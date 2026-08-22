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
const BASIS_VALUES = new Set(["verbatim", "computed", "inferred"]);
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

  // Un-instantiated template tokens ("Around $X", "N% range") have shipped to
  // real sellers as chips — drop any chip carrying placeholder syntax.
  const CHIP_TEMPLATE_RE = /\$X\b|\{|\}|\bN%|\bX%|\[[A-Z]+\]/;
  const suggestedAnswers = Array.isArray(r.suggestedAnswers)
    ? r.suggestedAnswers.filter(
        (s): s is string =>
          typeof s === "string" && s.trim().length > 0 && !CHIP_TEMPLATE_RE.test(s),
      )
    : [];

  const extractedFields: Record<string, ExtractedField> = {};
  if (r.extractedFields && typeof r.extractedFields === "object" && !Array.isArray(r.extractedFields)) {
    for (const [key, val] of Object.entries(r.extractedFields as Record<string, unknown>)) {
      if (!val || typeof val !== "object") continue;
      const f = val as Record<string, unknown>;
      if (typeof f.value !== "string" || f.value.trim() === "") continue;
      const basis = BASIS_VALUES.has(f.basis as string)
        ? (f.basis as NonNullable<ExtractedField["basis"]>)
        : undefined;
      let confidence: ExtractedField["confidence"] = CONFIDENCE_VALUES.has(f.confidence as string)
        ? (f.confidence as ExtractedField["confidence"])
        : "approximate";
      // Grounding cap: only a value the seller actually stated ("verbatim")
      // may be confirmed. Computed/inferred values are capped at "inferred" —
      // mechanically guaranteeing nothing the model marks uncertain lands as
      // a confirmed fact in the CIM pipeline.
      if (confidence === "confirmed" && basis && basis !== "verbatim") {
        confidence = "inferred";
      }
      extractedFields[key] = {
        value: f.value,
        confidence,
        source: SOURCE_VALUES.has(f.source as string)
          ? (f.source as ExtractedField["source"])
          : "seller_statement",
        ...(basis ? { basis } : {}),
      };
    }
  }

  const rawReasoning = (r.reasoning && typeof r.reasoning === "object" ? r.reasoning : {}) as Record<string, unknown>;
  const rawIc = (rawReasoning.industryContext && typeof rawReasoning.industryContext === "object"
    ? rawReasoning.industryContext
    : {}) as Record<string, unknown>;
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

  // Deferral deltas. Tolerates the legacy `deferredTopics` string array (from
  // a cached/degraded response) by treating its entries as new deferrals.
  const newDeferrals: InterviewResponse["reasoning"]["newDeferrals"] = [];
  if (Array.isArray(rawReasoning.newDeferrals)) {
    for (const d of rawReasoning.newDeferrals as unknown[]) {
      if (!d || typeof d !== "object") continue;
      const nd = d as Record<string, unknown>;
      if (typeof nd.topic !== "string" || nd.topic.trim() === "") continue;
      newDeferrals.push({
        topic: nd.topic,
        reason: typeof nd.reason === "string" ? nd.reason : "",
        whereInfoLives: typeof nd.whereInfoLives === "string" ? nd.whereInfoLives : "",
      });
    }
  }
  for (const legacy of strArray(rawReasoning.deferredTopics)) {
    if (legacy.trim() === "") continue;
    newDeferrals.push({ topic: legacy, reason: "", whereInfoLives: "" });
  }

  const reasoning: InterviewResponse["reasoning"] = {
    currentTopic: typeof rawReasoning.currentTopic === "string" ? rawReasoning.currentTopic : "",
    topicStatus: ["exploring", "probing", "moving_on", "circling_back", "dodged"].includes(rawReasoning.topicStatus as string)
      ? (rawReasoning.topicStatus as InterviewResponse["reasoning"]["topicStatus"])
      : "exploring",
    newDeferrals,
    resolvedDeferrals: strArray(rawReasoning.resolvedDeferrals),
    plannedTopics: strArray(rawReasoning.plannedTopics),
    priorCheck: typeof rawReasoning.priorCheck === "string" ? rawReasoning.priorCheck : "",
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

  const privateNotes: InterviewResponse["privateNotes"] = Array.isArray(r.privateNotes)
    ? (r.privateNotes as unknown[])
        .filter(
          (n): n is { note: string; reason: string } =>
            !!n &&
            typeof n === "object" &&
            typeof (n as Record<string, unknown>).note === "string" &&
            ((n as Record<string, unknown>).note as string).trim().length > 0,
        )
        .map((n) => ({
          note: n.note.trim(),
          reason: typeof n.reason === "string" ? n.reason.trim() : "",
        }))
    : [];

  const response: InterviewResponse = {
    message,
    whyItMatters:
      typeof r.whyItMatters === "string" && r.whyItMatters.trim().length > 0
        ? r.whyItMatters.trim()
        : undefined,
    suggestedAnswers,
    extractedFields,
    reasoning,
    privateNotes,
    newTasks,
    shouldEnd: r.shouldEnd === true,
    endReason: typeof r.endReason === "string" ? r.endReason : undefined,
  };

  return { response, valid: message.length > 0 };
}

