/**
 * gl spec §12.1 test 14 (§7.3): the assistant reading an unusual layout,
 * with a stubbed model (no paid AI):
 *   - a mapping for the "odd" fixture is accepted after the dry parse and
 *     the ledger is read with it (layoutBy "ai");
 *   - a wrong mapping (dates in the amount column) is refused → needs columns;
 *   - "not a general ledger" → the file fails with the plain message;
 *   - an outage → needs columns, never silent; the key disabled → needs
 *     columns without a call; the seller's mapping budget is its own.
 */
import assert from "node:assert/strict";
import { test, done, fixture } from "./_harness";
import { fakeWorld, fakeDeal, cleanup } from "./_fake-storage";
import { ingestDocument } from "../../server/documents/ingest";
import { _setGlIngestDepsForTests, glQueueIdle, setGlColumnMapper } from "../../server/gl/ingest";
import { _setExtractionClientForTests } from "../../server/documents/extractor";
import { _setGlAiClientForTests, GL_AI_CAPS } from "../../server/gl/ai";
import { mapColumnsWithAi, layoutFromAnswer, sampleText } from "../../server/gl/map-columns-ai";
import { peekRows } from "../../server/gl/read-file";
import { LEDGER_FAILURES } from "../../shared/gl-copy";

_setExtractionClientForTests({ messages: { create: async () => { throw new Error("no AI in tests"); } } } as any);
const w = fakeWorld();
_setGlIngestDepsForTests({ now: () => new Date("2025-03-01T12:00:00Z") });
setGlColumnMapper(mapColumnsWithAi);

let calls: any[] = [];
let answer: (req: any) => any = () => ({ content: [] });
_setGlAiClientForTests({ messages: { create: async (req: any) => { calls.push(req); return answer(req); } } });

const GOOD = { isGeneralLedger: true, headerRow: 0, columns: [{ index: 0, role: "date" }, { index: 1, role: "account" }, { index: 2, role: "name" }, { index: 3, role: "memo" }, { index: 4, role: "debit" }, { index: 5, role: "credit" }], accountInHeadingRows: false, dateOrder: "mdy", software: "other" };

/** Each read on a deal of its own: a deal reuses a layout it already learned for the same headings. */
async function readOdd(uploadedBy = "seller", onDeal = fakeDeal(w)) {
  const doc = w.addDocument({ dealId: onDeal.id, fileUrl: w.addFile(fixture("odd.csv")), name: "books.csv", subcategory: "general_ledger", uploadedBy } as any);
  await ingestDocument(doc.id);
  await glQueueIdle();
  return { doc, ledger: (await w.gl.getLedgerByDocument(doc.id))! };
}

await test("the sample sent: ≤40 rows, cells cut to 40 characters, ≤8,000 characters, [r…] references", async () => {
  const rows = await peekRows(fixture("odd.csv"), "csv");
  const { text, width } = sampleText(rows);
  assert.equal(width, 6);
  assert.ok(text.split("\n").length <= 40);
  assert.ok(text.length <= 8000);
  assert.match(text, /^\[r0\] When \| Ledger \| Who \| What \| In \| Out/);
});

await test("a good mapping is accepted after the dry parse; the ledger is read with it", async () => {
  calls = [];
  answer = () => ({ content: [{ type: "tool_use", name: "map_ledger_columns", input: GOOD }] });
  const { ledger } = await readOdd();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool_choice.name, "map_ledger_columns");
  assert.equal(calls[0].max_tokens, 1500);
  assert.equal(ledger.status, "ready");
  assert.equal(ledger.layoutBy, "ai");
  assert.ok(ledger.rowCount > 100);
});

await test("a wrong mapping (dates in the amount column) is refused → needs columns", async () => {
  const rows = await peekRows(fixture("odd.csv"), "csv");
  const wrong = { ...GOOD, columns: [{ index: 4, role: "date" }, { index: 1, role: "account" }, { index: 0, role: "amount" }] };
  assert.equal(layoutFromAnswer(wrong, rows, null, 6).layout, null);
  assert.equal(layoutFromAnswer({ ...GOOD, columns: [{ index: 9, role: "date" }] }, rows, null, 6).layout, null, "a column outside the sample");
  assert.equal(layoutFromAnswer({ ...GOOD, columns: [{ index: 0, role: "date" }, { index: 1, role: "account" }] }, rows, null, 6).layout, null, "no amount");
  answer = () => ({ content: [{ type: "tool_use", name: "map_ledger_columns", input: wrong }] });
  const { ledger } = await readOdd("broker");
  assert.equal(ledger.status, "needs_columns");
});

await test("'not a general ledger' → the file fails with the plain message", async () => {
  answer = () => ({ content: [{ type: "tool_use", name: "map_ledger_columns", input: { ...GOOD, isGeneralLedger: false } }] });
  const { ledger } = await readOdd("broker");
  assert.equal(ledger.status, "failed");
  assert.equal(ledger.failure, LEDGER_FAILURES.notLedger);
});

await test("an outage → needs columns (never silent)", async () => {
  answer = () => { throw Object.assign(new Error("credit balance too low"), { status: 400 }); };
  const { ledger } = await readOdd("broker");
  assert.equal(ledger.status, "needs_columns");
});

await test("the seller's mapping budget: past the cap, no call", async () => {
  calls = [];
  answer = () => ({ content: [{ type: "tool_use", name: "map_ledger_columns", input: GOOD }] });
  const spent = fakeDeal(w);
  const tr = (await w.gl.ensureTracing(spent.id, "12-31")) as any;
  tr.aiDay = new Date().toISOString().slice(0, 10);
  tr.aiSellerMapping = GL_AI_CAPS.seller_mapping;
  const { ledger } = await readOdd("seller", spent);
  assert.equal(calls.length, 0);
  assert.equal(ledger.status, "needs_columns");
});

await test("the key disabled → needs columns without a call", async () => {
  _setGlAiClientForTests(null);
  calls = [];
  const { ledger } = await readOdd("broker");
  assert.equal(calls.length, 0);
  assert.equal(ledger.status, "needs_columns");
});

_setGlAiClientForTests(undefined);
setGlColumnMapper(null);
cleanup(w);
done("assistant column mapping (stubbed)");
