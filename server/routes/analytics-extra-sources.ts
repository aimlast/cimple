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
 *
 * Data-room adapters (written at the vdr merge; vdr owns the wording —
 * server/vdr/activity-report.ts vdrTimelineEvents):
 *   - activity: each buyer's data-room timeline lines ("opened 3 documents in
 *     the data room · 12 min", "downloaded …", "asked for a document", "added
 *     their accountant …", "was given the data room"), named, kind and group
 *     `data_room`, linking to that buyer's log in the deal's Data room tab.
 *     Demo views (the founder-approved demo seed, `vdr_views.source='demo'`)
 *     come as `sample` items, like the heat map's sample reading.
 *   - heads-up: ONE line over every deal — "{Name} is in the {deal} data room
 *     now" while someone reads there (the reading-now window), else "{n}
 *     buyers opened the {deal} data room this week". Never a demo or preview
 *     view.
 */
import type { BuyerAccess, Deal, VdrActivity, VdrItem, VdrView } from "@shared/schema";
import {
  ACTIVITY_GROUP_OF, TEASER_HEADS_UP_ID, VDR_NOW_HEADS_UP_ID, VDR_WEEK_HEADS_UP_ID, plural, type ActivityItem, type HeadsUp,
} from "@shared/analytics-dashboard";
import { READING_RULES, formatReadingTime } from "@shared/analytics-v2";
import { seesCim } from "@shared/access-levels";
import { buyerKey } from "@shared/vdr";
import { vdrTimelineEvents } from "../vdr/activity-report";
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

// ── The data room (vdr, step 6) ──────────────────────────────────────────

type VdrLink = Pick<BuyerAccess, "id" | "buyerEmail" | "buyerName" | "buyerCompany" | "accessLevel" | "createdAt" | "revokedAt">;

/** What the data-room lines read for one deal that has a data room. */
export interface VdrDealActivity {
  accesses: Array<VdrLink & Pick<BuyerAccess, "dealId">>;
  views: VdrView[];
  activity: VdrActivity[];
  items: Array<Pick<VdrItem, "id" | "title">>;
}
/** Deal id → its data-room activity; deals without a data room are absent. */
export type VdrDealActivityLoader = (dealIds: string[]) => Promise<Map<string, VdrDealActivity>>;

const loadVdrDealActivity: VdrDealActivityLoader = async (dealIds) => {
  const out = new Map<string, VdrDealActivity>();
  if (dealIds.length === 0) return out;
  const [{ db }, { vdrRooms }, { inArray }, { dbVdrStore }, { storage }] = await Promise.all([
    import("../db"), import("@shared/schema"), import("drizzle-orm"), import("../vdr/store"), import("../storage"),
  ]);
  // One query for which deals have a room; only those are read further.
  const rooms = await db.select({ dealId: vdrRooms.dealId }).from(vdrRooms).where(inArray(vdrRooms.dealId, dealIds));
  await Promise.all(rooms.map(async ({ dealId }) => {
    const [accesses, views, activity, items] = await Promise.all([
      storage.getBuyerAccessByDeal(dealId), dbVdrStore.listViews(dealId), dbVdrStore.listActivity(dealId, 5000), dbVdrStore.listItems(dealId),
    ]);
    out.set(dealId, { accesses, views, activity, items });
  }));
  return out;
};

let vdrLoader: VdrDealActivityLoader = loadVdrDealActivity;
/** Tests: read data-room activity from a stub (null = the database). */
export function _setVdrDealActivityLoaderForTests(fn: VdrDealActivityLoader | null): void {
  vdrLoader = fn ?? loadVdrDealActivity;
}

/** A buyer's links by vdr's buyer key (the email, lower-cased). */
function linksByBuyer<T extends VdrLink>(accesses: ReadonlyArray<T>): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const a of accesses) {
    const k = buyerKey(a.buyerEmail);
    if (!k) continue;
    const list = out.get(k) ?? [];
    list.push(a);
    out.set(k, list);
  }
  return out;
}

/** The link a buyer's data-room line names: their newest live CIM link, else their newest link. */
function representative<T extends VdrLink>(links: ReadonlyArray<T>): T {
  const newest = [...links].sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
  return newest.find((a) => !a.revokedAt && seesCim(a.accessLevel)) ?? newest.find((a) => seesCim(a.accessLevel)) ?? newest[0];
}

const personName = (a: VdrLink) => a.buyerName || a.buyerCompany || a.buyerEmail;

/**
 * vdr's profile wording ("Opened 3 documents in the data room · 12 min",
 * "Given the data room") as a named feed line: "Tom Reyes opened 3 documents
 * in the data room" with "12 min" as the detail.
 */
export function vdrFeedWords(who: string, title: string): { title: string; detail: string | null } {
  const [head, ...rest] = title.split(" · ");
  const detail = rest.join(" · ") || null;
  if (head === "Given the data room") return { title: `${who} was given the data room`, detail };
  if (head === "Data room turned off for them") return { title: `Data room turned off for ${who}`, detail };
  return { title: `${who} ${head.charAt(0).toLowerCase()}${head.slice(1)}`, detail };
}

