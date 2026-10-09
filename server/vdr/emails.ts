/**
 * Emails the data room sends (vdr spec §9.1 emails.ts, V15). EVERY one is
 * the broker's click — never automatic:
 *   - emailSellerAboutRequests: "Your broker added N documents to your
 *     checklist" (Ask the seller → Email the seller now), through the seller
 *     portal path (each seller gets their own link; demo deals record, never send).
 *   - sendBrokerEmailToBuyers: "Tell the buyer" after sharing what they asked
 *     for, and "Let them know?" after a share. The broker edits the message;
 *     each buyer's own data-room link is added at the end. Reply-To is the
 *     broker. Demo deals record and never send.
 *
 * Founder question Q21 (INTEGRATION §8): the seller email has its own
 * routing key, `seller_document_request` (owner, representative,
 * accountant). ONE switch below turns it off; without it (or without the
 * key in NOTIFICATION_ROUTING) the email goes as `seller_followup_questions`
 * (owner, representative) — no existing event's recipients ever change.
 */
import { NOTIFICATION_ROUTING } from "@shared/schema";

/** Q21 switch: use the data room's own seller routing key when it exists. */
export const VDR_SELLER_DOCUMENT_REQUEST_KEY = true;

/** The notification event the seller's checklist email goes out as. */
export function sellerDocumentRequestEvent(routing: Record<string, unknown> = NOTIFICATION_ROUTING, enabled: boolean = VDR_SELLER_DOCUMENT_REQUEST_KEY): string {
  return enabled && routing.seller_document_request ? "seller_document_request" : "seller_followup_questions";
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayLabel(d: Date | string | null | undefined): string {
  if (!d) return "";
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? "" : `${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}`;
}

/** The seller email's title and body (HTML-escaped), for N checklist rows. Pure. */
export function sellerRequestEmail(rows: ReadonlyArray<{ documentName: string; notes?: string | null; neededBy?: Date | string | null }>): { title: string; body: string } {
  const n = rows.length;
  const title = n === 1 ? "Your broker added a document to your checklist" : `Your broker added ${n} documents to your checklist`;
  const items = rows
    .slice(0, 50)
    .map((r) => {
      const by = r.neededBy ? ` <span style="color:#9E752E">(needed by ${escapeHtml(dayLabel(r.neededBy))})</span>` : "";
      const note = r.notes && r.notes.trim() ? `<br/><span style="color:#666">${escapeHtml(r.notes.trim().slice(0, 300))}</span>` : "";
      return `<li style="margin:0 0 8px 0">${escapeHtml(r.documentName.slice(0, 200))}${by}${note}</li>`;
    })
    .join("");
  const more = n > 50 ? `<p>…and ${n - 50} more on your checklist.</p>` : "";
  const body = `Please upload ${n === 1 ? "this document" : "these documents"} from your checklist, or tell your broker if you don't have ${n === 1 ? "it" : "one"}:<ul style="padding-left:18px;margin:12px 0">${items}</ul>${more}`;
  return { title, body };
}

export type SellerEmailDeps = {
  notifySellerPortal: (dealId: string, eventType: string, opts: { title: string; body: string; path: string; businessName?: string; metadata?: Record<string, unknown> }) => Promise<{ recipients: number; emailsSent: number }>;
};

/** Emails the seller about checklist rows the broker added from buyers' requests (one email per call). */
export async function emailSellerAboutRequests(
  deps: SellerEmailDeps,
  deal: { id: string; businessName?: string | null; demoKey?: string | null },
  rows: ReadonlyArray<{ id: string; documentName: string; notes?: string | null; neededBy?: Date | string | null }>,
): Promise<{ recipients: number; emailsSent: number; demo: boolean; event: string }> {
  const event = sellerDocumentRequestEvent();
  if (rows.length === 0) return { recipients: 0, emailsSent: 0, demo: !!deal.demoKey, event };
  const { title, body } = sellerRequestEmail(rows);
  // notifySellerPortal records every recipient and never emails a demo deal's (fictional) seller.
  const r = await deps.notifySellerPortal(deal.id, event, {
    title,
    body,
    path: "documents",
    businessName: deal.businessName ?? undefined,
    metadata: { kind: "vdr_document_request", requirementIds: rows.map((x) => x.id) },
  });
  return { recipients: r.recipients, emailsSent: r.emailsSent, demo: !!deal.demoKey, event };
}

/** A plain-text broker message → simple, escaped HTML. */
export function messageHtml(message: string, link: string | null, linkLabel: string, footer: string): string {
  const paras = message.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="margin:0 0 16px 0;color:#333;font-size:14px;line-height:1.6;">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");
  const button = link
    ? `<p style="margin:20px 0 0 0;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#201D18;color:#FBF9F4;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;">${escapeHtml(linkLabel)}</a></p>`
    : "";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;padding:32px 28px;border-radius:8px;border:1px solid #e5e5e5;">
    ${paras}${button}
  </div>
  <p style="text-align:center;color:#999;font-size:11px;margin-top:16px;">${escapeHtml(footer)}</p>
</body>
</html>`;
}

export type BuyerEmailDeps = {
  sendDirect: (to: string, subject: string, html: string, cc?: string[], opts?: { replyTo?: string | null; fromName?: string | null }) => Promise<boolean>;
  recordBuyerEmail?: (row: { brokerId: string; buyerUserId: string; dealId: string | null; toEmail: string; replyTo: string | null; subject: string; body: string; status: string; errorMessage: string | null; sentAt: Date | null }) => Promise<unknown>;
  broker: (brokerId: string) => Promise<{ name: string | null; email: string | null; company: string | null }>;
  appUrl: () => string;
};

export type BuyerRecipient = { accessToken: string; buyerEmail: string; buyerUserId?: string | null; itemId?: string | null };

/**
 * Sends the broker's message to each buyer, with that buyer's own data-room
 * link added at the end. Demo deals record and never send.
 */
export async function sendBrokerEmailToBuyers(
  deps: BuyerEmailDeps,
  i: { deal: { id: string; demoKey?: string | null }; brokerId: string; to: ReadonlyArray<BuyerRecipient>; subject: string; message: string },
): Promise<{ sent: number; failed: number; demo: boolean }> {
  if (i.deal.demoKey) {
    console.log(`[vdr] demo deal ${i.deal.id}: ${i.to.length} buyer email(s) recorded, not sent`);
    return { sent: 0, failed: 0, demo: true };
  }
  const who = await deps.broker(i.brokerId).catch(() => ({ name: null, email: null, company: null }));
  const replyTo = who.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(who.email) ? who.email : null;
  const sender = (who.name && who.name.trim()) || (who.company && who.company.trim()) || null;
  const fromName = sender ? `${sender} via Cimple` : null;
  const footer = `Sent via Cimple on behalf of ${who.company || who.name || "your broker"}`;
  let sent = 0;
  let failed = 0;
  for (const r of i.to) {
    const base = `${deps.appUrl().replace(/\/+$/, "")}/view/${encodeURIComponent(r.accessToken)}/data-room`;
    const link = r.itemId ? `${base}?doc=${encodeURIComponent(r.itemId)}` : base;
    const ok = await deps.sendDirect(r.buyerEmail, i.subject, messageHtml(i.message, link, "Open the data room", footer), undefined, { replyTo, fromName }).catch(() => false);
    if (ok) sent++;
    else failed++;
    if (deps.recordBuyerEmail && r.buyerUserId) {
      await deps.recordBuyerEmail({
        brokerId: i.brokerId, buyerUserId: r.buyerUserId, dealId: i.deal.id, toEmail: r.buyerEmail, replyTo, subject: i.subject, body: i.message,
        status: ok ? "sent" : "failed",
        errorMessage: ok ? null : process.env.RESEND_API_KEY ? "The email provider didn't accept it" : "Email isn't set up on this server — nothing was sent",
        sentAt: ok ? new Date() : null,
      }).catch(() => undefined);
    }
  }
  return { sent, failed, demo: false };
}

/** The prefilled "Tell the buyer" message (§9.2 tell-buyer). */
export function tellBuyerDraft(title: string, sender: string | null): { subject: string; message: string } {
  return {
    subject: "The document you asked for is in the data room",
    message: `The document you asked for, '${title}', is now in the data room.${sender ? `\n\n${sender}` : ""}`,
  };
}

/** The prefilled "Let them know?" message after a share (§5.5). */
export function letBuyersKnowDraft(dealName: string, titles: ReadonlyArray<string>, sender: string | null): { subject: string; message: string } {
  const list = titles.slice(0, 8).join(", ") + (titles.length > 8 ? `, and ${titles.length - 8} more` : "");
  return {
    subject: `New documents in the data room for ${dealName}`,
    message: `New documents are in the data room for ${dealName}: ${list}.${sender ? `\n\n${sender}` : ""}`,
  };
}

/**
 * A team member's link (§6.8) — only ever on the broker's click ("Send the
 * link"). Their own link at the end; Reply-To is the broker; never the
 * business's name. Demo deals record and never send.
 */
export async function sendTeamLinkEmail(
  deps: BuyerEmailDeps,
  i: { deal: { id: string; demoKey?: string | null }; brokerId: string; to: string; token: string; principalCompany: string },
): Promise<{ sent: boolean; demo: boolean }> {
  if (i.deal.demoKey) {
    console.log(`[vdr] demo deal ${i.deal.id}: a team link email recorded, not sent`);
    return { sent: false, demo: true };
  }
  const { teamLinkEmail, teamLinkUrl } = await import("./team");
  const who = await deps.broker(i.brokerId).catch(() => ({ name: null, email: null, company: null }));
  const replyTo = who.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(who.email) ? who.email : null;
  const sender = (who.name && who.name.trim()) || (who.company && who.company.trim()) || null;
  const words = teamLinkEmail(i.principalCompany);
  const footer = `Sent via Cimple on behalf of ${who.company || who.name || "the broker"}`;
  const ok = await deps
    .sendDirect(i.to, words.subject, messageHtml(words.message, teamLinkUrl(deps.appUrl(), i.token), "Open the data room", footer), undefined, { replyTo, fromName: sender ? `${sender} via Cimple` : null })
    .catch(() => false);
  return { sent: !!ok, demo: false };
}
