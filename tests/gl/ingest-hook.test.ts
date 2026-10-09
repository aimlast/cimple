/**
 * gl spec §12.1 tests 7, 26 (part), 27, 28: which documents are ledgers; a
 * ledger is read by the ledger reader and never by the extractor (spy); a
 * PDF ledger is stored with a note ($0); needs columns / AI mapping / the
 * broker's columns / a reused layout; problems; restart recovery; one queue
 * entry per ledger.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test, done, fixture } from "./_harness";
import { fakeWorld, fakeDeal, cleanup } from "./_fake-storage";
import { _setExtractionClientForTests } from "../../server/documents/extractor";
import { ingestDocument } from "../../server/documents/ingest";
import {
  _setGlIngestDepsForTests, enqueueLedgerRead, glQueueIdle, isLedgerDocument, ledgerKindWithoutReading,
  recoverInterruptedLedgerReads, rereadWithLayout, LEDGER_NAME_RE,
} from "../../server/gl/ingest";
import { LEDGER_FAILURES } from "../../shared/gl-copy";
import type { GlLayout } from "../../shared/gl-types";

let extractorCalls = 0;
_setExtractionClientForTests({ messages: { create: async () => { extractorCalls++; throw new Error("the extractor must not run for a ledger"); } } } as any);
const w = fakeWorld();
_setGlIngestDepsForTests({ now: () => new Date("2025-03-01T12:00:00Z") });
const deal = fakeDeal(w);

const upload = (file: string, over: Record<string, unknown> = {}) =>
  w.addDocument({ dealId: deal.id, fileUrl: w.addFile(fixture(file), file), name: file, originalName: file, ...over } as any);

await test("which documents are ledgers, without reading them", () => {
  const base = { id: "x", category: "other", sourceKind: "document", sourceMeta: null } as any;
  assert.equal(ledgerKindWithoutReading({ ...base, name: "gl.csv", fileUrl: "/uploads/docs/a.csv", subcategory: "general_ledger" }), "ledger");
  assert.equal(ledgerKindWithoutReading({ ...base, name: "General Ledger 2024.pdf", fileUrl: "/uploads/docs/a.pdf" }), "pdf_ledger");
  assert.equal(ledgerKindWithoutReading({ ...base, name: "books.docx", fileUrl: "/uploads/docs/a.docx", subcategory: "general_ledger" }), "pdf_ledger");
  assert.equal(ledgerKindWithoutReading({ ...base, name: "data.xlsx", fileUrl: "/uploads/docs/a.xlsx" }), "sniff");
  assert.equal(ledgerKindWithoutReading({ ...base, name: "thread.csv", fileUrl: "/uploads/docs/a.csv", sourceKind: "email" }), null, "an email is never sniffed");
  assert.equal(ledgerKindWithoutReading({ ...base, name: "gl.csv", fileUrl: "/uploads/docs/a.csv", subcategory: "general_ledger", sourceMeta: { notLedger: true } }), null, "the broker said: a normal document");
  assert.equal(ledgerKindWithoutReading({ ...base, name: "Lease.pdf", fileUrl: "/uploads/docs/a.pdf" }), null);
  assert.ok(LEDGER_NAME_RE.test("Transaction Detail by Account 2024") && LEDGER_NAME_RE.test("GL export Jan-Dec") && !LEDGER_NAME_RE.test("Glen Abbey invoice"));
});

await test("a spreadsheet uploaded anywhere is sniffed: a ledger is a ledger, a bank statement isn't", async () => {
  assert.equal(await isLedgerDocument(upload("qbo-classic.csv")), "ledger");
  assert.equal(await isLedgerDocument(upload("xero-gl-detail.xlsx")), "ledger");
  assert.equal(await isLedgerDocument(upload("bank-statement.csv")), null);
  assert.equal(await isLedgerDocument(upload("pnl.csv")), null);
});

await test("a ledger is read entry by entry — never by the extractor, never merged as facts", async () => {
  const doc = upload("qbo-classic.csv", { uploadedBy: "seller" });
  const r = await ingestDocument(doc.id);
  assert.equal(r.status, "extracted");
  await glQueueIdle();
  assert.equal(extractorCalls, 0, "no extractor call");
  const ledger = await w.gl.getLedgerByDocument(doc.id);
  assert.equal(ledger?.status, "ready");
  assert.equal(ledger?.rowCount, 2117);
  assert.deepEqual(Object.keys(ledger!.years as object).sort(), ["2022", "2023", "2024"]);
  assert.equal(ledger?.software, "quickbooks_online");
  assert.equal(ledger?.basis, "accrual");
  assert.equal(ledger?.uploadedBy, "seller");
  const after = w.documents.get(doc.id)!;
  assert.equal(after.status, "extracted");
  assert.equal(after.subcategory, "general_ledger");
  assert.equal(after.isProcessed, true);
  assert.match(after.extractedText ?? "", /^General ledger export \(QuickBooks Online\)\. 2,117 entries from Jan 2, 2022 to Dec 31, 2024, 33 accounts\./);
  assert.doesNotMatch(after.extractedText ?? "", /\$|Lexus|Brightwater|Holloway/, "no figures or names in the document's text");
  assert.equal((after.extractedData as any)._glLedgerId, ledger!.id);
  assert.deepEqual(ledger!.problems, [], "three full years, accrual, nothing skipped");
  // Every entry carries its fiscal year and the ingest-time hint.
  const rows = w.gl.data.transactions.filter((t) => t.ledgerId === ledger!.id);
  assert.equal(rows.length, 2117);
  assert.ok(rows.find((t) => t.name === "Payroll — M. Chen")?.sensitiveHint === "staff");
  assert.ok(rows.find((t) => t.name === "Shoppers Drug Mart")?.sensitiveHint === "personal");
  assert.ok(rows.find((t) => t.name === "Holloway LLP")?.sensitiveHint === null);
});

await test("a PDF ledger is stored with a note, never read ($0)", async () => {
  const pdf = w.addDocument({ dealId: deal.id, fileUrl: w.addFile(fixture("t4-2024.txt"), "x.pdf"), name: "General Ledger 2024.pdf", originalName: "General Ledger 2024.pdf" } as any);
  const r = await ingestDocument(pdf.id);
  assert.equal(r.status, "extracted");
  const after = w.documents.get(pdf.id)!;
  assert.equal(after.subcategory, "general_ledger");
  assert.equal((after.sourceMeta as any).glNote, LEDGER_FAILURES.pdf);
  assert.equal(await w.gl.getLedgerByDocument(pdf.id), undefined);
  assert.equal(extractorCalls, 0);
});

await test("headings no rule knows: needs columns; the AI mapper (stub) or the broker's columns read it; a re-export reuses them", async () => {
  const odd = upload("odd.csv", { subcategory: "general_ledger" });
  await ingestDocument(odd.id);
  await glQueueIdle();
  let ledger = (await w.gl.getLedgerByDocument(odd.id))!;
  assert.equal(ledger.status, "needs_columns");
  assert.equal(w.documents.get(odd.id)!.status, "extracted");
  const layout: GlLayout = {
    headerRow: 0, accountMode: "column", dateOrder: "mdy", amountMode: "debit_credit", sheet: null,
    columns: [
      { index: 0, role: "date", header: "When" }, { index: 1, role: "account", header: "Ledger" }, { index: 2, role: "name", header: "Who" },
      { index: 3, role: "memo", header: "What" }, { index: 4, role: "credit", header: "In" }, { index: 5, role: "debit", header: "Out" },
    ],
  };
  await rereadWithLayout(ledger, layout, "broker");
  await glQueueIdle();
  ledger = (await w.gl.getLedgerByDocument(odd.id))!;
  assert.equal(ledger.status, "ready");
  assert.equal(ledger.layoutBy, "broker");
  assert.equal(ledger.rowCount, 400);
  // The same export again: its headings match — read without asking.
  const again = upload("odd.csv", { subcategory: "general_ledger", name: "odd again.csv" });
  await ingestDocument(again.id);
  await glQueueIdle();
  assert.equal((await w.gl.getLedgerByDocument(again.id))?.status, "ready");
  // The assistant (stubbed): a mapping is used; "not a ledger" fails with the plain reason.
  const third = w.addDocument({ dealId: fakeDeal(w).id, fileUrl: w.addFile(fixture("odd.csv")), name: "odd.csv", subcategory: "general_ledger" } as any);
  _setGlIngestDepsForTests({ now: () => new Date("2025-03-01T12:00:00Z"), mapColumns: async () => layout });
  await ingestDocument(third.id);
  await glQueueIdle();
  assert.equal((await w.gl.getLedgerByDocument(third.id))?.layoutBy, "ai");
  const fourth = w.addDocument({ dealId: fakeDeal(w).id, fileUrl: w.addFile(fixture("odd.csv")), name: "odd.csv", subcategory: "general_ledger" } as any);
  _setGlIngestDepsForTests({ now: () => new Date("2025-03-01T12:00:00Z"), mapColumns: async () => "not_ledger" });
  await ingestDocument(fourth.id);
  await glQueueIdle();
  const failed = (await w.gl.getLedgerByDocument(fourth.id))!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure, LEDGER_FAILURES.notLedger);
  assert.equal(w.documents.get(fourth.id)!.status, "failed");
  _setGlIngestDepsForTests({ now: () => new Date("2025-03-01T12:00:00Z") });
});

await test("problems: cash basis, a missing year, a partial year — each with what to do", async () => {
  const d2 = fakeDeal(w);
  const cash = w.addDocument({ dealId: d2.id, fileUrl: w.addFile(fixture("qbo-cash-basis.csv")), name: "cash.csv", subcategory: "general_ledger" } as any);
  await ingestDocument(cash.id);
  await glQueueIdle();
  const l = (await w.gl.getLedgerByDocument(cash.id))!;
  assert.equal(l.basis, "cash");
  const kinds = (l.problems as any[]).map((p) => p.kind).sort();
  assert.deepEqual(kinds, ["cash_basis", "missing_years"]);
  const missing = (l.problems as any[]).find((p) => p.kind === "missing_years");
  assert.deepEqual(missing.years, ["2022", "2023"]);
  assert.match(missing.message, /doesn't include 2022 and 2023/);
});

await test("a file over the size limit fails with what to do", async () => {
  const d3 = fakeDeal(w);
  const big = w.addDocument({ dealId: d3.id, fileUrl: w.addFile(fixture("qbo-classic.xlsx")), name: "big.xlsx", subcategory: "general_ledger" } as any);
  const p = `${w.root}/docs/${big.fileUrl.split("/").pop()}`;
  fs.truncateSync(p, 16 * 1024 * 1024);
  await ingestDocument(big.id);
  await glQueueIdle();
  const l = (await w.gl.getLedgerByDocument(big.id))!;
  assert.equal(l.status, "failed");
  assert.match(l.failure!, /Excel files over 15 MB are too big to read\. Save it as CSV/);
});

await test("a read a restart cut off: rows deleted and queued again (twice at most), then 'Read it again'", async () => {
  const d4 = fakeDeal(w);
  const doc = w.addDocument({ dealId: d4.id, fileUrl: w.addFile(fixture("qbo-2024-only.csv")), name: "gl.csv", subcategory: "general_ledger", status: "parsing" } as any);
  const stale = new Date(Date.now() - 10 * 60_000);
  const l = await w.gl.createLedger({ dealId: d4.id, documentId: doc.id, status: "reading", attempts: 0 } as any);
  await w.gl.insertTransactions([{ ledgerId: l.id, dealId: d4.id, rowNo: 7, txnDate: "2024-01-01", fiscalYear: "2024", account: "X", accountKey: "x", amountCents: 1 } as any]);
  l.updatedAt = stale;
  const r1 = await recoverInterruptedLedgerReads(new Date());
  assert.equal(r1.requeued, 1);
  await glQueueIdle();
  const done1 = (await w.gl.getLedger(l.id))!;
  assert.equal(done1.status, "ready", "read again after the restart");
  assert.equal(w.gl.data.transactions.filter((t) => t.ledgerId === l.id && t.rowNo === 7 && t.account === "X").length, 0, "the half-read rows went");
  // A third interruption: failed with the plain reason.
  Object.assign(done1, { status: "reading", attempts: 2, updatedAt: stale });
  const r2 = await recoverInterruptedLedgerReads(new Date());
  assert.equal(r2.failed, 1);
  assert.equal((await w.gl.getLedger(l.id))!.failure, LEDGER_FAILURES.restarted);
});

await test("one queue entry per ledger: a second 'Read it again' while it waits is the same job", async () => {
  const d5 = fakeDeal(w);
  const doc = w.addDocument({ dealId: d5.id, fileUrl: w.addFile(fixture("wave.csv")), name: "wave.csv", subcategory: "general_ledger" } as any);
  const l = await w.gl.createLedger({ dealId: d5.id, documentId: doc.id, status: "reading" } as any);
  const blocker = enqueueLedgerRead("no-such-ledger"); // occupies the queue's head
  const a = enqueueLedgerRead(l.id);
  const b = enqueueLedgerRead(l.id);
  assert.equal(a, b);
  await Promise.all([blocker, a]);
  assert.equal((await w.gl.getLedger(l.id))!.status, "ready");
});

cleanup(w);
done("ingest-hook");
