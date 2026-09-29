/**
 * question-answer — how a buyer's view-room question is answered.
 *
 *   1. A published answer this buyer may read already covers it → reuse it.
 *   2. The CIM the buyer can see answers it → answer from the CIM.
 *   3. Otherwise → escalate to the broker ("Forwarded to your broker").
 *
 * Every AI step fails soft. An AI failure (credits out, a 529 after the
 * SDK's retries, a timeout) used to throw the buyer's question away with a
 * 500 — before it was saved or the broker told — although escalating to the
 * broker is exactly the chatbot's designed fallback. Now a failed similarity
 * check skips to step 2, and a failed CIM answer escalates.
 */

/** One model call: system + user in, the text answer out. Throws on an API error. */
export type AskModel = (req: { system: string; user: string; maxTokens: number }) => Promise<string>;

export interface PublishedQa {
  id: string;
  question: string;
  publishedAnswer?: string | null;
  aiAnswer?: string | null;
}

export type BuyerAnswer =
  | { kind: "knowledge_base"; answer: string; matchedId: string | null }
  | { kind: "cim"; answer: string }
  | { kind: "escalate"; reason: "not_in_cim" | "no_cim" | "ai_unavailable" };

const SIMILARITY_SYSTEM = `You are a Q&A similarity matcher for a business CIM. Given a buyer's question and a knowledge base of previously answered questions, determine if any existing answer adequately addresses the new question.

If an existing answer covers the question (even if worded differently), respond with:
MATCH: <the existing answer, optionally rephrased to directly address the new question>

If no existing answer covers it, respond with exactly: NO_MATCH`;

const CIM_SYSTEM = `You are answering buyer questions about a business for sale based strictly on the CIM document provided.
If the answer is clearly in the CIM, answer concisely and professionally.
If the answer is NOT in the CIM, respond with exactly: ESCALATE
Do not speculate or add information not in the CIM.`;

export async function answerBuyerQuestion(opts: {
  question: string;
  /** Published answers THIS buyer may read (scope + identity already checked). */
  published: PublishedQa[];
  /** The text of the CIM the buyer can see (loaded only when step 1 finds nothing). */
  loadCimText: () => Promise<string>;
  ask: AskModel;
  log?: (msg: string, err?: unknown) => void;
}): Promise<BuyerAnswer> {
  const { question, published, ask } = opts;
  const log = opts.log ?? ((msg, err) => console.warn(msg, (err as Error)?.message ?? err ?? ""));

  // ── Step 1: an existing answer ─────────────────────────────────────────
  if (published.length > 0) {
    const kbContext = published.map((q) => `Q: ${q.question}\nA: ${q.publishedAnswer || q.aiAnswer}`).join("\n\n");
    try {
      const matchText = await ask({ system: SIMILARITY_SYSTEM, user: `KNOWLEDGE BASE:\n${kbContext}\n\nNEW QUESTION: ${question}`, maxTokens: 600 });
      if (matchText.startsWith("MATCH:")) {
        const answer = matchText.slice(6).trim();
        if (answer) {
          const matched = published.find((q) => answer.includes((q.publishedAnswer || q.aiAnswer)?.slice(0, 50) || "___none___"));
          return { kind: "knowledge_base", answer, matchedId: matched?.id ?? null };
        }
      }
    } catch (err) {
      // The CIM may still answer it.
      log("[buyer-qa] similarity check failed — trying the CIM:", err);
    }
  }

  // ── Step 2: the CIM the buyer can see ──────────────────────────────────
  const cimText = await opts.loadCimText();
  if (!cimText.trim()) return { kind: "escalate", reason: "no_cim" };
  let aiAnswer: string;
  try {
    aiAnswer = await ask({ system: CIM_SYSTEM, user: `CIM CONTENT:\n${cimText}\n\nBUYER QUESTION: ${question}`, maxTokens: 500 });
  } catch (err) {
    log("[buyer-qa] CIM answer failed — forwarding to the broker:", err);
    return { kind: "escalate", reason: "ai_unavailable" };
  }
  // The model sometimes writes "ESCALATE" and then explains — still an escalation.
  if (!aiAnswer.trim() || /^\s*ESCALATE\b/.test(aiAnswer)) return { kind: "escalate", reason: "not_in_cim" };
  return { kind: "cim", answer: aiAnswer };
}
