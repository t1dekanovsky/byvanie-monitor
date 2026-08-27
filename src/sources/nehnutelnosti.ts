import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';
import pLimit from 'p-limit';

import { CRITERIA } from '../config.js';
import { fetchHtmlWithRetry } from '../http.js';
import { clean, parseArea, parseEnergies, parseRooms } from '../parse.js';
import { loadSeen } from '../state.js';
import type { Criteria, FetchListings, Listing } from '../types.js';

export const SOURCE_NAME = 'nehnutelnosti';

const BASE_URL = 'https://www.nehnutelnosti.sk';

/**
 * Nehnutelnosti.sk má rovnakého majiteľa ako reality.sk, ale inú inzerciu –
 * platené inzeráty sa medzi portálmi neprelievajú, tento je z tých troch najväčší.
 * Značkovanie s reality.sk nezdieľa vôbec nič: beží na Next.js App Routeri a
 * doručené HTML nemá karty v DOM-e (v celom dokumente je ~30 divov). Všetko –
 * inzeráty aj ld+json – visí v RSC "flight" payloade rozsekanom do stoviek
 * `self.__next_f.push([1,"..."])`. Cheerio je tu teda len na meta tagy, obsah
 * sa číta z poskladaného payloadu.
 *
 * Sťahuje sa tá istá stránka, akú dostane prehliadač, nie JSON API – to má portál
 * v robots.txt zakázané (`Disallow: /api/`). Zakázané je aj `?order=NEWEST`,
 * takže sa číta v prednastavenom poradí a najnovšie sa hľadajú stránkovaním.
 *
 * Výpis: /vysledky/{kategoria}/{okres}/prenajom so stránkovaním cez ?page=N,
 * 30 inzerátov na stranu. Payload nesie dve použiteľné štruktúry naraz:
 *   - `advertisements` – karty s ulicou, plochou, počtom izieb a číselnou cenou,
 *   - ld+json `ItemList` – tie isté inzeráty aj s celým popisom.
 * Karty sú kostra (majú počet izieb aj tam, kde ho ld+json vynechá), popis
 * dopĺňa ld+json a detail sa preto sťahuje len výnimočne.
 */
const PROPERTY_TYPES = [
  { slug: '3-izbove-byty', label: '3-izbový byt', subValues: null },
  { slug: '4-izbove-byty', label: '4-izbový byt', subValues: null },
  { slug: '5-a-viac-izbove-byty', label: '5 a viac izbový byt', subValues: null },
  // Rodinné domy nemajú vlastný slug – portál pozná len kategóriu `domy`, v ktorej
  // sú aj vily, chaty a chalupy. Odfiltrujú sa až podľa podkategórie z karty.
  { slug: 'domy', label: 'rodinný dom', subValues: ['FAMILY_HOUSE'] },
] as const;

const LIST_CONCURRENCY = 4;

/**
 * Strop je vyšší než na ostatných portáloch, lebo tento je najväčší a nepustí
 * zoradenie podľa dátumu – čerstvý inzerát môže sedieť hlboko vo výpise, takže
 * orezaný výpis znamená stratenú ponuku. Osem strán dnes pokryje aj najväčší cieľ
 * (3-izbové byty v okrese Bratislava I, ~215 inzerátov) a keby to prestalo stačiť,
 * ohlási sa to do logu.
 */
const MAX_PAGES_PER_TARGET = 8;
const PAGE_SIZE = 30;
const TIMEOUT_MS = 20_000;
const RETRIES = 1;

/** Detaily sťahujeme najviac 2× za sekundu, nech portál zbytočne netrpí. */
const DETAIL_CONCURRENCY = 2;
const DETAIL_INTERVAL_MS = 500;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

/**
 * Vlastný súbor, nie spoločný s reality.sk – zdroje bežia súbežne a obe cache sa
 * zapisujú celé naraz, takže by si spoločný súbor navzájom prepísali.
 */
export const DESCRIPTIONS_FILE = path.join(DATA_DIR, 'descriptions-nehnutelnosti.json');

/** Ako dlho si držíme stiahnutý popis, kým ho zahodíme (rovnako ako seen.json). */
const DESCRIPTION_RETENTION_DAYS = 90;

interface Target {
  /** Lokalita presne tak, ako je zapísaná v CRITERIA.localities. */
  locality: string;
  typeLabel: string;
  /** Povolené podkategórie z karty, `null` keď kategóriu určuje už samotná URL. */
  subValues: readonly string[] | null;
  url: string;
  page: number;
}

interface CachedDescription {
  text: string;
  fetchedAt: string;
}

export type DescriptionCache = Record<string, CachedDescription>;

/* --------------------------------------------------------- flight payload */

