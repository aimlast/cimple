/**
 * One short-lived cache of reading facts per (deal, filters), shared by the
 * Engagement tab, the cross-deal call list and the broker buyer lists, so a
 * page that shows many deals doesn't reload the same facts over and over.
 * Entries last READING_RULES.cacheMs (30 s) and a new reading write in this
 * process starts a new key (readingVersion), so nothing stale outlives a send.
 */
import type { Deal } from "@shared/schema";
import { READING_RULES, type EngagementFilters } from "@shared/analytics-v2";
import { readingVersion } from "../analytics/reading-ingest";
import { loadDealReadingFacts, type CaptureFacts } from "./facts";

const cache = new Map<string, { at: number; facts: Promise<CaptureFacts> }>();
const CACHE_MAX = 200;

/** Reading facts for a deal and filter set — cached briefly (the tab polls every 20 s). */
export function cachedDealReadingFacts(deal: Deal, filters: EngagementFilters): Promise<CaptureFacts> {
  const key = `${deal.id}|${readingVersion(deal.id)}|${JSON.stringify(filters)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < READING_RULES.cacheMs) return hit.facts;
  const facts = loadDealReadingFacts(deal, filters);
  cache.set(key, { at: Date.now(), facts });
  facts.catch(() => cache.delete(key));
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return facts;
}

/** Forget a deal's cached facts (a broker action changed what they show). */
export function invalidateDealFacts(dealId: string): void {
  cache.forEach((_v, k) => { if (k.startsWith(`${dealId}|`)) cache.delete(k); });
}

/** Facts for several deals, a few at a time (each load is a handful of SQL reads); failures are skipped. */
export async function cachedFactsForDeals<D extends Deal>(deals: D[], filters: EngagementFilters, batch = 4): Promise<Array<{ deal: D; facts: CaptureFacts }>> {
  const out: Array<{ deal: D; facts: CaptureFacts }> = [];
  for (let i = 0; i < deals.length; i += batch) {
    const got = await Promise.all(deals.slice(i, i + batch).map(async (deal) => {
      try {
        return { deal, facts: await cachedDealReadingFacts(deal, filters) };
      } catch (err) {
        console.warn(`[engagement] facts for deal ${deal.id} failed:`, (err as Error).message);
        return null;
      }
    }));
    for (const g of got) if (g) out.push(g);
  }
  return out;
}
