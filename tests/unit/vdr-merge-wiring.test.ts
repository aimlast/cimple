/**
 * The data room wired into the other streams at the vdr merge (release/oct
 * merge step 6; INTEGRATION §2.4, §2.8, §2.9, §2.14, §2.17, C13):
 *   - Analytics: data-room lines in the Activity feed (named, kind/group
 *     `data_room`, demo views as `sample`, the window applies) and ONE
 *     heads-up line over every deal ("… is in the … data room now", else
 *     "… opened the … data room this week"; never preview or demo views),
 *     registered vdr-first for heads-up and teaser-first for activity.
 *   - The Engagement tab offers the "Data room" view (DataRoomActivity) when
 *     the deal has a room.
 *   - The CIM tab's slots carry vdr's tile lines (≤ 2 a tile, "No data room"
 *     in the tooltip) and the publish note.
 *   - The view room pauses the CIM reading tracker while a data-room
 *     document is open beside it and records `vdr_open` (doc:<itemId>).
 *   - "Read all" skips pictures and stored-only data-room files; "Read
 *     again" on one clears the stored-only choice first.
 *   - Q&A scope: one rule for teaser (no Q&A) and vdr (`room` = asker only).
 * No database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-merge-wiring.test.ts
 */
import "./react-global";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuyerAccess, VdrActivity, VdrView } from "../../shared/schema";
import { ACTIVITY_GROUP_OF, HEADS_UP_MAX, TEASER_HEADS_UP_ID, VDR_NOW_HEADS_UP_ID, VDR_WEEK_HEADS_UP_ID, type HeadsUp } from "../../shared/analytics-dashboard";
import { BLIND_ACCESS_LEVEL, DD_ACCESS_LEVEL, NAMED_ACCESS_LEVEL, TEASER_ACCESS_LEVEL } from "../../shared/access-levels";
import { scopeAllows, rowScope } from "../../shared/buyer-qa-scope";
import {
  _setVdrDealActivityLoaderForTests,
  registerAnalyticsExtraSources,
  vdrActivityItemsFor,
  vdrActivitySource,
  vdrFeedWords,
  vdrHeadsUpFor,
  vdrHeadsUpSource,
  type VdrDealActivity,
} from "../../server/routes/analytics-extra-sources";
import { _resetExtraSources, extraActivity, extraHeadsUp } from "../../server/analytics-dashboard/extra-sources";
import { activityItems } from "../../server/analytics-dashboard/activity";
import { headsUp } from "../../server/analytics-dashboard/kpis";
import { clearStoredOnly, storedOnlySource } from "../../server/documents/reprocess";
import { headsUpShort, headsUpTiny } from "../../client/src/components/analytics/HeadsUp";
import { NOW, ago, dealOf, inputsOf, type DealSpec } from "./fixtures/analytics-fixtures";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const MIN = 60_000;
const minsAgo = (m: number) => new Date(NOW.getTime() - m * MIN);

// ── fixtures ────────────────────────────────────────────────────────────
const link = (id: string, dealId: string, name: string, email: string, level: string, createdDaysAgo = 10, extra: Partial<BuyerAccess> = {}) =>
  ({ id, dealId, buyerName: name, buyerEmail: email, buyerCompany: name.split(" ")[0] + " Capital", accessLevel: level, createdAt: ago(createdDaysAgo), revokedAt: null, ...extra }) as unknown as BuyerAccess;
let seq = 0;
const view = (dealId: string, email: string, itemId: string, startedAt: Date, activeMs: number, extra: Partial<VdrView> = {}) =>
  ({ id: `v${++seq}`, dealId, buyerAccessId: "x", buyerEmail: email, teamMemberId: null, itemId, documentId: null, fileVersion: 1, trace: "ABC123",
    source: "room", startedAt, lastSeenAt: new Date(startedAt.getTime() + activeMs), activeMs, pageMs: {}, maxPage: 1, deviceClass: "desktop", downloaded: false, ...extra }) as VdrView;
const act = (dealId: string, email: string, action: string, at: Date, detail: Record<string, unknown> = {}, itemId: string | null = null) =>
  ({ id: `a${++seq}`, dealId, at, actorKind: "buyer", actorId: null, action, itemId, folderId: null, buyerEmail: email, detail, ipHash: null }) as VdrActivity;