/**
 * Poskladá RSC payload z jednotlivých `self.__next_f.push([1,"..."])`. Reťazec
 * v každom kúsku je platný JSON literál, takže sa dá odescapovať cez JSON.parse;
 * kúsky na seba nadväzujú aj v strede slova, preto sa len zreťazia.
 */
export function extractFlightPayload(html: string): string {
  const MARK = 'self.__next_f.push([1,';
  const parts: string[] = [];

  for (let at = html.indexOf(MARK); at >= 0; ) {
    const start = html.indexOf('"', at + MARK.length);
    if (start < 0) break;

    const end = endOfJsonString(html, start);
    if (end < 0) break;

    try {
      parts.push(JSON.parse(html.slice(start, end + 1)) as string);
    } catch {
      // Kúsok, ktorý nie je reťazec (napr. push([1,null])) – preskakujeme.
    }

    at = html.indexOf(MARK, end);
  }

  return parts.join('');
}

/** Index uzatváracej úvodzovky JSON reťazca, ktorý sa začína na `from`. */
function endOfJsonString(text: string, from: number): number {
  let escaped = false;

  for (let i = from + 1; i < text.length; i += 1) {
    const char = text[i] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') return i;
  }

  return -1;
}

/**
 * Vyreže vyvážený JSON objekt alebo pole, ktoré sa začína na `from`. Zátvorky
 * vnútri reťazcov sa nerátajú, inak by popis s "{" ukončil objekt predčasne.
 */
function sliceBalanced(text: string, from: number): string | null {
  const open = text[from];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = from; i < text.length; i += 1) {
    const char = text[i] as string;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }

  return null;
}

/** Vyreže a rozparsuje JSON hodnotu, ktorá v payloade nasleduje za `marker`. */
function parseAfterMarker(payload: string, marker: string): unknown {
  const at = payload.indexOf(marker);
  if (at < 0) return null;

  const raw = sliceBalanced(payload, at + marker.length - 1);
  if (raw === null) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ karty inzerátov */

interface RawCard {
  id?: unknown;
  title?: unknown;
  sefName?: unknown;
  createdAt?: unknown;
  location?: { name?: unknown; city?: unknown };
  photos?: { url?: unknown }[];
  price?: { priceNum?: unknown };
  parameters?: {
    area?: unknown;
    totalRoomsCount?: unknown;
    category?: { subValue?: unknown };
  };
}

export interface SearchPayload {
  /** Koľko inzerátov má výpis celkovo – z toho vychádza počet strán. */
  totalCount: number;
  cards: RawCard[];
}

/**
 * Blok `advertisements` z payloadu: hlavička výpisu a pole kariet. Rovnaký kľúč
 * sa v payloade vyskytuje aj ako odkaz (`"advertisements":"$26:props..."`),
 * preto sa hľadá výslovne tvar s objektom.
 */
export function parseSearchPayload(payload: string): SearchPayload | null {
  const parsed = parseAfterMarker(payload, '"advertisements":{');
  if (parsed === null || typeof parsed !== 'object') return null;

  const block = parsed as { totalCount?: unknown; results?: unknown };
  const results = Array.isArray(block.results) ? block.results : [];

  const cards = results.flatMap((entry) => {
    const advertisement = (entry as { advertisement?: unknown }).advertisement;
    return advertisement !== null && typeof advertisement === 'object' ? [advertisement as RawCard] : [];
  });

  return {
    totalCount: typeof block.totalCount === 'number' ? block.totalCount : cards.length,
    cards,
  };
}

/* ------------------------------------------------------------------ ld+json */

/**
 * Grafy ld+json ukryté v payloade. Nie sú v `<script>` tagu, portál ich vkladá
 * až na klientovi, takže v payloade ležia ako obyčajný text (`25:T22085,{...}`)
 * a hľadajú sa podľa `@context`.
 */
export function parseLdGraphs(payload: string): unknown[] {
  const MARK = '"@context": "https://schema.org"';
  const graphs: unknown[] = [];

  for (let at = payload.indexOf(MARK); at >= 0; at = payload.indexOf(MARK, at + MARK.length)) {
    const open = payload.lastIndexOf('{', at);
    if (open < 0) continue;

    const raw = sliceBalanced(payload, open);
    if (raw === null) continue;

    try {
      graphs.push(JSON.parse(raw));
    } catch {
      // Nie každý `@context` v payloade patrí platnému grafu – preskakujeme.
    }
  }

  return graphs;
}

/** Prejde graf do hĺbky a zavolá `visit` na každý objekt v ňom. */
function walkLd(node: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walkLd(child, visit);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  const record = node as Record<string, unknown>;
  visit(record);

  for (const value of Object.values(record)) {
    if (value !== null && typeof value === 'object') walkLd(value, visit);
  }
}

/** Popis uzla, zbavený BBCode. Prázdny reťazec, keď uzol popis nemá. */
function ldDescription(record: Record<string, unknown>): string {
  return typeof record['description'] === 'string' ? cleanDescription(record['description']) : '';
}

/**
 * Popisy z ld+json `ItemList` na výpise, kľúčované id inzerátu. Zoznam visí pod
 * `SearchResultsPage.mainEntity`, preto sa graf prechádza do hĺbky.
 */
export function parseLdDescriptions(payload: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const graph of parseLdGraphs(payload)) {
    walkLd(graph, (record) => {
      const id = typeof record['@id'] === 'string' ? advertisementId(record['@id']) : null;
      const description = ldDescription(record);
      if (id !== null && description !== '' && !found.has(id)) found.set(id, description);
    });
  }

  return found;
}

