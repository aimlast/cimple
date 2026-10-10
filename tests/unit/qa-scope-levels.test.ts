/**
 * Buyer Q&A scope (shared/buyer-qa-scope.ts) under the October 2026 levels:
 * a Teaser link never asks and never reads (not even its own rows); a Blind
 * CIM buyer's answer is for every CIM buyer; a named-CIM answer is the
 * asker's only; legacy keys behave as the level they alias. Pure.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/qa-scope-levels.test.ts
 */
import assert from "node:assert/strict";
import { askerScope, readerMaySeeRow, rowScope, scopeAllows } from "../../shared/buyer-qa-scope";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

const reader = (accessLevel: string | null, id = "R") => ({ id, accessLevel });
const approved = { buyerAccessId: "X", question: "How many staff?", aiAnswer: "Twelve.", publishedAnswer: "Twelve.", brokerDraft: "Twelve.", answerScope: "all" };

console.log("Q&A scope by level");

test("asker scope: Blind CIM (new and legacy) → all; named and DD → private; Teaser → private (never asks)", () => {
  const table: Array<[string | null, string]> = [
    ["blind", "all"], ["teaser", "all"], ["full", "all"],
    ["named", "private"], ["loi", "private"], ["due_diligence", "private"],
    ["teaser_only", "private"], [null, "private"], ["junk", "private"],
  ];
  for (const [l, want] of table) assert.equal(askerScope(l), want, String(l));
});

test("scopeAllows: a Teaser reader reads nothing — not even its own row", () => {
  for (const scope of ["all", "full", "private"] as const) {
    assert.equal(scopeAllows(scope, { buyerAccessId: "R" }, reader("teaser_only")), false, scope);
    assert.equal(scopeAllows(scope, { buyerAccessId: "X" }, reader("teaser_only")), false, scope);
  }
});

test("scopeAllows for CIM readers: all and historical full → every CIM buyer; private → the asker only", () => {
  for (const l of ["blind", "teaser", "full", "named", "loi", "due_diligence"]) {
    assert.equal(scopeAllows("all", { buyerAccessId: "X" }, reader(l)), true, l);
    assert.equal(scopeAllows("full", { buyerAccessId: "X" }, reader(l)), true, l);
    assert.equal(scopeAllows("private", { buyerAccessId: "X" }, reader(l)), false, l);
    assert.equal(scopeAllows("private", { buyerAccessId: "R" }, reader(l)), true, `${l}: own`);
  }
});

test("readerMaySeeRow: approved answers reach CIM readers, never a Teaser link", () => {
  assert.equal(readerMaySeeRow(approved as any, "all", reader("blind"), []), true);
  assert.equal(readerMaySeeRow(approved as any, "all", reader("named"), []), true);
  assert.equal(readerMaySeeRow(approved as any, "all", reader("teaser_only"), []), false);
  assert.equal(readerMaySeeRow({ ...approved, buyerAccessId: "R" } as any, "all", reader("teaser_only"), []), false);
});

test("rows from before scopes: the asker's current level decides (legacy values as their level)", () => {
  const legacy = { buyerAccessId: "X", question: "q", aiAnswer: "a", answerScope: null };
  assert.equal(rowScope(legacy as any, "full"), "all");
  assert.equal(rowScope(legacy as any, "loi"), "private");
  assert.equal(rowScope(legacy as any, "teaser_only"), "private");
  assert.equal(rowScope(legacy as any, false), "full");
});

console.log(`\n${passed} passed`);