const P: DealSpec = { id: "dP", name: "Pacific Coast Logistics", links: [] };
const B: DealSpec = { id: "dB", name: "Beacon Pharmacy", links: [] };
const items = [{ id: "i1", title: "T2 2023" }, { id: "i2", title: "FY2023 statements" }];
const pacific: VdrDealActivity = {
  accesses: [
    // Tom had a teaser link first, then a due-diligence link: the line names the DD link.
    link("tTeaser", "dP", "Tom Reyes", "tom@north.invalid", TEASER_ACCESS_LEVEL, 20),
    link("tDD", "dP", "Tom Reyes", "Tom@North.invalid", DD_ACCESS_LEVEL, 5),
    link("pFull", "dP", "Priya Shah", "priya@east.invalid", NAMED_ACCESS_LEVEL, 8),
  ],
  views: [
    view("dP", "tom@north.invalid", "i1", ago(2), 4 * MIN),
    view("dP", "tom@north.invalid", "i2", new Date(ago(2).getTime() + 10 * MIN), 2 * MIN),
    view("dP", "priya@east.invalid", "i1", minsAgo(3), 2 * MIN),                 // last seen 1 min ago: in the room now
    view("dP", "priya@east.invalid", "i2", ago(40), 5 * MIN, { source: "demo" }), // demo seed: a sample line, never "now"
    view("dP", "tom@north.invalid", "i1", minsAgo(1), 30_000, { source: "preview" }), // the broker's "View as": never counted
  ],
  activity: [
    act("dP", "tom@north.invalid", "buyer_room_changed", ago(4), { roomAccess: "auto" }),
    act("dP", "tom@north.invalid", "buyer_downloaded", ago(1), {}, "i1"),
    act("dP", "priya@east.invalid", "buyer_requested", ago(1), { count: 3 }),
  ],
  items,
};
const beacon: VdrDealActivity = {
  accesses: [link("uDD", "dB", "Uma Patel", "uma@west.invalid", DD_ACCESS_LEVEL, 6)],
  views: [view("dB", "uma@west.invalid", "i9", ago(3), 6 * MIN)],
  activity: [],
  items: [{ id: "i9", title: "Lease" }],
};
const deals = [dealOf(P), dealOf(B)];

// ── Activity ──────────────────────────────────────────────────────────────
await test("vdr's wording becomes a named feed line (detail after the dot)", () => {
  assert.deepEqual(vdrFeedWords("Tom Reyes", "Opened 2 documents in the data room · 6 min"), { title: "Tom Reyes opened 2 documents in the data room", detail: "6 min" });
  assert.deepEqual(vdrFeedWords("Tom Reyes", "Given the data room"), { title: "Tom Reyes was given the data room", detail: null });
  assert.deepEqual(vdrFeedWords("Tom Reyes", "Data room turned off for them"), { title: "Data room turned off for Tom Reyes", detail: null });
  assert.equal(vdrFeedWords("Priya Shah", "Asked for 3 documents").title, "Priya Shah asked for 3 documents");
  assert.equal(vdrFeedWords("Tom Reyes", "Downloaded 'T2 2023' from the data room").title, "Tom Reyes downloaded 'T2 2023' from the data room");
});

await test("activity: data-room lines per buyer, named on their CIM link, kind/group data_room, linked to their log", () => {
  const rows = vdrActivityItemsFor(dealOf(P), pacific, { since: null, now: NOW });
  for (const r of rows) {
    assert.equal(r.kind, "data_room");
    assert.equal(r.group, ACTIVITY_GROUP_OF.data_room);
    assert.equal(r.dealName, "Pacific Coast Logistics");
  }
  const tom = rows.filter((r) => r.name === "Tom Reyes");
  assert.ok(tom.every((r) => r.accessId === "tDD"), "Tom's line names his due-diligence link, not the old teaser link");
  const opened = tom.find((r) => r.title === "Tom Reyes opened 2 documents in the data room");
  assert.ok(opened, JSON.stringify(tom.map((r) => r.title)));
  assert.equal(opened!.detail, "6 min", "4 min + 2 min, in the feed's words");
  assert.equal(opened!.link!.href, "/deal/dP/data-room?view=activity&activity=log&buyer=tDD");
  assert.ok(tom.some((r) => r.title === "Tom Reyes was given the data room" && r.tone === "positive"));
  assert.ok(tom.some((r) => r.title === "Tom Reyes downloaded 'T2 2023' from the data room"));
  assert.ok(rows.some((r) => r.title === "Priya Shah asked for 3 documents"));
  // Preview views never count: Tom has no line for today.
  assert.ok(!tom.some((r) => r.at.slice(0, 10) === NOW.toISOString().slice(0, 10) && r.title.includes("opened")));
  // The demo seed's view is a sample line; real lines are not.
  const sample = rows.filter((r) => r.sample);
  assert.equal(sample.length, 1);
  assert.equal(sample[0].title, "Priya Shah opened 1 document in the data room");
  assert.ok(sample[0].id.endsWith(":sample"));
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "ids are unique");
});

