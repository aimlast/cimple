/**
 * The deal's buyer pipeline (Buyers tab): four stages a buyer moves through,
 * in order, and the one cache refresh every stage change goes through so a
 * buyer who is granted access, submitted or approved moves stage at once.
 */
import type { QueryClient } from "@tanstack/react-query";

export const BUYER_STAGES = [
  {
    key: "find",
    step: 1,
    label: "Find new buyers",
    short: "Find",
    explain: "Companies and investors buying in this space who aren't in your contacts yet — found on the web, with sources.",
  },
  {
    key: "send",
    step: 2,
    label: "Send it to next",
    short: "Send next",
    explain: "People in your buyer list who don't have this CIM yet, best matches first. Cimple drafts the email — you review and send.",
  },
  {
    key: "approval",
    step: 3,
    label: "Waiting for approval",
    short: "Approval",
    explain: "Buyers you've put forward for sign-off — by you, then the seller — before they get the CIM.",
  },
  {
    key: "have",
    step: 4,
    label: "Have the CIM",
    short: "Have CIM",
    explain: "Buyers who can open the CIM: how well they fit, what they've decided and how much they've read.",
  },
] as const;

export type BuyerStage = (typeof BUYER_STAGES)[number]["key"];

export function isBuyerStage(v: string | null | undefined): v is BuyerStage {
  return !!v && BUYER_STAGES.some((s) => s.key === v);
}

/** Approval requests still in flight (stage 3). Granted ones are in stage 4; turned-down ones are listed apart. */
export const WAITING_APPROVAL_STATUSES = new Set([
  "pending_broker_review",
  "approved_by_broker",
  "pending_seller_review",
  "approved_by_seller",
]);

/** Where the Buyers tab opens when the URL doesn't say: buyers who have a live CIM first, else who to send it to. */
export function defaultBuyerStage(isLive: boolean, activeBuyerCount: number): BuyerStage {
  return isLive && activeBuyerCount > 0 ? "have" : "send";
}

/**
 * Buyers whose access was revoked and who haven't been given a new link
 * since — newest revoked row per email. Listed apart under "Have the CIM",
 * so a revoked buyer never simply disappears from the pipeline.
 */
export function revokedWithoutNewLink<T extends { id: string; buyerEmail?: string | null; revokedAt?: string | Date | null }>(rows: T[]): T[] {
  const norm = (r: T) => String(r.buyerEmail || r.id).trim().toLowerCase();
  const active = new Set(rows.filter((r) => !r.revokedAt).map(norm));
  const latest = new Map<string, T>();
  for (const r of rows) {
    if (!r.revokedAt || active.has(norm(r))) continue;
    const prev = latest.get(norm(r));
    if (!prev || new Date(r.revokedAt).getTime() > new Date(prev.revokedAt!).getTime()) latest.set(norm(r), r);
  }
  return Array.from(latest.values());
}

/** Refresh every list a buyer can move between (and the fit of those who have the CIM). */
export function invalidateBuyerPipeline(qc: QueryClient, dealId: string): void {
  qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "buyers"] });
  qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "buyer-fit"] });
  qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "suggested-buyers"] });
  qc.invalidateQueries({ queryKey: [`/api/deals/${dealId}/buyer-approvals`] });
  qc.invalidateQueries({ queryKey: ["analytics"] });
  // The reading cards (Have the CIM's Reading column, the Engagement tab).
  qc.invalidateQueries({ queryKey: ["engagement", dealId] });
  qc.invalidateQueries({ queryKey: ["engagement", "broker"] });
  qc.invalidateQueries({ queryKey: ["/api/broker/buyers"] });
}
