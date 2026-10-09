/**
 * The teaser's lines on the analytics dashboards, as registered at the
 * analytics merge (server/routes/analytics-extra-sources.ts; INTEGRATION
 * §2.9, C7):
 *   - Activity: "read the teaser" (Reading) and "said the teaser isn't for
 *     them" (Decisions) arrive through the registered source; a CIM request
 *     from the teaser is listed exactly ONCE (the feed's own access event,
 *     never the teaser source's copy).
 *   - Heads-up: ONE line over every deal, naming the deals, so it never
 *     takes both slots and the built-in "links run out" line still shows.
 *   - Teaser readers never enter Who to call (C7).
 * No database (teaser's engagement source is stubbed), no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-extra-sources.test.ts
 */
import assert from "node:assert/strict";
import type { BuyerAccess, BuyerApprovalRequest } from "../../shared/schema";
import { ACTIVITY_GROUP_OF, HEADS_UP_MAX, TEASER_HEADS_UP_ID } from "../../shared/analytics-dashboard";
import { _setTeaserEngagementSourceForTests, type TeaserEngagementSource } from "../../server/teaser/engagement";
import { _resetExtraSources, extraActivity, extraHeadsUp } from "../../server/analytics-dashboard/extra-sources";
import {
  _setVdrDealActivityLoaderForTests,
  combineTeaserHeadsUp,
  registerAnalyticsExtraSources,
  teaserActivitySource,
  teaserHeadsUpSource,
} from "../../server/routes/analytics-extra-sources";
import { activityItems } from "../../server/analytics-dashboard/activity";
import { headsUp } from "../../server/analytics-dashboard/kpis";
import { callListResponse } from "../../server/analytics-dashboard/responses";
import { DAY, NOW, ago, dealOf, inputsOf, type DealSpec } from "./fixtures/analytics-fixtures";

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

// Deal P: a CIM buyer (c1) whose link runs out in 3 days, and three teaser links —
// t1 read it 3 days ago and didn't ask (worth a call), t2 read it and asked for the CIM,
// t3 read it and said it isn't for them. Deal B: one teaser reader who didn't ask.
const asked = { type: "cim_requested", at: ago(1).toISOString() };
const passedEvent = { type: "teaser_passed", at: ago(2).toISOString(), reasons: ["too_small"], note: null };
const P: DealSpec = {
  id: "dP", name: "Pacific Coast Logistics",
  links: [
    { id: "c1", name: "Cara CIM", level: "named", firstViewedDaysAgo: 4, expiresInDays: 3 },
    { id: "t1", name: "Tom Teaser", level: "teaser_only" },
    { id: "t2", name: "Tia Asker", level: "teaser_only", events: [asked as never] },
    { id: "t3", name: "Ted Passer", level: "teaser_only", events: [passedEvent as never] },
  ],
  visits: [{ id: "vc1", access: "c1", daysAgo: 4, activeMs: 120_000, pages: ["cover", "overview"] }],
};
const B: DealSpec = { id: "dB", name: "Beacon Pharmacy", links: [{ id: "u1", name: "Uma Reader", level: "teaser_only" }] };

const links: Record<string, BuyerAccess[]> = {};
for (const spec of [P, B]) {
  links[spec.id] = spec.links.map((l) => ({
    id: l.id, dealId: spec.id, buyerName: l.name, buyerEmail: `${l.id}@buyer.invalid`, buyerCompany: null,
    accessLevel: l.level ?? "named", accessEvents: [
      { type: "granted", at: ago(10).toISOString(), accessLevel: l.level ?? "named" },
      ...((l.events ?? []) as unknown[]),
    ],
    createdAt: ago(10), expiresAt: l.expiresInDays == null ? null : new Date(NOW.getTime() + l.expiresInDays * DAY),
    revokedAt: null, ndaProfile: null,
  } as unknown as BuyerAccess));
}
const requests: Record<string, BuyerApprovalRequest[]> = {
  dP: [{ id: "r2", buyerAccessId: "t2", source: "teaser_request", status: "pending_broker_review", createdAt: ago(1), updatedAt: ago(1) } as unknown as BuyerApprovalRequest],
  dB: [],
};
const teaserVisit = (accessId: string, daysAgo: number) => ({
  accessId, renditionId: "teaserR", startedAt: ago(daysAgo), lastSeenAt: new Date(ago(daysAgo).getTime() + 90_000), activeMs: 80_000, maxPageIndex: 1,
});
const stub: TeaserEngagementSource = {
  links: async (d) => links[d] ?? [],
  requests: async (d) => requests[d] ?? [],
  visits: async (d) => (d === "dP" ? [teaserVisit("t1", 3), teaserVisit("t2", 3), teaserVisit("t3", 3)] : [teaserVisit("u1", 5)]),
  blockSums: async () => [],
  pageIndexes: async () => new Map([["teaserR", [
    { pageId: "teaser_header", order: 0, servedTitle: "Header", layoutType: "cover_page", blocks: [] },
    { pageId: "b1", order: 1, servedTitle: "The opportunity", layoutType: "prose_highlight", blocks: [] },
  ] as never]]),
};
_setTeaserEngagementSourceForTests(stub);
const deals = [dealOf(P), dealOf(B)];

await test("activity: teaser reads and passes arrive with the dashboards' groups; the teaser's CIM-request copy is dropped", async () => {
  const items = await teaserActivitySource(deals, { since: null, now: NOW });
  const kinds = items.map((i) => `${i.accessId}:${i.kind}`).sort();
  assert.deepEqual(kinds, ["t1:teaser_opened", "t2:teaser_opened", "t3:teaser_opened", "t3:teaser_passed", "u1:teaser_opened"]);
  for (const i of items) assert.equal(i.group, ACTIVITY_GROUP_OF[i.kind], `${i.id} group`);
  assert.equal(items.find((i) => i.kind === "teaser_passed")!.group, "decision");
  assert.equal(items.find((i) => i.kind === "teaser_passed")!.tone, "negative");
});

