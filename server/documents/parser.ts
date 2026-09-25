/**
 * parser.ts
 *
 * Extracts text from uploaded documents: PDF, Excel (.xlsx/.xls), plain text/CSV/markdown.
 * Returns raw text for further Claude-powered extraction.
 */
import fs from "fs";
import path from "path";

export async function extractTextFromFile(filePath: string, mimeType?: string | null): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();

  // PDF
  if (ext === ".pdf" || mimeType === "application/pdf") {
    const pdfMod = await import("pdf-parse");
    const pdfParse: (buf: Buffer) => Promise<{ text: string }> =
      (pdfMod as any).default ?? (pdfMod as any);
    const buffer = fs.readFileSync(filePath);
    try {
      const data = await pdfParse(buffer);
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

  // PowerPoint (.pptx / .ppt) and Word (.docx / .doc)
  if ([".pptx", ".ppt", ".docx", ".doc"].includes(ext)) {
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
      let lastY: number | undefined;
      let pageText = "";
      for (const item of content.items as Array<{ str: string; transform: number[] }>) {
        pageText += lastY === undefined || lastY === item.transform[5] ? item.str : `\n${item.str}`;
        lastY = item.transform[5];
      }
      text += `\n\n${pageText}`;
    }
  } finally {
    doc.destroy?.();
  }
  return text;
}
