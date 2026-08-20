import type { Criteria, Listing } from './types.js';

/**
 * Doplní chýbajúce energie odhadom a dopočíta totalPriceEur.
 * Nastaví `estimatedEnergies: true`, ak sa odhad naozaj použil.
 */
export function withTotalPrice(_listing: Listing, _criteria: Criteria): Listing {
  throw new Error('filter.withTotalPrice: not implemented');
}

/**
 * Skóre zhody: kladné kľúčové slová pridávajú, blízkosť k stropu ceny uberá.
 * Používa sa na zoradenie správ v Slacku, nie na vyradenie inzerátu.
 */
export function scoreListing(_listing: Listing, _criteria: Criteria): number {
  throw new Error('filter.scoreListing: not implemented');
}

/**
 * Vyhodí inzeráty, ktoré nespĺňajú kritériá (izby, plocha, cena, lokalita,
 * negatívne kľúčové slová) a zvyšku doplní `score`. Vracia ich zoradené
 * od najvyššieho skóre.
 */
export function filterListings(_listings: readonly Listing[], _criteria: Criteria): Listing[] {
  throw new Error('filter.filterListings: not implemented');
}
