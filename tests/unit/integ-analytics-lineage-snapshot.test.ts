/**
 * Integration of reading analytics with the live-CIM keep (2026-09-29): a
 * regenerated CIM on a LIVE deal keeps the published copy first
 * (published-snapshot.ts) and writes the new sections in one transaction
 * (storage.replaceDealCim); each new section still continues the page
 * history of the section it replaces (cim_sections.analytics_lineage,
 * server/analytics/lineage.ts) — the kept copy keeps the old rows' lineage.
 * Storage and the generator are stubbed (no database, no AI).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/integ-analytics-lineage-snapshot.test.ts
 */
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { _setGeneratorForTests, getLiveCimGenerationStatus, startCimGeneration } from "../../server/cim/generation-jobs";
import { _setSnapshotStoreForTests, memorySnapshotStore, getPublishedSnapshot } from "../../server/cim/published-snapshot";

const snapshots = memorySnapshotStore();
_setSnapshotStoreForTests(snapshots);

const dealId = "deal-lineage-keep";
const deal: any = {
  id: dealId, brokerId: "b1", businessName: "Harbourline Dental (QA)", industry: "Dental",
  askingPrice: "$2,400,000", extractedInfo: { annualRevenue: "$3,100,000" },
  isLive: true, contentApprovedByBroker: true, contentApprovedBySeller: true,
  designApprovedByBroker: true, designApprovedBySeller: true,
  phase: "phase4_design_finalization", cimLayoutVersion: 2, cimGeneration: null,
};
// The live CIM: the overview already continues an older page ("lin-overview").
const oldSections = [
  { id: "old-overview", dealId, sectionKey: "companyOverview", sectionTitle: "Company Overview", order: 1, layoutType: "prose_highlight", layoutData: { body: "a" }, isVisible: true, analyticsLineage: "lin-overview", brokerApproved: true },
  { id: "old-fin", dealId, sectionKey: "financialOverview", sectionTitle: "Financial Overview", order: 2, layoutType: "financial_table", layoutData: {}, isVisible: true, analyticsLineage: null, brokerApproved: true },
];
let replaced: any[] = [];
const s = storage as any;
s.getDeal = async (id: string) => (id === dealId ? structuredClone(deal) : undefined);
s.updateDeal = async (_id: string, u: any) => { Object.assign(deal, structuredClone(u)); };
s.getCimSectionsByDeal = async () => structuredClone(oldSections);
s.getDocumentsByDeal = async () => [];
s.getResolvedDiscrepancies = async () => [];
s.getBrandingByBroker = async () => undefined;
s.getEngagementInsightsByIndustry = async () => [];
s.getFinancialAnalysesByDeal = async () => [];
s.getBuyerAccessByDeal = async () => [{ id: "a1", dealId, firstViewedAt: new Date(), decision: "under_review", revokedAt: null, expiresAt: null }];
s.updateBuyerAccess = async () => undefined;
s.getCimSectionOverrides = async () => [];
s.replaceDealCim = async (_id: string, rows: any[], u: any) => { replaced = rows; Object.assign(deal, structuredClone(u)); };

_setGeneratorForTests(async () => ({
  dealId, generatedAt: new Date().toISOString(), version: 1,
  sections: [
    { sectionKey: "financialOverview", sectionTitle: "Financial Overview", order: 1, layoutType: "financial_table", layoutData: {}, aiLayoutReasoning: "r", tags: [], isVisible: true, brokerApproved: false },
    { sectionKey: "companyOverview", sectionTitle: "Company Overview", order: 2, layoutType: "prose_highlight", layoutData: { body: "b" }, aiLayoutReasoning: "r", tags: [], isVisible: true, brokerApproved: false },
    { sectionKey: "growthStrategies", sectionTitle: "Growth", order: 3, layoutType: "callout_list", layoutData: {}, aiLayoutReasoning: "r", tags: [], isVisible: true, brokerApproved: false },
  ],
  warnings: [],
}) as any);

await startCimGeneration(structuredClone(deal), "layout");
for (let i = 0; i < 300 && getLiveCimGenerationStatus(dealId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
assert.equal(getLiveCimGenerationStatus(dealId)!.status, "done", getLiveCimGenerationStatus(dealId)!.error ?? "");

assert.equal(replaced.length, 3);
const byKey = new Map(replaced.map((r) => [r.sectionKey, r]));
assert.equal(byKey.get("companyOverview").analyticsLineage, "lin-overview", "a section continues its predecessor's lineage");
assert.equal(byKey.get("financialOverview").analyticsLineage, "old-fin", "a predecessor with no lineage of its own passes on its id");
assert.equal(byKey.get("growthStrategies").analyticsLineage ?? null, null, "a new page starts its own history");
console.log("  ✓ regenerated sections carry their predecessors' reading lineage through the one-transaction replace");

const kept = await getPublishedSnapshot(dealId);
assert.ok(kept, "the live CIM was kept for its buyers");
const keptOverview = kept!.sections.find((x: any) => x.id === "old-overview") as any;
assert.equal(keptOverview?.analyticsLineage, "lin-overview", "the kept copy (what buyers keep reading) keeps its lineage");
console.log("  ✓ the kept copy buyers keep reading keeps the same lineage, so its reading joins the same page history");
process.exit(0);
