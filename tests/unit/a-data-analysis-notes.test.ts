// ACC2-08: the Ridgeline analysis' free-text notes carried a wrong-period
// debt figure ("Long-term debt of $1,342,000 (Dec 31 2024)" — the FY2022
// balance), a net-income tie note (rows 936,410 vs reported 896,410,
// +40,000) and a note calling the adjusted EBITDA "SDE" (the check then
// said "states 2024 SDE as $1,552,000; the add-backs compute $1,717,000").
// The structured numbers (SDE 1,717,000, adjusted EBITDA 1,552,000) were
// right. Replayed with the recorded figures.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/a-data-analysis-notes.test.ts
import assert from "node:assert/strict";
import { correctBalanceSheetFigures } from "../../server/financial/note-figures";
import { reconcileNetIncome, excludedCarveOutRepair, finalizeEarnings } from "../../server/financial/analyzer";
import { flagEarningsNotes, computeCanonicalEarnings } from "../../server/financial/normalization-rules";
import { computePnlNetIncome } from "../../server/financial/shape";

const bs: any = {
  years: ["2022", "2023", "2024"],
  rows: [
    { id: "b1", name: "Cash", category: "Current Assets", values: { "2022": 164630, "2023": 431720, "2024": 642130 } },
    { id: "b2", name: "Current portion of long-term debt", category: "Current Liabilities", values: { "2022": 262000, "2023": 274000, "2024": 286000 } },
    { id: "b3", name: "Long-term debt", category: "Long-Term Liabilities", values: { "2022": 1342000, "2023": 1068000, "2024": 624000 } },
  ],
};

// 1. A figure from another year's column is corrected to the named year's.
{
  const r = correctBalanceSheetFigures("Debt: Long-term debt of $1,342,000 (Dec 31 2024), with a term loan maturing November 2027.", bs);
  assert.equal(r.text, "Debt: Long-term debt of $624,000 (Dec 31 2024), with a term loan maturing November 2027.");
  assert.deepEqual(r.corrections, [{ stated: "$1,342,000", year: "2024", belongsTo: "2022", corrected: "$624,000" }]);
  for (const ok of [
    "Long-term debt of $624,000 (Dec 31 2024).",
    "Long-term debt was $1,342,000 in 2022 and fell to $624,000 by 2024.",
    "Long-term debt of $1,342,000 (Dec 31 2022).",
    "Long-term debt of about $900,000 including vehicle loans (2024).",
    "Cash of $642,130 as at December 31, 2024.",
  ]) assert.equal(correctBalanceSheetFigures(ok, bs).text, ok, `left alone: ${ok}`);
  assert.equal(correctBalanceSheetFigures("Cash of $431,720 as at December 31, 2024.", bs).text, "Cash of $642,130 as at December 31, 2024.");
  console.log("✓ a balance from the wrong year's column is corrected; right, other-year and unknown figures are left");
}

// 2. Net income: Excluded carve-outs that nothing deducts are counted as expenses again.
{
  const pnl: any = {
    years: ["2023", "2024"],
    rows: [
      { id: "r1", name: "Revenue", category: "Revenue", values: { "2023": 9160000, "2024": 9815000 } },
      { id: "r2", name: "Cost of sales", category: "COGS", values: { "2023": 6420000, "2024": 6868000 } },
      { id: "r3", name: "Gross profit", category: "Excluded", values: { "2023": 2740000, "2024": 2947000 } },
      { id: "r4", name: "Operating expenses (less owner's personal items)", category: "Operating Expenses", values: { "2023": 1390910, "2024": 1509000 } },
      { id: "r5", name: "Owner's truck + personal vehicle expenses", category: "Excluded", values: { "2024": 28000 } },
      { id: "r6", name: "Junior hockey sponsorship", category: "Excluded", values: { "2024": 12000 } },
      { id: "r7", name: "Amortization", category: "Depreciation", values: { "2023": 286000, "2024": 312000 } },
      { id: "r8", name: "Interest", category: "Interest", values: { "2023": 66000, "2024": 58000 } },
      { id: "r9", name: "Income taxes", category: "Taxes", values: { "2023": 218000, "2024": 131590 } },
    ],
  };
  const normalization: any = { years: ["2023", "2024"], netIncome: { "2023": 779090, "2024": 896410 }, addbacks: [], notes: [] };
  assert.equal(computePnlNetIncome(pnl)["2024"], 936410, "the recorded +40,000 gap");
  const fix = excludedCarveOutRepair(pnl, [{ year: "2024", delta: 40000, reported: 896410 }]);
  assert.deepEqual(fix?.labels, ["Owner's truck + personal vehicle expenses", "Junior hockey sponsorship"]);
  const out = reconcileNetIncome(pnl, normalization);
  assert.equal(computePnlNetIncome(out.pnl)["2024"], 896410);
  assert.ok(!(out.normalization!.notes ?? []).some((n: string) => /does not tie/.test(n)), "no 'does not tie' note");
  assert.ok((out.normalization!.notes ?? []).some((n: string) => /now ties/.test(n)));
  assert.equal(out.pnl!.rows.find((r: any) => r.id === "r3")!.category, "Excluded", "subtotals stay excluded");
  // A broker's own Excluded choice is never flipped.
  const locked = { ...pnl, rows: pnl.rows.map((r: any) => (r.id === "r5" ? { ...r, categoryOverride: true } : r)) };
  assert.equal(excludedCarveOutRepair(locked, [{ year: "2024", delta: 40000, reported: 896410 }]), null);
  console.log("✓ rows high by exactly the Excluded carve-outs: counted again, the tie note is gone");
}

