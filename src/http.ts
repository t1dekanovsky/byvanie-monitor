/** Spoločné sťahovanie HTML pre všetky zdroje. */

/** Bežný desktopový prehliadač – portály odmietajú default hlavičku fetchu. */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchOptions {
  timeoutMs?: number;
  /** Koľkokrát to po zlyhaní skúsiť znova (0 = žiadny opakovaný pokus). */
  retries?: number;
  /**
   * Pauza pred ďalším pokusom. Portály, ktoré vracajú HTTP 429, okamžité
   * zopakovanie odmietnu rovnako – tým sa im dá čas vydýchnuť si.
   */
  retryDelayMs?: number;
  /** Predpona do logu, zvyčajne názov zdroja. */
  label?: string;
}

/** Jedno stiahnutie s tvrdým timeoutom cez AbortController. */
export async function fetchHtml(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'sk-SK,sk;q=0.9,cs;q=0.8,en;q=0.7',
      },
    });

    if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Stiahne stránku, po zlyhaní to skúsi znova. Poslednú chybu púšťa ďalej. */
export async function fetchHtmlWithRetry(url: string, options: FetchOptions = {}): Promise<string> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, retryDelayMs = 0, label = 'http' } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchHtml(url, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn('[' + label + '] ' + url + ' zlyhalo (' + reason + '), skúšam znova');
        // Pauza rastie s pokusom – druhé odmietnutie znamená, že portál chce viac pokoja.
        if (retryDelayMs > 0) await sleep(retryDelayMs * (attempt + 1));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
