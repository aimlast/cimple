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
 *   - "room"    a question about a data-room document whose answer the broker
 *               chose to show to everyone who can open that document (vdr
 *               spec §9.9). Fail-closed here: only the asker passes
 *               scopeAllows; server/qa/cim-context.ts publishedQuestionsFor
 *               admits other readers only while the document is visible to
 *               them. A data-room question is never "all".
 *
 * On top of the scope, a Blind reader (teaser / full) never receives a
 * question or answer that names anything identifying (shared/blind-guard.ts)
 * — whoever typed it. Pure: used by the chatbot route, the Q&A feed and
 * the view room.
 */
import { cimModeForAccessLevel } from "./cim-layouts";
import { findBlindLeaks, type BlindTerm } from "./blind-guard";

export type AnswerScope = "all" | "full" | "private" | "room";

/** The longest buyer question the chatbot accepts (the route refuses longer; the box stops at it). */
export const MAX_BUYER_QUESTION_CHARS = 1000;

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
  /** Asked about a data-room document (vdr). */
  vdrItemId?: string | null;
}

/**
 * A row's scope. Rows answered before scopes were recorded are judged
 * conservatively: broker/seller-approved answers are for everyone; an AI
 * answer takes the asker's CURRENT level (an unknown asker counts as
 * full-access, so teasers never see it).
 */
export function rowScope(row: QaRowLike, askerLevel: string | null | undefined | false): AnswerScope {
  // A data-room question is never for everyone, whatever else the row says.
  if (row.vdrItemId) return row.answerScope === "room" ? "room" : "private";
  if (row.answerScope === "all" || row.answerScope === "full" || row.answerScope === "private") return row.answerScope;
  if (row.sellerApproved || (row.brokerDraft && row.brokerDraft.trim())) return "all";
  if (askerLevel === false) return "full";
  return askerScope(askerLevel);
}

/** Scope alone: may this reader see the row? (Identity checks are separate.) */
export function scopeAllows(scope: AnswerScope, row: { buyerAccessId: string | null }, reader: { id: string; accessLevel: string | null | undefined }): boolean {
  if (row.buyerAccessId && row.buyerAccessId === reader.id) return true;
  if (scope === "private" || scope === "room") return false;
  if (scope === "full") return rank(reader.accessLevel) >= 1;
  return true;
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
  if (row.buyerAccessId && row.buyerAccessId === reader.id) return true;
  if (!approvedForSharing(row)) return false;
  if (!scopeAllows(scope, row, reader)) return false;
  if (cimModeForAccessLevel(reader.accessLevel) === "blind" && !qaTextIsBlindSafe(row, blindTerms)) return false;
  return true;
}

/**
 * The scope a data-room question's answer gets when the broker publishes it
 * or the seller approves it (vdr spec §9.9): "room" only when the broker
 * asked to show it to the document's other readers, else "private" — never
 * "all". `share` is the request body's shareWithDocumentReaders (undefined =
 * keep what the row has).
 */
export function vdrAnswerScope(current: string | null | undefined, share: boolean | undefined): "room" | "private" {
  if (share === true) return "room";
  if (share === false) return "private";
  return current === "room" ? "room" : "private";
}

/**
 * What a seller approval writes (both approval routes): a data-room
 * question keeps the scope the broker chose ("private" / "room") and feeds
 * the knowledge base only when shown to the document's readers; any other
 * question is published for everyone (unchanged behaviour).
 */
export function approvalScope(row: { vdrItemId?: string | null; answerScope?: string | null }): { answerScope: AnswerScope; addedToKnowledgeBase: boolean } {
  if (row.vdrItemId) {
    const scope = row.answerScope === "room" ? "room" : "private";
    return { answerScope: scope, addedToKnowledgeBase: scope === "room" };
  }
  return { answerScope: "all", addedToKnowledgeBase: true };
}

/**
 * Data-room answers another reader may see (§9.9): published, approved by a
 * person, scope "room", not the reader's own (those pass anyway), and about a
 * document this reader can open right now. Pure; the caller supplies the
 * open item ids (computed once per call).
 */
export function roomRowsFor<T extends QaRowLike & { isPublished?: boolean | null }>(rows: ReadonlyArray<T>, readerId: string, openItemIds: ReadonlySet<string>): T[] {
  return rows.filter((q) =>
    !!q.vdrItemId && !!q.isPublished && !!(q.publishedAnswer || q.aiAnswer) && rowScope(q, false) === "room" &&
    !(q.buyerAccessId && q.buyerAccessId === readerId) && approvedForSharing(q) && openItemIds.has(q.vdrItemId));
}
