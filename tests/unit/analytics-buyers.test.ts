/**
 * The Analytics page's Buyers tab rows (server/analytics-dashboard/buyers.ts)
 * and its status filter (shared matchesBuyerStatus).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-buyers.test.ts
 */
import assert from "node:assert/strict";
import { matchesBuyerStatus, parseBuyerStatusFilter, type BuyerStatusFilter } from "../../shared/analytics-dashboard";
import { accessLevelLabel } from "../../shared/access-levels";
import { buildBuyersResponse } from "../../server/engagement/responses";
import { buyerRows } from "../../server/analytics-dashboard/buyers";
import { cimOnly } from "../../server/analytics-dashboard/kpis";
import { NOW, ago, factsOf, inputsOf, questionRow, type DealSpec } from "./fixtures/analytics-fixtures";

const DEAL: DealSpec = {
  id: "d", name: "Pacific Coast Logistics",
  links: [
    { id: "a", name: "Ann Reader", firstViewedDaysAgo: 5, ndaDaysAgo: 6, decision: "interested", decisionDaysAgo: 2, fit: { matched: 4, total: 6 }, buyerUserId: "u-ann" },
    { id: "b", name: "Ben Blind", level: "full", firstViewedDaysAgo: 4, expiresInDays: 3 },
    { id: "n", name: "Nora Unopened", createdDaysAgo: 9, level: "due_diligence" },
    { id: "r", name: "Rae Removed", firstViewedDaysAgo: 3, revokedDaysAgo: 1 },
    { id: "x", name: "Xavi No", firstViewedDaysAgo: 6, decision: "not_interested", decisionDaysAgo: 1 },
    { id: "t1", name: "Tess Teaser", level: "teaser_only" },
    { id: "t2", name: "Tom Asked", level: "teaser_only", events: [{ type: "cim_requested", at: ago(1).toISOString() }], ndaDaysAgo: 1 },
  ],
  visits: [
    { id: "va1", access: "a", daysAgo: 5, activeMs: 30 * 60_000, pages: ["exec", "fin", "cust"] },
    { id: "va2", access: "a", daysAgo: 2, activeMs: 12 * 60_000, pages: ["fin"] },
    { id: "vb", access: "b", daysAgo: 4, activeMs: 8 * 60_000 },
    { id: "vr", access: "r", daysAgo: 3, activeMs: 2 * 60_000 },
    { id: "vx", access: "x", daysAgo: 6, activeMs: 1 * 60_000 },
  ],
  reading: [
    { visit: "va1", page: "fin", ms: 900_000, block: "row:0" }, { visit: "va1", page: "exec", ms: 200_000, block: "para:0" },
    { visit: "va1", page: "cust", ms: 2_000, block: "para:0" },
    { visit: "va2", page: "fin", ms: 400_000, block: "row:1" },
    { visit: "vb", page: "exec", ms: 300_000 },
  ],
};

const inputs = inputsOf([DEAL], { questions: [questionRow("d", { id: "q1", access: "a", text: "Yard lease?", daysAgo: 1, status: "pending_broker" })] });
const rows = buyerRows(inputs, NOW);
const row = (id: string) => rows.find((r) => r.accessId === id)!;

assert.equal(rows.length, 7, "every link: 5 CIM rows + 2 teaser rows");

// CIM rows match the deal tab's buyer cards exactly.
const facts = cimOnly(factsOf(DEAL));
const cards = buildBuyersResponse(facts).buyers;
for (const c of cards) {
  const r = row(c.accessId);
  assert.equal(r.status, c.status, `${c.name}: same status as the card`);
  assert.equal(r.statusLabel, c.statusLabel, `${c.name}: same words as the card`);
  assert.equal(r.readingMs, c.activeMs, `${c.name}: same reading time as the card`);
}
const A = row("a");
assert.equal(A.document, "cim");
assert.equal(A.readingMs, 42 * 60_000);
assert.equal(A.visits, 2);
assert.equal(A.pagesRead, 2, "pages with ≥ 3 s of reading (not the 2 s on Customer Base)");
assert.equal(A.contentPages, 4);
assert.equal(A.fitText, "4 of 6 criteria");
assert.deepEqual(A.fit, { matched: 4, total: 6 });
assert.equal(A.buyerUserId, "u-ann");
assert.equal(A.questions, 0, "no questions in the facts fixture");
assert.equal(A.questionsWaiting, 1, "one question waiting for the broker");
assert.equal(A.accessLabel, accessLevelLabel("loi"));
assert.equal(A.accessLabel, "Full CIM", "legacy 'loi' reads as the Full CIM");
assert.equal(row("b").accessLabel, "Blind CIM", "legacy 'full' reads as the Blind CIM");
assert.equal(row("n").accessLabel, "Due diligence");
assert.equal(row("n").readingMs, 0);
assert.equal(row("n").firstSeenAt, null);
assert.equal(row("n").fitText, null);
assert.equal(row("r").revokedAt, ago(1).toISOString());
assert.ok(row("b").expiresAt);

// Teaser-only rows.
const T1 = row("t1");
assert.equal(T1.document, "teaser");
assert.equal(T1.status, "teaser");
assert.equal(T1.statusLabel, "Has the teaser");
assert.equal(T1.accessLabel, "Teaser");
assert.equal(T1.readingMs, null);
assert.equal(T1.pagesRead, null);
assert.equal(T1.visits, null);
assert.equal(row("t2").status, "teaser_asked");
assert.equal(row("t2").statusLabel, "Asked for the CIM");

// Status filters.
const match = (f: BuyerStatusFilter) => rows.filter((r) => matchesBuyerStatus(r, f, NOW)).map((r) => r.accessId).sort();
assert.deepEqual(match("all").length, 7);
assert.deepEqual(match("interested"), ["a"]);
assert.deepEqual(match("deciding"), ["b", "r"], "opened, no final decision");
assert.deepEqual(match("not_opened"), ["n"], "CIM links never opened; never a teaser link");
assert.deepEqual(match("declined"), ["x"]);
assert.deepEqual(match("expiring"), ["b"], "runs out within 7 days, not removed, undecided");
assert.deepEqual(match("teaser_links"), ["t1", "t2"]);
assert.equal(parseBuyerStatusFilter("teaser"), "teaser_links", "an older ?status=teaser link still opens Teaser only");
assert.equal(parseBuyerStatusFilter("teaser_links"), "teaser_links");
assert.equal(parseBuyerStatusFilter("bogus"), "all");
assert.deepEqual(match("teaser_asked"), ["t2"]);
assert.deepEqual(match("revoked"), ["r"]);

console.log("analytics-buyers: all assertions passed");
