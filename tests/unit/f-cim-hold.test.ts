/**
 * F1 — "Regenerate all" on a live CIM with buyers: the new CIM must not go
 * to buyers unreviewed. Storage and the generator are stubbed (no database,
 * no AI). The whole job runs: the deal leaves live, every approval is
 * cleared, the hold is persisted (and carried by a later run), the DD
 * clearing is reported, the facts it wrote from are kept server-side only,
 * and publishing releases the hold.
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
import { cimHeldFromBuyers } from "../../shared/cim-buyer-view";

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
s.getCimSectionOverrides = async (_d: string, mode: string) => (mode === "dd" ? [{ id: "o1" }] : []);
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

// The deal left live and every approval — of the CIM that no longer exists — is gone.
assert.equal(deal.isLive, false);
for (const k of ["contentApprovedByBroker", "contentApprovedBySeller", "designApprovedByBroker", "designApprovedBySeller"]) assert.equal(deal[k], false, k);
// Held from all 13 buyers until published; DD clearing is reported.
assert.deepEqual({ ...job.buyerHold, since: "x" }, { since: "x", wasLive: true, buyers: 13, ddCleared: true });
assert.ok(cimHeldFromBuyers(deal), "persisted on the deal — the view room, chatbot and media all read it");
assert.ok(job.warnings.some((w) => /due-diligence version was cleared/.test(w)));
console.log("  ✓ a live, approved CIM with buyers is held after Regenerate all");

// The facts snapshot stays on the server (never in status responses).
assert.ok(deal.cimGeneration.factsAt, "stored for the staleness check");
assert.equal((job as any).factsAt, undefined);
assert.equal((getCimGenerationStatus(deal) as any).factsAt, undefined);
assert.equal((listBrokerCimGeneration("b1")[0] as any).factsAt, undefined);
assert.equal(lastGenerationFacts(deal)!.askingPrice, "$18,000,000");
console.log("  ✓ the facts it wrote from are kept, broker-side only");

// A second run (buyers gone, not live) keeps the hold until publishing.
s.getBuyerAccessByDeal = async () => [];
await startCimGeneration(structuredClone(deal), "layout");
await waitDone();
assert.ok(getLiveCimGenerationStatus(dealId)!.buyerHold, "carried");
assert.ok(cimHeldFromBuyers(deal));
console.log("  ✓ a later run doesn't release it");

// Publishing releases it.
await releaseBuyerHold(dealId);
assert.equal(cimHeldFromBuyers(deal), false);
assert.equal(getLiveCimGenerationStatus(dealId)!.buyerHold, undefined);
console.log("  ✓ publishing releases the hold");

// A deal nobody can see and nobody approved: nothing to hold.
Object.assign(deal, { isLive: false, cimGeneration: null });
await startCimGeneration(structuredClone(deal), "layout");
await waitDone();
assert.equal(getLiveCimGenerationStatus(dealId)!.buyerHold, undefined);
assert.equal(cimHeldFromBuyers(deal), false);
console.log("  ✓ no hold when no buyer could open it");

_setGeneratorForTests(null);
console.log("f-cim-hold: ok");
process.exit(0);
