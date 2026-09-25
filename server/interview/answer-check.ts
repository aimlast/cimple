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

const CHECK_TOOL = {
  name: "answer_check",
  description: "Say, for each item, whether it already answers the question.",
  input_schema: {
    type: "object" as const,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "reason", "answers"],
          properties: {
            id: { type: "string" },
            reason: { type: "string", description: "One short sentence: what the question mainly asks, and whether the item states it." },
            answers: { type: "boolean", description: "True when the item states the main thing the question asks." },
          },
        },
      },
    },
  },
};

/** How long a check may take before the question goes out unchecked (callers holding a streamed message pass less). */
const CHECK_TIMEOUT_MS = 8_000;

let client: Anthropic | null = null;

export const modelAnswerVerifier: AnswerVerifier = async (question, candidates, timeoutMs = CHECK_TIMEOUT_MS) => {
  if (candidates.length === 0) return new Set();
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const call = client.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 600,
    temperature: 0,
    tools: [CHECK_TOOL],
    tool_choice: { type: "tool", name: "answer_check" },
    system:
      "An interviewer is about to ask a business owner a question. For each item (a passage from the deal's own files — often the owner's own words on a call — or an earlier question the owner answered), decide whether it ALREADY answers the main thing the question asks, so that asking would make the owner repeat themselves. " +
      "Answer true when the item states that main thing — the status, the figure, the name, the yes/no, the arrangement, the reason — even if the question words it differently or also asks for a small extra detail (the interviewer can cite the item and ask just for that). " +
      "Answer false when the item merely mentions the same topic, answers a different question about it, is itself a question, or when the question asks what has changed since the item or goes clearly deeper than it. " +
      "The same matter can carry different figures at different stages (the amount claimed vs the amount settled, an estimate vs the actual) — that alone doesn't make it a different matter.",
    messages: [
      {
        role: "user",
        content: `QUESTION: ${question}\n\nITEMS:\n${candidates.map((c) => `[${c.id}] ${c.text}`).join("\n\n")}`,
      },
    ],
  });
  call.catch(() => {}); // a late failure after the timeout is not an unhandled rejection
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  try {
    const res = await Promise.race([call, timeout]);
    if (!res) {
      console.warn("[answer-check] timed out — nothing confirmed");
      return null;
    }
    const block = res.content.find((b) => b.type === "tool_use");
    const results = ((block && block.type === "tool_use" ? block.input : {}) as { results?: { id?: unknown; answers?: unknown }[] }).results;
    if (!Array.isArray(results)) return null;
    // (Ids may come back as numbers, or as "[1]".)
    return new Set(
      results
        .filter((r) => r && r.answers === true && (typeof r.id === "string" || typeof r.id === "number"))
        .map((r) => String(r.id).replace(/^\[|\]$/g, "").trim()),
    );
  } catch (err: any) {
    console.warn("[answer-check] failed — nothing confirmed:", err?.message || err);
    return null;
  }
};
