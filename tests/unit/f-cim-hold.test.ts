/**
 * F1 — "Regenerate all" on a live CIM with buyers: the new CIM must not go
 * to buyers unreviewed. Storage and the generator are stubbed (no database,
 * no AI). The whole job runs: every approval is cleared, the hold is
 * persisted (and carried by a later run), the DD clearing is reported, the
 * facts it wrote from are kept server-side only, and publishing releases
 * the hold. Since 2026-09-29 a LIVE deal stays live and its buyers keep the
 * version last published (the kept copy) until the broker publishes.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f-cim-hold.test.ts
 */
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import {
  _setGeneratorForTests,
  getCimGenerationStatus,
  getLiveCimGenerationStatus,
  lastGenerationFacts,
  listBrokerCimGeneration,
  releaseBuyerHold,
  startCimGeneration,
} from "../../server/cim/generation-jobs";
import { cimHeldFromBuyers, servesPublishedSnapshot } from "../../shared/cim-buyer-view";
import { _setSnapshotStoreForTests, memorySnapshotStore } from "../../server/cim/published-snapshot";

const snapshots = memorySnapshotStore();
_setSnapshotStoreForTests(snapshots);

const dealId = "deal-pacific-hold";
const deal: any = {
  id: dealId,
  brokerId: "b1",
  businessName: "Pacific Coast Logistics (QA)",
  industry: "Transportation",
  askingPrice: "$18,000,000",
  extractedInfo: { annualRevenue: "$31,020,000" },
  isLive: true,
  contentApprovedByBroker: true,
  contentApprovedBySeller: true,
  designApprovedByBroker: true,
  designApprovedBySeller: true,
  phase: "phase4_design_finalization",
  cimLayoutVersion: 3,
  cimGeneration: null,
};
const created: any[] = [];
const s = storage as any;
s.getDeal = async (id: string) => (id === dealId ? structuredClone(deal) : undefined);
s.updateDeal = async (_id: string, u: any) => Object.assign(deal, structuredClone(u));
s.getDocumentsByDeal = async () => [];
s.getResolvedDiscrepancies = async () => [];
s.getBrandingByBroker = async () => undefined;
s.getEngagementInsightsByIndustry = async () => [];
s.getFinancialAnalysesByDeal = async () => [];
s.getBuyerAccessByDeal = async () => Array.from({ length: 13 }, (_, i) => ({ id: `a${i}`, revokedAt: null, expiresAt: null }));
s.getCimSectionOverrides = async (_d: string, mode: string) => (mode === "dd" ? [{ id: "o1" }] : mode === "blind" ? [{ id: "b1" }] : []);
s.getCimSectionsByDeal = async () => [{ id: "old-1", sectionKey: "overview", sectionTitle: "Overview (published)", order: 1, layoutType: "prose_highlight", layoutData: { body: "old" }, isVisible: true }];
s.deleteCimSectionsForDeal = async () => undefined;
s.deleteCimSectionOverrides = async () => undefined;
s.createCimSection = async (x: any) => { created.push(x); return x; };

_setGeneratorForTests(async () => ({
  dealId,
  generatedAt: new Date().toISOString(),
  version: 1,
  sections: [{ sectionKey: "overview", sectionTitle: "Overview", order: 1, layoutType: "prose_highlight", layoutData: { body: "x" }, aiLayoutReasoning: "r", tags: [], isVisible: true, brokerApproved: false }],
  warnings: ["Check the figures in \"Overview\" before publishing — no source for \"$1\" (x)."],
}) as any);

