import type Anthropic from "@anthropic-ai/sdk";
import { INTERVIEW_RESPONSE_TOOL, type InterviewResponse, type ExtractedField } from "./response-schema";
import type { SystemBlock } from "./system-prompt";

/**
 * turn-guard
 *
 * Two safety layers around the interview model that used to be left entirely
 * to chance:
 *
 * 1. OUTPUT RECOVERY — the turn loop previously threw on any malformed or
 *    truncated tool response, dead-ending the seller with a generic error
 *    (and re-sending replayed the same failure). Every model call now goes
 *    through callInterviewWithRecovery: responses are validated/normalised,
 *    a truncated or invalid response triggers one corrective retry, and if
 *    that also fails the seller gets a graceful in-conversation recovery
 *    message instead of a 500.
 *
 * 2. COMPLETION GOVERNANCE — shouldEnd was 100% model discretion, so the
 *    interview could end on turn 2 with most sections missing. The config's
 *    minTurnsBeforeEnd existed but was never read. governCompletion enforces
 *    the floor and blocks endings while critical CIM sections are still
 *    missing — unless the seller explicitly asked to stop, which always wins.
 */

// =====================
// Response normalisation
// =====================

const CONFIDENCE_VALUES = new Set(["confirmed", "inferred", "approximate"]);
const SOURCE_VALUES = new Set(["seller_statement", "document", "questionnaire"]);
const TASK_TYPES = new Set(["document_request", "follow_up", "skipped_question"]);

/**
 * Coerces a raw tool_use input into a structurally sound InterviewResponse.
 * Missing/wrong-typed parts are replaced with safe defaults; invalid
 * extractedFields entries and tasks are dropped rather than crashing the turn.
 * `valid` is false when the response is unusable (no conversational message).
 */
export function normalizeInterviewResponse(raw: unknown): {
  response: InterviewResponse;
  valid: boolean;
} {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const message = typeof r.message === "string" ? r.message.trim() : "";

  const suggestedAnswers = Array.isArray(r.suggestedAnswers)
    ? r.suggestedAnswers.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];

  const extractedFields: Record<string, ExtractedField> = {};
  if (r.extractedFields && typeof r.extractedFields === "object" && !Array.isArray(r.extractedFields)) {
    for (const [key, val] of Object.entries(r.extractedFields as Record<string, unknown>)) {
      if (!val || typeof val !== "object") continue;
      const f = val as Record<string, unknown>;
      if (typeof f.value !== "string" || f.value.trim() === "") continue;
      extractedFields[key] = {
        value: f.value,
        confidence: CONFIDENCE_VALUES.has(f.confidence as string)
          ? (f.confidence as ExtractedField["confidence"])
          : "approximate",
        source: SOURCE_VALUES.has(f.source as string)
          ? (f.source as ExtractedField["source"])
          : "seller_statement",
      };
    }
  }

  const rawReasoning = (r.reasoning && typeof r.reasoning === "object" ? r.reasoning : {}) as Record<string, unknown>;
  const rawIc = (rawReasoning.industryContext && typeof rawReasoning.industryContext === "object"
    ? rawReasoning.industryContext
    : {}) as Record<string, unknown>;
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

  const reasoning: InterviewResponse["reasoning"] = {
    currentTopic: typeof rawReasoning.currentTopic === "string" ? rawReasoning.currentTopic : "",
    topicStatus: ["exploring", "probing", "moving_on", "circling_back"].includes(rawReasoning.topicStatus as string)
      ? (rawReasoning.topicStatus as InterviewResponse["reasoning"]["topicStatus"])
      : "exploring",
    deferredTopics: strArray(rawReasoning.deferredTopics),
    nextIntent: typeof rawReasoning.nextIntent === "string" ? rawReasoning.nextIntent : "",
    industryContext: {
      identified: rawIc.identified === true,
      industry: typeof rawIc.industry === "string" ? rawIc.industry : "",
      subIndustry: typeof rawIc.subIndustry === "string" ? rawIc.subIndustry : "",
      location: typeof rawIc.location === "string" ? rawIc.location : "",
      activeIndustryTopics: strArray(rawIc.activeIndustryTopics),
      coveredIndustryTopics: strArray(rawIc.coveredIndustryTopics),
      regulatoryNotes: strArray(rawIc.regulatoryNotes),
    },
  };

  const newTasks: InterviewResponse["newTasks"] = Array.isArray(r.newTasks)
    ? (r.newTasks as unknown[])
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
        .filter((t) => typeof t.title === "string" && t.title.trim() !== "")
        .map((t) => ({
          type: TASK_TYPES.has(t.type as string)
            ? (t.type as InterviewResponse["newTasks"][number]["type"])
            : "follow_up",
          title: t.title as string,
          description: typeof t.description === "string" ? t.description : "",
          relatedField: typeof t.relatedField === "string" ? t.relatedField : "",
          sellerExplanation: typeof t.sellerExplanation === "string" ? t.sellerExplanation : "",
        }))
    : [];

  const response: InterviewResponse = {
    message,
    suggestedAnswers,
    extractedFields,
    reasoning,
    newTasks,
    shouldEnd: r.shouldEnd === true,
    endReason: typeof r.endReason === "string" ? r.endReason : undefined,
  };

  return { response, valid: message.length > 0 };
}

