/**
 * Notification Service
 *
 * Event-driven notifications via email (Resend) and SMS (Twilio).
 * Gracefully degrades when credentials aren't configured — logs to console instead.
 *
 * Usage:
 *   await notify(dealId, "qa_needs_approval", {
 *     title: "Buyer question needs your approval",
 *     body: "A buyer asked about revenue trends...",
 *     actionUrl: "/approve/abc123",
 *   });
 *
 * Environment variables:
 *   RESEND_API_KEY       — enables email delivery
 *   TWILIO_ACCOUNT_SID   — enables SMS delivery
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_PHONE_NUMBER
 */
import { storage } from "../storage";
import { redactLogText } from "../log-redact";
import { escapeHtml, sanitizeEmailFragment } from "./email-escape";
import { NOTIFICATION_ROUTING } from "@shared/schema";
import type { DealMember, SellerInvite, User } from "@shared/schema";

// ── Broker notification preferences ─────────────────────────────────────
//
// Brokers manage email preferences on Settings → Notifications. Each switch
// there maps to one or more real NOTIFICATION_ROUTING events that route to
// the broker team. Keep this table in sync with client/src/pages/Settings.tsx
// (NOTIFICATION_PREFERENCES). Events not listed here (team invites, seller-
// and buyer-facing events) are never muted by a broker preference.
export const BROKER_EVENT_PREFERENCE: Record<string, string> = {
  buyer_question: "buyerQuestions",
  buyer_decision_interested: "buyerDecisions",
  buyer_decision_not_interested: "buyerDecisions",
  buyer_decision_lapsed: "buyerDecisions",
  buyer_approval_requested: "buyerApprovals",
  buyer_approval_seller_approved: "buyerApprovals",
  buyer_approval_rejected: "buyerApprovals",
  interview_complete: "interviewUpdates",
  seller_followups_answered: "interviewUpdates",
};

/**
 * Resolve whether a broker-team member has muted email for this event.
 * Only broker-team members whose email matches a broker user account carry
 * preferences; everyone else defaults to "send". A preference that was never
 * saved (undefined) also means "send".
 */
async function isEmailMutedByPreference(
  member: DealMember,
  eventType: string,
  cache: Map<string, User | null>,
): Promise<boolean> {
  if (member.teamType !== "broker" || !member.email) return false;
  const prefKey = BROKER_EVENT_PREFERENCE[eventType];
  if (!prefKey) return false;

  const emailKey = member.email.trim().toLowerCase();
  let user = cache.get(emailKey);
  if (user === undefined) {
    try {
      user = (await storage.getUserByEmail(emailKey)) ?? null;
    } catch (err) {
      console.warn(`[notify] Could not load preferences for ${emailKey}:`, err);
      user = null;
    }
    cache.set(emailKey, user);
  }
  if (!user || user.role !== "broker") return false;

  const prefs = (user.settings as { notifications?: Record<string, unknown> } | null)?.notifications;
  return prefs?.[prefKey] === false;
}

// ── Email provider (Resend) ──────────────────────────────────────────────

