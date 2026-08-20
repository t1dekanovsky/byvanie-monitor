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

function containsKeyword(haystack: string, keyword: string): boolean {
  return haystack.includes(keywordStem(keyword));
}

/**
 * Doplní chýbajúce energie odhadom a dopočíta totalPriceEur.
 * Nastaví `estimatedEnergies: true`, keď sa odhad naozaj použil.
 */
export function withTotalPrice(listing: Listing, criteria: Criteria = CRITERIA): Listing {
  if (listing.priceEur === null) {
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

/** Dôvod vyradenia, alebo null keď inzerát prejde. */
export function rejectionReason(listing: Listing, criteria: Criteria = CRITERIA): string | null {
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

/**
 * Vyhodí inzeráty, ktoré nespĺňajú kritériá, zvyšku dopočíta cenu s energiami
 * a skóre. Zoradené od najvyššieho skóre, pri zhode od najlacnejšieho.
 */
export function filterListings(listings: readonly Listing[], criteria: Criteria = CRITERIA): Listing[] {
  const kept: Listing[] = [];

  for (const listing of listings) {
    const priced = withTotalPrice(listing, criteria);
    if (rejectionReason(priced, criteria) !== null) continue;
    kept.push({ ...priced, score: scoreListing(priced, criteria) });
  }

  return kept.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Inzerát bez ceny ide na koniec, nie na začiatok.
    return (a.totalPriceEur ?? Infinity) - (b.totalPriceEur ?? Infinity);
  });
}
