/**
 * figure-states — what a due-diligence check looks like to a buyer (spec D5).
 * Colour says whether a difference is EXPLAINED, never how big it is; the
 * size is given in words. Every figure that differs between the records is
 * tinted (founder's decision 3: "differences highlighted in colour"): pale
 * blue-grey when the arithmetic explains it, blue-grey with a reason on file,
 * amber with none. Every state has an icon and words as well as a
 * colour, so meaning never rests on colour alone.
 *
 * The CIM paper is theme-locked (.cim-doc), so the paint is literal hex.
 */
import type { DiffSize } from "./figure-compare";

export type CheckState = "match" | "regrouped" | "explained" | "ask";

/**
 * D5: within rounding → match; a worked-out regrouping (D6) → regrouped;
 * differs with an approved reason → explained; else ask. Size never changes
 * the state.
 */
export function checkState(input: { size: DiffSize; regrouped: boolean; approvedReason: boolean }): CheckState {
  if (input.size === "match" || input.size === "rounding") return "match";
  if (input.regrouped) return "regrouped";
  if (input.approvedReason) return "explained";
  return "ask";
}

/**
 * D9: which checks start ticked in "Review and show to buyers". An `ask`
 * difference starts unticked ("Ask the seller first"); a CIM-vs-statements
 * mismatch (D9a) or a figure Cimple couldn't find in its document (D11) is
 * never offered at all.
 */
export function preTicked(state: CheckState, opts: { cimMismatch?: boolean; located?: boolean } = {}): boolean {
  if (opts.cimMismatch || opts.located === false) return false;
  return state === "match" || state === "regrouped" || state === "explained";
}

export interface StatePaint {
  /** Cell background ("" = none). */
  tint: string;
  /** Left rule colour and width ("" / 0 = none). */
  rule: string;
  ruleWidth: number;
  /** Ink for the icon. */
  ink: string;
  icon: "check" | "check_info" | "info" | "question";
  /** The words the colour key and screen readers use. */
  words: string;
}

export const STATE_PAINT: Record<CheckState, StatePaint> = {
  match: { tint: "", rule: "", ruleWidth: 0, ink: "#2F6B4F", icon: "check", words: "Matches" },
  // The founder's decision 3: a figure that differs between the records is highlighted in colour — even
  // when the arithmetic explains it. A pale blue-grey (calmer than "reason given"), the green tick still
  // saying the amounts agree once grouped the same way.
  regrouped: { tint: "#EDF0F3", rule: "#8796A5", ruleWidth: 1, ink: "#2F6B4F", icon: "check_info", words: "Same amounts, grouped differently" },
  explained: { tint: "#E4E8EC", rule: "#56687A", ruleWidth: 1, ink: "#56687A", icon: "info", words: "Differs, reason given" },
  ask: { tint: "#F3E3C3", rule: "#B7791F", ruleWidth: 2, ink: "#8A5A12", icon: "question", words: "Differs, ask the broker" },
};

/** Short state words (popover headline, check page, workspace pills). */
export const STATE_WORDS: Record<CheckState, string> = {
  match: "Matches",
  regrouped: "Same amounts, grouped differently",
  explained: "Differs, reason given",
  ask: "Differs: ask the broker about this difference",
};

/** The dotted underline of a figure with a note. */
export const NOTE_UNDERLINE = "#8A8170";

/** Broker-preview marks (never shown to buyers). */
export const PREVIEW_PAINT = {
  notShown: "#8A8170",
  cimMismatch: "#B7791F",
  notLocated: "#9B4A3A",
} as const;
