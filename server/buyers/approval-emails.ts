/**
 * The email a buyer receives once the seller approves them (buyer approval
 * workflow). Pure — the route and the unit tests share it.
 *
 * Approved buyers get the Blind CIM (BLIND_ACCESS_LEVEL): until they are
 * moved to the Full CIM / due diligence they must never learn the business's name
 * — not in the subject, not in the body. The deal is named the way
 * buyerFacingDealName names it (project codename, or neutral wording).
 *
 * Every variant carries the buyer's own view link, so the email works even
 * when the buyer never creates or signs in to an account.
 */
import { escapeHtml } from "../notifications/service";

export type ApprovalEmailVariant =
  /** A set-password invitation was sent separately (new or passwordless account). */
  | "set_password"
  /** A verified account with a password: the deal is on their dashboard. */
  | "existing_account"
  /** An account exists under the address but never proved it: the link only. */
  | "link_only";

export function buildApprovalInviteEmail(opts: {
  variant: ApprovalEmailVariant;
  buyerName: string | null;
  /** buyerFacingDealName(deal, access): codename/neutral for blind, else the name. */
  dealLabel: { blind: boolean; name: string | null };
  viewUrl: string;
  dashboardUrl: string;
}): { subject: string; html: string } {
  const { variant, dealLabel, viewUrl, dashboardUrl } = opts;
  const name = dealLabel.name ? escapeHtml(dealLabel.name) : null;
  const hello = opts.buyerName?.trim() ? `Hello ${escapeHtml(opts.buyerName.trim())},` : "Hello,";
  const what = !name
    ? "a confidential business profile"
    : dealLabel.blind
      ? `the confidential business profile <strong>${name}</strong>`
      : `the confidential information memorandum for <strong>${name}</strong>`;
  const plainName = dealLabel.name ?? null;
  const wrap = (title: string, inner: string) => `
        <div style="font-family: Inter, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #e5e5e5;">
          <h2 style="color: #14b8a6; margin-bottom: 16px;">${title}</h2>
          <p>${hello}</p>
          ${inner}
        </div>`;
  const viewButton = `<p style="margin: 32px 0;">
            <a href="${viewUrl}" style="background: #14b8a6; color: #0a0a0a; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Open the opportunity</a>
          </p>
          <p style="color: #888; font-size: 12px;">You'll be asked to sign an NDA before the full document opens. Link: <a href="${viewUrl}" style="color: #14b8a6;">${viewUrl}</a></p>`;

  if (variant === "set_password") {
    return {
      subject: plainName ? `You've been invited to ${plainName} on Cimple` : "You've been invited to a confidential opportunity on Cimple",
      html: wrap(
        "You've been invited to view a confidential business overview",
        `<p>You've been approved to view ${what}.</p>
          <p>You should have received a separate email asking you to set your password for your Cimple account. Once you're signed in, this opportunity will appear on your dashboard along with any other deals matched to your profile.</p>
          ${viewButton}`,
      ),
    };
  }
  if (variant === "existing_account") {
    return {
      subject: plainName ? `New CIM added to your Cimple dashboard: ${plainName}` : "A new confidential opportunity was added to your Cimple dashboard",
      html: wrap(
        "A new opportunity has been added to your Cimple dashboard",
        `<p>You've been granted access to ${what}. It's on your <a href="${dashboardUrl}" style="color: #14b8a6;">Cimple dashboard</a>, or open it directly:</p>
          ${viewButton}`,
      ),
    };
  }
  return {
    subject: plainName ? `You've been approved to view ${plainName}` : "You've been approved to view a confidential opportunity",
    html: wrap(
      "You've been approved to view a confidential business overview",
      `<p>You've been approved to view ${what}. Open it with your personal link below.</p>
          ${viewButton}
          <p style="color: #888; font-size: 12px;">To see it on your Cimple dashboard as well, confirm your email from the dashboard first.</p>`,
    ),
  };
}
