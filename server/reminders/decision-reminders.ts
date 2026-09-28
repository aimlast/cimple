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
 *
 * Rules that keep it honest:
 *   - Demo/QA deals (deals.demo_key) are skipped entirely.
 *   - On an NDA deal the clock starts no earlier than the signature
 *     (reminderClockStart).
 *   - A buyer is only ever lapsed after the warning email went out
 *     (reminderStage "warning_sent"); a buyer the pipeline reaches late
 *     (server down, scheduler off) is warned first and lapses 48h later.
 *   - "Need more time" puts the buyer back under review with a fresh clock
 *     (firstViewedAt = now, reminderStage "none") — a new day-3/6/8 cycle.
 *   - A cycle is never started for a first view older than the link's
 *     30-day life: a "quick check-in" weeks later is noise.
 *   - A buyer on the Blind CIM (teaser / full access) is never told the
 *     business's name by email: the project codename, or neutral wording.
 */
import { storage } from "../storage";
import { notify, escapeHtml as escapeEmailHtml } from "../notifications/service";
import { ndaBlocksBuyer, cimHeldFromBuyers } from "@shared/cim-buyer-view";
import type { BuyerAccess, Deal } from "@shared/schema";
import { cimModeForAccessLevel } from "@shared/cim-layouts";

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_AFTER_MS = 3 * DAY_MS; // day 3
const WARNING_AFTER_MS = 6 * DAY_MS;  // day 6
const LAPSE_AFTER_MS = 8 * DAY_MS;    // day 8
const LAPSE_GRACE_MS = 2 * DAY_MS;    // the warning promises 48 hours
const STALE_AFTER_MS = 30 * DAY_MS;   // never start a cycle this late

export type ReminderAction = "none" | "reminder" | "warning" | "lapse";

/**
 * When this buyer's review clock started. Normally the first time CIM
 * content was served (firstViewedAt). On a deal that requires an NDA the
 * buyer can't have seen the CIM before signing, so a firstViewedAt older
 * than the signature is a stamp from the NDA gate (rows stamped before the
 * gate stopped counting as a view) — the clock starts at the signature, so a
 * buyer never gets the day-6 "final follow-up" right after their first real
 * look. Pure.
 */
export function reminderClockStart(
  access: Pick<BuyerAccess, "firstViewedAt"> & { ndaSignedAt?: Date | string | null },
  deal?: { ndaRequired?: boolean | null } | null,
): number | null {
  if (!access.firstViewedAt) return null;
  const viewed = new Date(access.firstViewedAt).getTime();
  if (deal?.ndaRequired && access.ndaSignedAt) {
    const signed = new Date(access.ndaSignedAt).getTime();
    if (Number.isFinite(signed) && signed > viewed) return signed;
  }
  return viewed;
}

/**
 * What the pipeline should do for one buyer-access row now. Pure — the
 * scheduler and the tests share it. Pass the deal so the clock starts at
 * the NDA signature where the deal requires one (reminderClockStart).
 */
