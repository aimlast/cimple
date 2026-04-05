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
    const data = await pdfParse(buffer);
    return data.text || "";
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

  // Plain text / CSV / markdown
  if ([".txt", ".csv", ".md"].includes(ext) || mimeType?.startsWith("text/")) {
    return fs.readFileSync(filePath, "utf-8");
  }

  // Unsupported — degrade gracefully
  return "";
}
