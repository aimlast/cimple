/**
 * The names and shapes the data room imports from gl (INTEGRATION §2.6, C18):
 * isGlDocument (pure), ledgerStatusForVdr → { status, allowOriginalDownload }
 * | null, ledgerSummaryForVdr — one line with no amounts and no names.
 */
import assert from "node:assert/strict";
import { test, done, fixture } from "./_harness";
import { fakeWorld, fakeDeal, cleanup } from "./_fake-storage";
import { ingestDocument } from "../../server/documents/ingest";
import { _setGlIngestDepsForTests, glQueueIdle } from "../../server/gl/ingest";
import { glLedgerState, isGlDocument, ledgerStatusForVdr, ledgerSummaryForVdr } from "../../server/gl/viewer";
import { withHeavySheetSlot } from "../../server/documents/heavy-sheet";

const w = fakeWorld();
_setGlIngestDepsForTests({ now: () => new Date("2025-03-01T12:00:00Z") });
const deal = fakeDeal(w);

await test("the data room's view of a ledger: status, download switch, a one-line summary with no figures or names", async () => {
  const doc = w.addDocument({ dealId: deal.id, fileUrl: w.addFile(fixture("qbo-classic.csv")), name: "gl.csv", subcategory: "general_ledger" } as any);
  assert.equal(isGlDocument(doc), true);
  assert.equal(await ledgerStatusForVdr("nope"), null);
  await ingestDocument(doc.id);
  await glQueueIdle();
  assert.deepEqual(await ledgerStatusForVdr(doc.id), { status: "ready", allowOriginalDownload: false });
  assert.equal(glLedgerState, ledgerStatusForVdr);
  const line = await ledgerSummaryForVdr(doc.id);
  assert.equal(line, "General ledger, QuickBooks Online export: 2,117 entries, Jan 2022–Dec 2024, 33 accounts.");
  assert.doesNotMatch(line, /\$|Lexus|Brightwater|Holloway|Payroll/);
  assert.equal(typeof withHeavySheetSlot, "function");
});

await test("an uncategorised spreadsheet sniffed as a ledger is filed as financials, general ledger", async () => {
  const doc = w.addDocument({ dealId: deal.id, fileUrl: w.addFile(fixture("wave.csv")), name: "export.csv", category: "other" } as any);
  await ingestDocument(doc.id);
  await glQueueIdle();
  const after = w.documents.get(doc.id)!;
  assert.equal(after.subcategory, "general_ledger");
  assert.equal(after.category, "financials");
});

cleanup(w);
done("viewer-contract");
