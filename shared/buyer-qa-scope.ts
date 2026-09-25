/**
 * buyer-qa-scope — who may read a buyer Q&A answer.
 *
 * Every buyer_questions row records the scope of what fed its answer
 * (`answer_scope`), fixed at the moment it was answered:
 *   - "all"     drawn only from what EVERY buyer on the deal may see: the
 *               teaser-level Blind CIM, or an answer the broker/seller wrote
 *               and published on purpose.
 *   - "full"    drawn from the Blind CIM of a full-access buyer, which
 *               includes sections locked for teasers → readable by
 *               full-access buyers and above, never by teasers.
 *   - "private" drawn from the named CIM (LOI / due-diligence buyer) → only
 *               the buyer who asked.
 *
 * On top of the scope, a Blind reader (teaser / full) never receives a
 * question or answer that names anything identifying (shared/blind-guard.ts)
 * — whoever typed it. Pure: used by the chatbot route, the Q&A feed and
 * the view room.
 */
import { cimModeForAccessLevel } from "./cim-layouts";
import { findBlindLeaks, type BlindTerm } from "./blind-guard";

export type AnswerScope = "all" | "full" | "private";

const LEVEL_RANK: Record<string, number> = { teaser: 0, full: 1, loi: 2, due_diligence: 3 };
const rank = (level: string | null | undefined) => LEVEL_RANK[level ?? "teaser"] ?? 0;

/** The scope of an answer drawn from the CIM this access level receives. */
export function askerScope(accessLevel: string | null | undefined): AnswerScope {
  const mode = cimModeForAccessLevel(accessLevel);
  if (mode !== "blind") return "private";
  return rank(accessLevel) >= 1 ? "full" : "all";
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
  if (row.buyerAccessId && row.buyerAccessId === reader.id) return true;
  if (scope === "private") return false;
  if (scope === "full") return rank(reader.accessLevel) >= 1;
  return true;
}

/** Nothing in the question or answer names the business, a person, the city or street. */
export function qaTextIsBlindSafe(row: Pick<QaRowLike, "question" | "aiAnswer" | "publishedAnswer">, terms: BlindTerm[]): boolean {
  return findBlindLeaks([row.question, row.aiAnswer ?? "", row.publishedAnswer ?? ""], terms).length === 0;
}

/**
 * May `reader` see this row's question and answer? Their own questions
 * always; others' only within scope, and for a Blind reader only when the
 * text is identity-free.
 */
export function readerMaySeeRow(
  row: QaRowLike,
  scope: AnswerScope,
  reader: { id: string; accessLevel: string | null | undefined },
  blindTerms: BlindTerm[],
): boolean {
  if (row.buyerAccessId && row.buyerAccessId === reader.id) return true;
  if (!scopeAllows(scope, row, reader)) return false;
  if (cimModeForAccessLevel(reader.accessLevel) === "blind" && !qaTextIsBlindSafe(row, blindTerms)) return false;
  return true;
}
