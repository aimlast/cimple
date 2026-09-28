/**
 * Engagement intelligence — pure functions over DealReadingFacts
 * (shared/analytics-v2.ts). No I/O, no AI, no clock except `ctx.now`:
 * every rule is unit-testable. Owned by the INTELLIGENCE stream (signals,
 * talking points, status, call priority, headlines, journey moments,
 * benchmarks). The capture stream's routes call these; the signatures are
 * the contract. Base bodies are deliberately minimal (a status from the
 * decision and visits, no signals) so the API shapes are real from day one.
 *
 * Wording rules: seconds and minutes, never percent-of-max; suggestive,
 * never diagnostic ("Be ready to go through each add-back", never "they
 * are worried about the add-backs"); every talking point quotes its evidence.
 */
import {
  BUYER_STATUS_TEXT,
  READING_RULES,
  type BuyerInsight,
  type BuyerReadingFacts,
  type BuyerStatus,
  type DocumentPage,
  type FactPage,
  type KeyMoment,
  type ReachPoint,
  type VisitFacts,
} from "@shared/analytics-v2";

export interface InsightContext {
  now: Date;
  /** The document's viewer pages (real titles), in order. */
  pages: FactPage[];
  /** Every buyer in the current filter (for "3× the other readers" comparisons). */
  buyers: BuyerReadingFacts[];
}

/** Status, why, signals, talking points, intent and call priority for one buyer. */
export function buyerInsight(buyer: BuyerReadingFacts, ctx: InsightContext): BuyerInsight {
  const status = baseStatus(buyer, ctx.now);
  return {
    status,
    statusLabel: BUYER_STATUS_TEXT[status],
    why: status === "not_opened" ? "Hasn't opened the CIM yet." : "",
    signals: [],
    talkingPoints: [],
    intent: 0,
    priority: status === "not_opened" ? -1 : 0,
    pageLabels: {},
  };
}

function baseStatus(buyer: BuyerReadingFacts, now: Date): BuyerStatus {
  const last = buyer.visits.reduce<number>((m, v) => Math.max(m, Date.parse(v.lastSeenAt) || 0), 0);
  if (last && now.getTime() - last <= READING_RULES.readingNowMs) return "reading_now";
  if (buyer.decision === "interested") return "interested";
  if (buyer.decision === "not_interested") return "not_interested";
  if (buyer.decision === "lapsed") return "lapsed";
  return buyer.visits.length === 0 ? "not_opened" : "opened";
}

/** Buyers in call order (best lead first). */
export function rankBuyers(items: Array<{ facts: BuyerReadingFacts; insight: BuyerInsight }>): Array<{ facts: BuyerReadingFacts; insight: BuyerInsight }> {
  return [...items].sort((a, b) => b.insight.priority - a.insight.priority);
}

/** One sentence above a page in the Document view, or null when nothing notable. */
export function pageHeadline(_page: DocumentPage, _doc: { pages: DocumentPage[]; openedBy: number }): string | null {
  return null;
}

/** "Most buyers stopped around page 14 · Employees & Management (9 → 4 readers)", or null. */
export function reachHeadline(_reach: ReachPoint[]): string | null {
  return null;
}

/** Deterministic key moments of one visit ("Went straight to Financials after the cover"). */
export function journeyMoments(_visit: VisitFacts, _buyer: BuyerReadingFacts, _ctx: InsightContext): KeyMoment[] {
  return [];
}

/** "9 of 13 buyers have opened the CIM · 4 read it this week · 2 reading now" */
export function pulseSentence(p: { granted: number; opened: number; readThisWeek: number; readingNow: number }): string {
  if (p.granted === 0) return "No buyers have been given access yet.";
  const parts = [`${p.opened} of ${p.granted} buyer${p.granted === 1 ? " has" : "s have"} opened the CIM`];
  if (p.readThisWeek > 0) parts.push(`${p.readThisWeek} read it this week`);
  if (p.readingNow > 0) parts.push(`${p.readingNow} reading now`);
  return parts.join(" · ");
}