await test("activity: a CIM request from the teaser is listed exactly once in the merged feed", async () => {
  const inputs = inputsOf([P, B]);
  const extra = await teaserActivitySource(deals, { since: null, now: NOW });
  const feed = activityItems(inputs, [], { range: "all", now: NOW, extra });
  const asks = feed.filter((i) => i.kind === "cim_requested" && i.accessId === "t2");
  assert.equal(asks.length, 1, "one 'asked for the CIM' item");
  assert.equal(asks[0].title, "Tia Asker asked for the CIM");
  assert.ok(feed.some((i) => i.kind === "teaser_opened" && i.accessId === "t1"), "teaser read listed");
  // The Reading chip keeps teaser reads; the Decisions chip keeps the pass.
  const reading = activityItems(inputs, [], { range: "all", now: NOW, extra, kinds: "reading" });
  assert.ok(reading.some((i) => i.kind === "teaser_opened"));
  const decisions = activityItems(inputs, [], { range: "all", now: NOW, extra, kinds: "decision" });
  assert.ok(decisions.some((i) => i.kind === "teaser_passed" && i.accessId === "t3"));
});

await test("activity: a date window applies to the teaser source", async () => {
  const items = await teaserActivitySource(deals, { since: ago(4), now: NOW });
  assert.ok(!items.some((i) => i.accessId === "u1"), "Uma read 5 days ago: outside a 4-day window");
  assert.ok(items.some((i) => i.accessId === "t1"));
});

await test("heads-up: one line over every deal, naming the deals; the built-in line keeps its slot", async () => {
  const lines = await teaserHeadsUpSource(deals, NOW);
  assert.equal(lines.length, 1, "one line, not one per deal");
  const [line] = lines;
  assert.equal(line.id, TEASER_HEADS_UP_ID);
  assert.equal(line.count, 2, "Tom (Pacific) and Uma (Beacon); Tia asked, Ted passed");
  assert.equal(line.text, "2 buyers read the teaser but didn't ask for the CIM: Pacific Coast Logistics (1), Beacon Pharmacy (1).");
  assert.equal(line.link, "/broker/analytics?tab=buyers&status=teaser_links");
  assert.ok(!line.ids, "not a built-in notice: it links where it says");
  const shown = headsUp(inputsOf([P, B]), NOW, lines);
  assert.equal(shown.length, HEADS_UP_MAX);
  assert.deepEqual(shown.map((h) => h.id), [TEASER_HEADS_UP_ID, "expiring"], "teaser line first, then Cara's link running out");
});

await test("heads-up: one deal → its name and its Have the teaser stage", () => {
  const one = combineTeaserHeadsUp([{ id: "teaser-worth-dP", count: 1, names: ["Tom Teaser"], link: "/deal/dP/buyers?stage=teaser" }], deals);
  assert.equal(one[0].text, "1 buyer read the teaser but didn't ask for the CIM: Pacific Coast Logistics.");
  assert.equal(one[0].link, "/deal/dP/buyers?stage=teaser");
  assert.deepEqual(combineTeaserHeadsUp([], deals), []);
});

await test("Who to call stays CIM-only (C7): teaser readers are never on it", () => {
  const call = callListResponse(inputsOf([P, B]), 15, NOW);
  const ids = JSON.stringify(call);
  for (const t of ["t1", "t2", "t3", "u1"]) assert.ok(!ids.includes(`"${t}"`), `${t} not in the call list`);
});

await test("registration: once, in order; the registered sources feed the dashboards", async () => {
  // The data room's source (registered at the vdr merge) reads no database here: no deal has a room.
  _setVdrDealActivityLoaderForTests(async () => new Map());
  _resetExtraSources();
  registerAnalyticsExtraSources();
  registerAnalyticsExtraSources();
  const items = await extraActivity(deals, { since: null, now: NOW });
  assert.equal(items.filter((i) => i.kind === "teaser_opened").length, 4, "registered once (no duplicates)");
  assert.equal(items.filter((i) => i.kind === "data_room").length, 0, "no data room on these deals");
  const lines = await extraHeadsUp(deals, NOW);
  assert.deepEqual(lines.map((h) => h.id), [TEASER_HEADS_UP_ID]);
  _setVdrDealActivityLoaderForTests(null);
});

await test("the deal Engagement tab offers the Teaser view (registered extra view)", async () => {
  await import("./react-global");
  const { EXTRA_ENGAGEMENT_VIEWS } = await import("../../client/src/components/engagement/extra-views");
  const { useDealHasTeaser } = await import("../../client/src/components/teaser/useTeaserSummary");
  assert.deepEqual(EXTRA_ENGAGEMENT_VIEWS.map((v) => v.key), ["teaser", "data-room"], "teaser (step 4), then the data room (step 6)");
  const teaser = EXTRA_ENGAGEMENT_VIEWS[0];
  assert.equal(teaser.label, "Teaser");
  assert.equal(teaser.useAvailable, useDealHasTeaser);
  assert.deepEqual(teaser.filters, [], "the CIM filters never apply to the teaser view");
  const { resolveEngagementView } = await import("../../client/src/components/analytics/url");
  assert.equal(resolveEngagementView("teaser", ["teaser"]), "teaser", "?view=teaser opens it (reading-now and Buyers-tab links)");
});

_setTeaserEngagementSourceForTests(null);
console.log(`\nanalytics-extra-sources: ${passed} passed`);
