/**
 * While a live deal's regenerated CIM waits for the broker, every buyer path
 * reads the version last published (Beacon rebuild 2026-09-28: 12 buyers,
 * a due-diligence buyer among them, were shut out until re-publishing).
 * Storage stubbed, copies in memory (no database, no AI).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/published-snapshot.test.ts
 */
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { _setSnapshotStoreForTests, buyerCimRows, buyerSectionsForAnalytics, memorySnapshotStore, takePublishedSnapshot } from "../../server/cim/published-snapshot";
import { buildBuyerCim, cimHeldFromBuyers, ndaBlocksBuyer, realSectionKeyMap, servesPublishedSnapshot, blindSectionKey } from "../../shared/cim-buyer-view";
import { computeNextStep } from "../../shared/deal-progress";
import { approvalsWithdrawnByChange } from "../../shared/cim-approvals";

const store = memorySnapshotStore();
_setSnapshotStoreForTests(store);
const dealId = "deal-beacon";
const sec = (id: string, title: string, body: string, extra: Record<string, unknown> = {}) => ({
  id, dealId, sectionKey: title.toLowerCase().replace(/\W+/g, "_"), sectionTitle: title, order: Number(id.replace(/\D/g, "")) || 1,
  layoutType: "prose_highlight", layoutData: { body }, aiDraftContent: body, brokerEditedContent: null, isVisible: true, accessTier: "teaser",
  // (Approved: on a live CIM only approved sections reach buyers — shared/cim-published.ts.)
  blindStaleAt: null, ddStaleAt: null, aiTask: null, aiLayoutReasoning: "", brokerApproved: true, ...extra,
});
const published = [
  sec("p1", "Pharmacy Overview", "Beacon Specialty Pharmacy serves 14 long-term-care homes in Ottawa."),
  sec("p2", "Financial Summary", "Revenue $9,120,400; adjusted EBITDA $780,052."),
  sec("p3", "Growth", "New homes signed.", { blindStaleAt: new Date().toISOString() }),
];
const blind = [
  { id: "b1", dealId, cimSectionId: "p1", mode: "blind", layoutData: { body: "The pharmacy serves 14 long-term-care homes in Eastern Ontario." }, contentOverride: "The pharmacy serves 14 long-term-care homes in Eastern Ontario." },
  { id: "b2", dealId, cimSectionId: "p2", mode: "blind", layoutData: { body: "Revenue $9,120,400; adjusted EBITDA $780,052." }, contentOverride: null },
  { id: "b3", dealId, cimSectionId: "p3", mode: "blind", layoutData: { body: "New homes signed." }, contentOverride: null },
];
const dd = [{ id: "d1", dealId, cimSectionId: "p2", mode: "dd", layoutData: { body: "Revenue $9,120,400 [[dd]]T2 ties[[/dd]]." }, contentOverride: null }];
const draft = [sec("n1", "Draft Overview", "UNREVIEWED DRAFT naming Helen Park.")];

const s = storage as any;
let current: any[] = published;
let currentOverrides: Record<string, any[]> = { blind, dd };
s.getCimSectionsByDeal = async () => current;
s.getCimSectionOverrides = async (_d: string, mode: string) => currentOverrides[mode] ?? [];

const deal: any = {
  id: dealId, businessName: "Beacon Specialty Pharmacy", blindCodename: "Project Drift", isLive: true, ndaRequired: true,
  extractedInfo: { businessName: "Beacon Specialty Pharmacy", ownerName: "Helen Park", city: "Ottawa" },
  cimGeneration: null,
};

// 1. The published version is kept before the regeneration replaces it.
await takePublishedSnapshot(deal);
current = draft;
currentOverrides = {};
deal.cimGeneration = { status: "done", buyerHold: { since: "2026-09-28T21:00:00Z", wasLive: true, buyers: 12, ddCleared: true, servingPublished: true } };
assert.ok(servesPublishedSnapshot(deal));
assert.equal(cimHeldFromBuyers(deal), false, "no 'being updated' notice");

// 2. Every access level reads the kept copy, never the draft.
for (const level of ["teaser", "full", "loi", "due_diligence"]) {
  const rows = await buyerCimRows(deal, level);
  assert.equal(rows.fromSnapshot, true);
  const cim = buildBuyerCim({ deal, accessLevel: level, sections: rows.sections as any, overrides: rows.overrides as any, media: [] });
  const text = JSON.stringify(cim.sections);
  assert.doesNotMatch(text, /UNREVIEWED DRAFT/, `${level}: never the draft`);
  if (level === "teaser" || level === "full") {
    // Blind: identity guard and freshness still apply to the kept copy.
    assert.doesNotMatch(text, /Beacon|Helen|Ottawa/, `${level}: nothing identifying`);
    assert.equal(cim.sections.length, 2, `${level}: the stale blind section is held back`);
    assert.equal(cim.heldBack, 1);
    assert.ok(cim.sections.every((x) => /^s_/.test(x.sectionKey)), "neutral keys");
  } else if (level === "due_diligence") {
    assert.match(text, /T2 ties/, "the DD buyer keeps the due-diligence version");
    assert.equal(cim.sections.length, 3);
  } else {
    assert.match(text, /Beacon Specialty Pharmacy serves/, "LOI: the named CIM as published");
  }
}
console.log("  ✓ every buyer version reads the kept copy (Blind guarded, DD kept)");

// 3. The NDA gate is the same rule, before anything.
assert.ok(ndaBlocksBuyer(deal, { ndaSigned: false }));

// 4. Analytics from a blind view map back to the kept sections.
const map = realSectionKeyMap(await buyerSectionsForAnalytics(deal));
assert.equal(map.get(blindSectionKey("p1")), "pharmacy_overview");
assert.equal(map.get(blindSectionKey("n1")), "draft_overview", "and the draft's, once published");
console.log("  ✓ analytics keys resolve for the kept copy");

// 5. The broker's next step and the approvals follow the pending update.
assert.match(computeNextStep({ id: dealId, phase: "phase4_design_finalization", isLive: true, cimGeneration: deal.cimGeneration } as any).label, /review and publish the updated CIM/);
assert.deepEqual(approvalsWithdrawnByChange({ isLive: true, designApprovedByBroker: true, cimGeneration: deal.cimGeneration }), { designApprovedByBroker: false }, "an edit to the draft withdraws its approvals");
assert.deepEqual(approvalsWithdrawnByChange({ isLive: true, designApprovedByBroker: true }), {}, "a live CIM with no pending update: unchanged");
console.log("  ✓ the broker is told to review and publish the update");

// 6. A missing copy fails closed; no hold = the live rows.
store.rows.delete(dealId);
const missing = await buyerCimRows(deal, "loi");
assert.equal(missing.missing, true);
assert.deepEqual(missing.sections, []);
deal.cimGeneration = { status: "done" };
current = published;
const liveRows = await buyerCimRows(deal, "loi");
assert.equal(liveRows.fromSnapshot, false);
assert.equal(liveRows.sections.length, 3);
// A deal taken off live serves no copy (the publish gate refuses it anyway).
deal.cimGeneration = { status: "done", buyerHold: { since: "x", wasLive: true, buyers: 12, ddCleared: false, servingPublished: true } };
deal.isLive = false;
assert.equal(servesPublishedSnapshot(deal), false);
console.log("  ✓ a missing copy serves nothing; without a pending update buyers read the live CIM");

_setSnapshotStoreForTests(null);
console.log("published-snapshot: all passed");
process.exit(0);
