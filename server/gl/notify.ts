/**
 * notify.ts — the emails of "Add-backs in the books" (gl spec §6.12).
 * Nothing here is ever sent on its own: every seller email follows the
 * broker's click (Send request, Remind, Ask the seller about this, Send it),
 * and the broker hears when the seller finishes or needs help. Demo deals
 * record, never email (notifySellerPortal / notify guards). Local runs have
 * RESEND_API_KEY blank.
 *
 * ── Founder question Q21 (INTEGRATION §8) ────────────────────────────────
 * Two NEW routing keys, additive (no existing event's recipients change):
 *   seller_gl_request  → seller team: owner, accountant
 *   gl_needs_broker    → broker team: lead, associate
 * They sit behind ONE switch, GL_NOTIFICATION_ROUTING, with an automatic
 * fallback: switched off — or the two lines removed from NOTIFICATION_ROUTING
 * in shared/schema.ts — these emails reuse the existing follow-up events
 * (seller_followup_questions → owner + representative, so the accountant
 * isn't emailed; seller_followups_answered → lead + associate).
 */
import { storage } from "../storage";
import { NOTIFICATION_ROUTING } from "@shared/schema";

/** Q21 — the founder's yes is pending; the integrator flips this to false (or deletes the two routing lines) if they decline. */
export const GL_NOTIFICATION_ROUTING = true;

const FALLBACK_SELLER_EVENT = "seller_followup_questions";
const FALLBACK_BROKER_EVENT = "seller_followups_answered";

/** The seller-facing event in use. */
export function glSellerEvent(): string {
  return GL_NOTIFICATION_ROUTING && NOTIFICATION_ROUTING.seller_gl_request ? "seller_gl_request" : FALLBACK_SELLER_EVENT;
}
/** The broker-facing event in use. */
export function glBrokerEvent(): string {
  return GL_NOTIFICATION_ROUTING && NOTIFICATION_ROUTING.gl_needs_broker ? "gl_needs_broker" : FALLBACK_BROKER_EVENT;
}

const firstName = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/)[0] || "";
/** User-typed text inside an email body (buildEmailHtml keeps only plain tags; callers escape what people typed). */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The seller emails' words (§6.12). Pure. */
export function requestEmailCopy(input: { brokerFirst: string; n: number; ledgerOnFile: boolean; message?: string | null }): { title: string; body: string } {
  const rawWho = input.brokerFirst || "Your broker";
  const who = esc(rawWho);
  const costs = `${input.n} cost${input.n === 1 ? "" : "s"}`;
  const note = input.message?.trim() ? `\n\n${who}: "${esc(input.message.trim().slice(0, 1000))}"` : "";
  if (input.ledgerOnFile) {
    return {
      title: "Check a few costs we found in your books",
      body: `Cimple found the likely entries for ${costs} in the ledger you uploaded. Check they're right — about 15–30 minutes.${note}`,
    };
  }
  return {
    title: `${rawWho} needs a few entries from your books`,
    body: `${who} listed ${costs} that buyers will ask to see in your bookkeeping. Upload your general ledger and check the entries Cimple suggests. It takes about 20–40 minutes.${note}`,
  };
}

export type BrokerNoticeKind = "finished" | "cant_get_ledger" | "needs_columns" | "accountant" | "other_costs";

/** The broker's notices' words (§6.12). Pure. */
export function brokerNoticeCopy(kind: BrokerNoticeKind, ctx: { seller: string; business: string; accountant?: string | null; reason?: string | null }): { title: string; body: string } {
  // Titles are plain text (escaped by buildEmailHtml); bodies get the escaped values.
  const S = ctx.seller || "The seller";
  const B = ctx.business;
  const s = esc(S);
  switch (kind) {
    case "finished":
      return { title: `${S} finished showing the add-backs in their books — ${B}`, body: `${s} confirmed the entries behind the add-backs you sent. Review them on Financials → Add-backs in the books.` };
    case "cant_get_ledger":
      return { title: `${S} can't get the general ledger — ${B}`, body: `${s} told Cimple they can't get the general ledger${ctx.reason ? `: "${esc(ctx.reason.slice(0, 300))}"` : "."} You may need another way to show the add-backs, like bank statements.` };
    case "needs_columns":
      return { title: `The ledger ${S} uploaded needs a quick check — ${B}`, body: "Cimple couldn't tell which column is which. Ask for the standard General Ledger report, or set the columns yourself on Financials → Add-backs in the books." };
    case "accountant":
      return { title: `${S} asked to bring in their accountant, ${ctx.accountant ?? "their accountant"} — ${B}`, body: `${s} would like their accountant to do this step. Nothing has been sent — click "Send it" on Financials → Add-backs in the books to give them their own link.` };
    case "other_costs":
      return { title: `${S} mentioned other costs the business pays — ${B}`, body: `${s} listed other personal or one-off costs. You decide what counts — see Financials → Add-backs in the books.` };
  }
}

