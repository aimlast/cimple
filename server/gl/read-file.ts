/**
 * read-file.ts — a ledger file's rows, read without loading it into memory
 * twice and without a library for CSV.
 *
 *  - CSV / TSV / TXT: a streaming RFC-4180 reader in the main thread
 *    (quoted fields, "" inside quotes, newlines inside quotes, CRLF), the
 *    byte-order mark dropped, UTF-16 by its mark, Windows-1252 when the file
 *    isn't valid UTF-8 (Sage 50 and older Excel "CSV" saves), and the
 *    delimiter detected (comma, tab, semicolon, pipe).
 *  - XLSX / XLS: SheetJS in the isolated worker (heavy-sheet.ts) — the
 *    caller holds withHeavySheetSlot around the whole read.
 *
 * Rows are numbered 1-based as the file shows them (every record counts,
 * blank ones too), across sheets for a workbook — that number is the
 * citation ("row 18,422").
 */
import fs from "node:fs";
import path from "node:path";
import { readXlsxInWorker } from "../documents/heavy-sheet";
import type { GlCell, GlRawRow } from "@shared/gl-types";

export type LedgerFileKind = "csv" | "xlsx";

const CSV_EXT = new Set([".csv", ".tsv", ".txt"]);
const XLSX_EXT = new Set([".xlsx", ".xls"]);

/** The reader for a file name, or null when it isn't a spreadsheet Cimple reads as a ledger. */
export function ledgerFileKind(fileName: string | null | undefined): LedgerFileKind | null {
  const ext = path.extname(fileName ?? "").toLowerCase();
  if (CSV_EXT.has(ext)) return "csv";
  if (XLSX_EXT.has(ext)) return "xlsx";
  return null;
}

// ── Encoding ─────────────────────────────────────────────────────────────

export type TextEncodingName = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

/** The encoding of a file from its first bytes plus a UTF-8 validity check of the whole file. */
export async function detectEncoding(filePath: string): Promise<{ encoding: TextEncodingName; bomBytes: number }> {
  const fd = await fs.promises.open(filePath, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await fd.read(head, 0, 4, 0);
    const h = head.subarray(0, bytesRead);
    if (h[0] === 0xff && h[1] === 0xfe) return { encoding: "utf-16le", bomBytes: 2 };
    if (h[0] === 0xfe && h[1] === 0xff) return { encoding: "utf-16be", bomBytes: 2 };
    const bom = h[0] === 0xef && h[1] === 0xbb && h[2] === 0xbf ? 3 : 0;
    // Valid UTF-8 all the way through? (A streaming fatal decode — ~1 s per GB.)
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const buf = Buffer.alloc(1 << 20);
    let pos = 0;
    try {
      for (;;) {
        const { bytesRead: n } = await fd.read(buf, 0, buf.length, pos);
        if (n === 0) break;
        decoder.decode(buf.subarray(0, n), { stream: true });
        pos += n;
      }
      decoder.decode();
      return { encoding: "utf-8", bomBytes: bom };
    } catch {
      return { encoding: "windows-1252", bomBytes: 0 };
    }
  } finally {
    await fd.close();
  }
}

// ── Delimited records ────────────────────────────────────────────────────

/** Picks the delimiter from the first lines of text (outside quotes): the most consistent of , \t ; |. */
export function detectDelimiter(sample: string, fileName?: string | null): string {
  if (/\.tsv$/i.test(fileName ?? "")) return "\t";
  const candidates = [",", "\t", ";", "|"];
  const lines: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < sample.length && lines.length < 40; i++) {
    const c = sample[i];
    if (c === '"') q = !q;
    if (!q && (c === "\n" || c === "\r")) {
      if (cur.trim()) lines.push(cur);
      cur = "";
      continue;
    }
    cur += q ? (c === "," || c === "\t" || c === ";" || c === "|" ? " " : c) : c;
  }
  if (cur.trim()) lines.push(cur);
  let best = ",";
  let bestScore = -1;
  for (const d of candidates) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const withAny = counts.filter((n) => n > 0);
    if (withAny.length === 0) continue;
    // Lines that have it, weighted by how many fields the typical line has.
    const sorted = withAny.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const score = withAny.length * 10 + median;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/**
 * A streaming RFC-4180 record splitter. Feed text chunks; it returns the
 * complete records so far (each with its 1-based record number). Quoted
 * fields may hold delimiters, quotes ("") and newlines; the state carries
 * across chunks, so a "" or a CRLF split between two chunks reads right.
 */
