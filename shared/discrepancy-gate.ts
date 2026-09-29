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
 *
 * Rows routed BEFORE that rule shipped (release 2026-09-29) were never put to
 * the seller — no follow-up email existed — so they don't lock the CIM on
 * their own (release review DEP-4: TrueNorth and SariKnotSari would have
 * locked the moment the release went live, with nobody told why and no
 * seller asked). Every routing from the release on is stamped
 * (sideSources.routedAt, withRoutedStamp); an unstamped routed row is
 * shown to the broker as "never asked" with "Email the seller" (their
 * click — never automatic) and "Resolve it yourself". Emailing stamps it, and
 * from then on it blocks until the seller answers.
 */

export const BLOCKING_DISCREPANCY_STATUSES: ReadonlySet<string> = new Set(["open", "seller_responded"]);

type GateRow = { severity: string; status: string; sideSources?: unknown };

/** When the row was routed to the seller under the follow-up rules (ISO), or null for a routing that pre-dates them. */
export function routedToSellerAt(d: { sideSources?: unknown }): string | null {
  const raw = d.sideSources;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const at = (raw as { routedAt?: unknown }).routedAt;
  return typeof at === "string" && at ? at : null;
}

/** The row's sideSources with the routing stamp set (everything else kept). */
export function withRoutedStamp(sideSources: unknown, at: Date = new Date()): Record<string, unknown> {
  const base = sideSources && typeof sideSources === "object" && !Array.isArray(sideSources) ? (sideSources as Record<string, unknown>) : {};
  return { ...base, routedAt: at.toISOString() };
}

/**
 * New sideSources for a row an engine refreshes (the financial analysis,
 * the verification check): the engine's own sides, with the row's routing
 * stamp kept — a re-run never turns a routed row back into a "never asked" one.
 */
export function keepRoutedStamp(previous: unknown, next: unknown): unknown {
  const at = routedToSellerAt({ sideSources: previous });
  if (!at) return next;
  const base = next && typeof next === "object" && !Array.isArray(next) ? (next as Record<string, unknown>) : {};
  return { ...base, routedAt: at };
}

/**
 * A routed row the seller was never asked: routed before the follow-up
 * rules, on an interview that has since finished. It doesn't block; the
 * broker is asked to email the seller or resolve it.
 */
export function routedButNeverAsked(d: { status: string; sideSources?: unknown }, interviewCompleted: boolean | null | undefined): boolean {
  return d.status === "ask_seller" && !!interviewCompleted && !routedToSellerAt(d);
}

export function discrepancyBlocksCim(d: GateRow, interviewCompleted: boolean | null | undefined): boolean {
  if (d.severity !== "critical") return false;
  if (BLOCKING_DISCREPANCY_STATUSES.has(d.status)) return true;
  return d.status === "ask_seller" && !!interviewCompleted && !!routedToSellerAt(d);
}

/** Routed rows the seller hasn't been asked yet because the interview had already ended. */
export function waitingOnSellerAfterInterview<T extends { status: string }>(rows: T[], interviewCompleted: boolean | null | undefined): T[] {
  return interviewCompleted ? rows.filter((d) => d.status === "ask_seller") : [];
}
