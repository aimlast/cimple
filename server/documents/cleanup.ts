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

const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), "public", "uploads");

export async function deleteDocumentAndProvenance(docId: string): Promise<string[]> {
  const doc = await storage.getDocument(docId);
  if (!doc) return [];

  await storage.deleteDocument(docId);

  let removed: string[] = [];
  try {
    const deal = await storage.getDeal(doc.dealId);
    if (deal) {
      const result = removeDocumentFields((deal.extractedInfo as Record<string, unknown>) || {}, docId);
      removed = result.removed;
      if (removed.length > 0) await storage.updateDeal(doc.dealId, { extractedInfo: result.info } as any);
    }
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