export class DelimitedReader {
  private row: string[] = [];
  private cell = "";
  /** 0 field start · 1 unquoted · 2 quoted · 3 a quote seen inside quotes */
  private state: 0 | 1 | 2 | 3 = 0;
  private pendingCR = false;
  private recordNo = 0;
  constructor(private readonly delimiter: string) {}

  private endRecord(out: Array<{ recordNo: number; cells: string[] }>): void {
    this.row.push(this.cell);
    this.recordNo++;
    out.push({ recordNo: this.recordNo, cells: this.row });
    this.row = [];
    this.cell = "";
    this.state = 0;
  }

  push(text: string): Array<{ recordNo: number; cells: string[] }> {
    const out: Array<{ recordNo: number; cells: string[] }> = [];
    const d = this.delimiter;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (this.pendingCR) {
        this.pendingCR = false;
        if (c === "\n") continue;
      }
      switch (this.state) {
        case 2:
          if (c === '"') this.state = 3;
          else this.cell += c;
          continue;
        case 3:
          if (c === '"') { this.cell += '"'; this.state = 2; continue; }
          // The quote closed the field; fall through to the unquoted rules.
          this.state = 1;
          break;
        case 0:
          if (c === '"') { this.state = 2; continue; }
          break;
        default:
          break;
      }
      if (c === d) {
        this.row.push(this.cell);
        this.cell = "";
        this.state = 0;
      } else if (c === "\n" || c === "\r") {
        if (c === "\r") this.pendingCR = true;
        this.endRecord(out);
      } else {
        this.cell += c;
        this.state = 1;
      }
    }
    return out;
  }

  /** The last record when the text doesn't end with a newline. */
  end(): Array<{ recordNo: number; cells: string[] }> {
    const out: Array<{ recordNo: number; cells: string[] }> = [];
    if (this.state === 0 && this.cell === "" && this.row.length === 0) return out;
    this.endRecord(out);
    return out;
  }
}

const isBlankCells = (cells: GlCell[]) => cells.every((c) => c === null || (typeof c === "string" && c.trim() === ""));

function toCells(cells: string[]): GlCell[] {
  const out: GlCell[] = cells.map((c) => (c === "" ? null : c));
  while (out.length && out[out.length - 1] === null) out.pop();
  return out;
}

export interface ReadOptions {
  /** Rows per batch handed to onBatch (default 1,000). */
  batch?: number;
  /** Stop after this many non-blank rows (a peek). */
  limit?: number;
  /** The file's name (for .tsv). */
  fileName?: string | null;
}

