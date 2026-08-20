/**
 * Ručná kontrola parsovania reality.sk.
 *
 *   npm run test:reality
 *
 * Spustí fetchReality() naostro proti portálu a vypíše prvých 15 inzerátov ako
 * console.table, aby sa dali čísla porovnať očami s webom. Nič neposiela do Slacku
 * a nemení data/seen.json – dopĺňa len cache popisov v data/descriptions.json.
 */
import { fetchReality } from '../src/sources/reality.js';
import type { Listing } from '../src/types.js';

const PREVIEW_COUNT = 15;

function shorten(text: string | null, maxLength: number): string {
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
}

function toRow(listing: Listing): Record<string, string | number | null> {
  return {
    izby: listing.rooms,
    'm2': listing.areaSqm,
    'cena €': listing.priceEur,
    'energie €': listing.energiesEur,
    'spolu €': listing.totalPriceEur,
    lokalita: listing.locality,
    ulica: shorten(listing.street, 20),
    'popis zn.': listing.description.length,
    datum: listing.publishedAt === null ? '' : listing.publishedAt.slice(0, 10),
    nazov: shorten(listing.title, 40),
  };
}

async function main(): Promise<void> {
  const started = Date.now();
  const listings = await fetchReality();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log('\nStiahnutých ' + listings.length + ' inzerátov za ' + seconds + ' s.');
  console.log('Prvých ' + Math.min(PREVIEW_COUNT, listings.length) + ':\n');
  console.table(listings.slice(0, PREVIEW_COUNT).map(toRow));

  const missing = (predicate: (listing: Listing) => boolean): number => listings.filter(predicate).length;
  console.log('\nChýbajúce údaje:');
  console.log('  bez ceny:    ' + missing((l) => l.priceEur === null));
  console.log('  bez plochy:  ' + missing((l) => l.areaSqm === null));
  console.log('  bez izieb:   ' + missing((l) => l.rooms === null));
  console.log('  bez energií: ' + missing((l) => l.energiesEur === null));
  console.log('  bez ulice:   ' + missing((l) => l.street === null));
  console.log('  bez dátumu:  ' + missing((l) => l.publishedAt === null));
  console.log('  bez obrázka: ' + missing((l) => l.imageUrl === null));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
