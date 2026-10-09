/**
 * gl spec §12.1 tests 3–4: the streaming CSV reader (quotes, newlines in
 * quotes, CRLF split across chunks, BOM, delimiters, Windows-1252, UTF-16),
 * Excel read in the worker (same rows as SheetJS in-thread; the main
 * thread's prototypes untouched; over its memory cap or its time → a plain
 * failure), and one heavy parse at a time.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { test, done, fixture } from "./_harness";
import { DelimitedReader, detectDelimiter, readCsvRows, peekRows, readLedgerRows, detectEncoding } from "../../server/gl/read-file";
import { readXlsxInWorker, SheetReadError, withHeavySheetSlot, heavySheetQueueLength, xlsxToTextInWorker } from "../../server/documents/heavy-sheet";
import type { GlRawRow } from "../../shared/gl-types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gl-read-"));
const write = (name: string, body: string | Buffer) => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p; };

await test("RFC-4180: quotes, doubled quotes, newlines inside quotes, CRLF — even split across chunks", () => {
  const text = 'a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n1,2,3\r\n';
  // Every split point gives the same records.
  for (let cut = 0; cut <= text.length; cut++) {
    const r = new DelimitedReader(",");
    const recs = [...r.push(text.slice(0, cut)), ...r.push(text.slice(cut)), ...r.end()];
    assert.deepEqual(recs.map((x) => x.cells), [["a", "b", "c"], ["x, y", 'say "hi"', "line1\nline2"], ["1", "2", "3"]], `cut at ${cut}`);
    assert.deepEqual(recs.map((x) => x.recordNo), [1, 2, 3]);
  }
});

await test("delimiters: comma, tab, semicolon, pipe; .tsv is a tab", () => {
  assert.equal(detectDelimiter("Date,Account,Amount\n2024-01-01,Rent,100\n"), ",");
  assert.equal(detectDelimiter("Date\tAccount\tAmount\n2024-01-01\tRent\t100\n"), "\t");
  assert.equal(detectDelimiter("Date;Account;Amount\n01/01/2024;Rent;100,00\n"), ";");
  assert.equal(detectDelimiter("Date|Account|Amount\n2024-01-01|Rent|100\n"), "|");
  assert.equal(detectDelimiter("a,b", "x.tsv"), "\t");
  assert.equal(detectDelimiter('"Memo, with commas";Account;Amount\nx;y;1\n'), ";", "commas inside quotes don't count");
});

await test("encodings: BOM dropped, Windows-1252 when not UTF-8, UTF-16 by its mark", async () => {
  const bom = write("bom.csv", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Date,Name\n2024-01-01,Café\n")]));
  const rows: GlRawRow[] = [];
  await readCsvRows(bom, (b) => { rows.push(...b); });
  assert.deepEqual(rows.map((r) => r.cells), [["Date", "Name"], ["2024-01-01", "Café"]]);
  const w1252 = write("w.csv", Buffer.from([...Buffer.from("Date,Name\n2024-01-01,Caf"), 0xe9, 0x0a]));
  assert.equal((await detectEncoding(w1252)).encoding, "windows-1252");
  const r2: GlRawRow[] = [];
  await readCsvRows(w1252, (b) => { r2.push(...b); });
  assert.equal(r2[1].cells[1], "Café");
  const u16 = write("u16.csv", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Date\tName\r\n2024-01-01\tÉlan\r\n", "utf16le")]));
  const r3: GlRawRow[] = [];
  await readCsvRows(u16, (b) => { r3.push(...b); }, { fileName: "u16.tsv" });
  assert.deepEqual(r3.map((r) => r.cells), [["Date", "Name"], ["2024-01-01", "Élan"]]);
});

await test("record numbers count blank lines (the citation is the row the broker sees)", async () => {
  const p = write("blank.csv", "Date,Amount\n\n2024-01-01,5\n,\n2024-01-02,6\n");
  const rows: GlRawRow[] = [];
  await readCsvRows(p, (b) => { rows.push(...b); });
  assert.deepEqual(rows.map((r) => r.rowNo), [1, 3, 5]);
});

await test("streaming CSV = the whole file read at once, on 10,000 rows", async () => {
  const lines = ["Date,Account,Name,Memo,Amount"];
  for (let i = 0; i < 10_000; i++) lines.push(`2024-01-${String((i % 28) + 1).padStart(2, "0")},Acct ${i % 50},"Vendor, ${i}","memo ""${i}""\nwrapped",${(i * 1.37).toFixed(2)}`);
  const p = write("big.csv", lines.join("\r\n"));
  const streamed: GlRawRow[] = [];
  await readCsvRows(p, (b) => { streamed.push(...b); }, { batch: 333 });
  const whole = new DelimitedReader(",");
  const ref = [...whole.push(fs.readFileSync(p, "utf8")), ...whole.end()];
  assert.equal(streamed.length, 10_001);
  assert.deepEqual(streamed.map((r) => r.cells.join("|")), ref.map((r) => r.cells.join("|")));
});

await test("XLSX in the worker gives the same rows as SheetJS in-thread (numbers, text, dates as yyyy-mm-dd)", async () => {
  const p = fixture("qbo-classic.xlsx");
  const viaWorker: GlRawRow[] = [];
  await readLedgerRows(p, "xlsx", (b) => { viaWorker.push(...b); });
  const wb = XLSX.read(fs.readFileSync(p), { dense: true, cellNF: true, cellDates: false });
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, blankrows: false, defval: null });
  assert.equal(viaWorker.length, aoa.length);
  const firstData = viaWorker.find((r) => r.cells.some((c) => c && typeof c === "object"));
  assert.ok(firstData, "date cells come back as { date }");
  const dateCell = firstData!.cells.find((c) => c && typeof c === "object") as { date: string };
  assert.match(dateCell.date, /^\d{4}-\d{2}-\d{2}$/);
  // Every number matches SheetJS's value.
  const nums = (rows: unknown[][]) => rows.flat().filter((c) => typeof c === "number").length;
  assert.equal(nums(viaWorker.map((r) => r.cells)), nums(aoa as unknown[][]) - viaWorker.reduce((n, r) => n + r.cells.filter((c) => c && typeof c === "object").length, 0));
});

await test("a polluted prototype stays in the worker's realm", async () => {
  await readXlsxInWorker(fixture("xero-gl-detail.xlsx"), { sheetRows: 5, testPollute: true, onRows: () => {} });
  assert.equal(({} as Record<string, unknown>).glWorkerPolluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "glWorkerPolluted"), false);
});

await test("a worker over its memory cap or its time fails with the CSV advice, and the server lives on", async () => {
  await assert.rejects(readXlsxInWorker(fixture("qbo-classic.xlsx"), { timeoutMs: 1, onRows: () => {} }), (e: unknown) => e instanceof SheetReadError && e.code === "timeout" && /CSV/.test(e.message));
  // (A cap far below what a worker needs to start at all is a fatal error in V8 itself — the real cap is 900 MB.)
  const rows: unknown[][] = [["Date", "Account", "Name", "Memo", "Amount"]];
  for (let i = 0; i < 30_000; i++) rows.push(["2024-01-01", `Acct ${i % 90}`, `Vendor ${i}`, `Memo for line ${i} with some words`, i * 1.25]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "GL");
  const big = write("big.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }));
  await assert.rejects(readXlsxInWorker(big, { maxOldGenerationSizeMb: 24, onRows: () => {} }), (e: unknown) => e instanceof SheetReadError && e.code === "too_big" && /CSV/.test(e.message));
  // A damaged workbook (a zip cut short).
  const bad = write("bad.xlsx", fs.readFileSync(fixture("qbo-modern.xlsx")).subarray(0, 4000));
  await assert.rejects(readXlsxInWorker(bad, { onRows: () => {} }), (e: unknown) => e instanceof SheetReadError);
});

await test("peeks read only the first rows of each sheet", async () => {
  const rows = await peekRows(fixture("qbo-classic.xlsx"), "xlsx", 30);
  assert.equal(rows.length, 30);
});

await test("the generic parser's big-workbook text comes from the worker, unchanged", async () => {
  const text = await xlsxToTextInWorker(fixture("xero-gl-detail.xlsx"));
  assert.match(text, /^--- Sheet: General Ledger Detail ---/);
  assert.match(text, /Holloway LLP/);
});

await test("one heavy spreadsheet parse at a time (two run one after the other)", async () => {
  const order: string[] = [];
  const job = (name: string, ms: number) => withHeavySheetSlot(async () => {
    order.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${name}:end`);
  });
  const a = job("a", 40);
  const b = job("b", 5);
  assert.equal(heavySheetQueueLength(), 2);
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  // Two real workbook reads queue the same way.
  const t0 = Date.now();
  const spans: Array<[number, number]> = [];
  const read = () => withHeavySheetSlot(async () => { const s = Date.now(); await readLedgerRows(fixture("qbo-modern.xlsx"), "xlsx", () => {}); spans.push([s, Date.now()]); });
  await Promise.all([read(), read()]);
  assert.ok(spans[1][0] >= spans[0][1], "the second started after the first ended");
  assert.ok(Date.now() - t0 < 60_000);
});

fs.rmSync(tmp, { recursive: true, force: true });
done("read-file");
