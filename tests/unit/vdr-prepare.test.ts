/**
 * vdr spec §9.5: the prepare pipeline's web-process side (prepare.ts) with
 * an in-memory store, a temp UPLOADS_DIR and the REAL render child.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-prepare.test.ts
 *
 *  - a PDF (SIN on page 2) → ready: 3 pages, page 2's text masked, the mask stored, base images cached, page text rows
 *  - a photo; a sheet (through the heavy-sheet slot); a text file
 *  - a ledger → ledger_pending (gl not merged): never rendered, no page text, staff/pay flag
 *  - the file missing → failed file_missing (retried when it comes back)
 *  - the broker's cleaned copy is served instead of the original
 *  - same file → no work; a changed file → new forFile, old cache pruned, version bumped
 *  - two crashes on the same file → sticky; renderer down → retried; Try again (force) → runs
 *  - the background queue does nothing under DISABLE_SCHEDULERS=1
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-prepare-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";

const { fakeVdrStore } = await import("./vdr-fake-store");
const { prepareItem, enqueuePrepare, startPrepareQueue, preparedCacheFile } = await import("../../server/vdr/prepare");
const { createRenderPool, RenderJobError } = await import("../../server/vdr/render-pool");
const { setUpRoom } = await import("../../server/vdr/setup");
const { cleanCopyRelPath, cleanCopyPath, newPrivateName, vdrCacheDir } = await import("../../server/vdr/files");
const { itemFlags } = await import("../../shared/vdr");

const docsDir = path.join(root, "docs");
fs.mkdirSync(docsDir, { recursive: true });
function pdf(file: string, build: (d: PDFKit.PDFDocument) => void): Promise<void> {
  return new Promise((res, rej) => {
    const d = new PDFDocument({ size: "LETTER" });
    const s = fs.createWriteStream(file);
    s.on("finish", () => res());
    s.on("error", rej);
    d.pipe(s);
    build(d);
    d.end();
  });
}
await pdf(path.join(docsDir, "doc_t2.pdf"), (d) => {
  d.fontSize(16).text("T2 Corporation Income Tax Return 2023", 72, 72);
  d.fontSize(12).text("Sales 29,180,000", 72, 110);
  d.addPage().fontSize(12).text("Shareholder SIN 046 454 286 holds 60%", 72, 100);
  d.addPage().fontSize(12).text("Schedule 100 balance sheet information", 72, 100);
});
const { createCanvas } = await import("@napi-rs/canvas"); // fixture only
const c = createCanvas(800, 600);
const cx = c.getContext("2d");
cx.fillStyle = "#3a6"; cx.fillRect(0, 0, 800, 600);
fs.writeFileSync(path.join(docsDir, "doc_photo.png"), await c.encode("png"));
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Driver", "SIN", "Wage"], ["A", "46454286", 31]]), "Roster");
  XLSX.writeFile(wb, path.join(docsDir, "doc_roster.xlsx"));
  const gl = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(gl, XLSX.utils.aoa_to_sheet([["Date", "Account", "Amount"], ["2024-01-02", "Meals", 120]]), "GL");
  XLSX.writeFile(gl, path.join(docsDir, "doc_gl.xlsx"));
}
fs.writeFileSync(path.join(docsDir, "doc_notes.txt"), "Lease renewal terms.\nLandlord contact account no. 12345678\n");

const D = "deal-p";
const at = new Date("2026-10-01T00:00:00Z");
const f = fakeVdrStore({
  documents: [
    { id: "t2", dealId: D, name: "T2 corporate income tax return 2023", originalName: "T2 2023.pdf", category: "financials", fileUrl: "/uploads/docs/doc_t2.pdf", mimeType: "application/pdf", createdAt: at },
    { id: "photo", dealId: D, name: "Fleet yard photo", originalName: "yard.png", category: "operations", fileUrl: "/uploads/docs/doc_photo.png", mimeType: "image/png", createdAt: at },
    { id: "roster", dealId: D, name: "Driver roster 2024", originalName: "roster.xlsx", category: "operations", fileUrl: "/uploads/docs/doc_roster.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", createdAt: at },
    { id: "gl", dealId: D, name: "General ledger FY2024", originalName: "GL export.xlsx", category: "financials", fileUrl: "/uploads/docs/doc_gl.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", createdAt: at },
    { id: "notes", dealId: D, name: "Lease notes", originalName: "notes.txt", category: "legal", fileUrl: "/uploads/docs/doc_notes.txt", mimeType: "text/plain", createdAt: at },
    { id: "gone", dealId: D, name: "Bank statements 2024", originalName: "bank.pdf", category: "financials", fileUrl: "/uploads/docs/doc_missing.pdf", mimeType: "application/pdf", createdAt: at },
  ],
});
const pool = createRenderPool({ maxChildren: 1 });
let slotCalls = 0;
const deps = {
  store: f.store,
  pool,
  root,
  ledgerStatus: async () => null,
  sheetSlot: async <T,>(fn: () => Promise<T>) => { slotCalls++; return fn(); },
  now: () => new Date("2026-10-09T12:00:00Z"),
};
await setUpRoom(D, "broker-1", "auto", { store: f.store, enqueue: () => {}, now: deps.now });
const item = (docId: string) => f.items.find((i) => i.documentId === docId && !i.removedAt)!;

try {
  // ── PDF ──
  const p = await prepareItem(item("t2").id, {}, deps);
  assert.equal(p!.status, "ready");
  assert.equal(p!.kind, "pdf");
  assert.equal(p!.pages!.length, 3);
  assert.deepEqual(p!.personal, { count: 1, kinds: ["sin"], pages: [2] });
  assert.equal(p!.servedCopy, "sanitised");
  assert.match(p!.forFile, /^[a-f0-9]{16}$/);
  assert.equal(p!.personalRecords, false);
  const texts = f.pageText.filter((r) => r.itemId === item("t2").id).sort((a, b) => a.page - b.page);
  assert.deepEqual(texts.map((r) => r.label), ["Page 1", "Page 2", "Page 3"]);
  assert.match(texts[0].text, /Sales 29,180,000/);
  assert.match(texts[1].text, /Shareholder SIN ••• ••• 286 holds 60%/);
  assert.ok(texts.every((r) => r.forFile === p!.forFile));
  for (const n of [1, 2, 3]) assert.ok(fs.existsSync(preparedCacheFile(item("t2"), p!, `p${n}.webp`, root)!), `p${n} cached`);
  assert.ok(fs.existsSync(preparedCacheFile(item("t2"), p!, "served.pdf", root)!));
  assert.equal(preparedCacheFile(item("t2"), p!, "../../etc/passwd", root), null);
  // Same file again → nothing re-done (same object back, no new render).
  const mtime = fs.statSync(preparedCacheFile(item("t2"), p!, "p1.webp", root)!).mtimeMs;
  const again = await prepareItem(item("t2").id, {}, deps);
  assert.equal(again!.forFile, p!.forFile);
  assert.equal(fs.statSync(preparedCacheFile(item("t2"), p!, "p1.webp", root)!).mtimeMs, mtime);

  // A pruned cache folder (the 30-day sweep) is rebuilt on the next open.
  fs.rmSync(vdrCacheDir(D, item("t2").id, p!.forFile, root)!, { recursive: true, force: true });
  const rebuilt = await prepareItem(item("t2").id, {}, deps);
  assert.equal(rebuilt!.forFile, p!.forFile);
  assert.ok(fs.existsSync(preparedCacheFile(item("t2"), p!, "p1.webp", root)!), "rebuilt");

  // ── The broker's cleaned copy is what buyers get ──
  const name = newPrivateName(".pdf");
  fs.mkdirSync(path.dirname(cleanCopyPath(D, name, root)!), { recursive: true });
  await pdf(cleanCopyPath(D, name, root)!, (d) => { d.fontSize(12).text("Cleaned copy: shareholder details removed", 72, 100); });
  await f.store.updateItem(item("t2").id, { cleanCopyPath: cleanCopyRelPath(D, name), cleanCopyName: "T2 2023 cleaned.pdf", cleanCopyMime: "application/pdf" });
  const cleaned = await prepareItem(item("t2").id, {}, deps);
  assert.notEqual(cleaned!.forFile, p!.forFile, "a different served file");
  assert.equal(cleaned!.pages!.length, 1);
  assert.equal(cleaned!.personal!.count, 0);
  assert.match(f.pageText.find((r) => r.itemId === item("t2").id)!.text, /Cleaned copy/);
  assert.equal(f.pageText.filter((r) => r.itemId === item("t2").id).length, 1, "old page text replaced");
  assert.equal(fs.existsSync(vdrCacheDir(D, item("t2").id, p!.forFile, root)!), false, "the old cache is pruned");
  assert.equal(item("t2").fileVersion, 2, "a changed file is a new version (Updated)");
  assert.ok(item("t2").fileChangedAt);

  // ── Photo, sheet (via the heavy-sheet slot), text ──
  const ph = await prepareItem(item("photo").id, {}, deps);
  assert.equal(ph!.kind, "image");
  assert.deepEqual(ph!.pages, [{ w: 800, h: 600, hasText: false }]);
  assert.deepEqual(itemFlags(ph!, null).filter((x) => x.look).map((x) => x.key), ["scanned"], "a photo can't be checked for numbers: needs a look");
  const sh = await prepareItem(item("roster").id, {}, deps);
  assert.equal(sh!.kind, "sheet");
  assert.equal(slotCalls, 1, "sheet jobs go through gl's heavy-sheet slot (C19)");
  assert.equal(sh!.personal!.count, 1);
  assert.equal(sh!.personalRecords, true, "a roster in 4.1 Staff is staff/pay records");
  const tx = await prepareItem(item("notes").id, {}, deps);
  assert.equal(tx!.kind, "text");
  assert.match(f.pageText.find((r) => r.itemId === item("notes").id)!.text, /account no\. •••••678/);

  // ── A ledger before gl has read it ──
  const led = await prepareItem(item("gl").id, {}, deps);
  assert.equal(led!.kind, "ledger_pending");
  assert.equal(led!.status, "ready");
  assert.equal(led!.personalRecords, true);
  assert.equal(f.pageText.filter((r) => r.itemId === item("gl").id).length, 0, "a ledger is never indexed by vdr");
  assert.equal(fs.existsSync(path.join(root, "private-vdr-cache", D, item("gl").id)), false, "never rendered");
  // gl reads it → ready → a new forFile (gl status is part of it)
  const ledReady = await prepareItem(item("gl").id, {}, { ...deps, ledgerStatus: async () => ({ status: "ready" as const, allowOriginalDownload: false }) });
  assert.equal(ledReady!.kind, "ledger");
  assert.notEqual(ledReady!.forFile, led!.forFile);

  // ── File missing: failed, but not sticky ──
  const miss = await prepareItem(item("gone").id, {}, deps);
  assert.equal(miss!.status, "failed");
  assert.equal(miss!.errorCode, "file_missing");
  assert.equal(miss!.error, "The file isn't on the server. Upload it again.");
  await pdf(path.join(docsDir, "doc_missing.pdf"), (d) => { d.text("Bank statement January 2024 opening balance", 72, 72); });
  const found = await prepareItem(item("gone").id, {}, deps);
  assert.equal(found!.status, "ready", "the file came back → prepared");

  // ── Failures: two crashes sticky; renderer down retried; Try again runs ──
  let calls = 0;
  const crashing = { run: async () => { calls++; throw new RenderJobError("timeout", "no answer"); } } as any;
  await f.store.updateItem(item("photo").id, { prepared: null });
  const c1 = await prepareItem(item("photo").id, {}, { ...deps, pool: crashing });
  assert.equal(c1!.status, "failed");
  assert.equal(c1!.attempts, 1);
  const c2 = await prepareItem(item("photo").id, {}, { ...deps, pool: crashing });
  assert.equal(c2!.attempts, 2);
  assert.equal(c2!.error, "Too large or damaged to preview.");
  const c3 = await prepareItem(item("photo").id, {}, { ...deps, pool: crashing });
  assert.equal(calls, 2, "sticky after two crashes on the same file");
  assert.equal(c3!.attempts, 2);
  const forced = await prepareItem(item("photo").id, { force: true }, deps);
  assert.equal(forced!.status, "ready", "Try again (force) runs");
  let down = 0;
  const unavailable = { run: async () => { down++; throw new RenderJobError("renderer_unavailable", "down"); } } as any;
  await f.store.updateItem(item("notes").id, { prepared: null });
  await prepareItem(item("notes").id, {}, { ...deps, pool: unavailable });
  const u2 = await prepareItem(item("notes").id, {}, { ...deps, pool: unavailable });
  assert.equal(down, 2, "renderer down is retried on the next open");
  assert.equal(u2!.error, "Page previews aren't available on the server right now.");
  assert.equal(f.pageText.filter((r) => r.itemId === item("notes").id).length, 0, "a failed item has no page text");

  // ── Removed items aren't prepared ──
  await f.store.updateItem(item("notes").id, { removedAt: new Date() });
  assert.equal(await prepareItem(f.items.find((i) => i.documentId === "notes")!.id, {}, deps), null);

  // ── Caps apply to prepare jobs too (before anything is decoded) ──
  const bomb = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(bomb, 0);
  bomb.writeUInt32BE(30000, 16);
  bomb.writeUInt32BE(30000, 20);
  fs.writeFileSync(path.join(docsDir, "doc_bomb.png"), bomb);
  await assert.rejects(pool.run({ kind: "prepare", file: path.join(docsDir, "doc_bomb.png"), outDir: path.join(root, "private-vdr-cache", D, "x", "9999999999999999"), fileKind: "image", ext: ".png" }), (e: any) => e.code === "too_large", "a 900-megapixel header is refused without decoding");

  // ── The background queue is off on a local server against production ──
  enqueuePrepare("anything");
  assert.equal(await startPrepareQueue(f.store), 0);
} finally {
  await pool.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("vdr prepare: ok");
