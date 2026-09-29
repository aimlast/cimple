/**
 * Free round 2 — the CIM leftovers the round-1 checker left open.
 *
 * known-4: a financial table the AI rewrote or converted (builder) never got
 *   the reclassification footnote — the writer is told it is added for it,
 *   and only full generation / single-section writes added it.
 * known-2: rent per square foot written "$18/sf" was labelled Annual Rent;
 *   a raw lease kind ("month_to_month", "leased") showed as written; a
 *   "Net lease with …" sentence got no badge; "Lease: 10 years" became a
 *   badge reading "Lease: 10 years from 2019".
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-cim-known.test.ts
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildCimFinancials } from "../../server/cim/cim-financials";
import { convertSectionLayout, rewriteSectionContent, _setAnthropicForTests } from "../../server/cim/layout-engine";
import { leaseBadgeText, rentLabel, splitLeaseType } from "../../shared/cim-location";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(HERE, "..", "fixtures", "cim", f), "utf8"));

// ── known-4 ──
const analysis = read("ridgeline-acc-analysis.json");
const fin = buildCimFinancials(analysis, [analysis])!;
const params = {
  dealId: "d", businessName: "Ridgeline Metal Fabrication Inc.", industry: "Manufacturing", askingPrice: "$6,500,000",
  extractedInfo: read("ridgeline-acc-facts.json"), financials: fin, today: new Date("2026-09-26T12:00:00Z"),
};
const reclassified = {
  headers: ["", "FY2023", "FY2024"],
  rows: [
    { label: "Revenue", values: ["$9,160,000", "$9,815,000"] },
    { label: "Cost of sales", values: ["$6,410,000", "$6,804,000"] },
    { label: "Gross profit", values: ["$2,750,000", "$3,011,000"] },
    { label: "Operating expenses", values: ["$1,468,000", "$1,613,000"] },
  ],
  footnotes: ["Compiled financial statements (CSRS 4200)."],
};
const model = (layoutData: unknown) => ({ messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_section", input: { layoutData } }] }) }) } }) as any;
const current = { sectionKey: "fin", sectionTitle: "Financial summary", layoutType: "bar_chart", layoutData: { data: [{ name: "FY2024", value: 9815000 }] }, prose: "" };

_setAnthropicForTests(model(reclassified), 1);
try {
  const converted = await convertSectionLayout(params as any, current, "financial_table");
  const notes = (converted.layoutData.footnotes as string[]) ?? [];
  assert.ok(notes.some((n) => /^Figures as reclassified in the financial analysis: cost of sales leaves out the one-time item Crane rebuild/.test(n)), `converted table carries the note: ${JSON.stringify(notes)}`);
  assert.equal(notes[0], "Compiled financial statements (CSRS 4200), as reclassified in the financial analysis (see note).");

  const rewritten = await rewriteSectionContent(params as any, { ...current, layoutType: "financial_table", layoutData: reclassified }, { instructions: "Tighten it" });
  assert.ok(((rewritten.layoutData.footnotes as string[]) ?? []).some((n) => /^Figures as reclassified/.test(n)), "a rewrite proposal carries it too");
} finally {
  _setAnthropicForTests(null);
}
// The statements' own figures get no note (unchanged).
_setAnthropicForTests(model({ ...reclassified, rows: [{ label: "Cost of sales", values: ["$6,410,000", "$6,868,000"] }, { label: "Gross profit", values: ["$2,750,000", "$2,947,000"] }] }), 1);
try {
  const asIssued = await convertSectionLayout(params as any, current, "financial_table");
  assert.ok(!((asIssued.layoutData.footnotes as string[]) ?? []).some((n) => /reclassif/.test(n)));
} finally {
  _setAnthropicForTests(null);
}

// ── known-2 ──
assert.equal(rentLabel("annualRent", "$18/sf net"), "Base Rent");
assert.equal(rentLabel("annualRent", "$18 per sf"), "Base Rent");
assert.equal(rentLabel("annualRent", "$18.50/ft²"), "Base Rent");
assert.equal(rentLabel("annualRent", "$24 psf"), "Base Rent");
assert.equal(rentLabel("annualRent", "$336,000 per year ($12.00 per sq ft)"), "Annual Rent", "unchanged: the first unit named outside brackets decides");
assert.equal(rentLabel("monthlyRent", "$28,000 per month ($336,000 per annum)"), "Monthly Rent");
assert.equal(leaseBadgeText("month_to_month"), "Month-to-month");
assert.equal(leaseBadgeText("leased"), "Leased");
assert.equal(leaseBadgeText("owned"), "Owned");
assert.equal(leaseBadgeText("NNN"), "NNN", "an abbreviation stays as written");
assert.equal(leaseBadgeText("Triple-net lease"), "Triple-net lease");
assert.deepEqual(splitLeaseType("month_to_month"), { badge: "Month-to-month", terms: null });
assert.deepEqual(
  splitLeaseType("Net lease with related party McAllister Properties Ltd. at market rent, 5-year term"),
  { badge: "Net lease", terms: "With related party McAllister Properties Ltd. at market rent, 5-year term" },
);
assert.deepEqual(splitLeaseType("Lease: 10 years from 2019"), { badge: "Leased", terms: "10 years from 2019" });
assert.deepEqual(
  splitLeaseType("Leased from the owner's holding company on a triple-net basis through 2031 with two renewal options"),
  { badge: "Leased", terms: "From the owner's holding company on a triple-net basis through 2031 with two renewal options" },
);
// Unchanged cases from round 1.
assert.deepEqual(splitLeaseType("Triple-net lease (fully net and carefree to Landlord: Tenant pays realty taxes)"), { badge: "Triple-net lease", terms: "Fully net and carefree to Landlord: Tenant pays realty taxes" });
assert.deepEqual(splitLeaseType("Gross lease — landlord pays taxes and insurance; tenant pays utilities"), { badge: "Gross lease", terms: "Landlord pays taxes and insurance; tenant pays utilities" });
assert.deepEqual(splitLeaseType("Owned"), { badge: "Owned", terms: null });

console.log("f2-cim-known: ok");
