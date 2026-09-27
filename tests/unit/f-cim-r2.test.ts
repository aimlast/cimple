/**
 * FREE round 2, stream "cim" — offline proofs (no database, no AI) for the
 * checker's round-1 findings: rent labels, the reclassification footnote,
 * the asking-price rewrite, staleness noise, the per-section figure check,
 * reminders while a CIM is held, codename stems, chart totals, and the
 * small UI/payload items.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f-cim-r2.test.ts
 */
import "./react-global";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { rentLabel } from "../../shared/cim-location";
import { sectionToContextText } from "../../server/qa/cim-context";
import { buildCimFinancials, renderCimFinancialsBlock, tableReclassificationNote, withReclassificationNote, oneTimeItems } from "../../server/cim/cim-financials";
import { buildBuyerCim, withListedAskingPrice } from "../../shared/cim-buyer-view";
import { cimStaleness, factsSnapshotOf, withoutFactsSnapshot } from "../../server/cim/cim-staleness";
import { settleSectionFigures, settleUntracedFigures, writeOneSection, _setAnthropicForTests } from "../../server/cim/layout-engine";
import { clocksToRestart, processReminderForAccess, reminderActionFor } from "../../server/reminders/decision-reminders";
import { codenameProblem, codenameStemClash, validateCodename } from "../../server/cim/codenames";
import { chartShares, factAmounts, withStatedChartTotal } from "../../shared/cim-chart-values";
import { PieChartRenderer } from "../../client/src/components/cim/renderers/PieChart";
import { heldReplacedText, regenerateBuyerImpact } from "../../shared/cim-generation-warnings";
import { openBuyerLinks } from "../../server/cim/generation-jobs";
import { storage } from "../../server/storage";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "..", "fixtures", "cim");
const ROOT = path.join(HERE, "..", "..");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const src = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// ── known-2: rent labels, the chatbot too ────────────────────────────────
console.log("known-2 — the first unit named decides the rent label; the chatbot says the same");
const recordedLocation = (read("ridgeline-acc-sections.json") as any[]).find((s) => s.layoutType === "location_card");
await test("recorded Ridgeline rents: monthly (with its annual aside) and a per-sq-ft base rent", () => {
  const loc = recordedLocation.layoutData.locations[0];
  assert.equal(rentLabel("monthlyRent", loc.monthlyRent), "Monthly Rent");
  assert.equal(rentLabel("annualRent", loc.annualRent), "Base Rent");
  assert.equal(rentLabel("annualRent", "$336,000 ($28,000 per month)"), "Annual Rent");
});
await test("recorded Pacific rents: an annual total with a per-sq-ft rate in its aside is still annual", () => {
  // Pacific Coast Logistics' warehouse card, as written (2026-09-26).
  assert.equal(rentLabel("annualRent", "Current (Years 1–5): $2,326,500 total ($1,897,500 Basic + ~$429,000 Additional Rent at $3.90/sq ft)"), "Annual Rent");
  assert.equal(rentLabel("monthlyRent", "Years 1–5 (2022–2027): $158,125 Basic Rent + ~$35,750 Additional Rent (taxes, operating costs, insurance). Years 6–10: $178,750 + Additional Rent."), "Monthly Rent");
  assert.equal(rentLabel("annualRent", "$96,000 (current); Market rate: ~$174,000"), "Annual Rent");
});
await test("the buyer chatbot's CIM context: base rent, lease terms, no 'sq ft sq ft'", () => {
  const t = sectionToContextText(recordedLocation);
  assert.match(t, /monthly rent \$28,000 per month \(\$336,000 per annum\)/);
  assert.match(t, /base rent \$12\.00 per sq ft/);
  assert.doesNotMatch(t, /annual rent \$12\.00/);
  assert.match(t, /Triple-net lease; lease terms: Fully net and carefree/);
  assert.doesNotMatch(t, /sq ft\) sq ft/);
  const withTerms = sectionToContextText({ layoutType: "location_card", layoutData: { locations: [{ label: "Shop", leaseType: "Gross lease", leaseTerms: "Landlord pays taxes and insurance" }] } } as any);
  assert.match(withTerms, /Gross lease; lease terms: Landlord pays taxes and insurance/);
});

