/**
 * Round F (analysis): discrepancies by fiscal year, by-year facts, SDE.
 *
 *  - F-01: resolving "2024 Revenue" onto revenueByYear with no factYear
 *    wrote "$9,815,000" over the whole map (2022–2023 gone).
 *  - F-02: "Net income (2023)" settled hid a new "Net income (2024)"
 *    conflict; an open 2023 row was refreshed with 2024's values.
 *  - F-03: "SDE (2024)" $1.1M vs "$898,000 after add-backs" was dropped as
 *    adjusted-vs-reported (and an open SDE row superseded).
 *
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f-analysis-discrepancies.test.ts
 */
import assert from "node:assert/strict";
import { applyResolutionToInfo, editFact, NEEDS_MAPPING, suggestFactTargets, FactError } from "../../server/information/facts";
import { planResolution, targetForFactKey, yearForMapResolution } from "../../server/information/resolution-write";
import { settleResolvedFacts, resolvedNotes } from "../../server/cim/resolved-block";
import { _persistFinancialDiscrepanciesForTests } from "../../server/financial/analyzer";
import { isSameDiscrepancy, settledRowSettles, recordsSameDispute } from "../../server/cim/discrepancy-engine";
import { dropReason, discrepancyYear, differentYears, normalizeFactYear } from "../../server/cim/discrepancy-filter";

const REV = () => ({ revenueByYear: { "2022": "$8,400,000", "2023": "$9,160,000", "2024": "$9,815,000" }, annualRevenue: "$9,815,000" } as Record<string, unknown>);
const row = (over: Record<string, unknown> = {}) => ({
  field: "2024 Revenue", factKey: "revenueByYear", factYear: null, source: "financial_analysis",
  interviewValue: "$10,400,000 — Seller interview", documentValue: "$9,815,000 — Financial statements FY2024", documentId: null,
  resolvedValue: "$9,815,000", ...over,
}) as any;

// ── F-01: a figure never replaces a map by year ──
{
  // (a) the analysis's row: the year comes from the field.
  const info = REV();
  assert.equal(applyResolutionToInfo(info, row()), "revenueByYear.2024");
  assert.deepEqual(info.revenueByYear, { "2022": "$8,400,000", "2023": "$9,160,000", "2024": "$9,815,000" }, "every year kept");
  // Resolved to the seller's figure: only 2024 changes (and the 2024 headline with it).
  const info2 = REV();
  assert.equal(applyResolutionToInfo(info2, row({ resolvedValue: "$10,400,000" })), "revenueByYear.2024");
  assert.deepEqual(info2.revenueByYear, { "2022": "$8,400,000", "2023": "$9,160,000", "2024": "$10,400,000" });
  // (b) "FY24" or the number 2024 as the factYear is still 2024.
  assert.equal(normalizeFactYear("FY24"), "2024");
  assert.equal(normalizeFactYear(2024), "2024");
  assert.deepEqual(targetForFactKey(REV(), "revenueByYear", "FY24"), { key: "revenueByYear", sub: "2024" });
  // No year anywhere (the broker picked the fact in the dialog): ask for the year, write nothing.
  const info3 = REV();
  assert.equal(applyResolutionToInfo(info3, row({ field: "Revenue", documentValue: "$9,815,000 — statements", interviewValue: "$10,400,000 — seller" }), { brokerChoseFact: true }), NEEDS_MAPPING);
  assert.deepEqual(info3.revenueByYear, REV().revenueByYear);
  assert.deepEqual(planResolution(REV(), { key: "revenueByYear" }, row({ field: "Revenue", documentValue: "$9,815,000", interviewValue: "$10.4M" })), { kind: "needs_mapping", year: true });
  // The year from the sides' labels when the field names none.
  assert.equal(yearForMapResolution({ field: "Revenue", interviewValue: "$10.4M — seller", documentValue: "$9,815,000 — Financial statements FY2024" }), "2024");
  assert.equal(yearForMapResolution({ field: "Revenue", interviewValue: "$10.4M — 2025 call", documentValue: "$9,815,000 — FY2024 statements" }), null, "two years: ask");
  // The picker offers the map's years and the row's own year.
  const opts = suggestFactTargets(REV(), row({ field: "2024 Revenue" }));
  assert.deepEqual(opts.all.find((o) => o.key === "revenueByYear")?.years, ["2024", "2023", "2022"]);
  assert.equal(opts.suggestedYear, "2024");
  // The read-time overlay (every CIM) applies the same rule.
  const settled = settleResolvedFacts(REV(), resolvedNotes([{ ...row(), id: "r", dealId: "d", status: "resolved", resolvedAt: new Date(), createdAt: new Date() } as any]));
  assert.deepEqual(settled.facts.revenueByYear, REV().revenueByYear);
  // Last guard: a broker edit can't put one figure over the whole map.
  assert.throws(() => editFact(REV(), "revenueByYear", "$9,815,000"), FactError);
  const edited = REV();
  editFact(edited, "revenueByYear", "2022: $8,400,000\n2023: $9,160,000\n2024: $9,900,000");
  assert.deepEqual(edited.revenueByYear, { "2022": "$8,400,000", "2023": "$9,160,000", "2024": "$9,900,000" });
  console.log("✓ F-01: resolving '2024 Revenue' writes 2024 only; no year → the broker picks one; a map is never replaced by a figure");
}

