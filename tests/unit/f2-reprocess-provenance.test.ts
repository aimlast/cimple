// F2-DI-3: a re-read saves facts derived from the start-of-run snapshot and
// carries over what changed meanwhile. A broker resolution / confirmation
// that kept the SAME value (only the fact's source changed to the broker)
// used to be thrown away — the fact went back to the seller or the document.
// Round 2: a save that only RE-STAMPS a source (brokerOnly added by another
// upload's ingest, a visibility switch) is not a new source — the re-read's
// fresh value used to be thrown away for the stale one; and a source made
// broker-only during the run is saved with its new stamp.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-reprocess-provenance.test.ts
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { reprocessDealDocuments, sameSourceIdentity, restampChangedVisibility } from "../../server/documents/reprocess";
import { stampSourceDetails } from "../../server/documents/merge-policy";
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

// ── Round 2: stamp-only writes during the run ──
// On file from an earlier read of the memo: 9 staff, recorded WITHOUT the
// brokerOnly stamp; the memo's stored extraction now says 12.
const resetStale = (visibility = "shared") => {
  reset();
  deal.extractedInfo.employees = "9";
  deal.extractedInfo._fieldSources.employees = { source: "document", documentId: "memo", at };
  docs[0].visibility = visibility;
  docs[0].extractedData = { summary: "Company memo.", employees: "12" };
};

resetStale();
await reprocessDealDocuments("D");
assert.equal(deal.extractedInfo.employees, "12", "control: the re-read's value is saved");

resetStale();
await reprocessDealDocuments("D", (p) => {
  if (p.phase !== "saving") return;
  // Another source's ingest re-stamps every fact (adds brokerOnly:false).
  deal = { ...deal, extractedInfo: stampSourceDetails(JSON.parse(JSON.stringify(deal.extractedInfo)), docs) };
});
assert.equal(deal.extractedInfo.employees, "12", "a stamp-only write during the run doesn't throw the fresh value away");
assert.equal(getFieldSources(deal.extractedInfo).employees?.documentId, "memo");
console.log("✓ a save that only re-stamps a source during a re-read keeps the re-read's fresh value");

resetStale();
await reprocessDealDocuments("D", (p) => {
  if (p.phase !== "saving") return;
  docs[0].visibility = "broker_only";
  deal = { ...deal, extractedInfo: stampSourceDetails(JSON.parse(JSON.stringify(deal.extractedInfo)), docs) };
});
assert.equal(deal.extractedInfo.employees, "12", "the memo made broker-only during the run: its fresh value is saved…");
assert.equal(getFieldSources(deal.extractedInfo).employees?.brokerOnly, true, "…stamped broker-only, as the row is now");
console.log("✓ a source made broker-only during a re-read is saved with its new stamp (and its fresh value)");

// The visibility route's own restamp waits on the facts lock: the save must
// still stamp from the rows as they are now, not as the rebuild saw them.
resetStale();
await reprocessDealDocuments("D", (p) => {
  if (p.phase !== "saving") return;
  docs[0].visibility = "broker_only";
});
assert.equal(getFieldSources(deal.extractedInfo).employees?.brokerOnly, true, "a visibility switch the rebuild didn't see is stamped at save");
console.log("✓ the save stamps every value with its row's visibility at save time");

// Pure: identity ignores stamps, and an older bare-id year entry equals its full form.
assert.ok(sameSourceIdentity({ source: "document", documentId: "m", at: "x" }, { source: "document", documentId: "m", at: "y", brokerOnly: false, dated: "2024-01-01" }, "9"));
assert.ok(!sameSourceIdentity({ source: "document", documentId: "m" }, { source: "broker", note: "Resolved discrepancy" }, "9"));
assert.ok(!sameSourceIdentity({ source: "website", documentId: "w" }, { source: "website", documentId: "w", acceptedByBroker: true }, "9"), "the broker vouching counts");
assert.ok(!sameSourceIdentity({ source: "interview", sessionId: "s1", turn: 3 }, { source: "interview", sessionId: "s1", turn: 7 }, "9"));
const map = { "2023": "1.1M", "2024": "1.4M" };
const lookup = { kindOf: () => "document" as const, brokerOnlyOf: () => false };
assert.ok(sameSourceIdentity(
  { source: "document", documentId: "fs", years: { "2023": "fs", "2024": "fs" } },
  { source: "document", documentId: "fs", brokerOnly: false, years: { "2023": { source: "document", documentId: "fs", brokerOnly: false }, "2024": { source: "document", documentId: "fs", brokerOnly: false } } },
  map, lookup,
), "a by-year map re-summarised with full year entries is the same source");
assert.ok(!sameSourceIdentity(
  { source: "document", documentId: "fs", years: { "2023": "fs", "2024": "fs" } },
  { source: "document", documentId: "fs", years: { "2023": "fs", "2024": { source: "broker", note: "Resolved discrepancy" } } },
  map, lookup,
), "one year resolved by the broker is a new source");
assert.equal(sameSourceIdentity(undefined, undefined, "9"), true);
assert.equal(sameSourceIdentity({ source: "interview" }, undefined, "9"), false);
const restamped = restampChangedVisibility(
  { a: "1", _fieldSources: { a: { source: "email", documentId: "e" } }, _brokerPrivateNotes: [{ note: "Fee is 8%", documentId: "e" }] },
  [{ id: "e", visibility: "shared" }],
  [{ id: "e", sourceKind: "email", visibility: "broker_only" }],
) as any;
assert.equal(restamped._fieldSources.a.brokerOnly, true);
assert.equal(restamped._brokerPrivateNotes[0].brokerOnly, true, "private notes are re-stamped too");
console.log("✓ source identity ignores re-stamped details; visibility changes re-stamp facts and notes");

_setExtractionClientForTests(null);
console.log("f2-reprocess-provenance: all passed");
process.exit(0);
