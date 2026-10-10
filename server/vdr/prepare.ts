/**
 * Preparing a room item for viewing (vdr spec §9.5): the web-process side.
 * No AI. The heavy work runs in a render process (render-pool.ts); this
 * module decides what to prepare, confines every path, and writes the
 * result: vdr_items.prepared + vdr_page_text (the SERVED text — numbers
 * covered, hidden words dropped).
 *
 *  1. The served source: the broker's cleaned copy, else the document's file.
 *     Missing → failed `file_missing` (not sticky: an upload fixes it).
 *  2. A general ledger asks gl for its status: `ready` → kind `ledger`;
 *     anything else (or gl not merged) → `ledger_pending` — never served,
 *     indexed or downloadable, no page text.
 *  3. forFile = sha256(bytes + kind + gl status)[:16]: the cache folder's
 *     name; a different forFile means the old cache and the broker's
 *     "I've checked it" tick no longer apply.
 *  4. Failures: `renderer_unavailable` is retried on the next open; a crash
 *     or timeout twice on the same file is sticky ("Too large or damaged to
 *     preview") until the file changes or the broker clicks Try again
 *     (`force`); password / XFA / too long / too large are final for that file.
 *
 * Queue: `enqueuePrepare` (concurrency 1) for background work — a no-op
 * under DISABLE_SCHEDULERS=1 (local servers against production); opening a
 * document calls `ensurePrepared`, which always runs (only the item an
 * authorised user opened). `startPrepareQueue` re-queues stalled work once
 * at start-up.
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { extensionOf, fileKindFor, isLedgerDoc, preparedErrorCopy, presetFolder, VDR_LIMITS, VDR_TICK_BEFORE_PREPARED, type VdrPrepared } from "@shared/vdr";
import { personalRecordsHint } from "@shared/vdr-sensitive";
import { uploadsRoot } from "../documents/document-path";
import { dbVdrStore, type VdrStore } from "./store";
import { cacheFile, removeItemCache, servedFilePath, vdrCacheDir, VDR_CACHE_FOLDER } from "./files";
import { renderPool, RenderJobError, type RenderPool } from "./render-pool";
import { isGlDocument, ledgerStatusForVdr, withHeavySheetSlot, type LedgerStatusForVdr } from "./gl-adapter";
import { VDR_RENDER_LIMITS } from "./child/limits";
import type { PrepareFileKind } from "./render-jobs";

export type PrepareDeps = {
  store: VdrStore;
  pool: Pick<RenderPool, "run">;
  root: string;
  ledgerStatus: (documentId: string) => Promise<LedgerStatusForVdr | null>;
  sheetSlot: <T>(fn: () => Promise<T>) => Promise<T>;
  now: () => Date;
};

export function defaultPrepareDeps(): PrepareDeps {
  return { store: dbVdrStore, pool: renderPool, root: uploadsRoot(), ledgerStatus: ledgerStatusForVdr, sheetSlot: withHeavySheetSlot, now: () => new Date() };
}

const RETRY_CODES = new Set(["renderer_unavailable", "file_missing"]);
const CRASH_CODES = new Set(["timeout", "unreadable"]);

/** The preset folder key an item sits in (for the staff-records hint). */
async function folderKeyOf(store: VdrStore, dealId: string, folderId: string): Promise<string | null> {
  const folders = await store.listFolders(dealId);
  const byId = new Map(folders.map((f) => [f.id, f]));
  let f = byId.get(folderId);
  const seen = new Set<string>();
  while (f && !seen.has(f.id)) {
    seen.add(f.id);
    if (f.presetKey && presetFolder(f.presetKey)) return f.presetKey;
    f = f.parentId ? byId.get(f.parentId) : undefined;
  }
  return null;
}

function sha16(...parts: Array<Uint8Array | string>): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex").slice(0, 16);
}

/**
 * Prepares one item (or returns its current state when nothing changed).
 * Returns null for an item that is gone. Never throws for a document problem:
 * the problem is stored as a failed state with plain words.
 */
