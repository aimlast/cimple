/**
 * F1 robustness — the buyer hold is written to the deal BEFORE any section
 * is replaced, in the same write that clears the approvals (and, for a deal
 * that isn't live, keeps it unpublished); a live deal's published CIM is
 * kept first. If either write fails, the run fails and the old sections
 * stay (buyers never get the unreviewed CIM in the gap, or after a failed
 * status write). Publishing restarts the review clocks of buyers who were
 * held; buyers who kept reading the published version keep their clocks.
 * Storage and the generator are stubbed (no database, no AI).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f-cim-hold-r2.test.ts
 */
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { _setGeneratorForTests, getLiveCimGenerationStatus, releaseBuyerHold, startCimGeneration } from "../../server/cim/generation-jobs";
import { cimHeldFromBuyers, servesPublishedSnapshot } from "../../shared/cim-buyer-view";
import { _setSnapshotStoreForTests, memorySnapshotStore } from "../../server/cim/published-snapshot";

const snapshots = memorySnapshotStore();
let failSnapshot = false;
_setSnapshotStoreForTests({
  ...snapshots,
  save: async (id, cim) => {
    if (failSnapshot) throw new Error("db down");
    log.push("keep-published");
    return snapshots.save(id, cim);
  },
});

const dealId = "deal-hold-order";
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
const log: string[] = [];
let failHoldWrite = false;
const now = Date.now();
const access = [
  { id: "a-viewed", dealId, firstViewedAt: new Date(now - 9 * 86400000), reminderStage: "warning_sent", lastReminderAt: new Date(now - 3 * 86400000), decision: "under_review", revokedAt: null, expiresAt: null },
  { id: "a-decided", dealId, firstViewedAt: new Date(now - 9 * 86400000), reminderStage: "none", decision: "interested", revokedAt: null, expiresAt: null },
];
const accessUpdates: Array<[string, any]> = [];
const s = storage as any;
s.getDeal = async (id: string) => (id === dealId ? structuredClone(deal) : undefined);
s.updateDeal = async (_id: string, u: any) => {
  const holds = !!u?.cimGeneration?.buyerHold && u.contentApprovedByBroker === false;
  if (holds && failHoldWrite) throw new Error("db down");
  log.push(holds ? (u.isLive === false ? "hold+offline" : "hold") : `update:${Object.keys(u).sort().join(",")}`);
  Object.assign(deal, structuredClone(u));
};
s.getCimSectionsByDeal = async () => [{ id: "old-1", sectionTitle: "Overview", order: 1, layoutType: "prose_highlight", layoutData: {}, isVisible: true }];
s.getDocumentsByDeal = async () => [];
s.getResolvedDiscrepancies = async () => [];
s.getBrandingByBroker = async () => undefined;
s.getEngagementInsightsByIndustry = async () => [];
s.getFinancialAnalysesByDeal = async () => [];
s.getBuyerAccessByDeal = async () => access.map((a) => ({ ...a }));
s.updateBuyerAccess = async (id: string, u: any) => { accessUpdates.push([id, u]); };
s.getCimSectionOverrides = async () => [];
s.deleteCimSectionsForDeal = async () => { log.push("delete-sections"); };
s.deleteCimSectionOverrides = async () => undefined;
s.createCimSection = async (x: any) => { log.push("create-section"); return x; };
s.getCimSectionsByDeal = async () => [{ id: "old" }];
// One transaction: the hold, cleared approvals (and off-live, for a deal
// that wasn't live) go in with the section replacement, or nothing does.
s.replaceDealCim = async (_id: string, rows: any[], u: any) => {
  const holds = !!u?.cimGeneration?.buyerHold && u.contentApprovedByBroker === false;
  if (holds && failHoldWrite) throw new Error("db down");
  log.push(`${holds ? (u.isLive === false ? "hold+offline+" : "hold+") : ""}replace:${rows.length}`);
  Object.assign(deal, structuredClone(u));
};

