/**
 * Financial table header/value alignment — no database, no AI.
 *   npx tsx tests/unit/financial-table.test.ts [tables.json]
 *
 * The renderer and the buyer Q&A context both read tables through
 * normalizeFinancialTable. A figure must always sit under its own year.
 * Pass a JSON dump of real tables ([{data}]) to also check every one of them.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  financialLabelHeader,
  isPeriodHeader,
  normalizeFinancialTable,
} from "../../shared/financial-table";
import { defaultLayoutData } from "../../shared/cim-layouts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

console.log("financial table alignment");

test("leading blank header is the label column (the AI's shape)", () => {
  const t = normalizeFinancialTable({
    headers: ["", "FY2023", "FY2024", "FY2025"],
    rows: [{ label: "Revenue", values: ["$1,750,000", "$1,894,000", "$2,013,000"] }],
  });
  assert.equal(t.labelHeader, "");
  assert.deepEqual(t.columns, ["FY2023", "FY2024", "FY2025"]);
  assert.deepEqual(t.rows[0].cells, ["$1,750,000", "$1,894,000", "$2,013,000"]);
});

test("named label header ('Line Item') is the label column", () => {
  const t = normalizeFinancialTable({
    headers: ["Line Item", "FY 2020-21", "FY 2021-22", "3-Yr Avg"],
    rows: [{ label: "Revenue", values: ["1", "2", "3"] }],
  });
  assert.equal(t.labelHeader, "Line Item");
  assert.deepEqual(t.columns, ["FY 2020-21", "FY 2021-22", "3-Yr Avg"]);
});

test("non-year tables (Description / Amount) keep their label header", () => {
  const t = normalizeFinancialTable({ headers: ["Description", "Amount"], rows: [{ label: "Asking price", values: ["$1M"] }] });
  assert.equal(t.labelHeader, "Description");
  assert.deepEqual(t.columns, ["Amount"]);
  const e = normalizeFinancialTable({
    headers: ["Equipment", "Year", "Condition", "Book Value", "Market Value", "Status"],
    rows: [{ label: "Chair", values: ["2019", "Good", "$1", "$2", "Owned"] }],
  });
  assert.equal(e.labelHeader, "Equipment");
  assert.equal(e.columns.length, 5);
  assert.equal(e.columns[0], "Year");
});

test("headers without a label column map one-to-one onto values", () => {
  const t = normalizeFinancialTable({
    headers: ["2023", "2024", "2025"],
    rows: [{ label: "Revenue", values: ["1", "2", "3"] }],
  });
  assert.equal(t.labelHeader, "");
  assert.deepEqual(t.columns, ["2023", "2024", "2025"]);
  assert.deepEqual(t.rows[0].cells, ["1", "2", "3"]);
});

test("any number of years", () => {
  for (const n of [1, 2, 5, 8]) {
    const years = Array.from({ length: n }, (_, i) => String(2018 + i));
    const t = normalizeFinancialTable({
      headers: ["", ...years],
      rows: [{ label: "Revenue", values: years.map((y) => `v${y}`) }],
    });
    assert.deepEqual(t.columns, years);
    t.rows[0].cells.forEach((c, i) => assert.equal(c, `v${t.columns[i]}`));
  }
});

test("missing year values become empty cells, never shift", () => {
  const t = normalizeFinancialTable({
    headers: ["", "2023", "2024", "2025"],
    rows: [
      { label: "Revenue", values: ["1", "2", "3"] },
      { label: "EBITDA", values: ["", "5", "6"] },
      { label: "Capex", values: ["7"] },
    ],
  });
  assert.deepEqual(t.columns, ["2023", "2024", "2025"]);
  assert.deepEqual(t.rows[1].cells, [null, "5", "6"]);
  assert.deepEqual(t.rows[2].cells, ["7", null, null]);
});

test("a year header with no figures yet stays a column", () => {
  const t = normalizeFinancialTable({
    headers: ["", "2023", "2024", "2025"],
    rows: [{ label: "Revenue", values: ["1", "2"] }],
  });
  assert.deepEqual(t.columns, ["2023", "2024", "2025"]);
  assert.deepEqual(t.rows[0].cells, ["1", "2", null]);
});

test("rows wider than the headers get blank headers, not dropped values", () => {
  const t = normalizeFinancialTable({ headers: ["", "2023"], rows: [{ label: "Revenue", values: ["1", "2"] }] });
  assert.deepEqual(t.columns, ["2023", ""]);
  assert.deepEqual(t.rows[0].cells, ["1", "2"]);
});

test("section-header rows don't set the width; numbers are stringified", () => {
  const t = normalizeFinancialTable({
    headers: ["", "2024"],
    rows: [{ label: "INCOME", values: [], isSectionHeader: true }, { label: "Revenue", values: [1200 as any] }],
  });
  assert.deepEqual(t.columns, ["2024"]);
  assert.equal(t.rows[0].isSectionHeader, true);
  assert.deepEqual(t.rows[1].cells, ["1200"]);
});

test("garbage input never throws", () => {
  assert.deepEqual(normalizeFinancialTable(undefined).rows, []);
  assert.deepEqual(normalizeFinancialTable({ headers: "x" as any, rows: [null, 3, { label: "A" }] as any }).rows[0].cells, []);
});

test("currency header", () => {
  assert.equal(financialLabelHeader("", "CAD"), "(CAD)");
  assert.equal(financialLabelHeader("Line item", "CAD"), "Line item (CAD)");
  assert.equal(financialLabelHeader("Amount (CAD)", "CAD"), "Amount (CAD)");
  assert.equal(financialLabelHeader("", ""), "");
});

test("period detection", () => {
  for (const h of ["2023", "FY2023", "FY 2020-21", "FY23", "TTM", "LTM", "YTD 2025", "Q3", "3-Yr Avg", "Projected"]) assert.ok(isPeriodHeader(h), h);
  for (const h of ["Line Item", "Description", "Equipment", "Metric", ""]) assert.ok(!isPeriodHeader(h), h);
});

test("the registry's blank financial table aligns", () => {
  const d = defaultLayoutData("financial_table") as any;
  const t = normalizeFinancialTable(d);
  assert.equal(t.columns.length, d.rows[0].values.length);
  assert.ok(t.columns.every((c) => /^\d{4}$/.test(c)));
});

const dump = process.argv[2];
if (dump && fs.existsSync(dump)) {
  test(`every real table on file aligns (${dump})`, () => {
    const tables = JSON.parse(fs.readFileSync(dump, "utf8")) as { key: string; data: any }[];
    for (const { key, data } of tables) {
      const t = normalizeFinancialTable(data);
      const h: string[] = data.headers || [];
      const maxV = Math.max(0, ...(data.rows || []).filter((r: any) => !r.isSectionHeader).map((r: any) => (r.values || []).length));
      // Every table on file uses the leading label-header shape.
      assert.equal(t.hadLabelHeader, true, `${key}: ${JSON.stringify(h)}`);
      assert.equal(t.columns.length, Math.max(h.length - 1, maxV), key);
      for (const r of t.rows) assert.equal(r.cells.length, t.columns.length, key);
      // The last value of each full row sits under the last header.
      const full = (data.rows || []).find((r: any) => !r.isSectionHeader && (r.values || []).length === h.length - 1);
      if (full) assert.equal(t.rows[(data.rows || []).indexOf(full)].cells.at(-1), (String(full.values.at(-1)).trim() || null), key);
    }
    console.log(`    (${tables.length} tables checked)`);
  });
}

console.log(`\n${passed} checks passed`);
