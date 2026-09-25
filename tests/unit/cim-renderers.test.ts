/**
 * CIM renderer output — server-rendered to HTML, no database, no AI, no browser.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/cim-renderers.test.ts
 *
 * The rendering bugs buyers saw in the 2026-09-26 demo CIMs:
 *   - a financial-table "section header" row that carried figures hid them
 *     (Harborview's Revenue line);
 *   - donut values written "3,520,000 $";
 *   - "4 acres sq ft";
 *   - "Satisfactory/100" in a scorecard, benchmark labels off the card;
 *   - org charts with 5+ reports running off the page;
 *   - two-column sections printing the word "stats";
 *   - highlight cards breaking "$31,020,000" mid-number.
 */
import "./react-global";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FinancialTableRenderer } from "../../client/src/components/cim/renderers/FinancialTable";
import { PieChartRenderer } from "../../client/src/components/cim/renderers/PieChart";
import { LocationCardRenderer, formatSqft } from "../../client/src/components/cim/renderers/LocationCard";
import { ScorecardRenderer, benchmarkLabelPlacement } from "../../client/src/components/cim/renderers/Scorecard";
import { OrgChartRenderer, buildOrgTree, cardsPerRow } from "../../client/src/components/cim/renderers/OrgChart";
import { TwoColumnRenderer } from "../../client/src/components/cim/renderers/TwoColumn";
import { MetricGridRenderer, metricDisplayValue } from "../../client/src/components/cim/renderers/MetricGrid";
import { compactFigure } from "../../client/src/components/cim/renderers/chartFormat";

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

const branding = {} as any;
const section = (layoutType: string, p: Record<string, unknown> = {}) => ({ id: "s", layoutType, sectionTitle: "T", brokerEditedContent: null, ...p }) as any;
const html = (C: any, layoutData: unknown, layoutType: string) =>
  renderToStaticMarkup(React.createElement(C, { layoutData, content: "", branding, section: section(layoutType) }));
/** Visible text only (tags stripped, entities decoded). */
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

console.log("financial table");
test("a header row that carries figures renders them (Harborview's Revenue line)", () => {
  const h = html(FinancialTableRenderer, {
    headers: ["", "FY2023", "FY2024"],
    rows: [
      { label: "Revenue", isSectionHeader: true, values: ["$5.9M", "$6.2M"] },
      { label: "Operating expenses", isSectionHeader: true, values: ["", ""] },
      { label: "Rent", values: ["$132,000", "$138,600"], indent: 1 },
    ],
  }, "financial_table");
  const t = text(h);
  assert.match(t, /Revenue \$5\.9M \$6\.2M/);
  assert.doesNotMatch(h, /colSpan="3"[^>]*>Revenue/, "the figures row is not a colSpan header");
  assert.match(h, /colSpan="3"[^>]*>Operating expenses/, "a real header (no figures) is still a header");
});

console.log("donut / pie");
test("a '$' unit is written as a prefix everywhere ('$3,520,000', never '3,520,000 $')", () => {
  const h = html(PieChartRenderer, { unit: "$", totalLabel: "Total revenue", data: [{ name: "Freight", value: 3520000 }, { name: "Warehousing", value: 7412000 }] }, "donut_chart");
  const t = text(h);
  assert.match(t, /\$3,520,000/);
  assert.match(t, /\$7,412,000/);
  assert.match(t, /\$10,932,000/, "the total too");
  assert.doesNotMatch(t, /\d \$/);
});
test("legend names wrap instead of being cut off", () => {
  const h = html(PieChartRenderer, { unit: "%", data: [{ name: "Managed services (recurring monthly contracts)", value: 72 }, { name: "Projects", value: 28 }] }, "donut_chart");
  assert.doesNotMatch(h, /truncate/);
  assert.match(text(h), /72% \(72\.0%\)/);
});