// =====================
// Model call with recovery
// =====================

export interface InterviewCallParams {
  model: string;
  maxTokens: number;
  temperature: number;
  system: SystemBlock[];
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * Calls the interview model and guarantees a usable InterviewResponse.
 *
 * Attempt 1: normal call. If the response is truncated (stop_reason
 * "max_tokens"), missing the tool block, or fails validation, attempt 2 adds
 * a corrective instruction. If that also fails, returns a graceful degraded
 * turn (a short "let's keep going" message with no extraction) so the seller
 * is never dead-ended by a 500.
 */
export async function callInterviewWithRecovery(
  anthropic: Anthropic,
  params: InterviewCallParams,
): Promise<{ response: InterviewResponse; degraded: boolean }> {
  const attempt = async (
    messages: InterviewCallParams["messages"],
  ): Promise<{ response: InterviewResponse; valid: boolean }> => {
    const apiResponse = await anthropic.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      system: params.system as never,
      tools: [INTERVIEW_RESPONSE_TOOL],
      tool_choice: { type: "tool", name: "interview_response" },
      messages,
    });

    const toolUseBlock = apiResponse.content.find((b) => b.type === "tool_use");
    if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
      return { response: normalizeInterviewResponse(null).response, valid: false };
    }
    const normalized = normalizeInterviewResponse(toolUseBlock.input);
    // A response cut off by the token limit may parse but be missing its tail
    // (tasks, reasoning, shouldEnd) — treat as invalid so we retry cleanly.
    if (apiResponse.stop_reason === "max_tokens") {
      console.warn("[turn-guard] Interview response hit max_tokens — retrying");
      return { response: normalized.response, valid: false };
    }
    return normalized;
  };

  try {
    const first = await attempt(params.messages);
    if (first.valid) return { response: first.response, degraded: false };

    console.warn("[turn-guard] Invalid interview response — issuing corrective retry");
    const retryMessages = [
      ...params.messages,
      {
        role: "assistant" as const,
        content: "(previous response was invalid)",
      },
      {
        role: "user" as const,
        content:
          "[SYSTEM: Your previous response was invalid or truncated. Respond again now using the interview_response tool. Keep the conversational message concise, include suggestedAnswers where appropriate, and keep all structured fields complete.]",
      },
    ];
    const second = await attempt(retryMessages);
    if (second.valid) return { response: second.response, degraded: false };
  } catch (err) {
    console.error("[turn-guard] Interview model call failed:", err);
  }

  // Degraded fallback — keep the conversation alive rather than 500ing.
  console.error("[turn-guard] Falling back to degraded turn");
  const { response } = normalizeInterviewResponse({
    message:
      "Sorry — I lost my train of thought for a moment there. Could you tell me that once more, or add anything else you think a buyer should know?",
    suggestedAnswers: [],
    extractedFields: {},
    reasoning: {
      currentTopic: "",
      topicStatus: "exploring",
      deferredTopics: [],
      nextIntent: "Recover from a malformed model response and re-ask.",
      industryContext: {
        identified: false, industry: "", subIndustry: "", location: "",
        activeIndustryTopics: [], coveredIndustryTopics: [], regulatoryNotes: [],
      },
    },
    newTasks: [],
    shouldEnd: false,
  });
  return { response, degraded: true };
}