await test("activity: the window applies; deals without a room give nothing; the feed shows the Data room chip", async () => {
  const recent = vdrActivityItemsFor(dealOf(P), pacific, { since: ago(1.5), now: NOW });
  assert.ok(recent.every((r) => Date.parse(r.at) >= ago(1.5).getTime()));
  assert.ok(!recent.some((r) => r.title.includes("was given")), "given 4 days ago: outside");
  _setVdrDealActivityLoaderForTests(async (ids) => new Map(ids.filter((id) => id === "dP").map((id) => [id, pacific] as const)));
  const fromSource = await vdrActivitySource(deals, { since: null, now: NOW });
  assert.ok(fromSource.length > 0 && fromSource.every((r) => r.dealId === "dP"));
  const feed = activityItems(inputsOf([P, B]), [], { range: "all", now: NOW, extra: fromSource, kinds: "data_room" });
  assert.ok(feed.length > 0 && feed.every((i) => i.group === "data_room"), "the Data room chip filters to these lines");
  _setVdrDealActivityLoaderForTests(null);
});

// ── Heads-up ──────────────────────────────────────────────────────────────
await test("heads-up: someone in the data room now → one line naming them and the deal", () => {
  const lines = vdrHeadsUpFor(deals, new Map([["dP", pacific], ["dB", beacon]]), NOW);
  assert.equal(lines.length, 1);
  const [h] = lines;
  assert.equal(h.id, VDR_NOW_HEADS_UP_ID);
  assert.equal(h.count, 1, "Priya (Tom's preview view and the demo view never count)");
  assert.equal(h.text, "Priya Shah is in the Pacific Coast Logistics data room now.");
  assert.equal(h.link, "/deal/dP/data-room?view=activity");
  assert.ok(!h.ids, "a registered line: it links where it says");
  assert.equal(headsUpShort(h), "Priya Shah is in the data room now");
  assert.equal(headsUpTiny(h), "1 in the data room");
});

await test("heads-up: nobody there now → who opened a data room this week (one line over every deal)", () => {
  const quiet = { ...pacific, views: pacific.views.filter((v) => v.buyerEmail !== "priya@east.invalid") };
  const lines = vdrHeadsUpFor(deals, new Map([["dP", quiet], ["dB", beacon]]), NOW);
  assert.equal(lines.length, 1);
  const [h] = lines;
  assert.equal(h.id, VDR_WEEK_HEADS_UP_ID);
  assert.equal(h.count, 2, "Tom (Pacific, 2 days ago) and Uma (Beacon, 3 days ago)");
  assert.equal(h.text, "2 buyers opened a data room this week: Pacific Coast Logistics (1), Beacon Pharmacy (1).");
  assert.equal(h.link, "/broker/analytics?tab=activity&kind=data_room");
  assert.equal(headsUpShort(h), "2 opened the data room this week");
  const one = vdrHeadsUpFor([dealOf(B)], new Map([["dB", beacon]]), NOW);
  assert.equal(one[0].text, "1 buyer opened the Beacon Pharmacy data room this week.");
  assert.equal(one[0].link, "/deal/dB/data-room?view=activity");
  assert.deepEqual(vdrHeadsUpFor(deals, new Map(), NOW), [], "no room, no line");
  const old = { ...beacon, views: [view("dB", "uma@west.invalid", "i9", ago(9), MIN)] };
  assert.deepEqual(vdrHeadsUpFor([dealOf(B)], new Map([["dB", old]]), NOW), [], "nothing in the last 7 days");
});

