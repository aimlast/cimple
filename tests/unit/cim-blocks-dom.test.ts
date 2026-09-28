/**
 * The reading registry (shared/cim-blocks.ts) must name exactly the parts the
 * renderers mark in the DOM — otherwise the broker's heat map labels
 * something other than what the buyer's browser measured. Server-rendered,
 * no database, no AI, no browser.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/cim-blocks-dom.test.ts
 *
 * Covered: one hand-written section per layout (and the awkward shapes —
 * prose fallback, locked stubs, one-sided and nested two-column sections,
 * the Normalized financial view, the collapsed summary), every section of
 * three real AI-written CIMs (Ridgeline, Pacific ×2), the brokerage pages,
 * and that nothing is marked outside a CimBlocksProvider (builder/print).
 */
import "./react-global";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CimSectionRenderer } from "../../client/src/components/cim/CimSectionRenderer";
import { ExpandableSection } from "../../client/src/components/cim/ExpandableSection";
import { CimContactPage, CimDisclaimerPage } from "../../client/src/components/cim/CimFrontBackPages";
import { CimBlockScope, CimBlocksProvider } from "../../client/src/components/cim/blocks";
import { blocksOf, brokeragePageBlocks, CONTACT_PAGE_ID, DISCLAIMER_PAGE_ID, isValidBlockKey } from "../../shared/cim-blocks";
import { CIM_LAYOUT_KEYS } from "../../shared/cim-layouts";

// Browser globals some renderers touch in effects/handlers (never at render time on the server).
(globalThis as any).window ??= { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "..", "fixtures", "cim");
const branding = {} as any;

let seq = 0;
function section(layoutType: string, layoutData: unknown, extra: Record<string, unknown> = {}): any {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    dealId: "d1",
    sectionKey: `s_${seq}`,
    sectionTitle: `Section ${seq}`,
    order: seq,
    layoutType,
    layoutData,
    aiDraftContent: null,
    brokerEditedContent: null,
    isVisible: true,
    ...extra,
  };
}

const ATTR = /data-cim-block="([^"]*)"/g;
function domKeys(html: string): string[] {
  return [...html.matchAll(ATTR)].map((m) => m[1]);
}
function domPages(html: string): string[] {
  return [...html.matchAll(/data-cim-page="([^"]*)"/g)].map((m) => m[1]);
}
function render(node: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(CimBlocksProvider, { host: {} }, node));
}
function renderSection(s: any): string {
  return render(React.createElement(CimSectionRenderer, { section: s, branding }));
}
/** The default-view keys the registry promises (no virtual chart points, no other views). */
function expectedKeys(s: any): string[] {
  return blocksOf(s).filter((b) => !b.virtual && !b.when).map((b) => b.key);
}
function sameSet(actual: string[], expected: string[], what: string) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  assert.deepEqual(a, e, `${what}\n  DOM:      ${a.join(" ")}\n  registry: ${e.join(" ")}`);
}
function checkSection(s: any, what: string) {
  const html = renderSection(s);
  const keys = domKeys(html);
  assert.equal(new Set(keys).size, keys.length, `${what}: a block key appears twice in the DOM: ${keys.join(" ")}`);
  sameSet(keys, expectedKeys(s), what);
  for (const k of keys) assert.ok(isValidBlockKey(k), `${what}: invalid key ${k}`);
  if (keys.length > 0) assert.ok(domPages(html).includes(s.id), `${what}: no data-cim-page for the section`);
}

