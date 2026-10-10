/**
 * Preparing a spreadsheet (xlsx / xls / csv) for the data room (vdr spec
 * §9.5 step 4, §9.10), inside the render child.
 *
 *  - xlsx: the zip's central directory is checked first (limits.ts), and
 *    every XML part is scanned for personal numbers (scanOfficeParts) for the
 *    original-download decision.
 *  - SheetJS reads with { dense, sheetRows: 200,001, no formulas, no HTML };
 *    every sheet is kept, hidden ones too (flagged `hidden`, shown as a tab).
 *  - Row and column numbers are Excel's own: row = range start + index + 1,
 *    column (0-based, A = 0) = range start column + index — a sheet whose
 *    range starts at B3 still reports B and 3.
 *  - Personal numbers: per row (cells joined, so a "SIN" label in the cell to
 *    the left counts, and the row above), and a column rule — a column whose
 *    header (first 5 rows) names SIN / SSN / tax id has every 8–9-digit value
 *    covered. Cell comments are scanned too (they are never shown).
 *  - Written as chunks of 1,000 rows: sheet-<i>-<chunk>.json, one page-text
 *    row per chunk ("Sheet 'X', rows a–b").
 */
import fs from "node:fs/promises";
import path from "node:path";
import { findPersonalNumbers, isIdColumnValue, maskNumber, scanOfficeParts, sinColumns, personalKinds, type PersonalKind } from "../../../shared/vdr-sensitive";
import { zipTotals, zipTooLarge } from "./limits";
import { ChildJobError } from "./errors";
import { loadJszip, loadXlsx } from "./libs";
import type { PageTextRow, PrepareResult } from "../render-jobs";

export const SHEET_CHUNK_ROWS = 1000;
const MAX_ROWS = 200_000;
const MAX_PAGE_TEXT = 200_000;

/** One stored chunk of a sheet (what the viewer loads, 200 rows at a time). */
export type SheetChunk = {
  v: 1;
  sheetIndex: number;
  name: string;
  chunk: number;
  /** Excel row numbers of the first and last row in this chunk. */
  firstRow: number;
  lastRow: number;
  /** Absolute 0-based column of the first cell of every row (A = 0). */
  firstCol: number;
  cols: number;
  rows: Array<{ r: number; v: Array<string | null> }>;
  /** Covered cells: [excelRow, absoluteCol]. */
  covered: Array<[number, number]>;
};

/** Every XML part of a zip (office file) as text, for scanOfficeParts. */
export async function zipXmlParts(bytes: Uint8Array): Promise<Array<{ name: string; text: string }>> {
  const JSZip = await loadJszip();
  const zip = await (JSZip as any).loadAsync(bytes);
  const out: Array<{ name: string; text: string }> = [];
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && /\.(xml|rels|vml)$/i.test(n));
  for (const n of names) out.push({ name: n, text: await zip.files[n].async("string") });
  return out;
}

export function checkZip(bytes: Uint8Array): void {
  const totals = zipTotals(bytes);
  if (!totals) throw new ChildJobError("unreadable", "not a readable zip container");
  if (zipTooLarge(totals)) throw new ChildJobError("too_large", `${totals.entries} entries, ${totals.uncompressedBytes} bytes uncompressed`);
}

function cellText(cell: any): string | null {
  if (cell == null) return null;
  if (typeof cell !== "object") return String(cell);
  if (cell.w != null) return String(cell.w);
  if (cell.v != null) return String(cell.v);
  return null;
}

/** Covers one sheet's personal numbers in place. Returns the covered cells and their kinds. */
export function coverSheetRows(rows: Array<Array<string | null>>): { covered: Array<[number, number]>; kinds: PersonalKind[] } {
  const covered: Array<[number, number]> = [];
  const kinds: PersonalKind[] = [];
  const done = new Set<string>();
  const cover = (ri: number, ci: number, kind: PersonalKind, span?: [number, number]) => {
    const k = `${ri}:${ci}`;
    const v = rows[ri][ci];
    if (v == null) return;
    if (!done.has(k)) {
      done.add(k);
      covered.push([ri, ci]);
      kinds.push(kind);
    }
    rows[ri][ci] = span ? v.slice(0, span[0]) + maskNumber(v.slice(span[0], span[1])) + v.slice(span[1]) : maskNumber(v);
  };
  // The column rule (header in the first 5 rows).
  const idCols = sinColumns(rows.slice(0, 5));
  for (const c of idCols) {
    for (let r = 0; r < rows.length; r++) {
      const v = rows[r][c];
      if (v != null && isIdColumnValue(v)) cover(r, c, /SSN|social security/i.test(String(rows.slice(0, 5).map((x) => x[c] ?? "").join(" "))) ? "ssn" : "sin");
    }
  }
  // Per row: cells joined (labels to the left count), the row above as context.
  const SEP = " | ";
  let above = "";
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const starts: number[] = [];
    let line = "";
    for (let c = 0; c < row.length; c++) {
      if (c > 0) line += SEP;
      starts.push(line.length);
      line += row[c] ?? "";
    }
    if (/\d/.test(line)) {
      for (const m of findPersonalNumbers([above, line]).filter((x) => x.line === 1)) {
        for (let c = 0; c < row.length; c++) {
          const s = starts[c], e = s + (row[c] ?? "").length;
          if (m.start < e && m.end > s) {
            const inside = m.start >= s && m.end <= e;
            cover(r, c, m.kind, inside ? [m.start - s, m.end - s] : undefined);
          }
        }
      }
    }
    above = line;
  }
  return { covered, kinds };
}

