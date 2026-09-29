/**
 * auto-scrape — reads the business's public website without the broker
 * having to find the button.
 *
 * New Deal says "If provided, the AI will scrape public information before
 * the interview starts", but nothing scraped until the broker pressed
 * "Scrape" on the Phase 2 card, so most interviews started with no public
 * data. Now a deal created with a website is read in the background, and
 * an interview starting on a deal with a website that was never read
 * kicks it off too (the opening can't wait for it; later turns use it).
 *
 * Never for seeded demo/QA deals (their websites are fictional), never
 * twice at once for a deal, never throws.
 */
import type { Deal } from "@shared/schema";

type ScrapeFn = (dealId: string) => Promise<unknown>;

const running = new Set<string>();
/**
 * When a background read last failed, per deal. A site that is down (or a
 * name the search can't find) isn't read again on every interview opening —
 * each attempt fetches pages and runs the supporting model. The broker's
 * "Scrape" button on the Phase 2 card is not throttled.
 */
const lastFailure = new Map<string, number>();
export const AUTO_SCRAPE_RETRY_MS = 6 * 60 * 60 * 1000;

/** A website to read, not read yet, and a real deal. */
export function shouldAutoScrape(deal: Pick<Deal, "websiteUrl" | "scrapedAt"> & { demoKey?: string | null }): boolean {
  return !!deal.websiteUrl?.trim() && !deal.scrapedAt && !deal.demoKey;
}

export function scrapeInBackground(
  deal: Pick<Deal, "id" | "websiteUrl" | "scrapedAt"> & { demoKey?: string | null },
  why: string,
  scrape?: ScrapeFn,
): boolean {
  if (!shouldAutoScrape(deal) || running.has(deal.id)) return false;
  const failedAt = lastFailure.get(deal.id);
  if (failedAt !== undefined && now() - failedAt < AUTO_SCRAPE_RETRY_MS) return false;
  running.add(deal.id);
  const run = scrape
    ? Promise.resolve().then(() => scrape(deal.id))
    : import("./index").then(({ scrapeDeal }) => scrapeDeal(deal.id));
  run
    .then(() => {
      lastFailure.delete(deal.id);
      console.log(`[scraper] Read the website for deal ${deal.id} (${why})`);
    })
    .catch((err) => {
      lastFailure.set(deal.id, now());
      console.warn(`[scraper] Background website read failed for deal ${deal.id} (${why}) — not retried automatically for 6 hours:`, err?.message || err);
    })
    .finally(() => running.delete(deal.id));
  return true;
}

/** For tests. */
export function autoScrapeRunning(dealId: string): boolean {
  return running.has(dealId);
}

let clock: () => number = () => Date.now();
const now = () => clock();
/** For tests: a fake clock (omit to restore the real one). */
export function setAutoScrapeClock(fn?: () => number): void {
  clock = fn ?? (() => Date.now());
}