export async function prepareItem(itemId: string, opts: { force?: boolean } = {}, deps: PrepareDeps = defaultPrepareDeps()): Promise<VdrPrepared | null> {
  const { store } = deps;
  const item = await store.getItem(itemId);
  if (!item || item.removedAt || !item.documentId) return null;
  const doc = await store.getDocument(item.documentId);
  if (!doc || doc.dealId !== item.dealId) return null;
  const now = deps.now();
  const save = async (prepared: VdrPrepared, extra: Record<string, unknown> = {}) => {
    // A tick given before the first preparation (shared/vdr tickFileFor)
    // carries to the file now prepared. Read again: the broker may have
    // ticked while the file was being read.
    let carry: Record<string, unknown> = {};
    if (prepared.status === "ready") {
      const latest = await store.getItem(item.id).catch(() => null);
      if ((latest ?? item).checkedForFile === VDR_TICK_BEFORE_PREPARED) carry = { checkedForFile: prepared.forFile };
    }
    await store.updateItem(item.id, { prepared, ...extra, ...carry } as any);
    return prepared;
  };

  const fileName = item.cleanCopyPath ? item.cleanCopyName || item.cleanCopyPath : doc.originalName || doc.name || doc.fileUrl;
  const mime = item.cleanCopyPath ? item.cleanCopyMime : doc.mimeType;
  const extFromUrl = extensionOf(item.cleanCopyPath || doc.fileUrl);
  const fileKind = fileKindFor({ name: extensionOf(fileName) ? fileName : `x${extFromUrl}`, mimeType: mime });
  const ext = extensionOf(fileName) || extFromUrl;

  // 1. The served file.
  const abs = servedFilePath(item, doc, deps.root);
  let size = -1;
  try { size = abs ? (await fs.promises.stat(abs)).size : -1; } catch { size = -1; }
  if (!abs || size < 0) {
    await store.deletePageText(item.id);
    return save({ status: "failed", forFile: "0000000000000000", kind: fileKind, errorCode: "file_missing", error: preparedErrorCopy("file_missing"), preparedAt: now.toISOString() });
  }
  if (size > VDR_RENDER_LIMITS.maxFileBytes) {
    await store.deletePageText(item.id);
    return save({ status: "failed", forFile: sha16(String(size), doc.id), kind: fileKind, errorCode: "too_large", error: preparedErrorCopy("too_large"), preparedAt: now.toISOString() });
  }
  const bytes = new Uint8Array(await fs.promises.readFile(abs));
  const fileHash = sha16(bytes);

  // 2. Ledgers (never parsed here).
  const ledger = isLedgerDoc(doc) || isGlDocument(doc);
  let glStatus = "";
  let kind: VdrPrepared["kind"] = fileKind;
  if (ledger) {
    const st = await deps.ledgerStatus(doc.id).catch(() => null);
    glStatus = st?.status ?? "none";
    kind = st?.status === "ready" ? "ledger" : "ledger_pending";
  }
  const forFile = sha16(bytes, "|", kind, "|", glStatus);
  const prev = item.prepared ?? null;
  const fileChanged = !!prev && prev.status === "ready" && !!prev.fileHash && prev.fileHash !== fileHash;
  const versionExtra = fileChanged ? { fileVersion: (item.fileVersion ?? 1) + 1, fileChangedAt: now } : {};

  // 3. Nothing to do? (A ready item whose cache folder was pruned is prepared again.)
  const cacheGone = kind !== "ledger" && kind !== "ledger_pending" && kind !== "unsupported" && !fs.existsSync(vdrCacheDir(item.dealId, item.id, forFile, deps.root) ?? "/nonexistent");
  if (prev && prev.forFile === forFile && !opts.force) {
    if (prev.status === "ready" && !cacheGone) return prev;
    if (prev.status === "failed") {
      const code = prev.errorCode ?? "unreadable";
      const retry = RETRY_CODES.has(code) || (CRASH_CODES.has(code) && (prev.attempts ?? 0) < 2);
      if (!retry) return prev;
    }
  }

  if (kind === "ledger" || kind === "ledger_pending") {
    await store.deletePageText(item.id);
    await removeItemCache(item.dealId, item.id, null, deps.root);
    return save({ status: "ready", forFile, kind, personalRecords: true, fileHash, preparedAt: now.toISOString() }, versionExtra);
  }
  if (fileKind === "unsupported") {
    await store.deletePageText(item.id);
    return save({ status: "failed", forFile, kind: "unsupported", errorCode: "unreadable", error: "Cimple can't show this kind of file.", fileHash, preparedAt: now.toISOString() });
  }

  const outDir = vdrCacheDir(item.dealId, item.id, forFile, deps.root);
  if (!outDir) {
    return save({ status: "failed", forFile, kind: fileKind, errorCode: "unreadable", error: preparedErrorCopy("unreadable"), preparedAt: now.toISOString() });
  }
  const attemptsBefore = prev && prev.forFile === forFile && !opts.force ? prev.attempts ?? 0 : 0;
  await save({ status: "pending", forFile, kind: fileKind, attempts: attemptsBefore, startedAt: now.toISOString(), fileHash });

  const job = {
    kind: "prepare" as const,
    file: abs,
    outDir,
    fileKind: fileKind as PrepareFileKind,
    ext,
    text: fileKind === "text" && ext !== ".txt" && ext !== ".md" ? doc.extractedText ?? null : null,
    prerender: VDR_LIMITS.prerenderPages,
  };
  try {
    const run = () => deps.pool.run(job);
    const result = fileKind === "sheet" ? await deps.sheetSlot(run) : await run();
    const allText = result.pageTexts.map((p) => p.text).join("\n");
    const folderKey = await folderKeyOf(store, item.dealId, item.folderId);
    const prepared: VdrPrepared = {
      status: "ready",
      forFile,
      kind: result.kind,
      ...(result.pages ? { pages: result.pages } : {}),
      ...(result.sheets ? { sheets: result.sheets } : {}),
      personal: result.personal,
      ...(result.officeScan ? { officeScan: result.officeScan } : {}),
      ...(result.hidden ? { hidden: result.hidden } : {}),
      ...(result.forms ? { forms: result.forms } : {}),
      ...(result.strippedAnnotations !== undefined ? { strippedAnnotations: result.strippedAnnotations } : {}),
      ...(result.servedCopy ? { servedCopy: result.servedCopy } : {}),
      personalRecords: personalRecordsHint({ folderKey, subcategory: doc.subcategory }, allText),
      fileHash,
      preparedAt: deps.now().toISOString(),
    };
    await store.replacePageText({ dealId: item.dealId, itemId: item.id, forFile, rows: result.pageTexts.map((r) => ({ ...r, text: r.text.slice(0, VDR_LIMITS.pageTextMaxChars) })) });
    await removeItemCache(item.dealId, item.id, forFile, deps.root);
    return save(prepared, versionExtra);
  } catch (err: any) {
    const code = err instanceof RenderJobError ? err.code : "unreadable";
    const attempts = attemptsBefore + (CRASH_CODES.has(code) ? 1 : 0);
    console.warn(`[vdr] couldn't prepare item ${item.id} (${code}): ${String(err?.message ?? err).slice(0, 200)}`);
    await store.deletePageText(item.id);
    await removeItemCache(item.dealId, item.id, null, deps.root);
    return save({ status: "failed", forFile, kind: fileKind, errorCode: code, error: preparedErrorCopy(code), attempts, fileHash, preparedAt: deps.now().toISOString() });
  }
}

