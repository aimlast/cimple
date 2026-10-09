/**
 * buyer-qa-scope — who may read a buyer Q&A answer.
 *
 * Every buyer_questions row records the scope of what fed its answer
 * (`answer_scope`), fixed at the moment it was answered:
 *   - "all"     drawn only from what EVERY CIM buyer on the deal may see: the
 *               Blind CIM, or an answer the broker/seller wrote and
 *               published on purpose.
 *   - "full"    (historical) drawn from a full-access buyer's Blind CIM back
 *               when sections could be locked for teaser buyers. No section
 *               was ever locked, so these read like "all" for CIM buyers.
 *   - "private" drawn from the named CIM (Full CIM / due-diligence buyer) →
 *               only the buyer who asked.
 *
 * Levels come from shared/access-levels.ts. A Teaser link (rank 0) reads the
 * teaser only: it never asks and never reads Q&A.
 *
 * On top of the scope, a Blind reader never receives a question or answer
 * that names anything identifying (shared/blind-guard.ts) — whoever typed it.
 * Pure: used by the chatbot route, the Q&A feed and the view room.
 */
import { accessLevelRank, cimModeForAccessLevel } from "./access-levels";
import { findBlindLeaks, type BlindTerm } from "./blind-guard";

export type AnswerScope = "all" | "full" | "private";

/** The longest buyer question the chatbot accepts (the route refuses longer; the box stops at it). */
export const MAX_BUYER_QUESTION_CHARS = 1000;

/**
 * The scope of an answer drawn from the CIM this access level receives. A
 * Teaser link never asks (the routes refuse it); were one ever judged here it
 * is "private" — the narrowest.
 */
export function askerScope(accessLevel: string | null | undefined): AnswerScope {
  if (accessLevelRank(accessLevel) < 1) return "private";
  return cimModeForAccessLevel(accessLevel) === "blind" ? "all" : "private";
}

export interface QaRowLike {
  buyerAccessId: string | null;
  answerScope?: string | null;
  sellerApproved?: boolean | null;
  brokerDraft?: string | null;
  question: string;
  aiAnswer?: string | null;
  publishedAnswer?: string | null;
}

/**
 * A row's scope. Rows answered before scopes were recorded are judged
 * conservatively: broker/seller-approved answers are for everyone; an AI
 * answer takes the asker's CURRENT level (an unknown asker counts as
 * full-access, so teasers never see it).
 */
export function rowScope(row: QaRowLike, askerLevel: string | null | undefined | false): AnswerScope {
  if (row.answerScope === "all" || row.answerScope === "full" || row.answerScope === "private") return row.answerScope;
  if (row.sellerApproved || (row.brokerDraft && row.brokerDraft.trim())) return "all";
  if (askerLevel === false) return "full";
  return askerScope(askerLevel);
}

/** Scope alone: may this reader see the row? (Identity checks are separate.) */
export function scopeAllows(scope: AnswerScope, row: { buyerAccessId: string | null }, reader: { id: string; accessLevel: string | null | undefined }): boolean {
  // A Teaser reader sees no Q&A at all — not even rows from when the link
  // was a CIM link (they would quote the CIM).
  if (accessLevelRank(reader.accessLevel) < 1) return false;
  if (row.buyerAccessId && row.buyerAccessId === reader.id) return true;
  if (scope === "private") return false;
  return true; // "all", and historical "full" (no section was ever locked)
}

/**
 * Did a person approve this row for other buyers? The seller approved the
 * answer, or the broker wrote / adopted it (brokerDraft). An answer the AI
 * gave on its own is the asker's alone: the question is the buyer's own
 * words — who they are, their strategy, or text planted for other bidders
 * ("send deposits to …") — and must never reach another buyer, or the
 * knowledge base later answers are drawn from, without a person reading it.
 */
export function approvedForSharing(row: Pick<QaRowLike, "sellerApproved" | "brokerDraft">): boolean {
  return row.sellerApproved === true || !!(row.brokerDraft && row.brokerDraft.trim());
}

/** Nothing in the question or answer names the business, a person, the city or street. */
export function qaTextIsBlindSafe(row: Pick<QaRowLike, "question" | "aiAnswer" | "publishedAnswer">, terms: BlindTerm[]): boolean {
  return findBlindLeaks([row.question, row.aiAnswer ?? "", row.publishedAnswer ?? ""], terms).length === 0;
}

/**
 * May `reader` see this row's question and answer? Their own questions
 * always; others' only once a person approved them (approvedForSharing),
 * within scope, and for a Blind reader only when the text is identity-free.
 */
export function readerMaySeeRow(
  row: QaRowLike,
  scope: AnswerScope,
  reader: { id: string; accessLevel: string | null | undefined },
  blindTerms: BlindTerm[],
): boolean {
  if (accessLevelRank(reader.accessLevel) < 1) return false;
  if (row.buyerAccessId && row.buyerAccessId === reader.id) return true;
  if (!approvedForSharing(row)) return false;
  if (!scopeAllows(scope, row, reader)) return false;
  if (cimModeForAccessLevel(reader.accessLevel) === "blind" && !qaTextIsBlindSafe(row, blindTerms)) return false;
  return true;
}