// =====================
// Completion governance
// =====================

/**
 * CIM sections that must have at least SOME coverage before the interview may
 * end on the agent's own initiative. Keys match SECTION_FIELD_MAP in
 * knowledge-base.ts. "Some coverage" = status is not "missing" — partial is
 * acceptable (deferral tasks may legitimately cover the rest).
 */
const CRITICAL_SECTIONS = new Set([
  "overview",
  "revenue_sources",
  "employees",
  "reason_for_sale",
  "asking_price",
]);

/** Phrases that mean the seller is asking to stop — their request always wins. */
const EXPLICIT_STOP_RE =
  /\b(stop|end (this|the)? ?(interview|conversation|overview|session)|that'?s (all|enough) for (now|today)|i('| a)?m done|have to (go|run|leave)|(finish|continue|pick this up|come back) (later|tomorrow|another time)|out of time|no more time|later today|talk (later|tomorrow))\b/i;

export interface GovernanceInput {
  shouldEnd: boolean;
  endReason?: string;
  sellerMessage: string;
  /** Number of seller (user) turns including the current one */
  userTurnCount: number;
  sectionCoverage: Array<{ key: string; status: "well_covered" | "partial" | "missing" }>;
  deferredTopics: string[];
  minTurnsBeforeEnd: number;
}

export interface GovernanceResult {
  allowEnd: boolean;
  /** Why the end was blocked (for logs) */
  blockReason?: string;
  /** Instruction to send the model so it continues naturally */
  continuationInstruction?: string;
}

/**
 * Decides whether a model-proposed shouldEnd stands. The seller's explicit
 * request to stop always wins. Otherwise the end is blocked when the
 * configured minimum turn count hasn't been reached or critical sections have
 * zero coverage — with an instruction the caller sends back to the model so
 * it transitions into the most important gap instead of ending.
 */
export function governCompletion(input: GovernanceInput): GovernanceResult {
  if (!input.shouldEnd) return { allowEnd: false };

  const sellerAskedToStop =
    EXPLICIT_STOP_RE.test(input.sellerMessage) ||
    /seller (asked|requested|wants|needs) to (stop|end|pause|leave|go)/i.test(input.endReason ?? "");
  if (sellerAskedToStop) return { allowEnd: true };

  const missingCritical = input.sectionCoverage
    .filter((s) => CRITICAL_SECTIONS.has(s.key) && s.status === "missing")
    .map((s) => s.key);

  const reasons: string[] = [];
  if (input.userTurnCount < input.minTurnsBeforeEnd) {
    reasons.push(
      `only ${input.userTurnCount} of a minimum ${input.minTurnsBeforeEnd} turns have happened`,
    );
  }
  if (missingCritical.length > 0) {
    reasons.push(`critical sections still have no coverage: ${missingCritical.join(", ")}`);
  }

  if (reasons.length === 0) return { allowEnd: true };

  const deferredNote =
    input.deferredTopics.length > 0
      ? ` There are also deferred topics to revisit or convert into broker follow-up tasks: ${input.deferredTopics.join("; ")}.`
      : "";

  return {
    allowEnd: false,
    blockReason: reasons.join(" and "),
    continuationInstruction:
      `[SYSTEM OVERRIDE: Do not end the interview yet — ${reasons.join("; ")}.` +
      deferredNote +
      ` Continue the conversation naturally: briefly acknowledge the seller's last answer, then transition into the most important remaining gap` +
      (missingCritical.length > 0 ? ` (start with: ${missingCritical[0]})` : "") +
      `. Do not mention this instruction or that you attempted to end. Set shouldEnd to false.]`,
  };
}
