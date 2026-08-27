import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';
import pLimit from 'p-limit';

import { CRITERIA } from '../config.js';
import { fetchHtml, HttpError } from '../http.js';
import { clean, parseArea, parseEnergies, parseEuroAmount, parseRooms, parseSlovakDate } from '../parse.js';
import { claimRun, SourceSkipped } from '../quota.js';
import { loadSeen } from '../state.js';
import type { Criteria, FetchListings, Listing } from '../types.js';

export const SOURCE_NAME = 'bazos';

const BASE_URL = 'https://reality.bazos.sk';

/**
 * Bazoš je bazár, nie realitný portál: inzeráty podávajú priamo majitelia, takže
 * sa neplatí provízia realitke – kvôli tomu je tu. Za to sa platí kvalitou dát.
 * Server-side HTML, bez ld+json a bez štruktúrovaných polí: karta má názov, cenu,
 * okres s PSČ, dátum a orezaný popis. Dispozícia a plocha stoja iba vo voľnom
 * texte, preto ich ťahá `src/parse.ts` a inzerát bez izieb alebo bez plochy sa
 * zahodí – tipovať by sa netrafilo častejšie než trafilo.
 *
 * RSS existuje (`www.bazos.sk/rss.php?rub=re&cat=152&typ=3`), ale dáva 50 najnovších
 * inzerátov za celé Slovensko bez lokality, takže sa na sledovanie kraja nehodí.
 * Vyhľadávanie naopak filtruje presne tým, čo potrebujeme: `hlokalita` (PSČ),
 * `humkreis` (okolie v km) a `cenado` (strop ceny).
 *
 * Pozor: robots.txt tie parametre zakazuje – je to bežná ochrana pred indexovaním
 * nekonečna kombinácií vyhľadávania. Necháva otvorené len kategórie bez filtra,
 * lenže tie majú 6 300 prenájmov za celé Slovensko a nie sú zoradené podľa dátumu
 * (topované inzeráty sa predatujú), takže by sa muselo sťahovať ~320 strán namiesto
 * ~55. Filtrovaný dopyt je pre Bazoš rádovo menšia záťaž, preto ide o vedomú výnimku.
 */
const CATEGORIES = [
  { slug: 'byt', label: 'byt' },
  { slug: 'dom', label: 'dom' },
] as const;

/**
 * Bazoš nepozná okresy, hľadá v okolí PSČ. Dve stredové PSČ pokryjú celý kraj:
 * 811 01 (Bratislava-Staré Mesto) s 35 km dosiahne celý okres Senec aj Pezinok,
 * mestá po Modru a Malacky; 901 01 (Malacky) s 25 km dokryje severnú časť
 * Záhoria po Veľké Leváre a Studienku, kam prvý okruh nesiaha.
 *
 * Okruhy zasahujú aj za hranicu kraja (Trnava, Senica, Dunajská Streda). Tie
 * inzeráty vypadnú pri prepise okresu na lokalitu z CRITERIA.
 */
const CENTRES = [
  { psc: '81101', km: 35, label: 'Bratislava + Senec + Pezinok' },
  { psc: '90101', km: 25, label: 'okres Malacky' },
] as const;

/**
 * Bazoš je jediný zdroj, kde sťahujeme cesty zakázané v robots.txt, tak sa aspoň
 * predstavíme vlastným menom: čo to je, ako často to beží a kam napísať, keby to
 * niekomu prekážalo. Ostatné tri zdroje ostávajú na bežnej prehliadačovej hlavičke.
 */
const BAZOS_USER_AGENT =
  'byvanie-monitor/1.0 (osobne hladanie bytu / personal flat search; 2 runs per day; ' +
  '+https://github.com/t1dekanovsky/byvanie-monitor; t1dekanovsky@gmail.com)';

/** Koľkokrát smie Bazoš bežať za kalendárny deň (UTC), nech ho spustí čokoľvek. */
const MAX_RUNS_PER_DAY = 2;

/**
 * Čakanie po HTTP 429/503, exponenciálne. Tri pokusy spolu: prvý hneď, po ňom
 * pauza 30 s, potom 60 s. Keď ani tretí neprejde, zdroj sa pre tento beh zatvára –
 * ďalšie dopyty už neodídu, lebo búchať na zavreté dvere je presne to, čo Bazoš
 * týmto kódom zakazuje.
 */
const THROTTLE_BACKOFF_MS = [30_000, 60_000];

