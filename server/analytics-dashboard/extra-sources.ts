/**
 * Plug-in points for other streams' activity and heads-up lines, so the
 * analytics dashboards never import their code (INTEGRATION §2.9):
 *
 *   registerActivitySource(teaserActivityItems)   teaser reads ("read the teaser")
 *   registerActivitySource(vdrActivityItems)      data-room events (kind "data_room")
 *   registerHeadsUpSource(vdrHeadsUp)             "{Name} is in the data room now"
 *   registerHeadsUpSource(teaserHeadsUp)          "{n} buyers read the teaser but didn't ask for the CIM"
 *
 * Registered by the integrator after those streams merge (none at merge).
 * A source that throws is logged and skipped: it never breaks the feed.
 */
import type { Deal } from "@shared/schema";
import type { ActivityItem, HeadsUp } from "@shared/analytics-dashboard";

export interface ActivityWindow {
  /** null = all time */
  since: Date | null;
  now: Date;
}
export type ActivitySource = (deals: Deal[], window: ActivityWindow) => Promise<ActivityItem[]>;
export type HeadsUpSource = (deals: Deal[], now: Date) => Promise<HeadsUp[]>;

const activitySources: ActivitySource[] = [];
const headsUpSources: HeadsUpSource[] = [];

export function registerActivitySource(fn: ActivitySource): void {
  if (!activitySources.includes(fn)) activitySources.push(fn);
}

export function registerHeadsUpSource(fn: HeadsUpSource): void {
  if (!headsUpSources.includes(fn)) headsUpSources.push(fn);
}

/** Whether any activity source is registered (the "Data room" kind chip shows only then). */
export function hasActivitySources(): boolean {
  return activitySources.length > 0;
}

/** Every registered source's items for these deals (failures skipped). */
export async function extraActivity(deals: Deal[], window: ActivityWindow): Promise<ActivityItem[]> {
  if (activitySources.length === 0 || deals.length === 0) return [];
  const got = await Promise.all(activitySources.map(async (fn) => {
    try {
      return await fn(deals, window);
    } catch (err) {
      console.warn("[analytics] an activity source failed:", (err as Error)?.message ?? err);
      return [];
    }
  }));
  const ids = new Set(deals.map((d) => d.id));
  return got.flat().filter((i) => ids.has(i.dealId));
}

/** Every registered source's heads-up lines, in registration order (failures skipped). */
export async function extraHeadsUp(deals: Deal[], now: Date): Promise<HeadsUp[]> {
  if (headsUpSources.length === 0 || deals.length === 0) return [];
  const got = await Promise.all(headsUpSources.map(async (fn) => {
    try {
      return await fn(deals, now);
    } catch (err) {
      console.warn("[analytics] a heads-up source failed:", (err as Error)?.message ?? err);
      return [];
    }
  }));
  return got.flat().filter((h) => h.count > 0 && !!h.text);
}

/** Tests: forget every registered source. */
export function _resetExtraSources(): void {
  activitySources.length = 0;
  headsUpSources.length = 0;
}