export async function sendDirectEmail(
  to: string,
  subject: string,
  html: string,
  cc?: string[],
  opts: {
    /** Where the recipient's "Reply" goes (e.g. the broker's own inbox). */
    replyTo?: string | null;
    /** Display name on the From line, e.g. "Jane Smith via Cimple" (the address stays ours). */
    fromName?: string | null;
  } = {},
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[notify:email] (no RESEND_API_KEY) → ${to}${cc?.length ? ` (cc: ${cc.join(", ")})` : ""}${opts.replyTo ? ` (reply-to: ${opts.replyTo})` : ""}: ${subject}`);
    return false;
  }
  const defaultFrom = process.env.RESEND_FROM_EMAIL || "Cimple <notifications@cimple.ca>";
  const fromAddress = (defaultFrom.match(/<([^>]+)>/)?.[1] || defaultFrom).trim();
  const safeName = opts.fromName ? opts.fromName.replace(/["<>\r\n]/g, "").trim().slice(0, 80) : "";
  const from = safeName ? `${safeName} <${fromAddress}>` : defaultFrom;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: [to],
        cc: cc && cc.length > 0 ? cc : undefined,
        reply_to: opts.replyTo ? [opts.replyTo] : undefined,
        subject,
        html,
      }),
    });
    if (!res.ok) {
      console.error(`[notify:email] Failed to send to ${to}:`, await res.text());
      return false;
    }
    console.log(`[notify:email] Sent to ${to}${cc?.length ? ` cc ${cc.join(",")}` : ""}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[notify:email] Error:`, err);
    return false;
  }
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[notify:email] (no RESEND_API_KEY) → ${to}: ${subject}`);
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || "Cimple <notifications@cimple.ca>",
        to: [to],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[notify:email] Failed to send to ${to}:`, err);
      return false;
    }

    console.log(`[notify:email] Sent to ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[notify:email] Error sending to ${to}:`, err);
    return false;
  }
}

// ── SMS provider (Twilio) ────────────────────────────────────────────────

async function sendSms(to: string, body: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !from) {
    console.log(`[notify:sms] (no Twilio credentials) → ${to}: ${redactLogText(body).slice(0, 80)}...`);
    return false;
  }

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      console.error(`[notify:sms] Failed to send to ${to}:`, err);
      return false;
    }

    console.log(`[notify:sms] Sent to ${to}: ${redactLogText(body).slice(0, 50)}...`);
    return true;
  } catch (err) {
    console.error(`[notify:sms] Error sending to ${to}:`, err);
    return false;
  }
}

// ── Email template ───────────────────────────────────────────────────────

/** For callers that build their own email HTML (email-escape.ts). */
export { escapeHtml };

/**
 * `title` and `businessName` are plain text and are escaped here. `body`
 * keeps only plain formatting tags (sanitizeEmailFragment) — callers still
 * escape every user-typed value they put in it.
 */
export function buildEmailHtml(opts: {
  title: string;
  body: string;
  actionUrl?: string;
  businessName?: string;
}): string {
  const baseUrl = process.env.APP_URL || "https://cimple-production.up.railway.app";
  const fullActionUrl = opts.actionUrl
    ? opts.actionUrl.startsWith("http") ? opts.actionUrl : `${baseUrl}${opts.actionUrl}`
    : null;
  // Titles and names are text; the body keeps only plain formatting tags —
  // a buyer's question or name can never become a link or markup here.
  const title = escapeHtml(opts.title);
  const businessName = opts.businessName ? escapeHtml(opts.businessName) : "";
  const body = sanitizeEmailFragment(opts.body);
  const href = fullActionUrl ? escapeHtml(fullActionUrl) : null;

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px;">
    <div style="background:#141414;border:1px solid #222;border-radius:12px;padding:32px;">
      <div style="margin-bottom:24px;">
        <span style="font-size:13px;font-weight:600;color:#2dd4bf;letter-spacing:0.5px;text-transform:uppercase;">Cimple</span>
        ${businessName ? `<span style="color:#666;font-size:12px;margin-left:8px;">· ${businessName}</span>` : ""}
      </div>
      <h2 style="color:#f5f5f4;font-size:18px;font-weight:600;margin:0 0 12px;">${title}</h2>
      <p style="color:#a8a29e;font-size:14px;line-height:1.6;margin:0 0 24px;">${body}</p>
      ${href ? `
      <a href="${href}" style="display:inline-block;background:#2dd4bf;color:#0a0a0a;font-size:14px;font-weight:600;text-decoration:none;padding:10px 24px;border-radius:8px;">
        Take action
      </a>` : ""}
    </div>
    <p style="color:#444;font-size:11px;text-align:center;margin-top:16px;">
      This is an automated notification from Cimple. Do not reply to this email.
    </p>
  </div>
</body>
</html>`;
}

// ── SMS template ─────────────────────────────────────────────────────────

function buildSmsBody(opts: { title: string; body: string; actionUrl?: string }): string {
  const baseUrl = process.env.APP_URL || "https://cimple-production.up.railway.app";
  const link = opts.actionUrl
    ? opts.actionUrl.startsWith("http") ? opts.actionUrl : `${baseUrl}${opts.actionUrl}`
    : null;

  // The body is HTML for the email; a text message gets the plain words.
  const plain = opts.body.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
  let msg = `Cimple: ${opts.title}\n${plain}`;
  if (link) msg += `\n${link}`;
  // SMS max ~160 chars per segment, keep it concise
  return msg.length > 300 ? msg.slice(0, 297) + "..." : msg;
}

// ── Main notify function ─────────────────────────────────────────────────

