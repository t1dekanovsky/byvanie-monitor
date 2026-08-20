import type { Listing } from './types.js';

/** Jeden inzerát preložený do Slack Block Kit blokov. */
export function formatListing(_listing: Listing): unknown[] {
  throw new Error('slack.formatListing: not implemented');
}

/**
 * Pošle inzeráty do Slacku cez incoming webhook.
 * Volajúci garantuje, že `listings` je neprázdne a už odfiltrované aj deduplikované.
 */
export async function postListings(_listings: readonly Listing[], _webhookUrl: string): Promise<void> {
  throw new Error('slack.postListings: not implemented');
}
