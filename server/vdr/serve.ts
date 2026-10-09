/**
 * Serving a prepared document to a reader (vdr spec §6.3, §9.2, §9.3, §9.7):
 * the manifest, page images, spreadsheet rows, Word HTML, text and downloads.
 * Used by the broker's routes (no watermark; or a buyer's for "View as a
 * buyer") and the buyer's routes (always watermarked). The routes decide WHO
 * may read WHAT (access.ts); this module only reads the item's own prepared
 * cache, through confined paths (files.ts), and asks the render pool for the
 * heavy work. No original bytes ever leave here for a view-only reader.
 */
import fs from "fs";
import { downloadDecision, fileKindFor, preparedErrorCopy, downloadCopy, type DownloadDecision, type VdrPrepared } from "@shared/vdr";
import type { VdrManifest, VdrSheetRows } from "@shared/vdr-api";
import type { Document, VdrItem } from "@shared/schema";
import { ensureBasePage, ensurePrepared, markCacheUsed, preparedCacheFile } from "./prepare";
import { renderPool, RenderJobError, type RenderPool } from "./render-pool";
import { servedFilePath, vdrCacheDir } from "./files";
import { uploadsRoot } from "../documents/document-path";
import type { WatermarkSpec } from "./render-jobs";
import type { SheetChunk } from "./child/sheet";
import { ledgerStatusForVdr } from "./gl-adapter";

export type ServeDeps = { pool: Pick<RenderPool, "run">; root: string };
export const defaultServeDeps = (): ServeDeps => ({ pool: renderPool, root: uploadsRoot() });

/** Composite timeout: 5 s warm (§9.5), with room for a cold render process to start. */
const COMPOSITE_TIMEOUT_MS = 15_000;

export function decisionFor(item: VdrItem, prepared: VdrPrepared | null, allowDownloads: boolean, ledger?: { allowOriginalDownload: boolean } | null): DownloadDecision {
  return downloadDecision({ item: { downloadable: item.downloadable, downloadOriginal: item.downloadOriginal }, prepared, buyer: { allowDownloads }, ledger: ledger ?? null });
}

/** The viewer manifest. A buyer never sees a ledger here (gl's viewer reads it), nor any failure detail beyond plain words. */
export function manifestFor(item: VdrItem, doc: Document | null, download: DownloadDecision, audience: "broker" | "buyer"): VdrManifest {
  const p = item.prepared ?? null;
  const kind = p?.kind ?? (doc ? fileKindFor({ name: doc.originalName || doc.name, mimeType: doc.mimeType }) : null);
  if (!p || p.status === "pending") {
    return { status: "pending", kind, pages: [], sheets: [], error: null, download: { allowed: false, label: downloadCopy(download) } };
  }
  if (p.status === "failed") {
    return {
      status: "failed",
      kind,
      pages: [],
      sheets: [],
      error: audience === "broker" ? p.error || preparedErrorCopy(p.errorCode) : "We couldn't show this document here. Ask your broker for a copy.",
      download: { allowed: false, label: downloadCopy(download) },
    };
  }
  return {
    status: "ready",
    kind: p.kind,
    pages: (p.pages ?? []).map((pg) => ({ w: pg.w, h: pg.h })),
    sheets: (p.sheets ?? []).map((s, index) => ({ index, name: s.name, rows: s.rows, cols: s.cols, firstRow: s.firstRow, firstCol: s.firstCol })),
    error: null,
    download: { allowed: download.allowed, label: downloadCopy(download) },
    // gl's ledger viewer reads a ready ledger's rows by its document (INTEGRATION §2.6).
    ...(p.kind === "ledger" && doc ? { ledgerDocumentId: doc.id } : {}),
  };
}

/** Starts preparing (never waits): the viewer polls the manifest. */
export function kickPrepare(itemId: string): void {
  void ensurePrepared(itemId).catch((err) => console.warn(`[vdr] prepare on open failed for ${itemId}:`, err?.message ?? err));
}

// ── Page images ───────────────────────────────────────────────────────────