export interface NotifyOptions {
  title: string;
  body: string;
  actionUrl?: string;
  businessName?: string;
  metadata?: Record<string, any>;
  // Override default routing — send to specific members instead
  specificMemberIds?: string[];
  /**
    * The signed-in broker whose own action raised this event (they submitted
    * the approval, rejected it, ran the interview themselves). They aren't
    * emailed about it — neither as the deal's owner nor as a broker-team
    * member with their account email. Everyone else routed for it still is.
    */
   actorUserId?: string | null;
}

export interface NotifyResult {
  /** How many people were addressed (members, or the seller-invite fallback). */
  recipients: number;
  /** How many emails the provider accepted (0 when RESEND_API_KEY is absent). */
  emailsSent: number;
  /** Where the recipients came from ("deal_owner" = only the deal's own broker). */
  via: "members" | "seller_invite" | "deal_owner" | "none";
}

/**
 * The deal's own broker is its lead broker whether or not anyone built a
 * team: deal creation never adds them as a member (production: 0 broker-team
 * rows on the demo and QA accounts' deals), so buyer decisions, escalated
 * questions and approval requests used to email nobody. They get every
 * event routed to the lead broker — unless the broker put themselves on the
 * team explicitly, in which case that row (role, email/SMS toggles) governs.
 */
export function ownerGetsEvent(
  eventType: string,
  ownerEmail: string | null | undefined,
  members: Pick<DealMember, "teamType" | "email">[],
): boolean {
  const routing = NOTIFICATION_ROUTING[eventType];
  if (!routing || !routing.teams.includes("broker")) return false;
  if (routing.roles && !routing.roles.includes("lead")) return false;
  const email = ownerEmail?.trim().toLowerCase();
  if (!email) return false;
  return !members.some((m) => m.teamType === "broker" && m.email?.trim().toLowerCase() === email);
}

/** The owner's Settings → Notifications switch for this event (unset = send). */
export function ownerMutedFor(settings: unknown, eventType: string): boolean {
  const prefKey = BROKER_EVENT_PREFERENCE[eventType];
  if (!prefKey) return false;
  const prefs = (settings as { notifications?: Record<string, unknown> } | null)?.notifications;
  return prefs?.[prefKey] === false;
}

/**
 * Why the deal's owner is recorded but not emailed for this event (null =
 * email them). Seeded demo / QA deals (`deals.demoKey`) never email their
 * owner: their buyers and sellers are fictional, and a lapse notice for a
 * made-up buyer in the founder's inbox is noise, not news.
 */
export function ownerEmailSkipReason(opts: {
  settings: unknown;
  eventType: string;
  demoKey?: string | null;
}): "muted_by_preference" | "demo_deal" | null {
  if (ownerMutedFor(opts.settings, opts.eventType)) return "muted_by_preference";
  if (opts.demoKey) return "demo_deal";
  return null;
}

/** Email the deal's owning broker; records the notification either way. */
async function notifyDealOwner(
  dealId: string,
  eventType: string,
  opts: NotifyOptions,
  members: DealMember[],
): Promise<{ addressed: boolean; emailSent: boolean }> {
  const deal = await storage.getDeal(dealId);
  const owner = deal?.brokerId ? await storage.getUser(deal.brokerId) : undefined;
  if (!owner || !ownerGetsEvent(eventType, owner.email, members)) return { addressed: false, emailSent: false };
  // Their own action: nothing to tell them.
  if (opts.actorUserId && opts.actorUserId === owner.id) {
    console.log(`[notify] ${eventType}: raised by the deal's own broker — not notifying them`);
    return { addressed: false, emailSent: false };
  }
  const email = owner.email!.trim();
  const skip = ownerEmailSkipReason({
    settings: owner.settings,
    eventType,
    demoKey: deal?.demoKey,
  });
  const muted = skip === "muted_by_preference";
  let emailSent = false;
  if (skip) {
    console.log(`[notify:email] Not emailed (${skip === "muted_by_preference" ? `muted: ${BROKER_EVENT_PREFERENCE[eventType]}` : skip}) → deal owner: ${eventType}`);
  } else {
    emailSent = await sendEmail(email, opts.title, buildEmailHtml({ ...opts }));
  }
  await storage.createNotification({
    dealId,
    recipientId: owner.id,
    recipientEmail: email,
    recipientPhone: null,
    type: eventType,
    title: opts.title,
    body: opts.body,
    actionUrl: opts.actionUrl || null,
    metadata: {
      ...(opts.metadata || {}),
      fallbackRecipient: "deal_owner",
      ...(muted ? { emailMutedByPreference: true } : {}),
      ...(skip && !muted ? { emailSkipped: skip } : {}),
    },
    emailSent,
    emailSentAt: emailSent ? new Date() : null,
    smsSent: false,
    smsSentAt: null,
  });
  return { addressed: true, emailSent };
}

