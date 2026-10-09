/**
 * Document removal with provenance cleanup.
 *
 * Every delete of a source — the broker's DELETE /api/documents/:id, a
 * seller removing or replacing an upload, a CRM import replacing a changed
 * item — goes through deleteDocumentAndProvenance: the row, the facts only
 * it contributed, the discrepancies about it, and the file on disk (a
 * deleted tax return must not stay on the volume, still servable), awaited
 * so the file is gone when the delete returns. A whole deal's delete is
 * server/deals/delete-deal.ts.
 */
import fs from "fs";
import path from "path";
import { storage } from "../storage";
import { sourceRowLookup } from "../interview/info-merger";
import { withDealFactsLock } from "./facts-lock";
import { recordMergeConflicts, settleMergeRowsQuietly } from "./merge-conflicts";
import { removeSourceFromFacts } from "./source-removal";
import { releaseRequirementsFor } from "./requirements";
import type { MergeConflict } from "./merge-policy";
import { docsFileName, resolveDocumentPath, uploadsRoot } from "./document-path";
import { dealMediaDir, mediaFilePath } from "../cim/media-store";

/**
 * Takes a deleted source's facts off its deal (re-read under the deal's
 * facts lock). Saves whenever anything was cleaned — a source whose values
 * all lost to stronger sources still leaves alternates / corroborations /
 * private notes to drop. A fact or a year the source leaves empty is
 * refilled by the merge's own authority (source-removal.ts), and a conflict
 * that leaves standing becomes a discrepancy; then the merge discrepancies
 * the deleted source was a side of are superseded, and the checklist rows
 * it was credited to are released. Returns the removed field keys.
 */
export async function removeSourceFacts(dealId: string, docId: string): Promise<string[]> {
  const documents = (await storage.getDocumentsByDeal(dealId)).filter((d) => d.id !== docId);
  const conflicts: MergeConflict[] = [];
  let saved: Record<string, unknown> | null = null;
  const removed = await withDealFactsLock(dealId, async () => {
    const deal = await storage.getDeal(dealId);
    if (!deal) return [];
    const { info, removed, changed } = removeSourceFromFacts(
      (deal.extractedInfo as Record<string, unknown>) || {},
      docId,
      { conflicts, lookup: sourceRowLookup(documents) },
    );
    if (changed) {
      await storage.updateDeal(dealId, { extractedInfo: info } as any);
      saved = info;
    }
    return removed;
  });
  // What stepped in may disagree with another source (a call's figure vs the
  // final statements'): that stands as a discrepancy, so the gate still sees it.
  if (saved && conflicts.length > 0) {
    await recordMergeConflicts(dealId, conflicts, documents, saved).catch((err) =>
      console.error(`[documents] recording conflicts after a delete failed for ${dealId}:`, err));
  }
  // A conflict the deleted source was a side of no longer stands: it must
  // not keep blocking CIM generation or be put to the seller.
  await settleMergeRowsQuietly(dealId, "documents");
  // The checklist row it was uploaded for is missing again.
  await releaseRequirementsFor(dealId, docId);
  return removed;
}

/**
 * Deletes a document everywhere: the row, the facts only it contributed (and
 * the discrepancies about it), and the file on the uploads volume. Every
 * delete goes through here — the broker's, the seller's, a CRM import
 * replacing a changed item — so a mistaken upload (another client's tax
 * return) never stays on disk once it's gone from the deal. Returns the
 * removed field keys; throws only if the row itself can't be deleted.
 */
