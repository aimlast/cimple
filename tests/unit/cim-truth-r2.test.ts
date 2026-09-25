/**
 * CIM writer truthfulness, round 2 (QA harvest 2026-09-26, cimgen stream):
 *  - a vague figure on file never vouches for a precise one ("$5M" ≠ $5,440,500)
 *  - tables are reconciled in the writer's normal style (headings, "Total …" rows,
 *    headings that carry amounts), without flagging summary tables
 *  - customer names must be on file as written (not just their first two words)
 *  - long headline facts give the latest actual year (adjusted where given), never the oldest
 *  - an interview fact's year the seller never said is left out of the CIM
 *  - an extractor's working-out never reaches the writer
 *
 * Fixtures: the real Pacific knowledge base the checker's run used and sections from
 * the original (hallucinated) and the checker's generation.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSectionFigures, knownFiguresFrom, nameOnFile, isKnownFigure, parseFigures } from "../../server/cim/figure-check";
import { assembleKnowledgeBase, buildKnowledgeBase, figureConflicts, headlineFigure } from "../../server/cim/layout-engine";
import { buildCimFinancials, renderCimFinancialsBlock } from "../../server/cim/cim-financials";
import { repairInferredYears, hasMonthYear } from "../../server/cim/fact-dates";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cim");
const kbSource = fs.readFileSync(path.join(FIX, "pacific-kb-source.txt"), "utf-8");
const sections = JSON.parse(fs.readFileSync(path.join(FIX, "pacific-sections.json"), "utf-8"));
const known = knownFiguresFrom(kbSource);
const byTitle = (list: any[], t: string) => list.find((s) => s.sectionTitle === t);

// ── 1. Precision: the written figure's rounding only ──
const vague = knownFiguresFrom("Revenue about $5M. EBITDA $3.9M. Net income $2.1 million.");
const fig = (t: string) => parseFigures(t)[0];
assert.equal(isKnownFigure(fig("$5,440,500"), vague), false, "a '$5M' fact never validates $5,440,500");
assert.equal(isKnownFigure(fig("$3,910,000"), vague), false, "a '$3.9M' fact never validates $3,910,000");
assert.equal(isKnownFigure(fig("$4.41M"), knownFiguresFrom("EBITDA roughly $4.4M")), false, "no invented extra digit");
assert.equal(isKnownFigure(fig("$3.9M"), knownFiguresFrom("EBITDA $3,897,000")), true, "rounding the file's exact figure is fine");
assert.equal(isKnownFigure(fig("$3,900,000"), vague), true, "the same figure written out in full is fine");
assert.equal(isKnownFigure(fig("$5M"), vague), true);

// ── 2. The checker's real Pacific run: the invented subtotal and the EBITDA that doesn't follow ──
const summary = checkSectionFigures(byTitle(sections.checkerRun, "Three-Year Financial Summary"), known);
for (const v of ["3,910,000", "5,389,500", "5,440,500"]) {
  assert.ok(summary.some((m) => m.startsWith("no source") && m.includes(v)), `unsourced subtotal ${v}: ${summary.join(" | ")}`);
}
assert.ok(summary.some((m) => /FY2024: "Total Operating Expenses \(recurring\)" shows 5,440,500 but the lines above it add up to 5,567,500/.test(m)), "subtotal ≠ its lines");
assert.ok(summary.some((m) => /FY2024: gross profit − operating expenses \("Total Operating Expenses": 3,746,200\) ≠ EBITDA \(3,619,200\)/.test(m)), "GP − total opex ≠ EBITDA");
// The rest of that run traces and reconciles: no false alarms.
for (const t of ["Revenue by Service Line", "Revenue Growth Trend", "Customer Diversification", "Adjusted EBITDA Reconciliation", "Working Capital Position"]) {
  assert.deepEqual(checkSectionFigures(byTitle(sections.checkerRun, t), known), [], t);
}

// ── 3. The original hallucinated run, checked against today's knowledge base ──
const hist = checkSectionFigures(byTitle(sections.hallucinated, "Historical Financial Performance"), known);
for (const v of ["$4,781,900", "$4,695,600", "$26,481,800", "$2,169,660"]) assert.ok(hist.some((m) => m.includes(v)), `flags ${v}`);
const bridge = checkSectionFigures(byTitle(sections.hallucinated, "EBITDA Normalization & Adjustments"), known);
assert.ok(bridge.some((m) => /95000/.test(m)) && bridge.some((m) => /85000/.test(m)), "invented add-back amounts");
assert.ok(bridge.some((m) => /3900200/.test(m)) && bridge.some((m) => /steps add up to/.test(m)), "forced total");
const cust = checkSectionFigures(byTitle(sections.hallucinated, "Customer Diversification"), known);
assert.ok(cust.some((m) => /"Fraser Valley Dairy Co-op" is not a name on file/.test(m)), `invented customer: ${cust.join(" | ")}`);
assert.ok(!cust.some((m) => /(Alderbrook|Kestrel)[^"]*" is not a name/.test(m)), "real customers pass");

// A waterfall that starts at the bridge's net income must use the bridge's lines: $433,000 is on
// file ("Interest and bank charges"), but the bridge's interest line is $395,000.
const pacificBridge = [
  { year: "2024", label: "Adjusted EBITDA", start: 972960, steps: [395000, 293240, 1950000, -78000, 72000, 55000, -64000, 165000, 62000], totals: [3596200, 3823200] },
];
const knownWithBridge = knownFiguresFrom(kbSource, pacificBridge);
const origBridge = checkSectionFigures(byTitle(sections.hallucinated, "EBITDA Normalization & Adjustments"), knownWithBridge);
assert.ok(origBridge.some((m) => /bar "Interest Expense" \(433,000\) is not a line of the Adjusted EBITDA bridge for 2024/.test(m)), origBridge.join(" | "));
assert.ok(origBridge.some((m) => /"Adjusted EBITDA \(FY2024\)" \(3,900,200\) is not the Adjusted EBITDA total for 2024/.test(m)));
assert.deepEqual(checkSectionFigures(byTitle(sections.checkerRun, "Adjusted EBITDA Reconciliation"), knownWithBridge), [], "the real bridge passes");
// Neighbouring lines grouped into one bar are still the bridge's lines.
assert.deepEqual(
  checkSectionFigures(
    {
      sectionTitle: "Bridge",
      layoutType: "waterfall_chart",
      layoutData: {
        items: [
          { label: "Net income", value: "$972,960", type: "start" },
          { label: "Interest, taxes and D&A", value: "$2,638,240", type: "add" },
          { label: "Yard rent to market", value: "($78,000)", type: "subtract" },
          { label: "One-time items", value: "$127,000", type: "add" },
          { label: "Gain on disposal", value: "($64,000)", type: "subtract" },
          { label: "Adjusted EBITDA", value: "$3,596,200", type: "total" },
        ],
      },
    },
    knownFiguresFrom(`${kbSource}\n2,638,240 127,000`, pacificBridge),
  ),
  [],
);

// ── 4. Names: the whole name, legal endings aside ──
const names = knownFiguresFrom("Hauled berries from Fraser Valley farms. Alderbrook Grocery Distributors Ltd. is 22%. Tidewater Beverage Co. 6%.");
assert.equal(nameOnFile("Fraser Valley Dairy Co-op", names), false);
assert.equal(nameOnFile("Alderbrook Grocery", names), true, "a shortened name on file");
assert.equal(nameOnFile("Alderbrook Grocery Distributors Limited", names), true, "legal ending ignored");
assert.equal(nameOnFile("Tidewater Beverage Company", names), true);

// ── 5. Reconciliation without false alarms ──
const t = (rows: Array<[string, string[], Record<string, boolean>?]>, headers = ["", "FY2023", "FY2024"]) => ({
  sectionTitle: "Financial Performance",
  layoutType: "financial_table",
  layoutData: { headers, rows: rows.map(([label, values, flags]) => ({ label, values, ...(flags ?? {}) })) },
});
const recon = knownFiguresFrom(
  "8,640,200 9,120,400 5,823,500 6,098,300 2,816,700 3,022,100 2,265,830 2,361,848 550,870 660,252 1,484,800 1,640,800 1,811,000 920,600 1,199,100 400,000 500,000 900,000 1,000,000 1,300,000 1,084,800 1,140,800 2,405,400 2,839,900",
);
// A summary table: "Total operating expenses" right after gross profit is not a subtotal of revenue + COGS + GP.
assert.deepEqual(
  checkSectionFigures(t([["Revenue", ["$8,640,200", "$9,120,400"]], ["Cost of sales", ["$5,823,500", "$6,098,300"]], ["Gross profit", ["$2,816,700", "$3,022,100"]], ["Gross profit margin", ["32.6%", "33.1%"]], ["Total operating expenses", ["$2,265,830", "$2,361,848"]], ["Reported EBITDA", ["$550,870", "$660,252"], { isTotal: true }]]), knownFiguresFrom(`${"8,640,200 9,120,400 5,823,500 6,098,300 2,816,700 3,022,100 2,265,830 2,361,848 550,870 660,252"} 32.6% 33.1%`)),
  [],
  "summary table passes",
);
// A heading that carries its group's amounts must equal the lines under it.
const headed = (opex2024: string) =>
  t([
    ["Gross Profit", ["$2,405,400", "$2,839,900"], { isTotal: true }],
    ["Operating Expenses", ["$1,484,800", opex2024], { isSectionHeader: true }],
    ["Salaries", ["$1,084,800", "$1,140,800"]],
    ["Rent", ["$400,000", "$500,000"]],
    ["EBITDA (reported)", ["$920,600", "$1,199,100"], { isTotal: true }],
  ]);
assert.deepEqual(checkSectionFigures(headed("$1,640,800"), recon), [], "consistent heading totals pass");
const badHead = checkSectionFigures(headed("$1,811,000"), recon);
assert.ok(badHead.some((m) => /FY2024: "Operating Expenses" shows 1,811,000 but the lines under it add up to 1,640,800/.test(m)), badHead.join(" | "));
// Blank expense cells for a year are allowed (never guessed), not a reconciliation failure.
assert.deepEqual(
  checkSectionFigures(t([["Gross Profit", ["$2,405,400", "$2,839,900"]], ["Salaries", ["", "$1,140,800"]], ["Rent", ["", "$500,000"]], ["EBITDA", ["$920,600", "$1,199,100"]]]), recon),
  [],
);
// Balance sheet: "Total assets" = the earlier subtotal + the lines after it.
const bs = knownFiguresFrom("100,000 200,000 300,000 400,000 700,000 1,000,000");
assert.deepEqual(
  checkSectionFigures(t([["Cash", ["$100,000"]], ["Receivables", ["$200,000"]], ["Total current assets", ["$300,000"]], ["Equipment", ["$400,000"]], ["Building", ["$300,000"]], ["Total assets", ["$1,000,000"]]], ["", "2024"]), bs),
  [],
);

// ── 6. Headline figures from long facts ──
assert.equal(
  headlineFigure("Reported profit before adjustments: FY2021: $9,254, FY2022: $6,121, FY2023: $53,433, FY2024: $77,561, FY2025: $36,655. Normalized EBITDA: FY2021: $161,189, FY2022: $191,044, FY2023: $272,915, FY2024: $174,062, FY2025: $129,259", "Net income"),
  "$36,655 (FY2025)",
  "latest year, not the oldest (180 Smoke Vape)",
);
assert.equal(headlineFigure("FY2024 reported EBITDA $1,199,100 (FY2023 $920,600; FY2022 $638,200); FY2024 adjusted EBITDA $1,350,000.", "EBITDA"), "$1,350,000 (FY2024, adjusted)", "adjusted over reported (Harborview)");
assert.equal(headlineFigure("$1,350,000 for FY2024 (reported EBITDA $1,199,100 + owner compensation normalized to market $82,000 + aborted acquisition costs $38,000); FY2023 $1,024,500", "EBITDA"), "$1,350,000 (FY2024)");
assert.equal(headlineFigure("2024 net sales: $58,241,630, up approximately 6.5% year-over-year. Medical volume was the primary driver. 2025 budget: $61.5 million assuming medical keeps growing.", "Revenue"), "$58,241,630 (2024)", "a budget is not a result");
assert.equal(headlineFigure("FY2024 $920,052; FY2023 $815,620; FY2022 $720,500 — adjusted EBITDA plus one market-rate pharmacist-manager salary ($140,000)", "SDE"), "$920,052 (FY2024)");
assert.equal(headlineFigure("$2,013,000\nJust over $2 million in 2025\n$2,013,000 (FY2025), from the reviewed statements and the seller", "Revenue"), "$2,013,000 (FY2025)", "the precise statement of the year");
assert.equal(headlineFigure("Revenue was $1.2M in one year and $1.4M in another, and nobody is sure which came last or which is right.", "Revenue"), null, "ambiguous: no canonical figure");

const smoke = buildKnowledgeBase({
  dealId: "d",
  businessName: "Smoke Shop",
  industry: "Retail",
  extractedInfo: {
    netIncome: "Reported profit before adjustments: FY2021: $9,254, FY2022: $6,121, FY2023: $53,433, FY2024: $77,561, FY2025: $36,655. Normalized EBITDA: FY2021: $161,189, FY2025: $129,259",
    employees: "Key personnel: a manager, two part-time associates; the owner's spouse is on payroll at $42K with a minimal role. Total headcount 4 including the owner.",
  },
  today: new Date("2026-09-25T12:00:00Z"),
} as any);
assert.match(smoke, /CANONICAL FIGURES[\s\S]*Net income: \$36,655 \(FY2025\)/);
assert.ok(!/Net income: \$9,254/.test(smoke));
assert.ok(!/Headcount: \$42K/.test(smoke), "a salary is never the canonical headcount");

// ── 7. Conflicts: like with like, same year ──
const analysis = {
  id: "fa",
  version: 1,
  status: "completed",
  brokerReviewedAt: null,
  reclassifiedPnl: {
    years: ["2023", "2024"],
    rows: [
      { id: "r1", name: "Sales", category: "Revenue", values: { "2023": 8640200, "2024": 9120400 } },
      { id: "r2", name: "COGS", category: "COGS", values: { "2023": 5823500, "2024": 6098300 } },
      { id: "r3", name: "Opex", category: "Operating Expenses", values: { "2023": 2265830, "2024": 2361848 } },
    ],
  },
  normalization: { metric: "ebitda", years: ["2023", "2024"], netIncome: { "2023": 414656, "2024": 496728 }, addbacks: [] },
};
const fin = buildCimFinancials(analysis as any)!;
const conf = (extractedInfo: Record<string, unknown>) =>
  figureConflicts({ dealId: "d", businessName: "B", industry: "Pharmacy", extractedInfo, financials: { ...fin, bridge: null } } as any);
assert.deepEqual(conf({ ebitda: "FY2024 reported EBITDA $660,252; adjusted EBITDA $780,052 (8.6% margin) per the accountant's normalization and add-backs" }), [], "an adjusted figure isn't compared with reported EBITDA");
assert.ok(conf({ netIncome: "$396,728 (FY2024)" }).some((c) => /net income on file is \$396,728.*\$496,728 for 2024/.test(c)), "net income checked");
assert.deepEqual(conf({ netIncome: "$414,656 (2023)" }), [], "a 2023 figure is compared with 2023");

// ── 8. The statement block says what operating expenses include ──
const withOneTime = buildCimFinancials({
  ...analysis,
  reclassifiedPnl: {
    years: ["2024"],
    rows: [
      { id: "r1", name: "Sales", category: "Revenue", values: { "2024": 31020000 } },
      { id: "r2", name: "COGS", category: "COGS", values: { "2024": 21706300 } },
      { id: "r3", name: "Opex", category: "Operating Expenses", values: { "2024": 5567500 } },
      { id: "r4", name: "TMS migration (one-time)", category: "Non-Recurring", values: { "2024": 127000 } },
    ],
  },
} as any);
const block = renderCimFinancialsBlock(withOneTime);
assert.match(block, /Operating expenses \(recurring, incl\. owner compensation; the one-time items below are NOT in this total\): 2024 \$5,567,500/);
assert.match(block, /Total operating expenses incl\. one-time items: 2024 \$5,694,500/);
assert.match(block, /EBITDA before other income \(as reported, unadjusted; = gross profit − operating expenses − one-time items\): 2024 \$3,619,200/);

// ── 9. A year the seller never said ──
const said =
  "One thing: Dale, our shop foreman, is retiring in 2027 — he's been here since 2005. We've got his successor lined up, Kevin Tran (Red Seal, been with us since 2018), and we're promoting him to Assistant Shop Foreman in May to shadow Dale through the transition.";
const fact = "Dale retiring 2027; Kevin Tran promoted to Assistant Shop Foreman in May 2025 to shadow Dale through transition";
const fix = repairInferredYears(fact, said)!;
assert.ok(fix && !/May 2025/.test(fix.text) && /in May to shadow/.test(fix.text), JSON.stringify(fix));
assert.match(fix.quotes[0], /we're promoting him to Assistant Shop Foreman in May/);
assert.equal(repairInferredYears("Retiring 2027", said), null, "no month-year, nothing to do");
assert.equal(repairInferredYears("Promoted in May 2025", "We promoted him in May 2025."), null, "the seller said the year");
assert.equal(repairInferredYears("Lease signed March 2024", "It may take a while to sign the renewal."), null, "'may' the verb is not the month");
assert.equal(repairInferredYears("Lease signed March 2024", "The lease question came up with the landlord."), null, "month not named on that turn");
assert.ok(hasMonthYear("since Sept. 2024") && !hasMonthYear("Q3 2024"));

const pacificLike = assembleKnowledgeBase({
  dealId: "d",
  businessName: "Pacific",
  industry: "Transportation",
  extractedInfo: {
    daleSuccessionPlan: fact,
    _fieldSources: { daleSuccessionPlan: { source: "interview", sessionId: "s1", turn: 22, at: "2026-01-21T18:46:07.700Z" } },
  },
  factSourceWords: { daleSuccessionPlan: { words: said, at: "2026-01-21T18:46:07.700Z" } },
  today: new Date("2026-09-25T12:00:00Z"),
} as any);
assert.ok(!/May 2025/.test(pacificLike.text), "the unsaid year never reaches the writer");
assert.match(pacificLike.text, /Dale Succession Plan: .*in May to shadow.*never add one; keep their tense: "We've got his successor/);
assert.ok(pacificLike.warnings.some((w) => /Year left out of the CIM: "Dale Succession Plan" \(May 2025 → May\)/.test(w)), pacificLike.warnings.join(" | "));

// ── 10. An extractor's working-out is not a fact ──
const scratch = assembleKnowledgeBase({
  dealId: "d",
  businessName: "Pacific",
  industry: "Transportation",
  extractedInfo: {
    annualRevenue: "$31,020,000 (FY2024)",
    ebitdaNote: "$2,649,200 (calculated as net income before taxes $1,266,200 plus amortization $1,950,000 plus interest $433,000 - wait, recalculating: $3,585,200)",
  },
  today: new Date("2026-09-25T12:00:00Z"),
} as any);
assert.ok(!/433,000/.test(scratch.sourceText) && !/433,000/.test(scratch.text), "working-out left out");
assert.ok(scratch.warnings.some((w) => /"Ebitda Note" reads like unfinished working/.test(w)));
assert.match(scratch.text, /Annual Revenue: \$31,020,000/);

console.log("cim-truth-r2: ok");