const NO_RECIPIENTS: NotifyResult = { recipients: 0, emailsSent: 0, via: "none" };

/**
 * Seller invites that may receive seller-facing mail: only addresses the
 * broker actually sent an invite to — a pending row (typed but never sent,
 * or later corrected) must never receive mail. One row per address.
 */
function eligibleSellerInvites(invites: SellerInvite[]): SellerInvite[] {
  const now = Date.now();
  const seen = new Set<string>();
  return invites.filter((inv) => {
    const email = inv.sellerEmail?.trim().toLowerCase();
    if (!email || seen.has(email)) return false;
    if (inv.status !== "sent" && inv.status !== "accepted") return false;
    if (inv.expiresAt && inv.expiresAt.getTime() < now && inv.status !== "accepted") return false;
    seen.add(email);
    return true;
  });
}

/** Team members that NOTIFICATION_ROUTING would address for this event. */
function routedMembers(members: DealMember[], eventType: string): DealMember[] {
  const routing = NOTIFICATION_ROUTING[eventType];
  if (!routing) return [];
  return members.filter((m) => {
    if (!routing.teams.includes(m.teamType)) return false;
    if (routing.roles && !routing.roles.includes(m.role)) return false;
    if (m.inviteStatus !== "accepted" && m.inviteStatus !== "sent") return false;
    return true;
  });
}

export interface RecipientPreview {
  via: NotifyResult["via"];
  members: { name: string | null; email: string | null; role: string }[];
  sellerInvites: { name: string | null; email: string }[];
}

/**
 * Who a notify() for this event would reach right now, without sending.
 * Lets the UI ask the broker to confirm before a seller-facing email goes
 * to the invite address instead of a seller team member.
 */
export async function previewRecipients(dealId: string, eventType: string): Promise<RecipientPreview> {
  const members = routedMembers(await storage.getDealMembers(dealId), eventType);
  if (members.length > 0) {
    return {
      via: "members",
      members: members.map((m) => ({ name: m.name, email: m.email, role: m.role })),
      sellerInvites: [],
    };
  }
  const sellerRouted = !!NOTIFICATION_ROUTING[eventType]?.teams.includes("seller");
  const invites = sellerRouted ? eligibleSellerInvites(await storage.getSellerInvitesByDealId(dealId)) : [];
  return {
    via: invites.length > 0 ? "seller_invite" : "none",
    members: [],
    sellerInvites: invites.map((inv) => ({ name: inv.sellerName, email: inv.sellerEmail!.trim() })),
  };
}

/**
 * Seller-facing events must reach the seller even when nobody on the deal
 * team has been added with a seller role yet — the invited seller is a
 * sellerInvites row, not a dealMembers row, until the broker builds the
 * team. Email the deal's seller invite(s) directly and record the
 * notification against the invite so the broker's log shows it went out.
 */
async function notifySellerInviteFallback(
  dealId: string,
  eventType: string,
  opts: NotifyOptions,
): Promise<NotifyResult> {
  const targets = eligibleSellerInvites(await storage.getSellerInvitesByDealId(dealId));
  if (targets.length === 0) return NO_RECIPIENTS;

  let emailsSent = 0;
  const html = buildEmailHtml({ ...opts });
  for (const inv of targets) {
    const email = inv.sellerEmail!.trim();
    const emailSent = await sendEmail(email, opts.title, html);
    if (emailSent) emailsSent++;
    await storage.createNotification({
      dealId,
      recipientId: inv.id,
      recipientEmail: email,
      recipientPhone: null,
      type: eventType,
      title: opts.title,
      body: opts.body,
      actionUrl: opts.actionUrl || null,
      metadata: { ...(opts.metadata || {}), fallbackRecipient: "seller_invite", sellerInviteId: inv.id },
      emailSent,
      emailSentAt: emailSent ? new Date() : null,
      smsSent: false,
      smsSentAt: null,
    });
  }
  console.log(`[notify] ${eventType}: no seller team member — emailed ${targets.length} seller invite(s) instead`);
  return { recipients: targets.length, emailsSent, via: "seller_invite" };
}

