// F2-DI-3: a re-read saves facts derived from the start-of-run snapshot and
// carries over what changed meanwhile. A broker resolution / confirmation
// that kept the SAME value (only the fact's source changed to the broker)
// used to be thrown away — the fact went back to the seller or the document.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-reprocess-provenance.test.ts
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { reprocessDealDocuments } from "../../server/documents/reprocess";
import { _setExtractionClientForTests } from "../../server/documents/extractor";
import { setBrokerFact } from "../../server/information/facts";
import { getFieldSources } from "../../server/interview/info-merger";

let deal: any;
let docs: any[];
const s = storage as any;
s.getDeal = async () => (deal ? JSON.parse(JSON.stringify(deal)) : undefined);
s.updateDeal = async (_id: string, patch: any) => { deal = { ...deal, ...JSON.parse(JSON.stringify(patch)) }; return deal; };
s.getDocumentsByDeal = async () => docs.map((d) => ({ ...d }));
s.getDocument = async (id: string) => docs.find((d) => d.id === id);
s.updateDocument = async (id: string, patch: any) => { const d = docs.find((x) => x.id === id); if (d) Object.assign(d, patch); return d; };
s.getDiscrepanciesByDeal = async () => [];
s.createDiscrepancy = async (data: any) => data;
s.updateDiscrepancy = async () => undefined;
s.getDocumentRequirementsByDeal = async () => [];
s.updateDocumentRequirement = async () => undefined;
_setExtractionClientForTests({ messages: { stream() { throw new Error("no model call expected"); } } } as any);

const at = "2026-09-01T00:00:00.000Z";
const reset = () => {
  deal = {
    id: "D", brokerId: "b", businessName: "Probe Co", industry: "Manufacturing", askingPrice: null,
    extractedInfo: {
      reasonForSale: "Retirement",
      yearsOperating: "22",
      _fieldSources: { reasonForSale: { source: "interview", at }, yearsOperating: { source: "interview", at } },
    },
  };
  // A source read before: its stored extraction is replayed (no file, no text → no model call).
  docs = [{ id: "memo", dealId: "D", name: "memo", originalName: "memo.pdf", category: "other", subcategory: null, sourceKind: "document", visibility: "shared", extractedText: null, extractedData: { summary: "Company memo.", employees: "9" }, fileUrl: null, mimeType: null, status: "extracted", sourceMeta: null, isProcessed: true, uploadedBy: "broker", createdAt: new Date(1), updatedAt: new Date() }];
};

// While the re-read runs, the broker confirms the reason for sale as it stands (same value).
reset();
await reprocessDealDocuments("D", (p) => {
  if (p.phase !== "saving") return;
  const info = JSON.parse(JSON.stringify(deal.extractedInfo));
  setBrokerFact(info, "reasonForSale", "Retirement", { note: "Resolved discrepancy" });
  deal = { ...deal, extractedInfo: info };
});
const src = getFieldSources(deal.extractedInfo);
assert.equal(deal.extractedInfo.reasonForSale, "Retirement");
assert.equal(src.reasonForSale?.source, "broker", "the broker's confirmation made during the run survives the save");
assert.equal(src.reasonForSale?.note, "Resolved discrepancy");
assert.equal(src.yearsOperating?.source, "interview", "an untouched fact keeps its source");
console.log("✓ a broker confirmation with the same value made during a re-read keeps broker authority");

// Control: nothing changed during the run → nothing carried; the fact stays the seller's.
reset();
await reprocessDealDocuments("D");
assert.equal(getFieldSources(deal.extractedInfo).reasonForSale?.source, "interview");
console.log("✓ without a change during the run the fact keeps its own source");

_setExtractionClientForTests(null);
console.log("f2-reprocess-provenance: all passed");
process.exit(0);
