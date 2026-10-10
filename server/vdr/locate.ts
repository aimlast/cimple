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
import fs from "fs";
import type { VdrItem, VdrPageText } from "@shared/schema";
import { dbVdrStore, type VdrStore } from "./store";
import { cacheFile, vdrCacheDir } from "./files";
import { uploadsRoot } from "../documents/document-path";

const MAX_NEEDLE = 80;

/** Numbers are compared on their digits ("29,180,000" = "29 180 000" = "29180000"); words case- and space-insensitively. */
export function needleMatcher(needle: unknown): ((text: string) => boolean) | null {
  const re = needlePattern(needle);
  return re ? (text) => re.test(text) : null;
}

/**
 * The needle as a pattern (the rule above). Group 1 is the boundary before
 * a figure, so `index + group1.length` is where the figure itself starts.
 * Null for a needle too short to mean anything.
 */
export function needlePattern(needle: unknown): RegExp | null {
  if (typeof needle !== "string") return null;
  const n = needle.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_NEEDLE);
  if (n.length < 2) return null;
  // A figure: digits with thousands separators, an optional decimal part, $ / % / ( ) around it.
  const fig = n.replace(/^[($\s-]+|[)%\s]+$/g, "");
  if (/^\d{1,3}([,\s  ]\d{3})+(\.\d+)?$|^\d+(\.\d+)?$/.test(fig)) {
    const [int, dec] = fig.replace(/[,\s  ]/g, "").split(".");
    if (int.length < 3 && !dec) return null; // "12" is on every page
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, "[,\\s\\u00a0\\u202f]?");
    return new RegExp(`(^|[^\\d.,])${grouped}${dec ? `\\.${dec}` : ""}(?![\\d]|[.,]\\d)`);
  }
  const words = n.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.join("").length < 3) return null;
  return new RegExp(`()${words.join("\\s+")}`, "i");
}

/** A visible text piece on a page: [x0, y0, x1, y1, text] as fractions (the prepare step's spots.json). */
export type Spot = [number, number, number, number, string];
export type FocusBox = [number, number, number, number];

/**
 * Where the needle sits on a page: the part of each piece that prints it,
 * narrowed by character position (close enough to outline a figure). At
 * most 6 boxes; none when nothing matches.
 */
export function boxesForNeedle(spots: ReadonlyArray<Spot>, needle: unknown): FocusBox[] {
  const re = needlePattern(needle);
  if (!re) return [];
  const out: FocusBox[] = [];
  for (const spot of spots) {
    const [x0, y0, x1, y1, str] = spot;
    const m = re.exec(str);
    if (!m) continue;
    const len = Math.max(1, str.length);
    const start = m.index + (m[1]?.length ?? 0);
    const end = m.index + m[0].length;
    const w = x1 - x0;
    out.push([x0 + (w * start) / len, y0, x0 + (w * end) / len, y1]);
    if (out.length >= 6) break;
  }
  return out;
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

/**
 * Where to open a cited figure: the cited page when it prints the needle,
 * else the page that does; with the boxes that outline it (from the prepare
 * step's spots.json — a document prepared before it existed opens at the
 * page with no boxes). Null when the needle isn't on any page.
 */
export async function focusFor(
  item: Pick<VdrItem, "id" | "dealId" | "prepared">,
  needle: unknown,
  page: number | null,
  store: VdrStore = dbVdrStore,
  root?: string,
): Promise<{ page: number; boxes: FocusBox[] } | null> {
  const match = needleMatcher(needle);
  if (!match) return null;
  const pages = await servedPages(item, store);
  const onCited = page ? pages.find((p) => p.page === page && match(p.text)) : undefined;
  const at = onCited ? onCited.page : pageForNeedle(pages, needle);
  if (!at) return null;
  let boxes: FocusBox[] = [];
  try {
    const forFile = item.prepared?.forFile;
    const dir = forFile ? vdrCacheDir(item.dealId, item.id, forFile, root ?? uploadsRoot()) : null;
    const file = dir ? cacheFile(dir, "spots.json") : null;
    if (file) {
      const json = JSON.parse(await fs.promises.readFile(file, "utf8")) as { pages?: Record<string, Spot[]> };
      boxes = boxesForNeedle(json.pages?.[String(at)] ?? [], needle);
    }
  } catch {
    // No spots file: the page alone.
  }
  return { page: at, boxes };
}