/** A small LRU of composites (64 MB) so scrolling back costs nothing. */
const LRU_LIMIT = 64 * 1024 * 1024;
const lru = new Map<string, Uint8Array>();
let lruBytes = 0;
function lruGet(key: string): Uint8Array | null {
  const v = lru.get(key);
  if (!v) return null;
  lru.delete(key);
  lru.set(key, v);
  return v;
}
function lruSet(key: string, v: Uint8Array) {
  if (v.byteLength > LRU_LIMIT / 8) return;
  const old = lru.get(key);
  if (old) { lruBytes -= old.byteLength; lru.delete(key); }
  lru.set(key, v);
  lruBytes += v.byteLength;
  for (const [k, val] of Array.from(lru.entries())) {
    if (lruBytes <= LRU_LIMIT) break;
    lru.delete(k);
    lruBytes -= val.byteLength;
  }
}
/** Tests. */
export function _clearCompositeCache() { lru.clear(); lruBytes = 0; }

export class ServeError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

/**
 * One page as the reader sees it: base page (made on first need) →
 * scaled → watermark → JPEG. `cacheKey` must include who it was made for.
 */
export async function pageImage(
  item: VdrItem,
  doc: Document | null,
  page: number,
  width: 700 | 1400,
  mark: WatermarkSpec,
  cacheKey: string,
  deps: ServeDeps = defaultServeDeps(),
): Promise<Uint8Array> {
  const p = item.prepared ?? null;
  if (!p || p.status !== "ready" || (p.kind !== "pdf" && p.kind !== "image")) throw new ServeError(404, "not_found", "Not found");
  const key = `${item.id}|${p.forFile}|${page}|${width}|${cacheKey}`;
  const hit = lruGet(key);
  if (hit) return hit;
  let base: string | null;
  try {
    base = await ensureBasePage(item, doc, p, page, { pool: deps.pool, root: deps.root });
  } catch (err) {
    throw new ServeError(503, err instanceof RenderJobError ? err.code : "unreadable", "The page couldn't be shown right now.");
  }
  if (!base) throw new ServeError(404, "not_found", "Not found");
  try {
    const r = await deps.pool.run({ kind: "composite", file: base, width, mark }, { timeoutMs: COMPOSITE_TIMEOUT_MS });
    const jpeg = r.jpeg instanceof Uint8Array ? r.jpeg : new Uint8Array(r.jpeg as ArrayBuffer);
    lruSet(key, jpeg);
    return jpeg;
  } catch (err) {
    throw new ServeError(503, err instanceof RenderJobError ? err.code : "unreadable", "The page couldn't be shown right now.");
  }
}

// ── Sheets, Word and text ─────────────────────────────────────────────────

function readChunk(item: VdrItem, p: VdrPrepared, sheet: number, chunk: number, root: string): SheetChunk | null {
  const file = preparedCacheFile(item, p, `sheet-${sheet}-${chunk}.json`, root);
  if (!file || !fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as SheetChunk; } catch { return null; }
}

/**
 * Rows of one sheet (200 at a time, at most 500), Excel's own row numbers.
 * With `onlyRows` (≤ 500 Excel row numbers) only those rows come back.
 */
export function sheetRows(item: VdrItem, sheetIndex: number, offset: number, limit: number, onlyRows: number[] | null, root: string = uploadsRoot()): VdrSheetRows | null {
  const p = item.prepared ?? null;
  if (!p || p.status !== "ready" || p.kind !== "sheet" || !p.sheets) return null;
  const meta = p.sheets[sheetIndex];
  if (!meta) return null;
  const dir = vdrCacheDir(item.dealId, item.id, p.forFile, root);
  if (dir) markCacheUsed(dir);
  const sheet = { index: sheetIndex, name: meta.name, rows: meta.rows, cols: meta.cols, firstRow: meta.firstRow, firstCol: meta.firstCol };
  const CH = 1000;
  const out: VdrSheetRows = { sheet, offset: 0, total: meta.rows, rows: [], covered: [] };
  const take = (c: SheetChunk, filter: (r: number) => boolean) => {
    for (const row of c.rows) if (filter(row.r)) out.rows.push(row);
    for (const cv of c.covered) if (filter(cv[0])) out.covered.push(cv);
  };
  if (onlyRows && onlyRows.length) {
    const want = new Set(onlyRows.slice(0, 500));
    const chunks = new Set(Array.from(want).map((r) => Math.floor((r - meta.firstRow) / CH)).filter((c) => c >= 0));
    for (const ci of Array.from(chunks).sort((a, b) => a - b)) {
      const c = readChunk(item, p, sheetIndex, ci, root);
      if (c) take(c, (r) => want.has(r));
    }
    out.total = out.rows.length;
    return out;
  }
  const from = Math.max(0, Math.floor(offset));
  const n = Math.max(1, Math.min(500, Math.floor(limit) || 200));
  out.offset = from;
  const firstChunk = Math.floor(from / CH);
  const lastChunk = Math.floor((from + n - 1) / CH);
  for (let ci = firstChunk; ci <= lastChunk; ci++) {
    const c = readChunk(item, p, sheetIndex, ci, root);
    if (!c) break;
    const lo = meta.firstRow + from, hi = meta.firstRow + from + n - 1;
    take(c, (r) => r >= lo && r <= hi);
  }
  return out;
}

