/**
 * Teaser pages (pure; no DOM). A teaser is drawn on real pages — Letter
 * (816 × 1056 CSS px) or A4 (794 × 1123), 48 px margins — and blocks never
 * split across pages unless one is taller than a page.
 *
 *   paginateTeaser(heights, availableHeight, gap) → which items go on which page
 *   fitSentence(…)                                 → "Fits on 1 page" / "Runs onto page 3 by about 6 lines — …"
 *
 * Item 0 is the header when there is one; the rest are the blocks in order.
 */
import { TEASER_PAGE_MARGIN, TEASER_PAGE_SIZES, type TeaserPageSize } from "@shared/teaser";

export interface TeaserPagination {
  /** Item indices per page. */
  pages: number[][];
  /** Height used on each page (CSS px; can exceed the page for an oversized item). */
  used: number[];
}

/** The usable box of a page (inside the 48 px margins). */
export function pageBox(size: TeaserPageSize): { width: number; height: number; contentWidth: number; contentHeight: number } {
  const p = TEASER_PAGE_SIZES[size] ?? TEASER_PAGE_SIZES.letter;
  return { width: p.width, height: p.height, contentWidth: p.width - 2 * TEASER_PAGE_MARGIN, contentHeight: p.height - 2 * TEASER_PAGE_MARGIN };
}

/**
 * Greedy: each item goes on the current page when it fits; otherwise it
 * starts the next page. An item taller than a whole page gets a page of its
 * own (it runs past that page's bottom — never split).
 */
export function paginateTeaser(heights: number[], availableHeight: number, gap: number): TeaserPagination {
  const pages: number[][] = [];
  const used: number[] = [];
  let cur: number[] = [];
  let h = 0;
  heights.forEach((raw, i) => {
    const itemH = Math.max(0, Number.isFinite(raw) ? raw : 0);
    const add = cur.length === 0 ? itemH : gap + itemH;
    if (cur.length > 0 && h + add > availableHeight) {
      pages.push(cur);
      used.push(h);
      cur = [];
      h = 0;
    }
    h += cur.length === 0 ? itemH : gap + itemH;
    cur.push(i);
  });
  if (cur.length > 0 || pages.length === 0) {
    pages.push(cur);
    used.push(h);
  }
  return { pages, used };
}

/** How many printed pages a pagination makes (an oversized item spills onto more). */
export function printedPageCount(p: TeaserPagination, availableHeight: number): number {
  return p.used.reduce((n, u) => n + Math.max(1, Math.ceil(u / Math.max(1, availableHeight) - 1e-6)), 0);
}

/** About how many lines of text a height is (body text ≈ 22 px a line). */
export function linesFor(px: number, lineHeight = 22): number {
  return Math.max(1, Math.round(px / lineHeight));
}

/**
 * The fit indicator (editor only; it never blocks — the broker can make the
 * teaser as long as they like):
 *   1 page                          → "Fits on 1 page"
 *   within the template's length    → "Fits on 2 pages"
 *   just over (≤ 15 lines spill)    → "Runs onto page 3 by about 6 lines — shorten a block or keep it longer, it's up to you"
 *   longer                          → "3 pages"
 */
export function fitSentence(input: { pages: number; targetPages: number; lastPageUsed: number; lineHeight?: number }): { text: string; over: boolean } {
  const { pages, targetPages } = input;
  if (pages <= 1) return { text: "Fits on 1 page", over: false };
  if (pages <= Math.max(1, targetPages)) return { text: `Fits on ${pages} pages`, over: false };
  const lines = linesFor(input.lastPageUsed, input.lineHeight);
  if (pages === Math.max(1, targetPages) + 1 && lines <= 15) {
    return { text: `Runs onto page ${pages} by about ${lines} line${lines === 1 ? "" : "s"} — shorten a block or keep it longer, it's up to you`, over: true };
  }
  return { text: `${pages} pages`, over: true };
}