/**
 * Who a seller-portal email goes to, each with THEIR OWN seller link: the
 * seller-team members routed for the event (a member's link is the invite
 * minted for their address), else the deal's sent/accepted seller invites.
 * A member with no live link of their own is skipped — a seller-portal
 * link is never someone else's token. Pure.
 */
export function sellerPortalRecipients(
  eventType: string,
  members: DealMember[],
  invites: SellerInvite[],
): { email: string; name: string | null; token: string; recipientId: string; via: "members" | "seller_invite" }[] {
  const live = invites.filter((i) => i.status !== "revoked" && !!i.token);
  const byEmail = new Map<string, SellerInvite>();
  // Newest first from storage; keep the first (newest) per address.
  for (const inv of live) {
    const e = inv.sellerEmail?.trim().toLowerCase();
    if (e && !byEmail.has(e)) byEmail.set(e, inv);
  }
  const routed = routedMembers(members, eventType).filter((m) => m.teamType === "seller" && m.emailNotifications !== false && !!m.email);
  const fromMembers = routed
    .map((m) => {
      const inv = byEmail.get(m.email!.trim().toLowerCase());
      return inv ? { email: m.email!.trim(), name: m.name ?? null, token: inv.token, recipientId: m.id, via: "members" as const } : null;
    })
    .filter((r): r is NonNullable<typeof r> => !!r);
  if (routed.length > 0) return fromMembers;
  return eligibleSellerInvites(live).map((inv) => ({
    email: inv.sellerEmail!.trim(),
    name: inv.sellerName ?? null,
    token: inv.token,
    recipientId: inv.id,
    via: "seller_invite" as const,
  }));
}

/**
 * A seller-facing email whose button opens the seller's own portal page
 * (`/seller/<their token>/<path>`): the CIM ready for their review, the
 * broker's follow-up questions. Seeded demo/QA deals record it but never
 * email (their sellers are fictional).
 */
export async function notifySellerPortal(
  dealId: string,
  eventType: string,
  opts: { title: string; body: string; path: string; businessName?: string; metadata?: Record<string, any> },
): Promise<NotifyResult> {
  try {
    const deal = await storage.getDeal(dealId);
    if (!deal) return NO_RECIPIENTS;
    const targets = sellerPortalRecipients(
      eventType,
      await storage.getDealMembers(dealId),
      await storage.getSellerInvitesByDealId(dealId),
    );
    if (targets.length === 0) {
      console.log(`[notify] ${eventType}: no seller with a link of their own on deal ${dealId}`);
      return NO_RECIPIENTS;
    }
    const path = opts.path.replace(/^\/+/, "");
    let emailsSent = 0;
    for (const t of targets) {
      const actionUrl = `/seller/${t.token}/${path}`;
      const skip = deal.demoKey ? "demo_deal" : null;
      const emailSent = skip
        ? false
        : await sendEmail(t.email, opts.title, buildEmailHtml({ title: opts.title, body: opts.body, actionUrl, businessName: opts.businessName }));
      if (skip) console.log(`[notify:email] Not emailed (${skip}) → seller: ${eventType}`);
      if (emailSent) emailsSent++;
      await storage.createNotification({
        dealId,
        recipientId: t.recipientId,
        recipientEmail: t.email,
        recipientPhone: null,
        type: eventType,
        title: opts.title,
        body: opts.body,
        // (The link carries the seller's token — the log keeps the page, not the token.)
        actionUrl: `/seller/…/${path}`,
        metadata: { ...(opts.metadata || {}), ...(t.via === "seller_invite" ? { fallbackRecipient: "seller_invite", sellerInviteId: t.recipientId } : {}), ...(skip ? { emailSkipped: skip } : {}) },
        emailSent,
        emailSentAt: emailSent ? new Date() : null,
        smsSent: false,
        smsSentAt: null,
      });
    }
    return { recipients: targets.length, emailsSent, via: targets[0].via };
  } catch (err) {
    console.error(`[notify] Error dispatching ${eventType}:`, err);
    return NO_RECIPIENTS;
  }
}

/**
 * Send notifications for a deal event.
 *
 * Automatically routes to the right team members based on NOTIFICATION_ROUTING.
 * Sends email and/or SMS based on each member's preferences.
 * Resolves with who was reached so callers can tell the broker when nobody was.
 */
