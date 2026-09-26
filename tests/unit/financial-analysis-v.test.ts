/**
 * Financial analysis, round V: broker decisions reach both owner-pay lines,
 * owner-comp conflicts follow the dividend rule, the earnings-text check
 * reads worked sums and never an unrelated figure, the working-capital peg
 * is the multi-year average from the balance sheet, add-backs and questions
 * that rest only on the broker's private material are held back, and a
 * statement line the model cut twice is restored.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/financial-analysis-v.test.ts
 */
import assert from "node:assert/strict";
import {
  applyAddbackRules,
  applyWorkingCapitalRules,
  computeCanonicalEarnings,
  findEarningsMismatches,
  flagEarningsNotes,
  flagEarningsStatements,
  isOwnerCompDiscrepancy,
  ownerPayOnly,
  workingCapitalHistory,
} from "../../server/financial/normalization-rules";
import {
  carryForwardBrokerEdits,
  financialDiscrepancyValues,
  markPrivateMaterial,
  postProcessAnalysis,
  reconcileNetIncome,
  type AnalysisOutput,
} from "../../server/financial/analyzer";
import {
  buildFigureIndex,
  privateOnlyFigures,
  withoutPrivateFigureSentences,
  dealFigureTexts,
} from "../../server/financial/private-figures";
import { buildCimFinancials, renderCimFinancialsBlock } from "../../server/cim/cim-financials";
import type { UiNormalization, UiReclassifiedTable } from "../../server/financial/shape";

const ab = (o: Record<string, unknown>) => ({ id: String(o.label), approved: true, amounts: {}, category: "other", ...o }) as any;
const output = (o: Partial<AnalysisOutput>): AnalysisOutput => ({
  reclassifiedPnl: null, reclassifiedBalanceSheet: null, reclassifiedCashFlow: null, normalization: null,
  workingCapital: null, insights: null, clarifyingQuestions: null, discrepancies: [], clearedDiscrepancyIds: [], aiReasoning: "", ...o,
});

// ── owner-comp-split-escapes-broker-rejection ──
{
  const NI = 896_410;
  // v1 (stored before the split existed): one owner-pay line, rejected by the broker.
  const v1 = {
    version: 1, reclassifiedPnl: null, reclassifiedBalanceSheet: null, reclassifiedCashFlow: null, clarifyingQuestions: null,
    normalization: {
      metric: "sde", years: ["2024"], netIncome: { "2024": NI },
      addbacks: [
        ab({ label: "Owner salary", category: "owner_comp", type: "sde", amounts: { "2024": 180_000 }, approved: false, approvedOverride: true }),
        ab({ label: "Interest", type: "ebitda", amounts: { "2024": 58_000 } }),
      ],
    },
  } as any;
  // v2: the model gives the structured owner line; the rules split it.
  const fresh = postProcessAnalysis(output({
    normalization: {
      metric: "sde", years: ["2024"], netIncome: { "2024": NI },
      addbacks: [
        ab({ label: "Owner salary", category: "owner_comp", ownerActualComp: { "2024": 180_000 }, marketSalary: 125_000, amounts: { "2024": 180_000 } }),
        ab({ label: "Interest", type: "ebitda", amounts: { "2024": 58_000 } }),
      ],
    },
  }));
  assert.equal(fresh.normalization!.addbacks.filter((a) => a.ownerCompPart).length, 2, "split into two lines");
  const carried = carryForwardBrokerEdits(v1, fresh);
  const owner = carried.normalization!.addbacks.filter((a) => a.ownerCompPart);
  for (const line of owner) {
    assert.equal(line.approved, false, `${line.label} carries the broker's rejection`);
    assert.equal(line.approvedOverride, true);
  }
  const c = computeCanonicalEarnings(carried.normalization)!;
  assert.equal(c.sde["2024"], NI + 58_000, "SDE = NI + interest only: the rejected owner pay (both parts) is out");
  assert.equal(c.adjustedEbitda["2024"], NI + 58_000);

  // The model renamed the owner line: one working owner on both sides still matches.
  const renamed = postProcessAnalysis(output({
    normalization: {
      metric: "sde", years: ["2024"], netIncome: { "2024": NI },
      addbacks: [ab({ label: "Owner compensation — Gord McAllister (President)", category: "owner_comp", ownerActualComp: { "2024": 180_000 }, marketSalary: 165_000, amounts: { "2024": 180_000 } })],
    },
  }));
  const c2 = carryForwardBrokerEdits(v1, renamed).normalization!.addbacks;
  assert.ok(c2.every((a) => a.approved === false), "renamed owner lines both carry the rejection");

  // A decision on the market-salary part only speaks for that part.
  const v2split = { ...v1, version: 2, normalization: { ...fresh.normalization!, addbacks: fresh.normalization!.addbacks.map((a) => (a.ownerCompPart === "market" ? { ...a, approved: false, approvedOverride: true } : a)) } };
  const c3 = carryForwardBrokerEdits(v2split, fresh).normalization!.addbacks;
  assert.equal(c3.find((a) => a.ownerCompPart === "market")!.approved, false);
  assert.equal(c3.find((a) => a.ownerCompPart === "excess")!.approved, true, "the excess part stays as the model had it");

  // An approval (not a rejection) also reaches both parts.
  const approvedV1 = { ...v1, normalization: { ...v1.normalization, addbacks: [ab({ label: "Owner salary", category: "owner_comp", type: "sde", amounts: { "2024": 180_000 }, approved: true, approvedOverride: true })] } };
  assert.ok(carryForwardBrokerEdits(approvedV1, fresh).normalization!.addbacks.filter((a) => a.ownerCompPart).every((a) => a.approved && a.approvedOverride));
}

