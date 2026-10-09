/**
 * The Analytics page's Deals tab (server/analytics-dashboard/deals.ts, spec §6.2).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-deals.test.ts
 */
import assert from "node:assert/strict";
import { readingSummary } from "../../server/engagement/insights";
import { contentPageCount, dealRows, dealsWithoutBuyers, median, teaserCounts } from "../../server/analytics-dashboard/deals";
import { NOW, ago, accessOf, factsOf, inputsOf, type DealSpec } from "./fixtures/analytics-fixtures";

assert.equal(median([]), null);
assert.equal(median([5, 1, 3]), 3, "odd count");
assert.equal(median([4, 1, 3, 2]), 3, "even count: the mean of the middle two (2.5 → 3)");
assert.equal(median([10, 20]), 15);

const LIVE: DealSpec = {
  id: "live", name: "Pacific Coast Logistics", live: true, demo: true,
  links: [
    { id: "a", name: "Ann", firstViewedDaysAgo: 5, ndaDaysAgo: 6, decision: "interested", decisionDaysAgo: 2 },
    { id: "b", name: "Ben", firstViewedDaysAgo: 4, ndaDaysAgo: 5 },
    { id: "c", name: "Cy", firstViewedDaysAgo: 3 },
    { id: "n", name: "Never", createdDaysAgo: 9 },
    // A teaser link that asked for the CIM, and one first sent as a teaser then moved up.
    { id: "t1", name: "Teaser Asker", level: "teaser_only", events: [{ type: "cim_requested", at: ago(1).toISOString() }] },
    { id: "t2", name: "Moved Up", level: "loi", events: [{ type: "granted", at: ago(8).toISOString(), accessLevel: "teaser_only" }] },
  ],
  visits: [
    { id: "va", access: "a", daysAgo: 5, activeMs: 40 * 60_000, pages: ["cover", "exec", "fin", "cust", "deal"] },
    { id: "vb", access: "b", daysAgo: 4, activeMs: 10 * 60_000, pages: ["cover", "exec"] },
    { id: "vc", access: "c", daysAgo: 3, activeMs: 20 * 60_000, pages: ["cover", "exec", "fin"] },
  ],
  reading: [
    { visit: "va", page: "fin", ms: 600_000, block: "row:0" },
    { visit: "vb", page: "exec", ms: 300_000, block: "para:0" },
    { visit: "vc", page: "fin", ms: 200_000, block: "row:1" },
  ],
};
const DRAFT: DealSpec = { id: "draft", name: "Beacon Specialty Pharmacy", live: false, links: [{ id: "z", name: "Zed" }] };
const EMPTY: DealSpec = { id: "empty", name: "Lakeshore Home Comfort", live: false, links: [] };
const OLD: DealSpec = {
  id: "old", name: "Old Tracker Deal", live: true,
  links: [{ id: "o", name: "Olga", firstViewedDaysAgo: 20 }],
  visits: [{ id: "vo", access: "o", daysAgo: 20, activeMs: 600_000, legacy: true, pages: ["exec", "fin"] }],
  reading: [{ visit: "vo", page: "exec", ms: 300_000 }, { visit: "vo", page: "fin", ms: 300_000 }],
};

const inputs = inputsOf([LIVE, DRAFT, EMPTY, OLD]);
const rows = dealRows(inputs, "7d", NOW);
const row = (id: string) => rows.find((r) => r.dealId === id)!;

assert.deepEqual(rows.map((r) => r.dealId).sort(), ["draft", "live", "old"], "every deal with a buyer link; not the one without");
assert.deepEqual(dealsWithoutBuyers(inputs).map((d) => d.dealId), ["empty"]);

const L = row("live");
assert.equal(L.live, true);
assert.equal(L.demo, true);
assert.equal(L.granted, 5, "CIM links only (the teaser-only link is not one)");
assert.equal(L.opened, 3);
assert.equal(L.readingInRange, 3, "read in the last 7 days");
assert.equal(L.medianReadingMs, 20 * 60_000, "median of 40, 10 and 20 min");
const facts = factsOf(LIVE);
assert.equal(L.contentPages, 4, "front matter (the cover) isn't a content page");
assert.equal(contentPageCount(facts), 4);
const reached = facts.buyers.filter((b) => b.visits.length > 0).map((b) => readingSummary(b, facts.pages).pagesReached).sort((x, y) => x - y);
assert.equal(L.medianPagesReached, reached[1], "how far: readingSummary's pages reached (content pages only)");
assert.ok(L.medianPagesReached! <= 4);
assert.equal(L.ndaSigned, 2);
assert.equal(L.interested, 1);
assert.deepEqual(L.teaser, { sent: 2, asked: 1 }, "sent = teaser-only now or first given as a teaser; asked = asked for the CIM");
assert.equal(L.lastActivityAt, ago(1).toISOString(), "the CIM request (1 day ago) is the latest thing that happened");
assert.equal(L.partByPart, true);

assert.equal(row("draft").live, false);
assert.equal(row("draft").granted, 1);
assert.equal(row("draft").teaser, null, "no teaser links: no Teaser figure");
assert.equal(row("old").partByPart, false, "old-tracker (page-level) reading only");
assert.equal(row("old").readingInRange, 0);

assert.equal(teaserCounts([accessOf("x", { id: "p", name: "P" })]), null);

// No pages to draw on (old reading on a CIM that can't be rebuilt): "—", never "0 of 0".
{
  const i = inputsOf([LIVE]);
  i.items[0].facts = { ...i.items[0].facts, pages: [] };
  const r = dealRows(i, "all", NOW)[0];
  assert.equal(r.contentPages, 0);
  assert.equal(r.medianPagesReached, null);
  const { buyerRows } = await import("../../server/analytics-dashboard/buyers");
  const b = buyerRows(i, NOW).find((x) => x.accessId === "a")!;
  assert.equal(b.pagesRead, null);
  assert.equal(b.contentPages, null);
}

// A deal whose facts failed is left out (and reported as partial by the route).
const failed = dealRows(inputsOf([LIVE, OLD], { failed: [{ dealId: "old", dealName: "Old Tracker Deal" }], noFacts: ["old"] }), "all", NOW);
assert.deepEqual(failed.map((r) => r.dealId), ["live"]);

console.log("analytics-deals: all assertions passed");
