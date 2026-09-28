/**
 * Follow-ups from the live smoke test of 2026-09-27 (scratchpad
 * harvest/smoke-results.json → defects), proved on the recorded data:
 *   D1 — the broker's AI-session notes are labelled as their notes, not "Broker edit".
 *   D2 — a section changed after approval withdraws the approvals and holds publishing.
 *   D3 — a long source read in parts keeps its headline summary; row-range prose stays out of the summary (facts are kept as written — round 3).
 *   D5 — a regenerated section's relatedSections point at real sections; share slices rank largest first.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/smoke-followups.test.ts
 */
import "./react-global";
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { BROKER_SESSION_SOURCE_NOTE, describeSource } from "../../server/interview/info-merger";
import { buildInformationView } from "../../server/information/view";
import { sourceChipText } from "../../client/src/components/information/source-kinds";
import {
  approvalsWithdrawnByChange,
  editNeedsReapproval,
  publishReadiness,
  sectionsAwaitingApproval,
} from "../../shared/cim-approvals";
import {
  approveSectionsWithDesign,
  sectionsBlockingPublish,
  sectionsNeedApprovalResponse,
  withdrawApprovalsAfterChange,
} from "../../server/cim/approvals";
import { CIM_FALLBACK_REASONING } from "../../shared/cim-layouts";
import {
  combineExtractions,
  combinePartSummaries,
  isRowRangeDescription,
  stripPartLabel,
} from "../../server/documents/extractor";
import { reconcileRelatedSections, resolveRelatedKey } from "../../server/cim/related-sections";
import { orderShareSlices } from "../../shared/cim-chart-values";
import { finalizeLayoutData, writeOneSection, _setAnthropicForTests } from "../../server/cim/layout-engine";

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

// ── D1 ─────────────────────────────────────────────────────────────────────
console.log("D1 — the broker's AI-session notes are their notes, not an edit");

// Recorded in S2 (Maple & Main clone): three facts from the broker's own session.
const AT = "2026-09-28T02:56:40.000Z";
const sessionSrc = { source: "broker" as const, note: BROKER_SESSION_SOURCE_NOTE, sessionId: "6e382076-2967-45ea-9710-dbb79a25a862", turn: 1, at: AT };
const editSrc = { source: "broker" as const, at: AT };

await test("describeSource names the session notes (never 'Broker edit')", () => {
  const label = describeSource(sessionSrc);
  assert.equal(label, "Your notes · your AI interview session · turn 1");
  assert.doesNotMatch(label, /Broker edit/);
  // A real edit keeps its label.
  assert.match(describeSource(editSrc), /^Broker edit · /);
});

await test("the Information tab marks them as session notes, and the chip says so", () => {
  const deal = {
    id: "d-maple",
    extractedInfo: {
      farmersMarketCashTracking: "Cash sales tracked in a notebook at the stall; 2025 recorded figure $15,640.",
      walkInCompressorStatus: "Compressor original from 2011; likely needs replacement within 1–2 years.",
      leaseExpiry: "2029-04-30",
      _fieldSources: { farmersMarketCashTracking: sessionSrc, walkInCompressorStatus: { ...sessionSrc, turn: 2 }, leaseExpiry: editSrc },
    },
  };
  const view = buildInformationView({ deal, documents: [], sessions: [] } as any);
  const facts = view.sections.flatMap((s: any) => s.facts);
  const note = facts.find((f: any) => f.key === "farmersMarketCashTracking");
  const edit = facts.find((f: any) => f.key === "leaseExpiry");
  assert.ok(note && edit);
  assert.equal(note.source.label, "Your notes · your AI interview session · turn 1");
  assert.equal(note.source.brokerSessionNotes, true);
  assert.equal(note.brokerEdited, false);
  assert.equal(sourceChipText(note.source), "You · session notes");
  assert.ok(!edit.source.brokerSessionNotes);
  assert.match(sourceChipText(edit.source), /^You · edited/);
});

// ── D2 ─────────────────────────────────────────────────────────────────────
console.log("D2 — a section changed after approval needs approving again before publishing");

