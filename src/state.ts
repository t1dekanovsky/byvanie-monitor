import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Listing } from './types.js';

/** Mapa `kľúč inzerátu -> ISO timestamp, kedy sme ho videli prvýkrát`. */
export type SeenMap = Record<string, string>;

/** Po koľkých dňoch sa záznam zahodí, aby seen.json nerástol donekonečna. */
export const DEFAULT_RETENTION_DAYS = 90;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const SEEN_FILE = path.join(DATA_DIR, 'seen.json');

/**
 * Druhý kľúč identity vedľa URL. Reality.sk ten istý byt inzeruje aj pod dvoma
 * odkazmi, takže sa ešte porovnáva odtlačok obsahu: lokalita, izby, plocha
 * zaokrúhlená na celé m² a cena.
 *
 * Keď niektorý údaj chýba, vracia null – odtlačok "neznáme|neznáme|neznáme" by
 * zlial dokopy inzeráty, ktoré spolu nemajú nič spoločné.
 */
export function contentKey(listing: Listing): string | null {
  if (
    listing.locality === null ||
    listing.rooms === null ||
    listing.areaSqm === null ||
    listing.priceEur === null
  ) {
    return null;
  }

  const fingerprint = [
    listing.locality.trim().toLowerCase(),
    listing.rooms,
    Math.round(listing.areaSqm),
    listing.priceEur,
  ].join('|');

  return 'content:' + createHash('sha1').update(fingerprint).digest('hex').slice(0, 16);
}

/** Kľúče, pod ktorými inzerát vedieme v seen.json (URL a odtlačok obsahu). */
export function seenKeys(listing: Listing): string[] {
  const content = contentKey(listing);
  return content === null ? [listing.id] : [listing.id, content];
}

/** Inzerát je známy, keď v seen.json sedí ktorýkoľvek z jeho kľúčov. */
export function isSeen(listing: Listing, seen: SeenMap): boolean {
  return seenKeys(listing).some((key) => seen[key] !== undefined);
}

/**
 * Načíta data/seen.json. Ak súbor neexistuje, vytvorí ho s `{}`.
 * Poškodený súbor sa nezahodí ticho – prepíše sa na `{}` a zaloguje sa varovanie,
 * inak by beh spadol a workflow by sa nikdy nedostal cez prvý krok.
 */
export async function loadSeen(): Promise<SeenMap> {
  try {
    const raw = await readFile(SEEN_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('seen.json nie je objekt');
    }
    return parsed as SeenMap;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(`[state] ${SEEN_FILE} sa nedá prečítať (${String(error)}), zakladám nový.`);
    }
    await writeSeen({});
    return {};
  }
}

/** Zapíše mapu na disk (vrátane vytvorenia data/, ak chýba). */
export async function writeSeen(seen: SeenMap): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  // Zoradené kľúče => stabilné diffy v gite, commit obsahuje iba naozaj nové id.
  const sorted: SeenMap = {};
  for (const id of Object.keys(seen).sort()) sorted[id] = seen[id] as string;
  await writeFile(SEEN_FILE, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

/**
 * Označí id ako videné. Už existujúce záznamy si nechávajú pôvodný timestamp,
 * aby ich pruneOlderThan vedel zahodiť podľa prvého, nie posledného videnia.
 */
export async function markSeen(ids: readonly string[]): Promise<SeenMap> {
  const seen = await loadSeen();
  const now = new Date().toISOString();
  for (const id of ids) {
    if (!seen[id]) seen[id] = now;
  }
  await writeSeen(seen);
  return seen;
}

/** Zahodí záznamy staršie ako `days` dní. Vracia počet odstránených id. */
export async function pruneOlderThan(days: number = DEFAULT_RETENTION_DAYS): Promise<number> {
  const seen = await loadSeen();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const [id, iso] of Object.entries(seen)) {
    const ts = Date.parse(iso);
    // Nečitateľný timestamp berieme ako starý – inak by v súbore zostal navždy.
    if (Number.isNaN(ts) || ts < cutoff) {
      delete seen[id];
      removed += 1;
    }
  }

  if (removed > 0) await writeSeen(seen);
  return removed;
}
