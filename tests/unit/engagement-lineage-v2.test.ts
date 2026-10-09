/**
 * Section lineage v2 (server/analytics/lineage.ts): precision first.
 * The Pacific demo CIM's regeneration (2026-09-29) is the reference: v2 must
 * reproduce the prototype's 30-row output exactly — the "Working Capital
 * Summary" page no longer continues the capital-expenditure page, and five
 * pages the role pass missed now continue their old pages. No DB, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled node_modules/.bin/tsx tests/unit/engagement-lineage-v2.test.ts
 */
import assert from "node:assert/strict";
import { assignLineage, matchLineage, type LineageOld } from "../../server/analytics/lineage";
import { sectionSimilarity, lineageWords, keyStem } from "../../shared/section-words";
import { pageRole } from "../../shared/cim-page-role";
import { PACIFIC_NEW, PACIFIC_OLD } from "../fixtures/engagement/pacific-lineage";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

console.log("lineage v2 — Pacific (the prototype's full output)");
test("every one of the 30 rows: link and pass", () => {
  const out = matchLineage(PACIFIC_OLD, PACIFIC_NEW);
  const got = PACIFIC_NEW.map((n, i) => [n.id, out[i].lineage, out[i].how, out[i].score ?? null]);
  assert.deepEqual(got, [
    ["n01", "o01", "same key", null],
    ["n02", null, "new", null],
    ["n03", "o04", "same key", null],
    ["n04", "o05", "same key", null],
    ["n05", "o06", "same key", null],
    ["n06", "o08", "same key", null],
    ["n07", "o07", "similar words", 0.57],     // Adjusted EBITDA & Margin ← EBITDA Normalization & Adjustments
    ["n08", null, "new", null],                // Working Capital Summary: fresh (was the capex page)
    ["n09", "o09", "similar words", 0.62],     // Customer Base & Concentration ← Customer Diversification
    ["n10", null, "new", null],
    ["n11", "o10", "same key", null],
    ["n12", null, "new", null],
    ["n13", "o11", "same key", null],
    ["n14", "o12", "same key", null],
    ["n15", "o14", "similar words", 0.5],      // Facility Location ← Locations
    ["n16", "o15", "similar words", 0.8],      // Team & Organizational Structure ← Organization & Key Personnel
    ["n17", null, "new", null],                // Key Personnel: its only candidate went to a better match
    ["n18", "o16", "same key", null],
    ["n19", "o17", "same key", null],
    ["n20", "o21", "same key", null],
    ["n21", null, "new", null],
    ["n22", "o19", "same key", null],
    ["n23", "o20", "similar words", 1],        // Competitive Strengths ← Competitive Advantages (key words)
    ["n24", "o18", "similar words", 0.67],     // Capital Investment & Fleet Renewal ← Capital Expenditures & Fleet Replacement
    ["n25", null, "new", null],
    ["n26", "o22", "similar words", 0.62],     // Legal, Regulatory & Compliance ← Regulatory & Operating Authorities
    ["n27", "o23", "same key", null],
    ["n28", "o24", "same key", null],
    ["n29", "o25", "same key", null],
    ["n30", "o26", "same key", null],
  ]);
});
test("against the stored links: exactly the 6 changes of the spec (1 cleared, 5 added)", () => {
  const v2 = assignLineage(PACIFIC_OLD, PACIFIC_NEW);
  const changes = PACIFIC_NEW.map((n, i) => ({ id: n.id, title: n.sectionTitle, stored: n.stored, v2: v2[i] })).filter((r) => r.stored !== r.v2);
  assert.deepEqual(changes.map((c) => [c.title, c.stored, c.v2]), [
    ["Working Capital Summary", "o18", null],
    ["Customer Base & Concentration", null, "o09"],
    ["Facility Location", null, "o14"],
    ["Team & Organizational Structure", null, "o15"],
    ["Capital Investment & Fleet Renewal", null, "o18"],
    ["Legal, Regulatory & Compliance", null, "o22"],
  ]);
  assert.equal(PACIFIC_NEW.length - changes.length, 24);
});
test("each old page is continued at most once", () => {
  const v2 = assignLineage(PACIFIC_OLD, PACIFIC_NEW).filter((x): x is string => !!x);
  assert.equal(new Set(v2).size, v2.length);
});

