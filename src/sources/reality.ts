import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';
import pLimit from 'p-limit';

import { CRITERIA } from '../config.js';
import { fetchHtmlWithRetry } from '../http.js';
import { clean, parseArea, parseEnergies, parseRooms, parseSlovakDate } from '../parse.js';
import { loadSeen } from '../state.js';
import type { Criteria, FetchListings, Listing } from '../types.js';

export const SOURCE_NAME = 'reality';

const BASE_URL = 'https://www.reality.sk';

/**
 * Reality.sk a Nehnutelnosti.sk bežia na tej istej platforme; Reality.sk má jednoduchšie
 * HTML, tak berieme ten. Výpis: https://www.reality.sk/{kategoria}/{okres}/prenajom/
 * so stránkovaním cez ?page=N. Selektory nižšie sú odčítané zo skutočného HTML
 * (karta = div.offer), nie odhadnuté.
 *
 * Pozor na formát čísel: tento portál píše ceny po anglicky ("1,699 €/mesiac" = 1699 €,
 * čiarka je oddeľovač tisícov) a plochu s desatinnou bodkou ("79.02 m²"). Popisy
 * inzerátov sú naopak po slovensky, takže energie z nich ťahá spoločný parser.
 */
const PROPERTY_TYPES = [
  { slug: 'byty/3-izbovy-byt', label: '3-izbový byt' },
  { slug: 'byty/4-izbovy-byt', label: '4-izbový byt' },
  { slug: 'byty/5-a-viac-izbovy-byt', label: '5 a viac izbový byt' },
  { slug: 'domy/rodinny-dom', label: 'rodinný dom' },
] as const;

const LIST_CONCURRENCY = 5;
const MAX_PAGES_PER_TARGET = 3;
const TIMEOUT_MS = 15_000;
const RETRIES = 1;

/** Detaily sťahujeme najviac 2× za sekundu, nech portál zbytočne netrpí. */
const DETAIL_CONCURRENCY = 2;
const DETAIL_INTERVAL_MS = 500;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
export const DESCRIPTIONS_FILE = path.join(DATA_DIR, 'descriptions.json');

/** Ako dlho si držíme stiahnutý popis, kým ho zahodíme (rovnako ako seen.json). */
const DESCRIPTION_RETENTION_DAYS = 90;

interface Target {
  /** Lokalita presne tak, ako je zapísaná v CRITERIA.localities. */
  locality: string;
  typeLabel: string;
  url: string;
  page: number;
}

interface CachedDescription {
  text: string;
  fetchedAt: string;
}

export type DescriptionCache = Record<string, CachedDescription>;

/* ------------------------------------------------------------------ parsing */

/** "Bratislava I" -> "okres-bratislava-i", "Senec" -> "okres-senec". */
export function localitySlug(locality: string): string {
  const slug = locality
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return 'okres-' + slug;
}

/**
 * Cena z karty: "750 €/mesiac", "1,699 €/mesiac". Na rozdiel od zvyšku portálu
 * je tu čiarka oddeľovač tisícov, nie desatinná čiarka.
 */
