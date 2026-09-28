/**
 * parser.ts
 *
 * Extracts text from uploaded documents: PDF, Excel (.xlsx/.xls), plain text/CSV/markdown.
 * Returns raw text for further Claude-powered extraction.
 */
import fs from "fs";
import path from "path";

/**
 * File types Cimple can't read, and what to do instead. officeparser reads
 * only the XML Office formats (.docx / .pptx / .xlsx): a .doc or .ppt went
 * to "Couldn't read" with no reason and still ticked the checklist row.
 */
const UNSUPPORTED_FORMATS: Record<string, string> = {
  ".doc": "Cimple can't read old Word (.doc) files — save it as .docx (File → Save As) and upload that",
  ".ppt": "Cimple can't read old PowerPoint (.ppt) files — save it as .pptx (File → Save As) or as a PDF and upload that",
};

/** Why a file of this name can't be read (a plain sentence), or null. */
export function unsupportedFormatReason(fileName: string): string | null {
  return UNSUPPORTED_FORMATS[path.extname(fileName || "").toLowerCase()] ?? null;
}

/** A file whose format the parser can't read — `message` is the plain reason for the broker or seller. */
export class UnreadableFormatError extends Error {
  readonly unreadable = true;
}

export async function extractTextFromFile(filePath: string, mimeType?: string | null): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();

  // PDF
  if (ext === ".pdf" || mimeType === "application/pdf") {
    const pdfMod = await import("pdf-parse");
    const pdfParse: (buf: Buffer, options?: Record<string, unknown>) => Promise<{ text: string }> =
      (pdfMod as any).default ?? (pdfMod as any);
    const buffer = fs.readFileSync(filePath);
    try {
      const data = await pdfParse(buffer, { pagerender: renderPdfPage });
      return data.text || "";
    } catch (err) {
      // pdf-parse's pdf.js (v1.10, loaded once per process) rejects some
      // valid PDFs with "bad XRef entry" — e.g. every PDF made with PDFKit.
      // The newer pdf.js bundled with pdf-parse reads them.
      try {
        return await extractPdfWithNewerPdfjs(buffer);
      } catch {
        throw err;
      }
    }
  }

  // Excel (.xlsx / .xls)
  if ([".xlsx", ".xls"].includes(ext) ||
      mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mimeType === "application/vnd.ms-excel") {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(fs.readFileSync(filePath));
    const lines: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      if (csv.trim()) {
        lines.push(`--- Sheet: ${sheetName} ---`);
        lines.push(csv);
      }
    }
    return lines.join("\n");
  }

  // The old binary Office formats: the parser reads only the XML ones.
  const unsupported = unsupportedFormatReason(filePath);
  if (unsupported) throw new UnreadableFormatError(unsupported);

  // PowerPoint (.pptx) and Word (.docx)
  if ([".pptx", ".docx"].includes(ext)) {
    const officeparser = await import("officeparser");
    const parse: (file: string) => Promise<string> =
      (officeparser as any).parseOfficeAsync ?? (officeparser as any).default?.parseOfficeAsync;
    return await parse(filePath);
  }

  // Plain text / CSV / markdown
  if ([".txt", ".csv", ".md"].includes(ext) || mimeType?.startsWith("text/")) {
    return fs.readFileSync(filePath, "utf-8");
  }

  // Unsupported — degrade gracefully
  return "";
}

export interface PdfTextItem {
  str: string;
  /** [a, b, c, d, x, y]: d (or a) is the font size, x/y the item's origin. */
  transform: number[];
  /** Advance width in the same units as x, when pdf.js gives it. */
  width?: number;
}

/**
 * A page's text items joined into lines, as pdf-parse does — with a space
 * where two items on one line have a visible gap between them. pdf-parse
 * glued them: a table row "2022 | 58 | 9 | 3 | 6 | 15.5%" came out as
 * "20225893615.5%", which the extractor read as "589 inspections, 36
 * out-of-service" beside a 15.5% rate (Pacific's safety summary), and a
 * label column ran into its value ("National Safety Code (BC)NSC BC …").
 */
export function joinPdfTextItems(items: PdfTextItem[]): string {
  let lastY: number | undefined;
  let lastEnd: number | undefined;
  let text = "";
  for (const item of items) {
    const x = item.transform?.[4];
    const y = item.transform?.[5];
    const size = Math.abs(item.transform?.[3] || item.transform?.[0] || 10);
    if (lastY === undefined || !lastY) {
      text += item.str;
    } else if (lastY === y) {
      const gap = lastEnd !== undefined && typeof x === "number" ? x - lastEnd : 0;
      const space = item.str !== "" && gap > size * 0.15 && !/\s$/.test(text) && !/^\s/.test(item.str);
      text += (space ? " " : "") + item.str;
    } else {
      text += `\n${item.str}`;
    }
    lastY = y;
    // An empty item (pdf.js emits them) doesn't move the line's end.
    if (item.str !== "" || lastEnd === undefined) lastEnd = typeof x === "number" && typeof item.width === "number" ? x + item.width : undefined;
  }
  return text;
}

/** pdf-parse's page renderer, with the gap-aware joining above. */
async function renderPdfPage(pageData: { getTextContent: (o: Record<string, boolean>) => Promise<{ items: PdfTextItem[] }> }): Promise<string> {
  const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
  return joinPdfTextItems(content.items);
}

/** Text of every page via pdf-parse's bundled pdf.js v2 (same line-joining as pdf-parse). */
async function extractPdfWithNewerPdfjs(buffer: Buffer): Promise<string> {
  const mod: any = await import("module");
  const req = (mod.createRequire ?? mod.default.createRequire)(import.meta.url);
  const pdfjs = req("pdf-parse/lib/pdf.js/v2.0.550/build/pdf.js");
  pdfjs.disableWorker = true;
  const task = pdfjs.getDocument(new Uint8Array(buffer));
  const doc = await (task.promise ?? task);
  let text = "";
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += `\n\n${joinPdfTextItems(content.items as PdfTextItem[])}`;
    }
  } finally {
    doc.destroy?.();
  }
  return text;
}
