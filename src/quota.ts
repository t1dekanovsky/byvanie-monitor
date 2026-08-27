import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DATA_DIR } from './state.js';

/**
 * Denný strop na počet behov jedného zdroja. Bazoš sťahujeme cez cesty, ktoré má
 * v robots.txt zakázané, takže mu na oplátku držíme pevný rozpočet: dva behy za
 * kalendárny deň a dosť, nech sa spustí čokoľvek – plán, ručné spustenie aj backfill.
 *
 * Počítadlo leží v `data/` vedľa seen.json, takže ho workflow commitne späť do repa
 * a strop platí naprieč behmi, nie len v jednom procese.
 */
export const QUOTA_FILE = path.join(DATA_DIR, 'run-quota.json');

export interface SourceQuota {
  /** Kalendárny deň v UTC, `YYYY-MM-DD`. */
  date: string;
  runs: number;
}

export type QuotaMap = Record<string, SourceQuota>;

/** Zdroj sa v tomto behu preskočil. Nie je to chyba, len vyčerpaný rozpočet. */
export class SourceSkipped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceSkipped';
  }
}

/** Kalendárny deň v UTC – rovnaká zóna, v akej bežia plánované behy aj reporty. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Načíta počítadlo; chýbajúci či rozbitý súbor berie ako prázdny. */
export async function loadQuota(): Promise<QuotaMap> {
  try {
    const parsed: unknown = JSON.parse(await readFile(QUOTA_FILE, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(path.basename(QUOTA_FILE) + ' nie je objekt');
    }
    return parsed as QuotaMap;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn('[quota] ' + path.basename(QUOTA_FILE) + ' sa nedá prečítať (' + String(error) + '), zakladám nový.');
    }
    return {};
  }
}

async function saveQuota(quota: QuotaMap): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const sorted: QuotaMap = {};
  for (const source of Object.keys(quota).sort()) sorted[source] = quota[source] as SourceQuota;
  await writeFile(QUOTA_FILE, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

/**
 * Zaberie jeden beh z denného rozpočtu. Vracia `false`, keď je na dnes vyčerpaný.
 *
 * Zapisuje sa hneď na začiatku behu, ešte pred sťahovaním – keby sa počítalo až po
 * úspechu, zdroj, ktorý padá, by sa dal skúšať donekonečna. Z rovnakého dôvodu sa
 * ráta aj DRY_RUN: sieť zaťaží rovnako ako ostrý beh.
 */
export async function claimRun(source: string, maxPerDay: number, now: Date = new Date()): Promise<boolean> {
  const quota = await loadQuota();
  const today = utcDay(now);
  const current = quota[source];
  const runs = current !== undefined && current.date === today ? current.runs : 0;

  if (runs >= maxPerDay) return false;

  quota[source] = { date: today, runs: runs + 1 };
  await saveQuota(quota);
  return true;
}