// 3. A right figure under the other metric's name is renamed, not questioned.
{
  const n: any = {
    years: ["2024"],
    netIncome: { "2024": 896410 },
    addbacks: [
      { id: "a1", label: "Income taxes", category: "other", amounts: { "2024": 131590 }, approved: true, type: "ebitda" },
      { id: "a2", label: "Interest", category: "other", amounts: { "2024": 58000 }, approved: true, type: "ebitda" },
      { id: "a3", label: "Amortization", category: "other", amounts: { "2024": 312000 }, approved: true, type: "ebitda" },
      { id: "a4", label: "Owner pay above a market salary", category: "owner_comp", amounts: { "2024": 154000 }, approved: true, type: "ebitda" },
      { id: "a5", label: "Owner — market salary", category: "owner_comp", amounts: { "2024": 165000 }, approved: true, type: "sde" },
    ],
    notes: ["Normalized 2024 SDE: $1,552,000, after the non-recurring items."],
  };
  const c = computeCanonicalEarnings(n)!;
  assert.equal(c.adjustedEbitda["2024"], 1552000);
  assert.equal(c.sde["2024"], 1717000);
  const out = flagEarningsNotes(n)!;
  assert.deepEqual(out.notes, ["Normalized 2024 adjusted EBITDA: $1,552,000, after the non-recurring items."]);
  // A figure that is neither metric is corrected to the computed one (round F: prose that ties).
  const wrong = flagEarningsNotes({ ...n, notes: ["2024 SDE of $1,900,000."] })!;
  assert.deepEqual(wrong.notes, ["2024 SDE of $1,717,000."]);
  // With no year and nowhere near any year's figure, it keeps its check line.
  const unplaced = flagEarningsNotes({ ...n, notes: ["SDE of $3,900,000."] })!;
  assert.ok(unplaced.notes!.some((x: string) => /^Check: the note above states 2024 SDE as \$3,900,000; the add-backs listed here compute \$1,717,000\./.test(x)));
  console.log("✓ '2024 SDE $1,552,000' (the adjusted EBITDA) is renamed; a wrong figure is corrected; one the code can't place is still checked");
}

// 4. Through finalizeEarnings (the analysis' last step).
{
  const result: any = {
    reclassifiedPnl: null,
    reclassifiedBalanceSheet: bs,
    reclassifiedCashFlow: null,
    normalization: { years: ["2024"], netIncome: { "2024": 896410 }, addbacks: [], notes: ["Debt: Long-term debt of $1,342,000 (Dec 31 2024)."] },
    workingCapital: null,
    insights: { positive: [], negative: [{ title: "Debt load", detail: "Long-term debt of $1,342,000 (Dec 31 2024) is being paid down." }] },
    clarifyingQuestions: [],
    discrepancies: [],
    clearedDiscrepancyIds: [],
    aiReasoning: "",
  };
  const out = finalizeEarnings(result);
  assert.equal(out.normalization!.notes![0], "Debt: Long-term debt of $624,000 (Dec 31 2024).");
  assert.equal(out.insights.negative[0].detail, "Long-term debt of $624,000 (Dec 31 2024) is being paid down.");
  console.log("✓ notes and insights leave the analysis with the right year's balance");
}

console.log("a-data-analysis-notes: all passed");
