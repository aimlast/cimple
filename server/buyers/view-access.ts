/**
 * Rules shared by every buyer view-link endpoint (view room, NDA, decision,
 * profile, analytics) and by the flows that link an access row to a buyer
 * account. Pure — the routes and the unit tests share them.
 */
import type { BuyerAccess, BuyerUser } from "@shared/schema";

export type ViewLinkProblem = "not_found" | "revoked" | "expired";

/**
 * Why a view link can't be used right now, or null when it can. An expired
 * or revoked link may not sign the NDA, record a decision (which moves the
 * broker's CRM and emails them), read the buyer's profile or add analytics —
 * the same rule the view room itself applies.
 */
export function viewLinkProblem(
  access: Pick<BuyerAccess, "revokedAt" | "expiresAt"> | null | undefined,
  now: number = Date.now(),
): ViewLinkProblem | null {
  if (!access) return "not_found";
  if (access.revokedAt) return "revoked";
  if (access.expiresAt && new Date(access.expiresAt).getTime() < now) return "expired";
  return null;
}

/** The HTTP answer for a link problem (same wording as the view room). */
export function viewLinkError(problem: ViewLinkProblem): { status: number; error: string } {
  if (problem === "not_found") return { status: 404, error: "Access denied or link expired" };
  if (problem === "revoked") return { status: 403, error: "Access has been revoked" };
  return { status: 403, error: "Link has expired" };
}

/**
 * May a deal link (and what the buyer tells us at the NDA) be attached to
 * this existing buyer account?
 *
 * Self-signup creates a signed-in account for ANY unclaimed email without
 * proving the inbox (emailVerified false, password set). Linking such an
 * account would hand whoever registered the address the buyer's deal access
 * (the dashboard lists linked links with their tokens) and their NDA answers.
 *
 * Safe to link:
 *  - a verified account (its owner proved the inbox via a set-password or
 *    reset link), or
 *  - an account with no password yet (broker-invited, CRM-imported, created
 *    at an NDA): nobody can sign in to it until the inbox owner sets a
 *    password from an emailed link — which also verifies it.
 */
export function isLinkableBuyerAccount(
  user: Pick<BuyerUser, "emailVerified" | "passwordHash"> | null | undefined,
): boolean {
  if (!user) return false;
  return !!user.emailVerified || !user.passwordHash;
}

/**
 * Does this dashboard account get to see deals linked to it? Only an
 * account whose owner proved the inbox. A self-signup account that never
 * verified its email sees none (links linked before this rule included).
 */
export function dashboardShowsLinkedDeals(user: Pick<BuyerUser, "emailVerified">): boolean {
  return !!user.emailVerified;
}

/**
 * Should this fetch of the view room count as the buyer viewing the CIM?
 * Only when CIM content was actually served: not the NDA / profile gate and
 * not the "preparing your confidential view" holding state. firstViewedAt
 * starts the day-3/6/8 reminder clock and the reminder emails tell the buyer
 * they "reviewed" the CIM, so a buyer who only saw the gate must never get it.
 */
export function viewStampFor(
  access: Pick<BuyerAccess, "firstViewedAt" | "lastAccessedAt" | "viewCount">,
  served: boolean,
  now: Date = new Date(),
): Partial<Pick<BuyerAccess, "firstViewedAt" | "lastAccessedAt" | "viewCount">> {
  // lastAccessedAt always moves: the broker sees the link was opened.
  const stamp: Partial<Pick<BuyerAccess, "firstViewedAt" | "lastAccessedAt" | "viewCount">> = { lastAccessedAt: now };
  if (!served) return stamp;
  // A "view" is a session, not a fetch: NDA refetches and the preparing poll
  // hit the endpoint repeatedly. The first time content is served always
  // counts, even straight after the gate (same session).
  const lastAt = access.lastAccessedAt ? new Date(access.lastAccessedAt).getTime() : 0;
  const newSession = now.getTime() - lastAt > 30 * 60 * 1000;
  const firstServe = !access.firstViewedAt;
  if (newSession || firstServe) stamp.viewCount = (access.viewCount ?? 0) + 1;
  if (firstServe) stamp.firstViewedAt = now;
  return stamp;
}
