/**
 * Ručná kontrola ohľaduplnosti voči Bazošu: čakanie po HTTP 429 a zatvorenie zdroja.
 *
 * `npx tsx scripts/test-bazos-backoff.ts` postaví lokálny server, ktorý vždy odpovie
 * 429, a nechá naň zdroj naraziť. Trvá vyše 90 sekúnd – toľko sú tie čakačky.
 * Na Bazoš sa pritom nesiahne ani raz.
 */
import { createServer } from 'node:http';

import { politeFetch } from '../src/sources/bazos.js';

let hits = 0;
const server = createServer((req, res) => {
  hits += 1;
  console.log('  server: pokus ' + hits + ', User-Agent: ' + (req.headers['user-agent'] ?? '(žiadny)'));
  res.writeHead(429, { 'Content-Type': 'text/html' });
  res.end('Too Many Requests');
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/';

const started = Date.now();
try {
  await politeFetch(url);
  console.log('CHYBA: malo to spadnúť');
} catch (error) {
  console.log('  1. volanie spadlo po ' + Math.round((Date.now() - started) / 1000) + ' s: ' + String(error));
}

const afterFirst = Date.now();
try {
  await politeFetch(url);
  console.log('CHYBA: druhé volanie malo byť odmietnuté bez siete');
} catch (error) {
  console.log('  2. volanie spadlo po ' + (Date.now() - afterFirst) + ' ms: ' + String(error));
}

console.log('\n  pokusov na server: ' + hits + ' (čakané 3 – prvý, po 30 s a po 60 s)');
console.log('  druhé volanie server nezaťažilo: ' + (hits === 3));
server.close();
