/**
 * Generation runs the discrepancy check first when it never ran (or the
 * sources changed) and stops at the gate before writing anything when a
 * critical conflict is found. Storage and both model calls are stubbed.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/discrepancy-gate.test.ts
 */
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { _setCheckModelForTests } from "../../server/cim/discrepancy-engine";
import { ensureDiscrepancyGate, computeCheckStatus, checkFingerprint } from "../../server/cim/discrepancy-check";
import { startCimGeneration, getLiveCimGenerationStatus, _setGeneratorForTests } from "../../server/cim/generation-jobs";

const dealId = "deal-gate";
const deal: any = {
  id: dealId,
  brokerId: "b1",
  businessName: "Harborview (QA)",
  industry: "IT services",
  extractedInfo: {
    customerConcentration: "Largest client is about 4% of revenue",
    _fieldSources: { customerConcentration: { source: "call", documentId: "call1" } },
    _fieldAlternates: { customerConcentration: [{ value: "Maritime Smiles 7.8% of MRR", source: "document", documentId: "mrr" }] },
  },
  discrepancyCheckedAt: null,
  discrepancyCheckSources: null,
  cimLayoutVersion: 0,
};
const docs: any[] = [
  { id: "call1", name: "Discovery call", category: "transcripts", sourceKind: "call", visibility: "shared", isProcessed: true, extractedText: "about 4%", extractedData: null },
  { id: "mrr", name: "MRR schedule", category: "financials", sourceKind: "document", visibility: "shared", isProcessed: true, extractedText: "Maritime Smiles $30,600 of $392,640 MRR (7.8%)", extractedData: null },
];
const rows: any[] = [];
const s = storage as any;
s.getDeal = async (id: string) => (id === dealId ? { ...deal } : undefined);
s.getDocumentsByDeal = async () => docs;
s.getDiscrepanciesByDeal = async () => rows.map((r) => ({ ...r }));
s.createDiscrepancy = async (data: any) => {
  const r = { id: `00000000-0000-0000-0000-00000000000${rows.length + 1}`, createdAt: new Date(), ...data };
  rows.push(r);
  return r;
};
s.updateDiscrepancy = async (id: string, u: any) => Object.assign(rows.find((r) => r.id === id), u);
s.updateDeal = async (_id: string, u: any) => Object.assign(deal, u);
s.getResolvedDiscrepancies = async () => [];
s.getBrandingByBroker = async () => undefined;
s.getEngagementInsightsByIndustry = async () => [];
s.deleteCimSectionsForDeal = async () => undefined;
s.deleteCimSectionOverrides = async () => undefined;
s.createCimSection = async (x: any) => x;

let checkCalls = 0;
_setCheckModelForTests(async (_system, user) => {
  checkCalls++;
  const ref = (label: string) => user.match(new RegExp(`- (S\\d+): [^\\n]*${label}`))?.[1];
  return {
    discrepancies: [{
      field: "Largest client share",
      factKey: "customerConcentration",
      claimValue: "about 4% of revenue",
      claimSource: ref("Call"),
      evidenceValue: "7.8% of MRR",
      evidenceSource: ref("MRR schedule"),
      severity: "critical",
      category: "financial",
      explanation: "The MRR schedule shows the largest client at 7.8%.",
      suggestedResolution: "Confirm the largest client's share.",
    }],
    clearedIds: [],
  };
});
let generated = 0;
_setGeneratorForTests(async () => {
  generated++;
  return { sections: [], warnings: [] } as any;
});

(async () => {
  // Never checked → stale.
  const before = computeCheckStatus(deal, docs);
  assert.equal(before.canRun, true);
  assert.equal(before.stale, true);
  assert.equal(before.checkedAt, null);

  await startCimGeneration(deal, "content", { beforeWriting: (onChecking) => ensureDiscrepancyGate(dealId, onChecking) });
  for (let i = 0; i < 100 && getLiveCimGenerationStatus(dealId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
  const job = getLiveCimGenerationStatus(dealId)!;
  assert.equal(checkCalls, 1, "the check ran first");
  assert.equal(generated, 0, "no section was written");
  assert.equal(job.status, "failed");
  assert.equal(job.stoppedBy, "discrepancies");
  assert.deepEqual(job.blockingDiscrepancies!.map((b) => b.field), ["Largest client share"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, "critical");
  assert.equal(rows[0].factKey, "customerConcentration");
  assert.equal(rows[0].sideSources.interview.kind, "call");
  assert.equal(rows[0].sideSources.document.documentId, "mrr");
  assert.ok(deal.discrepancyCheckedAt, "the deal is stamped");
  assert.equal(computeCheckStatus(deal, docs).stale, false, "fresh after the run");

  // Resolved → the next run doesn't re-check (sources unchanged) and writes.
  rows[0].status = "resolved";
  rows[0].resolvedValue = "7.8% of MRR";
  await startCimGeneration(deal, "content", { beforeWriting: (onChecking) => ensureDiscrepancyGate(dealId, onChecking) });
  for (let i = 0; i < 100 && getLiveCimGenerationStatus(dealId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(checkCalls, 1, "not re-run while sources are unchanged");
  assert.equal(generated, 1);
  assert.equal(getLiveCimGenerationStatus(dealId)!.status, "done");

  // A new document makes the check stale again.
  const withNew = [...docs, { id: "lease", name: "Lease", category: "legal", sourceKind: "document", visibility: "shared", isProcessed: true, extractedText: "x", extractedData: null }];
  const st = computeCheckStatus(deal, withNew);
  assert.equal(st.stale, true);
  assert.equal(st.newSources, 1);
  // A broker-only file never counts as a source to check against.
  const withPrivate = [...docs, { id: "crm", name: "CRM note", category: "other", sourceKind: "crm", visibility: "broker_only", isProcessed: true, extractedText: "x", extractedData: null }];
  assert.deepEqual(checkFingerprint(deal.extractedInfo, withPrivate).docs, ["mrr"]);

  // A new SIGNIFICANT conflict stops the first run once (seen before writing);
  // generating again proceeds — only criticals block.
  rows.length = 0;
  deal.discrepancyCheckedAt = null;
  deal.discrepancyCheckSources = null;
  generated = 0;
  _setCheckModelForTests(async (_system, user) => {
    const ref = (label: string) => user.match(new RegExp(`- (S\\d+): [^\\n]*${label}`))?.[1];
    return {
      discrepancies: [{ field: "Largest client share", factKey: "customerConcentration", claimValue: "about 4%", claimSource: ref("Call"), evidenceValue: "7.8% of MRR", evidenceSource: ref("MRR schedule"), severity: "significant", category: "financial", explanation: "x", suggestedResolution: "y" }],
      clearedIds: [],
    };
  });
  const run = async () => {
    await startCimGeneration(deal, "content", { beforeWriting: (onChecking) => ensureDiscrepancyGate(dealId, onChecking) });
    for (let i = 0; i < 100 && getLiveCimGenerationStatus(dealId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    return getLiveCimGenerationStatus(dealId)!;
  };
  const first = await run();
  assert.equal(first.status, "failed");
  assert.equal(first.stoppedReason, "new");
  assert.equal(generated, 0, "nothing written before the broker saw it");
  const second = await run();
  assert.equal(second.status, "done", "generating again goes ahead");
  assert.equal(generated, 1);

  _setCheckModelForTests(null);
  _setGeneratorForTests(null);
  console.log("discrepancy-gate: ok");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
