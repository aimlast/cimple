/**
 * gl spec §12.1 test 7: a second file overlapping the first is marked as
 * copies (and says so); deleting the earlier file un-marks the later one;
 * reading again recomputes. Same rule in the memory store as in the SQL.
 */
import assert from "node:assert/strict";
import { test, done, fixture } from "./_harness";
import { fakeWorld, fakeDeal, cleanup } from "./_fake-storage";
import { ingestDocument } from "../../server/documents/ingest";
import { _setGlIngestDepsForTests, glQueueIdle, onLedgerDocumentDeleted, rereadLedgerDocument } from "../../server/gl/ingest";

const w = fakeWorld();
_setGlIngestDepsForTests({ now: () => new Date("2025-03-01T12:00:00Z") });
const deal = fakeDeal(w);
const add = (file: string) => w.addDocument({ dealId: deal.id, fileUrl: w.addFile(fixture(file)), name: file, subcategory: "general_ledger" } as any);

await test("the 2024-only file overlapping the 3-year file: every 2024 entry is a copy", async () => {
  const three = add("qbo-classic.csv");
  await ingestDocument(three.id);
  await glQueueIdle();
  const only = add("qbo-2024-only.csv");
  await ingestDocument(only.id);
  await glQueueIdle();
  const a = (await w.gl.getLedgerByDocument(three.id))!;
  const b = (await w.gl.getLedgerByDocument(only.id))!;
  assert.equal(a.duplicateCount, 0, "the earlier file keeps its entries");
  assert.equal(b.duplicateCount, 709, "every entry of the later file was already in the earlier one");
  const p = (b.problems as any[]).find((x) => x.kind === "duplicates_skipped");
  assert.equal(p.count, 709);
  assert.match(p.message, /709 entries were already in your earlier file — we skipped the copies/);
  assert.equal(w.gl.data.transactions.filter((t) => t.ledgerId === b.id && !t.duplicate).length, 0);
});

await test("deleting the earlier file un-marks the later file's entries", async () => {
  const three = Array.from(w.documents.values()).find((d) => d.name === "qbo-classic.csv")!;
  const only = Array.from(w.documents.values()).find((d) => d.name === "qbo-2024-only.csv")!;
  w.documents.delete(three.id);
  await onLedgerDocumentDeleted(three);
  const b = (await w.gl.getLedgerByDocument(only.id))!;
  assert.equal(b.duplicateCount, 0);
  assert.equal((b.problems as any[]).some((x) => x.kind === "duplicates_skipped"), false);
  assert.equal(w.gl.data.transactions.filter((t) => t.ledgerId === b.id && t.duplicate).length, 0);
  assert.equal(await w.gl.getLedgerByDocument(three.id), undefined);
  assert.equal(w.gl.data.transactions.filter((t) => t.dealId === deal.id).length, 709, "only the remaining file's entries");
});

await test("reading the earlier file again (re-uploaded) marks the later one's copies again", async () => {
  const again = add("qbo-classic.csv");
  await ingestDocument(again.id);
  await glQueueIdle();
  const only = Array.from(w.documents.values()).find((d) => d.name === "qbo-2024-only.csv")!;
  // The re-upload is newer: now ITS 2024 entries are the copies.
  assert.equal((await w.gl.getLedgerByDocument(again.id))!.duplicateCount, 709);
  assert.equal((await w.gl.getLedgerByDocument(only.id))!.duplicateCount, 0);
  await rereadLedgerDocument(only.id);
  await glQueueIdle();
  assert.equal((await w.gl.getLedgerByDocument(only.id))!.duplicateCount, 0, "re-reading keeps the order of upload");
});

await test("identical entries inside one file are not copies (two equal purchases on one day)", async () => {
  await w.gl.recomputeDuplicates(deal.id);
  const one = (await w.gl.listLedgers(deal.id))[0];
  const rows = w.gl.data.transactions.filter((t) => t.ledgerId === one.id);
  const sig = new Map<string, number>();
  for (const t of rows) sig.set(`${t.txnDate}|${t.accountKey}|${t.amountCents}|${t.name}|${t.memo}|${t.txnNumber}`, 0);
  assert.equal(rows.filter((t) => t.duplicate).length, 0);
});

cleanup(w);
done("dedupe");
