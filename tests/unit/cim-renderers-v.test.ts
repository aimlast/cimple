/**
 * CIM renderers — QA harvest round V. Server-rendered / pure; no database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/cim-renderers-v.test.ts
 *
 *   - Waterfall: deductions read "−C$78,000" (not "C$-78K"); a "subtract"
 *     step written as a positive number still subtracts; axis labels are
 *     wrapped to their bar instead of angled off the chart.
 *   - Comparison table: a 3-year series packed into one cell is drawn as
 *     one column per year, with a single "Metric" header.
 */
import "./react-global";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildWaterfallData, formatCurrency, wrapLabel } from "../../client/src/components/cim/renderers/WaterfallChart";
import { ComparisonTableRenderer } from "../../client/src/components/cim/renderers/ComparisonTable";
import { TwoColumnRenderer } from "../../client/src/components/cim/renderers/TwoColumn";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

test("waterfall steps follow their type, and text values are numbers", () => {
  const d = buildWaterfallData([
    { label: "Net income", value: "$972,960", type: "start" },
    { label: "Interest", value: 395000, type: "add" },
    { label: "Gain on disposal", value: 64000, type: "subtract" },
    { label: "Yard rent", value: "-$78,000", type: "subtract" },
    { label: "Adjusted EBITDA", value: 0, type: "total" },
  ]);
  assert.deepEqual(d.map((x) => x.rawValue), [972960, 395000, -64000, -78000, 1225960]);
  assert.equal(d[2].type, "subtract");
  assert.equal(d[4].total, 972960 + 395000 - 64000 - 78000);
});

test("amounts are written sign first", () => {
  assert.equal(formatCurrency(-78000, "CAD"), "−C$78,000");
  assert.equal(formatCurrency(-78000, "CAD", undefined, true), "−C$78K");
  assert.equal(formatCurrency(3596200, "CAD", undefined, true), "C$3.6M");
  assert.equal(formatCurrency(395000, undefined, "$"), "$395,000");
  assert.equal(formatCurrency(1.95, undefined, "$M"), "$1,950,000");
});

test("axis labels wrap to their bar", () => {
  assert.deepEqual(wrapLabel("Below-Market Yard Rent Adjustment", 14), ["Below-Market", "Yard Rent", "Adjustment"]);
  assert.deepEqual(wrapLabel("Interest", 14), ["Interest"]);
});

const safety = {
  title: "Three-Year Safety Metrics",
  leftLabel: "Metric",
  rightLabel: "2022 → 2023 → 2024",
  rows: [
    { label: "CVSE roadside inspections", left: "Total inspections", right: "589 → 711 → 646" },
    { label: "Out-of-service rate", left: "Percent OOS", right: "15.5% → 16.9% → 9.4%", highlight: true },
  ],
};
const section = { id: "s", layoutType: "comparison_table", brokerEditedContent: null } as any;

test("a packed series renders one column per year and one 'Metric' header", () => {
  const html = renderToStaticMarkup(React.createElement(ComparisonTableRenderer, { layoutData: safety, content: "", branding: {} as any, section }));
  assert.equal((html.match(/>Metric</g) || []).length, 1, html);
  for (const y of [">2022<", ">2023<", ">2024<", ">589<", ">711<", ">646<", ">9.4%<", "Total inspections"]) assert.ok(html.includes(y), `missing ${y}`);
  assert.ok(!html.includes("→"), "arrows left in the table");
});

test("inside a two-column section too", () => {
  const html = renderToStaticMarkup(React.createElement(TwoColumnRenderer, {
    layoutData: { left: { layoutType: "prose", content: "Safety is managed by a dedicated team." }, right: { title: "Trends", layoutType: "comparison_table", content: safety } },
    content: "",
    branding: {} as any,
    section: { ...section, layoutType: "two_column" },
  }));
  assert.ok(html.includes(">2024<") && !html.includes("→"), html);
});

test("an ordinary comparison keeps its two columns", () => {
  const html = renderToStaticMarkup(React.createElement(ComparisonTableRenderer, {
    layoutData: { leftLabel: "This business", rightLabel: "Industry", rows: [{ label: "EBITDA margin", left: "12.6%", right: "8.0%" }] },
    content: "",
    branding: {} as any,
    section,
  }));
  for (const t of [">Metric<", ">This business<", ">Industry<", ">12.6%<", ">8.0%<"]) assert.ok(html.includes(t), `missing ${t}`);
});

console.log(`\ncim-renderers-v: ${passed} passed`);
