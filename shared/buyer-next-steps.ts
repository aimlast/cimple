/**
 * The words for a buyer's chosen next step (buyer_access.decision_next_step,
 * BUYER_NEXT_STEPS values) when the broker reads about it: "chose
 * Interested — wants a call with the seller".
 *
 * Same words as server/buyers/profile-view.ts's private NEXT_STEP_TEXT
 * (that file is left alone in this batch; deduping is an integrator
 * follow-up — tests/unit/analytics-activity.test.ts pins the two together).
 */
export const NEXT_STEP_WORDS: Readonly<Record<string, string>> = {
  seller_call: "wants a call with the seller",
  management_meeting: "wants a management meeting",
  site_visit: "wants a site visit",
  loi: "ready to submit an LOI",
  more_info: "wants more information",
  other: "other next step",
};

/** The words for a next-step value, or null when there is none. Unknown values are shown as given. */
export function nextStepWords(v: string | null | undefined): string | null {
  if (!v) return null;
  return NEXT_STEP_WORDS[v] ?? v.replace(/_/g, " ");
}
