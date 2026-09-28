/**
 * Free round 2 — a live CIM's buyers get only approved content (C1), the
 * asking price when it is removed (C7), a duplicated section keeps its
 * figure flags (C9), and a live CIM whose design flags were never set isn't
 * shown as unapproved (r3-live-flags-false-buttons).
 */
import assert from "node:assert/strict";
import { buildBuyerCim, withoutAskingPrice } from "../../shared/cim-buyer-view";
import { PUBLISHED_BLIND_MODE, PUBLISHED_DD_MODE, PUBLISHED_MODE, publishedOverrideOf, publishedSectionOf, servedVersions } from "../../shared/cim-published";
import { defaultLayoutData, hasSampleData, sampleDataIn } from "../../shared/cim-layouts";
import { publishReadiness, sectionsApprovedWithDesign, sectionsAwaitingApproval } from "../../shared/cim-approvals";
import { designApprovalState, phaseChecklist } from "../../shared/deal-progress";
import { duplicateSectionFields } from "../../server/cim/section-ops";

const LIVE = { id: "d", businessName: "Pacific Coast Logistics", isLive: true, extractedInfo: {} };
const OLD = new Date("2026-09-20T00:00:00Z");
const NOW = new Date("2026-09-30T00:00:00Z");

function section(o: Record<string, unknown> = {}): any {
  return {
    id: "s1", dealId: "d", sectionKey: "revenue_by_customer", sectionTitle: "Revenue by customer", order: 1,
    layoutType: "horizontal_bar_chart", layoutData: { data: [{ name: "Customer A", value: 22 }, { name: "Customer B", value: 9 }], unit: "%" },
    aiDraftContent: "The largest customer is 22% of revenue.", brokerEditedContent: null, aiLayoutReasoning: "", isVisible: true,
    brokerApproved: true, blindStaleAt: null, ddStaleAt: null, blindTitle: "Revenue by customer", aiTask: null, accessTier: "teaser",
    contentHistory: [{ at: NOW.toISOString(), reason: "x", approvalRule: true }], updatedAt: NOW, ...o,
  };
}
const approved = section();
const rec = (mode: string, data: unknown) => ({ id: `${mode}-1`, dealId: "d", cimSectionId: "s1", mode, layoutData: data, contentOverride: null, createdAt: NOW }) as any;
const published = [
  rec(PUBLISHED_MODE, publishedSectionOf(approved, NOW)),
  rec(PUBLISHED_BLIND_MODE, publishedOverrideOf({ layoutData: { data: [{ name: "Customer A", value: 22 }, { name: "Customer B", value: 9 }], unit: "%" }, contentOverride: "The largest customer is 22% of revenue." }, "Revenue by customer", NOW)),
];

