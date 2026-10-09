/**
 * LOCAL ONLY (vdr spec §12, §14): stand-in files for a QA copy's documents.
 *
 * The demo deals' files live on the Railway volume; a local server has an
 * empty UPLOADS_DIR, so the data room has nothing to show. For each document
 * of a "QA OCT — …" deal owned by qa_cimgen whose file isn't on local disk,
 * this writes a stand-in at the same /uploads/docs/<name>, built from the
 * document's stored text:
 *   - PDFs (pdfkit): paginated, footer "Local test copy"; a synthetic TEST SIN
 *     (046 454 286, Luhn-valid, nobody's) on page 2 of tax returns; a filled
 *     form field on page 1 of the first tax return; a drawn black box over a
 *     line of the first financial statements;
 *   - spreadsheets (SheetJS): one sheet per "--- Sheet: X ---" block of the
 *     stored text; the first gets a "SIN" column;
 *   - anything else: the stored text as a .txt-like file.
 *
 * Refuses unless UPLOADS_DIR is a scratchpad folder (never the Railway volume
 * or public/uploads) and the deal is a qa_cimgen "QA OCT — " copy. Reads the
 * database only; writes only local files. No AI.
 *
 *   UPLOADS_DIR=<scratchpad>/tools/uploads-5907 DATABASE_URL=… npx tsx scripts/vdr-local-fixtures.ts <dealId> [--dry-run]
 */
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";
import { deals, documents, users } from "@shared/schema";
import { resolveDocumentPath, uploadsRoot } from "../server/documents/document-path";
import { extensionOf, fileKindFor } from "@shared/vdr";

const TEST_SIN = "046 454 286";

function refuseUnlessLocal(): string {
  const root = path.resolve(uploadsRoot());
  if (!process.env.UPLOADS_DIR || !/\/scratchpad\//.test(root) || /\/data\/uploads/.test(root)) {
    throw new Error(`refusing: UPLOADS_DIR must be a scratchpad folder (got ${process.env.UPLOADS_DIR ? "a non-scratchpad path" : "nothing"})`);
  }
  return root;
}

function pdfFromText(file: string, title: string, text: string, opts: { sinOnPage2?: boolean; formField?: boolean; blackBox?: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 60, bottom: 60, left: 60, right: 60 }, bufferPages: true });
    const out = fs.createWriteStream(file);
    out.on("finish", () => resolve());
    out.on("error", reject);
    doc.pipe(out);
    doc.font("Helvetica-Bold").fontSize(14).text(title.slice(0, 120), 60, 60);
    let y = 90;
    if (opts.formField) {
      doc.font("Helvetica").fontSize(10).text("Corporation name (form field):", 60, y);
      doc.initForm();
      doc.formText("corporationName", 230, y - 3, 280, 16, { value: title.split(/[—–-]/)[0].trim().slice(0, 60) || "Business name", fontSize: 10 });
      y += 26;
    }
    if (opts.blackBox) {
      doc.font("Helvetica").fontSize(10).fillColor("black").text("Prepared for the owner's personal file — redacted in this copy", 60, y);
      doc.rect(56, y - 3, 360, 16).fill("#000000");
      doc.fillColor("black");
      y += 24;
    }
    doc.font("Helvetica").fontSize(9.5).fillColor("black");
    const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trimEnd()).filter((l, i, a) => l || (a[i - 1] ?? "") !== "");
    let page = 1;
    for (const line of lines.slice(0, 1500)) {
      if (y > 720) {
        doc.addPage();
        page += 1;
        y = 60;
        if (page === 2 && opts.sinOnPage2) {
          doc.font("Helvetica").fontSize(9.5).text(`Schedule 50 — shareholder: test person, SIN ${TEST_SIN}, 60% of the common shares`, 60, y);
          y += 16;
        }
      }
      doc.text(line.slice(0, 160) || " ", 60, y, { width: 490, lineBreak: false });
      y += 13;
    }
    if (page === 1 && opts.sinOnPage2) {
      doc.addPage();
      doc.font("Helvetica").fontSize(9.5).text(`Schedule 50 — shareholder: test person, SIN ${TEST_SIN}, 60% of the common shares`, 60, 60);
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font("Helvetica").fontSize(8).fillColor("#666666").text("Local test copy — made from the stored text, not the original file", 60, 752, { lineBreak: false });
    }
    doc.end();
  });
}

