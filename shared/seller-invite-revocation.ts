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

type PrimaryLike = InviteLike & { acceptedAt?: Date | string | null };

/**
 * The invite that represents the seller — the one the Overview's status card
 * and "Copy invite link" use, so the one a broker may have pasted to the
 * seller by hand. Furthest along wins (opened > emailed > created), newest
 * on ties. Revoked invites never count.
 */
export function primarySellerInvite<T extends PrimaryLike>(invites: T[]): T | undefined {
  const live = invites.filter((i) => !inviteIsRevoked(i));
  if (live.length === 0) return undefined;
  const newestFirst = [...live].sort((a, b) => (time(b.createdAt) ?? 0) - (time(a.createdAt) ?? 0));
  return newestFirst.find((i) => !!i.acceptedAt) ?? newestFirst.find((i) => !!i.sentAt) ?? newestFirst[0];
}

/**
 * What removing a seller-team member does to seller links — shown in the
 * confirm dialog before the broker clicks Remove, and returned afterwards:
 *   own_link       their own link was minted with the seat; it can be turned
 *                  off. `isDealSellerLink` = it is also the link the Overview
 *                  shows as the seller's (it may have been copied to the
 *                  seller), so the broker must decide knowingly.
 *   seller_invite  their address is on the seller's own invite, which keeps
 *                  working (this was the seller).
 *   none           they have no seller link.
 */
export type SellerLinkOnRemoval =
  | { kind: "own_link"; inviteId: string; isDealSellerLink: boolean }
  | { kind: "seller_invite" }
  | { kind: "none" };

export function sellerLinkOnRemoval<T extends PrimaryLike>(member: MemberLike, invites: T[]): SellerLinkOnRemoval {
  if (member.teamType !== "seller") return { kind: "none" };
  const minted = inviteMintedForMember(member, invites);
  if (minted) {
    return { kind: "own_link", inviteId: minted.id, isDealSellerLink: primarySellerInvite(invites)?.id === minted.id };
  }
  const email = member.email?.trim().toLowerCase();
  const onSellerInvite = !!email && invites.some(
    (i) => !inviteIsRevoked(i) && (i.sellerEmail || "").trim().toLowerCase() === email,
  );
  return onSellerInvite ? { kind: "seller_invite" } : { kind: "none" };
}
