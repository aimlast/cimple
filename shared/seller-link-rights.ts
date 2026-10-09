/**
 * What a seller link (seller_invites token) may do on the deal.
 *
 * Every seller-team member the broker adds gets their own seller link
 * (routes.ts: a seller-team member → findOrCreateSellerInvite), so a token
 * alone says nothing about WHO holds it. The owner signs off the CIM
 * (TEAM_ROLES.seller.owner has `approve_cim`); an accountant or attorney
 * must not — the seller's sign-off is the gate before buyers see the CIM.
 * Buyer-question approvals go to the roles NOTIFICATION_ROUTING sends
 * `qa_needs_approval` to (owner, representative) — those links reveal the
 * buyer's question and the broker's draft, and can publish an answer.
 *
 * The link is matched to a seller-team member by email. The original seller
 * invite with no member row is the owner (the person the broker invited as
 * "the seller"). A revoked member gets nothing.
 */
import { TEAM_ROLES, NOTIFICATION_ROUTING } from "./schema";

export interface SellerLinkRights {
  /** The member's seller-team role, "owner" for the original seller invite. */
  role: string;
  /** The deal_members row the link belongs to, when there is one. */
  memberId: string | null;
  /** May approve / sign off the CIM (and ask for changes to it). */
  canApproveCim: boolean;
  /** May see and answer buyer questions waiting on the seller. */
  canApproveQa: boolean;
  /**
   * May upload the general ledger and show where the add-backs are in the
   * books (gl spec D24): the owner (the original invite, or an `owner`
   * member) or an `accountant` member — by role, never by `view_financials`
   * (the attorney has that). The ledger holds every employee's pay.
   */
  canTraceAddbacks: boolean;
}

type InviteLike = { sellerEmail?: string | null };
type MemberLike = {
  id: string;
  email?: string | null;
  teamType?: string | null;
  role?: string | null;
  permissions?: unknown;
  inviteStatus?: string | null;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

function permissionsOf(m: MemberLike): string[] {
  if (Array.isArray(m.permissions) && m.permissions.length > 0) {
    return m.permissions.filter((p): p is string => typeof p === "string");
  }
  const cfg = (TEAM_ROLES.seller as Record<string, { permissions: readonly string[] }>)[m.role ?? ""];
  return cfg ? [...cfg.permissions] : [];
}

const QA_ROLES = NOTIFICATION_ROUTING.qa_needs_approval?.roles ?? ["owner", "representative"];

export function sellerLinkRights(invite: InviteLike, members: MemberLike[]): SellerLinkRights {
  const email = norm(invite.sellerEmail);
  const member = email
    ? members.find((m) => m.teamType === "seller" && norm(m.email) === email)
    : undefined;
  if (!member) {
    // The seller the broker invited directly — the owner.
    return { role: "owner", memberId: null, canApproveCim: true, canApproveQa: true, canTraceAddbacks: true };
  }
  if (member.inviteStatus === "revoked") {
    return { role: member.role ?? "revoked", memberId: member.id, canApproveCim: false, canApproveQa: false, canTraceAddbacks: false };
  }
  const perms = permissionsOf(member);
  const role = member.role ?? "";
  return {
    role,
    memberId: member.id,
    canApproveCim: perms.includes("approve_cim"),
    canApproveQa: perms.includes("approve_qa") && QA_ROLES.includes(role),
    canTraceAddbacks: TRACE_ROLES.includes(role),
  };
}

/** The seller-team roles that may work on the general ledger (gl spec D24). */
const TRACE_ROLES = ["owner", "accountant"];

/** What a link without the ledger right sees on the books page. */
export const OWNER_OR_ACCOUNTANT_MESSAGE = "Your broker asked the business owner or the accountant to do this step.";

/** The message a link without sign-off rights gets. */
export const OWNER_SIGNS_OFF_MESSAGE =
  "The business owner signs off the CIM. You can read it here — send any comments to your broker.";
