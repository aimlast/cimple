// Round V integration (d-resolution × f-conflicts-notes): the two
// "one conflict, one row" rules must never cancel each other out.
// discrepancy-check.ts supersedeCheckDuplicates supersedes an OPEN check row
// that repeats a merge row; merge-conflicts.ts planMergeRowSupersession
// supersedes an open merge row that repeats another row. Before the fix the
// merge rule still counted the superseded check row, so the next reprocess
// or check retired the merge row too and the conflict had no row at all
// (and a critical one stopped blocking CIM generation).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/information/v-dedupe-integration.test.ts
import assert from "node:assert/strict";
import { supersedeCheckDuplicates } from "../../server/cim/discrepancy-check";
import { planMergeRowSupersession } from "../../server/documents/merge-conflicts";

const doc = (documentId: string) => ({ documentId, source: "document" as const });
const info: Record<string, unknown> = {
  annualRevenue: "$1,820,000",
  revenueByYear: { "2024": "$1,820,000" },
  _fieldSources: { annualRevenue: doc("FS24"), revenueByYear: doc("FS24") },
  _fieldAlternates: { annualRevenue: [{ value: "about $4.5M", source: "call", documentId: "CALL" }] },
};
const docs = [{ id: "CALL", name: "Call" }, { id: "FS24", name: "FS 2024" }] as any[];

const merge: any = {
  id: "M", dealId: "d", createdAt: new Date(2), source: "merge", status: "open", severity: "critical", category: "financial",
  field: "Annual revenue", factKey: "annualRevenue", factYear: null, interviewValue: "about $4.5M", documentValue: "$1,820,000",
  resolvedValue: null, documentId: "FS24", sideSources: { interview: { kind: "call", documentId: "CALL" }, document: { kind: "document", documentId: "FS24" } },
};
const check: any = {
  id: "C", dealId: "d", createdAt: new Date(1), source: "interview", status: "open", severity: "critical", category: "financial",
  field: "Annual revenue", factKey: "annualRevenue", factYear: null, interviewValue: "about $4.5M", documentValue: "$1,820,000", resolvedValue: null,
};

await (async () => {
  const rows: any[] = [{ ...check }, { ...merge }];
  const store = {
    getDiscrepanciesByDeal: async () => rows.map((r) => ({ ...r })),
    updateDiscrepancy: async (id: string, u: any) => Object.assign(rows.find((r) => r.id === id), u),
  };
  assert.equal(await supersedeCheckDuplicates("d", store as any), 1, "the check's duplicate gives way to the merge row");
  assert.equal(rows.find((r) => r.id === "C").status, "superseded");
  // The next reprocess / check / gate settles merge rows: the merge row must stay.
  assert.deepEqual(planMergeRowSupersession(rows as any, info, docs), [], "the merge row is not retired for repeating a superseded row");
  const live = rows.filter((r) => r.status !== "superseded");
  assert.equal(live.length, 1, "exactly one row left for the dispute");
  console.log("✓ check-vs-merge dedupe leaves exactly one live row");
})();

// A live (open) check row still makes a later duplicate merge row give way,
// and a resolved row still keeps a settled conflict from coming back.
{
  assert.deepEqual(planMergeRowSupersession([check, merge], info, docs), ["M"], "an open check row still wins over a later duplicate merge row");
  assert.deepEqual(planMergeRowSupersession([{ ...check, status: "resolved", resolvedValue: "$1,820,000" }, merge], info, docs), ["M"], "a resolved conflict is not re-opened");
  console.log("✓ live and settled rows still dedupe merge rows");
}
console.log("v-dedupe-integration: all passed");
