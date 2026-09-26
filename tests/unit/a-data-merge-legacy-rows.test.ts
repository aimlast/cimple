// ACC2-05: the Ridgeline reprocess kept backlog $3.1M (WIP report) with the
// call's $4.2M as another value, yet raised no merge discrepancy: the
// clone's legacy financial-analysis row "Signed backlog (May 2025)" (open,
// fact_key NULL) was recognised as the same dispute, so nothing new was
// raised — and the one row for the dispute stayed without a fact. Now that
// row takes the fact. Owner comp ($180K salary vs the seller's $260K of
// salary + dividends) is by design no ownerSalary dispute: a salary against
// total compensation (the analysis raises it, with factKey — ACC2-04).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/a-data-merge-legacy-rows.test.ts
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { recordMergeConflicts } from "../../server/documents/merge-conflicts";
import type { MergeConflict } from "../../server/documents/merge-policy";

const rows: any[] = [];
const s = storage as any;
s.getDiscrepanciesByDeal = async () => rows.map((r) => ({ ...r }));
s.createDiscrepancy = async (data: any) => {
  const r = { id: `row-${rows.length + 1}`, createdAt: new Date(Date.now() + rows.length), resolvedValue: null, ...data };
  rows.push(r);
  return { ...r };
};
s.updateDiscrepancy = async (id: string, u: any) => Object.assign(rows.find((r) => r.id === id), u);

const docs = [
  { id: "wip", name: "WIP & backlog report as of May 31, 2025 (+ open quotes)" },
  { id: "call", name: "Phone call — Morgan Ellis & Gord McAllister (discovery deep-dive)" },
  { id: "t2", name: "T2 corporate tax return 2024 (client copy)" },
] as any[];
const backlogConflict: MergeConflict = {
  factKey: "backlog",
  winner: { value: "$3,100,000", src: { source: "document", documentId: "wip", specialist: true, period: "2025-05-31" } as any },
  loser: { value: "$4.2M as of end of May 2025 (best level since 2014)", src: { source: "call", documentId: "call" } as any },
};
const info = {
  backlog: "$3,100,000",
  _fieldSources: { backlog: { source: "document", documentId: "wip", specialist: true, period: "2025-05-31" } },
  _fieldAlternates: { backlog: [{ value: "$4.2M as of end of May 2025 (best level since 2014)", source: "call", documentId: "call" }] },
};

// 1. The legacy null-key row stands for the dispute and takes its fact.
{
  rows.length = 0;
  rows.push({
    id: "legacy", dealId: "D", source: "financial_analysis", status: "open", severity: "critical", category: "financial",
    field: "Signed backlog (May 2025)", factKey: null, factYear: null, sideSources: null, resolvedValue: null, createdAt: new Date(0),
    interviewValue: "$4.2M as of end of May 2025 — Seller statements (June 5, 2025 call and June 16, 2025 email)",
    documentValue: "$3.1M signed backlog (remaining contract value on signed work with POs) — WIP & backlog report as of May 31, 2025 (prepared by Tanya)",
  });
  const created = await recordMergeConflicts("D", [backlogConflict], docs, info);
  assert.equal(created, 0, "one dispute, one row");
  assert.equal(rows[0].factKey, "backlog");
  assert.equal(rows[0].sideSources.interview.kind, "call");
  assert.equal(rows[0].sideSources.document.documentId, "wip");
  assert.equal(rows[0].status, "open");
  // Idempotent: a second reprocess changes nothing more.
  assert.equal(await recordMergeConflicts("D", [backlogConflict], docs, info), 0);
  assert.equal(rows.length, 1);
  console.log("✓ the legacy analysis row for the backlog dispute now names backlog");
}

// 2. With no row for it, the merge raises the dispute itself (decision A: the WIP report is the authority).
{
  rows.length = 0;
  assert.equal(await recordMergeConflicts("D", [backlogConflict], docs, info), 1);
  assert.equal(rows[0].source, "merge");
  assert.equal(rows[0].factKey, "backlog");
  assert.match(rows[0].interviewValue, /4\.2M/);
  assert.equal(rows[0].documentValue, "$3,100,000");
  console.log("✓ without a legacy row the merge raises $4.2M vs $3.1M as a merge row");
}

// 3. A settled or superseded legacy row is left alone (a settled dispute stays settled).
{
  rows.length = 0;
  rows.push({ id: "settled", dealId: "D", source: "financial_analysis", status: "resolved", field: "Signed backlog (May 2025)", factKey: null, factYear: null, resolvedValue: "$3,100,000", createdAt: new Date(0),
    interviewValue: "$4.2M — Seller statements", documentValue: "$3.1M — WIP report" });
  assert.equal(await recordMergeConflicts("D", [backlogConflict], docs, info), 0);
  assert.equal(rows[0].factKey, null, "a resolved row is never rewritten");
  console.log("✓ resolved rows are untouched and never re-opened");
}

// 4. Owner pay: the salary against salary + dividends is not one fact disputed.
{
  rows.length = 0;
  const ownerPay: MergeConflict = {
    factKey: "ownerSalary",
    winner: { value: "$180,000", src: { source: "document", documentId: "t2" } as any },
    loser: { value: "$260,000 owner compensation (salary + dividends)", src: { source: "call", documentId: "call" } as any },
  };
  assert.equal(await recordMergeConflicts("D", [ownerPay], docs, { ownerSalary: "$180,000", _fieldSources: { ownerSalary: { source: "document", documentId: "t2" } }, _fieldAlternates: { ownerSalary: [{ value: ownerPay.loser.value, source: "call", documentId: "call" }] } }), 0);
  assert.equal(rows.length, 0);
  console.log("✓ $180K salary vs $260K salary + dividends is left to the analysis (a salary vs total compensation)");
}

console.log("a-data-merge-legacy-rows: all passed");
