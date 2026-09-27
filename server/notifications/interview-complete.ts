/**
 * "The seller finished their interview" — the email the deal's broker was
 * never sent (no interview_complete emitter existed). Sent once per finish:
 * when the deal's interviewCompleted flips from false to true, by the AI
 * closing the interview or the seller ending it. A broker-led ("interview
 * together") session isn't announced — the broker was in it.
 */
import { storage } from "../storage";
import { notify } from "./service";

export function shouldAnnounceInterviewComplete(opts: {
  wasCompleted: boolean | null | undefined;
  conductedBy?: string | null;
}): boolean {
  return !opts.wasCompleted && opts.conductedBy !== "broker_with_seller";
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
