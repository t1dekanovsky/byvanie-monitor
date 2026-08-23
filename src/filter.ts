import { CRITERIA } from './config.js';
import type { Criteria, Listing } from './types.js';

/**
 * Tieto slová vážia dvojnásobne – práve kvôli nim inzerát otvoríme ako prvý.
 * Musia doslova sedieť s hodnotami v CRITERIA.positiveKeywords.
 */
const DOUBLE_WEIGHT_KEYWORDS = [
  'novostavba',
  'po kompletnej rekonštrukcii',
  'kompletne zrekonštruovaný',
];

const MAX_SCORE = 10;

/**
 * Porovnávame bez diakritiky a bez veľkých písmen – inzeráty sú písané všelijako
 * ("novostavba", "NOVOSTAVBA", "novostavba" bez mäkčeňov) a inak by nám polovica ušla.
 */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Najkratší koreň, na ktorý sa ešte oplatí porovnávať. */
const MIN_STEM_LENGTH = 4;

/**
 * Slovenčina inzerát skloňuje: "kancelária" sa v texte objaví ako "kancelárie",
 * "pred rekonštrukciou" ako "rekonštrukciou". Doslovné hľadanie by tieto tvary
 * minulo, tak z kľúčového slova odrežeme koncové samohlásky a porovnávame koreň.
 */
function keywordStem(keyword: string): string {
  let stem = normalize(keyword);
  while (stem.length > MIN_STEM_LENGTH && /[aeiouy]$/.test(stem)) {
    stem = stem.slice(0, -1);
  }
  return stem;
}

/**
 * Koreň musí začínať na hranici slova, inak by "obsadené" našlo aj "neobsadené"
 * a vyradilo by presne tie voľné byty, ktoré hľadáme.
 */
function containsKeyword(haystack: string, keyword: string): boolean {
  const stem = keywordStem(keyword);

  for (let from = 0; ; from += 1) {
    const at = haystack.indexOf(stem, from);
    if (at < 0) return false;
    if (at === 0 || !/[a-z0-9]/.test(haystack[at - 1] as string)) return true;
    from = at;
  }
}

/* ------------------------------------------------------- dopytové inzeráty */

/** Koľko slov smie stáť medzi slovami frázy – "hľadám do prenájmu 3-izbový byt". */
const DEMAND_GAP = 4;

/** Kratšie slovo než toto musí nasledovať hneď za predchádzajúcim. */
const MIN_GAPPED_WORD = 3;

/**
 * Aj prenajímateľ píše v prvej osobe: "hľadáme nájomníkov, ktorí...". Keď medzi
 * "hľadám" a "byt" stojí nájomca, je to ponuka, nie dopyt, a nesmie vypadnúť.
 */
const TENANT_WORDS = ['nájomca', 'nájomník', 'podnájom'];