// ── Running it ────────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<VdrPrepared | null>>();

/** Prepares an item now (an authorised user opened it). Concurrent calls share one run. */
export function ensurePrepared(itemId: string, opts: { force?: boolean } = {}, deps?: PrepareDeps): Promise<VdrPrepared | null> {
  const running = inFlight.get(itemId);
  if (running) return running;
  const p = prepareItem(itemId, opts, deps ?? defaultPrepareDeps()).finally(() => inFlight.delete(itemId));
  inFlight.set(itemId, p);
  return p;
}

const queue: string[] = [];
let draining = false;

export function schedulersDisabled(): boolean {
  return process.env.DISABLE_SCHEDULERS === "1";
}

/**
 * Prepares an item in the background, one at a time. Does nothing under
 * DISABLE_SCHEDULERS=1 (a local server against production): the item is
 * prepared when someone opens it.
 */
export function enqueuePrepare(itemId: string): void {
  if (schedulersDisabled()) return;
  if (queue.includes(itemId)) return;
  queue.push(itemId);
  if (!draining) void drain();
}

async function drain(): Promise<void> {
  draining = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      await ensurePrepared(id).catch((err) => console.warn(`[vdr] prepare ${id} failed:`, err?.message ?? err));
    }
  } finally {
    draining = false;
  }
}

/** At start-up: items never prepared, or left "pending" for over 2 minutes by a restart, go back in the queue. */
export async function startPrepareQueue(store: VdrStore = dbVdrStore): Promise<number> {
  if (schedulersDisabled()) return 0;
  startCacheSweep();
  try {
    const items = await store.itemsNeedingPrepare(new Date(Date.now() - 2 * 60_000));
    for (const it of items) enqueuePrepare(it.id);
    if (items.length) console.log(`[vdr] preparing ${items.length} data-room document(s) left from before the restart`);
    return items.length;
  } catch (err: any) {
    console.warn("[vdr] the prepare queue couldn't start:", err?.message ?? err);
    return 0;
  }
}