console.log("location card");
test("'sq ft' goes on bare numbers only", () => {
  assert.equal(formatSqft("4 acres"), "4 acres");
  assert.equal(formatSqft("4 acres with shop facility"), "4 acres with shop facility");
  assert.equal(formatSqft("2650"), "2,650 sq ft");
  assert.equal(formatSqft("110,000"), "110,000 sq ft");
  assert.equal(formatSqft("110,000 sq ft"), "110,000 sq ft");
  assert.equal(formatSqft("1.2 ha"), "1.2 ha");
  assert.equal(formatSqft(4850), "4,850 sq ft");
  const t = text(html(LocationCardRenderer, { locations: [{ label: "Yard", sqft: "4 acres" }], totalSqft: "4 acres with shop facility" }, "location_card"));
  assert.doesNotMatch(t, /acres sq ft|facility sq ft/);
});

console.log("scorecard");
test("non-numeric results render as a list — 'Satisfactory', never 'Satisfactory/100'", () => {
  const h = html(ScorecardRenderer, { items: [
    { label: "CVSE rating", score: "Satisfactory", description: "No open audits" },
    { label: "OOS rate", score: "9.4%", benchmark: "Below national average" },
    { label: "Collisions", score: "0.11", benchmark: "per million km" },
  ] }, "scorecard");
  const t = text(h);
  assert.match(t, /CVSE rating No open audits Satisfactory/);
  assert.match(t, /Benchmark: Below national average/);
  assert.doesNotMatch(t, /\/100/);
  assert.doesNotMatch(h, /width:\s*NaN|rounded-full transition-all/, "no bars");
});
test("numeric scores keep their bars; a benchmark label stays inside the card at the ends", () => {
  const h = html(ScorecardRenderer, { maxScore: 100, items: [{ label: "Readiness", score: 82, benchmark: 0 }, { label: "Systems", score: "64", benchmark: 100 }] }, "scorecard");
  assert.match(text(h), /82\/100/);
  assert.match(text(h), /64\/100/);
  assert.deepEqual(benchmarkLabelPlacement(0), { left: "0%", transform: "none" });
  assert.deepEqual(benchmarkLabelPlacement(100), { right: "0%", transform: "none" });
  assert.deepEqual(benchmarkLabelPlacement(50), { left: "50%", transform: "translateX(-50%)" });
  assert.match(h, /style="left:0%;transform:none[^"]*" data-benchmark-label/);
  assert.match(h, /style="right:0%;transform:none[^"]*" data-benchmark-label/);
});

console.log("org chart");
const six = {
  nodes: [
    { id: "n1", name: "Owner", role: "Owner & Designated Manager", isOwner: true },
    ...["A", "B", "C", "D", "E", "F"].map((x, i) => ({ id: `c${i}`, name: `Person ${x}`, role: "Manager", reportsTo: "n1" })),
  ],
};
test("6 direct reports render in a wrapped grid, not one fixed-width row", () => {
  const h = html(OrgChartRenderer, six, "org_chart");
  assert.match(h, /data-org-level="grid"/);
  assert.doesNotMatch(h, /style="width:\d{3,}px"/, "no fixed-width connector bar");
  assert.match(h, /grid-template-columns:repeat\(4, 176px\)/, "4 per row on paper");
  assert.doesNotMatch(h, /width:(?:[89]\d\d|\d{4,})px/, "nothing wider than paper");
  for (const x of ["A", "B", "C", "D", "E", "F"]) assert.match(text(h), new RegExp(`Person ${x}`));
});
test("a deep, wide chart (Pacific's shape) never lays out wider than the paper", () => {
  const nodes: any[] = [
    { id: "n1", name: "Founder", role: "President" },
    { id: "n2", name: "VP", role: "VP Operations", reportsTo: "n1" },
    { id: "n3", name: "BD", role: "Business Development", reportsTo: "n1" },
  ];
  for (let i = 0; i < 5; i++) {
    nodes.push({ id: `m${i}`, name: `Manager ${i}`, role: "Manager", reportsTo: "n2" });
    nodes.push({ id: `t${i}`, name: `Team ${i}`, role: "Team", reportsTo: `m${i}` });
  }
  const h = html(OrgChartRenderer, { nodes }, "org_chart");
  assert.match(h, /data-org-level="row"/);
  assert.match(h, /data-org-level="grid"/);
  const widths = Array.from(h.matchAll(/width:(\d+(?:\.\d+)?)px/g)).map((m) => Number(m[1]));
  assert.ok(widths.length > 0 && Math.max(...widths) <= 720, widths.join(","));
  for (let i = 0; i < 5; i++) assert.match(text(h), new RegExp(`Manager ${i}`));
});
test("a small team is still a tree; cards per row follow the page width", () => {
  const h = html(OrgChartRenderer, { nodes: six.nodes.slice(0, 4) }, "org_chart");
  assert.match(h, /data-org-level="row"/);
  assert.equal(cardsPerRow(1440), 4, "never wider than paper");
  assert.equal(cardsPerRow(330), 1, "a phone stacks them");
  assert.equal(buildOrgTree(six.nodes as any)[0].children.length, 6);
});