// The Pacific clone in S4: both design approvals, 27 sections all ticked,
// then "Revenue by Service Line" regenerated (its tick reset).
const TITLES = [
  "Pacific Coast Logistics Ltd.", "Investment Highlights", "Executive Summary", "Business Model & Service Lines",
  "Revenue by Service Line", "Historical Financial Performance", "EBITDA Normalization & Adjustments",
  "Revenue Growth Trajectory", "Customer Diversification", "Anchor Customer: Alderbrook Grocery",
  "Fleet Assets & Composition", "Warehouse & Cross-Dock Facility", "Truck Yard & Maintenance Shop", "Locations",
  "Organization & Key Personnel", "Driver Workforce & Retention", "Safety & Compliance Record",
  "Capital Expenditures & Fleet Replacement", "Growth Opportunities", "Competitive Advantages",
  "Technology & Systems", "Regulatory & Operating Authorities", "Reason for Sale", "Transition & Continuity Plan",
  "Ideal Buyer Profile", "Transaction Structure & Assets", "Next Steps & Contact",
];
const KEYS = [
  "cover_page", "investment_highlights", "executive_summary", "business_overview", "revenue_breakdown",
  "financial_performance", "ebitda_normalization", "revenue_trend", "customer_concentration", "alderbrook_relationship",
  "fleet_composition", "warehouse_facility", "yard_shop_facility", "locations", "team_structure", "driver_workforce",
  "safety_compliance", "capex_fleet_replacement", "growth_opportunities", "competitive_strengths", "technology_systems",
  "regulatory_compliance", "reason_for_sale", "transition_support", "ideal_buyer_profile", "transaction_structure", "next_steps",
];
const pacificSections = () =>
  TITLES.map((t, i) => ({
    id: `s${i}`,
    dealId: "d-pac",
    sectionKey: KEYS[i],
    sectionTitle: t,
    order: i,
    isVisible: true,
    brokerApproved: true,
    aiLayoutReasoning: "r",
    contentHistory: [] as unknown[],
  }));
const approvedDeal = () => ({
  id: "d-pac",
  isLive: false,
  phase: "phase4_design_finalization",
  contentApprovedByBroker: true,
  contentApprovedBySeller: true,
  designApprovedByBroker: true,
  designApprovedBySeller: true,
});

await test("replay S4: the regenerated donut is listed as needing approval and publishing is not ready", () => {
  const sections = pacificSections();
  const donut = sections[4];
  donut.brokerApproved = false;
  donut.contentHistory = [{ at: "2026-09-28T03:03:31.045Z", reason: "Regenerated with AI" }];
  const before = publishReadiness(approvedDeal(), pacificSections());
  assert.equal(before.ready, true, "all 27 approved: ready");
  const r = publishReadiness(approvedDeal(), sections);
  assert.equal(r.ready, false);
  assert.equal(r.brokerApproved, false);
  assert.deepEqual(r.awaiting, [{ id: "s4", title: "Revenue by Service Line", lastChange: "Regenerated with AI" }]);
});

await test("a change withdraws the design approvals (and content approvals only before Design); never on a live CIM", () => {
  assert.deepEqual(approvalsWithdrawnByChange(approvedDeal()), { designApprovedByBroker: false, designApprovedBySeller: false });
  assert.deepEqual(approvalsWithdrawnByChange({ ...approvedDeal(), phase: "phase3_content_creation", designApprovedByBroker: false, designApprovedBySeller: false }), {
    contentApprovedByBroker: false,
    contentApprovedBySeller: false,
  });
  assert.deepEqual(approvalsWithdrawnByChange({ ...approvedDeal(), isLive: true }), {});
  assert.deepEqual(approvalsWithdrawnByChange({ isLive: false, phase: "phase4_design_finalization" }), {});
});

