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

/** Don't email the seller again for routings within this window. */
export const FOLLOWUP_EMAIL_WINDOW_MS = 60 * 60 * 1000;

export function shouldEmailFollowUp(
  recent: Array<{ type: string; createdAt: Date | string | null }>,
  now = Date.now(),
): boolean {
  return !recent.some(
    (n) => n.type === "seller_followup_questions" && n.createdAt && now - new Date(n.createdAt).getTime() < FOLLOWUP_EMAIL_WINDOW_MS,
  );
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
}

/**
 * Called after a row is routed to the seller. When the interview is still
 * running, the interview raises it — nothing to do. Never throws.
 */
export async function notifySellerOfFollowUps(dealId: string): Promise<FollowUpNotice> {
  const { storage } = await import("../storage");
  const deal = await storage.getDeal(dealId);
  if (!deal?.interviewCompleted) return { interviewFinished: false, waiting: 0, emailed: 0, addressed: 0 };
  const waiting = (await storage.getDiscrepanciesByDeal(dealId)).filter((d) => d.status === "ask_seller").length;
  try {
    const recent = await storage.getNotificationsByDeal(dealId);
    if (!shouldEmailFollowUp(recent)) return { interviewFinished: true, waiting, emailed: 0, addressed: 0, recentlyEmailed: true };
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
    return { interviewFinished: true, waiting, emailed: r.emailsSent, addressed: r.recipients };
  } catch (err) {
    console.warn(`[followups] couldn't tell the seller about follow-up questions on deal ${dealId}:`, err);
    return { interviewFinished: true, waiting, emailed: 0, addressed: 0 };
  }
}
