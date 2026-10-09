/**
 * A buyer's question asked from a figure's note (dd spec D18, §9.3): the
 * figure's opaque id is resolved against THIS buyer's own figure layer (so a
 * Blind buyer can't probe the named figures — ids differ by nothing but the
 * layer they were served in, and a figure the buyer wasn't served resolves to
 * nothing). Resolved → the question goes straight to the broker (no AI),
 * prefixed with the figure ("About Interest, FY2022: " / Blind: "About a
 * figure on page 7: "). Unresolved → the normal question flow.
 */
import type { FigureLayer } from "@shared/figure-layer";
import { DD_SOURCE_CHECK_PAGE_ID } from "@shared/figure-layer";

export const FIGURE_ID_RE = /^f_[0-9a-f]{10}$/;

/** The figure id from a request body, or null (anything else is a normal question). */
export function figureIdOf(body: unknown): string | null {
  const v = (body as { figureId?: unknown } | null)?.figureId;
  return typeof v === "string" && FIGURE_ID_RE.test(v) ? v : null;
}

/**
 * The text saved for the broker, or null when the id isn't a figure this
 * buyer was served. `sections` are the buyer's served sections in reading
 * order (page numbers count from 1).
 */
export function figureQuestionText(
  layer: FigureLayer | null | undefined,
  sections: ReadonlyArray<{ id: string }>,
  figureId: string | null,
  question: string,
  maxChars: number,
): string | null {
  if (!layer || !figureId) return null;
  const fig = layer.figures[figureId];
  if (!fig) return null;
  const anchor = layer.anchors.find((a) => a.fig === figureId && a.pageId !== DD_SOURCE_CHECK_PAGE_ID) ?? layer.anchors.find((a) => a.fig === figureId);
  const pageNo = anchor ? sections.findIndex((s) => s.id === anchor.pageId) + 1 : 0;
  const prefix = layer.mode === "blind" || !fig.label
    ? `About a figure on page ${pageNo > 0 ? pageNo : "?"}: `
    : `About ${fig.label}, FY${fig.year}: `;
  // The ask box is prefilled with the prefix; never write it twice.
  const body = question.trim().replace(/^About [^:\n]{1,160}:\s*/, "");
  return `${prefix}${body}`.slice(0, maxChars);
}
