/**
 * Finding a figure or phrase in a data-room document (vdr spec §11.1.6).
 *
 * dd calls `locateNeedle(documentId, needle)` at DD generation so a citation
 * can carry a page number ("T2 corporate tax return 2023 · p. 3"); the
 * viewer calls the same rule at open time (`?needle=`) when a citation has no
 * page. It reads only the SERVED page text (`vdr_page_text`: covered numbers
 * already covered, hidden words already dropped), so a needle can never be
 * "found" under a black box. No AI.
 *
 * Works only for PDFs that are in the room and prepared; anything else is
 * null (dd keeps the needle and the viewer tries again later).
 */
import type { VdrItem, VdrPageText } from "@shared/schema";
import { dbVdrStore, type VdrStore } from "./store";

const MAX_NEEDLE = 80;

/** Numbers are compared on their digits ("29,180,000" = "29 180 000" = "29180000"); words case- and space-insensitively. */
export function needleMatcher(needle: unknown): ((text: string) => boolean) | null {
  if (typeof needle !== "string") return null;
  const n = needle.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_NEEDLE);
  if (n.length < 2) return null;
  // A figure: digits with thousands separators, an optional decimal part, $ / % / ( ) around it.
  const fig = n.replace(/^[($\s-]+|[)%\s]+$/g, "");
  if (/^\d{1,3}([,\s  ]\d{3})+(\.\d+)?$|^\d+(\.\d+)?$/.test(fig)) {
    const [int, dec] = fig.replace(/[,\s  ]/g, "").split(".");
    if (int.length < 3 && !dec) return null; // "12" is on every page
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, "[,\\s\\u00a0\\u202f]?");
    const re = new RegExp(`(^|[^\\d.,])${grouped}${dec ? `\\.${dec}` : ""}(?![\\d]|[.,]\\d)`);
    return (text) => re.test(text);
  }
  const words = n.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.join("").length < 3) return null;
  const re = new RegExp(words.join("\\s+"), "i");
  return (text) => re.test(text);
}

/** The first page (1-based) whose text holds the needle, or null. */
export function pageForNeedle(pages: ReadonlyArray<Pick<VdrPageText, "page" | "text">>, needle: unknown): number | null {
  const match = needleMatcher(needle);
  if (!match) return null;
  const hit = pages.slice().sort((a, b) => a.page - b.page).find((p) => match(p.text));
  return hit ? hit.page : null;
}

/** Page text of an item's CURRENT served file only (a stale row never answers). */
export async function servedPages(item: Pick<VdrItem, "id" | "prepared">, store: VdrStore): Promise<VdrPageText[]> {
  const p = item.prepared ?? null;
  if (!p || p.status !== "ready" || (p.kind !== "pdf" && p.kind !== "image")) return [];
  const rows = await store.getPageText(item.id);
  return rows.filter((r) => !p.forFile || r.forFile === p.forFile);
}

/** The page of an item that holds the needle (PDF pages only), or null. */
export async function locateInItem(item: Pick<VdrItem, "id" | "prepared">, needle: unknown, store: VdrStore = dbVdrStore): Promise<number | null> {
  if (!needleMatcher(needle)) return null;
  return pageForNeedle(await servedPages(item, store), needle);
}

/**
 * dd's call: the page of a document (its live room item) that holds the
 * needle, or null when the document isn't in the room, isn't a prepared PDF,
 * or doesn't print it. Never throws.
 */
export async function locateNeedle(documentId: string, needle: string, store: VdrStore = dbVdrStore): Promise<{ page: number } | null> {
  try {
    if (typeof documentId !== "string" || !documentId) return null;
    const item = (await store.itemsForDocument(documentId)).find((r) => !r.removedAt) ?? null;
    if (!item) return null;
    const page = await locateInItem(item, needle, store);
    return page ? { page } : null;
  } catch (err: any) {
    console.warn(`[vdr] locate failed for ${documentId}:`, err?.message ?? err);
    return null;
  }
}