export async function deleteDocumentAndProvenance(docId: string): Promise<string[]> {
  const doc = await storage.getDocument(docId);
  if (!doc) return [];

  await storage.deleteDocument(docId);

  let removed: string[] = [];
  try {
    removed = await removeSourceFacts(doc.dealId, docId);
  } catch (e) {
    console.warn("[documents] provenance cleanup failed:", e);
  }
  // 1. together: an "Interview together" transcript stops its session filing (INTEGRATION §2.17).
  try {
    const { onTogetherSourceDeleted } = await import("../together/transcript");
    await onTogetherSourceDeleted(doc);
  } catch (e) {
    console.warn("[documents] together clean-up failed:", e);
  }

  // A general ledger (INTEGRATION §2.17 step 2): its entries and ledger row
  // go under the GL lock, links keep their snapshot as "orphaned", the
  // checklist row follows. Never throws.
  if (doc.subcategory === "general_ledger") {
    const { onLedgerDocumentDeleted } = await import("../gl/ingest");
    await onLedgerDocumentDeleted(doc);
  } else if (doc.subcategory === "addback_support") {
    const { onGlSupportDocumentDeleted } = await import("../gl/support-docs");
    await onGlSupportDocumentDeleted(doc);
  }

  // The data room (INTEGRATION §2.17 step 3): its item becomes a tombstone;
  // the cleaned copy, prepared pages and page text go. Never throws.
  const { onSourceDeleted } = await import("../vdr/setup");
  await onSourceDeleted(doc);

  await removeDocumentFile(doc);
  // dd (INTEGRATION §2.17, last): its citations drop at once; the figure checks re-read the deal's documents.
  void import("../cim/figures/refresh").then((m) => m.invalidateAndRefreshFigures(doc.dealId, "documents")).catch(() => {});
  return removed;
}

/**
 * Best-effort removal of a deleted row's file — only inside the docs folder,
 * and never while another row still points at the same file (a source
 * re-created from a file already in the docs folder keeps its name).
 */
export async function removeDocumentFile(doc: { id: string; fileUrl?: string | null }): Promise<boolean> {
  const filePath = resolveDocumentPath(doc);
  if (!filePath || !doc.fileUrl) return false;
  try {
    // A failed lookup throws into the catch below: the file stays (never
    // delete a file we couldn't prove unused).
    const others = (await storage.getDocumentsByFileUrl(doc.fileUrl)).filter((d) => d.id !== doc.id);
    if (others.length > 0) return false;
    await fs.promises.unlink(filePath);
    return true;
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.warn(`[documents] couldn't remove the file of deleted source ${doc.id}:`, err?.message ?? err);
    return false;
  }
}

/**
 * Files in the docs folder that no documents row points at — left behind by
 * deletes before every delete removed its file. `referenced` is the set of
 * file names rows still use; only files older than `minAgeMs` count (a file
 * is written a moment before its row is created). Pure over the folder.
 */
export function orphanDocumentFiles(
  docsDir: string,
  referenced: ReadonlySet<string>,
  now: number = Date.now(),
  minAgeMs: number = 60 * 60 * 1000,
): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(docsDir); } catch { return []; }
  const out: string[] = [];
  for (const name of names) {
    if (referenced.has(name) || name.startsWith(".")) continue;
    try {
      const st = fs.statSync(path.join(docsDir, name));
      if (!st.isFile() || now - st.mtimeMs < minAgeMs) continue;
    } catch { continue; }
    out.push(name);
  }
  return out;
}

// ── A deleted deal ──────────────────────────────────────────────────────

/**
 * What a deal that is already gone left on the volume: its documents rows
 * (with their extracted text) and their files — never a file another row
 * still points at — and its photos/videos (rows and the deal's
 * private-media folder). DELETE /api/deals/:id used to take only the deals
 * row, so every file the broker ever uploaded to the deal stayed on the
 * volume, and the orphan-file sweep counted them as in use. A live delete
 * now goes through server/deals/delete-deal.ts (every child table); this is
 * the sweep's per-deal step. Best effort per item; returns what it removed.
 */
