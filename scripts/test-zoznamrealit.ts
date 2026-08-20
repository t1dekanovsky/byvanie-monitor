/**
 * Ručná kontrola parsovania zoznamrealit.sk.
 *
 *   npm run test:zoznamrealit
 *
 * Spustí fetchZoznamRealit() naostro proti portálu a vypíše prvých 15 inzerátov
 * ako console.table, aby sa dali čísla (izby, plocha, cena, energie) porovnať
 * očami s tým, čo je na webe. Nič neposiela do Slacku a nemení data/seen.json.
 */
import { fetchZoznamRealit } from '../src/sources/zoznamrealit.js';
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
    ulica: shorten(listing.street, 22),
    nazov: shorten(listing.title, 46),
    url: listing.url.replace('https://www.zoznamrealit.sk', ''),
  };
}

async function main(): Promise<void> {
  const started = Date.now();
  const listings = await fetchZoznamRealit();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log('\nStiahnutých ' + listings.length + ' inzerátov za ' + seconds + ' s.');
  console.log('Prvých ' + Math.min(PREVIEW_COUNT, listings.length) + ':\n');
  console.table(listings.slice(0, PREVIEW_COUNT).map(toRow));

  // Rýchly prehľad, koľko polí sa vôbec podarilo vyparsovať.
  const missing = (predicate: (listing: Listing) => boolean): number => listings.filter(predicate).length;
  console.log('\nChýbajúce údaje:');
  console.log('  bez ceny:    ' + missing((l) => l.priceEur === null));
  console.log('  bez plochy:  ' + missing((l) => l.areaSqm === null));
  console.log('  bez izieb:   ' + missing((l) => l.rooms === null));
  console.log('  bez energií: ' + missing((l) => l.energiesEur === null));
  console.log('  bez ulice:   ' + missing((l) => l.street === null));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
