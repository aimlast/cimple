/**
 * seller-followups — questions the broker routes to a seller who has
 * already finished the interview.
 *
 * "Ask seller in interview" only put the row on the interview's agenda.
 * With the interview already complete, nothing brought the seller back —
 * their progress page said "Done", the interview page "Your conversation
 * is complete" — so the question was never asked, and because a routed
 * row counted as handled, a critical conflict stopped blocking the CIM.
 * Now:
 *   - routing after the interview emails the seller (their own link, to
 *     the interview page), at most once an hour for a burst of routings;
 *   - their progress page and the finished-interview card say "Your broker
 *     has N follow-up questions" and start a session that raises them;
 *   - until the seller has answered (the session's end hands the row back
 *     as seller_responded), a routed CRITICAL row keeps blocking the CIM
 *     (discrepancyBlocksCim).
 */
import type { Discrepancy } from "@shared/schema";

/** A routed row still waiting for the seller after the interview ended. */
export function awaitingSellerAfterInterview(
  d: Pick<Discrepancy, "status">,
  interviewCompleted: boolean | null | undefined,
): boolean {
  return d.status === "ask_seller" && !!interviewCompleted;
}

/**
 * The turn floor for a session. The first interview may not end on its own
 * before `configured` seller turns (completion governance). A session on a
 * deal whose interview is ALREADY complete — the seller answering the
 * broker's follow-up questions, or adding detail — is short by design: the
 * email promised "a short conversation", and a two-question follow-up held
 * open for ten turns would push the seller through new questions to leave.
 * The other end rules (critical coverage, open conflicts, the seller's stop)
 * still apply. Reopening the interview (interviewCompleted → false) restores
 * the floor.
 */
export function turnFloorFor(interviewAlreadyCompleted: boolean | null | undefined, configured: number): number {
  return interviewAlreadyCompleted ? 0 : configured;
}

/** Don't email the seller again for routings within this window. */
export const FOLLOWUP_EMAIL_WINDOW_MS = 60 * 60 * 1000;

/**
 * One email for a burst of routings: a follow-up email in the last hour
 * covers the new question — but only while the seller hasn't been back
 * since it. Once they came back (interview activity after that email, which
 * handed its questions back), a new routing is a new request and emails
 * again; otherwise it would reach nobody and the broker would be told it
 * was "added" to an email already acted on.
 */
export function shouldEmailFollowUp(
  recent: Array<{ type: string; createdAt: Date | string | null }>,
  now = Date.now(),
  sellerLastActiveAt?: Date | string | null,
): boolean {
  const back = sellerLastActiveAt ? new Date(sellerLastActiveAt).getTime() : null;
  return !recent.some((n) => {
    if (n.type !== "seller_followup_questions" || !n.createdAt) return false;
    const sent = new Date(n.createdAt).getTime();
    if (now - sent >= FOLLOWUP_EMAIL_WINDOW_MS) return false;
    return !(back != null && Number.isFinite(back) && back > sent);
  });
}

/** When the deal's interview last saw activity (any session), or null. */
async function lastInterviewActivity(dealId: string): Promise<Date | null> {
  const { db } = await import("../db");
  const { interviewSessions } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ dealId: interviewSessions.dealId, lastActivityAt: interviewSessions.lastActivityAt })
    .from(interviewSessions)
    .where(eq(interviewSessions.dealId, dealId));
  let latest: Date | null = null;
  for (const r of rows) {
    if (r.dealId !== dealId || !r.lastActivityAt) continue;
    const at = new Date(r.lastActivityAt);
    if (!latest || at > latest) latest = at;
  }
  return latest;
}

export interface FollowUpNotice {
  /** The interview was already finished — the seller has to come back for this. */
  interviewFinished: boolean;
  /** How many routed questions wait for the seller now. */
  waiting: number;
  /** Seller emails sent / addressed now (0 when recently emailed, a demo deal, or nobody to email). */
  emailed: number;
  addressed: number;
  /** Emailed within the last hour already — not sent again. */
  recentlyEmailed?: boolean;
  /** Addressed seller-team members who turned email notifications off (recorded, not emailed). */
  optedOut?: number;
}

/**
 * Called after a row is routed to the seller. When the interview is still
 * running, the interview raises it — nothing to do. Never throws.
 */
export async function notifySellerOfFollowUps(dealId: string, alsoSending: readonly string[] = []): Promise<FollowUpNotice> {
  const { storage } = await import("../storage");
  const { routedToSellerAt } = await import("@shared/discrepancy-gate");
  const deal = await storage.getDeal(dealId);
  if (!deal?.interviewCompleted) return { interviewFinished: false, waiting: 0, emailed: 0, addressed: 0 };
  // What the seller's page lists: routings under the follow-up rules, plus the
  // never-asked ones the broker is sending now (emailNeverAskedFollowUps).
  const waiting = (await storage.getDiscrepanciesByDeal(dealId))
    .filter((d) => d.status === "ask_seller" && (!!routedToSellerAt(d) || alsoSending.includes(d.id))).length;
  try {
    const recent = await storage.getNotificationsByDeal(dealId);
    const lastActive = await lastInterviewActivity(dealId).catch(() => null);
    if (!shouldEmailFollowUp(recent, Date.now(), lastActive)) return { interviewFinished: true, waiting, emailed: 0, addressed: 0, recentlyEmailed: true };
    const { notifySellerPortal } = await import("../notifications/service");
    const r = await notifySellerPortal(dealId, "seller_followup_questions", {
      title: `Your broker has ${waiting === 1 ? "a follow-up question" : "a few follow-up questions"} for you`,
      body:
        "Your broker went through what you shared and would like to check " +
        (waiting === 1 ? "one thing" : `${waiting} things`) +
        " with you. It's a short conversation that picks up where you left off — nothing you already answered is asked again.",
      path: "interview?followup=1",
      businessName: deal.businessName,
      metadata: { waiting },
    });
    return { interviewFinished: true, waiting, emailed: r.emailsSent, addressed: r.recipients, ...(r.optedOut ? { optedOut: r.optedOut } : {}) };
  } catch (err) {
    console.warn(`[followups] couldn't tell the seller about follow-up questions on deal ${dealId}:`, err);
    return { interviewFinished: true, waiting, emailed: 0, addressed: 0 };
  }
}