/** The sanitised Word HTML (returned as JSON; the client puts it in a sandboxed iframe). */
export function docHtml(item: VdrItem, root: string = uploadsRoot()): string | null {
  const p = item.prepared ?? null;
  if (!p || p.status !== "ready" || p.kind !== "html") return null;
  const file = preparedCacheFile(item, p, "doc.html", root);
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

export function docText(item: VdrItem, root: string = uploadsRoot()): string | null {
  const p = item.prepared ?? null;
  if (!p || p.status !== "ready" || p.kind !== "text") return null;
  const file = preparedCacheFile(item, p, "text.txt", root);
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

// ── Downloads ─────────────────────────────────────────────────────────────

export type BuiltDownload = { bytes: Uint8Array; contentType: string; fileName: string };

function safeFileName(title: string, ext: string): string {
  const base = title.replace(/[\u0000-\u001f"\\/:*?<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "document";
  return `${base}${ext}`;
}

/** Builds what the decision allows (never the original bytes unless the broker chose that). */
export async function buildDownload(item: VdrItem, doc: Document | null, decision: DownloadDecision, mark: WatermarkSpec, stamp: string, deps: ServeDeps = defaultServeDeps()): Promise<BuiltDownload> {
  if (!decision.allowed) throw new ServeError(403, decision.why, downloadCopy(decision));
  const p = item.prepared!;
  const outDir = vdrCacheDir(item.dealId, item.id, p.forFile, deps.root);
  if (!outDir) throw new ServeError(404, "not_found", "Not found");
  try {
    switch (decision.as) {
      case "pages_pdf": {
        const source = p.kind === "image" ? "image" : p.servedCopy === "original" ? "original" : "served";
        const r = await deps.pool.run({ kind: "pagesPdf", outDir, pages: p.pages?.length ?? 0, source, file: source === "original" ? servedFilePath(item, doc, deps.root) : null, mark });
        return { bytes: r.bytes, contentType: "application/pdf", fileName: safeFileName(item.title, ".pdf") };
      }
      case "values_xlsx": {
        const r = await deps.pool.run({ kind: "valuesXlsx", outDir, sheets: (p.sheets ?? []).map((s, index) => ({ index, name: s.name })), stamp });
        return { bytes: r.bytes, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName: safeFileName(item.title, ".xlsx") };
      }
      case "original_sanitised_pdf": {
        const r = await deps.pool.run({ kind: "originalPdf", outDir, mark });
        return { bytes: r.bytes, contentType: "application/pdf", fileName: safeFileName(item.title, ".pdf") };
      }
      default:
        // Stamped office originals and ledger originals come later (P2 / gl).
        throw new ServeError(403, "not_allowed", "View only. Ask your broker if you need a copy.");
    }
  } catch (err) {
    if (err instanceof ServeError) throw err;
    throw new ServeError(503, err instanceof RenderJobError ? err.code : "unreadable", "The download couldn't be made right now. Try again in a minute.");
  }
}

/** gl's ledger download switch (null until gl ships). */
export async function ledgerSwitch(documentId: string | null): Promise<{ allowOriginalDownload: boolean } | null> {
  if (!documentId) return null;
  const st = await ledgerStatusForVdr(documentId).catch(() => null);
  return st ? { allowOriginalDownload: !!st.allowOriginalDownload } : null;
}
