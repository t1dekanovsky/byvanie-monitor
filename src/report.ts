import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatPrice } from './slack.js';
import type { Listing } from './types.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPORTS_DIR = path.join(ROOT_DIR, 'reports');

/** Strop na dĺžku reportu – správa o behu má zostať pod 120 riadkov. */
const MAX_LINES = 119;

/** Réžia jednej sekcie so zoznamom: prázdny riadok a nadpis. */
const SECTION_OVERHEAD = 2;

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
  /** Koľko inzerátov vyhodilo pravidlo o dopytových inzerátoch. */
  rejectedDemand: number;
  /** Koľko inzerátov vyhodilo pravidlo o chýbajúcom nájme. */
  rejectedNoPrice: number;
  /** Koľko z nich sme ešte nevideli. */
  fresh: number;
  /** Inzeráty, ktoré naozaj odišli do Slacku. */
  sent: Listing[];
  /**
   * Inzeráty označené ako videné bez odoslania – dnes ich zadrží iba strop
   * prvého behu, s BACKFILL=1 zostáva zoznam prázdny. V reporte sú preto, aby
   * sa nedali stratiť a nemuseli sa loviť z histórie Slacku.
   */
  suppressed: Listing[];
  dryRun: boolean;
  /** Jednorazový beh s BACKFILL=1 – strop prvého behu sa nepoužil. */
  backfill: boolean;
  /** Chyba, ktorá zhodila celý beh (nie jednotlivý zdroj). */
  error: string | null;
}

export function createRunSummary(dryRun: boolean, backfill = false): RunSummary {
  return {
    sources: [],
    matched: 0,
    rejectedDemand: 0,
    rejectedNoPrice: 0,
    fresh: 0,
    sent: [],
    suppressed: [],
    dryRun,
    backfill,
    error: null,
  };
}

/** Riadok zoznamu: skóre, cena spolu, plocha, lokalita a odkaz. */
function renderEntry(listing: Listing): string {
  const area = listing.areaSqm === null ? 'plocha neuvedená' : `${listing.areaSqm} m²`;
  const locality = listing.locality ?? 'lokalita neuvedená';
  return `- ${listing.score}/10 · ${formatPrice(listing)} · ${area} · ${locality} · ${listing.url}`;
}

/** Koľko riadkov by sekcia zabrala celá. Prázdny zoznam sa nevypisuje vôbec. */
function sectionHeight(listings: readonly Listing[]): number {
  return listings.length === 0 ? 0 : SECTION_OVERHEAD + listings.length;
}

/**
 * Rozdelí zvyšok stropu medzi obe sekcie. Keď sa zmestia obe, dostanú celé.
 * Inak si miesto delia na polovicu, pričom kratšia sekcia požičia nevyužité
 * riadky tej dlhšej – inak by sa dlhý zoznam odrezal aj vtedy, keď je vedľa
 * neho miesto zadarmo.
 */
function splitBudget(sent: number, suppressed: number, room: number): [number, number] {
  if (sent + suppressed <= room) return [sent, suppressed];

  const half = Math.floor(room / 2);
  if (sent <= half) return [sent, room - sent];
  if (suppressed <= half) return [room - suppressed, suppressed];
  return [room - half, half];
}

/**
 * Sekcia zoradená od najvyššieho skóre, pri zhode od najlacnejšieho – rovnako
 * ako filter. Keď sa celá nezmestí, posledný riadok povie, koľko inzerátov
 * vypadlo; bez neho by sa skrátený zoznam tváril ako úplný.
 */
function renderSection(title: string, listings: readonly Listing[], budget: number): string[] {
  if (listings.length === 0 || budget < SECTION_OVERHEAD + 1) return [];

  const ordered = [...listings].sort(
    (a, b) => b.score - a.score || (a.totalPriceEur ?? Infinity) - (b.totalPriceEur ?? Infinity),
  );

  const room = budget - SECTION_OVERHEAD;
  // Hláška o vynechaných si tiež pýta riadok, inak by zmizla práve ona.
  const shown = room >= ordered.length ? ordered.length : room - 1;

  const lines = ['', `## ${title} (${ordered.length})`];
  for (const listing of ordered.slice(0, shown)) lines.push(renderEntry(listing));
  if (shown < ordered.length) {
    // Dvojbodka namiesto „ďalších N" – číslo sa mení a slovenčina by pri 2–4 pýtala iný tvar.
    lines.push(`- … nezmestilo sa do reportu: ${ordered.length - shown}`);
  }

  return lines;
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

  // Podľa hlavičky sa dá spätne rozoznať jednorazový backfill od bežného behu.
  const flags = [summary.backfill ? 'BACKFILL' : null, summary.dryRun ? 'DRY_RUN' : null].filter(
    (flag): flag is string => flag !== null,
  );
  const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : '';

  const lines: string[] = [`# Beh ${stamp} UTC${suffix}`, ''];

  for (const source of summary.sources) {
    const status = source.error === null ? 'ok' : `ZLYHAL – ${oneLine(source.error)}`;
    lines.push(`- ${source.name}: ${source.found} inzerátov, ${status}`);
  }

  lines.push(
    '',
    `- prešlo filtrom: ${summary.matched}`,
    // Obe pravidlá sa vypisujú vždy, aj s nulou – nech je vidieť, že bežia.
    `- vyradených ako dopyt: ${summary.rejectedDemand}`,
    `- vyradených bez ceny nájmu: ${summary.rejectedNoPrice}`,
    `- nových: ${summary.fresh}`,
    `- odoslaných do Slacku: ${summary.sent.length}${summary.dryRun ? ' (dry run, neposielalo sa)' : ''}`,
  );

  if (summary.suppressed.length > 0) {
    lines.push(
      `- potlačených pri prvom behu: ${summary.suppressed.length} (označené ako videné, neodoslané)`,
    );
  }
  if (failed.length > 0) lines.push(`- zlyhaných zdrojov: ${failed.length}`);
  if (summary.error !== null) lines.push(`- beh skončil chybou: ${oneLine(summary.error)}`);

  // Zoznamy sú jediné, čo vie report natiahnuť, tak si delia zvyšok stropu.
  const [sentRoom, suppressedRoom] = splitBudget(
    sectionHeight(summary.sent),
    sectionHeight(summary.suppressed),
    Math.max(MAX_LINES - lines.length, 0),
  );
  lines.push(...renderSection('Odoslané', summary.sent, sentRoom));
  lines.push(...renderSection('Potlačené', summary.suppressed, suppressedRoom));

  return `${lines.slice(0, MAX_LINES).join('\n')}\n`;
}

/** Zapíše report o behu a vráti cestu k súboru. */
export async function writeRunReport(summary: RunSummary, now: Date = new Date()): Promise<string> {
  await mkdir(REPORTS_DIR, { recursive: true });
  const filePath = path.join(REPORTS_DIR, reportFileName(now));
  await writeFile(filePath, renderRunReport(summary, now), 'utf8');
  return filePath;
}
