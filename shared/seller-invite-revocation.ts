/**
 * Seller links that stop working.
 *
 * Adding someone to the deal's SELLER team mints them their own seller
 * invite (the full seller workspace: questionnaire, documents, interview).
 * Removing them only deleted the team row, so a removed bookkeeper could
 * still open every uploaded financial. Now the invite minted for that member
 * is revoked (status "revoked"): storage never resolves its token again, and
 * it drops out of the deal's invite list, so re-adding or re-inviting the
 * address mints a fresh link.
 *
 * Which invite is theirs: the member add runs findOrCreateSellerInvite right
 * after creating the member row (stamped invitedAt), so an invite for the
 * member's address created at (or just after) invitedAt was minted for them.
 * An older invite for the same address is the seller's own (the broker invited them
 * first, then added them to the team — e.g. the Q&A routing "add as Owner"
 * step) and is never revoked. Neither is one the broker has since sent as the
 * deal's seller invite (sentAt).
 */

export const REVOKED_INVITE_STATUS = "revoked" as const;

export function inviteIsRevoked(invite: { status?: string | null } | null | undefined): boolean {
  return invite?.status === REVOKED_INVITE_STATUS;
}

/** Created within this window after the member row = minted by the member add. */
const MINTED_WINDOW_MS = 2 * 60 * 1000;
/** Clock slack: invitedAt is the app's clock, the invite's createdAt the database's. */
const SLACK_MS = 5 * 1000;

type MemberLike = { teamType: string; email?: string | null; invitedAt?: Date | string | null };
type InviteLike = { id: string; sellerEmail?: string | null; createdAt?: Date | string | null; sentAt?: Date | string | null; status?: string | null };

const time = (d: Date | string | null | undefined): number | null => {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
};

/** The seller invite a removed seller-team member was given, or null (none / it's the seller's own). */
export function inviteMintedForMember<T extends InviteLike>(member: MemberLike, invites: T[]): T | null {
  if (member.teamType !== "seller") return null;
  const email = member.email?.trim().toLowerCase();
  const memberAt = time(member.invitedAt);
  if (!email || memberAt === null) return null;
  const candidates = invites.filter((inv) => {
    if (inviteIsRevoked(inv)) return false;
    if ((inv.sellerEmail || "").trim().toLowerCase() !== email) return false;
    const created = time(inv.createdAt);
    return created !== null && created >= memberAt - SLACK_MS && created <= memberAt + MINTED_WINDOW_MS;
  });
  const minted = candidates[0] ?? null;
  // Sent as the deal's seller invite since → it is the seller's link now.
  if (!minted || minted.sentAt) return null;
  return minted;
}
