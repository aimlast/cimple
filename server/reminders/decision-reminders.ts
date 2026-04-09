/**
 * Decision Reminder Pipeline
 *
 * Escalates outreach to buyers who haven't explicitly chosen a direction
 * after viewing a CIM. Anchored to `buyerAccess.firstViewedAt`.
 *
 *   Day 0       — buyer first views the CIM (no prompt shown, breathing room)
 *   Day 3       — polite reminder email to the buyer
 *   Day 6       — warning email: "we will mark this as lapsed in 48 hours"
 *   Day 8       — auto-lapse: mark decision=lapsed, notify broker + seller team
 *
 * This service is idempotent — it tracks `reminderStage` on buyerAccess
 * so each email is sent exactly once. Run on a schedule (cron / setInterval).
 */
import { storage } from "../storage";
import { notify } from "../notifications/service";
import type { BuyerAccess, Deal } from "@shared/schema";

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_AFTER_MS = 3 * DAY_MS; // day 3
const WARNING_AFTER_MS = 6 * DAY_MS;  // day 6
const LAPSE_AFTER_MS = 8 * DAY_MS;    // day 8

// Direct email to the buyer (bypasses broker notification routing).
// Uses the same Resend/Twilio fallback as the broker notification service.
async function emailBuyer(to: string, subject: string, html: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[reminders] (no RESEND_API_KEY) would email ${to}: ${subject}`);
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
    return res.ok;
  } catch (err) {
    console.error(`[reminders] Email error to ${to}:`, err);
    return false;
  }
}

function buildBuyerEmail(opts: {
  businessName: string;
  viewUrl: string;
  headline: string;
  body: string;
  cta: string;
}): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="background:#141414;border:1px solid #222;border-radius:12px;padding:32px;">
      <div style="margin-bottom:20px;">
        <span style="font-size:12px;font-weight:600;color:#2dd4bf;letter-spacing:0.6px;text-transform:uppercase;">Cimple</span>
        <span style="color:#666;font-size:12px;margin-left:8px;">· ${opts.businessName}</span>
      </div>
      <h2 style="color:#f5f5f4;font-size:20px;font-weight:600;margin:0 0 14px;line-height:1.35;">${opts.headline}</h2>
      <p style="color:#a8a29e;font-size:14px;line-height:1.65;margin:0 0 24px;">${opts.body}</p>
      <a href="${opts.viewUrl}" style="display:inline-block;background:#2dd4bf;color:#0a0a0a;font-size:14px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:8px;">
        ${opts.cta}
      </a>
    </div>
    <p style="color:#444;font-size:11px;text-align:center;margin-top:16px;">
      If you no longer wish to evaluate this opportunity, you can let the broker know directly from the CIM.
    </p>
  </div>
</body>
</html>`;
}

interface RunStats {
  checked: number;
  reminderSent: number;
  warningSent: number;
  lapsed: number;
  errors: number;
}

/**
 * Run one pass of the reminder pipeline.
 * Safe to call frequently — idempotent via `reminderStage`.
 */