// ── known-4: a footnote true for the table it sits on ─────────────────────
console.log("known-4 — the reclassification footnote describes the lines the table shows");
const analysis = read("ridgeline-acc-analysis.json");
const fin = buildCimFinancials(analysis, [analysis])!;
const table = (cogs: string, gp: string, opex: string, footnotes: string[] = []) => ({
  headers: ["", "FY2023", "FY2024"],
  rows: [
    { label: "Revenue", values: ["$9,160,000", "$9,815,000"] },
    { label: "Cost of sales", values: ["$6,410,000", cogs] },
    { label: "Gross profit", values: ["$2,750,000", gp] },
    { label: "Operating expenses", values: ["$1,468,000", opex] },
  ],
  footnotes,
});
await test("the crane rebuild is read as a cost-of-sales item, the legal fees as operating", () => {
  const items = oneTimeItems(fin);
  assert.deepEqual(items.map((i) => [i.name, i.from]), [["Crane rebuild", "cogs"], ["Legal fees — shareholder agreement amendment", "opex"]]);
});
await test("opex incl. one-time items ($1,613,000): cost of sales leaves the crane out, operating expenses count it", () => {
  const note = tableReclassificationNote(table("$6,804,000", "$3,011,000", "$1,613,000"), fin)!;
  assert.match(note, /cost of sales leaves out the one-time item Crane rebuild \(FY2024 \$64,000\), which is counted in operating expenses with the other one-time items/);
  assert.doesNotMatch(note, /apart from cost of sales and operating expenses/);
});
await test("opex without them ($1,531,000): both one-time items shown apart", () => {
  const note = tableReclassificationNote(table("$6,804,000", "$3,011,000", "$1,531,000"), fin)!;
  assert.match(note, /the one-time items — Crane rebuild \(FY2024 \$64,000\); Legal fees — shareholder agreement amendment \(FY2024 \$18,000\) — are shown apart from cost of sales and operating expenses/);
});
await test("the statements' own figures ($6,868,000 / $2,947,000 / $1,549,000): no reclassification note", () => {
  assert.equal(tableReclassificationNote(table("$6,868,000", "$2,947,000", "$1,549,000"), fin), null);
  const d = withReclassificationNote("financial_table", table("$6,868,000", "$2,947,000", "$1,549,000", ["Compiled financial statements (CSRS 4200)."]), fin);
  assert.deepEqual(d.footnotes, ["Compiled financial statements (CSRS 4200)."], "the source line is left alone");
});
await test("an earlier (generic) copy of the note is replaced, never stacked; the source line is qualified once", () => {
  const stale = "Figures as reclassified in the financial analysis: one-time items — Crane rebuild (FY2024 $64,000); Legal fees — shareholder agreement amendment (FY2024 $18,000) — are shown apart from cost of sales and operating expenses, so these lines can differ from the financial statements as issued.";
  const once = withReclassificationNote("financial_table", table("$6,804,000", "$3,011,000", "$1,613,000", ["Compiled financial statements (CSRS 4200) prepared by Kwan & Brodeur LLP.", stale]), fin);
  const notes = once.footnotes as string[];
  assert.equal(notes.filter((n) => /^Figures as reclassified/.test(n)).length, 1);
  assert.ok(!notes.includes(stale));
  assert.equal(notes[0], "Compiled financial statements (CSRS 4200) prepared by Kwan & Brodeur LLP, as reclassified in the financial analysis (see note).");
  const twice = withReclassificationNote("financial_table", once, fin);
  assert.deepEqual(twice.footnotes, notes, "idempotent");
});
await test("the knowledge-base block explains the moves and no longer dictates one footnote for every table", () => {
  const block = renderCimFinancialsBlock(fin);
  assert.match(block, /out of cost of sales: Crane rebuild \(FY2024 \$64,000\); out of operating expenses: Legal fees/);
  assert.doesNotMatch(block, /it carries this footnote/);
  assert.match(block, /Don't write a footnote about the reclassification yourself/);
});

// ── F5: only the price itself is the listed price ────────────────────────
console.log("F5 — a label that only mentions the asking price keeps its own figure");
await test("'Asking Price / SDE' 9.4× and the other recorded multiples are left alone", () => {
  const grid = { layoutType: "metric_grid", layoutData: { metrics: [
    { label: "Asking Price / Revenue", value: "0.78x" },
    { label: "Asking Price / Adjusted EBITDA", value: "5.6x" },
    { label: "Asking Price / SDE", value: "9.4x" },
    { label: "List price per sq ft", value: "$120" },
    { label: "Asking Price", value: "$3,400,000" },
    { label: "Asking price (CAD)", value: "$3.4M" },
  ] } };
  const out = withListedAskingPrice(grid, "$3,200,000").layoutData as any;
  assert.deepEqual(out.metrics.map((m: any) => m.value), ["0.78x", "5.6x", "9.4x", "$120", "$3,200,000", "$3,200,000"]);
  const callout = withListedAskingPrice({ layoutType: "stat_callout", layoutData: { primaryLabel: "Asking price as a multiple of SDE", primaryValue: "3.8×" } }, "$6,500,000");
  assert.equal((callout.layoutData as any).primaryValue, "3.8×");
  const odd = withListedAskingPrice({ layoutType: "stat_callout", layoutData: { primaryLabel: "Asking Price", primaryValue: "4.2x" } }, "$6,500,000");
  assert.equal((odd.layoutData as any).primaryValue, "4.2x", "a multiple under a price label is not a price");
});

// ── F5: staleness without the noise ─────────────────────────────────────
console.log("F5 — staleness names only sections that show an old value");
await test("FY2024 revenue changed: a section with only FY2023 revenue is not stale", () => {
  const then = factsSnapshotOf({ revenueByYear: { "2023": "$9,160,000", "2024": "$9,815,000" } }, "$6,500,000");
  const now = factsSnapshotOf({ revenueByYear: { "2023": "$9,160,000", "2024": "$9,900,000" } }, "$6,500,000");
  const r = cimStaleness(then, now, [
    { id: "a", sectionTitle: "FY2023 highlights", layoutData: { body: "FY2023 revenue was $9,160,000." } },
    { id: "b", sectionTitle: "Latest year", layoutData: { body: "FY2024 revenue was $9,815,000." } },
    { id: "c", sectionTitle: "Updated", layoutData: { body: "FY2024 revenue was $9,900,000." } },
  ]);
  assert.deepEqual(r.sections.map((s) => s.id), ["b"]);
});
await test("a new asking price flags the sections with a price multiple (the view room can't recompute them)", () => {
  const then = factsSnapshotOf({}, "$3,400,000");
  const now = factsSnapshotOf({}, "$3,200,000");
  const r = cimStaleness(then, now, [
    { id: "m", sectionTitle: "Valuation support", layoutData: { metrics: [{ label: "Asking Price / SDE", value: "9.4x" }] } },
    { id: "p", sectionTitle: "Transaction", layoutData: { body: "The asking price represents 3.8× FY2024 SDE." } },
    { id: "q", sectionTitle: "Operations", layoutData: { body: "The shop runs two shifts across multiple bays." } },
  ]);
  assert.deepEqual(r.sections.map((s) => s.id), ["m", "p"]);
});
await test("a changed short wording: the section already showing the new wording is not stale", () => {
  const then = factsSnapshotOf({ leaseType: "Month-to-month" }, null);
  const now = factsSnapshotOf({ leaseType: "Month-to-month until a new 5-year lease is signed" }, null);
  const r = cimStaleness(then, now, [
    { id: "old", sectionTitle: "Facility", layoutData: { body: "Lease: Month-to-month." } },
    { id: "new", sectionTitle: "Facility 2", layoutData: { body: "Lease: Month-to-month until a new 5-year lease is signed." } },
  ]);
  assert.deepEqual(r.sections.map((s) => s.id), ["old"]);
});
await test("the facts snapshot never goes to the browser on a deal", () => {
  const deal = { id: "d", cimGeneration: { status: "done", factsAt: { values: { a: "x" }, askingPrice: null, notesKey: "k" } } };
  const out = withoutFactsSnapshot(deal) as any;
  assert.equal(out.cimGeneration.factsAt, undefined);
  assert.equal(out.cimGeneration.status, "done");
  assert.ok(deal.cimGeneration.factsAt, "the stored object is untouched");
  const routes = src("server/routes.ts");
  assert.ok(routes.includes("res.json(deals.map((d) => withoutFactsSnapshot(brokerFactsView(d))));"), "GET /api/deals");
  assert.equal((routes.match(/res\.json\(withoutFactsSnapshot\(brokerFactsView\(deal\)\)\)/g) ?? []).length, 2, "GET and PATCH /api/deals/:id");
});

// ── known-3: one-section writes keep what the check did ─────────────────
console.log("known-3 — Regenerate / Write / Convert: hidden stays hidden, the notes stay on the section");
const facts = read("ridgeline-acc-facts.json");
const params = {
  dealId: "d", businessName: "Ridgeline Metal Fabrication Inc.", industry: "Manufacturing", askingPrice: "$6,500,000",
  extractedInfo: facts, financials: fin, today: new Date("2026-09-26T12:00:00Z"),
};
const entry = { sectionKey: "fin", sectionTitle: "Opex", order: 1, layoutType: "financial_table", tags: [], aiLayoutReasoning: "r" };
await test("an all-untraced table comes back hidden, the reason in its flags", async () => {
  const untraced = { headers: ["", "FY2023", "FY2024"], rows: [{ label: "Operating expenses", values: ["$25,100,000", "$26,480,000"] }] };
  _setAnthropicForTests({ messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_section", input: { layoutData: untraced } }] }) }) } } as any, 1);
  try {
    const out = await writeOneSection(params as any, [entry], entry);
    assert.equal(out.isVisible, false);
    assert.ok((out.figureWarnings ?? []).some((w) => /"Opex" is hidden from buyers: none of its figures has a source on file/.test(w)), JSON.stringify(out.figureWarnings));
  } finally {
    _setAnthropicForTests(null);
  }
});
await test("a traced table stays visible with no notes", async () => {
  const traced = { headers: ["", "FY2023", "FY2024"], rows: [{ label: "Revenue", values: ["$9,160,000", "$9,815,000"] }] };
  _setAnthropicForTests({ messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_section", input: { layoutData: traced } }] }) }) } } as any, 1);
  try {
    const out = await writeOneSection(params as any, [entry], entry);
    assert.notEqual(out.isVisible, false);
    assert.ok(!(out.figureWarnings ?? []).some((w) => /hidden from buyers|Taken out/.test(w)));
  } finally {
    _setAnthropicForTests(null);
  }
});
await test("a converted section is settled the same way (untraced bars out, or hidden)", () => {
  const conv = settleSectionFigures(params as any, { sectionTitle: "Equipment", layoutType: "bar_chart", layoutData: { unit: "$M", data: [{ name: "Plasma table", value: 1.633 }, { name: "Press brake", value: 0.806 }] } });
  assert.equal(conv.isVisible, false);
  assert.ok(conv.flags.some((w) => /hidden from buyers/.test(w)));
  const ok = settleSectionFigures(params as any, { sectionTitle: "Revenue", layoutType: "bar_chart", layoutData: { unit: "$", data: [{ name: "FY2023", value: 9160000 }, { name: "FY2024", value: 9815000 }] } });
  assert.equal(ok.isVisible, true);
  assert.deepEqual(ok.flags, []);
});
await test("settleUntracedFigures is the one rule (a cover is never hidden)", () => {
  const cover = { sectionKey: "c", sectionTitle: "Cover", order: 0, layoutType: "cover_page", layoutData: { revenue: "$99,000,000" }, aiLayoutReasoning: "", tags: [], isVisible: true, brokerApproved: false } as any;
  const r = settleUntracedFigures(cover, ['no source for "$99,000,000"'], { amounts: [], percents: [], names: [] } as any, "Cover");
  assert.notEqual(r.section.isVisible, false);
});
await test("both callers save the hidden state", () => {
  const tasks = src("server/cim/section-tasks.ts");
  assert.match(tasks, /\.\.\.\(hide \? \{ isVisible: false \} : \{\}\)/);
  assert.match(tasks, /hide = written\.isVisible === false;/);
  assert.match(tasks, /settleSectionFigures\(params,/);
  const routes = src("server/routes.ts");
  const at = routes.indexOf("const regenerated = await regenerateCimSection(");
  assert.ok(at > 0 && routes.slice(at, at + 1500).includes("...(regenerated.isVisible === false ? { isVisible: false } : {}),"));
});

// ── F1: reminders while a CIM is held ────────────────────────────────────
console.log("F1 — no reminder or lapse while buyers can only see 'being updated'; publishing restarts the clock");
const DAY = 86400000;
const now = Date.parse("2026-09-26T12:00:00Z");
await test("a buyer at day 8 after the warning is not lapsed while the deal's CIM is held", async () => {
  const access: any = { id: "a1", dealId: "pac", accessToken: "t", buyerEmail: "b@x.invalid", firstViewedAt: new Date(now - 9 * DAY), reminderStage: "warning_sent", lastReminderAt: new Date(now - 3 * DAY), decision: "under_review", revokedAt: null, expiresAt: null };
  assert.equal(reminderActionFor(access, now), "lapse", "it would be lapsed");
  const s = storage as any;
  const getDeal = s.getDeal, update = s.updateBuyerAccess;
  const updates: any[] = [];
  s.getDeal = async () => ({ id: "pac", businessName: "Pacific", cimGeneration: { status: "done", buyerHold: { since: new Date(now - 2 * DAY).toISOString(), wasLive: true, buyers: 13, ddCleared: false } } });
  s.updateBuyerAccess = async (...a: any[]) => { updates.push(a); };
  try {
    assert.equal(await processReminderForAccess(access, now, "https://x"), "none");
    assert.equal(updates.length, 0, "nothing sent, nothing lapsed");
  } finally {
    s.getDeal = getDeal;
    s.updateBuyerAccess = update;
  }
});
await test("publishing restarts only the undecided buyers who viewed before the hold", () => {
  const since = new Date(now - 2 * DAY).toISOString();
  const ids = clocksToRestart([
    { id: "viewed-before", firstViewedAt: new Date(now - 9 * DAY), decision: "under_review", revokedAt: null, expiresAt: null },
    { id: "legacy-null", firstViewedAt: new Date(now - 5 * DAY), decision: null, revokedAt: null, expiresAt: null },
    { id: "decided", firstViewedAt: new Date(now - 9 * DAY), decision: "interested", revokedAt: null, expiresAt: null },
    { id: "revoked", firstViewedAt: new Date(now - 9 * DAY), decision: null, revokedAt: new Date(now - DAY), expiresAt: null },
    { id: "expired", firstViewedAt: new Date(now - 9 * DAY), decision: null, revokedAt: null, expiresAt: new Date(now - DAY) },
    { id: "never-viewed", firstViewedAt: null, decision: null, revokedAt: null, expiresAt: null },
    { id: "after-hold", firstViewedAt: new Date(now - DAY), decision: null, revokedAt: null, expiresAt: null },
  ] as any, since, now);
  assert.deepEqual(ids, ["viewed-before", "legacy-null"]);
});
await test("the release calls the restart with the hold's start", () => {
  const jobs = src("server/cim/generation-jobs.ts");
  const at = jobs.indexOf("export async function releaseBuyerHold");
  assert.ok(jobs.slice(at, at + 1400).includes("await restartReminderClocks(dealId, hold.since);"));
});

// ── F7: codenames ────────────────────────────────────────────────────────
console.log("F7 — a shared root, not a shared ending; the stored codename is re-checked");
const pacific = {
  businessName: "Pacific Coast Logistics Ltd.",
  location: "Cambridge, Ontario",
  extractedInfo: { leaseExpiry: "December 31, 2027", ownerName: "Maria Delgado", keyCustomers: "Salt Spring Foods; The Nook Café; Maple Ridge Farms" },
};
await test("Ember, Aria, Bridge, Stonebridge, Chinook and Basalt are no longer refused", () => {
  // The words they only END like are the deal's identifying words (so the old suffix rule refused them).
  for (const w of ["Maria", "Nook", "Salt", "Cambridge"]) assert.equal(codenameStemClash(`Project ${w}`, pacific), w);
  for (const c of ["Project Ember", "Project Aria", "Project Bridge", "Project Stonebridge", "Project Chinook", "Project Basalt"]) {
    assert.equal(codenameStemClash(c, pacific), null, c);
    assert.equal(validateCodename(pacific, c, new Set()).ok, true, c);
  }
});
await test("Coastline is refused for Pacific Coast (shares the root), with a clear reason", () => {
  const v = validateCodename(pacific, "Project Coastline", new Set());
  assert.equal(v.ok, false);
  assert.match((v as any).error, /“Coastline” shares its root with “Coast” from the business's own details/);
  assert.match(codenameProblem(pacific, "Project Coastline")!, /Coast/);
  assert.equal(codenameProblem(pacific, "Project Quartz"), null);
  assert.match(codenameProblem(pacific, "Project Pacific")!, /Pacific/);
});
await test("the CIM tab is told about a stored codename that points at the business", () => {
  const b = src("server/routes/cim-builder.ts");
  assert.match(b, /codenameProblem: deal\.blindCodename \? codenameProblem\(deal, deal\.blindCodename\) : null/);
  assert.match(src("client/src/pages/broker/deal/CimTab.tsx"), /data-testid="codename-problem"/);
});

// ── Charts: totals from the facts, unit-less splits, short of the total ──
console.log("charts — stated totals restored from the facts; shares only of a stated whole");
await test("Pacific's recorded donut (no total) gets FY2024 revenue back from the facts", () => {
  const donut = { layoutType: "donut_chart", layoutData: { unit: "$", totalLabel: "FY2024 Total Revenue", data: [
    { name: "Linehaul", value: 13560000 }, { name: "Dedicated", value: 8410000 }, { name: "Warehousing", value: 6720000 }, { name: "Brokerage", value: 2330000 },
  ] } };
  const amounts = factAmounts({ annualRevenue: "$31,020,000", revenueByYear: { "2024": "$31,020,000" }, _brokerPrivateNotes: "$1" });
  const out = withStatedChartTotal(donut, amounts);
  assert.equal((out.layoutData as any).total, 31020000);
  const t = text(renderToStaticMarkup(React.createElement(PieChartRenderer as any, { layoutData: out.layoutData, content: "", branding: {}, section: { layoutType: "donut_chart" } })));
  assert.match(t, /FY2024 Total Revenue \$31,020,000/);
  assert.match(t, /Linehaul \$13,560,000 \(43\.7%\)/);
});
await test("no fact states the whole: the chart is left with values only", () => {
  const donut = { layoutType: "donut_chart", layoutData: { unit: "$", totalLabel: "Total", data: [{ name: "A", value: 1295000 }, { name: "B", value: 555000 }] } };
  assert.equal(withStatedChartTotal(donut, factAmounts({ annualRevenue: "$2,400,000" })), donut);
});
await test("the buyer's CIM gets the same total (buildBuyerCim)", () => {
  const section: any = { id: "s", dealId: "d", sectionKey: "mix", sectionTitle: "Mix", order: 1, layoutType: "pie_chart", isVisible: true, aiLayoutReasoning: "r",
    layoutData: { unit: "$M", totalLabel: "Revenue", data: [{ name: "A", value: 4.5 }, { name: "B", value: 2.35 }] } };
  const cim = buildBuyerCim({ deal: { id: "d", businessName: "X Co", extractedInfo: { annualRevenue: "$6.85M" } }, accessLevel: "loi", sections: [section], overrides: [] });
  assert.equal((cim.sections[0].layoutData as any).total, 6.85);
});
await test("a unit-less 60 / 40 split keeps its shares", () => {
  assert.deepEqual(chartShares([60, 40], undefined, undefined), { shares: [60, 40], total: null, asBars: false });
  assert.deepEqual(chartShares([60, 30], undefined, undefined), { shares: null, total: null, asBars: false });
  assert.deepEqual(chartShares([600, 400], undefined, undefined), { shares: null, total: null, asBars: false });
});
await test("a long donut centre figure is set smaller so it stays inside the hole", () => {
  const h = renderToStaticMarkup(React.createElement(PieChartRenderer as any, { layoutData: { unit: "$", centerValue: "$31,020,000", centerLabel: "Total Revenue", data: [{ name: "A", value: 1 }, { name: "B", value: 2 }] }, content: "", branding: {}, section: { layoutType: "donut_chart" } }));
  assert.match(h, /class="[^"]*text-sm[^"]*">\$31,020,000</);
});
await test("slices short of the stated total are drawn as bars with their share of it", () => {
  const h = renderToStaticMarkup(React.createElement(PieChartRenderer as any, { layoutData: { unit: "$", totalLabel: "FY2024 Total Revenue", total: 31020000, data: [{ name: "Linehaul", value: 13560000 }, { name: "Dedicated", value: 8410000 }] }, content: "", branding: {}, section: { layoutType: "donut_chart" } }));
  assert.match(h, /data-testid="percent-bars"/);
  assert.match(text(h), /FY2024 Total Revenue \$31,020,000 Linehaul \$13,560,000 \(43\.7%\) Dedicated \$8,410,000 \(27\.1%\)/);
});

// ── Small items ──────────────────────────────────────────────────────────
console.log("small items — regenerate dialogs and the hold wording");
await test("expired links don't count as buyers who can open the CIM (dialogs = server)", () => {
  const n = new Date("2026-09-26T12:00:00Z");
  assert.equal(openBuyerLinks([{ revokedAt: null, expiresAt: null }, { revokedAt: null, expiresAt: new Date("2026-09-01") }, { revokedAt: new Date(), expiresAt: null }] as any, n), 1);
  assert.match(src("server/routes/cim-builder.ts"), /buyers: \{ total: openBuyerLinks\(buyers\), byLevel \}/);
  assert.equal(regenerateBuyerImpact({ isLive: false, openBuyers: 0, approved: false }), null);
});
await test("the hold says what it replaced: buyers' CIM, the live one, or an approved one", () => {
  assert.equal(heldReplacedText({ buyers: 13, wasLive: true }), "It was regenerated and replaced the one 13 buyers could open.");
  assert.equal(heldReplacedText({ buyers: 0, wasLive: true }), "It was regenerated and replaced the live one.");
  assert.match(heldReplacedText({ buyers: 0, wasLive: false }), /replaced the approved one/);
  assert.doesNotMatch(heldReplacedText({ buyers: 0, wasLive: false }), /buyers could open/);
});

console.log(`f-cim-r2: ${passed} passed`);
process.exit(0);