/** One deal's data-room lines for the Activity feed (pure). */
export function vdrActivityItemsFor(
  deal: Pick<Deal, "id" | "businessName">,
  d: VdrDealActivity,
  window: { since: Date | null; now: Date },
): ActivityItem[] {
  const out: ActivityItem[] = [];
  const since = window.since ? window.since.getTime() : Number.NEGATIVE_INFINITY;
  const until = window.now.getTime();
  const fmt = (seconds: number) => formatReadingTime(seconds * 1000);
  for (const [key, links] of Array.from(linksByBuyer(d.accesses).entries())) {
    const rep = representative(links);
    const who = personName(rep);
    const views = d.views.filter((v) => buyerKey(v.buyerEmail) === key);
    const real = views.filter((v) => v.source !== "demo");
    const demo = views.filter((v) => v.source === "demo");
    const events = [
      ...vdrTimelineEvents({ accesses: links, views: real, activity: d.activity, items: d.items }, fmt).map((e) => ({ e, sample: false })),
      ...(demo.length ? vdrTimelineEvents({ accesses: links, views: demo, activity: [], items: d.items }, fmt).map((e) => ({ e, sample: true })) : []),
    ];
    for (const { e, sample } of events) {
      const t = Date.parse(e.at);
      if (!(t >= since && t <= until)) continue;
      const words = vdrFeedWords(who, e.title);
      const row: ActivityItem = {
        id: `vdr:${rep.id}:${e.id}${sample ? ":sample" : ""}`,
        at: e.at,
        kind: "data_room",
        group: ACTIVITY_GROUP_OF.data_room,
        dealId: deal.id,
        dealName: deal.businessName,
        accessId: rep.id,
        name: rep.buyerName || rep.buyerEmail,
        company: rep.buyerCompany ?? null,
        title: words.title,
        detail: words.detail,
        tone: e.tone ?? "neutral",
        link: { href: `/deal/${deal.id}/data-room?view=activity&activity=log&buyer=${encodeURIComponent(rep.id)}`, label: "See activity" },
      };
      if (sample) row.sample = true;
      out.push(row);
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export const vdrActivitySource: ActivitySource = async (deals, window) => {
  const byDeal = await vdrLoader(deals.map((d) => d.id));
  return deals.flatMap((deal) => {
    const d = byDeal.get(deal.id);
    return d ? vdrActivityItemsFor(deal, d, window) : [];
  });
};

const WEEK_MS = 7 * 86_400_000;

function namesWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * At most ONE data-room heads-up line over every deal (pure): who is in a
 * data room now (the reading-now window), else who opened one in the last
 * 7 days. Preview (the broker's "View as") and demo views never count; only
 * people holding a buyer link on that deal (their team counts as them).
 */
export function vdrHeadsUpFor(
  deals: Array<Pick<Deal, "id" | "businessName">>,
  byDeal: Map<string, VdrDealActivity>,
  now: Date,
): HeadsUp[] {
  const nowMs = now.getTime();
  type Row = { dealId: string; dealName: string; names: string[] };
  const live: Row[] = [];
  const week: Row[] = [];
  for (const deal of deals) {
    const d = byDeal.get(deal.id);
    if (!d) continue;
    const links = linksByBuyer(d.accesses);
    const liveKeys = new Set<string>();
    const weekKeys = new Set<string>();
    for (const v of d.views) {
      if (v.source === "preview" || v.source === "demo") continue;
      const key = buyerKey(v.buyerEmail);
      if (!links.has(key)) continue;
      const seen = new Date(v.lastSeenAt).getTime();
      if (seen <= nowMs + 60_000 && nowMs - seen <= READING_RULES.readingNowMs) liveKeys.add(key);
      if (nowMs - new Date(v.startedAt).getTime() <= WEEK_MS) weekKeys.add(key);
    }
    const nameRow = (keys: Set<string>): Row => ({
      dealId: deal.id, dealName: deal.businessName || "a deal",
      names: Array.from(keys).map((k) => personName(representative(links.get(k)!))).sort((a, b) => a.localeCompare(b)),
    });
    if (liveKeys.size) live.push(nameRow(liveKeys));
    if (weekKeys.size) week.push(nameRow(weekKeys));
  }
  const pick = live.length ? live : week;
  if (pick.length === 0) return [];
  const isLive = pick === live;
  const count = pick.reduce((n, r) => n + r.names.length, 0);
  const names = pick.flatMap((r) => r.names);
  const one = pick.length === 1 ? pick[0] : null;
  const where = [...pick].sort((a, b) => b.names.length - a.names.length).map((r) => `${r.dealName} (${r.names.length})`).join(", ");
  const text = isLive
    ? one
      ? `${namesWords(one.names)} ${one.names.length === 1 ? "is" : "are"} in the ${one.dealName} data room now.`
      : `${plural(count, "buyer")} are in a data room now: ${where}.`
    : one
      ? `${plural(count, "buyer")} opened the ${one.dealName} data room this week.`
      : `${plural(count, "buyer")} opened a data room this week: ${where}.`;
  return [{
    id: isLive ? VDR_NOW_HEADS_UP_ID : VDR_WEEK_HEADS_UP_ID,
    count,
    text,
    names: names.slice(0, 20),
    // One deal: its Data room activity. Several: the data-room lines in Activity.
    link: one ? `/deal/${one.dealId}/data-room?view=activity` : "/broker/analytics?tab=activity&kind=data_room",
  }];
}

export const vdrHeadsUpSource: HeadsUpSource = async (deals, now) =>
  vdrHeadsUpFor(deals, await vdrLoader(deals.map((d) => d.id)), now);

let registered = false;

/** Called once from registerRoutes. */
export function registerAnalyticsExtraSources(): void {
  if (registered) return;
  registered = true;
  // Activity: teaser, then vdr.
  registerActivitySource(teaserActivitySource);
  registerActivitySource(vdrActivitySource);
  // Heads-up: vdr, then teaser.
  registerHeadsUpSource(vdrHeadsUpSource);
  registerHeadsUpSource(teaserHeadsUpSource);
}