export function parseRealityPrice(raw: string | null | undefined): number | null {
  const text = clean(raw);
  if (text === '') return null;

  const match = text.match(/\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;

  const value = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
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

  $('.offer').each((_index, element) => {
    const card = $(element);
    const link = card.find('a[href^="/byty/"], a[href^="/domy/"]').first();
    const url = absoluteUrl(link.attr('href'));
    if (url === null) return;

    const title = clean(card.find('h2.offer-title').first().text());
    if (title === '') return;

    // ["3 izbový byt", "| Floriánska", "| 86 m²"] – ulica občas chýba.
    const params = card
      .find('.offer-params span')
      .map((_i, el) => clean($(el).text()).replace(/^\|\s*/, ''))
      .get()
      .filter((value) => value !== '');

    const typeText = params[0] ?? '';
    const areaText = params.find((value) => /m\s*(?:2|²)/i.test(value)) ?? null;
    const street = params.slice(1).find((value) => value !== areaText) ?? null;

    // Vlastný text ceny bez vnoreného <small>20 €/mesiac/m²</small>.
    const priceText = clean(card.find('.offer-price').first().clone().children().remove().end().text());
    const description = clean(card.find('.offer-desc').first().text());

    const dates = card.find('.offer-date').map((_i, el) => clean($(el).text())).get();
    const published = dates.find((value) => /publikovan/i.test(value)) ?? null;
    const updated = dates.find((value) => /aktualizovan/i.test(value)) ?? null;

    const priceEur = parseRealityPrice(priceText);
    const energiesEur = parseEnergies(description, title);

    listings.push({
      // Podľa zadania je id absolútna URL inzerátu.
      id: url,
      source: SOURCE_NAME,
      title,
      url,
      priceEur,
      energiesEur,
      totalPriceEur: priceEur !== null && energiesEur !== null ? priceEur + energiesEur : null,
      // Odhad energií dopĺňa filter; zdroj hlási len to, čo videl v inzeráte.
      estimatedEnergies: false,
      areaSqm: parseArea(areaText, title),
      rooms: parseRooms(typeText, title, description),
      // Kanonický názov z CRITERIA, nie mestská časť z karty – filter porovnáva voči nemu.
      locality: target.locality,
      street,
      description,
      imageUrl: card.find('img[data-lazy-src]').first().attr('data-lazy-src') ?? null,
      publishedAt: parseSlovakDate(published) ?? parseSlovakDate(updated),
      score: 0,
    });
  });

  return listings;
}

/** Najvyššie číslo strany zo stránkovania `?page=N` (1, keď stránkovanie nie je). */
export function parseLastPage(html: string): number {
  const $ = cheerio.load(html);
  let last = 1;

  $('a[href*="?page="]').each((_index, element) => {
    const match = ($(element).attr('href') ?? '').match(/[?&]page=(\d+)/);
    if (match?.[1]) last = Math.max(last, Number(match[1]));
  });

  return last;
}

/**
 * Výpisová stránka nesie v ld+json (Place + ItemList) plný popis každého inzerátu,
 * takže detail sa vo väčšine prípadov sťahovať vôbec nemusí. Blok ale nie je platný
 * JSON – popisy majú v sebe surové zalomenia riadkov, ktoré treba najprv escapnúť.
 */
function escapeControlChars(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const char of raw) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }

    if (inString && char.charCodeAt(0) < 0x20) {
      out += char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : ' ';
      continue;
    }

    out += char;
  }

  return out;
}

/** Kľúč pre porovnanie URL – ld+json ich píše s koncovou lomkou, karta nie vždy. */
function urlKey(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Mapa `URL inzerátu -> plný popis` vytiahnutá z ld+json na výpisovej stránke. */
export function parseLdDescriptions(html: string): Map<string, string> {
  const $ = cheerio.load(html);
  const found = new Map<string, string>();

  $('script[type="application/ld+json"]').each((_index, element) => {
    const raw = $(element).text();
    if (!raw.includes('itemListElement')) return;

    let data: unknown;
    try {
      data = JSON.parse(escapeControlChars(raw));
    } catch {
      return;
    }

    const items = (data as { itemListElement?: unknown }).itemListElement;
    if (!Array.isArray(items)) return;

    for (const item of items) {
      const entity = (item as { mainEntity?: { url?: unknown; description?: unknown } }).mainEntity;
      if (typeof entity?.url !== 'string' || typeof entity.description !== 'string') continue;

      const text = clean(entity.description);
      if (text !== '') found.set(urlKey(entity.url), text);
    }
  });

  return found;
}

/** Nastaví popis a prepočíta energie – v plnom texte často stoja čiernym na bielom. */
function applyDescription(listing: Listing, text: string): void {
  listing.description = text;

  const energies = parseEnergies(text, listing.title);
  if (energies === null) return;

  listing.energiesEur = energies;
  if (listing.priceEur !== null) listing.totalPriceEur = listing.priceEur + energies;
}

/** Popis z detailu inzerátu. */
export function parseDetailDescription(html: string): string {
  const $ = cheerio.load(html);

  const preview = clean($('.content-preview').first().text());
  if (preview !== '') return preview;

  // Záloha: celý blok aj s ovládacím textom rozbaľovača, ten odstrihneme.
  const cms = clean($('.cms-content').first().text());
  if (cms !== '') return cms.replace(/\s*(?:Prečítať viac|Zobraziť menej)\s*$/i, '').trim();

  return clean($('meta[name="description"]').attr('content'));
}

/* -------------------------------------------------------------- cache popisov */

/** Načíta data/descriptions.json; chýbajúci či rozbitý súbor berie ako prázdny. */
export async function loadDescriptions(): Promise<DescriptionCache> {
  try {
    const parsed: unknown = JSON.parse(await readFile(DESCRIPTIONS_FILE, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('descriptions.json nie je objekt');
    }
    return parsed as DescriptionCache;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn('[' + SOURCE_NAME + '] descriptions.json sa nedá prečítať (' + String(error) + '), zakladám nový.');
    }
    return {};
  }
}

/** Zapíše cache a zároveň z nej vyhodí popisy staršie ako DESCRIPTION_RETENTION_DAYS. */
export async function saveDescriptions(cache: DescriptionCache): Promise<void> {
  const cutoff = Date.now() - DESCRIPTION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const kept: DescriptionCache = {};

  for (const url of Object.keys(cache).sort()) {
    const entry = cache[url] as CachedDescription;
    const stamp = Date.parse(entry.fetchedAt);
    if (!Number.isNaN(stamp) && stamp >= cutoff) kept[url] = entry;
  }

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DESCRIPTIONS_FILE, JSON.stringify(kept, null, 2) + '\n', 'utf8');
}

