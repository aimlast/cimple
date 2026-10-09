/**
 * vdr spec V19, V7, §9.5 (E2, U2): what the eye can't see doesn't get through.
 * Runs the REAL render child through the pool (pdf.js + canvas never load
 * in this process).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-hidden-and-forms.test.ts
 *
 *  - text under a drawn black box, and white-on-white text → hidden, dropped from page text
 *  - white text on a dark header band, and normal text → kept
 *  - a box over one word of a sentence → only that word dropped
 *  - a fillable form: the business name and a SIN are both page text (as form
 *    lines); the SIN is covered on the page image (dark inside the widget) and masked in text
 *  - a sticky note is removed from the served copy; the info dictionary, XMP
 *    metadata, an embedded file and an OpenAction script are not in it at all
 * 046 454 286 is a Luhn-valid TEST number.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import { PDFDocument as PdfLibDoc, PDFName, PDFString, PDFDict } from "pdf-lib";
import { createRenderPool } from "../../server/vdr/render-pool";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-hidden-"));
const cacheRoot = path.join(tmp, "private-vdr-cache", "deal", "item");

function makePdf(file: string, build: (doc: PDFKit.PDFDocument) => void, opts: PDFKit.PDFDocumentOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", ...opts });
    const out = fs.createWriteStream(file);
    out.on("finish", () => resolve(file));
    out.on("error", reject);
    doc.pipe(out);
    build(doc);
    doc.end();
  });
}

const { createCanvas, loadImage } = await import("@napi-rs/canvas"); // the TEST reads the images; the web process never loads the canvas
async function pixels(file: string) {
  const img = await loadImage(fs.readFileSync(file));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}
function darkShare(p: { w: number; data: Uint8ClampedArray }, x0: number, y0: number, x1: number, y1: number): number {
  let dark = 0, n = 0;
  for (let y = Math.round(y0); y < Math.round(y1); y++) {
    for (let x = Math.round(x0); x < Math.round(x1); x++) {
      const i = (y * p.w + x) * 4;
      const lum = 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2];
      n++;
      if (lum < 60) dark++;
    }
  }
  return dark / n;
}

// ── Fixture 1: hidden words ────────────────────────────────────────────────
const sentence = "Owner Harjit Grewal lives in Surrey";
let boxX = 0, boxW = 0;
const hiddenPdf = await makePdf(path.join(tmp, "hidden.pdf"), (doc) => {
  // p1: a black box drawn over a whole line with a SIN in it
  doc.fillColor("black").fontSize(12).text("Redacted: SIN 046 454 286", 72, 100);
  doc.rect(68, 96, 330, 20).fill("#000000");
  doc.fillColor("black").fontSize(12).text("Revenue 29,180,000 (normal text)", 72, 200);
  // p2: white text on a dark header band (a design, not a redaction)
  doc.addPage();
  doc.rect(68, 146, 330, 20).fill("#1F2A44");
  doc.fillColor("white").fontSize(12).text("Income statement 2023 (header band)", 72, 150);
  doc.fillColor("black").fontSize(12).text("Cost of sales 18,400,000", 72, 200);
  // A signature line (underscores sit below the measured band): never "hidden".
  doc.fillColor("black").fontSize(12).text("Per: ______________________", 72, 260);
  doc.fillColor("black").fontSize(12).text("________________________________ Director", 72, 290);
  // p3: white text on white paper
  doc.addPage();
  doc.fillColor("white").fontSize(12).text("Hidden white text Pacific Coast", 72, 250);
  doc.fillColor("black").fontSize(12).text("Visible line on page three", 72, 300);
  // p4: a box over one word in the middle of a sentence
  doc.addPage();
  doc.fillColor("black").fontSize(12).text(sentence, 72, 300, { lineBreak: false });
  doc.font("Helvetica").fontSize(12);
  boxX = 72 + doc.widthOfString("Owner Harjit ") - 1;
  boxW = doc.widthOfString("Grewal") + 2;
  doc.rect(boxX, 298, boxW, 16).fill("#000000");
});

// ── Fixture 2: a fillable form + things that must not ship ────────────────
const formsSrc = await makePdf(path.join(tmp, "forms-src.pdf"), (doc) => {
  doc.fontSize(14).text("Schedule 50 - Shareholder information", 72, 72);
  doc.initForm();
  doc.formText("corpName", 72, 110, 300, 20, { value: "Pacific Coast Logistics Ltd.", fontSize: 11 });
  doc.formText("shareholderSin", 72, 140, 200, 20, { value: "046 454 286", fontSize: 11 });
  doc.note(300, 300, 50, 50, "a sticky note comment from the accountant");
  doc.file(Buffer.from("attached secret spreadsheet"), { name: "secret-attachment.txt" });
}, { info: { Title: "Secret document title", Author: "Harjit Grewal" } });
const formsPdf = path.join(tmp, "forms.pdf");
{
  const d = await PdfLibDoc.load(fs.readFileSync(formsSrc), { updateMetadata: false });
  const js = d.context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert('opened')") });
  d.catalog.set(PDFName.of("OpenAction"), d.context.register(js));
  const xmp = d.context.stream("<x:xmpmeta>Secret XMP author Harjit Grewal</x:xmpmeta>", { Type: "Metadata", Subtype: "XML" });
  d.catalog.set(PDFName.of("Metadata"), d.context.register(xmp));
  fs.writeFileSync(formsPdf, await d.save({ useObjectStreams: false }));
  const raw = fs.readFileSync(formsPdf).toString("latin1");
  for (const s of ["app.alert", "Secret XMP", "secret-attachment.txt", "Secret document title", "sticky note comment"]) assert.ok(raw.includes(s), `fixture carries ${s}`);
}

const pool = createRenderPool({ maxChildren: 1 });
try {
  // ── 1. Hidden words ──
  const out1 = path.join(cacheRoot, "1111111111111111");
  const r1 = await pool.run({ kind: "prepare", file: hiddenPdf, outDir: out1, fileKind: "pdf", ext: ".pdf", prerender: 4 });
  assert.equal(r1.kind, "pdf");
  assert.equal(r1.pages!.length, 4);
  assert.deepEqual(r1.hidden!.pages, [1, 3, 4], "pages 1 (box), 3 (white on white), 4 (box over a word)");
  assert.equal(r1.hidden!.count, 3);
  const text = (n: number) => r1.pageTexts.find((p) => p.page === n)!.text;
  assert.ok(!/046|454|286|Redacted/.test(text(1)), `the boxed line is not page text: ${text(1)}`);
  assert.equal(r1.personal.count, 0, "a number under a box is gone, not 'covered'");
  assert.match(text(1), /Revenue 29,180,000/);
  assert.match(text(2), /Income statement 2023 \(header band\)/, "white text on a dark band is kept (a design, not a redaction)");
  assert.match(text(2), /Cost of sales 18,400,000/);
  assert.match(text(2), /Per: _+/, "a signature line is not hidden text");
  assert.match(text(2), /_+ Director/);
  assert.ok(!/Hidden white text/.test(text(3)), "white-on-white is dropped");
  assert.match(text(3), /Visible line on page three/);
  assert.equal(text(4), "Owner Harjit lives in Surrey", "only the boxed word is dropped");
  assert.deepEqual(r1.forms, { fields: 0, covered: 0 });

  // ── 2. Forms, annotations, metadata ──
  const out2 = path.join(cacheRoot, "2222222222222222");
  const r2 = await pool.run({ kind: "prepare", file: formsPdf, outDir: out2, fileKind: "pdf", ext: ".pdf", prerender: 3 });
  assert.equal(r2.servedCopy, "sanitised");
  assert.deepEqual(r2.forms, { fields: 2, covered: 1 });
  assert.equal(r2.strippedAnnotations, 1, "the sticky note");
  assert.equal(r2.personal.count, 1);
  assert.deepEqual(r2.personal.kinds, ["sin"]);
  assert.deepEqual(r2.personal.pages, [1]);
  const t = r2.pageTexts[0].text;
  assert.match(t, /Form field: Pacific Coast Logistics Ltd\./, "a filled-in value is page text (searchable)");
  assert.match(t, /Form field: ••• ••• 286/, "the SIN in a field is masked in text");
  assert.ok(!t.includes("046 454 286"));
  // On the image: the SIN field is covered (dark), the business-name field is not.
  const img = await pixels(path.join(out2, "p1.webp"));
  const s = img.w / 612;
  assert.ok(darkShare(img, (72 + 5) * s, (140 + 4) * s, (72 + 195) * s, (140 + 16) * s) > 0.95, "dark inside the SIN widget");
  assert.ok(darkShare(img, (72 + 5) * s, (110 + 4) * s, (72 + 295) * s, (110 + 16) * s) < 0.5, "the business name is visible");
  // The served copy: nothing the eye can't see.
  const served = fs.readFileSync(path.join(out2, "served.pdf"));
  const raw = served.toString("latin1");
  for (const secret of ["app.alert", "Secret XMP", "secret-attachment.txt", "attached secret", "Secret document title", "sticky note comment"]) {
    assert.ok(!raw.includes(secret), `served.pdf must not contain "${secret}"`);
  }
  const parsed = await PdfLibDoc.load(served, { updateMetadata: false });
  for (const k of ["Names", "OpenAction", "Metadata", "Outlines", "AA", "AF"]) assert.equal(parsed.catalog.get(PDFName.of(k)), undefined, `catalog /${k} removed`);
  assert.equal(parsed.context.trailerInfo.Info, undefined, "no info dictionary");
  const annots = parsed.getPages()[0].node.Annots();
  const subtypes: string[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i++) subtypes.push(String(annots!.lookup(i, PDFDict).get(PDFName.of("Subtype"))));
  assert.deepEqual(subtypes.sort(), ["/Widget", "/Widget"], "only the form widgets remain");
  // A later page rendered on demand uses the same covers.
  const masks = JSON.parse(fs.readFileSync(path.join(out2, "masks.json"), "utf8"));
  assert.equal(masks.pages["1"].length, 1);
  fs.unlinkSync(path.join(out2, "p1.webp"));
  const again = await pool.run({ kind: "basePage", outDir: out2, page: 1, source: "served" });
  assert.equal(again.width, 1400);
  const img2 = await pixels(path.join(out2, "p1.webp"));
  assert.ok(darkShare(img2, (72 + 5) * s, (140 + 4) * s, (72 + 195) * s, (140 + 16) * s) > 0.95, "covered again on a re-render");

  // ── 3. A PDF pdf-lib can't rewrite (encrypted): read as it is, no annotations drawn ──
  const locked = await makePdf(path.join(tmp, "owner-locked.pdf"), (doc) => {
    doc.fontSize(12).text("Bank statement SIN 046 454 286", 72, 100);
    doc.note(300, 300, 50, 50, "note");
  }, { ownerPassword: "owner-only", permissions: { printing: "highResolution" }, pdfVersion: "1.7" });
  const out3 = path.join(cacheRoot, "3333333333333333");
  const r3 = await pool.run({ kind: "prepare", file: locked, outDir: out3, fileKind: "pdf", ext: ".pdf", prerender: 3 });
  assert.equal(r3.servedCopy, "original");
  assert.equal(fs.existsSync(path.join(out3, "served.pdf")), false, "no served.pdf: originals are never offered for it");
  assert.match(r3.pageTexts[0].text, /SIN ••• ••• 286/, "numbers still covered");
  assert.equal(r3.personal.count, 1);

  // ── 4. A password-protected PDF is refused with its plain code ──
  const pw = await makePdf(path.join(tmp, "pw.pdf"), (doc) => { doc.text("x", 72, 72); }, { userPassword: "u", ownerPassword: "o", pdfVersion: "1.7" });
  await assert.rejects(pool.run({ kind: "prepare", file: pw, outDir: path.join(cacheRoot, "4444444444444444"), fileKind: "pdf", ext: ".pdf" }), (e: any) => e.code === "password");
  // An output folder outside the cache is refused by the child itself.
  await assert.rejects(pool.run({ kind: "prepare", file: hiddenPdf, outDir: path.join(tmp, "elsewhere"), fileKind: "pdf", ext: ".pdf" }), (e: any) => e.code === "unreadable");
} finally {
  await pool.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("vdr hidden-and-forms: ok");
