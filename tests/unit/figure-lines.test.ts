/**
 * figure-lines: CIM row labels → lines, figure keys, askable, blind words.
 *   npx tsx tests/unit/figure-lines.test.ts
 */
import assert from "node:assert/strict";
import { FIGURE_LINES, baseLineOf, figureKey, isStandardLine, lineForLabel, lineSlug, lineWords, parseFigureKey, standardLine } from "../../shared/figure-lines";
import { run, test } from "./helpers/figure-test";

test("the demo tables' labels map to their lines", () => {
  const cases: Array<[string, string | null]> = [
    ["Revenue", "revenue"], ["Annual Revenue", "revenue"], ["Total revenue", "revenue"],
    ["Cost of sales", "costOfSales"], ["Gross profit", "grossProfit"], ["Operating expenses", "operatingExpenses"],
    ["One-time / non-recurring expenses", "nonRecurring"], ["EBITDA (as reported)", "ebitda"], ["Other income", "otherIncome"],
    ["Depreciation & amortization", "amortization"], ["Depreciation and amortization", "amortization"], ["Interest", "interest"],
    ["Interest expense", "interest"], ["Income before income taxes", "incomeBeforeTax"], ["Income taxes", "incomeTaxes"], ["Net income", "netIncome"],
  ];
  for (const [label, line] of cases) assert.equal(lineForLabel(label), line, label);
});

test("margins, adjusted and normalised figures are never these lines", () => {
  for (const label of ["Adjusted EBITDA", "Adjusted EBITDA Margin", "Gross Profit Margin", "SDE", "Seller's Discretionary Earnings", "Revenue growth", "EBITDA margin %", "Revenue per employee"]) {
    assert.equal(lineForLabel(label), null, label);
  }
});

test("figure keys round-trip; analysis lines and as-issued variants parse", () => {
  assert.equal(figureKey("operatingExpenses", "2023"), "operatingExpenses|2023");
  assert.deepEqual(parseFigureKey("operatingExpenses|2023"), { line: "operatingExpenses", year: "2023" });
  assert.equal(lineSlug("Facility rent — warehouse"), "line:facility-rent-warehouse");
  assert.equal(lineSlug("Bank charges & merchant fees"), "line:bank-charges-and-merchant-fees");
  assert.deepEqual(parseFigureKey("line:facility-rent-warehouse|2023"), { line: "line:facility-rent-warehouse", year: "2023" });
  assert.deepEqual(parseFigureKey("operatingExpenses@statements|2024"), { line: "operatingExpenses@statements", year: "2024" });
  assert.equal(baseLineOf("operatingExpenses@statements"), "operatingExpenses");
  assert.equal(isStandardLine("operatingExpenses@statements"), false);
  for (const bad of ["revenue|24", "nonsense|2023", "revenue", "|2023", "line:Bad Slug|2023"]) assert.equal(parseFigureKey(bad), null, bad);
});

test("askable: never EBITDA, net income or derived lines; blind words are category words", () => {
  assert.equal(standardLine("ebitda")!.askable, false);
  assert.equal(standardLine("netIncome")!.askable, false);
  assert.equal(standardLine("incomeBeforeTax")!.askable, false);
  assert.equal(standardLine("operatingExpenses")!.askable, true);
  for (const l of FIGURE_LINES) assert.ok(/^[A-Za-z][A-Za-z -]+$/.test(l.blindWord), l.id);
  assert.equal(standardLine("operatingExpenses")!.comparable, "grouping");
  assert.equal(standardLine("ebitda")!.comparable, "grouping");
  assert.equal(standardLine("interest")!.comparable, "direct");
});

test("line words carry synonyms (rent → lease / premises / warehouse)", () => {
  const words = lineWords("line:facility-rent-warehouse", "Facility rent — warehouse");
  for (const w of ["lease", "premises", "warehouse", "rent"]) assert.ok(words.includes(w), w);
});

await run("figure-lines");
