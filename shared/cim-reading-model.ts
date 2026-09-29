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
import type { KindGroup, ReadLabel } from "./analytics-v2";

export const READ_LABEL_THRESHOLDS = {
  /** Under this share of the expected time (and scrolled past) → Skipped. */
  skipped: 0.1,
  /** Under this → Glanced. */
  glanced: 0.5,
  /** Up to this → Read; above → Studied. */
  read: 1.5,
  /**
   * "Studied" also needs this much time in absolute terms: 1.5× a page that
   * needs 6 s is 9 s — that is reading it, not studying it.
   */
  studiedMinMs: 15_000,
  /** Under this much time a page is never more than Glanced (a flick past a tiny page). */
  readMinMs: 2_000,
} as const;

/**
 * How one buyer read a page (or a block): attention vs the page's expected
 * reading time. `reached` = the page was on screen at all (a page never
 * reached has no label: null).
 */
export function readLabel(attentionMs: number, expectedMs: number, reached = true): ReadLabel | null {
  if (!reached) return null;
  const attention = Math.max(0, attentionMs);
  const expected = Math.max(1, expectedMs);
  const ratio = attention / expected;
  if (ratio < READ_LABEL_THRESHOLDS.skipped) return "skipped";
  if (ratio < READ_LABEL_THRESHOLDS.glanced || attention < READ_LABEL_THRESHOLDS.readMinMs) return "glanced";
  if (ratio <= READ_LABEL_THRESHOLDS.read || attention < READ_LABEL_THRESHOLDS.studiedMinMs) return "read";
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

/** "twice", "3 times", "1.5 times" — a ratio in words (≥ 1). */
export function timesWord(ratio: number): string {
  if (ratio >= 1.9 && ratio < 2.1) return "twice";
  const r = ratio >= 3 ? Math.round(ratio) : Math.round(ratio * 10) / 10;
  return `${r} times`;
}

/**
 * "What holds attention" in one sentence: which kind of content buyers read
 * most closely, compared per unit of content (attention ÷ expected), so a
 * CIM that is mostly text doesn't make text look "most read". Null when
 * fewer than two kinds have enough reading to compare.
 */
export function kindMixHeadline(
  kinds: ReadonlyArray<{ group: KindGroup | string; label: string; attentionMs: number; expectedMs: number }>,
): string | null {
  const usable = kinds
    .filter((k) => k.group !== "other" && k.expectedMs >= 5_000 && k.attentionMs >= 5_000)
    .map((k) => ({ ...k, ratio: studyRatio(k.attentionMs, k.expectedMs) }))
    .sort((a, b) => b.ratio - a.ratio);
  if (usable.length < 2) return null;
  const top = usable[0];
  const low = usable[usable.length - 1];
  const rel = top.ratio / Math.max(0.01, low.ratio);
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  if (rel < 1.3) return `Buyers give every kind of content about the same attention in this CIM.`;
  return `Buyers read ${lower(top.label)} most closely — ${timesWord(rel)} as long as ${lower(low.label)}, for the same amount of content.`;
}
