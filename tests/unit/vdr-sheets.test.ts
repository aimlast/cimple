/**
 * vdr spec §9.5 step 4, §9.10: spreadsheets in the data room. Runs the REAL
 * render child through the pool.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-sheets.test.ts
 *
 *  - Excel's own row numbers (a blank row counts; a range starting at row 3 says 3)
 *  - absolute columns (a range starting at column B reports B = 1)
 *  - every sheet, hidden ones too (flagged)
 *  - the SIN-column rule (8-digit values that lost their leading zero), a
 *    "SIN" label in the cell to the left, a comment holding a number
 *  - chunks of 1,000 rows with labelled page text; CSV and .xls too
 * 046 454 286 is a Luhn-valid TEST number.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { createRenderPool } from "../../server/vdr/render-pool";
import { coverSheetRows } from "../../server/vdr/child/sheet";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-sheets-"));
const cache = (n: string) => path.join(tmp, "private-vdr-cache", "deal", "item", n);

// ── Pure: the covering rules ──
{
  const rows: Array<Array<string | null>> = [
    ["Employee", "SIN", "Hourly rate"],
    ["A. Driver", "46454286", "31.50"],
    ["B. Driver", "046 454 286", "29.00"],
    ["Note", "SIN", "046454286"],
    ["Revenue", "29,180,000", null],
  ];
  const r = coverSheetRows(rows);
  assert.deepEqual(r.covered.map(([a, b]) => `${a}:${b}`).sort(), ["1:1", "2:1", "3:2"]);
  assert.equal(rows[1][1], "•••••286", "8 digits (leading zero lost) in a SIN column");
  assert.equal(rows[2][1], "••• ••• 286");
  assert.equal(rows[3][2], "••••••286", "a SIN label in the cell to the left");
  assert.equal(rows[4][1], "29,180,000", "figures are untouched");
  assert.deepEqual(r.kinds.every((k) => k === "sin"), true);
}

// ── Fixture: an xlsx ──
const wb = XLSX.utils.book_new();
// Sheet 1: header, a blank row, data; a SIN column.
const s1 = XLSX.utils.aoa_to_sheet([
  ["Customer", "Revenue 2024", "Contact SIN"],
  [],
  ["Alderbrook Foods", 4120000, "046454286"],
  ["Coastal Retail", 2980000, null],
]);
// A comment holding a number (never shown; blocks an original download).
s1["A3"].c = [{ a: "Accountant", t: "Owner SIN 046 454 286 on file" }];
XLSX.utils.book_append_sheet(wb, s1, "Customers");
// Sheet 2: range starting at B3.
const s2: XLSX.WorkSheet = {};
XLSX.utils.sheet_add_aoa(s2, [["Amount", "Item"], [120, "Fuel"], [80, "Tires"]], { origin: "B3" });
s2["!ref"] = "B3:C5"; // the used range, as Excel saves it
XLSX.utils.book_append_sheet(wb, s2, "Costs");
// Sheet 3: hidden.
const s3 = XLSX.utils.aoa_to_sheet([["Driver", "Wage"], ["X", 31]]);
XLSX.utils.book_append_sheet(wb, s3, "Payroll (hidden)");
wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }] } as any;
// Sheet 4: 2,500 rows → 3 chunks.
const big = [["Row", "Value"], ...Array.from({ length: 2499 }, (_, i) => [`r${i + 2}`, i])];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(big), "Detail");
const xlsxFile = path.join(tmp, "book.xlsx");
XLSX.writeFile(wb, xlsxFile);
const csvFile = path.join(tmp, "list.csv");
fs.writeFileSync(csvFile, "Name,SSN,City\nJane,123-45-6789,Vancouver\nBob,,Surrey\n");
const xlsFile = path.join(tmp, "old.xls");
{
  const w = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet([["Asset", "Cost"], ["Truck", 98000]]), "Assets");
  XLSX.writeFile(w, xlsFile, { bookType: "biff8" });
}

const pool = createRenderPool({ maxChildren: 1 });
try {
  const out = cache("aaaaaaaaaaaaaaaa");
  const r = await pool.run({ kind: "prepare", file: xlsxFile, outDir: out, fileKind: "sheet", ext: ".xlsx" });
  assert.equal(r.kind, "sheet");
  const byName = Object.fromEntries(r.sheets!.map((s) => [s.name, s]));
  assert.deepEqual(byName.Customers, { name: "Customers", rows: 4, cols: 3, firstRow: 1, firstCol: 0 });
  assert.deepEqual(byName.Costs, { name: "Costs", rows: 3, cols: 2, firstRow: 3, firstCol: 1 }, "Excel's row 3 and column B");
  assert.equal(byName["Payroll (hidden)"].hidden, true, "hidden sheets are kept and flagged");
  assert.equal(byName.Detail.rows, 2500);
  assert.equal(r.personal.count, 1, "the SIN column value");
  assert.ok(r.officeScan && r.officeScan.count >= 1, "the comment's number is counted for the original-download decision");

  const chunk = (si: number, c: number) => JSON.parse(fs.readFileSync(path.join(out, `sheet-${si}-${c}.json`), "utf8"));
  const c0 = chunk(0, 0);
  assert.deepEqual(c0.rows.map((x: any) => x.r), [1, 2, 3, 4], "a blank row keeps its number");
  assert.deepEqual(c0.rows[1].v, [null, null, null]);
  assert.equal(c0.rows[2].v[2], "••••••286", "covered in the chunk the viewer loads");
  assert.deepEqual(c0.covered, [[3, 2]]);
  const costs = chunk(1, 0);
  assert.equal(costs.firstRow, 3);
  assert.equal(costs.firstCol, 1, "absolute column: B = 1");
  assert.deepEqual(costs.rows.map((x: any) => x.r), [3, 4, 5]);
  // sumColumn B (= 1, absolute) totals the right cells: the index in a row is 1 − firstCol = 0.
  const sumB = costs.rows.slice(1).reduce((a: number, x: any) => a + Number(x.v[1 - costs.firstCol]), 0);
  assert.equal(sumB, 200, "column B holds the amounts");
  assert.equal(costs.rows[1].v[2 - costs.firstCol], "Fuel", "column C holds the items");
  // Chunks of 1,000 rows, each its own page-text row with Excel's row numbers.
  assert.ok(fs.existsSync(path.join(out, "sheet-3-2.json")) && !fs.existsSync(path.join(out, "sheet-3-3.json")));
  assert.equal(chunk(3, 1).firstRow, 1001);
  assert.equal(chunk(3, 2).lastRow, 2500);
  const labels = r.pageTexts.map((p) => p.label);
  assert.ok(labels.includes("Sheet 'Detail', rows 1,001–2,000"), labels.join(" | "));
  assert.ok(labels.includes("Sheet 'Customers', rows 1–4"));
  assert.deepEqual(r.pageTexts.map((p) => p.page), r.pageTexts.map((_, i) => i + 1), "pages are chunk ordinals");
  assert.ok(!r.pageTexts.some((p) => p.text.includes("046454286")), "page text is covered");

  // CSV
  const rc = await pool.run({ kind: "prepare", file: csvFile, outDir: cache("bbbbbbbbbbbbbbbb"), fileKind: "sheet", ext: ".csv" });
  assert.equal(rc.sheets!.length, 1);
  assert.equal(rc.personal.count, 1, "an SSN in an SSN column");
  assert.ok(rc.pageTexts[0].text.includes("Jane | •••-••-•789"), rc.pageTexts[0].text);
  assert.equal(rc.officeScan, undefined, "no zip parts in a CSV");
  // .xls (BIFF)
  const rx = await pool.run({ kind: "prepare", file: xlsFile, outDir: cache("cccccccccccccccc"), fileKind: "sheet", ext: ".xls" });
  assert.equal(rx.sheets![0].name, "Assets");
  assert.match(rx.pageTexts[0].text, /Truck \| 98,?000/);
  // A zip bomb guard: a fake xlsx that isn't a zip is unreadable, not a crash.
  const junk = path.join(tmp, "junk.xlsx");
  fs.writeFileSync(junk, "not a zip");
  await assert.rejects(pool.run({ kind: "prepare", file: junk, outDir: cache("dddddddddddddddd"), fileKind: "sheet", ext: ".xlsx" }), (e: any) => e.code === "unreadable");
} finally {
  await pool.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("vdr sheets: ok");
