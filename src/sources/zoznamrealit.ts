import * as cheerio from 'cheerio';
import pLimit from 'p-limit';

import { CRITERIA } from '../config.js';
import { fetchHtmlWithRetry } from '../http.js';
import { clean, parseArea, parseEnergies, parseEuroAmount, parseRooms } from '../parse.js';
import type { Criteria, FetchListings, Listing } from '../types.js';

export const SOURCE_NAME = 'zoznamrealit';

const BASE_URL = 'https://www.zoznamrealit.sk';

/**
 * ZDROJ DÁT: HTML výpisy, nie RSS.
 *
 * ZoznamRealit RSS kanály existujú a majú tvar
 *   http://rss.zoznamrealit.sk/{byty|domy|pozemky|komercne-objekty|developerske-projekty|ostatne-reality}/{lokalita}
 * (napr. http://rss.zoznamrealit.sk/byty/bratislava-i), lenže sú delené IBA podľa druhu
 * nehnuteľnosti a lokality. Neexistuje kanál pre "prenájom" ani pre počet izieb – jeden
 * feed mieša predaj s prenájmom, garsónky s 5-izbovými bytmi a ťahá aj roky staré, už
 * predané inzeráty (feed byty/bratislava-i mal pri overovaní 486 položiek a 1,2 MB,
 * najstaršie položky z roku 2024). Použiteľný RSS vzor pre "prenájom / 3-izbový byt /
 * lokalita" teda neexistuje, a preto tento modul parsuje HTML cez cheerio:
 *   https://www.zoznamrealit.sk/prenajom/{byty/3-izbove|byty/4-izbove|byty/5-izbove|domy}/{lokalita}
 * Stránkovanie je /2, /3, ... a číta sa najviac MAX_PAGES_PER_TARGET strán na cieľ.
 */
const RSS_PATTERN = 'http://rss.zoznamrealit.sk/{kategoria}/{lokalita}';
const HTML_PATTERN = 'https://www.zoznamrealit.sk/prenajom/{kategoria}/{lokalita}[/{strana}]';

/** Typy nehnuteľností, ktoré nás zaujímajú, ako URL segmenty portálu. */
const PROPERTY_TYPES = [
  { slug: 'byty/3-izbove', label: '3-izbový byt' },
  { slug: 'byty/4-izbove', label: '4-izbový byt' },
  { slug: 'byty/5-izbove', label: '5 a viac izbový byt' },
  // Portál nemá pre prenájom podtyp "rodinne-domy" – /prenajom/domy/<lokalita> JE výpis
  // rodinných domov (chaty a chalupy majú vlastnú kategóriu /prenajom/chaty-chalupy).
  { slug: 'domy', label: 'rodinný dom' },
] as const;

/**
 * Bratislavské okresy majú v URL tvar `bratislava/i`, nie `bratislava-i`.
 * Portál na to síce presmeruje, ale rovno správny tvar ušetrí redirect.
 */
const LOCALITY_SLUGS: Record<string, string> = {
  'Bratislava I': 'bratislava/i',
  'Bratislava II': 'bratislava/ii',
  'Bratislava III': 'bratislava/iii',
  'Bratislava IV': 'bratislava/iv',
  'Bratislava V': 'bratislava/v',
};

/** Cesta skutočného inzerátu končí číselným id, napr. /krasny-3i-byt-908051. */
const LISTING_URL_RE = /-\d{4,}$/;

const CONCURRENCY = 5;
const TIMEOUT_MS = 15_000;
const RETRIES = 1;
const MAX_PAGES_PER_TARGET = 5;

interface Target {
  /** Lokalita presne tak, ako je zapísaná v CRITERIA.localities. */
  locality: string;
  typeLabel: string;
  url: string;
  page: number;
}

/* ------------------------------------------------------------------ parsing */

/** "Bratislava I" -> "bratislava/i", "Senec" -> "senec". */
export function localitySlug(locality: string): string {
  const override = LOCALITY_SLUGS[locality];
  if (override !== undefined) return override;

  return locality
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** "Bratislava - Staré Mesto / Živnostenská" -> ulica "Živnostenská". */
export function parseStreet(locationText: string | null | undefined): string | null {
  if (!locationText) return null;
  const parts = locationText.split('/').map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? (parts[parts.length - 1] as string) : null;
}

function absoluteUrl(href: string | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href, BASE_URL).toString();
  } catch {
    return null;
  }
}

/** Vytiahne inzeráty z jednej výpisovej stránky. */
export function parseListingPage(html: string, target: Pick<Target, 'locality'>): Listing[] {
  const $ = cheerio.load(html);
  const listings: Listing[] = [];

  $('.top-seller-list__item').each((_index, element) => {
    const item = $(element);
    const headline = item.find('a.top-seller-list__item-headline').first();

    const url = absoluteUrl(headline.attr('href'));
    // Medzi kartami sedia aj reklamné bloky s odkazom na "/" alebo na projekt.
    // Skutočný inzerát má vždy na konci slugu svoje číselné id.
    if (url === null || !LISTING_URL_RE.test(new URL(url).pathname)) return;

    const title = clean(headline.text());
    const description =
      clean(item.find('.top-seller-list__item-text').first().text()) || clean(headline.attr('title'));
    const construction = clean(item.find('.top-seller-list__item-construction').first().text());
    const areaText = clean(item.find('.top-seller-list__item-area').first().text());
    const locationText = clean(item.find('.top-seller-list__item-location').first().text());
    const priceText = clean(item.find('.top-seller-list__item-price').first().text());

    const priceEur = parseEuroAmount(priceText);
    const energiesEur = parseEnergies(description, title, priceText);

    listings.push({
      // Podľa zadania je id URL inzerátu.
      id: url,
      source: SOURCE_NAME,
      title,
      url,
      priceEur,
      energiesEur,
      totalPriceEur: priceEur !== null && energiesEur !== null ? priceEur + energiesEur : null,
      // Odhad energií dopĺňa filter; zdroj hlási len to, čo naozaj videl v inzeráte.
      estimatedEnergies: false,
      areaSqm: parseArea(areaText, title, description),
      rooms: parseRooms(construction, title, description),
      // Kanonický názov z CRITERIA, nie okres z portálu – filter porovnáva voči nemu.
      locality: target.locality,
      street: parseStreet(locationText),
      description,
      imageUrl: absoluteUrl(item.find('img.top-seller-list__item-image').first().attr('src')),
      // Výpis dátum zverejnenia neuvádza, je len v detaile inzerátu.
      publishedAt: null,
      score: 0,
    });
  });

  return listings;
}

