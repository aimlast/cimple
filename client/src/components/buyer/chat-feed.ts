/**
 * Pure helpers behind the buyer Q&A chat (BuyerChatbot): how the server's
 * question feed turns into chat history, and how a polled feed resolves
 * questions still waiting on the broker. No React, no imports — unit-tested
 * in tests/unit/buyer-chat-feed.test.ts.
 *
 * "Answered" is NOT the same as "published to the shared feed". The server
 * keeps some answers private to the buyer who asked (server/qa/cim-context.ts
 * buildBuyerQuestionFeed): answers drawn from the named CIM for LOI / DD
 * buyers, and blind-buyer answers whose question or answer names the
 * business. Those arrive as `isMine: true, status: "published",
 * isPublished: false` with the answer text — the asker must see them as
 * answered, never as "awaiting your broker".
 */

/**
 * One item of the buyer-facing Q&A feed (GET /api/view/:token →
 * publishedQuestions, GET /api/deals/:dealId/questions/published).
 * Whitelisted server shape — never the raw buyerQuestions row.
 */
export interface BuyerQuestionFeedItem {
  id: string;
  question: string;
  /** pending_ai | pending_broker | pending_seller | published | declined */
  status: string;
  /** Shared with this buyer through the Q&A feed (theirs or another buyer's) */
  isPublished: boolean;
  aiAnswer: string | null;
  publishedAnswer: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  /** True when this buyer asked the question */
  isMine: boolean;
}

export interface ChatMessage {
  id: string;
  role: "buyer" | "ai" | "system";
  content: string;
  status?: "published" | "pending_broker" | "pending_seller" | "answered" | "declined";
  /** Server-side question id — lets us pair an escalated question with its later answer */
  questionId?: string;
  /** Who asked a seeded question — other buyers' questions get a caption */
  origin?: "mine" | "other";
  timestamp: Date;
}

export const PENDING_TEXT = "Forwarded to your broker.";
export const DECLINED_TEXT = "Your broker wasn't able to answer this one.";

export function isPendingStatus(status: string | undefined): boolean {
  return status === "pending_broker" || status === "pending_seller" || status === "pending_ai";
}

/**
 * The answer this buyer may read for a feed item, or null when there is
 * none yet. Shared Q&A (isPublished) and the buyer's own answered question
 * (status "published", even when kept private to them) both count.
 */
export function answerForReader(q: BuyerQuestionFeedItem): string | null {
  const text = (q.publishedAnswer || q.aiAnswer || "").trim();
  if (!text) return null;
  if (q.isPublished) return q.publishedAnswer || q.aiAnswer || null;
  if (q.isMine && q.status === "published") return q.publishedAnswer || q.aiAnswer || null;
  return null;
}

/** Build the initial chat history (and the set of still-pending ids) from the feed. */
export function seedFromFeed(feed: BuyerQuestionFeedItem[], businessName: string) {
  const messages: ChatMessage[] = [{
    id: "welcome",
    role: "system",
    content: `Ask anything about ${businessName}. Answers come from the CIM; anything it doesn't cover goes to your broker.`,
    timestamp: new Date(),
  }];
  const pendingIds: string[] = [];

  for (const q of feed) {
    const asked = new Date(q.createdAt);
    const answer = answerForReader(q);
    if (answer !== null) {
      messages.push({
        id: `pq-${q.id}`,
        role: "buyer",
        content: q.question,
        status: "published",
        questionId: q.id,
        origin: q.isMine ? "mine" : "other",
        timestamp: asked,
      });
      messages.push({
        id: `pa-${q.id}`,
        role: "ai",
        content: answer,
        status: "published",
        questionId: q.id,
        timestamp: asked,
      });
      continue;
    }
    if (!q.isMine) continue;

    // The buyer's own unanswered question — keep it in the thread with its
    // waiting state so it doesn't silently vanish on reload.
    messages.push({
      id: `pq-${q.id}`,
      role: "buyer",
      content: q.question,
      questionId: q.id,
      origin: "mine",
      timestamp: asked,
    });
    const declined = q.status === "declined";
    messages.push({
      id: `ps-${q.id}`,
      role: "system",
      content: declined ? DECLINED_TEXT : PENDING_TEXT,
      status: declined ? "declined" : "pending_broker",
      questionId: q.id,
      timestamp: asked,
    });
    if (!declined) pendingIds.push(q.id);
  }

  return { messages, pendingIds };
}

/**
 * Apply a polled feed to the open chat: questions in `pendingIds` that now
 * have an answer the buyer may read are marked answered and their answer is
 * appended; declined ones say so. Returns null when nothing changed.
 */
export function resolvePolledFeed(
  feed: BuyerQuestionFeedItem[],
  pendingIds: string[],
  messages: ChatMessage[],
): { messages: ChatMessage[]; resolvedIds: string[]; answeredCount: number } | null {
  const answered = feed.filter(q => pendingIds.includes(q.id) && answerForReader(q) !== null);
  const declined = feed.filter(
    q => pendingIds.includes(q.id) && q.status === "declined" && !answered.some(a => a.id === q.id),
  );
  if (answered.length === 0 && declined.length === 0) return null;

  const next = messages.map(m => {
    // Only the waiting note changes; the buyer's own bubble stays as asked.
    if (!m.questionId || m.status === "published" || m.role !== "system") return m;
    if (answered.some(a => a.id === m.questionId)) return { ...m, status: "answered" as const };
    if (declined.some(d => d.id === m.questionId)) {
      return { ...m, status: "declined" as const, content: DECLINED_TEXT };
    }
    return m;
  });
  for (const a of answered) {
    if (next.some(m => m.id === `pa-${a.id}`)) continue;
    next.push({
      id: `pa-${a.id}`,
      role: "ai",
      content: answerForReader(a) || "",
      status: "published",
      questionId: a.id,
      timestamp: new Date(a.updatedAt || a.createdAt),
    });
  }
  return {
    messages: next,
    resolvedIds: [...answered, ...declined].map(q => q.id),
    answeredCount: answered.length,
  };
}