export async function runDecisionReminders(): Promise<RunStats> {
  const stats: RunStats = { checked: 0, reminderSent: 0, warningSent: 0, lapsed: 0, errors: 0 };
  const baseUrl = process.env.APP_URL || "https://cimple-production.up.railway.app";

  try {
    const pending = await storage.getBuyerAccessUnderReview();
    stats.checked = pending.length;
    const now = Date.now();

    for (const access of pending) {
      try {
        if (!access.firstViewedAt) continue;
        const age = now - new Date(access.firstViewedAt).getTime();
        const stage = access.reminderStage || "none";
        const deal: Deal | undefined = await storage.getDeal(access.dealId);
        if (!deal) continue;

        const viewUrl = `${baseUrl}/view/${access.accessToken}`;
        const buyerGreeting = access.buyerName ? `Hi ${access.buyerName.split(" ")[0]},` : "Hello,";

        // ── Stage 1: Day 3 reminder ─────────────────────────────────
        if (stage === "none" && age >= REMINDER_AFTER_MS && age < WARNING_AFTER_MS) {
          const html = buildBuyerEmail({
            businessName: deal.businessName,
            viewUrl,
            headline: `A quick check-in on ${deal.businessName}`,
            body: `${buyerGreeting}<br/><br/>It's been a few days since you first reviewed the Confidential Information Memorandum for <strong>${deal.businessName}</strong>. When you have a moment, please let us know whether you'd like to move forward or if this opportunity isn't the right fit — the broker would appreciate your decision either way so they can coordinate next steps.`,
            cta: "Review & share your decision",
          });
          await emailBuyer(access.buyerEmail, `Quick check-in — ${deal.businessName}`, html);
          await storage.updateBuyerAccess(access.id, {
            reminderStage: "reminder_sent",
            lastReminderAt: new Date(),
          } as any);
          stats.reminderSent++;
          continue;
        }

        // ── Stage 2: Day 6 warning ──────────────────────────────────
        if ((stage === "none" || stage === "reminder_sent") && age >= WARNING_AFTER_MS && age < LAPSE_AFTER_MS) {
          const html = buildBuyerEmail({
            businessName: deal.businessName,
            viewUrl,
            headline: `Final follow-up on ${deal.businessName}`,
            body: `${buyerGreeting}<br/><br/>We still haven't received a response regarding <strong>${deal.businessName}</strong>. If we don't hear back within the next 48 hours, this opportunity will be automatically marked as <strong>lapsed</strong> and the sell-side will be informed that you're no longer actively evaluating the business.<br/><br/>If you'd still like to explore this opportunity, please let us know by selecting a decision on the CIM.`,
            cta: "Share your decision now",
          });
          await emailBuyer(access.buyerEmail, `Final follow-up — ${deal.businessName}`, html);
          await storage.updateBuyerAccess(access.id, {
            reminderStage: "warning_sent",
            lastReminderAt: new Date(),
          } as any);
          stats.warningSent++;
          continue;
        }

        // ── Stage 3: Day 8+ auto-lapse ──────────────────────────────
        if (age >= LAPSE_AFTER_MS && (access.decision === "under_review" || !access.decision)) {
          await storage.updateBuyerAccess(access.id, {
            decision: "lapsed",
            decisionAt: new Date(),
            decisionReason: "Auto-lapsed — no response after reminder + warning emails",
            reminderStage: "warning_sent",
            lastReminderAt: new Date(),
          } as any);

          // Final courtesy email to the buyer
          const buyerHtml = buildBuyerEmail({
            businessName: deal.businessName,
            viewUrl,
            headline: `${deal.businessName} has been marked as lapsed`,
            body: `${buyerGreeting}<br/><br/>Because we didn't receive a decision from you within the review window, this opportunity has been automatically marked as lapsed and the sell-side has been informed. If this was a mistake or you'd still like to explore <strong>${deal.businessName}</strong>, please contact the broker directly and they can reactivate your access.`,
            cta: "Open the CIM",
          });
          await emailBuyer(access.buyerEmail, `${deal.businessName} — marked as lapsed`, buyerHtml);

          // Notify broker + seller team
          const buyerLabel = access.buyerName
            ? `${access.buyerName}${access.buyerCompany ? ` (${access.buyerCompany})` : ""}`
            : access.buyerEmail;
          await notify(deal.id, "buyer_decision_lapsed", {
            title: `${buyerLabel} — opportunity lapsed (no response)`,
            body: `${buyerLabel} reviewed the ${deal.businessName} CIM but did not record a decision within the review window. Following a reminder and warning email, the opportunity has been automatically marked as <strong>lapsed</strong>. The sell-side has been notified. No CRM stage change has been performed automatically for lapsed buyers — please update your pipeline manually if appropriate.`,
            actionUrl: `/deal/${deal.id}`,
            businessName: deal.businessName,
            metadata: {
              buyerAccessId: access.id,
              decision: "lapsed",
              reason: "auto_lapsed_no_response",
            },
          });

          stats.lapsed++;
          continue;
        }
      } catch (err: any) {
        console.error(`[reminders] Error processing buyer ${access.id}:`, err);
        stats.errors++;
      }
    }

    console.log(`[reminders] Run complete:`, stats);
  } catch (err) {
    console.error("[reminders] Pipeline error:", err);
    stats.errors++;
  }

  return stats;
}

/**
 * Start a background interval that runs the reminder pipeline.
 * For production reliability, also expose an admin HTTP endpoint and
 * have Railway's scheduled jobs hit it once a day — the setInterval
 * here is a safety net for when the server is up.
 */
let intervalHandle: NodeJS.Timeout | null = null;
export function startReminderScheduler(intervalMs: number = 6 * 60 * 60 * 1000) {
  if (intervalHandle) return;
  // Run once on boot (15s delay so startup finishes)
  setTimeout(() => { runDecisionReminders().catch(err => console.error("[reminders] Startup run failed:", err)); }, 15_000);
  // Then on interval
  intervalHandle = setInterval(() => {
    runDecisionReminders().catch(err => console.error("[reminders] Scheduled run failed:", err));
  }, intervalMs);
  console.log(`[reminders] Scheduler started (every ${Math.round(intervalMs / 3600_000)}h)`);
}
