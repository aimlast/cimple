/**
 * F1 robustness — the buyer hold is written to the deal BEFORE any section
 * is replaced, in the same write that takes the deal off live and clears
 * the approvals; if that write fails, the run fails and the old sections
 * stay (buyers never get the unreviewed CIM in the gap, or after a failed
 * status write). Publishing restarts undecided buyers' review clocks.
 * Storage and the generator are stubbed (no database, no AI).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f-cim-hold-r2.test.ts
 */
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { _setGeneratorForTests, getLiveCimGenerationStatus, releaseBuyerHold, startCimGeneration } from "../../server/cim/generation-jobs";
import { cimHeldFromBuyers } from "../../shared/cim-buyer-view";

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
  const holds = !!u?.cimGeneration?.buyerHold && u.isLive === false;
  if (holds && failHoldWrite) throw new Error("db down");
  log.push(holds ? "hold+offline" : `update:${Object.keys(u).sort().join(",")}`);
  Object.assign(deal, structuredClone(u));
};
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

// A failed hold write: the run fails, no section was touched, the deal is still live.
failHoldWrite = true;
await startCimGeneration(structuredClone(deal), "layout");
await waitDone();
assert.equal(getLiveCimGenerationStatus(dealId)!.status, "failed");
assert.ok(!log.includes("delete-sections") && !log.includes("create-section"), log.join(" "));
assert.equal(deal.isLive, true);
assert.equal(cimHeldFromBuyers(deal), false, "the old CIM is still what buyers see — not a 'being updated' notice");
console.log("  ✓ if the hold can't be written, nothing is replaced (and the old CIM isn't held)");

// The hold goes in first — before the old sections are deleted.
failHoldWrite = false;
log.length = 0;
await startCimGeneration(structuredClone(deal), "layout");
await waitDone();
assert.equal(getLiveCimGenerationStatus(dealId)!.status, "done");
const holdAt = log.indexOf("hold+offline");
assert.ok(holdAt >= 0 && holdAt < log.indexOf("delete-sections") && holdAt < log.indexOf("create-section"), log.join(" "));
assert.ok(cimHeldFromBuyers(deal));
assert.equal(deal.isLive, false);
for (const k of ["contentApprovedByBroker", "contentApprovedBySeller", "designApprovedByBroker", "designApprovedBySeller"]) assert.equal(deal[k], false, k);
console.log("  ✓ the hold, off-live and cleared approvals are written before any section is replaced");

// Publishing: the hold is released and the undecided buyer who viewed the old CIM gets a fresh clock.
await releaseBuyerHold(dealId);
assert.equal(cimHeldFromBuyers(deal), false);
assert.deepEqual(accessUpdates.map(([id]) => id), ["a-viewed"]);
assert.equal(accessUpdates[0][1].reminderStage, "none");
assert.ok(Math.abs(new Date(accessUpdates[0][1].firstViewedAt).getTime() - Date.now()) < 60000);
console.log("  ✓ publishing restarts the review clock of buyers still deciding on the replaced CIM");

_setGeneratorForTests(null);
console.log("f-cim-hold-r2: ok");
process.exit(0);
