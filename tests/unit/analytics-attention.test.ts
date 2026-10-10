/**
 * "What buyers read most" (server/analytics-dashboard/attention.ts):
 * page-level (old-tracker) reading no longer claims buyers skipped every
 * kind of content (the old panel's P4 bug).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-attention.test.ts
 */
import assert from "node:assert/strict";
import { attentionBasis, hasPartByPart, kindAttention, layoutAttention, roleAttention } from "../../server/analytics-dashboard/attention";
import { attentionResponse } from "../../server/analytics-dashboard/responses";
import { factsOf, inputsOf, type DealSpec } from "./fixtures/analytics-fixtures";

// Old tracker only: page totals.
const OLD: DealSpec = {
  id: "old", name: "Old Tracker Deal",
  links: [{ id: "o1", name: "Olga", firstViewedDaysAgo: 20 }, { id: "o2", name: "Oscar", firstViewedDaysAgo: 19 }],
  visits: [
    { id: "a", access: "o1", daysAgo: 20, activeMs: 900_000, legacy: true, pages: ["cover", "exec", "fin"] },
    { id: "b", access: "o2", daysAgo: 19, activeMs: 300_000, legacy: true, pages: ["fin", "deal"] },
  ],
  reading: [
    { visit: "a", page: "cover", ms: 30_000 }, { visit: "a", page: "exec", ms: 120_000 }, { visit: "a", page: "fin", ms: 400_000 },
    { visit: "b", page: "fin", ms: 200_000 }, { visit: "b", page: "deal", ms: 60_000 },
  ],
};
const oldItems = [{ facts: factsOf(OLD) }];
assert.equal(hasPartByPart(oldItems), false);
assert.deepEqual(kindAttention(oldItems), [], "page totals only: no claim about kinds of content");
const roles = roleAttention(oldItems);
assert.ok(roles.length > 0, "by topic works with page-level reading");
assert.ok(!roles.some((r) => r.role === "front_matter"), "front matter never counts");
const fin = roles.find((r) => r.role === "financials")!;
assert.equal(fin.label, "Financials");
assert.equal(fin.attentionMs, 600_000);
assert.equal(fin.readers, 2);
assert.equal(fin.pages, 1);
assert.equal(roles[0].role, "financials", "sorted by how closely they're read");
assert.ok(layoutAttention(oldItems).length > 0, "by layout works with page-level reading");
assert.deepEqual(attentionBasis(oldItems), { buyers: 2, deals: 1, attentionMs: 780_000 });

// Mixed: one deal part by part, one with page totals.
const NEW: DealSpec = {
  id: "new", name: "Part By Part",
  links: [{ id: "n1", name: "Nia", firstViewedDaysAgo: 2 }],
  visits: [{ id: "c", access: "n1", daysAgo: 2, activeMs: 600_000, pages: ["exec", "fin"] }],
  reading: [{ visit: "c", page: "fin", ms: 300_000, block: "row:0" }, { visit: "c", page: "exec", ms: 100_000, block: "para:0" }],
};
const mixed = [{ facts: factsOf(OLD) }, { facts: factsOf(NEW) }];
assert.equal(hasPartByPart(mixed), true);
const kinds = kindAttention(mixed);
const tables = kinds.find((k) => k.group === "tables")!;
assert.equal(tables.attentionMs, 300_000, "only the part-by-part reading counts toward kinds");
assert.equal(tables.expectedMs, 40_000, "and only those pages' expected time (two 20 s rows)");
assert.equal(kinds.find((k) => k.group === "text")?.attentionMs, 100_000);

// Locked pages never count.
{
  const f = factsOf(NEW);
  f.pages = f.pages.map((p) => (p.pageId === "fin" ? { ...p, locked: true } : p));
  assert.ok(!roleAttention([{ facts: f }]).some((r) => r.role === "financials"));
}

// The response.
const resp = attentionResponse(inputsOf([OLD]), []);
assert.equal(resp.partByPart, false);
assert.deepEqual(resp.byKind, []);
assert.ok(resp.byRole.length > 0 && resp.byLayout.length > 0);

console.log("analytics-attention: all assertions passed");