export async function notify(
  dealId: string,
  eventType: string,
  opts: NotifyOptions,
): Promise<NotifyResult> {
  try {
    let sellerRouted = false;
    let recipients: DealMember[] = [];
    let owner = { addressed: false, emailSent: false };

    if (opts.specificMemberIds?.length) {
      // Send to specific members
      const allMembers = await storage.getDealMembers(dealId);
      recipients = allMembers.filter(m => opts.specificMemberIds!.includes(m.id));
    } else {
      // Route based on event type
      const routing = NOTIFICATION_ROUTING[eventType];
      if (!routing) {
        console.warn(`[notify] No routing for event type: ${eventType}`);
        return NO_RECIPIENTS;
      }
      sellerRouted = routing.teams.includes("seller");

      const allMembers = await storage.getDealMembers(dealId);
      recipients = routedMembers(allMembers, eventType);
      // The deal's own broker, when they aren't on the team themselves.
      owner = await notifyDealOwner(dealId, eventType, opts, allMembers).catch((err) => {
        console.warn(`[notify] owner notification failed for ${eventType}:`, err);
        return { addressed: false, emailSent: false };
      });
    }

    // The broker who caused the event isn't told about it (matched to a
    // broker-team member by their account email).
    if (opts.actorUserId && recipients.length > 0) {
      const actorEmail = (await storage.getUser(opts.actorUserId).catch(() => undefined))?.email?.trim().toLowerCase();
      if (actorEmail) {
        recipients = recipients.filter((m) => !(m.teamType === "broker" && m.email?.trim().toLowerCase() === actorEmail));
      }
    }

    if (recipients.length === 0) {
      const fallback = sellerRouted ? await notifySellerInviteFallback(dealId, eventType, opts) : NO_RECIPIENTS;
      if (fallback.recipients > 0 || owner.addressed) {
        if (owner.addressed) console.log(`[notify] ${eventType}: deal owner notified (no team recipients)`);
        return {
          recipients: fallback.recipients + (owner.addressed ? 1 : 0),
          emailsSent: fallback.emailsSent + (owner.emailSent ? 1 : 0),
          via: fallback.recipients > 0 ? "seller_invite" : "deal_owner",
        };
      }
      console.log(`[notify] No recipients for ${eventType} on deal ${dealId}`);
      return NO_RECIPIENTS;
    }

    // Broker user lookups are shared across recipients of this dispatch.
    const userCache = new Map<string, User | null>();

    // Send in parallel
    const results = await Promise.allSettled(
      recipients.map(async (member): Promise<boolean> => {
        let emailSent = false;
        let smsSent = false;
        let mutedByPreference = false;

        // Email — honors the broker's Settings → Notifications preferences
        if (member.emailNotifications && member.email) {
          mutedByPreference = await isEmailMutedByPreference(member, eventType, userCache);
          if (mutedByPreference) {
            console.log(`[notify:email] Muted by preference (${BROKER_EVENT_PREFERENCE[eventType]}) → ${member.email}: ${eventType}`);
          } else {
            const html = buildEmailHtml({ ...opts });
            emailSent = await sendEmail(member.email, opts.title, html);
          }
        }

        // SMS
        if (member.smsNotifications && member.phone) {
          const smsBody = buildSmsBody(opts);
          smsSent = await sendSms(member.phone, smsBody);
        }

        // Record notification
        await storage.createNotification({
          dealId,
          recipientId: member.id,
          recipientEmail: member.email,
          recipientPhone: member.phone || null,
          type: eventType,
          title: opts.title,
          body: opts.body,
          actionUrl: opts.actionUrl || null,
          metadata: mutedByPreference
            ? { ...(opts.metadata || {}), emailMutedByPreference: true }
            : (opts.metadata || {}),
          emailSent,
          emailSentAt: emailSent ? new Date() : null,
          smsSent,
          smsSentAt: smsSent ? new Date() : null,
        });
        return emailSent;
      }),
    );

    const sent = results.filter(r => r.status === "fulfilled").length;
    const emailsSent = results.filter(r => r.status === "fulfilled" && r.value === true).length;
    console.log(`[notify] ${eventType}: ${sent}/${recipients.length} recipients notified${owner.addressed ? " + deal owner" : ""}`);
    return {
      recipients: recipients.length + (owner.addressed ? 1 : 0),
      emailsSent: emailsSent + (owner.emailSent ? 1 : 0),
      via: "members",
    };
  } catch (err) {
    console.error(`[notify] Error dispatching ${eventType}:`, err);
    return NO_RECIPIENTS;
  }
}