/** "https://www.nehnutelnosti.sk/#/schema/Product/JuIJO7afu8t" -> "JuIJO7afu8t". */
function advertisementId(schemaId: string): string | null {
  return schemaId.match(/\/schema\/Product\/([A-Za-z0-9_-]+)$/)?.[1] ?? null;
}

/**
 * Popis inzerátu z ld+json na detailovej stránke. Tá má iný graf než výpis –
 * `@id` uzlov je `.../Accommodation/listing-<id>`, nie `.../Product/<id>` –
 * takže sa hľadá podľa typu uzla. Berie sa najdlhší popis: Organization aj
 * RealEstateAgent majú vlastný, oveľa kratší.
 */
function parseLdListingDescription(payload: string): string {
  const LISTING_TYPES = new Set(['Product', 'Accommodation', 'Offer', 'Place', 'Residence']);
  let best = '';

  for (const graph of parseLdGraphs(payload)) {
    walkLd(graph, (record) => {
      const type = record['@type'];
      const types = Array.isArray(type) ? type : [type];
      if (!types.some((value) => typeof value === 'string' && LISTING_TYPES.has(value))) return;

      const description = ldDescription(record);
      if (description.length > best.length) best = description;
    });
  }

  return best;
}

/** Inzerenti píšu popisy s BBCode ([b], [url=...]); značky sú v texte na zavadzaní. */
function cleanDescription(raw: string): string {
  return clean(raw.replace(/\[\/?[a-z][a-z0-9]*(?:=[^\]]*)?\]/gi, ' '));
}

/* ------------------------------------------------------------------ mapovanie */

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Ulica z `location.name` – "Drotárska cesta, Bratislava-Staré Mesto, okres
 * Bratislava I". Prvý úsek je ulica len vtedy, keď to nie je rovno mesto;
 * pri inzerátoch bez adresy začína názov mestom.
 */
function parseStreet(location: { name?: unknown; city?: unknown } | undefined): string | null {
  const name = text(location?.name);
  if (name === null) return null;

  const first = clean(name.split(',')[0]);
  if (first === '') return null;

  const city = text(location?.city);
  return city !== null && first === city.trim() ? null : first;
}

function toIsoDate(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  const stamp = Date.parse(raw);
  return Number.isNaN(stamp) ? null : new Date(stamp).toISOString();
}

/** Karta z payloadu -> `Listing`. Vracia null, keď z nej nejde poskladať ani URL. */
function toListing(card: RawCard, target: Target, descriptions: Map<string, string>): Listing | null {
  const id = text(card.id);
  const title = text(card.title);
  if (id === null || title === null) return null;

  const subValue = text(card.parameters?.category?.subValue);
  if (target.subValues !== null && (subValue === null || !target.subValues.includes(subValue))) return null;

  const sefName = text(card.sefName);
  const url = BASE_URL + '/detail/' + id + (sefName === null ? '' : '/' + sefName);

  const description = descriptions.get(id) ?? '';
  const priceEur = positiveNumber(card.price?.priceNum);
  const energiesEur = parseEnergies(description, title);

  return {
    // Rovnako ako ostatné zdroje: id je absolútna URL inzerátu.
    id: url,
    source: SOURCE_NAME,
    title: clean(title),
    url,
    priceEur,
    energiesEur,
    totalPriceEur: priceEur !== null && energiesEur !== null ? priceEur + energiesEur : null,
    // Základ ceny aj odhad energií dopočíta filter z celého textu inzerátu.
    priceBasis: 'unknown',
    estimatedEnergies: false,
    areaSqm: positiveNumber(card.parameters?.area) ?? parseArea(title, description),
    rooms: positiveNumber(card.parameters?.totalRoomsCount) ?? parseRooms(target.typeLabel, title, description),
    // Kanonický názov z CRITERIA, nie mestská časť z karty – filter porovnáva voči nemu.
    locality: target.locality,
    street: parseStreet(card.location),
    description,
    imageUrl: text(card.photos?.[0]?.url),
    publishedAt: toIsoDate(card.createdAt),
    // Províziu aj odkazy na to isté v iných zdrojoch dopĺňa filter a dedup.
    commissionFree: false,
    mirrors: [],
    score: 0,
  };
}