const waitDone = async () => {
  for (let i = 0; i < 200 && getLiveCimGenerationStatus(dealId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
};

await startCimGeneration(structuredClone(deal), "layout");
await waitDone();
const job = getLiveCimGenerationStatus(dealId)!;
assert.equal(job.status, "done");
assert.equal(created.length, 1);

// The deal stays live; every approval — of the CIM that is being replaced — is gone.
assert.equal(deal.isLive, true);
for (const k of ["contentApprovedByBroker", "contentApprovedBySeller", "designApprovedByBroker", "designApprovedBySeller"]) assert.equal(deal[k], false, k);
// The new CIM is held from all 13 buyers until published — they keep the published version.
assert.deepEqual({ ...job.buyerHold, since: "x" }, { since: "x", wasLive: true, buyers: 13, ddCleared: true, servingPublished: true });
assert.equal(cimHeldFromBuyers(deal), false, "buyers are not shown a 'being updated' notice");
assert.ok(servesPublishedSnapshot(deal), "persisted on the deal — the view room, chatbot and media all read the kept copy");
const kept = snapshots.rows.get(dealId)!;
assert.deepEqual(kept.sections.map((x: any) => x.sectionTitle), ["Overview (published)"], "the published sections are kept");
assert.deepEqual(kept.blindOverrides.map((x: any) => x.id), ["b1"]);
assert.deepEqual(kept.ddOverrides.map((x: any) => x.id), ["o1"], "DD buyers keep their version");
assert.ok(job.warnings.some((w) => /no due-diligence version yet .*keep the previous one until you publish/.test(w)));
console.log("  ✓ a live, approved CIM with buyers: the new one is held, buyers keep the published one");

// The facts snapshot stays on the server (never in status responses).
assert.ok(deal.cimGeneration.factsAt, "stored for the staleness check");
assert.equal((job as any).factsAt, undefined);
assert.equal((getCimGenerationStatus(deal) as any).factsAt, undefined);
assert.equal((listBrokerCimGeneration("b1")[0] as any).factsAt, undefined);
assert.equal(lastGenerationFacts(deal)!.askingPrice, "$18,000,000");
console.log("  ✓ the facts it wrote from are kept, broker-side only");

// A second run before publishing keeps the hold — and the FIRST copy (still what buyers read).
s.getBuyerAccessByDeal = async () => [];
s.getCimSectionsByDeal = async () => [{ id: "draft-1", sectionKey: "overview", sectionTitle: "Overview (draft)", order: 1, layoutType: "prose_highlight", layoutData: { body: "draft" }, isVisible: true }];
await startCimGeneration(structuredClone(deal), "layout");
await waitDone();
assert.ok(getLiveCimGenerationStatus(dealId)!.buyerHold?.servingPublished, "carried");
assert.ok(servesPublishedSnapshot(deal));
assert.deepEqual(snapshots.rows.get(dealId)!.sections.map((x: any) => x.sectionTitle), ["Overview (published)"], "the unreviewed draft never becomes the kept copy");
console.log("  ✓ a later run doesn't release it or replace the kept copy");

// Publishing releases it: the kept copy goes, buyers get the new version.
await releaseBuyerHold(dealId);
assert.equal(cimHeldFromBuyers(deal), false);
assert.equal(servesPublishedSnapshot(deal), false);
assert.equal(snapshots.rows.has(dealId), false);
assert.equal(getLiveCimGenerationStatus(dealId)!.buyerHold, undefined);
console.log("  ✓ publishing releases the hold and drops the kept copy");

// An approved CIM that isn't live (no buyer reads it): held the old way — not live, nothing kept.
Object.assign(deal, { isLive: false, designApprovedByBroker: true, designApprovedBySeller: true, cimGeneration: null });
await startCimGeneration(structuredClone(deal), "layout");
await waitDone();
assert.ok(cimHeldFromBuyers(deal));
assert.equal(deal.isLive, false);
assert.equal(snapshots.rows.has(dealId), false);
await releaseBuyerHold(dealId);
console.log("  ✓ an approved CIM that isn't live is held until published (nothing to keep)");

// A deal nobody can see and nobody approved: nothing to hold.
Object.assign(deal, { isLive: false, cimGeneration: null });
await startCimGeneration(structuredClone(deal), "layout");
await waitDone();
assert.equal(getLiveCimGenerationStatus(dealId)!.buyerHold, undefined);
assert.equal(cimHeldFromBuyers(deal), false);
console.log("  ✓ no hold when no buyer could open it");

_setGeneratorForTests(null);
_setSnapshotStoreForTests(null);
console.log("f-cim-hold: ok");
process.exit(0);
