/**
 * FREE round, stream "cim" — offline proofs (no database, no AI) for the CIM
 * review findings F1–F10 and the known open CIM items.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f-cim.test.ts
 */
import "./react-global";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chartShares } from "../../shared/cim-chart-values";
import { PieChartRenderer } from "../../client/src/components/cim/renderers/PieChart";
import { buildWaterfallData } from "../../client/src/components/cim/renderers/WaterfallChart";
import { LocationCardRenderer, rentLabel, splitLeaseType } from "../../client/src/components/cim/renderers/LocationCard";
import { CoverPageRenderer } from "../../client/src/components/cim/renderers/CoverPage";
import { FinancialTableRenderer } from "../../client/src/components/cim/renderers/FinancialTable";
import { ExpandableSection } from "../../client/src/components/cim/ExpandableSection";
import { neutralBridgeLabel, scrubHeldNames } from "../../server/cim/layout-engine";
import { offCanon, type EarningsCanon } from "../../server/cim/earnings-canon";
import { carryFigureWarnings, untracedFigureTexts, withoutUntracedFigures } from "../../server/cim/figure-check";
import { snapshotOf } from "../../server/cim/section-ops";
import { buildBuyerCim, cimHeldFromBuyers, listedPriceText } from "../../shared/cim-buyer-view";
import { CIM_FALLBACK_REASONING } from "../../shared/cim-layouts";
import { classifyGenerationWarnings, generationSummary, regenerateBuyerImpact } from "../../shared/cim-generation-warnings";
import { cimStaleness, factsSnapshotOf } from "../../server/cim/cim-staleness";
import { codenameStemClash, pickCodename, validateCodename } from "../../server/cim/codenames";
import { openBuyerLinks, replacementNeedsReview } from "../../server/cim/generation-jobs";

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
const html = (C: any, layoutData: unknown, layoutType: string, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(React.createElement(C, { layoutData, content: "", branding: {} as any, section: { id: "s", layoutType, sectionTitle: "T", ...extra } as any }));
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cim");

// ── F2: shares and totals ────────────────────────────────────────────────
console.log("F2 — pie / donut / ranked bars print only stated shares and totals");
test("Pacific's concentration donut (22% and 47%) is not drawn as a whole: no 31.9% / 68.1%", () => {
  assert.deepEqual(chartShares([22, 47], "%", undefined), { shares: null, total: null, asBars: true });
  const t = text(html(PieChartRenderer, { unit: "%", data: [{ name: "Largest customer", value: 22 }, { name: "Top five customers", value: 47 }] }, "donut_chart"));
  assert.match(t, /Largest customer 22%/);
  assert.match(t, /Top five customers 47%/);
  assert.doesNotMatch(t, /31\.9|68\.1/);
});
test("a one-slice pie ('Food-related freight 50%') never reads (100.0%)", () => {
  const h = html(PieChartRenderer, { unit: "%", data: [{ name: "Food-related freight", value: 50 }] }, "pie_chart");
  assert.doesNotMatch(text(h), /100\.0%/);
  assert.match(h, /data-testid="percent-bars"/);
});
test("amounts with no stated total: values only — no computed shares, no computed 'Total'", () => {
  const t = text(html(PieChartRenderer, { unit: "$", totalLabel: "Total Revenue", data: [{ name: "Truckload", value: 13560000 }, { name: "LTL", value: 9310000 }, { name: "Warehousing", value: 8150000 }] }, "pie_chart"));
  assert.match(t, /\$13,560,000/);
  assert.doesNotMatch(t, /Total Revenue/, "no stated total → no total line");
  assert.doesNotMatch(t, /\$31,020,000/);
  assert.doesNotMatch(t, /\(43\.7%\)/);
});
test("amounts that add up to the stated total: its shares and the stated total", () => {
  const t = text(html(PieChartRenderer, { unit: "$", totalLabel: "Total Revenue", total: "$31,020,000", data: [{ name: "Truckload", value: 13560000 }, { name: "LTL", value: 9310000 }, { name: "Warehousing", value: 8150000 }] }, "pie_chart"));
  assert.match(t, /Total Revenue \$31,020,000/);
  assert.match(t, /\(43\.7%\)/);
});
test("a stated total the slices don't reach: the total, each slice's share OF IT, drawn as bars (never a full circle)", () => {
  const r = chartShares([13560000, 9310000], "$", 31020000);
  assert.equal(r.total, 31020000);
  assert.deepEqual(r.shares!.map((s) => s.toFixed(1)), ["43.7", "30.0"]);
  assert.equal(r.asBars, true);
  const over = chartShares([23560000, 9310000], "$", 31020000);
  assert.deepEqual(over, { shares: null, total: null, asBars: true }, "slices beyond the total are not its parts");
});

// ── F3: bridges ──────────────────────────────────────────────────────────
console.log("F3 — earnings bridge draws its stated total; a held name's add-back keeps its step");
const bridge = [
  { label: "Net income", value: 900000, type: "start" as const },
  { label: "Owner compensation", value: 180000, type: "add" as const },
  { label: "Salary paid to Maria Chen", value: 62000, type: "add" as const },
  { label: "Adjusted EBITDA", value: 1142000, type: "total" as const },
];
test("the total bar is the stated Adjusted EBITDA even when a step is missing", () => {
  const d = buildWaterfallData([bridge[0], bridge[1], bridge[3]]);
  assert.equal(d[2].rawValue, 1142000);
  assert.ok(!d.some((x) => x.rawValue === 1080000), "never the renderer's own 1,080,000");
});
test("scrubbing a held name keeps the add-back under a neutral label", () => {
  const r = scrubHeldNames({ layoutType: "waterfall_chart", layoutData: { items: bridge } }, ["Maria Chen"])!;
  const items = (r.layoutData.items as any[]);
  assert.equal(items.length, 4);
  assert.equal(items[2].value, 62000);
  assert.equal(items[2].label, "Salary paid");
  assert.ok(!JSON.stringify(r.layoutData).includes("Maria"));
  assert.equal(buildWaterfallData(items).at(-1)!.rawValue, 1142000);
});
test("neutral labels", () => {
  assert.equal(neutralBridgeLabel("Maria Chen — spouse wages", ["Maria Chen"]), "Spouse wages");
  assert.equal(neutralBridgeLabel("Maria Chen", ["Maria Chen"]), "Other add-back");
  assert.equal(neutralBridgeLabel("Maria Chen", ["Maria Chen"], "subtract"), "Other deduction");
});

// ── known-1: the multiple ────────────────────────────────────────────────
console.log("known-1 — a multiple is of the measure named right after it");
const canon = {
  headline: "sde", latestYear: "2024", adjustedEbitda: { "2024": 1552000 }, sde: { "2024": 1717000 }, reportedEbitda: { "2024": 1398000 },
  revenue: { "2024": 9815000 }, margins: [], multiples: [{ kind: "adjusted", year: "2024", value: 6500000 / 1552000 }, { kind: "sde", year: "2024", value: 6500000 / 1717000 }],
  source: { adjusted: {}, sde: {} }, override: null, unconfirmed: [], brokerConflicts: [], financials: null,
} as unknown as EarningsCanon;
test("'3.8× FY2024 SDE of $1,717,000 and 4.2× FY2024 Adjusted EBITDA of $1,552,000' is correct", () => {
  assert.deepEqual(offCanon("Asking price $6,500,000 — representing 3.8× FY2024 Seller's Discretionary Earnings of $1,717,000 and 4.2× FY2024 Adjusted EBITDA of $1,552,000.", canon), []);
});
test("a wrong multiple is still caught", () => {
  assert.equal(offCanon("The asking price represents 4.2× FY2024 SDE of $1,717,000.", canon).length, 1);
});

// ── known-2: location card ───────────────────────────────────────────────
console.log("known-2 — location card");
const NNN = "Triple-net lease (fully net and carefree to Landlord: Tenant pays realty taxes, building insurance premiums, utilities, repairs and maintenance)";
test("a paragraph lease type becomes a short badge plus 'Lease terms'", () => {
  assert.deepEqual(splitLeaseType("Month-to-month"), { badge: "Month-to-month", terms: null });
  const s = splitLeaseType(NNN);
  assert.equal(s.badge, "Triple-net lease");
  assert.match(s.terms!, /^Fully net and carefree to Landlord/);
});
test("a per-square-foot rate is not an 'Annual Rent'", () => {
  assert.equal(rentLabel("annualRent", "$12.00 per sq ft (Years 3-5: 2024-2026)"), "Base Rent");
  assert.equal(rentLabel("annualRent", "$336,000"), "Annual Rent");
  assert.equal(rentLabel("monthlyRent", "$28,000"), "Monthly Rent");
});
test("the first unit named decides the rent label (an aside in brackets never wins)", () => {
  assert.equal(rentLabel("monthlyRent", "$28,000 per month ($336,000 per annum)"), "Monthly Rent");
  assert.equal(rentLabel("annualRent", "$336,000 ($28,000 per month)"), "Annual Rent");
  assert.equal(rentLabel("annualRent", "$336,000 per annum ($28,000 per month)"), "Annual Rent");
  assert.equal(rentLabel("monthlyRent", "$336,000 per year"), "Annual Rent");
  assert.equal(rentLabel("annualRent", "$28,000 monthly"), "Monthly Rent");
  assert.equal(rentLabel("annualRent", "$12.00 per sq ft per annum"), "Base Rent");
  assert.equal(rentLabel("annualRent", "$336,000 per annum ($12.00 per sq ft)"), "Annual Rent");
  assert.equal(rentLabel("monthlyRent", "$4,500 a month"), "Monthly Rent");
});
test("the recorded Ridgeline card (both rent rows) renders Monthly Rent + Base Rent, never Annual Rent", () => {
  const rec = JSON.parse(fs.readFileSync(path.join(FIX, "ridgeline-acc-sections.json"), "utf8")).find((s: any) => s.layoutType === "location_card");
  const t = text(html(LocationCardRenderer, rec.layoutData, "location_card"));
  assert.match(t, /Monthly Rent \$28,000 per month \(\$336,000 per annum\)/);
  assert.match(t, /Base Rent \$12\.00 per sq ft/);
  assert.doesNotMatch(t, /Annual Rent/);
});
test("the Ridgeline facility card: badge under the address, terms spelt out, rent labelled right", () => {
  const h = html(LocationCardRenderer, { locations: [{ label: "Nisku Fabrication Facility", address: "2240 - 7A Street, Nisku, AB T9E 8N4", leaseType: NNN, annualRent: "$12.00 per sq ft (Years 3-5: 2024-2026)" }] }, "location_card");
  const t = text(h);
  assert.doesNotMatch(h, /justify-between gap-2 mb-3/, "no header row shared with the badge");
  assert.ok(t.indexOf("2240 - 7A Street") < t.indexOf("Triple-net lease"), "the badge sits under the address");
  assert.match(t, /Lease terms: Fully net and carefree/);
  assert.match(t, /Base Rent \$12\.00 per sq ft/);
  assert.doesNotMatch(t, /Annual Rent/);
});

// ── known-3: repair ──────────────────────────────────────────────────────
console.log("known-3 — untraced figures are taken out");
const recordedSections = JSON.parse(fs.readFileSync(path.join(FIX, "ridgeline-acc-sections.json"), "utf8"));
test("the recorded Equipment & Assets card loses only the sentence with the untraced figures", () => {
  const equip = recordedSections.find((s: any) => s.sectionTitle === "Equipment & Assets");
  const issues = [
    'no source for "$1,633,000" (Original cost $1,633,000, net book value $806,000 per financial statements.)',
    'no source for "$806,000" (Original cost $1,633,000, net book value $806,000 per financial statements.)',
  ];
  assert.deepEqual(untracedFigureTexts(issues), ["$1,633,000", "$806,000"]);
  const r = withoutUntracedFigures(equip, issues)!;
  const t = JSON.stringify(r.section.layoutData);
  assert.ok(!t.includes("$1,633,000") && !t.includes("$806,000"));
  assert.ok(t.includes("Original cost $812,000"), "other cards keep their figures");
  assert.ok(t.includes("CNC plasma tables (HD 10×30 ft"), "the card keeps its description");
});
test("a table cell is blanked in place; a chart bar is dropped", () => {
  const table = withoutUntracedFigures(
    { sectionTitle: "P&L", layoutType: "financial_table", layoutData: { headers: ["", "2023", "2024"], rows: [{ label: "Operating expenses", values: ["$1,468,000", "$26,480,000"] }] } },
    ['no source for row "Operating expenses", 2024: $26,480,000'],
  )!;
  assert.deepEqual((table.section.layoutData as any).rows[0].values, ["$1,468,000", ""]);
  const chart = withoutUntracedFigures(
    { sectionTitle: "Mix", layoutType: "bar_chart", layoutData: { data: [{ name: "A", value: 100000 }, { name: "B", value: 777777 }] } },
    ['no source for "B": 777777'],
  )!;
  assert.deepEqual((chart.section.layoutData as any).data.map((d: any) => d.name), ["A"]);
});

// ── known-4 is in f-cim-replay.test.ts (needs the recorded analysis) ─────

// ── known-5: cover ───────────────────────────────────────────────────────
console.log("known-5 — cover");
test("no empty outline circle where a logo would sit", () => {
  const h = html(CoverPageRenderer, { businessName: "Ridgeline Metal Fabrication Inc.", askingPrice: "$6,500,000" }, "cover_page");
  assert.doesNotMatch(h, /rounded-full border-2 opacity-25/);
});

// ── F1: regenerate on a live deal ────────────────────────────────────────
console.log("F1 — a regenerated CIM is held from buyers until published");
test("review is needed when live, approved or when buyers can open it", () => {
  const base = { isLive: false, contentApprovedByBroker: false, contentApprovedBySeller: false, designApprovedByBroker: false, designApprovedBySeller: false, cimGeneration: null } as any;
  assert.equal(replacementNeedsReview(base, 0), false);
  assert.equal(replacementNeedsReview({ ...base, isLive: true }, 0), true);
  assert.equal(replacementNeedsReview({ ...base, designApprovedBySeller: true }, 0), true);
  assert.equal(replacementNeedsReview(base, 13), true);
  const now = new Date("2026-09-26T00:00:00Z");
  assert.equal(openBuyerLinks([{ revokedAt: null, expiresAt: null }, { revokedAt: new Date(), expiresAt: null }, { revokedAt: null, expiresAt: new Date("2026-01-01") }] as any, now), 1);
});
test("the hold is what every buyer path checks", () => {
  assert.equal(cimHeldFromBuyers({ cimGeneration: { buyerHold: { since: "x", wasLive: true, buyers: 13, ddCleared: true } } }), true);
  assert.equal(cimHeldFromBuyers({ cimGeneration: { status: "done" } }), false);
  assert.equal(cimHeldFromBuyers({}), false);
});
test("both confirm dialogs say plainly what happens to buyers", () => {
  const t = regenerateBuyerImpact({ isLive: true, openBuyers: 13 })!;
  assert.match(t, /not shown to the 13 buyers with access until you review it, approve it and publish it again/);
  assert.match(t, /comes off live/);
  assert.equal(regenerateBuyerImpact({ isLive: false, openBuyers: 0, approved: false }), null);
});

// ── F4: warnings ─────────────────────────────────────────────────────────
console.log("F4 — generation notes are classified, and placeholders counted apart");
test("the recorded Ridgeline run: 6 notes, none a placeholder (the toast said '6 fell back to a placeholder')", () => {
  const job = JSON.parse(fs.readFileSync(path.join(FIX, "ridgeline-acc-job.json"), "utf8"));
  const c = classifyGenerationWarnings(job.warnings);
  assert.equal(c.length, 6);
  assert.equal(c.filter((w) => w.kind === "placeholder").length, 0);
  assert.equal(c.find((w) => /Equipment/.test(w.text))!.sectionTitle, "Equipment & Assets");
  assert.equal(c.find((w) => /rebuilt from the financial analysis/.test(w.text))!.kind, "review");
  const s = generationSummary(job.sectionCount, job.warnings);
  assert.match(s.text, /^24 sections written · 6 notes to review before publishing/);
  assert.doesNotMatch(s.text, /placeholder/);
  assert.equal(s.attention, false);
});
test("a real placeholder is counted as one", () => {
  const s = generationSummary(10, ['Section "Key Customers" could not be generated. It was saved as a hidden placeholder — …', 'Check the figures in "P&L" before publishing — …']);
  assert.match(s.text, /9 sections written · 1 couldn't be written .* · 1 note to review/);
  assert.equal(s.attention, true);
});

// ── F5: facts changed since generation ───────────────────────────────────
console.log("F5 — facts changed since the CIM was written");
const sec = (id: string, sectionTitle: string, layoutType: string, layoutData: unknown, aiDraftContent: string | null = null) =>
  ({ id, dealId: "d", sectionKey: id, sectionTitle, order: 1, layoutType, layoutData, aiDraftContent, isVisible: true, aiTask: null } as any);
test("a price cut and a resolved revenue figure name the sections that still show the old values", () => {
  const then = factsSnapshotOf({ annualRevenue: "$2,300,000", employees: "42", _brokerPrivateNotes: [] }, "$4,800,000");
  const now = factsSnapshotOf({ annualRevenue: "$1,820,000", employees: "42", _brokerPrivateNotes: [{ note: "don't mention the lawsuit" }] }, "$4,500,000");
  const sections = [
    sec("cover", "Lakeshore", "cover_page", { askingPrice: "$4,800,000", revenue: "$2,300,000" }),
    sec("tx", "Transaction", "prose_highlight", { body: "Offered at $4.8 million." }),
    sec("team", "Team", "prose_highlight", { body: "42 staff." }),
  ];
  const r = cimStaleness(then, now, sections);
  assert.deepEqual(r.changes.map((c) => c.label), ["Asking price", "Annual revenue"]);
  assert.deepEqual(r.sections.map((s) => [s.id, s.facts]), [["cover", ["Asking price", "Annual revenue"]], ["tx", ["Asking price"]]]);
  assert.equal(r.notesChanged, true);
});
test("a rewording with the same figure is no change", () => {
  const r = cimStaleness(factsSnapshotOf({ annualRevenue: "$4.8M" }, "$4,800,000"), factsSnapshotOf({ annualRevenue: "$4,800,000 (FY2024)" }, "4800000"), []);
  assert.deepEqual(r.changes, []);
});
test("buyers see the listed asking price on the cover and key numbers, whatever was stored", () => {
  assert.equal(listedPriceText("4500000"), "$4,500,000");
  const cim = buildBuyerCim({
    deal: { id: "d", businessName: "Lakeshore" },
    accessLevel: "loi",
    sections: [sec("c", "Cover", "cover_page", { askingPrice: "$4,800,000" }), sec("k", "Key numbers", "metric_grid", { metrics: [{ label: "Asking Price", value: "$4,800,000" }, { label: "Revenue", value: "$9,000,000" }] })],
    overrides: [],
    askingPrice: "$4,500,000",
  });
  assert.equal((cim.sections[0].layoutData as any).askingPrice, "$4,500,000");
  assert.deepEqual((cim.sections[1].layoutData as any).metrics.map((m: any) => m.value), ["$4,500,000", "$9,000,000"]);
});

// ── F6: figure warnings across edits and undo ────────────────────────────
console.log("F6 — figure warnings survive unrelated edits and come back on undo");
const flagged = 'no source for row "Operating expenses", 2024: $26,480,000';
const before = sec("fs", "Financial Summary", "financial_table", { caption: "FY2023–FY2024 (CAD)", headers: ["", "2023", "2024"], rows: [{ label: "Operating expenses", values: ["$25,900,000", "$26,480,000"] }] });
test("fixing a caption typo keeps the flag on the untraced figure", () => {
  const after = { ...before, layoutData: { ...before.layoutData, caption: "FY2023–FY2024 (CAD)." } };
  assert.deepEqual(carryFigureWarnings(before, [flagged], after), [flagged]);
});
test("correcting the flagged cell drops its flag", () => {
  const after = { ...before, layoutData: { ...before.layoutData, rows: [{ label: "Operating expenses", values: ["$25,900,000", "$1,613,000"] }] } };
  assert.equal(carryFigureWarnings(before, [flagged], after), null);
});
test("deleting a bridge row the total depended on is flagged", () => {
  const b = sec("br", "Bridge", "waterfall_chart", { items: bridge });
  const after = { ...b, layoutData: { items: [bridge[0], bridge[1], bridge[3]] } };
  const w = carryFigureWarnings(b, null, after)!;
  assert.ok(w.some((x) => /"Adjusted EBITDA" shows 1,142,000 but the steps add up to 1,080,000/.test(x)), String(w));
});
test("undo snapshots carry the version's flags", () => {
  assert.deepEqual(snapshotOf({ ...before, figureWarnings: [flagged] }, "Edited").figureWarnings, [flagged]);
  assert.equal(snapshotOf({ ...before, figureWarnings: null }, "Edited").figureWarnings, null);
});

// ── F7: codenames ────────────────────────────────────────────────────────
console.log("F7 — codenames that stem from the business, its people or its places");
for (const [deal, codename] of [
  [{ businessName: "Harborview MSP" }, "Project Harbor"],
  [{ businessName: "Cedarbrook Dental Centre" }, "Project Cedar"],
  [{ businessName: "Birchwood Landscaping" }, "Project Birch"],
  [{ businessName: "Summitview Physiotherapy" }, "Project Summit"],
  [{ businessName: "Great Lakes Plastics", location: "Oakville, Ontario" }, "Project Oak"],
  [{ businessName: "Harbourline Dental" }, "Project Harbor"],
] as const) {
  test(`${codename} is refused for ${deal.businessName}`, () => {
    assert.ok(codenameStemClash(codename, deal as any), `${codename} should clash`);
    const v = validateCodename(deal as any, codename, new Set());
    assert.equal(v.ok, false);
  });
}
test("a neutral codename passes, and the picker never offers a stem", () => {
  assert.equal(codenameStemClash("Project Quartz", { businessName: "Harborview MSP" }), null);
  assert.equal(validateCodename({ businessName: "Harborview MSP" }, "Project Quartz", new Set()).ok, true);
  for (let i = 0; i < 300; i++) {
    const c = pickCodename(new Set(), { businessName: "Harborview MSP", location: "Oakville, Ontario" });
    assert.ok(!/Harbor|Oak\b/.test(c), c);
  }
});

// ── F8: placeholders ─────────────────────────────────────────────────────
console.log("F8 — a placeholder never reaches a buyer");
test("even made visible, a fallback section is not served (normal, DD)", () => {
  const ph = { ...sec("p", "Key Customer Relationships", "prose_highlight", { body: "This section (brief) could not be generated automatically." }), aiLayoutReasoning: CIM_FALLBACK_REASONING };
  const ok = sec("o", "Overview", "prose_highlight", { body: "Real content." });
  for (const level of ["loi", "due_diligence"]) {
    const cim = buildBuyerCim({ deal: { id: "d", businessName: "X" }, accessLevel: level, sections: [ph, ok], overrides: [] });
    assert.deepEqual(cim.sections.map((s) => s.id), ["o"], level);
  }
});

// ── F9: the DD gate ──────────────────────────────────────────────────────
console.log("F9 — generate-dd is gated on critical discrepancies");
test("the handler checks the gate before loading DD inputs", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "server", "routes.ts"), "utf8");
  const start = src.indexOf('app.post("/api/deals/:dealId/generate-dd"');
  const body = src.slice(start, src.indexOf("app.", start + 10));
  const gate = body.indexOf("blockingCriticalDiscrepancies(dealId)");
  assert.ok(gate > 0, "gate present");
  assert.ok(body.indexOf("discrepancyBlockResponse(res, openCritical") > gate);
  assert.ok(gate < body.indexOf("loadDdInputs(deal)"), "before the DD inputs");
  assert.ok(gate < body.indexOf("startFullDdGeneration("), "before the run starts");
});

// ── F10: expandable financial tables ─────────────────────────────────────
console.log("F10 — expandable income statements keep their Normalized view");
test("an expandable table with normalizedRows renders the As Reported / Normalized switch", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ label: `Line ${i + 1}`, values: ["$1,000"] }));
  const section = { id: "t", sectionKey: "is", sectionTitle: "Income Statement", layoutType: "financial_table", layoutData: { expandable: true, headers: ["", "2024"], rows, normalizedRows: [{ label: "Owner salary", values: ["$120,000"], isAdjusted: true }] } } as any;
  const h = renderToStaticMarkup(React.createElement(ExpandableSection, { section, branding: {} as any }));
  assert.match(h, /As Reported/);
  assert.match(h, /Normalized/);
});
test("adjusted rows are highlighted, as the Normalized footnote says", () => {
  const h = html(FinancialTableRenderer, { headers: ["", "2024"], rows: [{ label: "Owner salary", values: ["$120,000"], isAdjusted: true }, { label: "Rent", values: ["$50,000"] }] }, "financial_table");
  assert.equal((h.match(/data-adjusted="true"/g) || []).length, 1);
});

console.log(`f-cim: ${passed} passed`);