/** Reads a CSV/TSV file's non-blank rows in batches. Resolves with the rows handed over and the encoding used. */
export async function readCsvRows(
  filePath: string,
  onBatch: (rows: GlRawRow[]) => Promise<void> | void,
  opts: ReadOptions = {},
): Promise<{ rows: number; encoding: TextEncodingName; delimiter: string; stoppedEarly: boolean }> {
  const { encoding, bomBytes } = await detectEncoding(filePath);
  const batchSize = opts.batch ?? 1000;
  const decoder = new TextDecoder(encoding);
  const stream = fs.createReadStream(filePath, { start: bomBytes, highWaterMark: 1 << 16 });
  let reader: DelimitedReader | null = null;
  let delimiter = ",";
  let pending = "";
  let batch: GlRawRow[] = [];
  let total = 0;
  let stopped = false;
  const take = async (records: Array<{ recordNo: number; cells: string[] }>) => {
    for (const r of records) {
      const cells = toCells(r.cells);
      if (isBlankCells(cells)) continue;
      batch.push({ sheet: null, rowNo: r.recordNo, cells });
      total++;
      if (opts.limit && total >= opts.limit) { stopped = true; break; }
      if (batch.length >= batchSize) {
        const b = batch;
        batch = [];
        await onBatch(b);
      }
    }
  };
  try {
    for await (const chunk of stream) {
      let text = decoder.decode(chunk as Buffer, { stream: true });
      if (!reader) {
        pending += text;
        // Enough text to see the delimiter (or the end of a short file).
        if (pending.length < 8192) continue;
        if (pending.charCodeAt(0) === 0xfeff) pending = pending.slice(1);
        delimiter = detectDelimiter(pending, opts.fileName);
        reader = new DelimitedReader(delimiter);
        text = pending;
        pending = "";
      }
      await take(reader.push(text));
      if (stopped) break;
    }
    if (!stopped) {
      const tail = decoder.decode();
      if (!reader) {
        pending += tail;
        if (pending.charCodeAt(0) === 0xfeff) pending = pending.slice(1);
        delimiter = detectDelimiter(pending, opts.fileName);
        reader = new DelimitedReader(delimiter);
        await take(reader.push(pending));
      } else if (tail) await take(reader.push(tail));
      if (!stopped) await take(reader.end());
    }
  } finally {
    stream.destroy();
  }
  if (batch.length) await onBatch(batch);
  return { rows: total, encoding, delimiter, stoppedEarly: stopped };
}

/**
 * Reads every non-blank row of a ledger file, in batches. XLSX goes through
 * the worker (the caller holds the heavy-sheet slot). Rejects with
 * SheetReadError for a workbook that can't be read.
 */
export async function readLedgerRows(
  filePath: string,
  kind: LedgerFileKind,
  onBatch: (rows: GlRawRow[]) => Promise<void> | void,
  opts: ReadOptions = {},
): Promise<{ rows: number }> {
  if (kind === "csv") {
    const r = await readCsvRows(filePath, onBatch, opts);
    return { rows: r.rows };
  }
  let total = 0;
  await readXlsxInWorker(filePath, {
    batch: opts.batch ?? 2000,
    onRows: async (rows, sheet) => {
      total += rows.length;
      await onBatch(rows.map((r) => ({ sheet, rowNo: r.rowNo, cells: r.cells })));
    },
  });
  return { rows: total };
}

/** Rows the detector reads: 60 to find the column headings, then 200 for its dry parse (gl spec §6.2). */
export const PEEK_ROWS = 260;
/** A bigger look for files uploaded outside the GL screens (a bank account's 1,000 entries can come first). */
export const SNIFF_ROWS = 2000;

/**
 * The first `n` non-blank rows (per sheet, for a workbook) — what the layout
 * detector looks at. XLSX peeks parse only the first rows of each sheet
 * (sheetRows) in the worker; the caller holds the heavy-sheet slot.
 */
export async function peekRows(filePath: string, kind: LedgerFileKind, n = PEEK_ROWS, fileName?: string | null): Promise<GlRawRow[]> {
  const rows: GlRawRow[] = [];
  if (kind === "csv") {
    await readCsvRows(filePath, (b) => { rows.push(...b); }, { limit: n, batch: n, fileName });
    return rows;
  }
  // A few more physical rows than n: blank rows count toward sheetRows.
  await readXlsxInWorker(filePath, {
    sheetRows: n + 20,
    onRows: (batch, sheet) => {
      for (const r of batch) rows.push({ sheet, rowNo: r.rowNo, cells: r.cells });
    },
  });
  // At most n per sheet.
  const per = new Map<string, number>();
  return rows.filter((r) => {
    const k = r.sheet ?? "";
    const c = per.get(k) ?? 0;
    if (c >= n) return false;
    per.set(k, c + 1);
    return true;
  });
}
