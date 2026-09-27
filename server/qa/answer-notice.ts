/**
 * Tell a buyer their escalated question has been answered.
 *
 * When the chatbot can't answer, the buyer is told "Forwarded to your
 * broker" — and the answer is published later (broker publishes it, or the
 * seller approves the broker's draft), often days later, after the buyer has
 * closed the view room. Without this email they never learn it exists.
 *
 * The email names the deal the way the buyer may see it (codename or neutral
 * wording on the Blind CIM — buyerFacingDealName), quotes only the buyer's
 * own question (never the answer, which is read in the view room behind the
 * same access rules as everything else) and links to their own view link.
 * Sent once, on the transition into "published".
 */
import { storage } from "../storage";
import { escapeHtml, sendDirectEmail } from "../notifications/service";
import { buyerFacingDealName } from "../reminders/decision-reminders";
import { viewLinkProblem } from "../buyers/view-access";
import type { BuyerAccess, BuyerQuestion, Deal } from "@shared/schema";

/** Did this update publish a buyer's question (and so owe them a notice)? */
export function answerNoticeDue(
  before: Pick<BuyerQuestion, "status" | "buyerAccessId">,
  after: Pick<BuyerQuestion, "status" | "publishedAnswer" | "aiAnswer" | "brokerDraft"> | null | undefined,
): boolean {
  if (!after || !before.buyerAccessId) return false;
  if (before.status === "published" || after.status !== "published") return false;
  return !!(after.publishedAnswer || after.brokerDraft || after.aiAnswer);
}

export function buildAnswerNoticeEmail(
  deal: Pick<Deal, "businessName"> & { blindCodename?: string | null },
  access: Pick<BuyerAccess, "accessLevel" | "buyerName">,
  question: string,
  viewUrl: string,
): { subject: string; html: string } {
  const { name } = buyerFacingDealName(deal, access);
  const safeName = name ? escapeHtml(name) : null;
  const first = (access.buyerName || "").trim().split(/\s+/)[0];
  const q = question.trim();
  const quoted = escapeHtml(q.length > 240 ? `${q.slice(0, 237)}…` : q);
  return {
    subject: name ? `Your question about ${name} has been answered` : "Your question about the confidential opportunity has been answered",
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="background:#141414;border:1px solid #222;border-radius:12px;padding:32px;">
      <div style="margin-bottom:20px;">
        <span style="font-size:12px;font-weight:600;color:#2dd4bf;letter-spacing:0.6px;text-transform:uppercase;">Cimple</span>
        <span style="color:#666;font-size:12px;margin-left:8px;">· ${safeName ?? "Confidential opportunity"}</span>
      </div>
      <h2 style="color:#f5f5f4;font-size:20px;font-weight:600;margin:0 0 14px;line-height:1.35;">Your question has been answered</h2>
      <p style="color:#a8a29e;font-size:14px;line-height:1.65;margin:0 0 12px;">${first ? `Hi ${escapeHtml(first)},` : "Hello,"}<br/><br/>The broker has answered the question you asked about ${safeName ? `<strong>${safeName}</strong>` : "the confidential opportunity"}:</p>
      <p style="color:#d6d3d1;font-size:14px;line-height:1.6;margin:0 0 24px;padding-left:12px;border-left:2px solid #333;">&ldquo;${quoted}&rdquo;</p>
      <a href="${viewUrl}" style="display:inline-block;background:#2dd4bf;color:#0a0a0a;font-size:14px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:8px;">
        Read the answer
      </a>
    </div>
    <p style="color:#444;font-size:11px;text-align:center;margin-top:16px;">
      The answer is in the Q&amp;A of your confidential view room.
    </p>
  </div>
</body>
</html>`,
  };
}

/**
 * Email the buyer who asked `question` that it is answered. Never throws —
 * a failed notice must not fail the broker's or seller's publish.
 */
export async function notifyBuyerQuestionAnswered(question: Pick<BuyerQuestion, "id" | "dealId" | "buyerAccessId" | "question">, baseUrl: string): Promise<boolean> {
  try {
    if (!question.buyerAccessId) return false;
    const access = await storage.getBuyerAccess(question.buyerAccessId);
    // Not for a link that no longer opens (revoked / expired): the email
    // would lead to "access denied".
    if (!access || access.dealId !== question.dealId || viewLinkProblem(access)) return false;
    const deal = await storage.getDeal(question.dealId);
    if (!deal) return false;
    const email = buildAnswerNoticeEmail(deal, access, question.question, `${baseUrl}/view/${access.accessToken}`);
    return await sendDirectEmail(access.buyerEmail, email.subject, email.html);
  } catch (err) {
    console.warn("[qa] answer notice failed:", err);
    return false;
  }
}
