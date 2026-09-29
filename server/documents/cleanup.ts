/**
 * Document removal with provenance cleanup.
 *
 * Used by the broker's DELETE /api/documents/:id and when a seller removes
 * or replaces one of their own uploads from the checklist: the row, the
 * facts it contributed (field provenance) and the file on disk — a deleted
 * tax return must not stay on the volume.
 */
import fs from "fs";
import { storage } from "../storage";
import { sourceRowLookup } from "../interview/info-merger";
import { withDealFactsLock } from "./facts-lock";
import { recordMergeConflicts, settleMergeRowsQuietly } from "./merge-conflicts";
import { removeSourceFromFacts } from "./source-removal";
import { releaseRequirementsFor } from "./requirements";
import type { MergeConflict } from "./merge-policy";
import { resolveDocumentPath } from "./document-path";

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

  // Best-effort file removal — only inside the docs directory, and only
  // when no other row (a copied document) still points at the same file.
  const filePath = resolveDocumentPath(doc);
  const stillUsed = doc.fileUrl ? (await storage.getDocumentsByFileUrl(doc.fileUrl).catch(() => [{}])).length > 0 : false;
  // Awaited: when the delete returns, the file is gone (a missing file is fine).
  if (filePath && !stillUsed) await fs.promises.unlink(filePath).catch(() => {});

  return removed;
}
