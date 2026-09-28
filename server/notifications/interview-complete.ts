/**
 * "The seller finished their interview" — the email the deal's broker was
 * never sent (no interview_complete emitter existed). Sent once per finish:
 * when the deal's interviewCompleted flips from false to true, by the AI
 * closing the interview or the seller ending it. Not announced when the
 * broker was the one there: a broker-led ("interview together") session, or
 * a turn / end sent from the deal broker's own session (broker-mode
 * interview, "Preview seller view") — "the seller finished" would be false
 * and the broker already knows.
 */
import { storage } from "../storage";
import { notify } from "./service";

export function shouldAnnounceInterviewComplete(opts: {
  wasCompleted: boolean | null | undefined;
  conductedBy?: string | null;
  /** The finishing request came from the deal's own broker session. */
  byDealBroker?: boolean;
}): boolean {
  return !opts.wasCompleted && opts.conductedBy !== "broker_with_seller" && !opts.byDealBroker;
}

export async function notifyInterviewComplete(
  dealId: string,
  how: "ai_closed" | "seller_ended",
): Promise<void> {
  const deal = await storage.getDeal(dealId);
  if (!deal) return;
  const invites = await storage.getSellerInvitesByDealId(dealId).catch(() => []);
  const seller = invites.find((i) => i.sellerName)?.sellerName?.trim() || "The seller";
  await notify(dealId, "interview_complete", {
    title: `Seller interview finished — ${deal.businessName}`,
    body:
      (how === "seller_ended"
        ? `${seller} ended the AI interview.`
        : `${seller} finished the AI interview.`) +
      ` What they said is on the deal's Interview Review tab, and the facts are on the Information tab.`,
    actionUrl: `/deal/${dealId}/interview-review`,
    businessName: deal.businessName,
    metadata: { how },
  });
}