/** The broker's notice (lead and associate; the deal's own broker when no team). Never throws. */
export async function notifyBroker(dealId: string, kind: BrokerNoticeKind, ctx: { seller?: string | null; accountant?: string | null; reason?: string | null } = {}): Promise<void> {
  try {
    const deal = await storage.getDeal(dealId);
    if (!deal) return;
    const { notify } = await import("../notifications/service");
    const copy = brokerNoticeCopy(kind, { seller: ctx.seller ?? "", business: deal.businessName, accountant: ctx.accountant, reason: ctx.reason });
    await notify(dealId, glBrokerEvent(), { ...copy, actionUrl: `/deal/${dealId}/financials?fin=books`, businessName: deal.businessName, metadata: { gl: kind } });
  } catch (err) {
    console.warn(`[gl] broker notice ${kind} for ${dealId} failed:`, err);
  }
}

/** The request to the seller (the broker clicked Send request). */
export async function sendGlRequest(dealId: string, input: { recipientIds: string[]; brokerName: string | null; n: number; ledgerOnFile: boolean; message?: string | null }) {
  const deal = await storage.getDeal(dealId);
  if (!deal) return { recipients: 0, emailsSent: 0, demo: false };
  const { notifySellerPortal } = await import("../notifications/service");
  const copy = requestEmailCopy({ brokerFirst: firstName(input.brokerName), n: input.n, ledgerOnFile: input.ledgerOnFile, message: input.message });
  const r = await notifySellerPortal(dealId, glSellerEvent(), { ...copy, path: "books", businessName: deal.businessName, metadata: { gl: "request" }, onlyRecipients: input.recipientIds });
  return { recipients: r.recipients, emailsSent: r.emailsSent, demo: !!deal.demoKey };
}

/** "Remind" (once a day, the broker's click). */
export async function remindGlRequest(dealId: string, recipientIds: string[]) {
  const deal = await storage.getDeal(dealId);
  if (!deal) return { recipients: 0, emailsSent: 0, demo: false };
  const { notifySellerPortal } = await import("../notifications/service");
  const r = await notifySellerPortal(dealId, glSellerEvent(), {
    title: "A reminder: a few entries from your books",
    body: "Your broker is waiting on a few entries from your books. Everything you've done so far is saved.",
    path: "books",
    businessName: deal.businessName,
    metadata: { gl: "remind" },
    onlyRecipients: recipientIds,
  });
  return { recipients: r.recipients, emailsSent: r.emailsSent, demo: !!deal.demoKey };
}

/**
 * "Ask the seller about this" — names the cost's seller label only. It goes
 * to the people the request went to; with none on record, to the owner only
 * (never everyone the event routes to — a representative can't open the
 * books page), else to nobody (the question still waits on the page).
 */
export async function sendTraceQuestion(dealId: string, sellerLabel: string, traceId: string, recipientIds: string[]) {
  const deal = await storage.getDeal(dealId);
  if (!deal) return;
  let to = recipientIds;
  if (to.length === 0) {
    const { glRecipients } = await import("./broker-view");
    to = (await glRecipients(dealId)).filter((r) => r.role === "owner").map((r) => r.id);
    if (to.length === 0) {
      console.log(`[gl] question on deal ${dealId}: no owner to email — it waits on the seller's books page`);
      return;
    }
  }
  const { notifySellerPortal } = await import("../notifications/service");
  await notifySellerPortal(dealId, glSellerEvent(), {
    title: "Your broker has a question about your books",
    body: `About: ${esc(sellerLabel)}. Open your books to read it and answer.`,
    path: `books?cost=${encodeURIComponent(traceId)}`,
    businessName: deal.businessName,
    metadata: { gl: "question" },
    onlyRecipients: to,
  });
}

/** "Email me this link" — this seller link's own address only (3 a day; demo deals record it, never send). */
export async function emailSellerTheirLink(invite: { id: string; token: string; sellerEmail: string | null; dealId: string }): Promise<{ sent: boolean; demo: boolean }> {
  const deal = await storage.getDeal(invite.dealId);
  const email = invite.sellerEmail?.trim();
  if (!deal || !email) return { sent: false, demo: false };
  if (deal.demoKey) {
    console.log("[notify:email] Not emailed (demo_deal) → seller: gl link");
    return { sent: false, demo: true };
  }
  const { sendDirectEmail, buildEmailHtml } = await import("../notifications/service");
  const sent = await sendDirectEmail(email, "Your link: show a few costs in your books", buildEmailHtml({
    title: "Your link for your books",
    body: "Here is the link you asked for. Exporting your general ledger is easier on a computer — open this link there.",
    actionUrl: `/seller/${invite.token}/books`,
    businessName: deal.businessName,
  }));
  return { sent, demo: false };
}
