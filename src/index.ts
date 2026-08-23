import pLimit from 'p-limit';

import { CRITERIA } from './config.js';
import { filterListings } from './filter.js';
import { createRunSummary, writeRunReport, type RunSummary, type SourceOutcome } from './report.js';
import { sendSourceError, sendToSlack, formatContext } from './slack.js';
import {
  loadSeen,
  markSeen,
  pruneOlderThan,
  isSeen,
  seenKeys,
  DEFAULT_RETENTION_DAYS,
  type SeenMap,
} from './state.js';
import type { Listing, Source } from './types.js';

import * as zoznamrealit from './sources/zoznamrealit.js';
import * as reality from './sources/reality.js';

/** Koľko zdrojov sa sťahuje naraz – portály sú malé, netreba ich zahltiť. */
const SOURCE_CONCURRENCY = 2;

/** Prvý beh pošle len toľko najlepších, zvyšok sa ticho označí ako videný. */
const FIRST_RUN_LIMIT = 15;

const SOURCES: Source[] = [
  { name: zoznamrealit.SOURCE_NAME, fetchListings: zoznamrealit.fetchListings },
  { name: reality.SOURCE_NAME, fetchListings: reality.fetchListings },
];

const DRY_RUN = process.env['DRY_RUN'] === '1' || process.env['DRY_RUN'] === 'true';

/**
 * Jednorazové dobehnutie zameškaného. Prvý beh označil ako videné aj to, čo
 * nikdy neodišlo do Slacku; s BACKFILL=1 sa strop FIRST_RUN_LIMIT nepoužije a
 * odíde všetko nové bez ohľadu na počet. Plánované behy ho nenastavujú.
 */
const BACKFILL = process.env['BACKFILL'] === '1' || process.env['BACKFILL'] === 'true';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stiahne inzeráty zo všetkých zdrojov. Každý zdroj je zabalený v try/catch –
 * keď sa jednému portálu zmení HTML, ostatné dobehnú a beh sa nezhodí.
 */
async function collectFromSources(summary: RunSummary): Promise<Listing[]> {
  const limit = pLimit(SOURCE_CONCURRENCY);

  const batches = await Promise.all(
    SOURCES.map((source) =>
      limit(async (): Promise<Listing[]> => {
        const outcome: SourceOutcome = { name: source.name, found: 0, error: null };
        summary.sources.push(outcome);

        try {
          const listings = await source.fetchListings(CRITERIA);
          outcome.found = listings.length;
          console.log('[' + source.name + '] načítaných ' + listings.length + ' inzerátov');
          return listings;
        } catch (error) {
          outcome.error = describeError(error);
          console.error('[' + source.name + '] zlyhal: ' + outcome.error);
          return [];
        }
      }),
    ),
  );

  return batches.flat();
}

/**
 * Zlúči duplicity v rámci behu. Ten istý byt visí na reality.sk aj pod dvoma URL
 * a často je aj na oboch portáloch naraz, takže sa porovnáva URL aj odtlačok
 * obsahu. Z dvojice zostáva inzerát s dlhším popisom – v ňom sa dá lepšie hľadať
 * podľa kľúčových slov.
 */
function collapseDuplicates(listings: readonly Listing[]): Listing[] {
  const byKey = new Map<string, Listing>();
  const kept: Listing[] = [];

  for (const listing of listings) {
    const keys = seenKeys(listing);
    const clash = keys.find((key) => byKey.has(key));

    if (clash === undefined) {
      for (const key of keys) byKey.set(key, listing);
      kept.push(listing);
      continue;
    }

    const previous = byKey.get(clash) as Listing;
    if (listing.description.length <= previous.description.length) continue;

    const at = kept.indexOf(previous);
    if (at >= 0) kept[at] = listing;
    else kept.push(listing);

    for (const key of seenKeys(previous)) {
      if (byKey.get(key) === previous) byKey.set(key, listing);
    }
    for (const key of keys) byKey.set(key, listing);
  }

  return kept;
}

/** Nové je to, čo v seen.json nie je ani pod URL, ani pod odtlačkom obsahu. */
function findNew(listings: readonly Listing[], seen: SeenMap): Listing[] {
  return collapseDuplicates(listings).filter((listing) => !isSeen(listing, seen));
}

function printListings(listings: readonly Listing[]): void {
  for (const listing of listings) {
    console.log(
      '\n• ' + (listing.score >= 6 ? '⭐ ' : '') + listing.title +
        '\n  ' + formatContext(listing) +
        '\n  ' + listing.url,
    );
  }
}

function failedSources(summary: RunSummary): SourceOutcome[] {
  return summary.sources.filter((source) => source.error !== null);
}