await test("heads-up order (analytics §3.2): the data-room line first, then the teaser's; at most two", () => {
  const vdr = vdrHeadsUpFor(deals, new Map([["dP", pacific]]), NOW);
  const teaser: HeadsUp = { id: TEASER_HEADS_UP_ID, count: 1, text: "1 buyer read the teaser but didn't ask for the CIM: Beacon Pharmacy.", names: ["Ann"], link: "/deal/dB/buyers?stage=teaser" };
  const shown = headsUp(inputsOf([P, B]), NOW, [...vdr, teaser]);
  assert.equal(shown.length, HEADS_UP_MAX);
  assert.deepEqual(shown.map((h) => h.id), [VDR_NOW_HEADS_UP_ID, TEASER_HEADS_UP_ID]);
});

await test("registration: activity teaser · vdr, heads-up vdr · teaser — each once", async () => {
  _setVdrDealActivityLoaderForTests(async (ids) => new Map(ids.filter((id) => id === "dP").map((id) => [id, pacific] as const)));
  _resetExtraSources();
  registerAnalyticsExtraSources();
  registerAnalyticsExtraSources();
  const all = await extraActivity([dealOf(P)], { since: null, now: NOW });
  const once = vdrActivityItemsFor(dealOf(P), pacific, { since: null, now: NOW });
  assert.equal(all.filter((i) => i.kind === "data_room").length, once.length, "the data-room source is registered once");
  const lines = await extraHeadsUp([dealOf(P)], NOW);
  assert.equal(lines[0]?.id, VDR_NOW_HEADS_UP_ID, "the data-room line comes first");
  assert.deepEqual(await vdrHeadsUpSource([dealOf(P)], NOW), [lines[0]]);
  _setVdrDealActivityLoaderForTests(null);
  _resetExtraSources();
});

// ── Client registrations ─────────────────────────────────────────────────
await test("Engagement tab: the Data room view is registered after the Teaser view, with no CIM filters", async () => {
  const { EXTRA_ENGAGEMENT_VIEWS } = await import("../../client/src/components/engagement/extra-views");
  const { useDealHasDataRoom } = await import("../../client/src/components/vdr/DataRoomActivity");
  assert.deepEqual(EXTRA_ENGAGEMENT_VIEWS.map((v) => v.key), ["teaser", "data-room"]);
  const room = EXTRA_ENGAGEMENT_VIEWS[1];
  assert.equal(room.label, "Data room");
  assert.equal(room.useAvailable, useDealHasDataRoom);
  assert.deepEqual(room.filters, []);
  const { resolveEngagementView } = await import("../../client/src/components/analytics/url");
  assert.equal(resolveEngagementView("data-room", ["teaser", "data-room"]), "data-room");
});

await test("CIM tab slots: vdr's tile lines (≤ 2 a tile, dd first at its merge) and tooltips, and the publish note", async () => {
  const slots = await import("../../client/src/pages/broker/deal/cim-tab-slots");
  const { vdrTileLines, vdrTileTooltips } = await import("../../client/src/components/vdr/cim-slots");
  assert.deepEqual(slots.ACCESS_TILE_LINES.map((s) => s.key), ["vdr"]);
  assert.deepEqual(slots.CIM_PUBLISH_NOTES.map((s) => s.key), ["vdr"]);
  const kpis = { sharedByLevel: { [DD_ACCESS_LEVEL]: 6 }, roomBuyersByLevel: { [NAMED_ACCESS_LEVEL]: 2 }, ddCitedNotShared: 0 };
  const lines = vdrTileLines("dP", { room: {} as never, kpis: kpis as never });
  assert.deepEqual(slots.tileLinesFor(DD_ACCESS_LEVEL, [lines]).map((l) => l.text), ["+ data room · 6 documents shared"]);
  assert.deepEqual(slots.tileLinesFor(NAMED_ACCESS_LEVEL, [lines]).map((l) => l.text), ["+ data room for 2 buyers you chose"]);
  assert.deepEqual(slots.tileLinesFor(BLIND_ACCESS_LEVEL, [lines]), [], "Blind CIM: no line — the tooltip says it (C13)");
  assert.deepEqual(slots.tileLinesFor(TEASER_ACCESS_LEVEL, [lines]), []);
  const tips = vdrTileTooltips();
  assert.equal(tips[TEASER_ACCESS_LEVEL], "No data room");
  assert.match(tips[BLIND_ACCESS_LEVEL], /^No data room/);
  const dd = { ...kpis, ddCitedNotShared: 3 };
  const amber = vdrTileLines("dP", { room: {} as never, kpis: dd as never })[DD_ACCESS_LEVEL];
  assert.equal(amber[0].tone, "amber");
  assert.equal(amber[0].text, "3 documents the DD CIM points to aren't shared · Share them");
  assert.deepEqual(vdrTileLines("dP", { room: null, kpis: kpis as never })[DD_ACCESS_LEVEL], [], "nothing before the room is set up");
});