// ── one section per layout ───────────────────────────────────────────────
const PER_LAYOUT: Record<string, any[]> = {
  cover_page: [section("cover_page", { businessName: "Harbourline Dental", revenue: "$2.4M", ebitda: "$610K" })],
  divider: [section("divider", { label: "Financials", style: "section-break" }), section("divider", { style: "line" })],
  metric_grid: [
    section("metric_grid", { title: "Key figures", intro: "At a glance.", metrics: [{ label: "Revenue", value: "$9.8M" }, { label: "EBITDA", value: "$1.7M" }, { label: "Staff", value: "42" }] }),
    // prose fallback: no metrics, content present
    section("metric_grid", { metrics: [] }, { aiDraftContent: "First paragraph.\n\nSecond paragraph." }),
  ],
  stat_callout: [section("stat_callout", { primaryValue: "29 years", primaryLabel: "In business", secondaryStats: [{ label: "Clients", value: "140" }, { label: "Repeat", value: "88%" }], description: "Since 1997." })],
  icon_stat_row: [
    section("icon_stat_row", { stats: [{ label: "Trucks", value: 64 }, { label: "Drivers", value: 71 }, { label: "", value: null }] }),
  ],
  scorecard: [
    section("scorecard", { items: [{ label: "Safety", score: 92, benchmark: 80 }, { label: "On time", score: 97 }] }),
    section("scorecard", { items: [{ label: "CVOR", score: "Satisfactory" }] }),
  ],
  bar_chart: [section("bar_chart", { title: "Revenue by year", yLabel: "$M", data: [{ name: "2023", value: 8.1 }, { name: "2024", value: 9.8 }] })],
  horizontal_bar_chart: [section("horizontal_bar_chart", { data: [{ name: "Retail", value: 40 }, { name: "Food", value: 35 }], unit: "%", showPercentages: true })],
  line_chart: [section("line_chart", { data: [{ name: "2023", rev: 8 }, { name: "2024", rev: 9 }], series: [{ key: "rev", label: "Revenue" }] })],
  pie_chart: [
    section("pie_chart", { data: [{ name: "A", value: 60 }, { name: "B", value: 40 }], unit: "%" }),
    // not parts of one whole → drawn as percent bars, still one "chart" block
    section("pie_chart", { data: [{ name: "Top customer", value: 22 }, { name: "Top five", value: 47 }], unit: "%" }),
  ],
  donut_chart: [section("donut_chart", { data: [{ name: "A", value: 3 }, { name: "B", value: 1 }], centerValue: "$4M", total: 4 })],
  waterfall_chart: [section("waterfall_chart", { items: [{ label: "Net income", value: 900000, type: "start" }, { label: "Owner salary", value: 150000 }, { label: "Adjusted EBITDA", value: 1050000, type: "total" }] })],
  financial_table: [
    section("financial_table", {
      caption: "Income statement",
      headers: ["", "2023", "2024"],
      rows: [
        { label: "Revenue", values: ["$8.1M", "$9.8M"] },
        { label: "Operating costs", isSectionHeader: true },
        { label: "Wages", values: ["$3.0M", "$3.4M"], indent: 1 },
        { label: "EBITDA", values: ["$1.4M", "$1.7M"], isTotal: true },
      ],
      footnotes: ["Fiscal years end March 31."],
      normalizedRows: [
        { label: "Revenue", values: ["$8.1M", "$9.8M"] },
        { label: "Owner salary add-back", values: ["$0.15M", "$0.15M"], isAdjusted: true, adjustmentAmount: "+$150K" },
        { label: "Adjusted EBITDA", values: ["$1.55M", "$1.85M"], isTotal: true },
      ],
    }),
    // no headers at all → no "head"
    section("financial_table", { rows: [{ label: "Cash", values: ["$1"] }] }),
  ],
  comparison_table: [section("comparison_table", { leftLabel: "Company", rightLabel: "Industry", rows: [{ label: "Margin", left: "18%", right: "11%" }, { label: "Growth", left: "9%", right: "4%", highlight: true }] })],
  prose_highlight: [
    section("prose_highlight", { body: "Para one about the business.\n\n- bullet a\n- bullet b\n\n## A heading\n\nPara three.", pullQuote: "Built right.", highlights: ["Low churn", "Owned building"] }),
    section("prose_highlight", { body: "From the AI." }, { brokerEditedContent: "The broker's words win.\n\nSecond." }),
  ],
  two_column: [
    section("two_column", {
      title: "People",
      left: { title: "Summary", content: "Left prose paragraph.\n\nAnother.", layoutType: "prose" },
      right: { title: "Figures", layoutType: "metric_grid", content: { metrics: [{ label: "Staff", value: "42" }, { label: "Tenure", value: "9 yrs" }] } },
    }),
    // one side only; the right is a list
    section("two_column", { right: { layoutType: "list", content: "One\nTwo\nThree" } }),
    // metric lines + a nested financial table
    section("two_column", {
      left: { layoutType: "metric", content: "Revenue: $9.8M\nEBITDA: $1.7M" },
      right: { layoutType: "financial_table", content: { headers: ["", "2024"], rows: [{ label: "Revenue", values: ["$9.8M"] }] } },
    }),
    // a placeholder column is dropped; the broker's edit shows above the columns
    section("two_column", {
      left: { content: "stats", layoutType: "icon_stat_row" },
      right: { layoutType: "bar_chart", content: { data: [{ name: "2024", value: 1 }] } },
    }, { brokerEditedContent: "Edited above." }),
  ],
  callout_list: [
    section("callout_list", { items: [{ title: "Recurring revenue", description: "68% under contract" }, { title: "No debt" }], style: "card" }),
    section("callout_list", { items: [{ title: "A" }, { title: "B" }] }),
  ],
  numbered_list: [section("numbered_list", { items: [{ title: "Step one" }, { title: "Step two", description: "Then this." }] })],
  timeline: [section("timeline", { events: [{ year: "1997", title: "Founded" }, { date: "2019", title: "Second plant", highlight: true }] })],
  tag_cloud: [
    section("tag_cloud", { tags: [{ label: "HVAC" }, { label: "Plumbing", weight: 4 }] }),
    section("tag_cloud", { tags: [] }, { aiDraftContent: "Only prose." }),
  ],
  org_chart: [
    section("org_chart", {
      nodes: [
        { id: "n1", name: "Owner", role: "President", isOwner: true },
        { id: "n2", name: "GM", role: "General manager", reportsTo: "n1" },
        { id: "n2", name: "Dup", role: "Duplicate id" },
        { id: "n3", name: "Lead", role: "Shop lead", reportsTo: "n2" },
      ],
      totalHeadcount: 42,
    }),
  ],
  location_card: [section("location_card", { locations: [{ label: "Plant", address: "Somewhere", sqft: 42000, leaseType: "Owned" }, { label: "Yard" }], totalSqft: 50000 })],
  image_gallery: [section("image_gallery", { title: "Facility", images: [{ url: "https://example.com/a.jpg" }, { url: "https://example.com/b.jpg" }] })],
  video: [section("video", { items: [{ source: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Tour" }] })],
  location_map: [
    section("location_map", { locations: [{ label: "HQ", address: "100 Main St, Kitchener, ON" }] }),
    section("location_map", { regionOnly: true, locations: [{ region: "Southern Ontario" }] }),
  ],
};

console.log("every layout: the DOM's blocks are exactly the registry's");
test("the table covers every registered layout", () => {
  for (const key of CIM_LAYOUT_KEYS) assert.ok(PER_LAYOUT[key]?.length, `no fixture for ${key}`);
});
for (const [layout, list] of Object.entries(PER_LAYOUT)) {
  list.forEach((s, i) => test(`${layout} #${i + 1}`, () => checkSection(s, `${layout} #${i + 1}`)));
}

test("a locked teaser stub is a heading + locked", () => {
  const s = section("locked", null, { locked: true, sectionTitle: "Customer Profile" });
  checkSection(s, "locked");
  assert.deepEqual(expectedKeys(s), ["heading", "locked"]);
});

test("an unregistered legacy layout with prose → heading + paragraphs", () => {
  checkSection(section("fancy_old_layout", {}, { aiDraftContent: "Legacy words.\n\nMore." }), "legacy");
});

test("the Normalized financial view marks nrow:i rows (FinancialToggle)", () => {
  const s = PER_LAYOUT.financial_table[0];
  const ld = s.layoutData;
  // What FinancialToggle renders while "Normalized" is on.
  const active = {
    ...s,
    layoutData: {
      ...ld,
      rows: ld.normalizedRows.map((r: any) => ({ ...r, label: r.isAdjusted ? `${r.label} (${r.adjustmentAmount})` : r.label })),
      footnotes: [...ld.footnotes, "Highlighted rows indicate adjustments from reported figures."],
    },
  };
  const html = render(React.createElement(CimBlockScope, { rowKind: "nrow" }, React.createElement(CimSectionRenderer, { section: active, branding })));
  const expected = blocksOf(s).filter((b) => !b.virtual && (b.when === "normalized" || (!b.when && !b.key.startsWith("row:")))).map((b) => b.key);
  sameSet([...new Set(domKeys(html))], [...new Set(expected)], "normalized view");
});

test("a collapsed expandable section: the summary block + the (hidden) full blocks, no preview duplicates", () => {
  const s = section("callout_list", { expandable: true, items: [1, 2, 3, 4, 5].map((n) => ({ title: `Point ${n}` })) });
  const html = render(React.createElement(ExpandableSection, { section: s, branding }));
  const keys = domKeys(html);
  assert.equal(new Set(keys).size, keys.length, `duplicates: ${keys.join(" ")}`);
  sameSet(keys, blocksOf(s).filter((b) => !b.virtual).map((b) => b.key), "collapsed");
  assert.ok(domPages(html).includes(s.id));
});

test("brokerage pages are one 'page' block each, under their page ids", () => {
  for (const [el, id] of [[CimDisclaimerPage, DISCLAIMER_PAGE_ID], [CimContactPage, CONTACT_PAGE_ID]] as const) {
    const html = render(React.createElement(el));
    assert.deepEqual(domKeys(html), brokeragePageBlocks(id).map((b) => b.key));
    assert.ok(domPages(html).includes(id));
  }
});

test("outside a CimBlocksProvider nothing is marked (builder, print, previews unchanged)", () => {
  for (const list of Object.values(PER_LAYOUT)) {
    for (const s of list) {
      const html = renderToStaticMarkup(React.createElement(CimSectionRenderer, { section: s, branding }));
      assert.ok(!/data-cim-(block|page)=/.test(html), `${s.layoutType} marked without a provider`);
    }
  }
});

// ── real AI-written CIMs ─────────────────────────────────────────────────
console.log("real CIMs: Ridgeline, Pacific (acc2), Pacific (v)");
for (const file of ["ridgeline-acc-sections.json", "pacific-acc2-sections.json", "pacific-v-sections.json"]) {
  const rows = JSON.parse(fs.readFileSync(path.join(FIX, file), "utf8")) as any[];
  test(`${file}: ${rows.length} sections match`, () => {
    rows.forEach((r, i) => {
      const s = { id: `f-${i}`, dealId: "d", isVisible: true, aiDraftContent: null, brokerEditedContent: null, ...r };
      checkSection(s, `${file} #${i} ${r.layoutType} "${r.sectionTitle}"`);
    });
  });
}

console.log(`\n${passed} passed`);