await test("which edits need re-approval: content and showing a hidden section — not a re-save, a hide, a tier or the tick", () => {
  const s = { isVisible: true, sectionTitle: "Revenue", layoutData: { data: [{ name: "A", value: 1 }], unit: "$" }, brokerEditedContent: null, layoutType: "donut_chart" };
  assert.equal(editNeedsReapproval(s, { brokerEditedContent: "New words" }), true, "the broker's own edit");
  assert.equal(editNeedsReapproval(s, { sectionTitle: "Revenue by line" }), true);
  assert.equal(editNeedsReapproval(s, { layoutType: "pie_chart" }), true);
  assert.equal(editNeedsReapproval(s, { layoutData: { unit: "$", data: [{ value: 1, name: "A" }] } }), false, "same data, other key order");
  assert.equal(editNeedsReapproval(s, { layoutData: { unit: "$", data: [{ value: 2, name: "A" }] } }), true);
  assert.equal(editNeedsReapproval(s, { isVisible: false }), false);
  assert.equal(editNeedsReapproval({ ...s, isVisible: false }, { isVisible: true }), true);
  assert.equal(editNeedsReapproval(s, { accessTier: "full" }), false);
  assert.equal(editNeedsReapproval(s, { brokerApproved: true }), false);
});

await test("hidden sections and placeholders are not listed (placeholders have their own gate)", () => {
  const list = sectionsAwaitingApproval([
    { id: "a", sectionTitle: "Hidden", isVisible: false, brokerApproved: false },
    { id: "b", sectionTitle: "Placeholder", isVisible: true, brokerApproved: false, aiLayoutReasoning: CIM_FALLBACK_REASONING },
    { id: "c", sectionTitle: "Edited", isVisible: true, brokerApproved: false, contentHistory: [{ reason: "Edited" }] },
  ]);
  assert.deepEqual(list, [{ id: "c", title: "Edited", lastChange: "Edited" }]);
});

// Server side, with storage stubbed.
const st = storage as any;
let dealRow: any;
let rows: any[];
st.getDeal = async (id: string) => (id === dealRow?.id ? { ...dealRow } : undefined);
st.updateDeal = async (_id: string, u: any) => Object.assign(dealRow, u);
st.getCimSectionsByDeal = async () => rows.map((r) => ({ ...r }));
st.updateCimSection = async (id: string, u: any) => Object.assign(rows.find((r) => r.id === id), u);

await test("withdrawApprovalsAfterChange clears the approvals the change voids (Pacific clone, not live)", async () => {
  dealRow = approvedDeal();
  const cleared = await withdrawApprovalsAfterChange("d-pac");
  assert.deepEqual(cleared.sort(), ["designApprovedByBroker", "designApprovedBySeller"]);
  assert.equal(dealRow.designApprovedByBroker, false);
  assert.equal(dealRow.designApprovedBySeller, false);
  assert.equal(dealRow.contentApprovedByBroker, true, "content approvals are history once in Design");
  dealRow = { ...approvedDeal(), isLive: true };
  assert.deepEqual(await withdrawApprovalsAfterChange("d-pac"), []);
  assert.equal(dealRow.designApprovedByBroker, true);
});