// ── The broker regenerates the section on the live CIM (unapproved AI text) ──
const regenerated = section({
  brokerApproved: false, blindStaleAt: NOW, ddStaleAt: NOW,
  layoutData: { data: [{ name: "Customer A", value: 31 }], unit: "%" }, aiDraftContent: "UNREVIEWED AI TEXT",
});
for (const level of ["loi", "due_diligence"]) {
  const cim = buildBuyerCim({ deal: LIVE, accessLevel: level, sections: [regenerated], overrides: [], published });
  assert.equal(cim.sections.length, 1, level);
  assert.equal(cim.sections[0].aiDraftContent, "The largest customer is 22% of revenue.", `${level} keeps the approved text`);
  assert.ok(!JSON.stringify(cim.sections).includes("UNREVIEWED"), level);
}
// Blind buyers keep the approved Blind version (the current override belongs to the change).
const blindNow = { id: "b", dealId: "d", cimSectionId: "s1", mode: "blind", layoutData: { data: [{ name: "Customer A", value: 31 }] }, contentOverride: "UNREVIEWED AI TEXT", createdAt: NOW } as any;
const blind = buildBuyerCim({ deal: LIVE, accessLevel: "full", sections: [regenerated], overrides: [blindNow], published });
assert.equal(blind.sections.length, 1);
assert.equal(blind.sections[0].brokerEditedContent, null);
assert.ok(!JSON.stringify(blind.sections).includes("UNREVIEWED"), "blind buyers never see the unapproved change");
assert.match(JSON.stringify(blind.sections[0].layoutData), /"value":22/);
// No approved Blind version on record → held back, never the change.
const blindHeld = buildBuyerCim({ deal: LIVE, accessLevel: "full", sections: [regenerated], overrides: [blindNow], published: [published[0]] });
assert.equal(blindHeld.sections.length, 0);
assert.equal(blindHeld.heldBack, 1);
// Approving the change serves it.
const reapproved = buildBuyerCim({ deal: LIVE, accessLevel: "loi", sections: [{ ...regenerated, brokerApproved: true }], overrides: [], published });
assert.equal(reapproved.sections[0].aiDraftContent, "UNREVIEWED AI TEXT");
// A section never approved (no record) isn't served on a live CIM.
assert.equal(buildBuyerCim({ deal: LIVE, accessLevel: "loi", sections: [regenerated], overrides: [], published: [] }).sections.length, 0);
// A section of a CIM live before the per-section rule, untouched since, is served as it stands.
const legacy = section({ brokerApproved: false, updatedAt: OLD, contentHistory: null });
assert.equal(buildBuyerCim({ deal: LIVE, accessLevel: "loi", sections: [legacy], overrides: [], published: [] }).sections.length, 1);
// Not live, or a broker preview (no records passed): as it stands.
assert.equal(buildBuyerCim({ deal: { ...LIVE, isLive: false }, accessLevel: "loi", sections: [regenerated], overrides: [], published }).sections[0].aiDraftContent, "UNREVIEWED AI TEXT");
assert.equal(buildBuyerCim({ deal: LIVE, accessLevel: "loi", sections: [regenerated], overrides: [] }).sections[0].aiDraftContent, "UNREVIEWED AI TEXT");
// DD: the approved DD version when recorded, else the approved named one.
const withDd = [...published, rec(PUBLISHED_DD_MODE, publishedOverrideOf({ layoutData: { data: [{ name: "Acme Logistics", value: 22 }], unit: "%" }, contentOverride: "[[dd]]Acme Logistics[[/dd]] is 22%." }, undefined, NOW))];
const dd = buildBuyerCim({ deal: LIVE, accessLevel: "due_diligence", sections: [regenerated], overrides: [{ id: "x", dealId: "d", cimSectionId: "s1", mode: "dd", layoutData: { body: "NEW DD" }, contentOverride: "NEW DD", createdAt: NOW } as any], published: withDd });
assert.match(JSON.stringify(dd.sections[0].layoutData), /Acme Logistics/);
assert.ok(!JSON.stringify(dd.sections).includes("NEW DD"));
// servedVersions reports which sections are on their approved version.
assert.deepEqual(servedVersions({ deal: LIVE, mode: "normal", sections: [regenerated], overrides: [], published }).kept, ["s1"]);

// ── "Start it blank": sample data never reaches buyers, can't be approved or published ──
const blank = defaultLayoutData("donut_chart", { title: "Revenue by customer" });
assert.deepEqual(sampleDataIn("donut_chart", blank), ["sample data"]);
assert.deepEqual(sampleDataIn("pie_chart", { data: [{ name: "Category A", value: 60 }, { name: "Category B", value: 40 }], total: 100 }).sort(), ["Category A", "Category B"]);
assert.deepEqual(sampleDataIn("horizontal_bar_chart", { data: [{ name: "Acme", value: 50 }, { name: "Item B", value: 30 }] }), ["Item B"]);
assert.deepEqual(sampleDataIn("scorecard", { items: [{ label: "Factor", score: 50, description: "" }, { label: "Safety", score: 92 }], maxScore: 100 }), ["Factor"]);
assert.deepEqual(sampleDataIn("metric_grid", { metrics: [{ label: "Metric", value: "—" }, { label: "Revenue", value: "$9.8M" }] }), ["Metric"]);
assert.deepEqual(sampleDataIn("bar_chart", { data: [{ name: "2023", value: 0 }, { name: "2024", value: 9815000 }] }), [], "a real chart with a zero year is not sample data");
assert.deepEqual(sampleDataIn("donut_chart", { data: [{ name: "Dry van", value: 60 }, { name: "Reefer", value: 40 }] }), []);
assert.deepEqual(sampleDataIn("prose_highlight", { body: "" }), []);
const sampleSection = section({ layoutType: "donut_chart", layoutData: blank, brokerApproved: false });
assert.equal(buildBuyerCim({ deal: { ...LIVE, isLive: false }, accessLevel: "loi", sections: [sampleSection], overrides: [] }).sections.length, 0, "never served");
assert.equal(buildBuyerCim({ deal: { ...LIVE, isLive: false }, accessLevel: "loi", sections: [{ ...sampleSection, brokerApproved: true }], overrides: [] }).sections.length, 0, "not even ticked");
assert.deepEqual(sectionsApprovedWithDesign([sampleSection]), [], "the design approval doesn't tick it");
const awaiting = sectionsAwaitingApproval([{ ...sampleSection, brokerApproved: true }], { isLive: false });
assert.equal(awaiting.length, 1);
assert.equal(awaiting[0].lastChange, "Still shows sample data");
assert.equal(publishReadiness({ designApprovedByBroker: true, designApprovedBySeller: true }, [{ ...sampleSection, brokerApproved: true }]).ready, false, "publishing waits");
assert.ok(hasSampleData(sampleSection));