console.log("two columns");
test("an icon_stat_row column renders its stats; a placeholder word never prints", () => {
  const h = renderToStaticMarkup(React.createElement(TwoColumnRenderer, {
    layoutData: {
      left: { content: "Long-term care is the backbone of the business with fourteen homes served." },
      right: { layoutType: "icon_stat_row", content: { stats: [{ label: "Homes served", value: "14" }, { label: "Beds", value: "1,046" }] } },
    },
    content: "", branding, section: section("two_column"),
  }));
  const t = text(h);
  assert.match(t, /14 Homes served/);
  assert.match(t, /1,046 Beds/);
  const bad = renderToStaticMarkup(React.createElement(TwoColumnRenderer, {
    layoutData: { left: { content: "Long-term care is the backbone of the business with fourteen homes served." }, right: { content: "stats", layoutType: "icon_stat_row" } },
    content: "", branding, section: section("two_column"),
  }));
  assert.doesNotMatch(text(bad), /\bstats\b/);
  assert.doesNotMatch(bad, /md:grid-cols-2/, "the prose column takes the full width");
});
test("a card list with no layoutType renders as cards, not an empty heading", () => {
  const h = renderToStaticMarkup(React.createElement(TwoColumnRenderer, {
    layoutData: {
      left: { content: "Compounding is a distinctive strength of the pharmacy." },
      right: { title: "Compounding at a Glance", style: "card", content: [{ title: "Veterinary Formulations", description: "6 clinic relationships" }, { title: "Pain Management", description: "Topical creams" }] },
    },
    content: "", branding, section: section("two_column"),
  }));
  const t = text(h);
  assert.match(t, /Compounding at a Glance/);
  assert.match(t, /Veterinary Formulations/);
  assert.match(t, /Pain Management/);
});

console.log("highlight cards");
test("long figures in 3–4 card rows are shortened, never broken mid-number", () => {
  assert.equal(compactFigure("$31,020,000"), "$31.02M");
  assert.equal(compactFigure("$6,212,400"), "$6.21M");
  assert.equal(compactFigure("$9,000,000"), "$9M");
  assert.equal(compactFigure("C$1,250,000"), "C$1.25M");
  assert.equal(compactFigure("350+"), "350+");
  assert.equal(compactFigure("12.8%"), "12.8%");
  assert.equal(compactFigure("$975,216"), "$975.22K");
  assert.deepEqual(metricDisplayValue({ value: "$31,020,000" }, 4), { text: "$31.02M", exact: "$31,020,000" });
  assert.deepEqual(metricDisplayValue({ value: "$31,020,000" }, 2), { text: "$31,020,000", exact: "$31,020,000" });
  const h = html(MetricGridRenderer, { columns: 4, metrics: [{ label: "Annual Revenue", value: "$31,020,000" }, { label: "Safety", value: "Satisfactory" }] }, "metric_grid");
  assert.doesNotMatch(h, /overflow-wrap:anywhere/);
  assert.match(h, /whitespace-nowrap[^>]*title="\$31,020,000"[^>]*>\$31\.02M</);
});

console.log(`\n${passed} checks passed`);
