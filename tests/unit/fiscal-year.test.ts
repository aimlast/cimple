/**
 * fiscalYearKey (shared/fiscal-year.ts — gl owns the file; INTEGRATION §2.16):
 * the cases the figure notes rely on. No DB, no AI.
 *   npx tsx tests/unit/fiscal-year.test.ts
 */
import assert from "node:assert/strict";
import { fiscalYearKey } from "../../shared/fiscal-year";
import { run, test } from "./helpers/figure-test";

test("full fiscal-year labels → the year they end in", () => {
  for (const [label, year] of [
    ["FY2024", "2024"], ["FY 2024", "2024"], ["FYE 2024", "2024"], ["FY24", "2024"], ["FY'23", "2023"],
    ["2023/24", "2024"], ["2023-24", "2024"], ["2023-2024", "2024"], ["2023–2024", "2024"],
    ["2024-12-31", "2024"], ["Dec 31, 2024", "2024"], ["31 December 2024", "2024"], ["2024", "2024"], ["Fiscal 2022", "2022"],
  ] as const) {
    assert.equal(fiscalYearKey(label), year, label);
  }
});

test("part years and projections → null", () => {
  for (const label of ["YTD 2024", "TTM", "LTM Sep 2024", "Interim 2024", "9 months 2024", "Q3 2024", "H1 2024", "2025 projected", "Budget 2025", "6 months ended June 30, 2024"]) {
    assert.equal(fiscalYearKey(label), null, label);
  }
});

test("not a year → null", () => {
  for (const label of ["", null, undefined, "Line item", "2022/2025", "December", "FY", "abc 2024 def"]) {
    assert.equal(fiscalYearKey(label as any), null, String(label));
  }
});

await run("fiscal-year");
