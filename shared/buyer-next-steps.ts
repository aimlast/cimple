/**
 * The words for a buyer's chosen next step (buyer_access.decision_next_step,
 * BUYER_NEXT_STEPS values) when the broker reads about it: "chose
 * Interested · wants a call with the seller", "Next: wants to make an offer
 * (LOI)".
 *
 * The ONE map (INTEGRATION §9.2, deduped at the analytics merge): the
 * Analytics dashboards, the deal's Buyers tab (HaveCimStage) and the buyer
 * profile timeline (server/buyers/profile-view.ts) all read it. "LOI" here
 * is the buyer's own step (an offer), never an access level.
 */
export const NEXT_STEP_WORDS: Readonly<Record<string, string>> = {
  seller_call: "wants a call with the seller",
  management_meeting: "wants a management meeting",
  site_visit: "wants a site visit",
  loi: "wants to make an offer (LOI)",
  more_info: "wants more information",
  other: "another next step",
};

/** The words for a next-step value, or null when there is none. Unknown values are shown as given. */
export function nextStepWords(v: string | null | undefined): string | null {
  if (!v) return null;
  return NEXT_STEP_WORDS[v] ?? v.replace(/_/g, " ");
}
