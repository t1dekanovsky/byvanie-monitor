import pLimit from 'p-limit';

import { CRITERIA } from './config.js';
import { filterListings } from './filter.js';
import { createRunSummary, writeRunReport, type RunSummary, type SourceOutcome } from './report.js';
import { sendSourceError, sendToSlack, formatContext } from './slack.js';
import { loadSeen, markSeen, pruneOlderThan, DEFAULT_RETENTION_DAYS, type SeenMap } from './state.js';
import type { Listing, Source } from './types.js';

import * as zoznamrealit from './sources/zoznamrealit.js';
import * as reality from './sources/reality.js';

/** Koľko zdrojov sa sťahuje naraz – portály sú malé, netreba ich zahltiť. */
const SOURCE_CONCURRENCY = 2;

const SOURCES: Source[] = [
  { name: zoznamrealit.SOURCE_NAME, fetchListings: zoznamrealit.fetchListings },
  { name: reality.SOURCE_NAME, fetchListings: reality.fetchListings },
];

const DRY_RUN = process.env['DRY_RUN'] === '1' || process.env['DRY_RUN'] === 'true';

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

/** Zahodí duplicity v rámci behu aj všetko, čo už je v data/seen.json. */
function dedupe(listings: readonly Listing[], seen: SeenMap): Listing[] {
  const fresh: Listing[] = [];
  const idsInRun = new Set<string>();

  for (const listing of listings) {
    if (seen[listing.id] !== undefined || idsInRun.has(listing.id)) continue;
    idsInRun.add(listing.id);
    fresh.push(listing);
  }

  return fresh;
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
  const collected = await collectFromSources(summary);
  console.log('[run] spolu ' + collected.length + ' inzerátov zo ' + SOURCES.length + ' zdrojov');

  const matching = filterListings(collected, CRITERIA);
  summary.matched = matching.length;

  const fresh = dedupe(matching, seen);
  summary.fresh = fresh.length;
  console.log('[run] ' + matching.length + ' vyhovujúcich, z toho ' + fresh.length + ' nových');

  const failures = failedSources(summary);

  if (DRY_RUN) {
    console.log('[run] DRY_RUN – do Slacku sa nič neposiela a seen.json sa nemení.');
    if (fresh.length === 0) console.log('[run] nič nové.');
    printListings(fresh);
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

  if (fresh.length > 0) {
    const delivered = await sendToSlack(fresh, webhookUrl);
    summary.sent = delivered.length;
    console.log('[slack] odoslaných ' + delivered.length + ' z ' + fresh.length + ' inzerátov');

    // Až po odoslaní a naraz za celú dávku – čo neodišlo, ostáva na budúci beh.
    if (delivered.length > 0) {
      await markSeen(delivered);
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
  const summary = createRunSummary(DRY_RUN);
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