// ── F-02: fiscal years keep conflicts apart ──
(async () => {
  const info = { revenueByYear: { "2023": "$9,160,000", "2024": "$9,815,000" }, netIncomeByYear: { "2023": "$700,000", "2024": "$896,410" }, ownerSalary: "$180,000" };
  const store = (rows: any[]) => ({
    async updateDiscrepancy(id: string, p: any) { Object.assign(rows.find((r) => r.id === id), p); return rows.find((r) => r.id === id); },
    async createDiscrepancy(r: any) { const x = { id: `N${rows.length}`, createdAt: new Date(), ...r }; rows.push(x); return x; },
  }) as any;
  const base = { severity: "critical", category: "financial", explanation: "x", suggestedResolution: "y" };

  // 1. A settled 2023 net income never hides the 2024 conflict.
  {
    const rows: any[] = [{ id: "R1", dealId: "D", source: "financial_analysis", status: "resolved", field: "Net income (2023)", factKey: "netIncomeByYear", factYear: "2023", interviewValue: "$650,000 — seller", documentValue: "$700,000 — FS 2023", resolvedValue: "$700,000", createdAt: new Date(0) }];
    await _persistFinancialDiscrepanciesForTests("D", store(rows), [{ ...base, field: "Net income (2024)", factKey: "netIncomeByYear", factYear: "2024", sourceA: { source: "Seller interview", value: "$1,050,000" }, sourceB: { source: "FS 2024", value: "$896,410" } } as any], [], {}, rows.slice(), {}, undefined, info);
    assert.equal(rows.length, 2, "the 2024 conflict is a row of its own");
    assert.equal(rows[1].field, "Net income (2024)");
    assert.equal(rows[1].factYear, "2024");
  }
  // 2. An open 2023 row is never refreshed with 2024's figures.
  {
    const rows: any[] = [{ id: "O1", dealId: "D", source: "financial_analysis", status: "open", field: "Owner compensation (2023)", factKey: "ownerSalary", factYear: "2023", interviewValue: "$250,000 — seller", documentValue: "$180,000 — T2 2023", createdAt: new Date(0) }];
    await _persistFinancialDiscrepanciesForTests("D", store(rows), [
      { ...base, field: "Owner compensation (2024)", factKey: "ownerSalary", factYear: "2024", sourceA: { source: "Seller interview", value: "$260,000" }, sourceB: { source: "T2 2024", value: "$190,000" } } as any,
      { ...base, field: "Owner compensation (2023)", factKey: "ownerSalary", factYear: "2023", sourceA: { source: "Seller interview", value: "$250,000" }, sourceB: { source: "T2 2023", value: "$180,000" } } as any,
    ], [], {}, rows.slice(), {}, undefined, info);
    const o1 = rows.find((r) => r.id === "O1");
    assert.match(o1.interviewValue, /^\$250,000/, "the 2023 row keeps 2023's figures");
    assert.match(o1.documentValue, /^\$180,000/);
    assert.equal(o1.factYear, "2023");
    const y24 = rows.filter((r) => r.field === "Owner compensation (2024)");
    assert.equal(y24.length, 1);
    assert.match(y24[0].interviewValue, /^\$260,000/);
    assert.equal(rows.filter((r) => r.field === "Owner compensation (2023)").length, 1, "no duplicate 2023 row");
  }
  // 3. The model's existingId pointing at another year's row is not trusted.
  {
    const rows: any[] = [{ id: "11111111-1111-1111-1111-111111111111", dealId: "D", source: "financial_analysis", status: "resolved", field: "Revenue (FY2023)", factKey: "revenueByYear", factYear: "2023", interviewValue: "$9.5M — seller", documentValue: "$9,160,000 — FS", resolvedValue: "$9,160,000", createdAt: new Date(0) }];
    await _persistFinancialDiscrepanciesForTests("D", store(rows), [{ ...base, existingId: rows[0].id, field: "Revenue (FY2024)", factKey: "revenueByYear", factYear: "2024", sourceA: { source: "Seller interview", value: "$10.4M" }, sourceB: { source: "FS 2024", value: "$9,815,000" } } as any], [], {}, rows.slice(), {}, undefined, info);
    assert.equal(rows.length, 2);
  }
  // 4. The verification check's matchers.
  const item = { field: "Net income (2024)", factKey: "netIncomeByYear", factYear: "2024", interviewValue: "$1,050,000", documentValue: "$896,410", severity: "critical" };
  const settledRow: any = { id: "R", field: "Net income (2023)", factKey: "netIncomeByYear", factYear: "2023", interviewValue: "$650,000", documentValue: "$700,000", resolvedValue: "$700,000", status: "resolved", source: "interview", severity: "critical" };
  assert.equal(isSameDiscrepancy(item, settledRow), false);
  assert.equal(settledRowSettles(item as any, settledRow), false);
  assert.equal(isSameDiscrepancy({ field: "Owner compensation (2024)", factKey: "ownerSalary", factYear: "2024" }, { ...settledRow, field: "Owner compensation (2023)", factKey: "ownerSalary", factYear: "2023" }), false);
  assert.equal(isSameDiscrepancy({ field: "Accounts receivable 2024" }, { ...settledRow, field: "Accounts receivable 2023", factKey: null, factYear: null }), false);
  assert.equal(recordsSameDispute({ field: "Net income (2024)", interviewValue: "$700,000", documentValue: "$650,000" }, { field: "Net income (2023)", interviewValue: "$650,000", documentValue: "$700,000" }), false);
  // The same year (or no year on one side) still matches as before.
  assert.equal(isSameDiscrepancy({ field: "Net income (2024)", factKey: "netIncomeByYear", factYear: "2024" }, { ...settledRow, field: "2024 net income", factYear: "2024" }), true);
  assert.equal(differentYears({ field: "Net income" }, { field: "Net income (2023)" }), false);
  assert.equal(discrepancyYear({ field: "FY2024 revenue" }), "2024");
  assert.equal(discrepancyYear({ field: "Revenue 2023 vs 2024" }), null, "two years named: no single year");
  console.log("✓ F-02: a settled 2023 row never hides 2024; an open 2023 row is never refreshed with 2024's figures");

  // ── F-03: SDE against SDE is a real conflict ──
  const keep = [
    { field: "SDE (2024)", interviewValue: "$1,100,000 — Seller interview", documentValue: "$898,000 after add-backs — 2024 recast workbook", severity: "critical" },
    { field: "Seller's discretionary earnings 2024", interviewValue: "$1.1M — Seller interview", documentValue: "$898,000 normalized — Accountant's SDE schedule", severity: "critical" },
    { field: "2024 SDE", interviewValue: "about $1.1M in SDE — seller call", documentValue: "SDE $898,000 (net income $512,000 + add-backs $386,000) — Valuation workbook", severity: "critical" },
    { field: "Owner benefit 2024", factKey: "sde", interviewValue: "$1.1M", documentValue: "$898,000 after add-backs", severity: "critical" },
  ];
  for (const c of keep) assert.equal(dropReason(c as any), null, c.field);
  // One side the reported (unadjusted) figure: still two metrics.
  assert.equal(dropReason({ field: "SDE (2024)", interviewValue: "$1,100,000 — Seller interview", documentValue: "$512,000 net income — 2024 statements", severity: "critical" } as any), "adjusted_vs_reported");
  assert.equal(dropReason({ field: "2024 EBITDA", interviewValue: "adjusted EBITDA about $780K — seller", documentValue: "$648,891 — statements", severity: "critical" } as any), "adjusted_vs_reported");
  // An open SDE row stays open on the next run (it used to be superseded).
  {
    const rows: any[] = [{ id: "S1", dealId: "D", source: "financial_analysis", status: "open", field: "SDE (2024)", factKey: null, factYear: "2024", interviewValue: "$1,100,000 — Seller interview", documentValue: "$898,000 after add-backs — 2024 recast workbook", severity: "critical", createdAt: new Date(0) }];
    await _persistFinancialDiscrepanciesForTests("D", store(rows), [], [], {}, rows.slice(), {}, undefined, info);
    assert.equal(rows[0].status, "open");
  }
  console.log("✓ F-03: the seller's $1.1M SDE against $898,000 after add-backs is kept (and an open SDE row isn't superseded)");
  console.log("f-analysis-discrepancies: all passed");
})().catch((e) => { console.error(e); process.exit(1); });
