/**
 * Ručná kontrola parsovania nehnutelnosti.sk.
 *
 * `npx tsx scripts/test-nehnutelnosti.ts` stiahne prenájmy podľa CRITERIA
 * a vypíše, čo sa z nich podarilo prečítať. Do Slacku neposiela nič
 * a nemení data/seen.json – dopĺňa len cache popisov.
 */
import { fetchNehnutelnosti } from '../src/sources/nehnutelnosti.js';
import type { Listing } from '../src/types.js';

function coverage(listings: readonly Listing[], field: keyof Listing): string {
  const filled = listings.filter((listing) => listing[field] !== null && listing[field] !== '').length;
  return field + ': ' + filled + '/' + listings.length;
}

const listings = await fetchNehnutelnosti();

console.log('\n=== pokrytie polí ===');
for (const field of ['priceEur', 'areaSqm', 'rooms', 'street', 'description', 'imageUrl', 'publishedAt'] as const) {
  console.log('  ' + coverage(listings, field));
}

console.log('\n=== prvých 5 inzerátov ===');
for (const listing of listings.slice(0, 5)) {
  console.log(
    '\n• ' + listing.title +
      '\n  ' + listing.rooms + ' izb · ' + listing.areaSqm + ' m² · ' + listing.priceEur + ' € · energie ' +
      listing.energiesEur + ' € · ' + listing.locality + ' · ' + listing.street +
      '\n  ' + listing.publishedAt + ' · popis ' + listing.description.length + ' znakov' +
      '\n  ' + listing.url,
  );
}
