// V11-1 (creation path): a SETTLED row of another engine keeps the check's
// finding from coming back only when it records the same dispute at the
// finding's severity or above. The engine's own backstop
// (runDiscrepancyCheck) used to drop the finding on the loose
// isSameDiscrepancy match against every settled row — so after the broker
// resolved a minor T2-vs-FS revenue row, the seller's critical "$2.3M vs the
// statements' $1,820,000" was never created and the CIM gate stayed open.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/rv-dispute-create.test.ts
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { _setCheckModelForTests, settledRowSettles } from "../../server/cim/discrepancy-engine";
import { runAndPersistDiscrepancyCheck, blockingCritical } from "../../server/cim/discrepancy-check";
import { discrepancyForConflict } from "../../server/documents/merge-conflicts";

const dealId = "deal-create";
const deal: any = {
  id: dealId, brokerId: "b1", businessName: "Probe Co", industry: "Distribution",
  extractedInfo: {
    revenueByYear: { "2024": "$2,300,000" },
    _fieldSources: { revenueByYear: { source: "interview", years: { "2024": { source: "interview" } } } },
    _fieldAlternates: { "revenueByYear.2024": [{ value: "$1,820,000", source: "document", documentId: "fs" }] },
  },
  discrepancyCheckedAt: null, discrepancyCheckSources: null,
};
const docs: any[] = [
  { id: "fs", name: "FY2024 Financial Statements", category: "financials", sourceKind: "document", visibility: "shared", isProcessed: true, extractedText: "Revenue 2024 1,820,000", extractedData: null },
  { id: "t2", name: "2024 T2 Corporate Tax Return", category: "financials", sourceKind: "document", visibility: "shared", isProcessed: true, extractedText: "Gross revenue 1,700,000", extractedData: null },
];
let rows: any[] = [];
const s = storage as any;
s.getDeal = async () => ({ ...deal });
s.getDocumentsByDeal = async () => docs;
s.getDiscrepanciesByDeal = async () => rows.map((r) => ({ ...r }));
s.createDiscrepancy = async (data: any) => { const r = { id: `new-${rows.length + 1}`, createdAt: new Date(), ...data }; rows.push(r); return r; };
s.updateDiscrepancy = async (id: string, u: any) => Object.assign(rows.find((r) => r.id === id), u);
s.updateDeal = async (_id: string, u: any) => Object.assign(deal, u);

let existingId: string | null = null;
_setCheckModelForTests(async (_system, user) => {
  const ref = (label: string) => user.match(new RegExp(`- (S\\d+): [^\\n]*${label}`))?.[1];
  return {
    discrepancies: [{
      field: "FY2024 revenue", factKey: "revenueByYear", factYear: "2024",
      claimValue: "$2.3 million", claimSource: ref("nterview"),
      evidenceValue: "$1,820,000", evidenceSource: ref("Financial Statements"),
      severity: "critical", category: "financial",
      explanation: "The seller said $2.3M; the statements show $1.82M.", suggestedResolution: "Confirm.",
      ...(existingId ? { existingId } : {}),
    }],
    clearedIds: [],
  };
});

const draft = discrepancyForConflict({
  factKey: "revenueByYear", factYear: "2024",
  winner: { value: "$1,820,000", src: { source: "document", documentId: "fs", specialist: true } as any },
  loser: { value: "$1,700,000", src: { source: "document", documentId: "t2" } as any },
} as any, (id) => ({ fs: "FY2024 Financial Statements", t2: "2024 T2 Corporate Tax Return" } as Record<string, string>)[id]);

async function run(existing: any[], useId = false) {
  rows = existing.map((r, i) => ({ id: `0000000${i}-0000-0000-0000-000000000000`, dealId, createdAt: new Date("2026-09-20"), resolvedValue: null, ...r }));
  existingId = useId ? rows[0].id : null;
  deal.discrepancyCheckedAt = null; deal.discrepancyCheckSources = null;
  const res = await runAndPersistDiscrepancyCheck(dealId);
  return { created: res.count, blocks: blockingCritical(rows) };
}

// Baseline: nothing on file — created as critical.
assert.deepEqual(await run([]), { created: 1, blocks: true });

// Another engine's settled row for a DIFFERENT dispute on the same fact/year.
const t2VsFsResolved = { ...draft, source: "merge", status: "resolved", resolvedValue: "$1,820,000" };
const analysisResolved = {
  source: "financial_analysis", status: "resolved", severity: "significant", field: "Revenue 2024 (T2 vs financial statements)",
  factKey: "revenueByYear", factYear: "2024", interviewValue: "$1,700,000 — 2024 T2 Corporate Tax Return",
  documentValue: "$1,820,000 — FY2024 Financial Statements", resolvedValue: "$1,820,000",
};
for (const [label, other] of [["merge T2-vs-FS minor, resolved", t2VsFsResolved], ["analysis T2-vs-FS significant, resolved", analysisResolved]] as const) {
  assert.deepEqual(await run([other]), { created: 1, blocks: true }, `${label}: the seller's claim is still raised and blocks`);
  assert.deepEqual(await run([other], true), { created: 1, blocks: true }, `${label}: also when the model names that row`);
}
console.log("✓ a settled row for a different dispute never stops the finding being created");

// The SAME dispute, settled at critical: stays settled (never re-raised).
const sameCritical = {
  source: "merge", status: "resolved", severity: "critical", field: "Revenue (2024)", factKey: "revenueByYear", factYear: "2024",
  interviewValue: "$2,300,000 (interview)", documentValue: "$1,820,000 — FY2024 Financial Statements", resolvedValue: "$1,820,000",
};
assert.deepEqual(await run([sameCritical]), { created: 0, blocks: false });
// The check's own settled row: settled, whatever its values.
assert.deepEqual(await run([{ source: "interview", status: "resolved", severity: "critical", field: "FY2024 revenue", factKey: "revenueByYear", factYear: "2024", interviewValue: "$2.2M", documentValue: "$1,820,000", resolvedValue: "$1,820,000" }]), { created: 0, blocks: false });
console.log("✓ the same dispute settled at its severity, or the check's own settled row, is never re-raised");

// The rule itself.
const item = { field: "FY2024 revenue", factKey: "revenueByYear", factYear: "2024", interviewValue: "$2.3 million", documentValue: "$1,820,000", severity: "critical" };
assert.equal(settledRowSettles(item, { id: "x", ...t2VsFsResolved } as any), false);
assert.equal(settledRowSettles(item, { id: "x", ...sameCritical } as any), true);
assert.equal(settledRowSettles(item, { id: "x", ...sameCritical, severity: "minor" } as any), false, "a lower-severity twin never silences a critical");

_setCheckModelForTests(null);
console.log("rv-dispute-create: all passed");
process.exit(0);
