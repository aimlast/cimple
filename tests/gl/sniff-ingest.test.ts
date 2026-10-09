/**
 * Checker r2 GL-R2-03: a spreadsheet uploaded anywhere is taken for a general
 * ledger only with evidence (a ledger's title, or a chart of accounts). A
 * QuickBooks "Sales by Customer Detail" or "A/R Aging Detail" — the same
 * heading-row shape — is read by the extractor like any document (its facts
 * kept), never filed as a ledger. A ledger-shaped file without the evidence
 * is read as a document too and flagged, so the broker is offered "Read it
 * as a ledger" (its document facts then go) or "It isn't".
 */
import assert from "node:assert/strict";
import { test, done, fixture } from "./_harness";
import { fakeWorld, fakeDeal, cleanup } from "./_fake-storage";
import { _setExtractionClientForTests, _setExtractionRetryDelaysForTests } from "../../server/documents/extractor";
import { ingestDocument } from "../../server/documents/ingest";
import { _setGlIngestDepsForTests, dismissMaybeLedger, glQueueIdle, isMaybeLedger, ledgerKindWithoutReading, readAsLedger } from "../../server/gl/ingest";

let extractorCalls = 0;
_setExtractionRetryDelaysForTests([1]);
_setExtractionClientForTests({
  messages: {
    stream() {
      extractorCalls++;
      return { finalMessage: async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", input: { summary: "Sales by customer for 2024." } }] }) };
    },
  },
} as any);
const w = fakeWorld();
_setGlIngestDepsForTests({ now: () => new Date("2025-03-01T12:00:00Z") });
const deal = fakeDeal(w);
const upload = (file: string, name: string) => w.addDocument({ dealId: deal.id, fileUrl: w.addFile(fixture(file), file.split("/").pop()), name, originalName: name, category: "other" } as any);

await test("QuickBooks 'Sales by Customer Detail' and 'A/R Aging Detail' are read as documents, never filed as ledgers", async () => {
  for (const [file, name] of [["not-ledgers/sales-by-customer.csv", "Customer sales 2024.csv"], ["not-ledgers/ar-aging.csv", "AR.csv"]]) {
    const before = extractorCalls;
    const doc = upload(file, name);
    await ingestDocument(doc.id);
    await glQueueIdle();
    assert.ok(extractorCalls > before, `${file}: the extractor read it (its facts aren't lost)`);
    assert.equal(await w.gl.getLedgerByDocument(doc.id), undefined, `${file}: no ledger`);
    const after = w.documents.get(doc.id)!;
    assert.notEqual(after.subcategory, "general_ledger", file);
    assert.equal(w.gl.data.transactions.filter((t) => t.dealId === deal.id).length, 0, "nothing went into the ledger tables");
    assert.equal(isMaybeLedger(after), false, `${file}: its title says what it is — not offered as a ledger`);
  }
});

await test("a ledger-shaped file without a ledger's title or accounts: a document, flagged; 'Read it as a ledger' files it", async () => {
  const before = extractorCalls;
  const doc = upload("not-ledgers/sales-by-customer-untitled.csv", "export (3).csv");
  await ingestDocument(doc.id);
  await glQueueIdle();
  assert.ok(extractorCalls > before, "read as an ordinary document");
  const after = w.documents.get(doc.id)!;
  // (The fake world has no database for the facts merge, so the read ends "failed" here — its sourceMeta write still runs.)
  assert.ok(after.status === "extracted" || after.status === "failed", `the ordinary read finished (${after.status})`);
  assert.equal((after.sourceMeta as any)?.glMaybeLedger, true, "the flag survives the ordinary read's own sourceMeta write");
  assert.equal(isMaybeLedger(after), true);
  assert.equal(await w.gl.getLedgerByDocument(doc.id), undefined);
  const ledger = await readAsLedger(doc.id);
  assert.ok(ledger, "the broker reads it as a ledger");
  await glQueueIdle();
  const filed = w.documents.get(doc.id)!;
  assert.equal(filed.subcategory, "general_ledger");
  assert.equal((filed.sourceMeta as any)?.glMaybeLedger, undefined);
  assert.equal(isMaybeLedger(filed), false);
});

await test("'It isn't' — never offered or sniffed again", async () => {
  const doc = upload("not-ledgers/ar-aging-untitled.csv", "export (4).csv");
  await ingestDocument(doc.id);
  await glQueueIdle();
  assert.equal(isMaybeLedger(w.documents.get(doc.id)!), true);
  assert.equal(await dismissMaybeLedger(doc.id), true);
  const after = w.documents.get(doc.id)!;
  assert.equal(isMaybeLedger(after), false);
  assert.equal((after.sourceMeta as any)?.notLedger, true);
  assert.equal(ledgerKindWithoutReading(after as any), null, "a re-read never sniffs it again");
});

await test("the file's own name counts: 'A/R aging.csv' is never offered as a ledger", async () => {
  const doc = upload("not-ledgers/ar-aging-untitled.csv", "A-R aging Dec 2024.csv");
  await ingestDocument(doc.id);
  await glQueueIdle();
  assert.equal(isMaybeLedger(w.documents.get(doc.id)!), false);
  assert.equal(await w.gl.getLedgerByDocument(doc.id), undefined);
});

await test("a real ledger uploaded the same way is still a ledger", async () => {
  const doc = upload("qbd.csv", "books.csv");
  await ingestDocument(doc.id);
  await glQueueIdle();
  assert.equal((await w.gl.getLedgerByDocument(doc.id))?.status, "ready");
});

_setExtractionClientForTests(null);
cleanup(w);
done("sniff-ingest");