await test("the publish gate holds a CIM approved before a section changed; the broker's design approval ticks every shown section", async () => {
  dealRow = approvedDeal();
  rows = pacificSections();
  rows[4].brokerApproved = false;
  rows.push({ id: "hid", dealId: "d-pac", sectionKey: "x", sectionTitle: "Hidden draft", isVisible: false, brokerApproved: false });
  rows.push({ id: "ph", dealId: "d-pac", sectionKey: "y", sectionTitle: "Couldn't write", isVisible: true, brokerApproved: false, aiLayoutReasoning: CIM_FALLBACK_REASONING });
  const awaiting = await sectionsBlockingPublish("d-pac");
  assert.deepEqual(awaiting.map((a) => a.title), ["Revenue by Service Line"]);
  const body = sectionsNeedApprovalResponse(awaiting);
  assert.equal(body.code, "sections_need_approval");
  assert.match(body.error, /One section hasn't been approved as it stands \("Revenue by Service Line"\)/);
  const ticked = await approveSectionsWithDesign("d-pac");
  assert.equal(ticked, 1);
  assert.equal(rows[4].brokerApproved, true);
  assert.equal(rows.find((r) => r.id === "hid").brokerApproved, false, "hidden stays as it was");
  assert.equal(rows.find((r) => r.id === "ph").brokerApproved, false, "a placeholder is never approved");
  assert.deepEqual(await sectionsBlockingPublish("d-pac"), []);
});

await test("every change path withdraws the approvals and resets the section's tick (wiring)", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
  const tasks = read("server/cim/section-tasks.ts");
  assert.match(tasks, /if \(!hide && row\.isVisible !== false\) await withdrawApprovalsAfterChange\(deal\.id\);/, "regenerate / write / convert");
  assert.match(tasks, /if \(updated && updated\.isVisible !== false\) await withdrawApprovalsAfterChange\(section\.dealId\);/, "apply rewrite");
  const ops = read("server/cim/section-ops.ts");
  assert.match(ops, /if \(reapprove && approved === undefined\) set\.brokerApproved = false;/, "broker edit resets the tick");
  assert.match(ops, /if \(reapprove && updated\.isVisible !== false\) await withdrawApprovalsAfterChange\(section\.dealId\);/, "broker edit / unhide");
  assert.match(ops, /brokerApproved: false,\n      updatedAt: new Date\(\),\n    \}\)\n    \.where\(eq\(cimSections\.id, section\.id\)\)\n    \.returning\(\);\n  const at = await invalidateBlind\(section\.dealId, \[section\.id\]\);\n  if \(updated && updated\.isVisible !== false\) await withdrawApprovalsAfterChange/, "undo");
  assert.match(ops, /if \(created\.isVisible !== false\) await withdrawApprovalsAfterChange\(section\.dealId\);/, "duplicate");
  const builder = read("server/routes/cim-builder.ts");
  assert.match(builder, /if \(created\.isVisible !== false\) await withdrawApprovalsAfterChange\(deal\.id\);/, "add section");
  assert.match(builder, /brokerApproved: false,\n            updatedAt: new Date\(\),[\s\S]{0,300}withdrawApprovalsAfterChange\(deal\.id\)/, "layout change");
  const media = read("server/routes/cim-media.ts");
  assert.match(media, /brokerApproved: false, updatedAt[\s\S]{0,400}withdrawApprovalsAfterChange\(deal\.id\)/, "removed photo");
  const routes = read("server/routes.ts");
  assert.match(routes, /sectionsBlockingPublish\(req\.params\.id\)/, "publish gate");
  assert.match(routes, /approveSectionsWithDesign\(req\.params\.id\)/, "design approval ticks");
  assert.equal((routes.match(/withdrawApprovalsAfterChange\(dealId\)/g) ?? []).length, 2, "both generate-content single-section paths");
});

// ── D3 ─────────────────────────────────────────────────────────────────────
console.log("D3 — a long source read in parts keeps its headline");

// The five part reads recorded in S3 (Lakeshore clone, Comfort Club report,
// 293,222 characters), as combined on the live build.
const PARTS = [
  "Part 2 of 5 of a customer membership database showing member IDs CC-10620 through CC-11280, with membership tiers (Silver/Gold), billing types (Monthly/Annual prepaid), pricing ($22.95 or $32.95), locations across Hamilton region, join dates from May 2018 through March 2021, status, and most recent activity dates through March 2025.",
  "Customer list showing Comfort Club memberships with subscription IDs, membership tiers (Silver/Gold), billing frequencies (Monthly/Annual), pricing ($22.95 Silver, $32.95 Gold), locations across Hamilton region, join dates from February 2021 through February 2023, acquisition channels (all Organic), membership statuses, and last payment dates through March 2025.",
  "Part 4 of customer membership database showing individual customer records from February 2023 through November 2023, including a large acquisition book from Pembury Furnace Services dated July 1, 2023. Records include membership ID, tier (Silver/Gold), billing type (Monthly/Annual prepaid), pricing, location, acquisition source, status, and customer age category.",
  "Part 5 of customer database showing member records from November 2023 through March 2025, including membership tier (Silver/Gold), billing frequency (Monthly/Annual prepaid), pricing, location, join date, status, and last activity dates.",
  "Lakeshore Home Comfort Ltd. Comfort Club membership report as at March 31, 2025, exported from field-service software by Denise Tran. Shows 2,900 active members generating $75,835 monthly recurring revenue ($910,020 annualized).",
];
const PART4_CUSTOMER_BASE =
  "Customer membership records from February 2023 through November 2023. Major customer book acquisition from Pembury Furnace Services on July 1, 2023. Geographic concentration in Hamilton area with surrounding municipalities. Customer age distribution across all tenure bands from new (0-5 years) to long-term (16+ years).";

