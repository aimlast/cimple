/**
 * The "you've been added to a deal" email, per team — saying only what the
 * person actually gets.
 *
 *   seller team → their own link to the seller workspace (real access).
 *   broker team → email updates about the deal. There is no colleague
 *                 sign-in behind a team seat yet, so no "get started" link
 *                 to a login page they have no account for.
 *   buyer team  → email updates about the opportunity; the CIM itself comes
 *                 as a buyer link from the broker. On a Blind deal (the
 *                 default "full" access) the business is named only by its
 *                 codename.
 */
import { cimModeForAccessLevel } from "@shared/cim-layouts";

export interface TeamInviteCopyInput {
  teamType: string;
  roleLabel: string;
  businessName: string | null;
  blindCodename: string | null;
  /** The member's access level (buyer team) — decides Blind vs named. */
  accessLevel: string | null;
  /** A seller-team member whose seller link was created. */
  hasSellerLink: boolean;
}

export function teamInviteCopy(input: TeamInviteCopyInput): { title: string; body: string; displayName: string } {
  const business = input.businessName?.trim() || "a business";
  if (input.teamType === "buyer") {
    const blind = cimModeForAccessLevel(input.accessLevel) === "blind";
    const name = blind ? input.blindCodename?.trim() || "a confidential business opportunity" : business;
    return {
      title: "You've been added to a buyer team",
      body:
        `You've been added as ${input.roleLabel} on the buyer team for ${name}. ` +
        `You'll receive email updates about this opportunity. Your broker will send you a secure link to the confidential memorandum separately.`,
      displayName: name,
    };
  }
  if (input.teamType === "seller") {
    return {
      title: "You've been added to a deal",
      body: input.hasSellerLink
        ? `You've been added as ${input.roleLabel} on the seller team for ${business}. Use the button below to open the seller workspace — questionnaire, documents and interview. The link is personal to you; please don't forward it.`
        : `You've been added as ${input.roleLabel} on the seller team for ${business}. You'll receive email updates about this deal.`,
      displayName: business,
    };
  }
  return {
    title: "You've been added to a deal team",
    body:
      `You've been added as ${input.roleLabel} on the broker team for ${business}. ` +
      `You'll receive email updates about this deal — for example buyer questions, decisions and approvals.`,
    displayName: business,
  };
}