export interface PageResult {
  listings: Listing[];
  /** Koľko inzerátov má výpis celkovo, naprieč všetkými stranami. */
  totalCount: number;
  /** URL inzerátov, ktoré už majú plný popis z ld+json a netreba im detail. */
  full: string[];
}

/** Vytiahne inzeráty z jednej výpisovej stránky. */
export function parseListingPage(html: string, target: Target): PageResult {
  const payload = extractFlightPayload(html);
  const search = parseSearchPayload(payload);
  if (search === null) return { listings: [], totalCount: 0, full: [] };

  const descriptions = parseLdDescriptions(payload);
  const listings: Listing[] = [];
  const full: string[] = [];

  for (const card of search.cards) {
    const listing = toListing(card, target, descriptions);
    if (listing === null) continue;

    listings.push(listing);
    if (listing.description !== '') full.push(listing.url);
  }

  return { listings, totalCount: search.totalCount, full };
}

/** Popis z detailu inzerátu – záloha pre inzeráty, ktoré vo výpise ld+json nemali. */
export function parseDetailDescription(html: string): string {
  const fromLd = parseLdListingDescription(extractFlightPayload(html));
  if (fromLd !== '') return fromLd;

  // Meta popis je orezaný na pár viet, ale je to lepšie než nič.
  return cleanDescription(cheerio.load(html)('meta[name="description"]').attr('content') ?? '');
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

function buildTargets(criteria: Criteria): Target[] {
  const targets: Target[] = [];

  for (const locality of criteria.localities) {
    for (const type of PROPERTY_TYPES) {
      targets.push({
        locality,
        typeLabel: type.label,
        subValues: type.subValues,
        url: BASE_URL + '/vysledky/' + type.slug + '/' + localitySlug(locality) + '/prenajom',
        page: 1,
      });
    }
  }

  return targets;
}

async function loadTarget(target: Target): Promise<PageResult | null> {
  try {
    const html = await fetchHtmlWithRetry(target.url, {
      timeoutMs: TIMEOUT_MS,
      retries: RETRIES,
      label: SOURCE_NAME,
    });

    return parseListingPage(html, target);
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
 */
export function passesNumericChecks(listing: Listing, criteria: Criteria): boolean {
  if (listing.rooms !== null && listing.rooms < criteria.minRooms) return false;
  if (listing.areaSqm !== null && listing.areaSqm < criteria.minAreaSqm) return false;
  if (listing.priceEur !== null && listing.priceEur > criteria.maxTotalPriceEur) return false;
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

/** Nastaví popis a prepočíta energie – v plnom texte často stoja čiernym na bielom. */
function applyDescription(listing: Listing, text: string): void {
  listing.description = text;

  const energies = parseEnergies(text, listing.title);
  if (energies === null) return;

  listing.energiesEur = energies;
  if (listing.priceEur !== null) listing.totalPriceEur = listing.priceEur + energies;
}

/**
 * Dotiahne popisy k sľubným inzerátom, ktorým ich ld+json vo výpise nedal. Beží
 * najviac 2× za sekundu a čokoľvek raz stiahnuté si pamätá v cache.
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
          const description = parseDetailDescription(html);
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

/** Načíta prenájmy z nehnutelnosti.sk a normalizuje ich do `Listing`. */
export async function fetchNehnutelnosti(criteria: Criteria = CRITERIA): Promise<Listing[]> {
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
  const truncated: string[] = [];
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

    // Počet strán vieme rovno z hlavičky výpisu, netreba ho lúštiť zo stránkovania.
    const pages = Math.ceil(result.totalCount / PAGE_SIZE);
    if (pages > MAX_PAGES_PER_TARGET) {
      truncated.push(target.typeLabel + ' / ' + target.locality + ' (' + result.totalCount + ')');
    }

    const lastPage = Math.min(pages, MAX_PAGES_PER_TARGET);
    for (let page = 2; page <= lastPage; page += 1) {
      followUp.push({ ...target, page, url: target.url + '?page=' + page });
    }
  });

  // Portál nepustí zoradenie podľa dátumu, takže z orezaného výpisu môže vypadnúť
  // aj čerstvý inzerát. Nech je aspoň vidieť, kde sa strop dotýka.
  if (truncated.length > 0) {
    console.warn(
      '[' + SOURCE_NAME + '] strop ' + MAX_PAGES_PER_TARGET + ' strán dosiahli: ' + truncated.join(', '),
    );
  }

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
export const fetchListings: FetchListings = (criteria) => fetchNehnutelnosti(criteria);