/** Text rozsekaný na slová – porovnávame po slovách, nie po znakoch. */
function wordsOf(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

/**
 * Sedia zvyšné korene frázy, keď prvý sedel na slove `start`? Každý ďalší musí
 * nasledovať v poradí a najviac DEMAND_GAP slov za predchádzajúcim.
 */
function matchesFrom(words: readonly string[], stems: readonly string[], start: number): boolean {
  let at = start;

  for (const stem of stems.slice(1)) {
    // Krátke slovko ("sa") pustené cez medzeru sa prilepí na hocijaké "hľadá"
    // v ponuke, tak ho pýtame hneď za predchádzajúcim slovom.
    const reach = Math.min(stem.length < MIN_GAPPED_WORD ? at + 1 : at + DEMAND_GAP + 1, words.length - 1);

    let found = -1;
    for (let next = at + 1; next <= reach; next += 1) {
      const word = words[next] as string;
      if (TENANT_WORDS.some((tenant) => word.startsWith(keywordStem(tenant)))) return false;
      if (word.startsWith(stem)) {
        found = next;
        break;
      }
    }

    if (found < 0) return false;
    at = found;
  }

  return true;
}

/** Nájde frázu v texte rozsekanom na slová. Korene sa porovnávajú od začiatku slova. */
function containsPhrase(words: readonly string[], phrase: string): boolean {
  const stems = phrase.split(' ').map(keywordStem);
  const first = stems[0] as string;

  // Jediné slovo nemá okolo seba kontext, ktorý by ho ubránil, tak musí sedieť
  // celé: inak "dopytu po nájomnom bývaní" vyhodí úplne normálnu ponuku.
  if (stems.length === 1) return words.includes(normalize(phrase));

  for (let start = 0; start < words.length; start += 1) {
    if (!(words[start] as string).startsWith(first)) continue;
    if (matchesFrom(words, stems, start)) return true;
  }

  return false;
}

/** Dopytová fráza z názvu alebo popisu, alebo null keď inzerát byt ponúka. */
export function demandPhrase(listing: Listing, criteria: Criteria = CRITERIA): string | null {
  const words = wordsOf(listing.title + ' ' + listing.description);
  return criteria.demandKeywords.find((phrase) => containsPhrase(words, phrase)) ?? null;
}

/**
 * Doplní chýbajúce energie odhadom a dopočíta totalPriceEur.
 * Nastaví `estimatedEnergies: true`, keď sa odhad naozaj použil.
 */
export function withTotalPrice(listing: Listing, criteria: Criteria = CRITERIA): Listing {
  // Odhadnúť sa smú len energie, nájom nikdy. Nula znamená to isté čo chýbajúci
  // údaj – inzerát bez nájmu nemá k čomu energie pripočítať.
  if (listing.priceEur === null || listing.priceEur === 0) {
    return { ...listing, totalPriceEur: null };
  }

  const energiesKnown = listing.energiesEur !== null;
  const energies = energiesKnown ? (listing.energiesEur as number) : criteria.estimatedEnergiesEur;

  return {
    ...listing,
    energiesEur: energies,
    totalPriceEur: listing.priceEur + energies,
    estimatedEnergies: !energiesKnown,
  };
}

/**
 * Skóre 0–10: koľko kladných kľúčových slov sedí v názve a popise.
 * Novostavba a kompletná rekonštrukcia sa rátajú dvakrát.
 */
export function scoreListing(listing: Listing, criteria: Criteria = CRITERIA): number {
  const haystack = normalize(listing.title + ' ' + listing.description);

  let score = 0;
  for (const keyword of criteria.positiveKeywords) {
    if (!containsKeyword(haystack, keyword)) continue;
    score += DOUBLE_WEIGHT_KEYWORDS.includes(keyword) ? 2 : 1;
  }

  return Math.min(score, MAX_SCORE);
}

/**
 * Ktoré pravidlo inzerát vyhodilo. Dopyt a chýbajúcu cenu rátame osobitne –
 * v reporte je po behu vidieť, koľko toho každé z nich zobralo.
 */
export type RejectionRule = 'demand' | 'noPrice' | 'other';

export interface Rejection {
  rule: RejectionRule;
  reason: string;
}

/** Dôvod vyradenia aj s pravidlom, alebo null keď inzerát prejde. */
function rejection(listing: Listing, criteria: Criteria): Rejection | null {
  // Dopytový inzerát byt nikdy neponúka, takže čísla v ňom nemá zmysel ani čítať.
  const demand = demandPhrase(listing, criteria);
  if (demand !== null) return { rule: 'demand', reason: 'dopyt: ' + demand };

  // Bez nájmu inzerát nevyhodnotíme – a nájom sa neodhaduje, len energie.
  if (listing.priceEur === null || listing.priceEur === 0) {
    return { rule: 'noPrice', reason: 'bez ceny nájmu' };
  }

  const other = otherRejection(listing, criteria);
  return other === null ? null : { rule: 'other', reason: other };
}

/** Dôvod vyradenia, alebo null keď inzerát prejde. */
export function rejectionReason(listing: Listing, criteria: Criteria = CRITERIA): string | null {
  return rejection(listing, criteria)?.reason ?? null;
}

/** Pôvodné kritériá: izby, plocha, cena a záporné slová. */
function otherRejection(listing: Listing, criteria: Criteria): string | null {
  // Neznámy údaj inzerát nevyraďuje – radšej ho ukážeme, než by nám ušiel kvôli
  // chýbajúcemu číslu vo výpise.
  if (listing.rooms !== null && listing.rooms < criteria.minRooms) {
    return 'málo izieb (' + listing.rooms + ')';
  }
  if (listing.areaSqm !== null && listing.areaSqm < criteria.minAreaSqm) {
    return 'malá plocha (' + listing.areaSqm + ' m2)';
  }
  if (listing.totalPriceEur !== null && listing.totalPriceEur > criteria.maxTotalPriceEur) {
    return 'drahé (' + listing.totalPriceEur + ' EUR)';
  }

  const haystack = normalize(listing.title + ' ' + listing.description);
  for (const keyword of criteria.negativeKeywords) {
    if (containsKeyword(haystack, keyword)) return 'zaporne slovo: ' + keyword;
  }

  return null;
}

export interface FilterResult {
  /** Inzeráty, ktoré prešli, zoradené od najlepšieho. */
  kept: Listing[];
  /** Koľko inzerátov vyhodilo pravidlo o dopytových inzerátoch. */
  demand: number;
  /** Koľko inzerátov vyhodilo pravidlo o chýbajúcom nájme. */
  noPrice: number;
}

/**
 * Vyhodí inzeráty, ktoré nespĺňajú kritériá, zvyšku dopočíta cenu s energiami
 * a skóre. Zoradené od najvyššieho skóre, pri zhode od najlacnejšieho.
 *
 * Inzerát sa ráta tomu pravidlu, ktoré ho vyhodilo ako prvé – dopyt bez ceny
 * teda pribudne k dopytom, nie k obom počtom naraz.
 */
export function filterListings(listings: readonly Listing[], criteria: Criteria = CRITERIA): FilterResult {
  const kept: Listing[] = [];
  let demand = 0;
  let noPrice = 0;

  for (const listing of listings) {
    const priced = withTotalPrice(listing, criteria);
    const bad = rejection(priced, criteria);

    if (bad !== null) {
      if (bad.rule === 'demand') demand += 1;
      else if (bad.rule === 'noPrice') noPrice += 1;
      continue;
    }

    kept.push({ ...priced, score: scoreListing(priced, criteria) });
  }

  kept.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.totalPriceEur ?? Infinity) - (b.totalPriceEur ?? Infinity);
  });

  return { kept, demand, noPrice };
}
