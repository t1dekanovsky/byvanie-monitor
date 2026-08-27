import { isCommissionFree } from './config.js';
import type { Listing } from './types.js';

/** Od tohto skóre dostane inzerát hviezdičku. */
const STAR_SCORE = 6;

/** Koľko znakov popisu sa vojde do správy. */
const DESCRIPTION_LIMIT = 200;

/** Slack incoming webhook znesie zhruba jednu správu za sekundu. */
const BATCH_GAP_MS = 1000;

const POST_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Slack mrkdwn si vyhradzuje &, < a >. */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatEur(amount: number): string {
  return new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 0 }).format(amount) + ' €';
}

function shorten(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength - 1).trimEnd() + '…' : trimmed;
}

/**
 * "1 080 € všetko v cene", "850 € + 200 € energie", "950 € + odhad 175 € energie".
 * Zo samotného čísla nie je poznať, čo kryje, tak to hovoríme priamo.
 */
export function formatPrice(listing: Listing): string {
  if (listing.totalPriceEur === null || listing.priceEur === null) return 'cena neuvedená';

  const rent = formatEur(listing.priceEur);
  // „Všetko v cene" platí len dovtedy, kým sa k cene naozaj nič nepripočítava.
  // Keď popis povie vyššiu sumu spolu, hovoríme radšej rozdiel než hlavičku.
  if (listing.priceBasis === 'all_in' && listing.totalPriceEur === listing.priceEur) {
    return rent + ' všetko v cene';
  }

  const energies = formatEur(listing.energiesEur ?? 0);
  return rent + (listing.estimatedEnergies ? ' + odhad ' : ' + ') + energies + ' energie';
}

/** 1 izba, 2–4 izby, 5 a viac izieb. */
function roomsWord(rooms: number): string {
  if (rooms === 1) return 'izba';
  return rooms >= 2 && rooms <= 4 ? 'izby' : 'izieb';
}

/** "1 050 € · 78 m² · 3 izby · Bratislava II · bez provízie · skóre 8/10" */
export function formatContext(listing: Listing): string {
  const parts = [formatPrice(listing)];

  if (listing.areaSqm !== null) parts.push(listing.areaSqm + ' m²');
  if (listing.rooms !== null) parts.push(listing.rooms + ' ' + roomsWord(listing.rooms));
  if (listing.locality !== null) parts.push(listing.locality);
  if (listing.street !== null) parts.push(listing.street);
  // Inzerát od majiteľa – ušetrená provízia je to prvé, čo treba na ňom vidieť.
  if (isCommissionFree(listing)) parts.push('bez provízie');
  parts.push('skóre ' + listing.score + '/10');
  parts.push(listing.source);

  return parts.join('  ·  ');
}

/** Block Kit bloky pre jeden inzerát. */
export function formatListing(listing: Listing): unknown[] {
  const star = listing.score >= STAR_SCORE ? '⭐ ' : '';
  const title = escapeMrkdwn(listing.title === '' ? listing.url : listing.title);

  const headline: Record<string, unknown> = {
    type: 'section',
    text: { type: 'mrkdwn', text: star + '*<' + listing.url + '|' + title + '>*' },
  };

  // Náhľadová fotka ide ako accessory, aby správa zostala jednoriadková.
  if (listing.imageUrl !== null) {
    headline['accessory'] = {
      type: 'image',
      image_url: listing.imageUrl,
      alt_text: shorten(listing.title === '' ? 'foto' : listing.title, 60),
    };
  }

  const blocks: unknown[] = [
    headline,
    { type: 'context', elements: [{ type: 'mrkdwn', text: formatContext(listing) }] },
  ];

  const description = listing.description.trim();
  if (description !== '') {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: escapeMrkdwn(shorten(description, DESCRIPTION_LIMIT)) },
    });
  }

  return blocks;
}

/** Celá správa vrátane fallbacku pre notifikácie. */
export function buildMessage(listing: Listing): Record<string, unknown> {
  return {
    text: (listing.score >= STAR_SCORE ? '⭐ ' : '') + listing.title + ' – ' + formatPrice(listing),
    blocks: formatListing(listing),
  };
}

function webhookOrThrow(webhookUrl: string | undefined): string {
  const url = webhookUrl ?? process.env['SLACK_WEBHOOK_URL'];
  if (!url) throw new Error('Chýba SLACK_WEBHOOK_URL.');
  return url;
}

async function post(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // Webhook vracia obyčajné "ok"; pri chybe je v tele dôvod (napr. invalid_blocks).
    const body = (await response.text()).trim();
    if (!response.ok || body !== 'ok') {
      throw new Error('HTTP ' + response.status + ' ' + (body === '' ? response.statusText : body));
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pošle jednu správu na inzerát, medzi správami sekundová pauza.
 * Vracia id úspešne odoslaných inzerátov – len tie sa smú označiť ako videné,
 * inak by nám pri chybe uprostred dávky inzerát nenávratne vypadol.
 */
export async function sendToSlack(
  listings: readonly Listing[],
  webhookUrl?: string,
): Promise<string[]> {
  if (listings.length === 0) return [];

  const url = webhookOrThrow(webhookUrl);
  const delivered: string[] = [];

  for (const [index, listing] of listings.entries()) {
    if (index > 0) await sleep(BATCH_GAP_MS);

    try {
      await post(url, buildMessage(listing));
      delivered.push(listing.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[slack] ' + listing.url + ' sa nepodarilo odoslať: ' + reason);
    }
  }

  return delivered;
}

/**
 * Krátka textová hláška o zlyhanom zdroji. Bez nej by sa rozbitý scraper tváril
 * ako "dnes nič nové".
 */
export async function sendSourceError(
  source: string,
  message: string,
  webhookUrl?: string,
): Promise<void> {
  const url = webhookOrThrow(webhookUrl);
  const text = ':warning: Zdroj *' + source + '* zlyhal: ' + message;
  await post(url, { text });
}