async function run(summary: RunSummary): Promise<void> {
  const seen = await loadSeen();
  // Prázdny seen.json = prvý beh. Vtedy by do Slacku spadol celý archív portálov.
  const firstRun = Object.keys(seen).length === 0;

  const collected = await collectFromSources(summary);
  console.log('[run] spolu ' + collected.length + ' inzerátov zo ' + SOURCES.length + ' zdrojov');

  const matching = filterListings(collected, CRITERIA);
  summary.matched = matching.length;

  const fresh = findNew(matching, seen);
  summary.fresh = fresh.length;
  console.log('[run] ' + matching.length + ' vyhovujúcich, z toho ' + fresh.length + ' nových');

  // fresh je zoradené podľa skóre, takže prvých 15 sú tie najlepšie.
  let toSend = fresh;
  let suppressed: Listing[] = [];
  if (BACKFILL) {
    console.log('[run] BACKFILL – posielam všetkých ' + fresh.length + ' nových, bez stropu prvého behu.');
  } else if (firstRun && fresh.length > FIRST_RUN_LIMIT) {
    toSend = fresh.slice(0, FIRST_RUN_LIMIT);
    suppressed = fresh.slice(FIRST_RUN_LIMIT);
    summary.suppressed = suppressed.length;
    console.log(
      '[run] prvý beh: posielam ' + toSend.length + ' najlepších, zvyšných ' +
        suppressed.length + ' len označím ako videné',
    );
  }

  const failures = failedSources(summary);

  if (DRY_RUN) {
    console.log('[run] DRY_RUN – do Slacku sa nič neposiela a seen.json sa nemení.');
    if (fresh.length === 0) console.log('[run] nič nové.');
    printListings(toSend);
    if (suppressed.length > 0) {
      console.log('\n[run] ďalších ' + suppressed.length + ' by sa označilo ako videné bez odoslania.');
    }
    for (const failure of failures) {
      console.log('\n[run] Slack by dostal hlásenie: zdroj ' + failure.name + ' zlyhal – ' + failure.error);
    }
    return;
  }

  // Prázdny beh mlčí. Hlásiť treba len rozbitý zdroj, inak by sa tváril ako "nič nové".
  if (fresh.length === 0 && failures.length === 0) {
    console.log('[run] nič nové, koniec.');
    return;
  }

  const webhookUrl = process.env['SLACK_WEBHOOK_URL'];
  if (!webhookUrl) {
    throw new Error('Chýba SLACK_WEBHOOK_URL (nastav ho ako GitHub secret alebo spusti s DRY_RUN=1).');
  }

  if (toSend.length > 0) {
    const delivered = await sendToSlack(toSend, webhookUrl);
    summary.sent = delivered.length;
    console.log('[slack] odoslaných ' + delivered.length + ' z ' + toSend.length + ' inzerátov');

    // Zapisujeme oba kľúče – URL aj odtlačok obsahu, nech ten istý byt pod druhou
    // URL nabudúce neprejde. Až po odoslaní a naraz; čo neodišlo, ostáva na budúce.
    const byId = new Map(toSend.map((listing) => [listing.id, listing]));
    const keys = [
      ...delivered.flatMap((id) => {
        const listing = byId.get(id);
        return listing === undefined ? [id] : seenKeys(listing);
      }),
      ...suppressed.flatMap((listing) => seenKeys(listing)),
    ];

    if (keys.length > 0) {
      await markSeen(keys);
      const pruned = await pruneOlderThan(DEFAULT_RETENTION_DAYS);
      if (pruned > 0) {
        console.log('[state] odstránených ' + pruned + ' záznamov starších ako ' + DEFAULT_RETENTION_DAYS + ' dní');
      }
    }
  }

  for (const failure of failures) {
    try {
      await sendSourceError(failure.name, failure.error as string, webhookUrl);
      console.log('[slack] nahlásený zlyhaný zdroj ' + failure.name);
    } catch (error) {
      console.error('[slack] hlásenie o zdroji ' + failure.name + ' sa nepodarilo poslať: ' + describeError(error));
    }
  }
}

async function main(): Promise<void> {
  const summary = createRunSummary(DRY_RUN, BACKFILL);
  let failure: unknown = null;

  try {
    await run(summary);
  } catch (error) {
    failure = error;
    summary.error = describeError(error);
  }

  // Report sa píše aj po páde, inak by o zlyhanom behu nezostala stopa.
  try {
    const reportPath = await writeRunReport(summary);
    console.log('[report] ' + reportPath);
  } catch (error) {
    console.error('[report] report sa nepodarilo zapísať: ' + describeError(error));
  }

  if (failure !== null) {
    console.error('[run] beh zlyhal: ' + summary.error);
    process.exitCode = 1;
  }
}

void main();
