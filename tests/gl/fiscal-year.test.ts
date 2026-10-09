/**
 * gl spec §12.1 test 5 (INTEGRATION §2.16): fiscalYearKey on every label
 * form seen in production analyses, interim periods → null; fiscal years of
 * dates for a non-December year end; the deal's year end from its facts or
 * statements.
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { fiscalYearKey, fiscalYearOfDate, fiscalYearRange, normaliseFiscalYearEnd } from "../../shared/fiscal-year";
import { fiscalYearKey as reExported } from "../../shared/gl-types";
import { fiscalYearEndFor, fiscalYearOf, fyeFromText, yearRange } from "../../server/gl/fiscal";

await test("labels → the year the fiscal year ends in", () => {
  const cases: Array<[string, string]> = [
    ["2024", "2024"], ["FY2024", "2024"], ["FY 2024", "2024"], ["FYE 2024", "2024"], ["FY24", "2024"],
    ["2023/24", "2024"], ["2023-2024", "2024"], ["2023–24", "2024"], ["2024-12-31", "2024"], ["Dec 31, 2024", "2024"],
    ["Year ended March 31, 2024", "2024"], ["FY2023/24", "2024"], ["2024A", "2024"], ["Fiscal 2024", "2024"],
    ["FY2024 Restated", "2024"], ["12 months ended Dec 31, 2024", "2024"], ["31/12/2024", "2024"], ["2019-20", "2020"],
  ];
  for (const [label, want] of cases) assert.equal(fiscalYearKey(label), want, label);
  assert.equal(fiscalYearKey(2024), "2024");
  assert.equal(reExported("FY2023"), "2023", "gl-types re-exports the same function");
});

await test("not one full fiscal year → null", () => {
  for (const label of ["YTD 2025", "TTM", "LTM Jun 2025", "9 months 2025", "Six months ended June 30, 2025", "Q3 2025", "H1 2025", "Interim", "2025E", "2025 (Projected)", "Budget 2025", "2024 Revenue", "", "abc"]) {
    assert.equal(fiscalYearKey(label), null, label);
  }
});

await test("dates → fiscal years for a March year end; ranges", () => {
  assert.equal(fiscalYearOfDate("2024-03-31", "03-31"), "2024");
  assert.equal(fiscalYearOfDate("2024-04-01", "03-31"), "2025");
  assert.equal(fiscalYearOf("2024-12-31"), "2024");
  assert.deepEqual(fiscalYearRange("2024", "03-31"), { start: "2023-04-01", end: "2024-03-31" });
  assert.deepEqual(fiscalYearRange("2024", "12-31"), { start: "2024-01-01", end: "2024-12-31" });
  assert.deepEqual(yearRange("2022-01-03", "2024-12-31"), ["2022", "2023", "2024"]);
  assert.deepEqual(yearRange("2023-04-01", "2024-03-31", "03-31"), ["2024"]);
});

await test("a fiscal-year end written any way", () => {
  assert.equal(fyeFromText("December 31"), "12-31");
  assert.equal(fyeFromText("FYE March 31"), "03-31");
  assert.equal(fyeFromText("2024-06-30"), "06-30");
  assert.equal(fyeFromText("Mar 31, 2024"), "03-31");
  assert.equal(fyeFromText("31 August"), "08-31");
  assert.equal(fyeFromText("June"), "06-30");
  assert.equal(fyeFromText(""), null);
  assert.equal(normaliseFiscalYearEnd("02-30"), null);
});

await test("the deal's year end: facts first, then the statements' period end, else Dec 31", () => {
  assert.equal(fiscalYearEndFor({ extractedInfo: { fiscalYearEnd: "March 31" } }), "03-31");
  assert.equal(fiscalYearEndFor({ extractedInfo: { taxYearEnd: "2024-08-31" } }), "08-31");
  assert.equal(fiscalYearEndFor({ extractedInfo: {} }, [
    { category: "financials", sourceMeta: { periodEnd: "2024-06-30" } },
    { category: "financials", sourceMeta: { periodEnd: "2023-06-30" } },
    { category: "financials", subcategory: "general_ledger", sourceMeta: { periodEnd: "2024-12-31" } },
  ]), "06-30");
  assert.equal(fiscalYearEndFor(null), "12-31");
});

done("fiscal-year");
