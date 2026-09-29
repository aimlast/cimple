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
import { escapeHtml } from "./email-escape";
import { openInterviewItems } from "@shared/seller-portal";

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
  const open = openInterviewItems(await storage.getTasksByDeal(dealId).catch(() => []));
  await notify(dealId, "interview_complete", {
    title: `Seller interview finished — ${deal.businessName}`,
    body:
      escapeHtml(
        (how === "seller_ended"
          ? `${seller} ended the AI interview.`
          : `${seller} finished the AI interview.`) +
        ` What they said is on the deal's Interview Review tab, and the facts are on the Information tab.`,
      ) + openItemsHtml(open),
    actionUrl: `/deal/${dealId}/interview-review`,
    businessName: deal.businessName,
    metadata: { how, openItems: open.length },
  });
}

const ITEM_KIND: Record<string, string> = {
  document_request: "Document",
  follow_up: "Follow up",
  skipped_question: "Not answered",
};

/**
 * The interview's open to-dos (documents it asked for, things to follow
 * up, questions it couldn't cover) — the interview promised the seller
 * they would be noted "so they don't get lost". Plain text, escaped.
 */
export function openItemsHtml(items: Array<{ type: string; title: string }>, max = 10): string {
  if (items.length === 0) return "";
  const lines = items.slice(0, max).map((t) => `• ${escapeHtml(ITEM_KIND[t.type] ?? "To do")}: ${escapeHtml(t.title)}`);
  const more = items.length > max ? `<br>…and ${items.length - max} more on the deal's Interview Review tab.` : "";
  return `<br><br><strong>Open items from the interview (${items.length}):</strong><br>${lines.join("<br>")}${more}`;
}
