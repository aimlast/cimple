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
import type { DealMember } from "@shared/schema";

// ── Email provider (Resend) ──────────────────────────────────────────────

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
        from: process.env.RESEND_FROM_EMAIL || "Cimple <notifications@cimple.app>",
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

/**
 * Send notifications for a deal event.
 *
 * Automatically routes to the right team members based on NOTIFICATION_ROUTING.
 * Sends email and/or SMS based on each member's preferences.
 */
export async function notify(
  dealId: string,
  eventType: string,
  opts: NotifyOptions,
): Promise<void> {
  try {
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
        return;
      }

      const allMembers = await storage.getDealMembers(dealId);
      recipients = allMembers.filter(m => {
        if (!routing.teams.includes(m.teamType)) return false;
        if (routing.roles && !routing.roles.includes(m.role)) return false;
        if (m.inviteStatus !== "accepted" && m.inviteStatus !== "sent") return false;
        return true;
      });
    }

    if (recipients.length === 0) {
      console.log(`[notify] No recipients for ${eventType} on deal ${dealId}`);
      return;
    }

    // Send in parallel
    const results = await Promise.allSettled(
      recipients.map(async (member) => {
        let emailSent = false;
        let smsSent = false;

        // Email
        if (member.emailNotifications && member.email) {
          const html = buildEmailHtml({ ...opts });
          emailSent = await sendEmail(member.email, opts.title, html);
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
          metadata: opts.metadata || {},
          emailSent,
          emailSentAt: emailSent ? new Date() : null,
          smsSent,
          smsSentAt: smsSent ? new Date() : null,
        });
      }),
    );

    const sent = results.filter(r => r.status === "fulfilled").length;
    console.log(`[notify] ${eventType}: ${sent}/${recipients.length} recipients notified`);
  } catch (err) {
    console.error(`[notify] Error dispatching ${eventType}:`, err);
  }
}
