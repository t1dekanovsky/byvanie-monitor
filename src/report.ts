import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPORTS_DIR = path.join(ROOT_DIR, 'reports');

/** Strop na dĺžku reportu – správa o behu má zostať prehľadná. */
const MAX_LINES = 20;

export interface SourceOutcome {
  name: string;
  /** Koľko inzerátov zdroj vrátil (0 ak zlyhal). */
  found: number;
  /** Text chyby, ak zdroj spadol. */
  error: string | null;
}

export interface RunSummary {
  sources: SourceOutcome[];
  /** Koľko prešlo filtrom. */
  matched: number;
  /** Koľko z nich sme ešte nevideli. */
  fresh: number;
  /** Koľko naozaj odišlo do Slacku. */
  sent: number;
  /** Koľko sa pri prvom behu označilo ako videné bez odoslania. */
  suppressed: number;
  dryRun: boolean;
  /** Chyba, ktorá zhodila celý beh (nie jednotlivý zdroj). */
  error: string | null;
}

export function createRunSummary(dryRun: boolean): RunSummary {
  return { sources: [], matched: 0, fresh: 0, sent: 0, suppressed: 0, dryRun, error: null };
}

/** reports/YYYY-MM-DD-HHmm.md, v UTC – rovnako ako cron vo workflowe. */
export function reportFileName(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}.md`;
}

function oneLine(text: string, maxLength = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

export function renderRunReport(summary: RunSummary, now: Date): string {
  const stamp = now.toISOString().replace('T', ' ').slice(0, 16);
  const failed = summary.sources.filter((source) => source.error !== null);

  const lines: string[] = [`# Beh ${stamp} UTC${summary.dryRun ? ' (DRY_RUN)' : ''}`, ''];

  for (const source of summary.sources) {
    const status = source.error === null ? 'ok' : `ZLYHAL – ${oneLine(source.error)}`;
    lines.push(`- ${source.name}: ${source.found} inzerátov, ${status}`);
  }

  lines.push(
    '',
    `- prešlo filtrom: ${summary.matched}`,
    `- nových: ${summary.fresh}`,
    `- odoslaných do Slacku: ${summary.sent}${summary.dryRun ? ' (dry run, neposielalo sa)' : ''}`,
  );

  if (summary.suppressed > 0) {
    lines.push(`- potlačených pri prvom behu: ${summary.suppressed} (označené ako videné, neodoslané)`);
  }
  if (failed.length > 0) lines.push(`- zlyhaných zdrojov: ${failed.length}`);
  if (summary.error !== null) lines.push(`- beh skončil chybou: ${oneLine(summary.error)}`);

  return `${lines.slice(0, MAX_LINES).join('\n')}\n`;
}

/** Zapíše report o behu a vráti cestu k súboru. */
export async function writeRunReport(summary: RunSummary, now: Date = new Date()): Promise<string> {
  await mkdir(REPORTS_DIR, { recursive: true });
  const filePath = path.join(REPORTS_DIR, reportFileName(now));
  await writeFile(filePath, renderRunReport(summary, now), 'utf8');
  return filePath;
}
