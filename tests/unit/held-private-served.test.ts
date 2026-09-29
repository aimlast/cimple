/**
 * PRIV-3 (final review): a staff-private matter taken out of the DRAFT can
 * still be in front of live buyers — the kept copy while a regenerated CIM
 * waits for review, or a changed section's approved version. The CIM tab
 * now scans what buyers are served, and the broker can take a section out
 * of the kept copy.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/held-private-served.test.ts
 */
import assert from "node:assert/strict";
import { memorySnapshotStore, _setSnapshotStoreForTests, buyerCimRows, withdrawFromPublishedSnapshot } from "../../server/cim/published-snapshot";
import { heldPrivateStateForDeal, servedHeldPrivateForDeal, servedRowsNotDraft, servedShowingStaffPrivate, heldPrivateForDeal } from "../../server/cim/held-private";
import { buildBuyerCim } from "../../shared/cim-buyer-view";
import { publishedSectionOf } from "../../shared/cim-published";

const KEY_EMP = "Daniel Okafor: LTC lead pharmacist since 2014 (11 years), primary contact for long-term care homes, approximately 1 year ago informally asked about buying equity stake. Mei-Lin: compounding pharmacist since 2018.";
const info = { ownerName: "Dr. Helen Park", keyEmployees: KEY_EMP, annualRevenue: "$9,120,400" };
const STAKE = "Daniel Okafor, LTC lead pharmacist since 2014, approximately a year ago informally asked about buying an equity stake in the pharmacy.";

const base: any = {
  dealId: "d1", sectionKey: "keyPersonnel", sectionTitle: "Key Personnel", layoutType: "prose_highlight", order: 1,
  brokerEditedContent: null, isVisible: true, accessTier: "teaser", blindStaleAt: null, ddStaleAt: null, updatedAt: new Date(),
};

// ── (a) the kept copy during a live CIM's review ───────────────────────
{
  const oldSection: any = { ...base, id: "old-1", layoutData: { title: "Key Personnel", body: STAKE }, aiDraftContent: STAKE, brokerApproved: true };
  const clean = "Daniel Okafor, LTC lead pharmacist since 2014, leads long-term care accounts.";
  const newDraft: any = { ...base, id: "new-1", layoutData: { title: "Key Personnel", body: clean }, aiDraftContent: clean, brokerApproved: false };
  const store = memorySnapshotStore();
  _setSnapshotStoreForTests(store);
  await store.save("d1", { sections: [oldSection], blindOverrides: [], ddOverrides: [{ id: "o1", dealId: "d1", cimSectionId: "old-1", mode: "dd", layoutData: null, contentOverride: STAKE } as any], blindCodename: "Project Coastal" });
  const deal: any = {
    id: "d1", brokerId: "b1", businessName: "Beacon Specialty Pharmacy Inc.", isLive: true, extractedInfo: info,
    cimGeneration: { status: "done", buyerHold: { since: new Date().toISOString(), wasLive: true, buyers: 12, servingPublished: true } },
  };

  // The LOI buyer is served the matter; the draft scan (as before) sees nothing.
  const rows = await buyerCimRows(deal, "loi");
  const cim = buildBuyerCim({ deal, accessLevel: "loi", sections: rows.sections, overrides: rows.overrides, media: [], askingPrice: null, published: rows.published });
  assert.ok(cim.sections.some((s: any) => /equity stake/.test(s.aiDraftContent ?? "")), "precondition: buyers read the kept copy's equity sentence");
  const draftState = heldPrivateStateForDeal(deal, [newDraft]);
  assert.equal(draftState.showing.length, 0, "precondition: the draft no longer states it");
  assert.ok(draftState.items.length > 0, "the matter is held back");

  // Now: the served scan flags it, from the kept copy.
  const served = await servedHeldPrivateForDeal(deal, [newDraft], draftState.items);
  assert.equal(served.source, "kept_copy");
  assert.deepEqual(served.showing.map((s) => s.id), ["old-1"], "the kept copy's Key Personnel is flagged");
  assert.ok(served.showing[0].descriptions.length > 0);

  // "Hide from buyers": the section leaves the kept copy; buyers stop getting it; the flag clears.
  assert.equal(await withdrawFromPublishedSnapshot("d1", "old-1"), true);
  assert.equal(await withdrawFromPublishedSnapshot("d1", "old-1"), false, "already hidden");
  const after = await buyerCimRows(deal, "dd");
  const cimAfter = buildBuyerCim({ deal, accessLevel: "dd", sections: after.sections, overrides: after.overrides, media: [], askingPrice: null, published: after.published });
  assert.ok(!cimAfter.sections.some((s: any) => /equity stake/.test(JSON.stringify(s))), "DD buyers no longer get it");
  assert.equal((await servedHeldPrivateForDeal(deal, [newDraft], draftState.items)).showing.length, 0, "no flag once hidden");
  _setSnapshotStoreForTests(null);
}

// ── (b) a live CIM section edited since its approval ───────────────────
{
  const editedText = "Daniel Okafor, LTC lead pharmacist since 2014.";
  const edited: any = { ...base, id: "s1", layoutData: { title: "Key Personnel", body: editedText }, aiDraftContent: editedText, brokerEditedContent: editedText, brokerApproved: false };
  const record: any = {
    id: "p1", dealId: "d1", cimSectionId: "s1", mode: "published", contentOverride: null,
    layoutData: publishedSectionOf({ ...edited, layoutData: { title: "Key Personnel", body: STAKE }, aiDraftContent: STAKE, brokerEditedContent: null }),
  };
  const deal: any = { id: "d1", businessName: "Beacon Specialty Pharmacy Inc.", isLive: true, extractedInfo: info, cimGeneration: null };
  const cim = buildBuyerCim({ deal, accessLevel: "loi", sections: [edited], overrides: [], media: [], askingPrice: null, published: [record] });
  assert.ok(cim.sections.some((s: any) => /equity stake/.test(s.brokerEditedContent || s.aiDraftContent || "")), "precondition: buyers read the approved version");
  assert.equal(heldPrivateStateForDeal(deal, [edited]).showing.length, 0, "precondition: the draft scan sees nothing");

  const rows = servedRowsNotDraft({ deal, draft: [edited], snapshot: null, published: [record] });
  assert.equal(rows?.source, "approved_version");
  const hits = servedShowingStaffPrivate(rows!, info, heldPrivateForDeal(deal));
  assert.deepEqual(hits.map((h) => h.id), ["s1"], "the approved version is flagged");

  // Approved as it stands → buyers read the draft, nothing extra to flag.
  assert.equal(servedRowsNotDraft({ deal, draft: [{ ...edited, brokerApproved: true }], snapshot: null, published: [record] }), null);
  // Hidden → served to nobody, nothing to flag.
  assert.equal(servedRowsNotDraft({ deal, draft: [{ ...edited, isVisible: false }], snapshot: null, published: [record] }), null);
  // Not live → buyers read nothing.
  assert.equal(servedRowsNotDraft({ deal: { ...deal, isLive: false }, draft: [edited], snapshot: null, published: [record] }), null);
}

console.log("held-private-served: all assertions passed");
process.exit(0);
