/**
 * Downloads, built inside the render child (vdr spec §4.3, §9.7). What a
 * buyer can take away is never the original bytes unless the broker chose
 * that explicitly:
 *
 *  - pagesPdf:     a PDF of IMAGE pages — one per served page, the watermark and
 *                  the covers burned in, no text layer, no file details.
 *  - valuesXlsx:   a new workbook of the covered cell values (no formulas, no
 *                  formatting, every sheet shown) with a first sheet
 *                  "Confidential · downloaded by …".
 *  - originalPdf:  the SANITISED served copy (comments, attachments, scripts,
 *                  outline and file details already removed) with the
 *                  watermark line and footer stamped on every page. The
 *                  caller refuses it when any personal number was covered.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ChildJobError } from "./errors";
import { loadPdfLib, loadXlsx } from "./libs";
import { readJobFile } from "./read-file";
import { renderBasePage } from "./prepare-pdf";
import { compositePage, type WatermarkSpec } from "./watermark";
import type { SheetChunk } from "./sheet";

function checkCacheDir(dir: unknown): string {
  if (typeof dir !== "string" || !path.isAbsolute(dir) || dir.includes("\0") || !/[\\/]private-vdr-cache[\\/]/.test(dir)) {
    throw new ChildJobError("unreadable", "no usable output folder");
  }
  return dir;
}

export async function buildPagesPdf(job: { outDir: string; pages: number; source: "served" | "original" | "image"; file?: string | null; mark: WatermarkSpec }): Promise<Uint8Array> {
  const outDir = checkCacheDir(job.outDir);
  const pages = Math.max(0, Math.min(500, Math.floor(Number(job.pages) || 0)));
  if (pages === 0) throw new ChildJobError("unreadable", "nothing to download");
  const { PDFDocument } = await loadPdfLib();
  const pdf = await PDFDocument.create({ updateMetadata: false });
  let sourceBytes: Uint8Array | null = null;
  for (let n = 1; n <= pages; n++) {
    const base = path.join(outDir, `p${n}.webp`);
    if (!existsSync(base)) {
      if (job.source === "image") throw new ChildJobError("unreadable", `no page ${n}`);
      if (!sourceBytes) sourceBytes = job.source === "served" ? await readJobFile(path.join(outDir, "served.pdf")) : await readJobFile(job.file);
      await renderBasePage(sourceBytes, outDir, n, job.source === "served" ? "all" : "none");
    }
    const { jpeg, width, height } = await compositePage(base, 1400, job.mark, 80);
    const img = await pdf.embedJpg(jpeg);
    const w = 612;
    const h = Math.round((612 * height) / width);
    const page = pdf.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return new Uint8Array(await pdf.save({ useObjectStreams: true }));
}

export async function buildValuesXlsx(job: { outDir: string; sheets: Array<{ index: number; name: string }>; stamp: string }): Promise<Uint8Array> {
  const outDir = checkCacheDir(job.outDir);
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[job.stamp]]), "Confidential");
  const used = new Set(["Confidential"]);
  for (const s of job.sheets.slice(0, 200)) {
    if (!Number.isInteger(s.index) || s.index < 0 || s.index > 999) continue;
    const ws = XLSX.utils.aoa_to_sheet([]);
    let wrote = false;
    for (let chunk = 0; chunk < 400; chunk++) {
      const file = path.join(outDir, `sheet-${s.index}-${chunk}.json`);
      if (!existsSync(file)) break;
      const c = JSON.parse(await fs.readFile(file, "utf8")) as SheetChunk;
      const aoa = c.rows.map((r) => r.v.map((v) => (v == null ? null : String(v))));
      if (aoa.length) {
        XLSX.utils.sheet_add_aoa(ws, aoa, { origin: { r: c.firstRow - 1, c: c.firstCol } });
        wrote = true;
      }
    }
    let name = String(s.name || `Sheet ${s.index + 1}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31).trim() || `Sheet ${s.index + 1}`;
    for (let i = 2; used.has(name); i++) name = `${name.slice(0, 27)} (${i})`;
    used.add(name);
    XLSX.utils.book_append_sheet(wb, wrote ? ws : XLSX.utils.aoa_to_sheet([[]]), name);
  }
  wb.Props = {};
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer;
  return new Uint8Array(out);
}

export async function buildOriginalPdf(job: { outDir: string; mark: WatermarkSpec }): Promise<Uint8Array> {
  const outDir = checkCacheDir(job.outDir);
  const bytes = await readJobFile(path.join(outDir, "served.pdf"));
  const { PDFDocument, StandardFonts, rgb, degrees } = await loadPdfLib();
  let pdf;
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    throw new ChildJobError("unreadable", "the served copy couldn't be read");
  }
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const ink = rgb(70 / 255, 66 / 255, 59 / 255);
  // Helvetica (WinAnsi) can't encode every character: keep what it can.
  const safe = (s: string) => s.replace(/[^\x20-\x7E -ÿ]/g, (c) => (c === "·" ? "·" : c === "—" || c === "–" ? "-" : ""));
  const line = job.mark.line ? `${safe(job.mark.line)}     ` : null;
  const footer = safe(job.mark.footer);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    if (line) {
      const size = 14;
      const unit = Math.max(40, font.widthOfTextAtSize(line, size));
      for (let y = -height; y < height * 2; y += 180) {
        for (let x = -width; x < width * 2; x += unit) {
          page.drawText(line, { x, y, size, font, color: ink, opacity: 0.09, rotate: degrees(30) });
        }
      }
    }
    page.drawRectangle({ x: 0, y: 0, width, height: 14, color: rgb(251 / 255, 249 / 255, 244 / 255), opacity: 0.94 });
    page.drawText(footer.slice(0, 160), { x: 8, y: 4, size: 7, font, color: ink });
  }
  return new Uint8Array(await pdf.save({ useObjectStreams: true }));
}