const LIST_CONCURRENCY = 2;
const PAGE_SIZE = 20;
const MAX_PAGES_PER_TARGET = 50;
const TIMEOUT_MS = 15_000;
const DETAIL_CONCURRENCY = 2;

/**
 * Bazoš na rýchle sťahovanie odpovedá HTTP 429, a to naprieč celým zdrojom, nie
 * podľa druhu stránky. Preto ide každá požiadavka – výpis aj detail – cez jednu
 * frontu s pevným rozostupom, teda necelé dve za sekundu. Studený beh (57 strán
 * výpisu plus detaily) tak trvá pár minút, ďalšie behy sú kratšie o všetko,
 * čo už leží v cache popisov.
 */
const REQUEST_INTERVAL_MS = 700;
const RETRIES = 2;
const RETRY_DELAY_MS = 3_000;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

/** Vlastný súbor – zdroje bežia súbežne a spoločnú cache by si navzájom prepísali. */
export const DESCRIPTIONS_FILE = path.join(DATA_DIR, 'descriptions-bazos.json');

/** Ako dlho si držíme stiahnutý popis, kým ho zahodíme (rovnako ako seen.json). */
const DESCRIPTION_RETENTION_DAYS = 90;

interface Target {
  categorySlug: string;
  categoryLabel: string;
  centre: (typeof CENTRES)[number];
  url: string;
  page: number;
}

interface CachedDescription {
  text: string;
  fetchedAt: string;
}

export type DescriptionCache = Record<string, CachedDescription>;

/* ------------------------------------------------------------- fronta dopytov */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kedy najskôr smie odísť ďalšia požiadavka. Spoločné pre výpisy aj detaily. */
let nextRequestAt = 0;

/** Bazoš nás v tomto behu odmietol aj po všetkých pauzách – už mu nevoláme. */
let throttledOut = false;

const THROTTLED_OUT = 'Bazoš odmietol aj po opakovaných pauzách, zvyšok behu ho vynechávam';

/** Počká, kým príde rad podľa REQUEST_INTERVAL_MS. */
async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextRequestAt);
  nextRequestAt = start + REQUEST_INTERVAL_MS;
  if (start > now) await sleep(start - now);
}

/** Odmietol nás portál preto, že ideme príliš zhurta? */
function isThrottled(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 429 || error.status === 503);
}

/**
 * Stiahnutie s pevným rozostupom od predchádzajúceho. Na 429/503 čaká podľa
 * THROTTLE_BACKOFF_MS a po vyčerpaní pokusov zatvorí zdroj pre celý beh; iné
 * chyby (timeout, výpadok siete) skúsi ešte raz s krátkou pauzou.
 *
 * Exportované kvôli scripts/test-bazos-backoff.ts – čakačky sa inak nedajú overiť.
 */