// ── C7: the listed price was removed ──
const cover = { id: "c", dealId: "d", sectionKey: "cover", sectionTitle: "Cover", order: 0, layoutType: "cover_page", isVisible: true, brokerApproved: true, layoutData: { businessName: "Lakeshore Home Comfort", askingPrice: "$4,800,000" } } as any;
const keyNumbers = { id: "k", dealId: "d", sectionKey: "key", sectionTitle: "Key numbers", order: 1, layoutType: "metric_grid", isVisible: true, brokerApproved: true, layoutData: { metrics: [{ label: "Asking Price", value: "$4,800,000" }, { label: "Asking Price / SDE", value: "3.8x" }, { label: "Revenue", value: "$6.2M" }] } } as any;
const callout = { id: "p", dealId: "d", sectionKey: "price", sectionTitle: "Price", order: 2, layoutType: "stat_callout", isVisible: true, brokerApproved: true, layoutData: { primaryLabel: "Asking price", primaryValue: "$4,800,000" } } as any;
const unpriced = buildBuyerCim({ deal: { id: "d", businessName: "Lakeshore" }, accessLevel: "loi", sections: [cover, keyNumbers, callout], overrides: [], askingPrice: null });
assert.equal((unpriced.sections[0].layoutData as any).askingPrice, undefined, "cover price gone");
assert.deepEqual((unpriced.sections[1].layoutData as any).metrics.map((m: any) => m.label), ["Asking Price / SDE", "Revenue"], "the key number goes; the multiple is the staleness check's to flag");
assert.equal((unpriced.sections[2].layoutData as any).primaryValue, "Price on request");
assert.ok(!JSON.stringify(unpriced.sections).includes("4,800,000"));
// Omitted (unknown) keeps the CIM's figures; a listed price replaces them.
assert.equal((buildBuyerCim({ deal: { id: "d" }, accessLevel: "loi", sections: [cover], overrides: [] }).sections[0].layoutData as any).askingPrice, "$4,800,000");
assert.equal((buildBuyerCim({ deal: { id: "d" }, accessLevel: "loi", sections: [cover], overrides: [], askingPrice: "4500000" }).sections[0].layoutData as any).askingPrice, "$4,500,000");
// "Contact broker" on the cover isn't a price.
assert.equal((withoutAskingPrice({ layoutType: "cover_page", layoutData: { askingPrice: "Contact broker" } }).layoutData as any).askingPrice, "Contact broker");

// ── C9: a copy keeps the original's figure flags ──
const flagged = section({ figureWarnings: ['no source for "$1,633,000" (Original cost of equipment)'] });
assert.deepEqual(duplicateSectionFields(flagged, { hidden: false }).figureWarnings, flagged.figureWarnings);
assert.equal(duplicateSectionFields(section({ figureWarnings: null }), { hidden: true }).figureWarnings, null);
assert.equal(duplicateSectionFields(flagged, { hidden: true }).isVisible, false);

// ── r3: a live CIM published with no design flags isn't "unapproved" ──
const trueNorth = { isLive: true, phase: "phase4_design_finalization", designApprovedByBroker: false, designApprovedBySeller: false } as any;
assert.deepEqual(designApprovalState(trueNorth, 0), { brokerApproved: true, sellerApproved: true, ready: true });
assert.equal(designApprovalState(trueNorth, 2).brokerApproved, false, "a live CIM with changes awaiting approval still needs the broker");
assert.equal(designApprovalState({ ...trueNorth, isLive: false }, 0).brokerApproved, false);
const rows = phaseChecklist("phase4_design_finalization", trueNorth, { sectionsAwaitingApproval: 0 });
assert.ok(rows.filter((r) => /approved/i.test(r.label)).every((r) => r.done), JSON.stringify(rows));

console.log("f2-cim-live: ok");
