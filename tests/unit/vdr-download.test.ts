/**
 * vdr spec §4.3, §9.7: what a buyer can take away, built by the REAL render
 * child. No AI, no database.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-download.test.ts
 *
 *  - pages_pdf: one IMAGE page per served page (watermark + covers burned in),
 *    no text layer, no file details — the SIN on page 2 is not in the bytes.
 *  - original_sanitised_pdf: the sanitised served copy with the reader's line
 *    stamped on every page, still no Info dictionary.
 *  - values_xlsx: a first "Confidential" sheet with the stamp, then the
 *    covered cell values (the SIN column covered), no formulas.
 *  - the buyer's route: view-only → 403 with the plain words; allowed (the
 *    document AND the buyer) → the file, the view marked downloaded, logged.
 *  - the composite (the page a reader sees) differs from the base page and is a JPEG.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-download-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";

const { prepareItem } = await import("../../server/vdr/prepare");
const { createRenderPool } = await import("../../server/vdr/render-pool");
const { buildDownload, ServeError } = await import("../../server/vdr/serve");
const { vdrCacheDir } = await import("../../server/vdr/files");
const { downloadDecision } = await import("../../shared/vdr");
const { vdrTestApp } = await import("./vdr-app-harness");
const { PDFDocument: PdfLib } = await import("pdf-lib");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const docsDir = path.join(root, "docs");
fs.mkdirSync(docsDir, { recursive: true });
function pdf(file: string, build: (d: PDFKit.PDFDocument) => void): Promise<void> {
  return new Promise((res, rej) => {
    const d = new PDFDocument({ size: "LETTER", info: { Title: "SECRET TITLE", Author: "Owner Name" } });
    const s = fs.createWriteStream(file);
    s.on("finish", () => res());
    s.on("error", rej);
    d.pipe(s);
    build(d);
    d.end();
  });
}
await pdf(path.join(docsDir, "t2.pdf"), (d) => {
  d.fontSize(16).text("T2 Corporation Income Tax Return 2023", 72, 72);
  d.addPage().fontSize(12).text("Shareholder SIN 046 454 286 holds 60%", 72, 100);
});
await pdf(path.join(docsDir, "lease.pdf"), (d) => { d.fontSize(14).text("Warehouse lease, term 10 years", 72, 72); });
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Driver", "SIN", "Wage"], ["Ann", "046 454 286", 31], ["Bo", "130 692 544", 29]]), "Roster");
  XLSX.writeFile(wb, path.join(docsDir, "roster.xlsx"));
}

const now = new Date("2026-10-09T12:00:00Z");
const later = new Date("2026-11-30T00:00:00Z");
const access = [{ id: "dd", dealId: "D", buyerEmail: "jane@northgate.invalid", buyerName: "Jane Doe", buyerCompany: "Northgate", accessToken: "tok-dd-xxxxxxxxx", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now }];
const docs = [
  { id: "t2", dealId: "D", name: "T2 corporate income tax return 2023", originalName: "T2.pdf", category: "financials", fileUrl: "/uploads/docs/t2.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "lease", dealId: "D", name: "Warehouse lease", originalName: "lease.pdf", category: "legal", fileUrl: "/uploads/docs/lease.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "roster", dealId: "D", name: "Revenue by customer 2024", originalName: "roster.xlsx", category: "financials", fileUrl: "/uploads/docs/roster.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", createdAt: now },
];
const pool = createRenderPool({ maxChildren: 1 });
const h = await vdrTestApp({ root, docs, deals: [{ id: "D", brokerId: "b1", businessName: "Test Co", isLive: true, extractedInfo: {} }], access, now, pool });
await h.call("POST", "/api/deals/D/data-room/setup", { mode: "auto" }, "b1");
const itemOf = (doc: string) => h.f.items.find((i) => i.documentId === doc && !i.removedAt)!;
const pdeps = { store: h.f.store, pool, root, ledgerStatus: async () => null, sheetSlot: <T,>(fn: () => Promise<T>) => fn(), now: () => now };
for (const d of ["t2", "lease", "roster"]) {
  const p = await prepareItem(itemOf(d).id, {}, pdeps);
  assert.equal(p?.status, "ready", `${d} prepared: ${p?.error ?? ""}`);
}
const mark = { line: "Jane Doe · jane@northgate.invalid · 2026-10-09 12:00 UTC · ABCDEF", footer: "Confidential · viewed by jane@northgate.invalid on Oct 9, 2026, 12:00 UTC · shared by Brassline" };
const sdeps = { pool, root };
async function textOf(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  let out = "";
  for (let n = 1; n <= doc.numPages; n++) out += (await (await doc.getPage(n)).getTextContent()).items.map((i: any) => i.str ?? "").join(" ");
  await doc.destroy();
  return out;
}

// ── pages_pdf ──
const t2 = itemOf("t2");
const pages = await buildDownload(t2 as any, docs[0] as any, { allowed: true, as: "pages_pdf" }, mark, "stamp", sdeps);
assert.equal(pages.contentType, "application/pdf");
const pagesDoc = await PdfLib.load(pages.bytes, { updateMetadata: false });
assert.equal(pagesDoc.getPageCount(), 2, "one page per served page");
assert.equal(pagesDoc.getTitle(), undefined, "no file details");
assert.equal(pagesDoc.getAuthor(), undefined);
assert.equal((await textOf(pages.bytes)).trim(), "", "no text layer at all");
const raw = Buffer.from(pages.bytes).toString("latin1");
assert.ok(!raw.includes("046 454 286") && !raw.includes("SECRET TITLE") && !raw.includes("Owner Name"), "nothing hidden underneath");
// Page 2 was rendered on demand (only pages 1–3 are pre-rendered; this PDF has 2).
assert.ok(fs.existsSync(path.join(vdrCacheDir("D", t2.id, t2.prepared!.forFile, root)!, "p2.webp")));

// ── original_sanitised_pdf (a PDF with no personal numbers) ──
const lease = itemOf("lease");
assert.deepEqual(downloadDecision({ item: { downloadable: true, downloadOriginal: true }, prepared: lease.prepared, buyer: { allowDownloads: true } }), { allowed: true, as: "original_sanitised_pdf" });
const orig = await buildDownload(lease as any, docs[1] as any, { allowed: true, as: "original_sanitised_pdf" }, mark, "stamp", sdeps);
const origDoc = await PdfLib.load(orig.bytes, { updateMetadata: false });
assert.equal(origDoc.getPageCount(), 1);
assert.equal(origDoc.getTitle(), undefined, "the served copy carries no file details");
const origText = await textOf(orig.bytes);
assert.ok(origText.includes("Warehouse lease"), "the original's text stays (it's the original)");
assert.ok(origText.includes("jane@northgate.invalid"), "the reader's line is stamped on the page");
assert.ok(origText.includes("Confidential · viewed by jane@northgate.invalid"), "and the footer");
// The T2 has a covered SIN → never as the original.
assert.deepEqual(downloadDecision({ item: { downloadable: true, downloadOriginal: true }, prepared: t2.prepared, buyer: { allowDownloads: true } }), { allowed: false, why: "personal_numbers" });

// ── values_xlsx ──
const sheet = itemOf("roster");
const xlsx = await buildDownload(sheet as any, docs[2] as any, { allowed: true, as: "values_xlsx" }, mark, "Confidential · downloaded by Jane Doe jane@northgate.invalid · 2026-10-09 12:00 UTC · ABCDEF", sdeps);
const wb = XLSX.read(xlsx.bytes, { type: "array", cellFormula: true });
assert.deepEqual(wb.SheetNames, ["Confidential", "Roster"]);
assert.match(String(wb.Sheets.Confidential.A1.v), /downloaded by Jane Doe jane@northgate.invalid .* ABCDEF/);
const rows = XLSX.utils.sheet_to_json(wb.Sheets.Roster, { header: 1, raw: false }) as string[][];
assert.equal(rows[0][1], "SIN");
assert.ok(!JSON.stringify(rows).includes("454") && !JSON.stringify(rows).includes("692"), "the SIN column is covered in the copy");
assert.ok(rows[1][1].includes("•"), "covered, not dropped");
assert.equal(rows[1][0], "Ann");
assert.ok(Object.values(wb.Sheets.Roster).every((c: any) => !c || typeof c !== "object" || !c.f), "no formulas");

// A decision that isn't allowed can't be built.
await assert.rejects(buildDownload(t2 as any, null, { allowed: false, why: "not_allowed" }, mark, "s", sdeps), (e: any) => e instanceof ServeError && e.status === 403);

// ── The composite a reader sees ──
const comp = await pool.run({ kind: "composite", file: path.join(vdrCacheDir("D", t2.id, t2.prepared!.forFile, root)!, "p1.webp"), width: 700, mark });
assert.equal(comp.jpeg[0], 0xff);
assert.equal(comp.jpeg[1], 0xd8, "JPEG");
assert.equal(comp.width, 700);
const plain = await pool.run({ kind: "composite", file: path.join(vdrCacheDir("D", t2.id, t2.prepared!.forFile, root)!, "p1.webp"), width: 700, mark: { line: null, footer: "x" } });
assert.notDeepEqual(Buffer.from(comp.jpeg), Buffer.from(plain.jpeg), "the watermark changes the pixels");

// ── The buyer's download route ──
const R = "/api/deals/D/data-room";
await h.call("PUT", `${R}/items/${t2.id}/shares`, { levels: ["due_diligence"], allow: [], deny: [] }, "b1");
const V = "/api/view/tok-dd-xxxxxxxxx/data-room";
const start = await h.call("POST", `${V}/views/start`, { itemId: t2.id });
assert.equal(start.status, 200);
const viewOnly = await h.call("GET", `${V}/items/${t2.id}/download?v=${start.json.viewId}`);
assert.equal(viewOnly.status, 403);
assert.equal(viewOnly.json.error, "View only. Ask your broker if you need a copy.");
await h.call("PATCH", `${R}/items/${t2.id}`, { downloadable: true }, "b1");
assert.equal((await h.call("GET", `${V}/items/${t2.id}/download?v=${start.json.viewId}`)).status, 403, "the buyer must be allowed too");
await h.call("PATCH", `${R}/buyers/dd`, { allowDownloads: true }, "b1");
const about = await h.call("GET", `${V}/items/${t2.id}`);
assert.deepEqual(about.json.manifest.download, { allowed: true, label: "Download (pages as PDF)" });
const dl = await fetch(`${h.base}${V}/items/${t2.id}/download?v=${start.json.viewId}`);
assert.equal(dl.status, 200);
assert.equal(dl.headers.get("content-type"), "application/pdf");
assert.match(dl.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''T2/);
assert.equal((await PdfLib.load(new Uint8Array(await dl.arrayBuffer()))).getPageCount(), 2);
assert.equal(h.f.views.find((v) => v.id === start.json.viewId)!.downloaded, true);
assert.ok(h.f.activity.some((a) => a.action === "buyer_downloaded" && a.itemId === t2.id));
// Offering the original is refused for a PDF with a covered SIN (plain words).
const refuse = await h.call("PATCH", `${R}/items/${t2.id}`, { downloadOriginal: true }, "b1");
assert.equal(refuse.status, 409);
assert.match(refuse.json.error, /social insurance numbers/);

h.close();
await pool.close();
console.log("vdr-download: all passed");
process.exit(0);