function sheetBlocks(text: string): Array<{ name: string; rows: string[][] }> {
  const blocks: Array<{ name: string; rows: string[][] }> = [];
  const parts = text.split(/^--- Sheet: (.+?) ---$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const csv = parts[i + 1] ?? "";
    const wb = XLSX.read(csv.trim(), { type: "string" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = ws ? (XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, raw: false, defval: "" }) as string[][]) : [];
    blocks.push({ name: parts[i].slice(0, 31).replace(/[\\/?*[\]:]/g, " "), rows });
  }
  if (blocks.length === 0) blocks.push({ name: "Sheet1", rows: text.split("\n").map((l) => l.split(",")) });
  return blocks;
}

async function main() {
  const args = process.argv.slice(2);
  const dealId = args.find((a) => !a.startsWith("--"));
  const dry = args.includes("--dry-run");
  if (!dealId) throw new Error("usage: vdr-local-fixtures.ts <dealId> [--dry-run]");
  const root = refuseUnlessLocal();
  const { db } = await import("../server/db");
  const [deal] = await db.select().from(deals).where(eq(deals.id, dealId));
  if (!deal) throw new Error("no such deal");
  const [owner] = await db.select({ username: users.username }).from(users).where(eq(users.id, deal.brokerId));
  if (owner?.username !== "qa_cimgen" || !String(deal.businessName ?? "").startsWith("QA OCT —")) {
    throw new Error("refusing: only qa_cimgen's \"QA OCT — \" copies");
  }
  const docs = await db.select().from(documents).where(eq(documents.dealId, dealId));
  let firstT2 = true;
  let firstStatement = true;
  let firstSheet = true;
  const planned: string[] = [];
  for (const d of docs) {
    const abs = resolveDocumentPath(d, root);
    if (!abs) { planned.push(`skip   ${d.name} (no usable file path)`); continue; }
    if (fs.existsSync(abs)) { planned.push(`exists ${d.name}`); continue; }
    const kind = fileKindFor({ name: d.originalName || d.fileUrl, mimeType: d.mimeType });
    const text = String(d.extractedText ?? "");
    const isT2 = /\bt2\b|tax return/i.test(d.name);
    const isStatement = /financial statement/i.test(d.name);
    const desc = kind === "pdf"
      ? `pdf    ${d.name}${isT2 ? " (+ test SIN on p.2" + (firstT2 ? ", form field" : "") + ")" : ""}${isStatement && firstStatement ? " (+ black box)" : ""}`
      : kind === "sheet" ? `xlsx   ${d.name}${firstSheet ? " (+ SIN column)" : ""}` : `text   ${d.name} (${extensionOf(d.fileUrl) || "no extension"})`;
    planned.push(desc);
    if (dry) {
      if (kind === "pdf" && isT2) firstT2 = false;
      if (kind === "pdf" && isStatement) firstStatement = false;
      if (kind === "sheet") firstSheet = false;
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (kind === "pdf") {
      await pdfFromText(abs, d.name, text || d.name, { sinOnPage2: isT2, formField: isT2 && firstT2, blackBox: isStatement && firstStatement });
      if (isT2) firstT2 = false;
      if (isStatement) firstStatement = false;
    } else if (kind === "sheet") {
      const wb = XLSX.utils.book_new();
      for (const [i, b] of sheetBlocks(text).entries()) {
        const rows = b.rows.length ? b.rows : [[""]];
        if (i === 0 && firstSheet) {
          rows[0] = [...(rows[0] ?? []), "SIN (test)"];
          if (rows[1]) rows[1] = [...rows[1], "46454286"];
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), b.name || `Sheet${i + 1}`);
      }
      XLSX.writeFile(wb, abs, { bookType: extensionOf(abs) === ".xls" ? "biff8" : extensionOf(abs) === ".csv" ? "csv" : "xlsx" });
      firstSheet = false;
    } else {
      fs.writeFileSync(abs, text || d.name);
    }
  }
  console.log(`${dry ? "Would write" : "Wrote"} stand-ins under ${root}:`);
  for (const p of planned) console.log(`  ${p}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(String(err?.message ?? err).replace(/postgres(ql)?:\/\/[^\s"']+/g, "<DATABASE_URL>"));
  process.exit(1);
});
