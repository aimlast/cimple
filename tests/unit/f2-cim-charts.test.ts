/**
 * Free round 2 — chart values (C3, C6).
 *
 * C3: an earnings bridge drew a negative amount typed "add" as a +$36K
 * add-back (the renderer forced it positive) while the figure check read it
 * signed, so the bars overshot their own total and nothing was flagged.
 * C6: a chart value that wasn't one plain number ("$1,850,000 (9 months
 * YTD)", "TBD") was drawn and labelled as $0.
 */
import "./react-global";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PieChartRenderer } from "../../client/src/components/cim/renderers/PieChart";
import { BarChartRenderer } from "../../client/src/components/cim/renderers/BarChart";
import { buildWaterfallData } from "../../client/src/components/cim/renderers/WaterfallChart";
import { structuralFigureProblems, carryFigureWarnings } from "../../server/cim/figure-check";
import { chartSeriesRows, normalizeChartValues, readChartValue } from "../../shared/cim-chart-values";

// ── C3: the recorded probe (scratchpad f2cim/wf.mts) ──
const items = [
  { label: "Net income", value: "$500,000", type: "start" },
  { label: "Owner compensation above market", value: "$120,000", type: "add" },
  { label: "Below-market related-party rent", value: "-$36,000", type: "add" },
  { label: "Adjusted EBITDA", value: "$584,000", type: "total" },
];
const bars = buildWaterfallData(items as any);
const rent = bars.find((b) => b.name.startsWith("Below-market"))!;
assert.equal(rent.type, "subtract", "a negative 'add' is drawn as a deduction");
assert.equal(rent.rawValue, -36000);
assert.equal(rent.total, 584000, "the steps reach the stated total");
assert.equal(bars[bars.length - 1].total, 584000);
const problems = structuralFigureProblems({ sectionKey: "x", sectionTitle: "Bridge", layoutType: "waterfall_chart", layoutData: { items } } as any);
assert.ok(problems.some((p) => /Below-market related-party rent.*negative.*deduction/.test(p)), `the sign/type mismatch is named: ${problems.join(" | ")}`);
assert.ok(!problems.some((p) => /steps add up/.test(p)), "and the bridge reconciles");
// A bridge that only reconciled because the check read the sign the renderer didn't: now both agree.
const wrongTotal = [...items.slice(0, 3), { label: "Adjusted EBITDA", value: "$656,000", type: "total" }];
assert.ok(structuralFigureProblems({ sectionKey: "x", sectionTitle: "Bridge", layoutType: "waterfall_chart", layoutData: { items: wrongTotal } } as any).some((p) => /steps add up to 584,000/.test(p)));
// Saved from the writer: the step is stored as the deduction it is.
const saved = normalizeChartValues("waterfall_chart", { items }) as any;
assert.deepEqual(saved.items[2], { label: "Below-market related-party rent", value: 36000, type: "subtract" });
assert.equal(saved.items[1].type, "add");
// A "subtract" written positive still takes the amount off (unchanged behaviour).
assert.equal(buildWaterfallData([{ label: "NI", value: 100, type: "start" }, { label: "Rent", value: 10, type: "subtract" }, { label: "T", value: 90, type: "total" }] as any)[1].rawValue, -10);

// ── C6: the recorded probe (scratchpad f2cim/pcn.mts) ──
assert.deepEqual(readChartValue("$1,850,000 (9 months YTD)"), { value: 1850000, note: "9 months YTD" });
assert.deepEqual(readChartValue("$1.2M (YTD)"), { value: 1200000, note: "YTD" });
assert.deepEqual(readChartValue("1.2M est."), { value: 1200000, note: "est." });
assert.deepEqual(readChartValue("$1,200,000*"), { value: 1200000, note: "*" });
assert.deepEqual(readChartValue("$1.1–1.2M"), { value: null, note: null }, "a range is not one amount");
assert.deepEqual(readChartValue("TBD"), { value: null, note: null });
assert.deepEqual(readChartValue("$2,400,000"), { value: 2400000, note: null });

const revenue = [{ name: "FY2023", value: "$2,100,000" }, { name: "FY2024", value: "$2,400,000" }, { name: "FY2025", value: "$1,850,000 (9 months YTD)" }];
const drawn = chartSeriesRows(revenue, "");
assert.deepEqual(drawn.rows.map((r) => [r.name, r.value]), [["FY2023", 2100000], ["FY2024", 2400000], ["FY2025 (9 months YTD)", 1850000]], "the YTD bar is drawn at its amount, labelled as YTD");
assert.deepEqual(drawn.unreadable, []);
const tbd = chartSeriesRows([{ name: "FY2024", value: 2400000 }, { name: "FY2025", value: "TBD" }], "$");
assert.deepEqual(tbd.rows.map((r) => r.name), ["FY2024"], "an unreadable value is never a $0 bar");
assert.deepEqual(tbd.unreadable, [{ name: "FY2025", value: "TBD" }]);
// When saved from the writer, the note joins the label and the value is a number.
const norm = normalizeChartValues("bar_chart", { data: revenue }) as any;
assert.deepEqual(norm.data[2], { name: "FY2025 (9 months YTD)", value: 1850000 });
assert.equal(norm.unit, "$");
// The builder is told about a value it can't draw (after a broker edit, too).
const pie = { sectionKey: "p", sectionTitle: "Mix", layoutType: "pie_chart", layoutData: { data: [{ name: "Dry van", value: "$13.5M" }, { name: "Reefer", value: "$1.1–1.2M" }] } } as any;
assert.ok(structuralFigureProblems(pie).some((p) => /"\$1\.1–1\.2M" for "Reefer" isn't one amount/.test(p)));
assert.ok((carryFigureWarnings(pie, null, pie) ?? []).some((p) => /Reefer/.test(p)), "a broker edit that leaves it is flagged");
assert.deepEqual(structuralFigureProblems({ ...pie, layoutData: { data: [{ name: "Dry van", value: "$13.5M" }, { name: "Reefer", value: "$1,150,000 (est.)" }] } }), []);

// Rendered: the unreadable value is listed under the chart as written, never "$0".
const html = (el: any) => renderToStaticMarkup(el).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const pieHtml = html(React.createElement(PieChartRenderer as any, { layoutData: { unit: "$", data: [{ name: "Dry van", value: "$13,500,000" }, { name: "Reefer", value: "TBD" }] }, content: "", branding: {}, section: { layoutType: "donut_chart" } }));
assert.match(pieHtml, /Reefer: TBD/);
assert.doesNotMatch(pieHtml, /\$0\b/);
assert.match(pieHtml, /Dry van/);
const barHtml = html(React.createElement(BarChartRenderer as any, { layoutData: { data: [{ name: "FY2024", value: 2400000 }, { name: "FY2025", value: "TBD" }] }, content: "", branding: {}, section: { layoutType: "bar_chart" } }));
assert.match(barHtml, /FY2025: TBD/);

console.log("f2-cim-charts: ok");
