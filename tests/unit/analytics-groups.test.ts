/**
 * The deal Engagement tab's Buyers list groups (buyerGroups, spec §4.2):
 * on the same facts as the cards, "Worth a call" = the KPI's call order,
 * buyers who read before a date filter's window no longer vanish (P11),
 * never-opened links stay "Not opened yet" whatever the filter.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-groups.test.ts
 */
import assert from "node:assert/strict";
import { DEFAULT_ENGAGEMENT_FILTERS, type EngagementFilters } from "../../shared/analytics-v2";
import { buildBuyersResponse } from "../../server/engagement/responses";
import { buyerGroups, cimOnly, computeKpis } from "../../server/analytics-dashboard/kpis";
import { dealKpisResponse } from "../../server/analytics-dashboard/responses";
import { NOW, dealInputsOf, factsOf, type DealSpec } from "./fixtures/analytics-fixtures";

const DEAL: DealSpec = {
  id: "g", name: "Groups Deal",
  links: [
    { id: "hot", name: "Hot Reader", firstViewedDaysAgo: 2, ndaDaysAgo: 3 },
    { id: "warm", name: "Warm Reader", firstViewedDaysAgo: 3 },
    { id: "old", name: "Read Ten Days Ago", firstViewedDaysAgo: 10 },
    { id: "no", name: "Said No", firstViewedDaysAgo: 4, decision: "not_interested", decisionDaysAgo: 1 },
    { id: "lap", name: "Lapsed One", firstViewedDaysAgo: 12, decision: "lapsed", decisionDaysAgo: 1 },
    { id: "rev", name: "Removed One", firstViewedDaysAgo: 3, revokedDaysAgo: 1 },
    { id: "never", name: "Never Opened", createdDaysAgo: 6 },
    { id: "stamp", name: "Tracker Blocked", firstViewedDaysAgo: 2 },
    { id: "tz", name: "Teaser Only", level: "teaser_only" },
  ],
  visits: [
    { id: "a1", access: "hot", daysAgo: 2, activeMs: 40 * 60_000, pages: ["exec", "fin", "cust", "deal"] },
    { id: "a2", access: "hot", daysAgo: 1, activeMs: 20 * 60_000, pages: ["fin", "deal"] },
    { id: "b1", access: "warm", daysAgo: 3, activeMs: 5 * 60_000 },
    { id: "c1", access: "old", daysAgo: 10, activeMs: 15 * 60_000 },
    { id: "d1", access: "no", daysAgo: 4, activeMs: 9 * 60_000 },
    { id: "e1", access: "lap", daysAgo: 12, activeMs: 3 * 60_000 },
    { id: "f1", access: "rev", daysAgo: 3, activeMs: 25 * 60_000 },
  ],
  reading: [
    { visit: "a1", page: "fin", ms: 900_000, block: "row:0" }, { visit: "a1", page: "deal", ms: 400_000, block: "para:0" },
    { visit: "a2", page: "fin", ms: 500_000, block: "row:1" },
    { visit: "b1", page: "exec", ms: 120_000 },
    { visit: "c1", page: "fin", ms: 600_000 },
    { visit: "d1", page: "exec", ms: 200_000 },
    { visit: "e1", page: "exec", ms: 100_000 },
    { visit: "f1", page: "fin", ms: 700_000 },
  ],
};

const ids = (rows: Array<{ accessId: string }>) => rows.map((r) => r.accessId);

// ── All time ──
{
  const all = factsOf(DEAL);
  const g = buyerGroups(all, all);
  const { callable } = computeKpis(dealInputsOf(DEAL), { range: "all", now: NOW, scope: "deal" });
  assert.deepEqual(ids(g.worthACall), callable, "Worth a call = exactly the KPI's set, in call order");
  assert.ok(g.worthACall.length >= 2, "readers who haven't said no are callable");
  assert.deepEqual(ids(g.declined).sort(), ["lap", "no"]);
  assert.deepEqual(ids(g.revoked), ["rev"]);
  assert.deepEqual(ids(g.notOpened), ["never"]);
  assert.equal(g.quietInRange.length, 0, "no date filter: nobody is 'no reading in this period'");
  assert.ok(ids(g.reading).includes("stamp") || ids(g.worthACall).includes("stamp"), "opened with the tracker blocked: still listed");
  const everyone = [...g.worthACall, ...g.reading, ...g.quietInRange, ...g.declined, ...g.revoked, ...g.notOpened];
  assert.equal(everyone.length, 8, "every CIM link once");
  assert.ok(!ids(everyone).includes("tz"), "never the teaser-only link");
  const cards = new Set(buildBuyersResponse(cimOnly(all)).buyers.map((b) => b.accessId));
  for (const r of everyone) assert.equal(r.hasCard, cards.has(r.accessId), `${r.name}: hasCard matches the cards`);
}

// ── Last 7 days ──
{
  const f: EngagementFilters = { ...DEFAULT_ENGAGEMENT_FILTERS, range: "7d" };
  const win = factsOf(DEAL, f);
  const all = factsOf(DEAL);
  const g = buyerGroups(win, all);
  assert.deepEqual(ids(g.quietInRange), ["old"], "read 10 days ago: 'No reading in this period', not 'Not opened yet'");
  assert.ok(ids(g.reading).includes("stamp"), "opened 2 days ago (tracker blocked): opened in the period, so still listed as reading");
  assert.ok(g.quietInRange[0].lastSeenAt, "with when they last read");
  assert.deepEqual(ids(g.notOpened), ["never"], "a never-opened link under every filter");
  assert.deepEqual(ids(g.declined).sort(), ["lap", "no"]);
  assert.deepEqual(ids(g.revoked), ["rev"]);
  const cards = new Set(buildBuyersResponse(cimOnly(win)).buyers.map((b) => b.accessId));
  for (const r of [...g.worthACall, ...g.reading, ...g.quietInRange, ...g.declined, ...g.revoked, ...g.notOpened]) {
    assert.equal(r.hasCard, cards.has(r.accessId), `${r.name}: hasCard matches the 7-day cards`);
  }
  // The deal response carries these groups (group facts = the When filter).
  const resp = dealKpisResponse(dealInputsOf(DEAL, f), [], NOW);
  assert.deepEqual(ids(resp.groups.quietInRange), ["old"]);
  assert.equal(resp.forText, "Last 7 days · All buyers");
}

console.log("analytics-groups: all assertions passed");