/* ----------------------------------------------------------------- fetching */

function buildTargets(criteria: Criteria): Target[] {
  const targets: Target[] = [];

  for (const locality of criteria.localities) {
    for (const type of PROPERTY_TYPES) {
      targets.push({
        locality,
        typeLabel: type.label,
        url: BASE_URL + '/' + type.slug + '/' + localitySlug(locality) + '/prenajom/',
        page: 1,
      });
    }
  }

  return targets;
}

interface TargetResult {
  listings: Listing[];
  lastPage: number;
  /** URL inzerátov, ktoré už majú plný popis z ld+json a netreba im detail. */
  full: string[];
}

async function loadTarget(target: Target): Promise<TargetResult | null> {
  try {
    const html = await fetchHtmlWithRetry(target.url, {
      timeoutMs: TIMEOUT_MS,
      retries: RETRIES,
      label: SOURCE_NAME,
    });

    const listings = parseListingPage(html, target);
    const descriptions = parseLdDescriptions(html);
    const full: string[] = [];

    for (const listing of listings) {
      const text = descriptions.get(urlKey(listing.url));
      if (text === undefined) continue;
      applyDescription(listing, text);
      full.push(listing.url);
    }

    return { listings, lastPage: parseLastPage(html), full };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      '[' + SOURCE_NAME + '] preskakujem ' + target.typeLabel + ' / ' + target.locality +
        ' (strana ' + target.page + '): ' + reason,
    );
    return null;
  }
}

/**
 * Hrubé číselné sito pred sťahovaním detailov. Neznámy údaj inzerát nevyraďuje –
 * radšej stiahneme popis navyše, než by nám ušla ponuka kvôli chýbajúcemu číslu.
 * Energie sa dopĺňajú odhadom z CRITERIA, presné číslo býva až v popise.
 */
export function passesNumericChecks(listing: Listing, criteria: Criteria): boolean {
  if (listing.rooms !== null && listing.rooms < criteria.minRooms) return false;
  if (listing.areaSqm !== null && listing.areaSqm < criteria.minAreaSqm) return false;

  if (listing.priceEur !== null) {
    const energies = listing.energiesEur ?? criteria.estimatedEnergiesEur;
    if (listing.priceEur + energies > criteria.maxTotalPriceEur) return false;
  }

  return true;
}

