/**
 * figure-anchors (D3): on the three demo CIMs (fictional fixtures copied from
 * the QA OCT copies) every statement cell anchors to the right figure; a
 * coincidental equal value under another label does NOT anchor; "$31.0M"
 * tolerance; two-column prefixes; nothing in prose or Normalized rows.
 *   npx tsx tests/unit/figure-anchors.test.ts
 */
import assert from "node:assert/strict";
import { anchorFigures, parseShownAmount, type FigureRegistry } from "../../shared/figure-anchors";
import { fixtureRaw, run, test } from "./helpers/figure-test";

const reg = (entries: Array<[string, number, Partial<{ expense: boolean }>?]>): FigureRegistry =>
  Object.fromEntries(entries.map(([key, value, o]) => {
    const [line, year] = key.split("|");
    return [key, { key, line: line as any, lineLabel: line, year, value, total: false, expense: !!o?.expense }];
  }));

test("Pacific: the financial table's statement cells anchor to their figures", async () => {
  const { fx, raw } = await fixtureRaw("pacific", { locate: false });
  const s = fx.sections.find((x) => x.sectionKey === "financial_performance")!;
  const anchors = anchorFigures(s, raw.registry);
  const at = (block: string, cell: number) => anchors.find((a) => a.block === block && a.cell === cell)?.figureKey;
  assert.equal(at("row:0", 0), "revenue|2022");
  assert.equal(at("row:0", 2), "revenue|2024");
  assert.equal(at("row:1", 1), "line:dry-van-truckload-and-regional-distribution|2023");
  assert.equal(at("row:5", 0), "costOfSales|2022");
  assert.equal(at("row:7", 1), "operatingExpenses|2023");
  assert.equal(at("row:9", 0), "ebitda|2022");
  assert.equal(at("row:12", 0), "interest|2022");
  assert.equal(at("row:14", 1), "incomeTaxes|2023");
  assert.equal(at("row:15", 2), "netIncome|2024");
  assert.equal(at("row:13", 0), undefined, "a blank cell anchors nothing");
});

test("Beacon: the as-issued operating expenses anchor to the statements variant", async () => {
  const { fx, raw } = await fixtureRaw("beacon", { locate: false });
  const s = fx.sections.find((x) => x.sectionKey === "financial_performance")!;
  const anchors = anchorFigures(s, raw.registry);
  assert.equal(anchors.find((a) => a.block === "row:3" && a.cell === 1)?.figureKey, "operatingExpenses@statements|2023");
  assert.equal(anchors.find((a) => a.block === "row:0" && a.cell === 2)?.figureKey, "revenue|2024");
});

test("Lakeshore: the key-number card without a year anchors to the latest year only on an exact value", async () => {
  const { fx, raw } = await fixtureRaw("lakeshore", { locate: false });
  const s = fx.sections.find((x) => x.sectionKey === "key_metrics")!;
  const anchors = anchorFigures(s, raw.registry);
  const revenue = anchors.find((a) => a.block === "metric:0");
  assert.equal(revenue?.figureKey, "revenue|2024");
  assert.equal(anchors.find((a) => a.block === "metric:2"), undefined, "SDE Margin (a %) never anchors");
});

test("label AND value: a coincidental equal value under another label does not anchor", () => {
  const r = reg([["interest|2023", 412000, { expense: true }], ["revenue|2023", 29180000]]);
  const s = { id: "p", layoutType: "financial_table", layoutData: { headers: ["", "FY2023"], rows: [{ label: "Bank charges", values: ["$412,000"] }, { label: "Interest", values: ["$412,000"] }] } };
  const a = anchorFigures(s, r);
  assert.equal(a.length, 1);
  assert.equal(a[0].block, "row:1");
});

test("precision shown: $31.0M matches within ±$50,000, not beyond", () => {
  assert.deepEqual(parseShownAmount("$31.0M"), { value: 31000000, tolerance: 50000 });
  const r = reg([["revenue|2024", 31020000]]);
  const ok = anchorFigures({ id: "p", layoutType: "metric_grid", layoutData: { metrics: [{ label: "FY2024 Revenue", value: "$31.0M" }] } }, r);
  assert.equal(ok.length, 1);
  const off = anchorFigures({ id: "p", layoutType: "metric_grid", layoutData: { metrics: [{ label: "FY2024 Revenue", value: "$31.1M" }] } }, r);
  assert.equal(off.length, 0);
  assert.equal(parseShownAmount("12.6%"), null);
  assert.equal(parseShownAmount("4.6x"), null);
  assert.deepEqual(parseShownAmount("(155,000)"), { value: -155000, tolerance: 1 });
});

test("expenses compare as absolute amounts; two-column sections carry the side prefix", () => {
  const r = reg([["operatingExpenses|2022", 4127000, { expense: true }]]);
  const s = { id: "p", layoutType: "two_column", layoutData: { left: { layoutType: "prose", content: "Operating expenses were 4,127,000 in 2022." }, right: { layoutType: "financial_table", content: { headers: ["", "FY2022"], rows: [{ label: "Operating expenses", values: ["(4,127,000)"] }] } } } };
  const a = anchorFigures(s, r);
  assert.equal(a.length, 1, "nothing in prose");
  assert.equal(a[0].block, "right/row:0");
});

test("Normalized rows are never anchored; nothing in an indexed chart", () => {
  const r = reg([["revenue|2024", 9120400]]);
  const ft = { id: "p", layoutType: "financial_table", layoutData: { headers: ["", "FY2024"], rows: [{ label: "Revenue", values: ["$9,120,400"] }], normalizedRows: [{ label: "Revenue", values: ["$9,120,400"] }] } };
  assert.deepEqual(anchorFigures(ft, r).map((a) => a.block), ["row:0"]);
  const chart = { id: "p", layoutType: "line_chart", layoutData: { indexed: true, data: [{ name: "FY2024", revenue: 9120400 }], series: [{ key: "revenue", label: "Revenue" }] } };
  assert.equal(anchorFigures(chart, r).length, 0);
  const chart2 = { id: "p", layoutType: "line_chart", layoutData: { unit: "$", data: [{ name: "FY2024", revenue: 9120400 }], series: [{ key: "revenue", label: "Total Revenue" }] } };
  assert.deepEqual(anchorFigures(chart2, r).map((a) => `${a.block}/${a.cell}`), ["chart/point:0/0"]);
});

await run("figure-anchors");
