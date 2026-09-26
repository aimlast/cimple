// ACC2-04: the financial analysis on the Ridgeline clone raised "Owner
// compensation (2024)" and "Signed backlog (May 2025)" with fact_key NULL,
// although ownerSalary and backlog were on file. Replays the recorded rows
// (acc2/ridge-after-fa.json) through the analysis' persistence with a fake
// store.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/a-data-analysis-factkey.test.ts
import assert from "node:assert/strict";
import { analysisFactKey } from "../../server/financial/discrepancy-fact-key";
import { _persistFinancialDiscrepanciesForTests } from "../../server/financial/analyzer";

const info: Record<string, unknown> = {
  ownerSalary: "$180,000",
  ownerSalaryByYear: { "2022": "$180,000", "2023": "$180,000" },
  managementSalary: "$180,000 paid to majority shareholder (2023 and 2022)",
  backlog: "$3,100,000",
  backlogBySegment: "Oil & gas fabrication: $1,183,400 | Commercial construction: $788,000 | Agriculture: $766,300 | Mixed: $362,300 | Total signed backlog: $3,100,000",
  openQuotesTotal: "$2,186,000 across 4 quotes",
  revenueByYear: { "2023": "$9,160,000", "2024": "$9,815,000" },
  annualRevenue: "$9,815,000 (2024)",
  leaseExpiry: "December 31, 2026",
  employees: "42",
};

const ownerComp = {
  field: "Owner compensation (2024)",
  factKey: null,
  factYear: "2024",
  sourceA: { source: "Seller's add-back list (June 3, 2025 email)", value: "$260,000 owner salary (Gord)" },
  sourceB: { source: "T2 corporate tax return 2024 and accountant's notes", value: "$180,000 T4 management salary to Gord McAllister" },
};
const backlog = {
  field: "Signed backlog (May 2025)",
  factKey: null,
  factYear: null,
  sourceA: { source: "Seller statements (June 5, 2025 call and June 16, 2025 email)", value: "$4.2M as of end of May 2025" },
  sourceB: { source: "WIP & backlog report as of May 31, 2025 (prepared by Tanya)", value: "$3.1M signed backlog (remaining contract value on signed work with POs)" },
};

// 1. The recorded findings get their facts.
{
  assert.deepEqual(analysisFactKey(ownerComp, info), { factKey: "ownerSalary", factYear: "2024" });
  assert.deepEqual(analysisFactKey(backlog, info), { factKey: "backlog", factYear: null });
  console.log("✓ Owner compensation (2024) → ownerSalary; Signed backlog (May 2025) → backlog");
}

// 2. The model's key stays when it is on file; a misspelt one is canonicalised; a guess is refused.
{
  assert.equal(analysisFactKey({ ...ownerComp, factKey: "managementSalary" }, info)?.factKey, "managementSalary");
  assert.equal(analysisFactKey({ ...backlog, field: "Revenue (2024)", factKey: null, factYear: "2024", sourceA: { value: "$10.2M" }, sourceB: { value: "$9,815,000" } } as any, info)?.factKey, "revenueByYear");
  assert.equal(analysisFactKey({ field: "Lease expiry", sourceA: { value: "2034" }, sourceB: { value: "December 31, 2026" } }, info)?.factKey, "leaseExpiry");
  assert.equal(analysisFactKey({ field: "Customer deposits", sourceA: { value: "$40,000" }, sourceB: { value: "$55,000" } }, info), null, "nothing on file fits");
  console.log("✓ model keys kept; labels mapped; no guesses");
}

// 3. Through persistence: new rows carry the key, and a legacy null-key row of ours is backfilled.
{
  const rows: any[] = [
    { id: "L1", dealId: "D", source: "financial_analysis", status: "open", severity: "critical", category: "financial", field: "Signed backlog (May 2025)", factKey: null, factYear: null, interviewValue: "$4.2M as of end of May 2025 — Seller statements", documentValue: "$3.1M signed backlog — WIP & backlog report", createdAt: new Date(0) },
  ];
  const store: any = {
    async updateDiscrepancy(id: string, patch: any) { Object.assign(rows.find((r) => r.id === id), patch); return rows.find((r) => r.id === id); },
    async createDiscrepancy(row: any) { const r = { id: `N${rows.length}`, createdAt: new Date(), ...row }; rows.push(r); return r; },
  };
  await _persistFinancialDiscrepanciesForTests("D", store, [{ ...ownerComp, severity: "critical", category: "financial", explanation: "The seller's add-back list claims $260,000; the T2 shows $180,000.", suggestedResolution: "Confirm." } as any], [], {}, rows.slice(), {}, undefined, info);
  const legacy = rows.find((r) => r.id === "L1");
  assert.equal(legacy.factKey, "backlog", "the legacy row now names its fact");
  const created = rows.find((r) => r.field === "Owner compensation (2024)");
  assert.ok(created, "the owner-pay row is created");
  assert.equal(created.factKey, "ownerSalary");
  assert.equal(created.factYear, "2024");
  console.log("✓ persisted rows carry factKey; a legacy row is backfilled");
}

console.log("a-data-analysis-factkey: all passed");
