/**
 * The deal's buyer pipeline (Buyers tab): five stages a buyer moves through,
 * in order, and the one cache refresh every stage change goes through so a
 * buyer who is granted access, submitted or approved moves stage at once.
 *
 *   1 find      Find new buyers
 *   2 send      Send it to next
 *   3 teaser    Have the teaser      (new, October 2026)
 *   4 approval  Waiting for approval
 *   5 have      Have the CIM
 * The keys never change, so old ?stage= links keep working.
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
    explain: "People in your buyer list who don't have this deal yet, best matches first. Cimple drafts the email — you review and send.",
  },
  {
    key: "teaser",
    step: 3,
    label: "Have the teaser",
    short: "Teaser",
    explain: "Buyers who have the anonymous summary: who opened it, how far they read, and who asked for the CIM.",
  },
  {
    key: "approval",
    step: 4,
    label: "Waiting for approval",
    short: "Approval",
    explain: "Buyers asking for the CIM and buyers you've put forward — you decide, the seller can sign off too.",
  },
  {
    key: "have",
    step: 5,
    label: "Have the CIM",
    short: "Have CIM",
    explain: "Buyers who can open the CIM: how well they fit, what they've decided and how much they've read.",
  },
] as const;

export type BuyerStage = (typeof BUYER_STAGES)[number]["key"];

export function isBuyerStage(v: string | null | undefined): v is BuyerStage {
  return !!v && BUYER_STAGES.some((s) => s.key === v);
}

/**
 * Approval requests still in flight (stage 4), including access the broker
 * gave while the CIM isn't live yet (approved_waiting_publish). Granted ones
 * are in stage 5; turned-down ones are listed apart.
 */
export const WAITING_APPROVAL_STATUSES = new Set([
  "pending_broker_review",
  "approved_by_broker",
  "pending_seller_review",
  "approved_by_seller",
  "approved_waiting_publish",
]);

/**
 * Where the Buyers tab opens when the URL doesn't say: Have the CIM when the
 * CIM is live with buyers; else Have the teaser when anyone has the teaser;
 * else who to send it to.
 */
export function defaultBuyerStage(isLive: boolean, activeBuyerCount: number, teaserLinkCount = 0): BuyerStage {
  if (isLive && activeBuyerCount > 0) return "have";
  if (teaserLinkCount > 0) return "teaser";
  return "send";
}

/**
 * The teaser stage's sub-line on the strip — the most urgent one:
 * "1 asked for a new link" › "1 worth a call" › "2 opened today".
 */
export function teaserStageSubline(counts: { openedToday: number; worthACall: number; freshLinkRequests: number } | null | undefined): string | null {
  if (!counts) return null;
  if (counts.freshLinkRequests > 0) return `${counts.freshLinkRequests} asked for a new link`;
  if (counts.worthACall > 0) return `${counts.worthACall} worth a call`;
  if (counts.openedToday > 0) return `${counts.openedToday} opened today`;
  return null;
}

/** The approval stage's sub-line: "2 asked from the teaser". */
export function approvalStageSubline(requests: Array<{ status: string; source?: string | null }> | null | undefined): string | null {
  const n = (requests ?? []).filter((r) => WAITING_APPROVAL_STATUSES.has(r.status) && r.source === "teaser_request").length;
  return n > 0 ? `${n} asked from the teaser` : null;
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
  qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "analytics/buyer-scores"] });
  // The reading cards (Have the CIM's Reading column, the Engagement tab).
  qc.invalidateQueries({ queryKey: ["engagement", dealId] });
  qc.invalidateQueries({ queryKey: ["engagement", "broker"] });
  qc.invalidateQueries({ queryKey: ["/api/broker/buyers"] });
  // The teaser's light summary (counts on the strip) and who has the teaser — never the full teaser state.
  qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "teaser", "summary"] });
  qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "teaser", "engagement"] });
}
