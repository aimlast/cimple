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
import { NOTIFICATION_ROUTING } from "@shared/schema";
import type { DealMember, User } from "@shared/schema";

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
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[notify:email] (no RESEND_API_KEY) → ${to}${cc?.length ? ` (cc: ${cc.join(", ")})` : ""}: ${subject}`);
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
        cc: cc && cc.length > 0 ? cc : undefined,
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
    console.log(`[notify:sms] (no Twilio credentials) → ${to}: ${body.slice(0, 80)}...`);
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

    console.log(`[notify:sms] Sent to ${to}: ${body.slice(0, 50)}...`);
    return true;
  } catch (err) {
    console.error(`[notify:sms] Error sending to ${to}:`, err);
    return false;
  }
}

// ── Email template ───────────────────────────────────────────────────────

function buildEmailHtml(opts: {
  title: string;
  body: string;
  actionUrl?: string;
  businessName?: string;
}): string {
  const baseUrl = process.env.APP_URL || "https://cimple-production.up.railway.app";
  const fullActionUrl = opts.actionUrl
    ? opts.actionUrl.startsWith("http") ? opts.actionUrl : `${baseUrl}${opts.actionUrl}`
    : null;

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px;">
    <div style="background:#141414;border:1px solid #222;border-radius:12px;padding:32px;">
      <div style="margin-bottom:24px;">
        <span style="font-size:13px;font-weight:600;color:#2dd4bf;letter-spacing:0.5px;text-transform:uppercase;">Cimple</span>
        ${opts.businessName ? `<span style="color:#666;font-size:12px;margin-left:8px;">· ${opts.businessName}</span>` : ""}
      </div>
      <h2 style="color:#f5f5f4;font-size:18px;font-weight:600;margin:0 0 12px;">${opts.title}</h2>
      <p style="color:#a8a29e;font-size:14px;line-height:1.6;margin:0 0 24px;">${opts.body}</p>
      ${fullActionUrl ? `
      <a href="${fullActionUrl}" style="display:inline-block;background:#2dd4bf;color:#0a0a0a;font-size:14px;font-weight:600;text-decoration:none;padding:10px 24px;border-radius:8px;">
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

  let msg = `Cimple: ${opts.title}\n${opts.body}`;
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
}

export interface NotifyResult {
  /** How many people were addressed (members, or the seller-invite fallback). */
  recipients: number;
  /** How many emails the provider accepted (0 when RESEND_API_KEY is absent). */
  emailsSent: number;
  /** Where the recipients came from. */
  via: "members" | "seller_invite" | "none";
}

const NO_RECIPIENTS: NotifyResult = { recipients: 0, emailsSent: 0, via: "none" };

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
  const invites = await storage.getSellerInvitesByDealId(dealId);
  const now = Date.now();
  const seen = new Set<string>();
  const targets = invites.filter((inv) => {
    const email = inv.sellerEmail?.trim().toLowerCase();
    if (!email || seen.has(email)) return false;
    // Only addresses the broker actually sent an invite to — a pending row
    // (typed but never sent, or later corrected) must never receive mail.
    if (inv.status !== "sent" && inv.status !== "accepted") return false;
    if (inv.expiresAt && inv.expiresAt.getTime() < now && inv.status !== "accepted") return false;
    seen.add(email);
    return true;
  });
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
      recipients = allMembers.filter(m => {
        if (!routing.teams.includes(m.teamType)) return false;
        if (routing.roles && !routing.roles.includes(m.role)) return false;
        if (m.inviteStatus !== "accepted" && m.inviteStatus !== "sent") return false;
        return true;
      });
    }

    if (recipients.length === 0) {
      if (sellerRouted) {
        const fallback = await notifySellerInviteFallback(dealId, eventType, opts);
        if (fallback.recipients > 0) return fallback;
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
    console.log(`[notify] ${eventType}: ${sent}/${recipients.length} recipients notified`);
    return { recipients: recipients.length, emailsSent, via: "members" };
  } catch (err) {
    console.error(`[notify] Error dispatching ${eventType}:`, err);
    return NO_RECIPIENTS;
  }
}