console.log("sectionSimilarity");
const sec = (sectionKey: string, sectionTitle: string, layoutType = "callout_list") => ({ sectionKey, sectionTitle, layoutType });
test("capex reads as capital expenditure", () => {
  assert.ok(lineageWords("capex").has(keyStem("capital")));
  assert.ok(lineageWords("capex").has(keyStem("expenditure")));
  const s = sectionSimilarity(sec("capex_plan", "Capex Plan", "two_column"), sec("capital_expenditures", "Capital Expenditures", "two_column"));
  assert.ok(s >= 0.4, `capex ~ capital expenditures: ${s}`);
});
test("one shared word ('capital') between a capex page and working capital is not enough", () => {
  assert.equal(sectionSimilarity(sec("capex_fleet_replacement", "Capital Expenditures & Fleet Replacement", "two_column"), sec("working_capital", "Working Capital Summary", "financial_table")), 0);
});
test("broad words alone never match ('Business Overview' vs 'Company Overview')", () => {
  assert.equal(sectionSimilarity(sec("business_overview", "Business Overview"), sec("company_overview", "Company Overview")), 0);
});
test("one telling word needs ≥ 0.50 and the same role", () => {
  // Locations ↔ Facility Location: 'location' shared, both location role.
  assert.equal(sectionSimilarity(sec("locations", "Locations", "location_map"), sec("facility_location_map", "Facility Location", "location_map")), 0.5);
  // Same word, different roles (financials vs growth): no.
  assert.equal(sectionSimilarity(sec("revenue_growth", "Revenue Growth", "line_chart"), sec("growth_plan", "Growth Plan")), 0);
});

console.log("ambiguity guard");
test("a new page with two near-equal candidates starts fresh", () => {
  const old: LineageOld[] = [
    { id: "a", sectionKey: "fleet_trucks", sectionTitle: "Fleet Trucks", layoutType: "callout_list" },
    { id: "b", sectionKey: "fleet_trailers", sectionTitle: "Fleet Trailers", layoutType: "callout_list" },
  ];
  // "Fleet Trucks & Trailers" shares 2 telling words with each, equally.
  const out = matchLineage(old, [{ sectionKey: "fleet_trucks_trailers", sectionTitle: "Fleet Trucks & Trailers", layoutType: "callout_list" }]);
  assert.equal(out[0].lineage, null);
});
test("an old page wanted equally by two new pages is given to neither", () => {
  const old: LineageOld[] = [{ id: "a", sectionKey: "customer_mix", sectionTitle: "Customer Mix", layoutType: "callout_list" }];
  const out = assignLineage(old, [
    { sectionKey: "customer_mix_retail", sectionTitle: "Customer Mix Retail", layoutType: "callout_list" },
    { sectionKey: "customer_mix_trade", sectionTitle: "Customer Mix Trade", layoutType: "callout_list" },
  ]);
  assert.deepEqual(out, [null, null]);
});

console.log("same fixed layout (replaces the role pass)");
test("an org chart continues the only unmatched org chart", () => {
  const out = matchLineage(
    [{ id: "o", sectionKey: "people", sectionTitle: "Our People", layoutType: "org_chart" }],
    [{ sectionKey: "leadership", sectionTitle: "Management & Staff", layoutType: "org_chart" }],
  );
  assert.deepEqual([out[0].lineage, out[0].how], ["o", "same fixed layout"]);
});
test("not when two unmatched pages of that layout are left on one side", () => {
  const out = assignLineage(
    [{ id: "o1", sectionKey: "site_a", sectionTitle: "North Plant", layoutType: "location_card" }, { id: "o2", sectionKey: "site_b", sectionTitle: "South Plant", layoutType: "location_card" }],
    [{ sectionKey: "premises", sectionTitle: "Premises", layoutType: "location_card" }],
  );
  assert.deepEqual(out, [null]);
});
test("not for a layout whose role isn't fixed (two financial tables are not the same page)", () => {
  const out = assignLineage(
    [{ id: "o", sectionKey: "capex", sectionTitle: "Capital Expenditures", layoutType: "financial_table" }],
    [{ sectionKey: "working_capital", sectionTitle: "Working Capital Summary", layoutType: "financial_table" }],
  );
  assert.deepEqual(out, [null]);
});
test("not when the layouts differ", () => {
  const out = assignLineage(
    [{ id: "o", sectionKey: "people", sectionTitle: "Our People", layoutType: "org_chart" }],
    [{ sectionKey: "leadership", sectionTitle: "Management", layoutType: "callout_list" }],
  );
  assert.deepEqual(out, [null]);
});

console.log("page role");
test("staff retention is about the team; customer retention stays customers", () => {
  assert.equal(pageRole({ layoutType: "icon_stat_row", title: "Driver Workforce & Retention" }), "employees");
  assert.equal(pageRole({ layoutType: "callout_list", title: "Retention of technicians" }), "employees");
  assert.equal(pageRole({ layoutType: "callout_list", title: "Customer Retention" }), "customers");
  assert.equal(pageRole({ layoutType: "callout_list", title: "Client Retention & Churn" }), "customers");
});

console.log(`\n${passed} passed`);
