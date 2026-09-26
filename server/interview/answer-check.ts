/**
 * answer-check — does a passage (or an earlier exchange) ALREADY answer the
 * question the interviewer is about to ask?
 *
 * The re-ask guard finds candidates mechanically: a source passage sharing
 * the question's words, or an earlier question worded much like this one.
 * Word overlap alone is a poor judge — replaying every question the seeded
 * interviews actually asked, a third of them "matched" a passage that only
 * mentioned the topic (a lease clause about repairs for "how many dock
 * doors?", a customer-list row for "who supplies your resin?"), and each such
 * match forced a rewrite with a misleading quote. So a candidate only stops a
 * question once the supporting model confirms that the passage states the
 * very thing asked. One short call (tool-forced JSON), only on turns with a
 * candidate; a failure or a slow answer confirms nothing (the question goes
 * out — the prompt's own ALREADY ANSWERED rules still apply).
 */
import Anthropic from "@anthropic-ai/sdk";
import { agentConfig } from "./config/load-config";

export interface AnswerCandidate {
  id: string;
  /** "a passage from <source>: «…»" or "asked in session 1: … — the seller answered: …" */
  text: string;
}

/** Returns the ids of candidates that answer the question; null when it couldn't decide (in time). */
export type AnswerVerifier = (question: string, candidates: AnswerCandidate[], timeoutMs?: number) => Promise<Set<string> | null>;

// Short on purpose: the seller is waiting on this call, and its time is
// almost all output — one line for what the question mainly asks, then just
// the ids that already answer it (a per-item reason tripled the latency).
const CHECK_TOOL = {
  name: "answer_check",
  description: "Say which items already answer the question.",
  input_schema: {
    type: "object" as const,
    required: ["mainAsk", "answeredBy"],
    properties: {
      mainAsk: { type: "string", description: "What the question mainly asks, in at most 12 words." },
      answeredBy: {
        type: "array",
        items: { type: "string" },
        description: "The ids of the items that already state that main thing (empty when none does).",
      },
    },
  },
};

/**
 * How long a check may take before the question goes out on the mechanical
 * verdict alone (strong matches stand, weak candidates don't). 8s was too
 * little once three or four interviews ran at once — the check timed out on
 * a fifth of turns in the round-V live run; a streamed message passes its own.
 */
const CHECK_TIMEOUT_MS = 15_000;

let client: Anthropic | null = null;

export const modelAnswerVerifier: AnswerVerifier = async (question, candidates, timeoutMs = CHECK_TIMEOUT_MS) => {
  if (candidates.length === 0) return new Set();
  // One retry at most (an overloaded 529 is retried once, quickly) — the
  // seller is waiting, and a check past its budget is worth nothing.
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });
  const call = client.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 300,
    temperature: 0,
    tools: [CHECK_TOOL],
    tool_choice: { type: "tool", name: "answer_check" },
    system:
      "An interviewer is about to ask a business owner a question. For each item — a fact already on file, a passage from the deal's own files (often the owner's own words on a call), an earlier question the owner answered, or something the interviewer itself already told the owner — decide whether it ALREADY answers the main thing the question asks, so that asking would make the owner repeat themselves (or tell the interviewer what the interviewer just told them). " +
      "An item answers it when it states that main thing — the status, the figure, the count, the share, the name, the yes/no, the terms, the plan, the reason — even if the question words it differently or also asks for a small extra detail (the interviewer can cite the item and ask just for that). " +
      "It does not when it merely mentions the same topic, answers a different question about it, is itself a question, or when the question asks what has changed since the item or goes clearly deeper than it. " +
      "An earlier question the owner answered only in part: if the question now asks for the part the owner did NOT answer (the renewal options after they gave only the years left), it does not answer it — following up on the missing half is not a re-ask. " +
      "The same matter can carry different figures at different stages (the amount claimed vs the amount settled, an estimate vs the actual) — that alone doesn't make it a different matter. " +
      "Return the ids of the items that already answer it (an empty list when none does).",
    messages: [
      {
        role: "user",
        content: `QUESTION: ${question}\n\nITEMS:\n${candidates.map((c) => `[${c.id}] ${c.text}`).join("\n\n")}`,
      },
    ],
  }, { timeout: timeoutMs + 2_000 });
  call.catch(() => {}); // a late failure after the timeout is not an unhandled rejection
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  try {
    const res = await Promise.race([call, timeout]);
    if (!res) {
      console.warn("[answer-check] timed out — nothing confirmed");
      return null;
    }
    const block = res.content.find((b) => b.type === "tool_use");
    const answeredBy = ((block && block.type === "tool_use" ? block.input : {}) as { answeredBy?: unknown }).answeredBy;
    if (!Array.isArray(answeredBy)) return null;
    // (Ids may come back as numbers, or as "[1]".)
    return new Set(
      answeredBy
        .filter((id) => typeof id === "string" || typeof id === "number")
        .map((id) => String(id).replace(/^\[|\]$/g, "").trim()),
    );
  } catch (err: any) {
    console.warn("[answer-check] failed — nothing confirmed:", err?.message || err);
    return null;
  }
};
