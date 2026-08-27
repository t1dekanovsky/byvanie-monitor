/**
 * Ručná kontrola parsovania reality.bazos.sk.
 *
 * `npx tsx scripts/test-bazos.ts` stiahne prenájmy podľa CRITERIA a vypíše, čo sa
 * z voľného textu podarilo prečítať. Do Slacku neposiela nič a nemení data/seen.json –
 * dopĺňa len cache popisov.
 */
import { CRITERIA } from '../src/config.js';
import { filterListings } from '../src/filter.js';
import { fetchBazos } from '../src/sources/bazos.js';

const listings = await fetchBazos();
const { kept, demand, noPrice } = filterListings(listings, CRITERIA);

console.log('\n=== filter ===');
console.log('  vstup ' + listings.length + ', prešlo ' + kept.length);
console.log('  vyradených dopytových ' + demand + ', bez ceny nájmu ' + noPrice);

console.log('\n=== rozdelenie podľa lokality ===');
const byLocality = new Map<string, number>();
for (const listing of kept) {
  const key = listing.locality ?? 'neznáma';
  byLocality.set(key, (byLocality.get(key) ?? 0) + 1);
}
for (const [locality, count] of [...byLocality].sort((a, b) => b[1] - a[1])) {
  console.log('  ' + locality.padEnd(16) + count);
}

console.log('\n=== 10 najlepších ===');
for (const listing of kept.slice(0, 10)) {
  console.log(
    '\n• ' + listing.score + '/10 · ' + listing.title +
      '\n  ' + listing.rooms + ' izb · ' + listing.areaSqm + ' m² · ' + listing.priceEur + ' € · energie ' +
      listing.energiesEur + ' € · ' + listing.locality +
      '\n  ' + (listing.publishedAt ?? '?').slice(0, 10) + ' · popis ' + listing.description.length + ' znakov' +
      '\n  ' + listing.url,
  );
}
