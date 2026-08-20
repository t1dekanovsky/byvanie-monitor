import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Mapa `id inzerátu -> ISO timestamp, kedy sme ho videli prvýkrát`. */
export type SeenMap = Record<string, string>;

/** Po koľkých dňoch sa záznam zahodí, aby seen.json nerástol donekonečna. */
export const DEFAULT_RETENTION_DAYS = 90;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const SEEN_FILE = path.join(DATA_DIR, 'seen.json');

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