// ── fa-owner-comp-row-still-268k: an owner-comp conflict compares the owner's pay only ──
{
  // The exact stored Ridgeline document side: pay only is the $180,000 T4
  // salary — neither the dividend nor the personal expenses (a separate
  // add-back) — so the panel no longer contradicts the analysis.
  assert.equal(
    ownerPayOnly("$268,000 total (T4 salary $180,000 + T5 dividends $60,000 + personal expenses through company $28,000)"),
    "$180,000 — the owner's pay only (T4 salary $180,000); not counted: T5 dividends $60,000 (a distribution, not pay), personal expenses through company $28,000 (a separate add-back, not pay)",
  );
  assert.equal(ownerPayOnly("$260,000 total owner compensation per seller's add-back list"), null, "a bare total is left as stated");
  assert.equal(ownerPayOnly("$260,000 (salary + dividends) — seller's add-back list"), null, "no amount for the dividend: the seller's claim stays as claimed");
  assert.equal(ownerPayOnly("$180,000 T4 salary; the $60,000 dividend is excluded"), null, "already excluded");
  assert.equal(ownerPayOnly("$180,000 T4 salary — dividends of $60,000 paid separately"), null, "the text keeps the dividend out");
  const once = ownerPayOnly("$240,000 = $180,000 salary + $60,000 dividends")!;
  assert.match(once, /^\$180,000 — the owner's pay only/);
  assert.equal(ownerPayOnly(once), null, "idempotent");
  // Salary written first: the salary is not a total that includes the
  // dividend (round 1 turned each of these into $120,000).
  for (const v of [
    "$180,000 T4 salary and $60,000 in dividends",
    "T4 salary $180,000 plus T5 dividends of $60,000, totalling $240,000",
    "$180,000 salary plus $60,000 dividends = $240,000 total",
    "$180,000 salary (T4) and dividends of $60,000 on Class D shares",
    "T4 salary $180,000; T5 dividends $60,000",
    "$240,000 ($180,000 salary + $60,000 dividends)",
    "$240,000 total owner compensation including $60,000 dividends",
    "$240,000 — T2 2024 (salary $180,000 plus $60,000 Class D dividends)",
  ]) assert.match(ownerPayOnly(v) ?? "", /^\$180,000 — the owner's pay only/, v);
  // Pay components (benefits) stay in; nothing to restate without a non-pay part.
  assert.equal(ownerPayOnly("$150,000 salary + $12,000 benefits = $162,000"), null);
  // "$180,000 management fee" is $180,000, not $180 million.
  assert.match(ownerPayOnly("$180,000 management fee and $60,000 dividends")!, /^\$180,000 /);
  assert.ok(isOwnerCompDiscrepancy("Owner compensation (2024)"));
  assert.ok(isOwnerCompDiscrepancy("Add-back list", "ownerSalary"));
  assert.ok(!isOwnerCompDiscrepancy("Signed backlog (May 2025)", "signedBacklog"));

  // The same reader decides the add-back: a salary-first description on a
  // $180K line has nothing to take out; a folded-in dividend still comes out.
  const n = { metric: "sde" as const, years: ["2024"], netIncome: { "2024": 1_000_000 } };
  const salaryFirst = applyAddbackRules({ ...n, addbacks: [ab({ label: "Owner salary", category: "owner_comp", type: "sde", description: "$180,000 T4 salary and $60,000 in dividends", amounts: { "2024": 180_000 } })] })!;
  assert.equal(salaryFirst.addbacks[0].amounts["2024"], 180_000, "not cut to $120,000");
  assert.ok(!salaryFirst.notes!.some((x) => /included a \$60,000 dividend/.test(x)));
  const folded = applyAddbackRules({ ...n, addbacks: [ab({ label: "Owner salary", category: "owner_comp", type: "sde", description: "$180,000 T4 salary and $60,000 in dividends", amounts: { "2024": 240_000 } })] })!;
  assert.equal(folded.addbacks[0].amounts["2024"], 180_000);
  const including = applyAddbackRules({ ...n, addbacks: [ab({ label: "Owner salary", category: "owner_comp", type: "sde", description: "Owner salary including $60,000 of dividends", amounts: { "2024": 240_000 } })] })!;
  assert.equal(including.addbacks[0].amounts["2024"], 180_000, "an inclusion word with a single amount still takes it out");
}

// ── earnings-flagger-false-and-missed (Lakeshore v2 wording) ──
{
  const computed = {
    reportedEbitda: { "2022": 644_000, "2023": 793_000, "2024": 917_000 },
    adjustedEbitda: { "2022": 843_000, "2023": 1_000_000, "2024": 1_163_000 },
    sde: { "2022": 983_000, "2023": 1_140_000, "2024": 1_303_000 },
    latestYear: "2024",
  };
  const found = (t: string) => findEarningsMismatches(t, computed);
  // Missed before (1% tolerance, worked sums per year):
  assert.deepEqual(found("SDE calculation: 2024: $563,190 + $749,810 = $1,313,000.").map((f) => [f.year, f.label, f.stated, f.expected]), [["2024", "SDE", 1_313_000, 1_303_000]]);
  assert.deepEqual(
    found("Adjusted EBITDA calculation: 2022: $386,174 + $442,826 = $829,000; 2024: $563,190 + $609,810 = $1,173,000.").map((f) => [f.year, f.stated]),
    [["2022", 829_000], ["2024", 1_173_000]],
  );
  assert.deepEqual(found("SDE: 2022 $386,174 + $582,826 = $969,000.").map((f) => f.expected), [983_000]);
  assert.deepEqual(found("SDE grew from $983K in 2022 to $1.31M in 2024.").map((f) => [f.year, f.stated]), [["2024", 1_310_000]], "$1.31M ≠ $1.30M at its own precision");
  // The false flag before: $100K is the owner's pay above market, not EBITDA.
  assert.deepEqual(found("Adjusted EBITDA includes $100,000 of owner pay above the $140,000 market salary."), []);
  assert.deepEqual(found("EBITDA adds back only the $100K excess over market."), []);
  assert.deepEqual(found("Adjusted EBITDA = Net Income + non-owner add-backs + (owner compensation − market salary)."), [], "a definition");
  // Sub-calculations inside parentheses are not the result.
  assert.deepEqual(found("2024 SDE: $563,190 + owner pay ($240,000 − $140,000 = $100,000 above market) + $639,810 = $1,303,000."), []);
  // Figures that tie, at their precision, are left alone.
  assert.deepEqual(found("FY2024 SDE of $1.30M; adjusted EBITDA reached $1,163,000 in 2024."), []);
  assert.deepEqual(found("SDE = adjusted EBITDA $1,163,000 + the $140,000 market salary = $1,303,000 for 2024."), []);
  // Someone else's figure is reported, not stated.
  assert.deepEqual(found("Owner claims ~$1.5M SDE for 2024."), []);
  // A year outside the analysis (a forecast) is never judged.
  assert.deepEqual(found("FY2025 adjusted EBITDA of approximately $1.4M is management's estimate."), []);

  // The EXACT stored Lakeshore v2 notes (vfd2/lake-fa.json): the per-year
  // chains are separate sentences after a "… calculation:" heading.
  const lakeComputed = {
    reportedEbitda: { "2022": 644_000, "2023": 793_000, "2024": 917_000 },
    adjustedEbitda: { "2022": 843_000, "2023": 1_017_000, "2024": 1_163_000 },
    sde: { "2022": 983_000, "2023": 1_157_000, "2024": 1_303_000 },
    latestYear: "2024",
  };
  const lake = (t: string) => findEarningsMismatches(t, lakeComputed).map((f) => `${f.year} ${f.label} ${f.stated} vs ${f.expected}`);
  assert.deepEqual(
    lake("SDE calculation: Net income + all add-backs listed above. 2022: $386,174 + $582,826 = $969,000. 2023: $482,930 + $674,070 = $1,157,000. 2024: $563,190 + $749,810 = $1,313,000."),
    ["2022 SDE 969000 vs 983000", "2024 SDE 1313000 vs 1303000"],
  );
  assert.deepEqual(
    lake("Adjusted EBITDA calculation: Net income + non-owner add-backs + (owner actual comp - market salary). 2022: $386,174 + $362,826 + ($220,000 - $140,000) = $829,000. 2023: $482,930 + $434,070 + ($240,000 - $140,000) = $1,017,000. 2024: $563,190 + $509,810 + ($240,000 - $140,000) = $1,173,000."),
    ["2022 adjusted EBITDA 829000 vs 843000", "2024 adjusted EBITDA 1173000 vs 1163000"],
  );
  assert.deepEqual(
    lake("Owner compensation: Tony Moretti's $220K-$240K salary is above market for the role. A qualified general manager for a $7M+ HVAC/plumbing business in Hamilton would cost approximately $140K all-in (salary, benefits, vehicle allowance). The $100K excess is discretionary owner benefit. For SDE, the full owner salary is added back; for adjusted EBITDA, only the $100K excess is added back."),
    [],
  );
  // A sentence that doesn't open with its year never inherits a metric.
  assert.deepEqual(lake("SDE calculation: see above. Gross profit: $3,100,000 + $200,000 = $3,300,000."), []);

  // Year keys written "FY2025" (both Harbourline versions): still judged.
  const fy = { latestYear: "FY2025", reportedEbitda: { FY2023: 299_000, FY2024: 354_500, FY2025: 411_500 }, adjustedEbitda: { FY2023: 305_000, FY2024: 389_000, FY2025: 418_500 }, sde: { FY2023: 511_000, FY2024: 599_000, FY2025: 627_000 } };
  const fyFound = (t: string) => findEarningsMismatches(t, fy).map((f) => `${f.year} ${f.label} ${f.stated} vs ${f.expected}`);
  assert.deepEqual(fyFound("FY2025 SDE: Net Income $362,500 + Owner Salary $180,000 + Owner Vehicle $15,000 + Depreciation $49,000 + Discretionary Marketing $13,500 = $620,000."), ["FY2025 SDE 620000 vs 627000"]);
  assert.deepEqual(fyFound("SDE for FY2024 of $540,000."), ["FY2024 SDE 540000 vs 599000"]);
  assert.deepEqual(fyFound("Adjusted EBITDA in 2025 was $380,000."), ["FY2025 adjusted EBITDA 380000 vs 418500"]);
  assert.deepEqual(fyFound("SDE of $627,000 in FY2025."), []);
  assert.deepEqual(fyFound("FY2026 SDE of $700,000 is the seller's forecast."), [], "a year outside the analysis");

  // A labelled first term is a term, not a statement of the metric.
  const lab = { reportedEbitda: { "2024": 1_000_000 }, adjustedEbitda: { "2024": 1_100_000 }, sde: { "2024": 1_697_000 }, latestYear: "2024" };
  const labFound = (t: string) => findEarningsMismatches(t, lab).map((f) => `${f.year} ${f.label} ${f.stated}`);
  assert.deepEqual(labFound("SDE 2024: $896,410 net income + $800,590 add-backs = $1,697,000."), []);
  assert.deepEqual(labFound("2024 SDE = $896,410 net income + $800,590 add-backs = $1,697,000."), []);
  assert.deepEqual(labFound("2024 SDE = $896,410 net income + $800,590 add-backs = $1,700,000."), ["2024 SDE 1700000"], "the result is still judged");
  assert.deepEqual(labFound("Adjusted EBITDA was $1,100,000; SDE = $1,100,000 + $597,000 = $1,697,000."), [], "a statement before a chain is still read");
  assert.deepEqual(labFound("Adjusted EBITDA was $1,150,000; SDE = $1,100,000 + $597,000 = $1,697,000."), ["2024 adjusted EBITDA 1150000"]);

  // End to end: the note check and the insight check use the same reader.
  const n: UiNormalization = {
    metric: "sde", years: ["2024"], netIncome: { "2024": 563_190 },
    addbacks: [ab({ label: "Owner pay", category: "owner_comp", ownerActualComp: { "2024": 240_000 }, marketSalary: 140_000, amounts: { "2024": 240_000 } }), ab({ label: "Depreciation", type: "ebitda", amounts: { "2024": 499_810 } })],
    notes: ["SDE calculation: 2024: $563,190 + $749,810 = $1,313,000.", "Adjusted EBITDA includes $100,000 of owner pay above market."],
  };
  const ruled = applyAddbackRules(n)!;
  const flagged = flagEarningsNotes(ruled)!;
  const checks = flagged.notes!.filter((x) => x.startsWith("Check:"));
  assert.equal(checks.length, 1);
  assert.match(checks[0], /states 2024 SDE as \$1,313,000; the add-backs listed here compute \$1,303,000/);
  const { insights } = flagEarningsStatements({ positive: [{ id: "i", type: "positive", title: "Earnings growth", detail: "SDE grew to $1.31M in 2024." }], negative: [] }, ruled);
  assert.match(insights!.positive[0].detail, /computes 2024 SDE as \$1,303,000, not \$1,310,000/);
}

// ── peg-rule-evaded: the peg is the multi-year average from the balance sheet ──
{
  // Ridgeline's reclassified balance sheet (bible: NWC 1,072,000 / 1,152,000 / 1,237,000).
  const bs: UiReclassifiedTable = {
    years: ["2022", "2023", "2024"],
    rows: [
      { id: "1", name: "Cash and deposits", category: "Current Assets", values: { "2022": 164_630, "2023": 431_720, "2024": 642_130 } },
      { id: "2", name: "Accounts receivable (incl. holdbacks)", category: "Current Assets", values: { "2022": 1_268_000, "2023": 1_392_000, "2024": 1_486_000 } },
      { id: "3", name: "Contract assets", category: "Current Assets", values: { "2022": 171_000, "2023": 196_000, "2024": 238_000 } },
      { id: "4", name: "Inventory", category: "Current Assets", values: { "2022": 486_000, "2023": 512_000, "2024": 544_000 } },
      { id: "5", name: "Prepaid expenses & deposits", category: "Current Assets", values: { "2022": 38_000, "2023": 41_000, "2024": 46_000 } },
      { id: "6", name: "Accounts payable & accrued liabilities", category: "Current Liabilities", values: { "2022": 712_000, "2023": 781_000, "2024": 842_000 } },
      { id: "7", name: "Contract liabilities", category: "Current Liabilities", values: { "2022": 118_000, "2023": 142_000, "2024": 164_000 } },
      { id: "8", name: "Income taxes payable", category: "Current Liabilities", values: { "2022": 21_000, "2023": 29_000, "2024": 38_000 } },
      { id: "9", name: "Government remittances payable", category: "Current Liabilities", values: { "2022": 61_000, "2023": 66_000, "2024": 71_000 } },
      { id: "10", name: "Current portion of long-term debt", category: "Current Liabilities", values: { "2022": 262_000, "2023": 274_000, "2024": 286_000 } },
      { id: "11", name: "Long-term debt", category: "Long-Term Liabilities", values: { "2022": 1_342_000, "2023": 1_068_000, "2024": 624_000 } },
    ],
  };
  assert.deepEqual(workingCapitalHistory(bs), { "2022": 1_072_000, "2023": 1_152_000, "2024": 1_237_000 });
  const wc = applyWorkingCapitalRules({
    asOfPeriod: "2024-12-31",
    currentAssets: [{ name: "Accounts receivable", amount: 1_486_000 }, { name: "Contract assets", amount: 238_000 }, { name: "Inventory", amount: 544_000 }, { name: "Prepaid expenses", amount: 46_000 }],
    currentLiabilities: [{ name: "Accounts payable", amount: 842_000 }, { name: "Contract liabilities", amount: 164_000 }, { name: "Government remittances payable", amount: 71_000 }],
    netWorkingCapital: 1_237_000,
    pegAmount: 1_290_000,
    targetNwc: 1_290_000,
    notes: [
      "Target NWC set at $1,290,000 based on trailing 12-month average plus 10% buffer.",
      "Historical NWC: $1,099,630 (2022), $1,149,720 (2023), $1,237,000 (2024).",
      "Working capital as % of revenue: 12.6% (2024), 13.5% (2023), 14.7% (2022).",
      "Net working capital (NWC) at December 31, 2024 = Current Assets $2,956,130 less Current Liabilities $1,401,000 = $1,555,130.",
    ],
  }, bs)!;
  assert.ok(!wc.notes!.some((x) => /1,555,130/.test(x)), "a year-end NWC that counted the cash goes");
  assert.equal(wc.pegAmount, 1_153_667, "average of 1,072,000 / 1,152,000 / 1,237,000 — no buffer");
  assert.equal(wc.targetNwc, 1_153_667);
  assert.deepEqual(wc.history, { "2022": 1_072_000, "2023": 1_152_000, "2024": 1_237_000 });
  assert.match(wc.pegBasis!, /Average of year-end net working capital, 2022–2024 \(3 balance sheets\)/);
  assert.ok(!wc.notes!.some((x) => /1,290,000|buffer|1,099,630/.test(x)), "the model's buffered peg and misstated history are gone");
  assert.ok(wc.notes!.some((x) => /% of revenue/.test(x)), "unrelated notes stay");
  const pegNote = wc.notes!.find((x) => /^Suggested peg/.test(x))!;
  assert.match(pegNote, /\$1,153,667: the average of year-end net working capital \(2022 \$1,072,000, 2023 \$1,152,000, 2024 \$1,237,000\)/);
  assert.ok(!wc.notes!.some((x) => /has been replaced|was shown as the peg/.test(x)), "no correction-log wording");
  // Idempotent.
  assert.deepEqual(applyWorkingCapitalRules(wc, bs), wc);

  // Lakeshore: a $300,000 peg next to a $301,000 closing balance → the 3-year average.
  const lake: UiReclassifiedTable = {
    years: ["2022", "2023", "2024"],
    rows: [
      { id: "c", name: "Cash and deposits", category: "Current Assets", values: { "2022": 837_274, "2023": 996_204, "2024": 1_117_394 } },
      { id: "a", name: "Accounts receivable", category: "Current Assets", values: { "2022": 412_000, "2023": 468_000, "2024": 505_000 } },
      { id: "i", name: "Inventory", category: "Current Assets", values: { "2022": 318_000, "2023": 342_000, "2024": 361_000 } },
      { id: "p", name: "Prepaid expenses", category: "Current Assets", values: { "2022": 38_000, "2023": 42_000, "2024": 47_000 } },
      { id: "ap", name: "Accounts payable and accrued liabilities", category: "Current Liabilities", values: { "2022": 356_000, "2023": 389_000, "2024": 402_000 } },
      { id: "h", name: "HST payable", category: "Current Liabilities", values: { "2022": 61_000, "2023": 68_000, "2024": 74_000 } },
      { id: "t", name: "Income taxes payable", category: "Current Liabilities", values: { "2022": 12_000, "2023": 18_000, "2024": 29_000 } },
      { id: "d", name: "Deferred revenue", category: "Current Liabilities", values: { "2022": 94_000, "2023": 118_000, "2024": 136_000 } },
      { id: "cp", name: "Current portion of long-term debt", category: "Current Liabilities", values: { "2022": 136_000, "2023": 145_000, "2024": 162_000 } },
    ],
  };
  // The model's items include cash; the latest year ties back to the balance sheet.
  const lw = applyWorkingCapitalRules({
    asOfPeriod: "2024-12-31",
    currentAssets: [{ name: "Cash", amount: 1_117_394 }, { name: "Accounts receivable", amount: 505_000 }, { name: "Inventory", amount: 361_000 }],
    currentLiabilities: [{ name: "Accounts payable", amount: 402_000 }],
    netWorkingCapital: 1_581_394, pegAmount: 300_000, targetNwc: 300_000,
    notes: ["Three-year average NWC: ($301K + $277K + $257K) / 3 = $278,333. Suggested peg at $300K (rounded, conservative)."],
  }, lake)!;
  assert.equal(lw.netWorkingCapital, 301_000, "the 2024 lines come from the balance sheet");
  assert.equal(lw.currentAssets.length, 3);
  assert.equal(lw.pegAmount, 278_333);
  assert.ok(lw.notes!.some((x) => /lines are taken from the balance sheet/.test(x)));
  // Notes that give the right year-end figure with its components, or merely
  // say "cushion", are kept; only peg notes and misstated year-ends go.
  const kept = applyWorkingCapitalRules({
    asOfPeriod: "2024-12-31",
    currentAssets: [{ name: "Accounts receivable", amount: 505_000 }, { name: "Inventory", amount: 361_000 }, { name: "Prepaid expenses", amount: 47_000 }],
    currentLiabilities: [{ name: "Accounts payable", amount: 402_000 }, { name: "HST payable", amount: 74_000 }, { name: "Deferred revenue", amount: 136_000 }],
    netWorkingCapital: 301_000,
    notes: [
      "NWC Dec 31 2023: ($468K + $342K + $42K) - ($389K + $68K + $118K) = $277,000.",
      "Deferred revenue ($136K) is prepaid Comfort Club fees and provides a cash cushion.",
      "NWC Dec 31 2022: ($412K + $318K + $38K) - ($356K + $61K + $94K) = $262,000.",
    ],
  }, lake)!;
  assert.ok(kept.notes!.some((x) => /= \$277,000/.test(x)), "a correct year-end with its components stays");
  assert.ok(kept.notes!.some((x) => /cash cushion/.test(x)));
  assert.ok(!kept.notes!.some((x) => /\$262,000/.test(x)), "a misstated year-end goes (the balance sheet says $257,000)");

  // Contra and opposite balances keep their sign (never Math.abs per row):
  // an allowance reduces current assets, a net HST receivable filed under
  // liabilities reduces liabilities — as the balance-sheet table sums them.
  const contra: UiReclassifiedTable = {
    years: ["2023", "2024"],
    rows: [
      { id: "1", category: "Current Assets", name: "Accounts receivable", values: { "2023": 480_000, "2024": 500_000 } },
      { id: "2", category: "Current Assets", name: "Allowance for doubtful accounts", values: { "2023": -18_000, "2024": -20_000 } },
      { id: "3", category: "Current Assets", name: "Inventory", values: { "2023": 290_000, "2024": 300_000 } },
      { id: "4", category: "Current Liabilities", name: "Accounts payable", values: { "2023": 240_000, "2024": 250_000 } },
      { id: "5", category: "Current Liabilities", name: "HST payable (receivable)", values: { "2023": 12_000, "2024": -15_000 } },
    ],
  };
  assert.deepEqual(workingCapitalHistory(contra), { "2023": 500_000, "2024": 545_000 });
  const signed = applyWorkingCapitalRules({
    asOfPeriod: "2024-12-31",
    currentAssets: [{ name: "Accounts receivable (net of allowance)", amount: 480_000 }, { name: "Inventory", amount: 300_000 }],
    currentLiabilities: [{ name: "Accounts payable", amount: 250_000 }, { name: "HST (net receivable)", amount: -15_000 }],
    netWorkingCapital: 545_000, pegAmount: null, targetNwc: null, notes: [],
  }, contra)!;
  assert.equal(signed.netWorkingCapital, 545_000, "the model's correctly signed lines stay");
  assert.equal(signed.currentLiabilities.length, 2);
  assert.ok(!signed.notes!.some((x) => /taken from the balance sheet/.test(x)));
  assert.equal(signed.pegAmount, 522_500);
  // SariKnotSari v4 (a real business): a debit "Gift Card Liabilities −57,168".
  const sari: UiReclassifiedTable = {
    years: ["2024"],
    rows: [
      { id: "c", category: "Current Assets", name: "Cash and Deposits", values: { "2024": 91_402 } },
      { id: "i", category: "Current Assets", name: "Inventory", values: { "2024": 71_712 } },
      { id: "p", category: "Current Assets", name: "Prepaid Expenses", values: { "2024": 57_168 } },
      { id: "o", category: "Current Assets", name: "Other Current Assets", values: { "2024": 8_402 } },
      { id: "ap", category: "Current Liabilities", name: "Accounts Payable", values: { "2024": 120 } },
      { id: "cc", category: "Current Liabilities", name: "Credit Card Payable", values: { "2024": 4_351 } },
      { id: "tx", category: "Current Liabilities", name: "Taxes Payable", values: { "2024": -755 } },
      { id: "ed", category: "Current Liabilities", name: "Employee Deductions Payable", values: { "2024": 1_007 } },
      { id: "gc", category: "Current Liabilities", name: "Gift Card Liabilities", values: { "2024": -57_168 } },
      { id: "sh", category: "Current Liabilities", name: "Due to Shareholders", values: { "2024": 17_849 } },
    ],
  };
  assert.deepEqual(workingCapitalHistory(sari), { "2024": 189_727 }, "≈ the analysis's own $189.5K, not $73,881");
  // A liabilities section written negative throughout is turned round as a
  // whole: its one positive (contra) row still counts against it.
  const negConv: UiReclassifiedTable = {
    years: ["2024"],
    rows: [
      { id: "a", category: "Current Assets", name: "Accounts receivable", values: { "2024": 500_000 } },
      { id: "l1", category: "Current Liabilities", name: "Accounts payable", values: { "2024": -250_000 } },
      { id: "l2", category: "Current Liabilities", name: "Accrued liabilities", values: { "2024": -50_000 } },
      { id: "l3", category: "Current Liabilities", name: "HST receivable (net)", values: { "2024": 15_000 } },
    ],
  };
  assert.deepEqual(workingCapitalHistory(negConv), { "2024": 215_000 });

  // One balance sheet: no peg.
  const one = applyWorkingCapitalRules({ currentAssets: [{ name: "AR", amount: 500 }], currentLiabilities: [{ name: "AP", amount: 100 }], netWorkingCapital: 400, pegAmount: 420 },
    { years: ["2024"], rows: [{ id: "a", name: "AR", category: "Current Assets", values: { "2024": 500 } }, { id: "b", name: "AP", category: "Current Liabilities", values: { "2024": 100 } }] })!;
  assert.equal(one.pegAmount, null);
  assert.ok(one.notes!.some((x) => /only the 2024 year-end balance sheet/.test(x)));
  // No balance sheet at all: a buffered peg is not kept.
  const buf = applyWorkingCapitalRules({ currentAssets: [{ name: "AR", amount: 900 }], currentLiabilities: [], netWorkingCapital: 900, pegAmount: 1_000, notes: ["Peg set at the average plus a 10% buffer."] })!;
  assert.equal(buf.pegAmount, null);
  // The CIM block carries the history and the basis.
  const block = renderCimFinancialsBlock(buildCimFinancials({ id: "x", version: 3, status: "completed", brokerReviewedAt: null, workingCapital: wc } as any));
  assert.match(block, /Year-end net working capital: 2022 \$1,072,000 · 2023 \$1,152,000 · 2024 \$1,237,000/);
  assert.match(block, /Working capital peg \(target\): \$1,153,667 — Average of year-end net working capital/);
}

// ── analysis-private-context-into-cim-bridge ──
{
  const index = buildFigureIndex(
    ["T2 2024: vehicle expenses 63,000; management salary 180,000; net income 896,410", "Seller email: truck & personal expenses $28,000"],
    ["CRM note: owner runs ~$40K of personal vehicle costs through the company; boat slip $14,600/yr. Replacement GM ~165K."],
  );
  const fresh = postProcessAnalysis(output({
    normalization: {
      metric: "sde", years: ["2024"], netIncome: { "2024": 896_410 },
      addbacks: [
        ab({ label: "Owner personal vehicle costs", category: "discretionary", type: "ebitda", amounts: { "2024": 40_000 } }),
        ab({ label: "Boat slip (personal)", category: "discretionary", type: "ebitda", amounts: { "2024": 14_600 } }),
        ab({ label: "Owner personal expenses", category: "discretionary", type: "ebitda", amounts: { "2024": 28_000 } }),
        ab({ label: "Owner salary", category: "owner_comp", ownerActualComp: { "2024": 180_000 }, marketSalary: 165_000, amounts: { "2024": 180_000 } }),
        ab({ label: "Golf dues", category: "discretionary", type: "ebitda", amounts: { "2024": 9_200 } }),
      ],
    },
    clarifyingQuestions: [
      { id: "q1", severity: "high", status: "pending", question: "The owner's vehicle costs of about $40K don't appear as a separate line. Where are they booked?" },
      { id: "q2", severity: "medium", status: "pending", question: "Can you confirm the $28,000 of personal expenses?" },
    ],
    privateAddbackLabels: ["Golf dues"],
  }));
  const marked = markPrivateMaterial(fresh, index);
  const byLabel = (l: string) => marked.normalization!.addbacks.find((a) => a.label === l)!;
  assert.equal(byLabel("Owner personal vehicle costs").privateEvidence, true, "$40K only in a CRM note");
  assert.equal(byLabel("Owner personal vehicle costs").approved, false);
  assert.equal(byLabel("Boat slip (personal)").privateEvidence, true);
  assert.equal(byLabel("Golf dues").privateEvidence, true, "the model said evidence: private");
  assert.ok(!byLabel("Owner personal expenses").privateEvidence, "$28,000 is in the seller's email");
  assert.ok(marked.normalization!.addbacks.filter((a) => a.ownerCompPart).every((a) => !a.privateEvidence && a.approved), "owner pay rests on the T2 ($180K); the market salary is the analysis's own estimate");
  assert.ok(marked.normalization!.notes!.some((x) => /rests only on your private notes/.test(x)));
  // Out of the canonical figures, and out of the CIM bridge until the broker approves.
  const c = computeCanonicalEarnings(marked.normalization)!;
  assert.equal(c.adjustedEbitda["2024"], 896_410 + 28_000 + 15_000);
  const bridgeLabels = (norm: UiNormalization) => buildCimFinancials({ id: "a", version: 2, status: "completed", brokerReviewedAt: null, normalization: norm } as any)!.bridge!.addbacks.map((a) => a.label);
  assert.ok(!bridgeLabels(marked.normalization!).some((l) => /vehicle costs|Boat|Golf/.test(l)));
  // Defence in depth: approved but not by the broker → still out of the bridge.
  const sneaky = { ...marked.normalization!, addbacks: marked.normalization!.addbacks.map((a) => (a.privateEvidence ? { ...a, approved: true } : a)) };
  assert.ok(!bridgeLabels(sneaky).some((l) => /vehicle costs|Boat|Golf/.test(l)));
  // The broker approves one: it counts, and a re-run keeps it.
  const approved = { ...marked.normalization!, addbacks: marked.normalization!.addbacks.map((a) => (a.label === "Boat slip (personal)" ? { ...a, approved: true, approvedOverride: true } : a)) };
  assert.ok(bridgeLabels(approved).includes("Boat slip (personal)"));
  const rerun = carryForwardBrokerEdits({ version: 2, reclassifiedPnl: null, reclassifiedBalanceSheet: null, reclassifiedCashFlow: null, clarifyingQuestions: null, normalization: approved } as any, markPrivateMaterial(fresh, index));
  const boat = rerun.normalization!.addbacks.find((a) => a.label === "Boat slip (personal)")!;
  assert.equal(boat.approved, true);
  assert.equal(boat.approvedOverride, true);

  // ── clarifying-question-quotes-private-figure ──
  const q1 = marked.clarifyingQuestions!.find((q) => q.id === "q1")!;
  assert.deepEqual(q1.privateFigures, ["$40k"]);
  assert.ok(!marked.clarifyingQuestions!.find((q) => q.id === "q2")!.privateFigures, "$28,000 is shared");
  assert.equal(
    withoutPrivateFigureSentences("The owner's vehicle costs of about $40K don't appear as a separate line. Where are they booked?", index),
    "Where are they booked?",
  );
  assert.deepEqual(privateOnlyFigures("The market salary is $165,000.", index), ["$165,000"]);
  assert.deepEqual(privateOnlyFigures("Net income was $896,410 in 2024 (15% margin).", index), [], "shared figures, years and round percentages are not private");
  // Discrepancy text that may reach the seller drops a private-only figure.
  const v = financialDiscrepancyValues(
    {
      field: "Owner vehicle costs", sourceA: { source: "Seller interview", value: "about $20,000" }, sourceB: { source: "2024 T2", value: "$63,000 vehicle expenses", documentId: "11111111-1111-1111-1111-111111111111" },
      severity: "significant", category: "financial",
      explanation: "The seller says about $20,000 is personal. An earlier estimate put it at $40K.", suggestedResolution: "Ask the seller how the $63,000 splits.",
    },
    { "11111111-1111-1111-1111-111111111111": "2024 T2" },
    { "11111111-1111-1111-1111-111111111111": { kind: "document", brokerOnly: false } },
    index,
  );
  assert.equal(v.aiExplanation, "The seller says about $20,000 is personal.");
  assert.equal(v.suggestedResolution, "Ask the seller how the $63,000 splits.");

  // A coincidental shared amount about something else is not support (the
  // round-1 check failed open on round figures: 13 of 25 typical CRM amounts
  // found some shared figure within 0.5% on Ridgeline).
  const ridge = buildFigureIndex(
    [
      "T5 slips: dividends Class D 2022: $40,000; 2023: $60,000; 2024: $60,000",
      "Balance sheet 2022\nCash and deposits 164,630\nAccounts receivable 1,268,000",
      "Operating expenses 2024: utilities $71,000, vehicle expenses $63,000, computer & software $22,000",
      "Crane rebuild (one-time) $64,000 in 2024",
      "management salary 180,000",
    ],
    ["CRM note: owner runs ~$40K of personal vehicle costs through the company. Replacement GM ~165K. Donna's SUV lease $11,340 a year; cabin costs $8,275."],
  );
  const vehicle = postProcessAnalysis(output({
    normalization: {
      metric: "sde", years: ["2024"], netIncome: { "2024": 896_410 },
      addbacks: [
        ab({ label: "Owner personal vehicle costs", category: "discretionary", type: "ebitda", amounts: { "2024": 40_000 } }),
        ab({ label: "Crane rebuild (one-time)", category: "one_time", type: "ebitda", amounts: { "2024": 64_000 } }),
        ab({ label: "Computer & software upgrade", category: "one_time", type: "ebitda", amounts: { "2024": 22_000 } }),
      ],
    },
  }));
  const vm = markPrivateMaterial(vehicle, ridge).normalization!.addbacks;
  assert.equal(vm.find((a) => /vehicle/.test(a.label))!.privateEvidence, true, "the 2022 $40,000 dividend is not support for $40K of vehicle costs");
  assert.equal(vm.find((a) => /vehicle/.test(a.label))!.approved, false);
  assert.ok(!vm.find((a) => /Crane/.test(a.label))!.privateEvidence);
  assert.ok(!vm.find((a) => /Computer/.test(a.label))!.privateEvidence, "not private: the private notes don't state $22,000");
  const bridge = buildCimFinancials({ id: "a", version: 2, status: "completed", brokerReviewedAt: null, normalization: markPrivateMaterial(vehicle, ridge).normalization } as any)!.bridge!.addbacks.map((a) => a.label);
  assert.ok(!bridge.some((l) => /vehicle/.test(l)) && bridge.some((l) => /Crane/.test(l)), "the private line stays out of the CIM bridge");
  // A $165,000 figure quoted in a question: a $164,630 cash balance is not support.
  assert.deepEqual(privateOnlyFigures("The owner's compensation of $165,000 doesn't appear in the statements — where is it booked?", ridge), ["$165,000"]);
  assert.equal(
    withoutPrivateFigureSentences("The owner's compensation of $165,000 doesn't appear in the statements. Where is the owner's pay booked in the general ledger?", ridge),
    "Where is the owner's pay booked in the general ledger?",
  );
  // Shared figures about the same thing stay shared even when a private note repeats them.
  const echo = buildFigureIndex(["Crane rebuild (one-time) $64,000 in 2024", "management salary 180,000"], ["CRM: crane rebuild ~$64K; owner salary 180K"]);
  assert.deepEqual(privateOnlyFigures("Was the $64,000 crane rebuild in 2024 a one-time repair?", echo), []);
  assert.deepEqual(privateOnlyFigures("Is the owner's $180,000 salary the full T4 amount?", echo), []);
  // The very same non-round amount anywhere shared is support.
  assert.deepEqual(privateOnlyFigures("The lease costs $11,340 a year.", buildFigureIndex(["GL 6120 11,340.00"], ["CRM: SUV lease $11,340"])), []);

  // The deal's shared vs private material: broker-only files and CRM-only facts are private.
  const texts = dealFigureTexts(
    [
      { id: "d1", visibility: "shared", sourceKind: "document", extractedText: "Revenue 9,815,000" },
      { id: "d2", visibility: "broker_only", sourceKind: "crm", extractedText: "Ask 6.5M" },
    ],
    { askingPrice: "$6,500,000", _fieldSources: { askingPrice: { source: "crm", documentId: "d2", brokerOnly: true } }, revenue: "$9,815,000" },
    null,
  );
  assert.ok(texts.private.some((t) => /6,500,000/.test(t)) && texts.private.some((t) => /6\.5M/.test(t)));
  assert.ok(texts.shared.some((t) => /9,815,000/.test(t)) && !texts.shared.some((t) => /6,500,000/.test(t)));
}

// ── Pacific: a line cut for a carve-out the statement already lists separately is restored ──
{
  const pnl: UiReclassifiedTable = {
    years: ["2024"],
    rows: [
      { id: "r", name: "Revenue", category: "Revenue", values: { "2024": 31_020_000 } },
      { id: "c", name: "Direct operating costs", category: "COGS", values: { "2024": 21_706_300 } },
      { id: "it", name: "Office, IT & software subscriptions", category: "Operating Expenses", values: { "2024": 246_000 } },
      { id: "o", name: "Other G&A", category: "Operating Expenses", values: { "2024": 5_448_500 - 55_000 - 72_000 } },
      { id: "tms", name: "TMS migration consultants (one-time)", category: "Non-Recurring", values: { "2024": 72_000 } },
      { id: "s", name: "Wrongful dismissal settlement (one-time)", category: "Non-Recurring", values: { "2024": 55_000 } },
      { id: "d", name: "Amortization", category: "Depreciation", values: { "2024": 1_950_000 } },
      { id: "i", name: "Interest", category: "Interest", values: { "2024": 395_000 } },
      { id: "g", name: "Gain on disposal", category: "Other Income", values: { "2024": 64_000 } },
      { id: "t", name: "Income taxes", category: "Taxes", values: { "2024": 293_240 } },
    ],
  };
  const normalization: UiNormalization = { metric: "ebitda", years: ["2024"], netIncome: { "2024": 972_960 }, addbacks: [] };
  const statements = [{
    statementType: "income_statement" as const, periods: ["2024"], currency: "CAD", sourceDocumentId: "fs24", sourceDocumentName: "Financial statements FY2024", confidence: 0.9, notes: [],
    lineItems: [
      { label: "Office, IT & software subscriptions", amounts: { "2024": 318_000 }, category: "operating_expenses" },
      { label: "Systems implementation (TMS migration)", amounts: { "2024": 72_000 }, category: "operating_expenses" },
      { label: "Total general & administrative", amounts: { "2024": 5_766_500 }, category: "operating_expenses", isTotal: true },
    ],
  }];
  const out = reconcileNetIncome(pnl, normalization, statements);
  const it = out.pnl!.rows.find((r) => r.id === "it")!;
  assert.equal(it.values["2024"], 318_000, "restored to the statement amount");
  assert.ok(out.pnl!.notes!.some((x) => /Office, IT & software subscriptions \(2024\) is shown at \$318,000, its amount on the Financial statements FY2024/.test(x)));
  assert.ok(!out.pnl!.notes!.some((x) => /does not tie/.test(x)), "net income now ties");
  // No statement line explains the gap → flagged, nothing changed.
  const untouched = reconcileNetIncome(pnl, normalization, []);
  assert.equal(untouched.pnl!.rows.find((r) => r.id === "it")!.values["2024"], 246_000);
  assert.ok(untouched.pnl!.notes!.some((x) => /does not tie/.test(x)));
}

console.log("financial-analysis-v: ok");