_setGeneratorForTests(async () => ({
  dealId,
  generatedAt: new Date().toISOString(),
  version: 1,
  sections: [{ sectionKey: "overview", sectionTitle: "Overview", order: 1, layoutType: "prose_highlight", layoutData: { body: "x" }, aiLayoutReasoning: "r", tags: [], isVisible: true, brokerApproved: false }],
  warnings: [],
}) as any);

const waitDone = async () => {
  for (let i = 0; i < 200 && getLiveCimGenerationStatus(dealId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
};

// The published CIM can't be kept: the run fails, nothing is replaced.
failSnapshot = true;
await startCimGeneration(structuredClone(deal), "layout");
await waitDone();
assert.equal(getLiveCimGenerationStatus(dealId)!.status, "failed");
assert.ok(!log.some((l) => l.includes("replace") || l.includes("hold")), log.join(" "));
assert.equal(deal.isLive, true);
assert.equal(deal.cimGeneration?.buyerHold, undefined);
failSnapshot = false;
log.length = 0;
console.log("  ✓ if the published CIM can't be kept, nothing is replaced");

// A failed hold write: the run fails, no section was touched, the deal is still live.
failHoldWrite = true;
await startCimGeneration(structuredClone(deal), "layout");
await waitDone();
assert.equal(getLiveCimGenerationStatus(dealId)!.status, "failed");
assert.ok(!log.some((l) => l.includes("replace")), log.join(" "));
assert.equal(deal.isLive, true);
assert.equal(cimHeldFromBuyers(deal), false, "the old CIM is still what buyers see — not a 'being updated' notice");
assert.equal(servesPublishedSnapshot(deal), false, "and served as the live CIM, not a kept copy");
console.log("  ✓ if the hold can't be written, nothing is replaced (and the old CIM isn't held)");

// The published CIM is kept, then the hold goes in — both before the old sections are deleted.
failHoldWrite = false;
log.length = 0;
await startCimGeneration(structuredClone(deal), "layout");
await waitDone();
assert.equal(getLiveCimGenerationStatus(dealId)!.status, "done");
const keptAt = log.indexOf("keep-published");
const holdAt = log.indexOf("hold+replace:1");
assert.ok(keptAt >= 0 && holdAt > keptAt, log.join(" "));
assert.ok(!log.some((l) => l.startsWith("update:") && l.includes("isLive")), "the hold is never written apart from the sections");
assert.ok(servesPublishedSnapshot(deal));
assert.equal(deal.isLive, true, "the deal stays live");
for (const k of ["contentApprovedByBroker", "contentApprovedBySeller", "designApprovedByBroker", "designApprovedBySeller"]) assert.equal(deal[k], false, k);
console.log("  ✓ the kept copy goes in first; the hold and cleared approvals in the same transaction as the sections");

// Publishing: buyers kept reading all along — their review clocks run on.
await releaseBuyerHold(dealId);
assert.equal(servesPublishedSnapshot(deal), false);
assert.deepEqual(accessUpdates, [], "no clock restarted: nobody was held");
console.log("  ✓ publishing the update leaves the buyers' review clocks alone");

// A deal taken off live with buyers who were held: publishing restarts the undecided viewer's clock.
Object.assign(deal, { isLive: false, cimGeneration: null, designApprovedByBroker: true });
log.length = 0;
await startCimGeneration(structuredClone(deal), "layout");
await waitDone();
assert.ok(log.includes("hold+offline+replace:1") && cimHeldFromBuyers(deal), log.join(" "));
await releaseBuyerHold(dealId);
assert.equal(cimHeldFromBuyers(deal), false);
assert.deepEqual(accessUpdates.map(([id]) => id), ["a-viewed"]);
assert.equal(accessUpdates[0][1].reminderStage, "none");
assert.ok(Math.abs(new Date(accessUpdates[0][1].firstViewedAt).getTime() - Date.now()) < 60000);
console.log("  ✓ publishing restarts the review clock of buyers who were held from the replaced CIM");

_setGeneratorForTests(null);
_setSnapshotStoreForTests(null);
console.log("f-cim-hold-r2: ok");
process.exit(0);