export async function politeFetch(url: string): Promise<string> {
  if (throttledOut) throw new Error(THROTTLED_OUT);

  let lastError: unknown;

  for (let attempt = 0; attempt <= THROTTLE_BACKOFF_MS.length; attempt += 1) {
    await waitForSlot();

    try {
      return await fetchHtml(url, TIMEOUT_MS, BAZOS_USER_AGENT);
    } catch (error) {
      lastError = error;

      if (!isThrottled(error)) {
        // Bežné zlyhanie: jedno rýchle zopakovanie a dosť, o zvyšok sa stará volajúci.
        if (attempt >= RETRIES) break;
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      const wait = THROTTLE_BACKOFF_MS[attempt];
      if (wait === undefined) break;

      console.warn(
        '[' + SOURCE_NAME + '] ' + (error as HttpError).message + ', čakám ' +
          Math.round(wait / 1000) + ' s a skúšam znova',
      );
      await sleep(wait);
    }
  }

  if (isThrottled(lastError)) {
    throttledOut = true;
    console.warn('[' + SOURCE_NAME + '] ' + THROTTLED_OUT);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/* ------------------------------------------------------------------ lokalita */

/**
 * Bazoš píše do karty okres, nie obec – "Senec 900 27" je Bernolákovo v okrese
 * Senec, "Malacky 900 31" je Stupava. Mená okresov teda sadnú rovno na
 * CRITERIA.localities. Jediná výnimka je Bratislava, ktorá je jedno mesto s piatimi
 * okresmi; tie rozlišuje druhá číslica PSČ (811 xx = I … 851 xx = V).
 *
 * Vracia null pre všetko mimo kritérií – tak sa odrežú Trnava, Senica či Dunajská
 * Streda, kam okruhy zasahujú.
 */
export function localityFrom(district: string, psc: string, criteria: Criteria): string | null {
  const name = clean(district);
  if (name === '') return null;

  if (name.toLowerCase() !== 'bratislava') {
    return criteria.localities.find((locality) => locality === name) ?? null;
  }

  const digits = psc.replace(/\D/g, '');
  if (digits.length < 2) return null;

  const roman = ['I', 'II', 'III', 'IV', 'V'][Number(digits[1]) - 1];
  if (roman === undefined) return null;

  const locality = 'Bratislava ' + roman;
  return criteria.localities.includes(locality) ? locality : null;
}

/* ------------------------------------------------------------------ parsing */

function absoluteUrl(href: string | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href, BASE_URL).toString();
  } catch {
    return null;
  }
}

/** Vytiahne inzeráty z jednej výpisovej stránky. */
export function parseListingPage(html: string, target: Target, criteria: Criteria): Listing[] {
  const $ = cheerio.load(html);
  const listings: Listing[] = [];

  $('div.inzeraty').each((_index, element) => {
    const card = $(element);
    const link = card.find('h2.nadpis a').first();
    const url = absoluteUrl(link.attr('href'));
    if (url === null) return;

    const title = clean(link.text());
    if (title === '') return;

    // "Senec<br>900 27" – prvý textový uzol je okres, druhý PSČ.
    const [district = '', psc = ''] = card
      .find('.inzeratylok')
      .first()
      .contents()
      .toArray()
      .filter((node) => node.type === 'text')
      .map((node) => clean($(node).text()))
      .filter((part) => part !== '');

    const locality = localityFrom(district, psc, criteria);
    if (locality === null) return;

    const description = clean(card.find('.popis').first().text());
    const priceEur = parseEuroAmount(clean(card.find('.inzeratycena').first().text()));
    const energiesEur = parseEnergies(description, title);

    listings.push({
      // Rovnako ako ostatné zdroje: id je absolútna URL inzerátu.
      id: url,
      source: SOURCE_NAME,
      title,
      url,
      priceEur,
      energiesEur,
      totalPriceEur: priceEur !== null && energiesEur !== null ? priceEur + energiesEur : null,
      // Základ ceny aj odhad energií dopočíta filter z celého textu inzerátu.
      priceBasis: 'unknown',
      estimatedEnergies: false,
      areaSqm: parseArea(title, description),
      rooms: parseRooms(title, description),
      locality,
      // Bazoš adresu neuvádza, ostáva len okres a PSČ.
      street: null,
      description,
      imageUrl: card.find('img.obrazek').first().attr('src') ?? null,
      publishedAt: parseSlovakDate(clean(card.find('span.velikost10').first().text())),
      // Províziu aj odkazy na to isté v iných zdrojoch dopĺňa filter a dedup.
      commissionFree: false,
      mirrors: [],
      score: 0,
    });
  });

  return listings;
}

/** "Zobrazených 1-20 inzerátov z 938" -> 938. */
export function parseTotalCount(html: string): number {
  const raw = html.match(/Zobrazených\s+[\d-]+\s+inzerátov\s+z\s+([\d\s]+)/)?.[1];
  if (raw === undefined) return 0;

  const value = Number(raw.replace(/\s/g, ''));
  return Number.isFinite(value) ? value : 0;
}

/** Celý text inzerátu z detailu. */
export function parseDetailDescription(html: string): string {
  const $ = cheerio.load(html);
  // <br> oddeľuje odstavce; bez medzery by sa slová zlepili do jedného.
  $('.popisdetail br').replaceWith(' ');
  return clean($('.popisdetail').first().text());
}

/* -------------------------------------------------------------- cache popisov */

/** Načíta cache popisov; chýbajúci či rozbitý súbor berie ako prázdny. */
export async function loadDescriptions(): Promise<DescriptionCache> {
  try {
    const parsed: unknown = JSON.parse(await readFile(DESCRIPTIONS_FILE, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(path.basename(DESCRIPTIONS_FILE) + ' nie je objekt');
    }
    return parsed as DescriptionCache;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(
        '[' + SOURCE_NAME + '] ' + path.basename(DESCRIPTIONS_FILE) +
          ' sa nedá prečítať (' + String(error) + '), zakladám nový.',
      );
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

function targetUrl(
  category: string,
  centre: (typeof CENTRES)[number],
  offset: number,
  criteria: Criteria,
): string {
  const page = offset === 0 ? '' : offset + '/';
  return (
    BASE_URL + '/prenajmu/' + category + '/' + page +
    '?hlokalita=' + centre.psc + '&humkreis=' + centre.km + '&cenado=' + criteria.maxTotalPriceEur
  );
}

function buildTargets(criteria: Criteria): Target[] {
  const targets: Target[] = [];

  for (const centre of CENTRES) {
    for (const category of CATEGORIES) {
      targets.push({
        categorySlug: category.slug,
        categoryLabel: category.label,
        centre,
        url: targetUrl(category.slug, centre, 0, criteria),
        page: 1,
      });
    }
  }

  return targets;
}

interface PageResult {
  listings: Listing[];
  totalCount: number;
}

async function loadTarget(target: Target, criteria: Criteria): Promise<PageResult | null> {
  try {
    const html = await politeFetch(target.url);
    return { listings: parseListingPage(html, target, criteria), totalCount: parseTotalCount(html) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      '[' + SOURCE_NAME + '] preskakujem ' + target.categoryLabel + ' / ' + target.centre.label +
        ' (strana ' + target.page + '): ' + reason,
    );
    return null;
  }
}

/**
 * Sito pred sťahovaním detailov. Na rozdiel od portálov tu neznáma dispozícia
 * inzerát nezachraňuje – detail sa jej ide dopýtať – ale známa a malá ho zabije
 * hneď, bez ďalšej požiadavky. Práve toto odreže väčšinu Bazoša: garsónky
 * a jednoizbáky sú tam drvivá väčšina ponuky.
 */
export function passesNumericChecks(listing: Listing, criteria: Criteria): boolean {
  if (listing.rooms !== null && listing.rooms < criteria.minRooms) return false;
  if (listing.areaSqm !== null && listing.areaSqm < criteria.minAreaSqm) return false;
  if (listing.priceEur !== null && listing.priceEur > criteria.maxTotalPriceEur) return false;
  return true;
}

/** Zahodí duplicity podľa URL – okruhy sa prekrývajú a inzerát býva vo viacerých. */
function dedupeByUrl(listings: readonly Listing[]): Listing[] {
  const byId = new Map<string, Listing>();
  for (const listing of listings) {
    if (!byId.has(listing.id)) byId.set(listing.id, listing);
  }
  return [...byId.values()];
}

/** Nastaví popis a prepočíta z neho izby, plochu a energie. */
function applyDescription(listing: Listing, text: string): void {
  listing.description = text;

  // Na Bazoši je detail často jediné miesto, kde dispozícia a výmera vôbec stoja.
  listing.rooms ??= parseRooms(listing.title, text);
  listing.areaSqm ??= parseArea(listing.title, text);

  const energies = parseEnergies(text, listing.title);
  if (energies === null) return;

  listing.energiesEur = energies;
  if (listing.priceEur !== null) listing.totalPriceEur = listing.priceEur + energies;
}

/**
 * Dotiahne celé texty k sľubným inzerátom. Beží najviac 2× za sekundu a čokoľvek
 * raz stiahnuté si pamätá v cache, takže druhýkrát sa to už neťahá.
 */
async function attachDescriptions(candidates: readonly Listing[]): Promise<number> {
  const cache = await loadDescriptions();
  const limit = pLimit(DETAIL_CONCURRENCY);
  let fetched = 0;
  let failed = 0;

  await Promise.all(
    candidates.map((listing) =>
      limit(async () => {
        const cached = cache[listing.url];
        if (cached !== undefined) {
          applyDescription(listing, cached.text);
          return;
        }

        try {
          const description = parseDetailDescription(await politeFetch(listing.url));
          if (description === '') return;

          cache[listing.url] = { text: description, fetchedAt: new Date().toISOString() };
          applyDescription(listing, description);
          fetched += 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.error('[' + SOURCE_NAME + '] detail ' + listing.url + ' zlyhal: ' + reason);
          failed += 1;
        }
      }),
    ),
  );

  await saveDescriptions(cache);
  if (failed > 0) console.warn('[' + SOURCE_NAME + '] ' + failed + ' detailov sa nepodarilo stiahnuť');
  return fetched;
}

/** Načíta prenájmy z reality.bazos.sk a normalizuje ich do `Listing`. */
export async function fetchBazos(criteria: Criteria = CRITERIA): Promise<Listing[]> {
  if (!(await claimRun(SOURCE_NAME, MAX_RUNS_PER_DAY))) {
    throw new SourceSkipped(
      'denný strop ' + MAX_RUNS_PER_DAY + ' behov je vyčerpaný, dnes už Bazoš nesťahujem',
    );
  }

  // Proces zvyčajne beží raz, ale v testoch sa `fetchBazos` volá viackrát za sebou –
  // predchádzajúce odmietnutie nesmie zavrieť aj ten ďalší beh.
  throttledOut = false;

  const limit = pLimit(LIST_CONCURRENCY);
  const firstPages = buildTargets(criteria);
  console.log(
    '[' + SOURCE_NAME + '] ' + firstPages.length + ' cieľov (' + CENTRES.length + ' okruhov x ' +
      CATEGORIES.length + ' kategórií), max ' + MAX_PAGES_PER_TARGET + ' strán, súbežne ' + LIST_CONCURRENCY,
  );

  const collected: Listing[] = [];
  const followUp: Target[] = [];
  const truncated: string[] = [];
  let skipped = 0;

  const firstResults = await Promise.all(firstPages.map((target) => limit(() => loadTarget(target, criteria))));

  firstResults.forEach((result, index) => {
    const target = firstPages[index] as Target;
    if (result === null) {
      skipped += 1;
      return;
    }

    collected.push(...result.listings);

    const pages = Math.ceil(result.totalCount / PAGE_SIZE);
    if (pages > MAX_PAGES_PER_TARGET) {
      truncated.push(target.categoryLabel + ' / ' + target.centre.label + ' (' + result.totalCount + ')');
    }

    const lastPage = Math.min(pages, MAX_PAGES_PER_TARGET);
    for (let page = 2; page <= lastPage; page += 1) {
      // Stránkuje sa posunom v ceste: /prenajmu/byt/20/, /prenajmu/byt/40/, ...
      followUp.push({
        ...target,
        page,
        url: targetUrl(target.categorySlug, target.centre, (page - 1) * PAGE_SIZE, criteria),
      });
    }
  });

  // Keď odmietne úplne všetko, je to zablokovanie (HTTP 429), nie prázdna ponuka.
  // Ticho vrátená nula by v reporte vyzerala ako „dnes nič nové"; radšej nech to
  // spadne a Slack ohlási rozbitý zdroj.
  if (skipped === firstPages.length) {
    throw new Error('žiadny z ' + firstPages.length + ' výpisov sa nepodarilo stiahnuť');
  }

  if (truncated.length > 0) {
    console.warn(
      '[' + SOURCE_NAME + '] strop ' + MAX_PAGES_PER_TARGET + ' strán dosiahli: ' + truncated.join(', '),
    );
  }

  if (followUp.length > 0) {
    const extraResults = await Promise.all(followUp.map((target) => limit(() => loadTarget(target, criteria))));
    for (const result of extraResults) {
      if (result === null) {
        skipped += 1;
        continue;
      }
      collected.push(...result.listings);
    }
  }

  const listings = dedupeByUrl(collected);
  console.log(
    '[' + SOURCE_NAME + '] ' + listings.length + ' unikátnych inzerátov v kraji (' + collected.length +
      ' pred dedupom, ' + followUp.length + ' ďalších strán, ' + skipped + ' preskočených)',
  );

  // Detail sťahujeme len tomu, čo prejde číslami a ešte sme to neposlali do Slacku.
  const seen = await loadSeen();
  const candidates = listings.filter(
    (listing) => seen[listing.id] === undefined && passesNumericChecks(listing, criteria),
  );

  const fetched = await attachDescriptions(candidates);
  console.log(
    '[' + SOURCE_NAME + '] popisy: ' + candidates.length + ' kandidátov, ' + fetched +
      ' dotiahnutých z detailu, ' + (candidates.length - fetched) + ' z cache alebo bez popisu',
  );

  // Bez dispozície a výmery sa inzerát nedá porovnať s kritériami a Bazoš je príliš
  // hlučný na to, aby sa tipovalo. Radšej ho zahodíme, než by prešiel naslepo.
  const usable = listings.filter((listing) => listing.rooms !== null && listing.areaSqm !== null);
  const blind = candidates.filter((listing) => listing.rooms === null || listing.areaSqm === null).length;
  console.log(
    '[' + SOURCE_NAME + '] ' + usable.length + ' s dispozíciou aj výmerou; zahodených ' +
      (listings.length - usable.length) + ' neurčiteľných, z toho ' + blind +
      ' aj po stiahnutí celého textu',
  );

  return usable;
}

/** Podpis pre `Source` v src/index.ts. */
export const fetchListings: FetchListings = (criteria) => fetchBazos(criteria);