export function reminderActionFor(
  access: Pick<BuyerAccess, "firstViewedAt" | "reminderStage" | "decision" | "revokedAt" | "expiresAt"> & { lastReminderAt?: Date | string | null; ndaSignedAt?: Date | string | null },
  now: number = Date.now(),
  deal?: { ndaRequired?: boolean | null } | null,
): ReminderAction {
  const clockStart = reminderClockStart(access, deal);
  if (clockStart === null || access.revokedAt) return "none";
  // Only buyers still deciding ("under_review"; NULL is the legacy
  // need-more-time state) are ever reminded or lapsed.
  if (access.decision && access.decision !== "under_review") return "none";
  if (access.expiresAt && new Date(access.expiresAt).getTime() < now) return "none";
  const age = now - clockStart;
  const stage = access.reminderStage || "none";
  if (stage === "warning_sent") {
    // Lapse only once the warning's 48 hours have passed.
    const warnedAt = access.lastReminderAt ? new Date(access.lastReminderAt).getTime() : null;
    const graceOver = warnedAt === null || now - warnedAt >= LAPSE_GRACE_MS;
    return age >= LAPSE_AFTER_MS && graceOver ? "lapse" : "none";
  }
  if (stage === "none" && age >= STALE_AFTER_MS) return "none";
  if (age >= WARNING_AFTER_MS) return "warning";          // day 6+, including late arrivals from "none"
  if (stage === "none" && age >= REMINDER_AFTER_MS) return "reminder";
  return "none";
}

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
        from: process.env.RESEND_FROM_EMAIL || "Cimple <notifications@cimple.ca>",
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildBuyerEmail(opts: {
  /** Already HTML-escaped. */
  headerLabel: string;
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
        <span style="color:#666;font-size:12px;margin-left:8px;">· ${opts.headerLabel}</span>
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

type DealNaming = Pick<Deal, "businessName"> & { blindCodename?: string | null };

/**
 * How the business is named in an email to this buyer. A buyer whose access
 * level serves the Blind CIM (teaser, full — see cimModeForAccessLevel) has
 * never been told who the business is: the email uses the deal's project
 * codename, or neutral wording when there is no codename yet — never the
 * business name. LOI and due-diligence buyers read the named CIM, so their
 * emails name the business.
 */
export function buyerFacingDealName(deal: DealNaming, access: Pick<BuyerAccess, "accessLevel">): { blind: boolean; name: string | null } {
  if (cimModeForAccessLevel(access.accessLevel) === "blind") {
    const code = (deal.blindCodename || "").trim();
    return { blind: true, name: code || null };
  }
  return { blind: false, name: deal.businessName };
}

export interface ReminderEmail {
  subject: string;
  html: string;
}

/**
 * The buyer's email for one reminder stage. Pure — the pipeline and the
 * tests share it.
 */
export function buildReminderEmail(
  stage: "reminder" | "warning" | "lapse",
  deal: DealNaming,
  access: Pick<BuyerAccess, "accessLevel" | "buyerName">,
  viewUrl: string,
): ReminderEmail {
  const { blind, name } = buyerFacingDealName(deal, access);
  const safe = name ? escapeHtml(name) : null;
  const first = (access.buyerName || "").trim().split(/\s+/)[0];
  const greeting = first ? `Hi ${escapeHtml(first)},` : "Hello,";
  const header = safe ?? "Confidential opportunity";
  // "the Confidential Information Memorandum for X" names the business; a
  // blind buyer only ever saw a confidential profile under a codename.
  const reviewed = !safe
    ? "the confidential business profile you were sent"
    : blind
      ? `the confidential business profile <strong>${safe}</strong>`
      : `the Confidential Information Memorandum for <strong>${safe}</strong>`;
  const regarding = safe ? `<strong>${safe}</strong>` : "the confidential opportunity you reviewed";

  if (stage === "reminder") {
    return {
      subject: name ? `Quick check-in — ${name}` : "Quick check-in on the opportunity you reviewed",
      html: buildBuyerEmail({
        headerLabel: header,
        viewUrl,
        headline: `A quick check-in on ${safe ?? "the confidential opportunity"}`,
        body: `${greeting}<br/><br/>It's been a few days since you first reviewed ${reviewed}. When you have a moment, please let us know whether you'd like to move forward or if this opportunity isn't the right fit — the broker would appreciate your decision either way so they can coordinate next steps.`,
        cta: "Review & share your decision",
      }),
    };
  }
  if (stage === "warning") {
    return {
      subject: name ? `Final follow-up — ${name}` : "Final follow-up on the opportunity you reviewed",
      html: buildBuyerEmail({
        headerLabel: header,
        viewUrl,
        headline: `Final follow-up on ${safe ?? "the confidential opportunity"}`,
        body: `${greeting}<br/><br/>We still haven't received a response regarding ${regarding}. If we don't hear back within the next 48 hours, this opportunity will be automatically marked as <strong>lapsed</strong> and the sell-side will be informed that you're no longer actively evaluating it.<br/><br/>If you'd still like to explore this opportunity, please let us know by selecting a decision on the CIM.`,
        cta: "Share your decision now",
      }),
    };
  }
  return {
    subject: name ? `${name} — marked as lapsed` : "The opportunity you reviewed has been marked as lapsed",
    html: buildBuyerEmail({
      headerLabel: header,
      viewUrl,
      headline: `${safe ?? "The confidential opportunity"} has been marked as lapsed`,
      body: `${greeting}<br/><br/>Because we didn't receive a decision from you within the review window, this opportunity has been automatically marked as lapsed and the sell-side has been informed. If this was a mistake or you'd still like to explore ${safe ? `<strong>${safe}</strong>` : "it"}, please contact the broker directly and they can reactivate your access.`,
      cta: "Open the CIM",
    }),
  };
}

/**
 * "Need more time" only applies while the buyer is still deciding. It never
 * undoes a final decision (interested / not interested / lapsed): an
 * "interested" may already be in the broker's CRM, and a lapsed buyer is
 * reactivated by the broker, not by themselves.
 */
export function canSnoozeDecision(decision: string | null | undefined): boolean {
  return !decision || decision === "under_review";
}

/**
 * Act on one buyer-access row: send the due email and advance the stage, or
 * lapse. Returns what it did. Exported so a single row can be exercised
 * without running the whole pipeline.
 */
export async function processReminderForAccess(access: BuyerAccess, now: number, baseUrl: string): Promise<ReminderAction> {
  if (!access.firstViewedAt || access.revokedAt) return "none";
  const deal: Deal | undefined = await storage.getDeal(access.dealId);
  if (!deal) return "none";
  // A CIM taken offline: the buyer can't open it, so no nudges and no
  // lapsing (they resume where they stopped once it's published again).
  if (!deal.isLive) return "none";
  // Demo and QA deals (seeded showcase data, fictional buyers) are never
  // automated: no reminders to .invalid buyers, no auto-lapse rewriting the
  // showcase, and no "opportunity lapsed" emails to the broker about people
  // who don't exist.
  if (deal.demoKey) return "none";
  // A buyer who hasn't signed a required NDA has never seen the CIM or the
  // decision panel — they can't be told they "reviewed" it, or lapsed.
  // (The view room no longer starts the clock at the gate; this also covers
  // rows stamped before it stopped.)
  if (ndaBlocksBuyer(deal, access)) return "none";
  // A regenerated CIM waiting for the broker to publish it: the buyer can
  // only see "This document is being updated", so nobody is chased or
  // lapsed over it. Publishing restarts the clock (restartReminderClocks).
  if (cimHeldFromBuyers(deal)) return "none";
  const action = reminderActionFor(access as any, now, deal);
  if (action === "none") return action;

  const viewUrl = `${baseUrl}/view/${access.accessToken}`;

  // ── Stage 1: Day 3 reminder ─────────────────────────────────
  if (action === "reminder") {
    const email = buildReminderEmail("reminder", deal, access, viewUrl);
    await emailBuyer(access.buyerEmail, email.subject, email.html);
    await storage.updateBuyerAccess(access.id, {
      decision: "under_review",
      reminderStage: "reminder_sent",
      lastReminderAt: new Date(now),
    } as any);
    return action;
  }

  // ── Stage 2: Day 6 warning (or the first email for a late arrival) ──
  if (action === "warning") {
    const email = buildReminderEmail("warning", deal, access, viewUrl);
    await emailBuyer(access.buyerEmail, email.subject, email.html);
    await storage.updateBuyerAccess(access.id, {
      decision: "under_review",
      reminderStage: "warning_sent",
      lastReminderAt: new Date(now),
    } as any);
    return action;
  }

  // ── Stage 3: Day 8+ auto-lapse (only after the warning) ─────
  await storage.updateBuyerAccess(access.id, {
    decision: "lapsed",
    decisionAt: new Date(now),
    decisionReason: "Auto-lapsed — no response after reminder + warning emails",
    lastReminderAt: new Date(now),
  } as any);

  // Final courtesy email to the buyer
  const lapseEmail = buildReminderEmail("lapse", deal, access, viewUrl);
  await emailBuyer(access.buyerEmail, lapseEmail.subject, lapseEmail.html);

  // Notify broker + seller team (the sell side — the business's name is fine here)
  const buyerLabel = access.buyerName
    ? `${access.buyerName}${access.buyerCompany ? ` (${access.buyerCompany})` : ""}`
    : access.buyerEmail;
  await notify(deal.id, "buyer_decision_lapsed", {
    title: `${buyerLabel} — opportunity lapsed (no response)`,
    // The buyer typed their own name/company at the NDA: escaped.
    body: `${escapeEmailHtml(buyerLabel)} reviewed the ${escapeEmailHtml(deal.businessName)} CIM but did not record a decision within the review window. Following a reminder and warning email, the opportunity has been automatically marked as <strong>lapsed</strong>. The sell-side has been notified. No CRM stage change has been performed automatically for lapsed buyers — please update your pipeline manually if appropriate.`,
    actionUrl: `/deal/${deal.id}`,
    businessName: deal.businessName,
    metadata: {
      buyerAccessId: access.id,
      decision: "lapsed",
      reason: "auto_lapsed_no_response",
    },
  });
  return action;
}

/**
 * Pure: the buyer-access rows whose review clock restarts when a held CIM
 * is published — still deciding, not revoked or expired, and first viewed
 * before the hold began (they reviewed the CIM that was replaced). Their
 * day-3/6/8 cycle restarts from the publish, the way "Need more time" gives
 * a fresh clock; a warning sent about the old CIM never lapses them.
 */
export function clocksToRestart(
  access: Array<Pick<BuyerAccess, "id" | "firstViewedAt" | "decision" | "revokedAt" | "expiresAt">>,
  holdSince: string | Date | null | undefined,
  now: number = Date.now(),
): string[] {
  const since = holdSince ? new Date(holdSince).getTime() : Number.POSITIVE_INFINITY;
  return access
    .filter((a) => {
      if (!a.firstViewedAt || a.revokedAt) return false;
      if (a.decision && a.decision !== "under_review") return false;
      if (a.expiresAt && new Date(a.expiresAt).getTime() < now) return false;
      return new Date(a.firstViewedAt).getTime() <= since;
    })
    .map((a) => a.id);
}

/** The held CIM was published: undecided buyers get a fresh review window. */
export async function restartReminderClocks(dealId: string, holdSince: string | Date | null | undefined, now: number = Date.now()): Promise<number> {
  const rows = await storage.getBuyerAccessByDeal(dealId);
  const ids = clocksToRestart(rows, holdSince, now);
  for (const id of ids) {
    await storage.updateBuyerAccess(id, { firstViewedAt: new Date(now), reminderStage: "none", lastReminderAt: null } as any);
  }
  return ids.length;
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
        const action = await processReminderForAccess(access, now, baseUrl);
        if (action === "reminder") stats.reminderSent++;
        else if (action === "warning") stats.warningSent++;
        else if (action === "lapse") stats.lapsed++;
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
