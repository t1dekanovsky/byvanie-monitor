import type { Criteria, Listing } from '../types.js';

export const SOURCE_NAME = 'reality';

/** Načíta prenájmy z reality.sk a normalizuje ich do `Listing`. */
export async function fetchListings(_criteria: Criteria): Promise<Listing[]> {
  throw new Error('sources/reality.fetchListings: not implemented');
}