export async function deleteDealLeftovers(
  dealId: string,
  docs?: Array<{ id: string; fileUrl?: string | null }>,
): Promise<{ documents: number; files: number; media: number }> {
  const out = { documents: 0, files: 0, media: 0 };
  for (const doc of docs ?? (await storage.getDocumentsByDeal(dealId))) {
    try {
      await storage.deleteDocument(doc.id);
      out.documents++;
      if (await removeDocumentFile(doc)) out.files++;
    } catch (err: any) {
      console.warn(`[documents] couldn't remove source ${doc.id} of deleted deal ${dealId}:`, err?.message ?? err);
    }
  }
  try {
    const media = await storage.deleteDealMediaRows(dealId);
    out.media = media.length;
    for (const row of media) {
      const p = mediaFilePath(row);
      if (p) await fs.promises.unlink(p).catch(() => undefined);
    }
    // The deal's own media folder (anything left in it belongs to no row now).
    await fs.promises.rm(dealMediaDir(dealId), { recursive: true, force: true });
  } catch (err: any) {
    console.warn(`[documents] couldn't remove the media of deleted deal ${dealId}:`, err?.message ?? err);
  }
  return out;
}

const DELETED_DEALS_MARKER = ".deleted-deals-sweep-v1";

/**
 * One-off clean-up of what deals deleted before a deal delete took everything
 * left behind: documents rows whose deal is gone (with their files) and
 * photo/video rows and folders of deals that are gone. Runs once per volume
 * (a marker file in the uploads root records it); never runs against an
 * empty deals table (see storage.getDocumentsOfDeletedDeals).
 */
export async function sweepDeletedDealLeftoversOnce(root: string = uploadsRoot()): Promise<{ documents: number; files: number; media: number } | null> {
  const marker = path.join(root, DELETED_DEALS_MARKER);
  if (!fs.existsSync(root) || fs.existsSync(marker)) return null;
  const total = { documents: 0, files: 0, media: 0 };
  const byDeal = new Map<string, Array<{ id: string; fileUrl?: string | null }>>();
  for (const d of await storage.getDocumentsOfDeletedDeals()) {
    const list = byDeal.get(d.dealId) ?? [];
    list.push(d);
    byDeal.set(d.dealId, list);
  }
  for (const id of await storage.getDeletedDealIdsWithMedia()) if (!byDeal.has(id)) byDeal.set(id, []);
  for (const [dealId, docs] of Array.from(byDeal.entries())) {
    const r = await deleteDealLeftovers(dealId, docs);
    total.documents += r.documents;
    total.files += r.files;
    total.media += r.media;
  }
  fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), deals: byDeal.size, ...total }));
  console.log(`[documents] removed what ${byDeal.size} deleted deal(s) left behind: ${total.documents} source row(s), ${total.files} file(s), ${total.media} photo/video row(s)`);
  return total;
}

const SWEEP_MARKER = ".orphan-sweep-v1";

/**
 * One-off clean-up of the files earlier deletes left on the volume (before
 * every delete removed its file): each docs-folder file no documents row
 * points at, older than an hour, is removed. Runs once per volume (a marker
 * file records it). Never empties the folder wholesale: with no referenced
 * file at all it does nothing. Returns how many files it removed.
 */
export async function sweepOrphanDocumentFilesOnce(
  root: string = uploadsRoot(),
  now: number = Date.now(),
  fileUrls: () => Promise<Array<string | null>> = () => storage.getAllDocumentFileUrls(),
): Promise<number> {
  const docsDir = path.join(root, "docs");
  const marker = path.join(docsDir, SWEEP_MARKER);
  if (!fs.existsSync(docsDir) || fs.existsSync(marker)) return 0;
  const referenced = new Set((await fileUrls()).map(docsFileName).filter((n): n is string => !!n));
  if (referenced.size === 0) return 0;
  let removed = 0;
  for (const name of orphanDocumentFiles(docsDir, referenced, now)) {
    try {
      fs.unlinkSync(path.join(docsDir, name));
      removed++;
    } catch { /* gone already */ }
  }
  fs.writeFileSync(marker, JSON.stringify({ at: new Date(now).toISOString(), removed }));
  console.log(`[documents] removed ${removed} file(s) left on the volume by earlier deletes`);
  return removed;
}