/**
 * The broker's "Email the seller" for questions routed before follow-up
 * emails existed (release review DEP-4): they were never put to the seller,
 * so they don't lock the CIM (discrepancy-gate.ts routedButNeverAsked).
 * Sends the follow-up link like a routing does now, and — once a seller was
 * addressed (or emailed in the last hour already) — stamps each row as routed,
 * so from then on a critical one locks the CIM until the seller answers.
 * With nobody to send to, nothing is stamped (the broker is told). Only ever
 * called from the broker's click. Never throws.
 */
export async function emailNeverAskedFollowUps(dealId: string): Promise<FollowUpNotice & { neverAsked: number; stamped: number }> {
  const { storage } = await import("../storage");
  const { routedButNeverAsked, withRoutedStamp } = await import("@shared/discrepancy-gate");
  const deal = await storage.getDeal(dealId);
  const rows = (await storage.getDiscrepanciesByDeal(dealId)).filter((d) => routedButNeverAsked(d, deal?.interviewCompleted));
  if (!deal || rows.length === 0) return { interviewFinished: !!deal?.interviewCompleted, waiting: 0, emailed: 0, addressed: 0, neverAsked: 0, stamped: 0 };
  const notice = await notifySellerOfFollowUps(dealId, rows.map((d) => d.id));
  if (notice.addressed === 0 && !notice.recentlyEmailed) return { ...notice, neverAsked: rows.length, stamped: 0 };
  const { updateDiscrepancyIfStill } = await import("../cim/discrepancy-cas");
  let stamped = 0;
  for (const d of rows) {
    try {
      if (await updateDiscrepancyIfStill(storage, d.id, ["ask_seller"], { sideSources: withRoutedStamp(d.sideSources) as any })) stamped++;
    } catch (err) {
      console.warn(`[followups] couldn't mark question ${d.id} as sent on deal ${dealId}:`, err);
    }
  }
  return { ...notice, neverAsked: rows.length, stamped };
}

/**
 * The broker's email when a follow-up session on a finished interview ends
 * and hands their routed questions back (seller_responded). Worded by what
 * the transcript shows: discussed, or ended before the question came up —
 * never "answered" for a question nobody raised. Pure.
 */
export function followUpsAnsweredNotice(r: { handedBack: number; discussed: number }, businessName: string): { title: string; body: string } {
  const n = r.handedBack;
  const all = r.discussed >= n;
  const noun = (k: number) => (k === 1 ? "follow-up question" : "follow-up questions");
  const title = r.discussed === 0
    ? `The seller ended the follow-up before your ${noun(n)} came up — ${businessName}`
    : all
      ? `The seller answered your ${noun(n)} — ${businessName}`
      : `The seller answered ${r.discussed} of your ${n} follow-up questions — ${businessName}`;
  const body =
    (r.discussed === 0
      ? `The seller came back but ended the conversation before ${n === 1 ? "it was" : "they were"} raised. `
      : all
        ? `The seller came back and went through ${n === 1 ? "the follow-up question" : `the ${n} follow-up questions`} you sent them. `
        : `The seller came back and went through ${r.discussed} of the ${n} follow-up questions you sent them. `) +
    "What they said is on the deal's Interview Review tab — resolve each conflict on the Overview to unlock the CIM.";
  return { title, body };
}

/**
 * A session on a finished interview ended and handed routed questions back
 * (seller_responded): the broker is told, since no "interview finished"
 * email goes out for a follow-up. Never throws.
 */
export async function notifyBrokerFollowUpsAnswered(dealId: string, r: { handedBack: number; discussed: number }): Promise<void> {
  if (r.handedBack <= 0) return;
  try {
    const { storage } = await import("../storage");
    const deal = await storage.getDeal(dealId);
    if (!deal) return;
    const { notify } = await import("../notifications/service");
    const { escapeHtml } = await import("../notifications/email-escape");
    const n = followUpsAnsweredNotice(r, deal.businessName);
    await notify(dealId, "seller_followups_answered", {
      title: n.title,
      body: escapeHtml(n.body),
      actionUrl: `/deal/${dealId}/overview`,
      businessName: deal.businessName,
      metadata: { handedBack: r.handedBack, discussed: r.discussed },
    });
  } catch (err) {
    console.warn(`[followups] couldn't tell the broker about the follow-up on deal ${dealId}:`, err);
  }
}
