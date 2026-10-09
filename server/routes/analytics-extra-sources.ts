/**
 * Other streams' lines on the analytics dashboards (INTEGRATION §2.9). The
 * dashboards never import those streams; this file (integrator-owned) plugs
 * them in through server/analytics-dashboard/extra-sources.ts, once, at
 * route registration. Registration order (binding):
 *
 *   activity   teaser (step 4) · vdr (step 6)
 *   heads-up   vdr (step 6) · teaser (step 4)
 *
 * Teaser adapters (written at the analytics merge):
 *   - activity: "read the teaser" and "said the teaser isn't for them". The
 *     teaser's "asked for the CIM" item is dropped — the feed already lists
 *     it from the same access event (server/teaser/requests.ts writes
 *     `cim_requested` with the request), so the broker would see it twice.
 *     Each item's group comes from the dashboards' own kind → group map.
 *   - heads-up: teaser's per-deal lines become ONE line naming the deals
 *     ("3 buyers read the teaser but didn't ask for the CIM: Pacific Coast
 *     Logistics (2), Beacon Pharmacy (1)"), so on the cross-deal page it says
 *     which deal and never takes both heads-up slots. Teaser "worth a call"
 *     readers stay out of Who to call (C7).
 */
import type { Deal } from "@shared/schema";
import { ACTIVITY_GROUP_OF, TEASER_HEADS_UP_ID, type ActivityItem, type HeadsUp } from "@shared/analytics-dashboard";
import {
  registerActivitySource,
  registerHeadsUpSource,
  type ActivitySource,
  type HeadsUpSource,
} from "../analytics-dashboard/extra-sources";
import { teaserActivityItems, teaserHeadsUp } from "../teaser/analytics-sources";

/** Teaser reads and passes for the Activity feed (CIM requests come from the feed's own access events). */
export const teaserActivitySource: ActivitySource = async (deals, window) => {
  const items = await teaserActivityItems(deals, { since: window.since, until: window.now });
  return items
    .filter((i) => i.kind !== "cim_requested")
    .map((i): ActivityItem => ({ ...i, group: ACTIVITY_GROUP_OF[i.kind] }));
};

/** One heads-up line over every deal whose teaser readers didn't ask for the CIM. */
export function combineTeaserHeadsUp(
  lines: Array<Pick<HeadsUp, "id" | "count" | "names" | "link">>,
  deals: Array<Pick<Deal, "id" | "businessName">>,
): HeadsUp[] {
  const rows = lines.filter((l) => l.count > 0);
  if (rows.length === 0) return [];
  const nameOf = new Map(deals.map((d) => [`teaser-worth-${d.id}`, d.businessName || "a deal"]));
  const count = rows.reduce((n, l) => n + l.count, 0);
  const lead = `${count === 1 ? "1 buyer" : `${count} buyers`} read the teaser but didn't ask for the CIM`;
  const where = rows.length === 1
    ? nameOf.get(rows[0].id) ?? "a deal"
    : [...rows].sort((a, b) => b.count - a.count).map((l) => `${nameOf.get(l.id) ?? "a deal"} (${l.count})`).join(", ");
  return [{
    id: TEASER_HEADS_UP_ID,
    count,
    text: `${lead}: ${where}.`,
    names: rows.flatMap((l) => l.names).slice(0, 20),
    // One deal: its "Have the teaser" stage. Several: every teaser-only link, on the Analytics Buyers tab.
    link: rows.length === 1 ? rows[0].link : "/broker/analytics?tab=buyers&status=teaser_links",
  }];
}

export const teaserHeadsUpSource: HeadsUpSource = async (deals, now) =>
  combineTeaserHeadsUp(await teaserHeadsUp(deals, now.getTime()), deals);

let registered = false;

/** Called once from registerRoutes. */
export function registerAnalyticsExtraSources(): void {
  if (registered) return;
  registered = true;
  // Activity: teaser, then (step 6) vdr.
  registerActivitySource(teaserActivitySource);
  // Heads-up: (step 6) vdr, then teaser.
  registerHeadsUpSource(teaserHeadsUpSource);
}
