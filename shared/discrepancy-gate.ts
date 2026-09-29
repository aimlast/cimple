/**
 * discrepancy-gate — THE rule for which conflicts lock the CIM (generate,
 * approve, advance to Design, publish). Server gates and the Overview's
 * buttons use this one function.
 *
 * Critical rows block while "open" or "seller_responded" (the seller
 * answered; the broker hasn't resolved). A row routed to the seller
 * ("ask_seller") counts as handled while the interview is running — it
 * raises it, and its end hands the row back as seller_responded. Once the
 * interview is FINISHED nothing raises it on its own, so a routed critical
 * row blocks until the seller has actually answered (free round 2, J2:
 * routing after the interview used to unlock the CIM with the conflict
 * never asked).
 */

export const BLOCKING_DISCREPANCY_STATUSES: ReadonlySet<string> = new Set(["open", "seller_responded"]);

export function discrepancyBlocksCim(
  d: { severity: string; status: string },
  interviewCompleted: boolean | null | undefined,
): boolean {
  if (d.severity !== "critical") return false;
  if (BLOCKING_DISCREPANCY_STATUSES.has(d.status)) return true;
  return d.status === "ask_seller" && !!interviewCompleted;
}

/** Routed rows the seller hasn't been asked yet because the interview had already ended. */
export function waitingOnSellerAfterInterview<T extends { status: string }>(rows: T[], interviewCompleted: boolean | null | undefined): T[] {
  return interviewCompleted ? rows.filter((d) => d.status === "ask_seller") : [];
}