await test("replay S3: the combined summary leads with the headline and carries no 'Part N of M' or row ranges", () => {
  const combined = combineExtractions([
    { summary: PARTS[0], _documentType: "Customer database" } as any,
    { summary: PARTS[1] } as any,
    { summary: PARTS[2], customerBase: PART4_CUSTOMER_BASE } as any,
    { summary: PARTS[3] } as any,
    { summary: PARTS[4], _periodEnd: "2025-03-31", revenue: "$801,000" } as any,
  ]);
  const summary = String(combined.summary);
  assert.ok(summary.startsWith("Lakeshore Home Comfort Ltd. Comfort Club membership report as at March 31, 2025"), summary);
  assert.match(summary, /2,900 active members generating \$75,835 monthly recurring revenue \(\$910,020 annualized\)/);
  assert.doesNotMatch(summary, /\bPart \d/);
  assert.doesNotMatch(summary, /CC-10620|through November 2023|from May 2018/);
  // Round 3 (conservative tidy-up): the business fact is kept word for word.
  // This assertion used to expect the "Customer membership records from
  // February 2023 through November 2023." sentence dropped — the fact-deletion
  // behaviour the integrator removed (a misfire there lost real facts).
  assert.equal(combined.customerBase, PART4_CUSTOMER_BASE);
  assert.equal(combined.revenue, "$801,000");
});

await test("row-range prose is recognised; a headline with figures never is", () => {
  for (const p of PARTS.slice(0, 4)) assert.equal(isRowRangeDescription(p), true, p.slice(0, 60));
  assert.equal(isRowRangeDescription(PARTS[4]), false);
  assert.equal(isRowRangeDescription("Income statement records revenue from $1.2M to $1.4M between 2023 and 2024."), false, "figures about the business");
  assert.equal(isRowRangeDescription("Customer membership records from February 2023 through November 2023."), true);
  // Round 2: a bare "Part 4 of …" is only a label in part 4's own row prose
  // ("Part 2 of the lease requires…" is a fact — smoke-followups-r2 test 2).
  assert.equal(
    stripPartLabel("Part 4 of customer membership database showing member records from February 2023 through November 2023.", { lead: true, part: 4 }),
    "Customer membership database showing member records from February 2023 through November 2023.",
  );
  assert.equal(stripPartLabel("Part 1 of 5: Comfort Club report as at March 31, 2025."), "Comfort Club report as at March 31, 2025.");
  // A business fact's own "part 2 of the lease" is not a label.
  assert.equal(stripPartLabel("Renewal is set out in part 2 of the lease.", { total: 5, lead: false }), "Renewal is set out in part 2 of the lease.");
  // Round 3 (conservative tidy-up): a fact is never blanked for its wording —
  // this assertion used to expect "" (the dropped fact-deletion behaviour).
  assert.equal(stripPartLabel("Member records CC-11264 through CC-11929.", { total: 5, lead: false }), "Member records CC-11264 through CC-11929.");
});

await test("no part states a headline: one short description, never a list of part labels", () => {
  const s = combinePartSummaries([PARTS[0], PARTS[3]]);
  assert.doesNotMatch(s, /\bPart \d/);
  assert.ok(s.startsWith("Customer membership database showing member IDs"), s);
  assert.ok(!s.includes("November 2023 through March 2025"), "only one row description kept");
  // Plain multi-year returns keep their order (existing behaviour).
  assert.equal(combinePartSummaries(["2022 return.", "2023 return.", "2024 return."]), "2022 return. 2023 return. 2024 return.");
});

// ── D5 ─────────────────────────────────────────────────────────────────────
console.log("D5 — related links point at real sections; share slices rank largest first");

const pac = KEYS.map((k, i) => ({ sectionKey: k, sectionTitle: TITLES[i] }));
// Recorded in S4: the regenerated donut's layoutData.
const REGENERATED = {
  data: [
    { name: "Temperature-controlled (reefer) transport", color: "#2563eb", value: 8410000 },
    { name: "Dry van truckload & regional distribution", color: "#3b82f6", value: 13560000 },
    { name: "3PL warehousing, cross-dock & handling", color: "#60a5fa", value: 6720000 },
    { name: "Port of Vancouver container drayage", color: "#93c5fd", value: 2330000 },
  ],
  unit: "$",
  total: "$31,020,000",
  totalLabel: "Total Revenue",
  centerLabel: "FY2024",
  centerValue: "$31.0M",
  relatedSections: ["business_model", "revenue_growth", "customer_diversification"],
};