/** Najvyššie číslo strany, na ktoré výpis odkazuje (1, keď stránkovanie nie je). */
export function parseLastPage(html: string, path: string): number {
  const $ = cheerio.load(html);
  let last = 1;

  $('a[href^="' + path + '/"]').each((_index, element) => {
    const href = $(element).attr('href') ?? '';
    const match = href.slice(path.length).match(/^\/(\d+)$/);
    if (match?.[1]) last = Math.max(last, Number(match[1]));
  });

  return last;
}

/* ----------------------------------------------------------------- fetching */

function targetPath(typeSlug: string, locality: string): string {
  return '/prenajom/' + typeSlug + '/' + localitySlug(locality);
}

function buildTargets(criteria: Criteria): Target[] {
  const targets: Target[] = [];

  for (const locality of criteria.localities) {
    for (const type of PROPERTY_TYPES) {
      targets.push({
        locality,
        typeLabel: type.label,
        url: BASE_URL + targetPath(type.slug, locality),
        page: 1,
      });
    }
  }

  return targets;
}

/**
 * Stiahne jeden cieľ. Keď zlyhá aj opakovaný pokus, cieľ sa preskočí a zaloguje –
 * jeden mŕtvy výpis nesmie zhodiť celú dávku.
 */
async function loadTarget(target: Target): Promise<{ listings: Listing[]; lastPage: number } | null> {
  try {
    const html = await fetchHtmlWithRetry(target.url, {
      timeoutMs: TIMEOUT_MS,
      retries: RETRIES,
      label: SOURCE_NAME,
    });
    return {
      listings: parseListingPage(html, target),
      lastPage: parseLastPage(html, new URL(target.url).pathname),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      '[' + SOURCE_NAME + '] preskakujem ' + target.typeLabel + ' / ' + target.locality +
        ' (strana ' + target.page + '): ' + reason,
    );
    return null;
  }
}

/** Zahodí duplicity podľa URL – ten istý inzerát býva vo viacerých výpisoch. */
function dedupeByUrl(listings: readonly Listing[]): Listing[] {
  const byId = new Map<string, Listing>();
  for (const listing of listings) {
    if (!byId.has(listing.id)) byId.set(listing.id, listing);
  }
  return [...byId.values()];
}

/** Načíta prenájmy zo zoznamrealit.sk a normalizuje ich do `Listing`. */
export async function fetchZoznamRealit(criteria: Criteria = CRITERIA): Promise<Listing[]> {
  console.log('[' + SOURCE_NAME + '] RSS vzor: ' + RSS_PATTERN + ' – bez rozlíšenia prenájom/predaj a bez počtu izieb, nepoužiteľný');
  console.log('[' + SOURCE_NAME + '] HTML vzor: ' + HTML_PATTERN);

  const limit = pLimit(CONCURRENCY);
  const firstPages = buildTargets(criteria);
  console.log(
    '[' + SOURCE_NAME + '] ' + firstPages.length + ' cieľov (' + criteria.localities.length +
      ' lokalít x ' + PROPERTY_TYPES.length + ' typov), súbežne ' + CONCURRENCY,
  );

  const collected: Listing[] = [];
  const followUp: Target[] = [];
  let skipped = 0;

  const firstResults = await Promise.all(firstPages.map((target) => limit(() => loadTarget(target))));

  firstResults.forEach((result, index) => {
    const target = firstPages[index] as Target;
    if (result === null) {
      skipped += 1;
      return;
    }

    collected.push(...result.listings);
    const lastPage = Math.min(result.lastPage, MAX_PAGES_PER_TARGET);
    for (let page = 2; page <= lastPage; page += 1) {
      followUp.push({ ...target, page, url: target.url + '/' + page });
    }
  });

  if (followUp.length > 0) {
    const extraResults = await Promise.all(followUp.map((target) => limit(() => loadTarget(target))));
    for (const result of extraResults) {
      if (result === null) skipped += 1;
      else collected.push(...result.listings);
    }
  }

  const listings = dedupeByUrl(collected);
  console.log(
    '[' + SOURCE_NAME + '] ' + listings.length + ' unikátnych inzerátov (' + collected.length +
      ' pred dedupom, ' + followUp.length + ' ďalších strán, ' + skipped + ' preskočených)',
  );

  return listings;
}

/** Podpis pre `Source` v src/index.ts. */
export const fetchListings: FetchListings = (criteria) => fetchZoznamRealit(criteria);
