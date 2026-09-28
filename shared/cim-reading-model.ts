/**
 * cim-reading-model — how reading time is judged against what a page needs.
 * Pure (server + client). The expected time of each block comes from the
 * registry (shared/cim-blocks.ts READING_MODEL); this file turns measured
 * time into words the broker reads ("Skipped / Glanced / Read / Studied").
 *
 * Owned by the intelligence stream (the thresholds are marked for tuning
 * with the capture proof and the first real buyers); the SIGNATURES are the
 * contract the aggregation and the viewer call.
 */
import type { ReadLabel } from "./analytics-v2";

export const READ_LABEL_THRESHOLDS = {
  /** Under this share of the expected time (and scrolled past) → Skipped. */
  skipped: 0.1,
  /** Under this → Glanced. */
  glanced: 0.5,
  /** Up to this → Read; above → Studied. */
  read: 1.5,
} as const;

/**
 * How one buyer read a page (or a block): attention vs the page's expected
 * reading time. `reached` = the page was on screen at all (a page never
 * reached has no label: null).
 */
export function readLabel(attentionMs: number, expectedMs: number, reached = true): ReadLabel | null {
  if (!reached) return null;
  const expected = Math.max(1, expectedMs);
  const ratio = Math.max(0, attentionMs) / expected;
  if (ratio < READ_LABEL_THRESHOLDS.skipped) return "skipped";
  if (ratio < READ_LABEL_THRESHOLDS.glanced) return "glanced";
  if (ratio <= READ_LABEL_THRESHOLDS.read) return "read";
  return "studied";
}

/** The label of a group of buyers: the median buyer's label (null when none reached it). */
export function groupReadLabel(perBuyer: ReadonlyArray<ReadLabel | null>): ReadLabel | null {
  const order: ReadLabel[] = ["skipped", "glanced", "read", "studied"];
  const ranks = perBuyer.filter((l): l is ReadLabel => !!l).map((l) => order.indexOf(l)).sort((a, b) => a - b);
  if (ranks.length === 0) return null;
  return order[ranks[Math.floor((ranks.length - 1) / 2)]];
}

/** attention ÷ expected (the "study ratio"), 0 when nothing was expected. */
export function studyRatio(attentionMs: number, expectedMs: number): number {
  return expectedMs > 0 ? Math.max(0, attentionMs) / expectedMs : 0;
}