/** Zahodí duplicity podľa URL – ten istý inzerát býva vo viacerých výpisoch. */
function dedupeByUrl(listings: readonly Listing[]): Listing[] {
  const byId = new Map<string, Listing>();
  for (const listing of listings) {
    if (!byId.has(listing.id)) byId.set(listing.id, listing);
  }
  return [...byId.values()];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dotiahne plné popisy k sľubným inzerátom. Beží najviac 2× za sekundu a čokoľvek
 * raz stiahnuté si pamätá v data/descriptions.json, takže druhýkrát sa to už neťahá.
 */
async function attachDescriptions(
  candidates: readonly Listing[],
  alreadyFull: ReadonlySet<string>,
): Promise<number> {
  const cache = await loadDescriptions();
  const limit = pLimit(DETAIL_CONCURRENCY);
  let nextStart = 0;
  let fetched = 0;
  let failed = 0;

  await Promise.all(
    candidates.map((listing) =>
      limit(async () => {
        // Popis z ld+json je rovnaký ako na detaile, netreba ho ťahať druhýkrát.
        if (alreadyFull.has(listing.url)) return;

        const cached = cache[listing.url];
        if (cached !== undefined) {
          applyDescription(listing, cached.text);
          return;
        }

        // Rozostup 500 ms medzi štartmi = 2 požiadavky za sekundu.
        const now = Date.now();
        const start = Math.max(now, nextStart);
        nextStart = start + DETAIL_INTERVAL_MS;
        if (start > now) await sleep(start - now);

        try {
          const html = await fetchHtmlWithRetry(listing.url, {
            timeoutMs: TIMEOUT_MS,
            retries: RETRIES,
            label: SOURCE_NAME,
          });
          const text = parseDetailDescription(html);
          if (text === '') return;

          cache[listing.url] = { text, fetchedAt: new Date().toISOString() };
          applyDescription(listing, text);
          fetched += 1;
        } catch (error) {
          failed += 1;
          const reason = error instanceof Error ? error.message : String(error);
          console.error('[' + SOURCE_NAME + '] detail ' + listing.url + ' zlyhal: ' + reason);
        }
      }),
    ),
  );

  await saveDescriptions(cache);
  if (failed > 0) console.warn('[' + SOURCE_NAME + '] ' + failed + ' detailov sa nepodarilo stiahnuť');
  return fetched;
}

/** Načíta prenájmy z reality.sk a normalizuje ich do `Listing`. */
export async function fetchReality(criteria: Criteria = CRITERIA): Promise<Listing[]> {
  const limit = pLimit(LIST_CONCURRENCY);
  const firstPages = buildTargets(criteria);
  console.log(
    '[' + SOURCE_NAME + '] ' + firstPages.length + ' cieľov (' + criteria.localities.length +
      ' lokalít x ' + PROPERTY_TYPES.length + ' typov), max ' + MAX_PAGES_PER_TARGET +
      ' strán, súbežne ' + LIST_CONCURRENCY,
  );

  const collected: Listing[] = [];
  const followUp: Target[] = [];
  const fullFromLd = new Set<string>();
  let skipped = 0;

  const firstResults = await Promise.all(firstPages.map((target) => limit(() => loadTarget(target))));

  firstResults.forEach((result, index) => {
    const target = firstPages[index] as Target;
    if (result === null) {
      skipped += 1;
      return;
    }

    collected.push(...result.listings);
    for (const url of result.full) fullFromLd.add(url);
    const lastPage = Math.min(result.lastPage, MAX_PAGES_PER_TARGET);
    for (let page = 2; page <= lastPage; page += 1) {
      followUp.push({ ...target, page, url: target.url + '?page=' + page });
    }
  });

  if (followUp.length > 0) {
    const extraResults = await Promise.all(followUp.map((target) => limit(() => loadTarget(target))));
    for (const result of extraResults) {
      if (result === null) {
        skipped += 1;
        continue;
      }
      collected.push(...result.listings);
      for (const url of result.full) fullFromLd.add(url);
    }
  }

  const listings = dedupeByUrl(collected);
  console.log(
    '[' + SOURCE_NAME + '] ' + listings.length + ' unikátnych inzerátov (' + collected.length +
      ' pred dedupom, ' + followUp.length + ' ďalších strán, ' + skipped + ' preskočených)',
  );

  // Detail sťahujeme len tomu, čo prejde číslami a ešte sme to neposlali do Slacku.
  const seen = await loadSeen();
  const candidates = listings.filter(
    (listing) => seen[listing.id] === undefined && passesNumericChecks(listing, criteria),
  );

  const fromLd = candidates.filter((listing) => fullFromLd.has(listing.url)).length;
  const fetched = await attachDescriptions(candidates, fullFromLd);
  console.log(
    '[' + SOURCE_NAME + '] popisy: ' + candidates.length + ' kandidátov, ' + fromLd +
      ' z ld+json na výpise, ' + fetched + ' dotiahnutých z detailu, ' +
      (candidates.length - fromLd - fetched) + ' z cache alebo bez popisu',
  );

  return listings;
}

/** Podpis pre `Source` v src/index.ts. */
export const fetchListings: FetchListings = (criteria) => fetchReality(criteria);