export async function prepareSheet(bytes: Uint8Array, ext: string, outDir: string): Promise<PrepareResult> {
  const t0 = performance.now();
  await fs.mkdir(outDir, { recursive: true });
  let officeScan: PrepareResult["officeScan"];
  if (ext === ".xlsx") {
    checkZip(bytes);
    officeScan = scanOfficeParts(await zipXmlParts(bytes));
  }
  const XLSX = await loadXlsx();
  let wb: any;
  try {
    wb = ext === ".csv"
      ? XLSX.read(new TextDecoder("utf-8").decode(bytes), { type: "string", dense: true, sheetRows: MAX_ROWS + 1, cellFormula: false, cellHTML: false, raw: false } as any)
      : XLSX.read(bytes, { type: "array", dense: true, sheetRows: MAX_ROWS + 1, cellFormula: false, cellHTML: false } as any);
  } catch (err: any) {
    if (/password|encrypt/i.test(String(err?.message))) throw new ChildJobError("password", "the workbook has a password");
    throw new ChildJobError("unreadable", `the spreadsheet couldn't be read: ${String(err?.message ?? err).slice(0, 150)}`);
  }
  const sheets: NonNullable<PrepareResult["sheets"]> = [];
  const pageTexts: PageTextRow[] = [];
  const kinds: PersonalKind[] = [];
  let personalCount = 0;
  let commentHits = 0;
  let ordinal = 0;
  const names: string[] = wb.SheetNames ?? [];
  for (let si = 0; si < names.length; si++) {
    const name = names[si];
    const ws = wb.Sheets[name];
    const hidden = !!wb.Workbook?.Sheets?.[si]?.Hidden;
    const ref: string | undefined = ws?.["!ref"];
    if (!ws || !ref) {
      sheets.push({ name, rows: 0, cols: 0, firstRow: 1, firstCol: 0, ...(hidden ? { hidden } : {}) });
      continue;
    }
    const range = XLSX.utils.decode_range(ref);
    const full = ws["!fullref"] ? XLSX.utils.decode_range(ws["!fullref"]) : range;
    const truncated = full.e.r - full.s.r + 1 > MAX_ROWS;
    const cols = range.e.c - range.s.c + 1;
    // Rows of formatted text, Excel-aligned: rows[i] is Excel row range.s.r + i + 1.
    const rows: Array<Array<string | null>> = [];
    const dense: any[] = Array.isArray(ws) ? ws : (ws as any)["!data"] ?? [];
    for (let R = range.s.r; R <= Math.min(range.e.r, range.s.r + MAX_ROWS - 1); R++) {
      const src = Array.isArray(dense[R]) ? dense[R] : null;
      const row: Array<string | null> = [];
      for (let C = range.s.c; C <= range.e.c; C++) {
        const cell = src ? src[C] : (ws as any)[XLSX.utils.encode_cell({ r: R, c: C })];
        row.push(cellText(cell));
        // Comments are never shown, but a number in one blocks an original download.
        const comments = cell && typeof cell === "object" && Array.isArray(cell.c) ? cell.c : null;
        if (comments) for (const cm of comments) commentHits += findPersonalNumbers(String(cm?.t ?? "").split("\n")).length;
      }
      rows.push(row);
    }
    const cov = coverSheetRows(rows);
    personalCount += cov.covered.length;
    kinds.push(...cov.kinds);
    const firstRow = range.s.r + 1;
    sheets.push({ name, rows: rows.length, cols, firstRow, firstCol: range.s.c, ...(hidden ? { hidden } : {}), ...(truncated ? { truncated } : {}) });
    for (let start = 0, chunk = 0; start < rows.length; start += SHEET_CHUNK_ROWS, chunk++) {
      const slice = rows.slice(start, start + SHEET_CHUNK_ROWS);
      const out: SheetChunk = {
        v: 1,
        sheetIndex: si,
        name,
        chunk,
        firstRow: firstRow + start,
        lastRow: firstRow + start + slice.length - 1,
        firstCol: range.s.c,
        cols,
        rows: slice.map((v, i) => ({ r: firstRow + start + i, v })),
        covered: cov.covered.filter(([ri]) => ri >= start && ri < start + SHEET_CHUNK_ROWS).map(([ri, ci]) => [firstRow + ri, range.s.c + ci] as [number, number]),
      };
      await fs.writeFile(path.join(outDir, `sheet-${si}-${chunk}.json`), JSON.stringify(out));
      ordinal += 1;
      let text = slice.map((row) => row.filter((c) => c != null && c !== "").join(" | ")).filter(Boolean).join("\n");
      if (text.length > MAX_PAGE_TEXT) text = text.slice(0, MAX_PAGE_TEXT);
      pageTexts.push({ page: ordinal, label: `Sheet '${name}', rows ${(out.firstRow).toLocaleString("en-US")}–${(out.lastRow).toLocaleString("en-US")}`, text });
    }
  }
  return {
    kind: "sheet",
    sheets,
    personal: { count: personalCount, kinds: personalKinds(kinds.map((k) => ({ kind: k }))), pages: [] },
    officeScan: officeScan ? { count: officeScan.count + commentHits, parts: officeScan.parts } : commentHits ? { count: commentHits, parts: ["comments"] } : undefined,
    pageTexts,
    rendered: [],
    ms: Math.round(performance.now() - t0),
  };
}
