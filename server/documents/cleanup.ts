/**
 * Document removal with provenance cleanup.
 *
 * Used when a seller removes or replaces one of their own uploads from the
 * checklist. Mirrors the broker DELETE /api/documents/:id behaviour (row +
 * extracted-field provenance) and additionally unlinks the file on disk,
 * since a seller has no other way to get a mistaken upload off the deal.
 */
import fs from "fs";
import path from "path";
import { storage } from "../storage";
import { removeDocumentFields } from "../interview/info-merger";
import { withDealFactsLock } from "./facts-lock";
import { settleMergeRowsQuietly } from "./merge-conflicts";

const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), "public", "uploads");

/**
 * Takes a deleted source's facts off its deal (re-read under the deal's
 * facts lock). Saves whenever anything was cleaned — a source whose values
 * all lost to stronger sources still leaves alternates / corroborations /
 * private notes to drop — then supersedes the merge discrepancies it was a
 * side of. Returns the removed field keys.
 */
export async function removeSourceFacts(dealId: string, docId: string): Promise<string[]> {
  const removed = await withDealFactsLock(dealId, async () => {
    const deal = await storage.getDeal(dealId);
    if (!deal) return [];
    const { info, removed, changed } = removeDocumentFields((deal.extractedInfo as Record<string, unknown>) || {}, docId);
    if (changed) await storage.updateDeal(dealId, { extractedInfo: info } as any);
    return removed;
  });
  // A conflict the deleted source was a side of no longer stands: it must
  // not keep blocking CIM generation or be put to the seller.
  await settleMergeRowsQuietly(dealId, "documents");
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

  // Best-effort file removal — only inside the docs directory.
  const filename = doc.fileUrl?.startsWith("/uploads/docs/") ? doc.fileUrl.slice("/uploads/docs/".length) : "";
  if (filename && !filename.includes("..") && !filename.includes("/")) {
    fs.unlink(path.join(uploadsDir, "docs", filename), () => {});
  }

  return removed;
}