/**
 * The base image (1,400 px, personal numbers covered) of one page of a ready
 * PDF item: pages 1–3 are made while preparing; a later page is rendered the
 * first time someone scrolls to it (from the served copy, or — for a PDF that
 * couldn't be sanitised — the original with no annotations). Returns the
 * file's absolute path, or null when the page doesn't exist.
 */
export async function ensureBasePage(
  item: { id: string; dealId: string; cleanCopyPath?: string | null },
  doc: { fileUrl?: string | null } | null,
  prepared: VdrPrepared,
  page: number,
  deps: Pick<PrepareDeps, "pool" | "root"> = defaultPrepareDeps(),
): Promise<string | null> {
  if (prepared.status !== "ready" || (prepared.kind !== "pdf" && prepared.kind !== "image")) return null;
  const pages = prepared.pages?.length ?? 0;
  if (!Number.isInteger(page) || page < 1 || page > pages) return null;
  const dir = vdrCacheDir(item.dealId, item.id, prepared.forFile, deps.root);
  const file = dir ? cacheFile(dir, `p${page}.webp`) : null;
  if (!dir || !file) return null;
  if (fs.existsSync(file)) {
    markCacheUsed(dir);
    return file;
  }
  if (prepared.kind === "image") return null; // a photo's one page is made while preparing
  const key = file;
  let running = basePagesInFlight.get(key);
  if (!running) {
    const source = prepared.servedCopy === "original" ? "original" : "served";
    const original = source === "original" ? servedFilePath(item, doc, deps.root) : null;
    running = deps.pool
      .run({ kind: "basePage", outDir: dir, page, source, file: original })
      .then(() => undefined)
      .finally(() => basePagesInFlight.delete(key));
    basePagesInFlight.set(key, running);
  }
  await running;
  return fs.existsSync(file) ? file : null;
}
const basePagesInFlight = new Map<string, Promise<void>>();

/** Reading a prepared folder keeps it from the 30-day sweep (its time is bumped at most hourly). */
const lastTouched = new Map<string, number>();
export function markCacheUsed(dir: string): void {
  const now = Date.now();
  if ((lastTouched.get(dir) ?? 0) > now - 60 * 60_000) return;
  lastTouched.set(dir, now);
  if (lastTouched.size > 5000) lastTouched.clear();
  const t = new Date(now);
  fs.promises.utimes(dir, t, t).catch(() => undefined);
}

/**
 * The weekly sweep (vdr spec §8 "Disk"): prepared folders nobody has read for
 * 30 days are removed (they are rebuilt on the next open). Returns how many.
 */
export async function sweepStaleCaches(root: string = uploadsRoot(), now: number = Date.now(), maxAgeMs = 30 * 24 * 60 * 60_000): Promise<number> {
  const base = path.join(root, VDR_CACHE_FOLDER);
  let removed = 0;
  let deals: string[] = [];
  try { deals = await fs.promises.readdir(base); } catch { return 0; }
  for (const d of deals) {
    let items: string[] = [];
    try { items = await fs.promises.readdir(path.join(base, d)); } catch { continue; }
    for (const it of items) {
      let versions: string[] = [];
      try { versions = await fs.promises.readdir(path.join(base, d, it)); } catch { continue; }
      for (const v of versions) {
        const dir = path.join(base, d, it, v);
        try {
          const names = await fs.promises.readdir(dir);
          // The folder's own time is bumped whenever a page is read (markCacheUsed).
          let newest = (await fs.promises.stat(dir)).mtimeMs;
          for (const n of names) newest = Math.max(newest, (await fs.promises.stat(path.join(dir, n))).mtimeMs);
          if (now - newest > maxAgeMs) {
            await fs.promises.rm(dir, { recursive: true, force: true });
            removed++;
          }
        } catch { /* gone meanwhile */ }
      }
    }
  }
  return removed;
}

let sweepTimer: NodeJS.Timeout | null = null;
function startCacheSweep(): void {
  if (sweepTimer || schedulersDisabled()) return;
  sweepTimer = setInterval(() => {
    sweepStaleCaches().then((n) => { if (n) console.log(`[vdr] removed ${n} data-room preview folder(s) nobody opened for 30 days`); }).catch(() => undefined);
  }, 7 * 24 * 60 * 60_000);
  sweepTimer.unref();
}

/** Cache file of a prepared item (for the viewer routes). */
export function preparedCacheFile(item: { dealId: string; id: string }, prepared: VdrPrepared, name: string, root: string = uploadsRoot()): string | null {
  const dir = vdrCacheDir(item.dealId, item.id, prepared.forFile, root);
  return dir ? cacheFile(dir, name) : null;
}
