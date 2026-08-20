import type { Criteria, Listing } from '../types.js';

export const SOURCE_NAME = 'zoznamrealit';

/** Načíta prenájmy zo zoznamrealit.sk a normalizuje ich do `Listing`. */
export async function fetchListings(_criteria: Criteria): Promise<Listing[]> {
  throw new Error('sources/zoznamrealit.fetchListings: not implemented');
}