await test("replay S4: invented keys map to the sections they mean", () => {
  const out = reconcileRelatedSections(REGENERATED, pac, "revenue_breakdown");
  assert.deepEqual(out.relatedSections, ["business_overview", "revenue_trend", "customer_concentration"]);
  assert.equal(resolveRelatedKey("revenue_breakdown", pac, "revenue_breakdown"), null, "never a link to itself");
  assert.equal(resolveRelatedKey("zebra_crossings", pac), null, "no match → dropped");
  assert.equal(resolveRelatedKey("facility", pac), null, "two facilities → ambiguous → dropped");
  assert.equal(resolveRelatedKey("fleet_composition", pac), "fleet_composition", "a real key is kept");
  const none = reconcileRelatedSections({ ...REGENERATED, relatedSections: ["zebra"] }, pac, "revenue_breakdown");
  assert.equal("relatedSections" in none, false);
});

await test("replay S4: slices come back largest first, the palette keeps its order", () => {
  const out = finalizeLayoutData("donut_chart", REGENERATED, new Date("2026-09-28T00:00:00Z")) as any;
  assert.deepEqual(out.data.map((d: any) => d.value), [13560000, 8410000, 6720000, 2330000]);
  assert.deepEqual(out.data.map((d: any) => d.color), ["#2563eb", "#3b82f6", "#60a5fa", "#93c5fd"]);
  assert.equal(out.data[0].name, "Dry van truckload & regional distribution");
  // "Other" stays last; an ordered scale keeps its order; bars are untouched.
  const other = orderShareSlices("pie_chart", { data: [{ name: "Other", value: 50 }, { name: "A", value: 10 }, { name: "B", value: 40 }] }) as any;
  assert.deepEqual(other.data.map((d: any) => d.name), ["B", "A", "Other"]);
  const bands = { data: [{ name: "0-5 yrs", value: 10 }, { name: "6-10 yrs", value: 40 }, { name: "11+ yrs", value: 50 }] };
  assert.deepEqual(orderShareSlices("donut_chart", bands), bands);
  const bars = { data: [{ name: "A", value: 1 }, { name: "B", value: 9 }] };
  assert.deepEqual(orderShareSlices("bar_chart", bars), bars);
});

await test("a single-section write reconciles the links and orders the slices (recorded model output replayed)", async () => {
  const params = {
    dealId: "d-pac",
    businessName: "Pacific Coast Logistics Ltd.",
    industry: "Transportation & Logistics",
    askingPrice: "$18,000,000",
    extractedInfo: {
      annualRevenue: "$31,020,000",
      reeferTransportRevenueByYear: { "2024": "$8,410,000" },
      dryVanRevenueByYear: { "2024": "$13,560,000" },
      warehousingRevenueByYear: { "2024": "$6,720,000" },
      drayageRevenueByYear: { "2024": "$2,330,000" },
    },
    today: new Date("2026-09-28T03:00:00Z"),
  };
  const prompts: string[] = [];
  _setAnthropicForTests({
    messages: {
      stream: (body: any) => {
        prompts.push(JSON.stringify(body.system));
        return { finalMessage: async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_section", input: { layoutData: REGENERATED } }] }) };
      },
    },
  } as any, 1);
  try {
    const existing = pac.map((s, i) => ({ ...s, order: i, layoutType: i === 4 ? "donut_chart" : "prose_highlight", tags: [], aiLayoutReasoning: "r" }));
    const out: any = await writeOneSection(params as any, existing, existing[4]);
    assert.deepEqual(out.layoutData.relatedSections, ["business_overview", "revenue_trend", "customer_concentration"]);
    assert.deepEqual(out.layoutData.data.map((d: any) => d.value), [13560000, 8410000, 6720000, 2330000]);
    // The writer is shown the real keys to link to.
    assert.match(prompts[0], /Revenue Growth Trajectory \[sectionKey: revenue_trend\]/);
  } finally {
    _setAnthropicForTests(null);
  }
});

console.log(`\n${passed} passed`);