/**
 * Soft-fail guard for empty answer chips: a question turn with zero
 * suggestedAnswers renders no chips in the UI (observed on an annual-revenue
 * turn in stress testing). Numeric questions legitimately avoid guessed
 * numbers, so the backfill offers honest escape hatches instead of figures.
 * Mutates and returns the response.
 */
export function backfillSuggestedAnswers(response: InterviewResponse): InterviewResponse {
  const asksQuestion = response.message.includes("?");
  if (asksQuestion && response.suggestedAnswers.length === 0 && !response.shouldEnd) {
    response.suggestedAnswers = [
      "Not sure — I'd have to check",
      "My accountant/bookkeeper would know",
      "Let me type out the details",
      "Prefer to come back to this",
    ];
  }
  return response;
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
/**
 * Extracts the current value of the top-level "message" string from a partial
 * tool-input JSON buffer, decoding JSON escapes. Returns the text accumulated
 * so far and whether the string has closed. Used to stream the conversational
 * message to the seller as the model emits it.
 */
function extractMessageSoFar(buf: string): { text: string; complete: boolean } | null {
  const m = buf.match(/"message"\s*:\s*"/);
  if (!m || m.index === undefined) return null;
  let i = m.index + m[0].length;
  let out = "";
  while (i < buf.length) {
    const c = buf[i];
    if (c === "\\") {
      const next = buf[i + 1];
      if (next === undefined) break; // incomplete escape at buffer edge — wait for more
      out += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
      i += 2;
      continue;
    }
    if (c === '"') return { text: out, complete: true };
    out += c;
    i++;
  }
  return { text: out, complete: false };
}

export async function callInterviewWithRecovery(
  anthropic: Anthropic,
  params: InterviewCallParams,
  /** When provided, the FIRST attempt streams the message field and emits each
   *  new text chunk here. Retries and governance re-calls never stream. */
  onDelta?: (chunk: string) => void,
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

  // Streaming variant of the first attempt: streams the message field for
  // display, but the FINAL parse (finalMessage) is authoritative — identical
  // validation to the non-streaming path.
  const streamAttempt = async (
    messages: InterviewCallParams["messages"],
  ): Promise<{ response: InterviewResponse; valid: boolean }> => {
    const stream = anthropic.messages.stream({
      model: params.model,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      system: params.system as never,
      tools: [INTERVIEW_RESPONSE_TOOL],
      tool_choice: { type: "tool", name: "interview_response" },
      messages,
    });

    let jsonBuf = "";
    let emitted = 0;
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "input_json_delta"
      ) {
        jsonBuf += event.delta.partial_json;
        const msg = extractMessageSoFar(jsonBuf);
        if (msg && msg.text.length > emitted) {
          onDelta!(msg.text.slice(emitted));
          emitted = msg.text.length;
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    const toolUseBlock = finalMessage.content.find((b) => b.type === "tool_use");
    if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
      return { response: normalizeInterviewResponse(null).response, valid: false };
    }
    const normalized = normalizeInterviewResponse(toolUseBlock.input);
    if (finalMessage.stop_reason === "max_tokens") {
      console.warn("[turn-guard] Streamed interview response hit max_tokens — retrying");
      return { response: normalized.response, valid: false };
    }
    return normalized;
  };

  try {
    const first = onDelta
      ? await streamAttempt(params.messages)
      : await attempt(params.messages);
    if (first.valid) return { response: backfillSuggestedAnswers(first.response), degraded: false };

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
    if (second.valid) return { response: backfillSuggestedAnswers(second.response), degraded: false };
  } catch (err) {
    // A billing failure is not transient — every subsequent call will fail
    // identically until the account is topped up. Make it unmissable in logs.
    const msg = err instanceof Error ? err.message : String(err);
    if (/credit balance|billing/i.test(msg)) {
      console.error(
        "[turn-guard][BILLING] Anthropic API billing failure — ALL interviews are degraded until credits are topped up:",
        msg,
      );
    } else {
      console.error("[turn-guard] Interview model call failed:", err);
    }
  }

  // Degraded fallback — keep the conversation alive rather than 500ing. The
  // message is honest about the fault (the seller's answer was NOT processed;
  // asking them to re-send with no explanation trained them to retype into a
  // dead pipeline). No "?" — the chip backfill must not decorate this turn.
  console.error("[turn-guard] Falling back to degraded turn");
  const { response } = normalizeInterviewResponse({
    message:
      "I'm having a brief technical issue on my end, and your last message may not have been recorded. Give it a moment, then please send it again — everything before this point is saved.",
    suggestedAnswers: [],
    extractedFields: {},
    reasoning: {
      currentTopic: "",
      topicStatus: "exploring",
      newDeferrals: [],
      resolvedDeferrals: [],
      plannedTopics: [],
      priorCheck: "",
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
export const CRITICAL_SECTIONS = new Set([
  "overview",
  "revenue_sources",
  "employees",
  "reason_for_sale",
  "asking_price",
]);

/**
 * Phrases that mean the seller is asking to stop — their request always wins.
 * Used BOTH to allow a model-proposed end (governCompletion) and to detect
 * incoming stop signals BEFORE the model call (detectStopSignal), so the two
 * sides of governance can never disagree about what counts as a stop.
 *
 * Bare "stop" is intentionally NOT matched (sellers say "customers stop by",
 * "we stop taking orders at 9") — stop must be phrased as a request to end.
 */
const STOP_PHRASES: string[] = [
  String.raw`(?:let'?s|can we|we should|i(?:'d| would)? (?:like|want|need) to|please) (?:stop|end|wrap(?: it| this)? up|call it)(?: here| now| a day)?`,
  String.raw`stop (?:here|now|the interview|this)`,
  String.raw`end (?:this|the) ?(?:interview|conversation|overview|session|call)`,
  String.raw`we(?:'| a)?re done(?! with)`,
  String.raw`i(?:'| a)?m done(?! with)`,
  String.raw`that(?:'| i)?s (?:all|enough|it) for (?:now|today|tonight)`,
  String.raw`that(?:'| i)?s enough`,
  String.raw`enough for (?:now|today)`,
  String.raw`done for (?:now|today|the day)`,
  String.raw`i (?:(?:really|just|actually|do) ){0,2}(?:have|need|got|gotta) to (?:go|run|leave|head out|get back)`,
  String.raw`have to get back to`,
  String.raw`gotta (?:go|run)`,
  String.raw`out of time`,
  String.raw`no more time`,
  String.raw`hard stop`,
  String.raw`call it a day`,
  String.raw`wrap (?:this|it) up`,
  String.raw`pick (?:this|it) up (?:later|tomorrow|another time)`,
  String.raw`(?:finish|continue|come back) (?:later|tomorrow|another time)`,
  String.raw`talk (?:later|tomorrow)`,
  String.raw`i(?:'| a)?m leaving`,
  String.raw`no more questions`,
  // Self-addressed completion declarations are unambiguous stops even
  // without a wrap offer — "from me" / "I've got" removes the ambiguity
  // that keeps bare "that's everything" gated behind the wrap-offer check.
  String.raw`that(?:'| i)?s (?:everything|all|it) from me`,
  String.raw`that(?:'| i)?s (?:everything|all) i(?:'ve| have)? got`,
  String.raw`nothing (?:more|else) from me`,
];

const STOP_SIGNAL_RE = new RegExp(`\\b(?:${STOP_PHRASES.join("|")})\\b`, "i");

// ── Valuation-figure guard ─────────────────────────────────────────────
// Sellers fish for valuation/tax numbers; the model deflects the first ask
// cleanly but leaks on callbacks ("what multiple should I expect?" got
// "2x-4x adjusted earnings" plus a fabricated "$150K" chip in live QA).
// These patterns let session-manager scan the OUTGOING reply on fishing
// turns and force one corrective re-call when figures leak.

export const VALUATION_FISHING_RE =
  /\bworth\b|valuation|ballpark|what.{0,30}(?:price|multiple)|how much.{0,30}(?:get|sell|keep|clear)|multiple of (?:profit|earnings|sde|ebitda)|what multiple|tax.?free|capital gains|exemption/i;

export function containsValuationFigures(text: string): boolean {
  return (
    // ANY multiple token ("2x", "3.5×") — on a fishing turn there is no
    // legitimate use of one; the earlier noun-anchored pattern missed
    // "2x to 3.5x THOSE discretionary earnings" (QA-caught leak).
    /\b\d+(?:\.\d+)?\s*[x×]\b/i.test(text) ||
    // "worth around $800K", "expect $600,000 to $1M", "valued in the $X range"
    /(?:worth|valued?|value at|fetch|expect|sell for|list(?:ed)? (?:at|for)|range of|in the range)\D{0,25}\$\s?\d/i.test(text) ||
    // Hypothetical/illustrative anchors smuggle real anchors: "If I say
    // $400K and it turns out to be $600K..." (QA-caught leak)
    /(?:if i sa(?:y|id)|say i said|suppose|let'?s say|for example|e\.g\.)\D{0,20}\$\s?\d/i.test(text) ||
    // tax figures: "$1.25M tax-free", "$970K under the exemption"
    /\$\s?[\d,.]+\s?[kmb]?(?:illion)?\D{0,30}(?:tax.?free|exempt)/i.test(text) ||
    /(?:tax.?free|exemption)\D{0,30}\$\s?\d/i.test(text)
  );
}

/** Chips carrying dollar amounts or multiples — banned on fishing turns
 *  unless the seller themselves used the number. */
export const CHIP_FIGURE_RE = /\$\s?\d|\d+(?:\.\d+)?\s*[x×]\b/;

// Completion-acceptance phrases: how a seller accepts a wrap-up the AGENT
// offered ("anything else?" → "that covers it"). Too ambiguous to count as
// stops on their own ("we're good" answers many questions), so they only
// count when the agent's previous message actually offered to wrap.
const COMPLETION_PHRASES = [
  String.raw`that (?:about )?covers (?:it|everything)`,
  String.raw`that(?:'| i)?s everything`,
  String.raw`that(?:'| i)?s (?:about )?(?:all|it)\.?$`,
  String.raw`nothing (?:else|more) (?:to add|from me|i can think of)`,
  String.raw`nothing else`,
  String.raw`we(?:'| a)?re (?:all )?(?:good|set)`,
  String.raw`i(?:'| a)?m (?:all )?(?:good|set)`,
  String.raw`all set`,
  String.raw`sounds good,? (?:that(?:'| i)?s (?:it|all))`,
];
const COMPLETION_RE = new RegExp(`\\b(?:${COMPLETION_PHRASES.join("|")})\\b`, "i");
// A wrap offer must be INTERVIEW-scoped. "Anything else about the lease?" is
// a topic probe — "nothing else" answers it and must never count as a stop
// (review-caught: topic-scoped probes turned routine answers into stop
// signals that could force-end the interview).
const WRAP_OFFER_RE =
  /covered everything|that (?:about )?wraps|wrap(?:ping)? (?:up|things up)|before we (?:wrap|finish|close)|final (?:question|thoughts?)|last (?:question|thing)|anything else you(?:'d| would) like to (?:add|cover|mention|share)|anything (?:else|more) (?:for|from) (?:me|you) today/i;
const TOPIC_SCOPED_RE =
  /(?:anything|something) (?:else|more)[^.?!]{0,40}\b(?:about|regarding|concerning|on (?:the|your|that|this)) /i;

/**
 * True when the seller's message is a request to stop the interview. Run on
 * every incoming seller message in session-manager BEFORE the model call:
 * the first signal permits one closing question; the second forces goodbye
 * and shouldEnd=true regardless of what the model returns.
 *
 * `prevAiMessage` (the agent's preceding message) unlocks the completion
 * branch: a chips-only seller who clicks "That covers it" after the agent
 * offered to wrap has ended the interview — observed live, one such seller
 * was carried 20 more turns because only typed stop phrases counted.
 */
export function detectStopSignal(sellerMessage: string, prevAiMessage?: string): boolean {
  if (STOP_SIGNAL_RE.test(sellerMessage)) return true;
  if (!prevAiMessage) return false;
  // The completion branch requires ALL of: an interview-scoped wrap offer
  // (not a topic probe), a completion phrase, and that the phrase is the
  // bulk of the message — "Nothing else on the lease, the landlord handles
  // maintenance" is an answer, not a goodbye.
  const m = COMPLETION_RE.exec(sellerMessage);
  if (!m) return false;
  const residual = sellerMessage.replace(m[0], "").replace(/[\s.,!—-]+/g, " ").trim();
  return (
    WRAP_OFFER_RE.test(prevAiMessage) &&
    !TOPIC_SCOPED_RE.test(prevAiMessage) &&
    sellerMessage.trim().length <= 80 &&
    residual.length <= 15
  );
}

/**
 * Builds the system nudge injected when a stop signal fires. Coverage-aware:
 * if the seller grants one last question, it must go to the most critical gap.
 */
export function buildStopSignalNudge(
  stopCount: number,
  missingCriticalSections: string[],
  declinedTopics: string[] = [],
): string {
  const declineBan =
    declinedTopics.length > 0
      ? ` NEVER use it on a topic the seller already declined (${declinedTopics.join("; ")}) — re-pressing a declined topic at the door is the single most trust-destroying move available to you.`
      : "";
  if (stopCount <= 1) {
    const triage = missingCriticalSections.length > 0
      ? ` If you ask it, take it from the critical sections still missing — ${missingCriticalSections.join(", ")} — nothing else is worth their remaining patience.`
      : ` Everything critical is at least partially covered — prefer wrapping up over asking anything.`;
    return (
      `# SELLER STOP SIGNAL\n` +
      `The seller has just signaled they want to stop. Respect it. You may ask AT MOST ONE brief, high-value closing question — or none.${triage}${declineBan} ` +
      `Then thank them, recap in one or two sentences, tell them everything is saved and they can pick this up anytime, and set shouldEnd to true. Do not promise "one last thing" and then ask another.`
    );
  }
  return (
    `# SELLER STOP — FINAL\n` +
    `The seller has now asked to stop more than once. Ask NOTHING — no questions, no "one quick thing". ` +
    `Say a warm goodbye, recap in one sentence, note that unanswered items are saved for next time, and set shouldEnd to true. This is mandatory.`
  );
}

export interface GovernanceInput {
  shouldEnd: boolean;
  endReason?: string;
  sellerMessage: string;
  /** Number of seller (user) turns including the current one */
  userTurnCount: number;
  sectionCoverage: Array<{ key: string; status: "well_covered" | "partial" | "missing" }>;
  deferredTopics: string[];
  minTurnsBeforeEnd: number;
  /** Session-manager's authoritative stop detection for this turn (sees the
   *  previous agent message; covers completion-acceptance stops). */
  sellerStopDetected?: boolean;
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

  // Session-manager's stop detection is authoritative (it sees the previous
  // agent message, which unlocks completion-acceptance stops like "that
  // covers it" — this regex alone would miss those and force the model to
  // keep questioning a seller who just accepted the wrap-up).
  const sellerAskedToStop =
    input.sellerStopDetected === true ||
    STOP_SIGNAL_RE.test(input.sellerMessage) ||
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


// ── Filler guard ───────────────────────────────────────────────────────
// Recap/grade openers the prompt forbids. Sentence-level: a leading sentence
// that merely echoes or praises the seller's last answer is removed when a
// question follows it. Openers that do real work — clarifying, reconciling
// a conflict, or meeting something hard with a human beat — are kept.
const FILLER_OPENER_RE =
  /\b(got it|noted|understood|makes sense|perfect|great|excellent|wonderful|fantastic|awesome|good to (know|hear)|glad to hear|thanks? (for|so much)|appreciate (you|that|the|it)|helpful (context|detail|to know)|that'?s (helpful|useful|clear|good|great|solid|strong|healthy|impressive|a (solid|strong|healthy|good|nice|great)|exactly|really)|that (is|sounds|seems) (like )?(a )?(solid|strong|healthy|good|great|nice|impressive|meaningful)|sounds (good|great|like a)|solid (foundation|number|position|base)|strong (position|foundation|number|signal)|healthy (margin|number|spread|sign)|impressive|buyers? (love|like|want|appreciate|will (love|appreciate|like|value))|from a buyer'?s (perspective|standpoint|point of view)|the kind of (thing|stuff|detail|number|signal|answer)|exactly the kind|what buyers|a good sign|good sign|nice (to see|spread|mix)|love to see|congrat)/i;
const KEEP_OPENER_RE =
  /\b(clarif|confirm|to be sure|make sure|just to check|double.?check|you mentioned|earlier you|you said|on file|i had|down as|your broker|the broker|privately|private|off the record|between (you|us)|won'?t (go|be|appear) in|stays? (with|between)|flag that|keep that|not (in|for) the (document|cim|memorandum)|your call|whenever you'?re ready|we can (skip|leave|come back)|correct(ed|ion)|updat(ed|ing) (that|it)|the (p&l|questionnaire|document|statement)s? (say|show|list|has|have)|doesn'?t (match|line up|square)|conflict|differ|discrepanc|versus|vs\.?|sorry|i'?m sorry|that (must|sounds) (be |like )?(hard|difficult|tough|a lot)|understandable|take your time|no pressure|apolog|my mistake|you'?re right|fair point|i should have)/i;

/**
 * Splits off leading sentences. A "sentence" ends at . ! ? or an em-dash
 * clause break followed by whitespace.
 */
const ABBREVIATION_RE = /\b(Dr|Mr|Mrs|Ms|Jr|Sr|St|No|vs|Inc|Ltd|Co|Corp|approx|est|e\.g|i\.e)\.$/i;
function leadingSentence(text: string): { head: string; rest: string } | null {
  // Walk sentence terminators; skip abbreviations ("Dr. Rao") and decimals ("1.5")
  const re = /[.!?](?=\s+\S)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const head = text.slice(0, m.index + 1);
    if (head.length < 3 || head.length > 240) { if (head.length > 240) return null; continue; }
    if (ABBREVIATION_RE.test(head)) continue;
    if (/\d\.$/.test(head) && /^\s*\d/.test(text.slice(m.index + 1))) continue;
    const rest = text.slice(m.index + 1).replace(/^\s+/, "");
    return { head, rest };
  }
  return null;
}

/**
 * Removes up to two leading filler sentences when a question remains after
 * them. Returns the message unchanged when no question follows (wrap-ups,
 * goodbyes), when the opener does real work, or when nothing matches.
 */
export function stripFillerPreamble(message: string): string {
  let current = message.trim();
  for (let i = 0; i < 2; i++) {
    const parts = leadingSentence(current);
    if (!parts) break;
    const { head, rest } = parts;
    if (!rest.includes("?")) break;               // nothing to ask after it
    if (head.includes("?")) break;                // the opener IS a question
    if (KEEP_OPENER_RE.test(head)) break;         // clarifying / reconciling / empathy
    if (!FILLER_OPENER_RE.test(head)) break;      // not recognisably filler
    if (!/^[A-Z"'(]/.test(rest.trim())) break;    // would leave a mid-sentence fragment
    current = rest.trim();
  }
  if (current === message.trim()) return message;
  return current.charAt(0).toUpperCase() + current.slice(1);
}