// ── View room: paused while a document is open, vdr_open recorded ─────────
await test("view room: the CIM tracker is paused while the data-room drawer is open, and each document opened records vdr_open", () => {
  const room = src("client/src/pages/BuyerViewRoom.tsx");
  assert.match(room, /useCimReading\(\{[\s\S]*?paused: roomDrawerOpen,[\s\S]*?\}\)/);
  assert.match(room, /onDrawerChange=\{\(open, itemId\) => \{[\s\S]*?if \(open && itemId\) tracker\.record\("vdr_open", null, undefined, `doc:\$\{itemId\}`\);[\s\S]*?setRoomDrawerOpen\(open\);/);
  // §2.4 branch order: the team link, then the expired teaser, then the teaser, then not-published (+ the room).
  const order = ["code === \"team_link\"", "error.teaser && error.code === \"expired\"", "data?.document === \"teaser\"", "ViewRoomError && error.code === \"not_published\")", "view-room-open-data-room"];
  const at = order.map((s) => room.indexOf(s));
  assert.ok(at.every((i) => i > 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, "branch order");
});

// ── Reprocess: pictures and stored-only files ────────────────────────────
await test("read all skips pictures and stored-only data-room files; Read again clears the choice first", () => {
  assert.equal(storedOnlySource({ sourceMeta: { readSkipped: true } }), true);
  assert.equal(storedOnlySource({ sourceMeta: { kind: "document" } }), false);
  assert.equal(storedOnlySource({ sourceMeta: null }), false);
  assert.deepEqual(clearStoredOnly({ readSkipped: true, uploadedVia: "data_room" } as never), { uploadedVia: "data_room" });
  assert.equal(clearStoredOnly({ uploadedVia: "x" } as never), null, "nothing to clear");
  const reprocess = src("server/documents/reprocess.ts");
  assert.match(reprocess, /if \(isTogetherSitting\(doc\)\) return \{ data: stored, freshText: null \};\s*\n(?:\s*\/\/.*\n)+\s*if \(isImageMime\(doc\.mimeType\) \|\| storedOnlySource\(doc\)\) return \{ data: stored, freshText: null \};/);
  const routes = src("server/routes.ts");
  const one = routes.slice(routes.indexOf('app.post("/api/deals/:dealId/documents/:documentId/reprocess"'));
  assert.ok(one.indexOf("clearStoredOnly") > 0 && one.indexOf("clearStoredOnly") < one.indexOf("startReprocessJob(deal.id"), "cleared before the job starts");
});

// ── Q&A scope: teaser's rule and vdr's room scope together ────────────────
await test("Q&A scope: a Teaser link reads nothing; a room answer is the asker's alone; historical 'full' reads like 'all'", () => {
  const row = { buyerAccessId: "asker" };
  assert.equal(scopeAllows("all", row, { id: "t", accessLevel: TEASER_ACCESS_LEVEL }), false);
  assert.equal(scopeAllows("room", row, { id: "asker", accessLevel: DD_ACCESS_LEVEL }), true);
  assert.equal(scopeAllows("room", row, { id: "other", accessLevel: DD_ACCESS_LEVEL }), false);
  assert.equal(scopeAllows("full", row, { id: "other", accessLevel: BLIND_ACCESS_LEVEL }), true);
  assert.equal(scopeAllows("full", row, { id: "other", accessLevel: "teaser" }), true, "a legacy teaser key is a Blind CIM link");
  assert.equal(rowScope({ buyerAccessId: "a", question: "q", vdrItemId: "i1", answerScope: "all" }, NAMED_ACCESS_LEVEL), "private", "a data-room question is never for everyone");
});

console.log(`\nvdr-merge-wiring: ${passed} passed`);
