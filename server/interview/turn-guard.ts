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

  // Withdrawn facts: [{field, reason}] (a bare string array is tolerated).
  const retractedFields: NonNullable<InterviewResponse["retractedFields"]> = Array.isArray(r.retractedFields)
    ? (r.retractedFields as unknown[])
        .map((x) =>
          typeof x === "string"
            ? { field: x, reason: "" }
            : x && typeof x === "object" && typeof (x as Record<string, unknown>).field === "string"
              ? { field: (x as Record<string, string>).field, reason: typeof (x as Record<string, unknown>).reason === "string" ? (x as Record<string, string>).reason : "" }
              : null,
        )
        .filter((x): x is { field: string; reason: string } => !!x && x.field.trim().length > 0)
        .map((x) => ({ field: x.field.trim(), reason: x.reason.trim() }))
    : [];

  const response: InterviewResponse = {
    message,
    whyItMatters:
      typeof r.whyItMatters === "string" && r.whyItMatters.trim().length > 0
        ? r.whyItMatters.trim()
        : undefined,
    importance:
      r.importance === "critical" || r.importance === "important" || r.importance === "helpful"
        ? r.importance
        : undefined,
    targetSection:
      typeof r.targetSection === "string" && r.targetSection.trim().length > 0
        ? r.targetSection.trim()
        : undefined,
    suggestedAnswers,
    extractedFields,
    reasoning,
    privateNotes,
    newTasks,
    retractedFields,
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
  /**
   * Streaming only: called once, as soon as the message field is complete
   * (before the rest of the response — extracted facts, reasoning — is
   * generated). Returning false stops the call there: the result is
   * `rejected` with just that message, so the caller can ask for a rewrite
   * without waiting for (or showing) the rest. Used by the re-ask guard, so
   * a question that re-asks something on file is never shown to the seller.
   */
  onMessageComplete?: (message: string) => boolean | Promise<boolean>,
): Promise<{ response: InterviewResponse; degraded: boolean; rejected?: boolean }> {
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
  ): Promise<{ response: InterviewResponse; valid: boolean; rejected?: boolean }> => {
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
    let checked = false;
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
        if (msg?.complete && !checked && onMessageComplete) {
          checked = true;
          let keep = true;
          try {
            keep = await onMessageComplete(msg.text);
          } catch (err) {
            console.warn("[turn-guard] message-complete hook failed — continuing:", err);
          }
          if (!keep) {
            // A listener, so the SDK doesn't report the deliberate abort as
            // an unhandled rejection.
            stream.on("abort", () => {});
            stream.abort();
            const { response } = normalizeInterviewResponse({ message: msg.text });
            return { response, valid: false, rejected: true };
          }
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
    if ((first as { rejected?: boolean }).rejected) return { response: first.response, degraded: false, rejected: true };
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
 * Used to detect incoming stop signals BEFORE the model call
 * (detectStopSignal); governCompletion trusts that detection.
 *
 * Detection is about INTENT, not vocabulary. A bare phrase inside an ordinary
 * answer is not a request to stop: "a lot of them come back later", "I'm
 * leaving the business once…", "that's enough to cover payroll", "we're done
 * installing by 3pm", "a hard stop on credit at 60 days" all describe the
 * business (QA harvest: one such sentence ended a Clearwater interview at 6
 * of the 10-turn minimum). So there are two tiers:
 *
 * - ADDRESSED phrases talk about THIS conversation ("let's stop here", "can we
 *   pick this up tomorrow?", "I have to run", "end the interview", "that's
 *   all for today") — they count anywhere in the message.
 * - SHORT-ONLY phrases ("I'm done", "hard stop at 3", "out of time", "call
 *   it a day") are ambiguous in a long answer — they count only in a short
 *   message, or when they make up the whole final sentence.
 *
 * Bare "stop" is intentionally NOT matched (sellers say "customers stop by",
 * "we stop taking orders at 9") — stop must be phrased as a request to end.
 */
// A phrase counts only where its clause ends — "that's enough to cover
// payroll" and "talk later about it" are not the stop phrases they contain.
// (A hyphen joined to a word isn't a clause end: "Bye-laws in our township".)
const CLAUSE_END = String.raw`(?=\s*(?:[.!?,;:)—–]|-(?![A-Za-z])|$|\n|\s(?:thanks|thank you|please|bye|sorry|anyway|so|and|but|i|we|let'?s)\b))`;
const LATER = String.raw`(?:later(?: on)?|tomorrow|another (?:time|day)|some other time|next (?:time|week)|(?:on )?(?:monday|tuesday|wednesday|thursday|friday|the weekend))`;
// Who is doing the stopping: the seller about themselves or this conversation
// ("let's", "can we", "I have to", "I'm going to have to") — never "we" the
// business ("we stop taking orders at 9", "we end the session with…").
const I_MUST = String.raw`(?:i (?:(?:really|just|actually|do|unfortunately|now|kind of|kinda) ){0,2}(?:have|need|got|gotta|'ve got|'ve gotta) to|i(?:'ve)? got(?:ta| to)|i'?m (?:going to|gonna) have to|i'?ll (?:have|need) to|i must)`;
const LEAVE_VERB = String.raw`(?:go|run|leave|head out|head off|jump(?: off)?|hop off|sign off|get going|take off|dash|split|bounce|step away|log off)`;
// Leaving FOR something: "go to a meeting", "leave for an appointment", "run
// to the bank", "go pick up my daughter", "jump on another call". Unlike the
// bare "I have to go", these read like business in a long answer ("I have to
// go to the supplier every Monday"), so they count only in a short message
// or as the closing (or apologetic opening) sentence, and never with a
// habit word in the sentence.
const LEAVE_FOR_DEST = String.raw`(?:meeting|appointment|appt|call|zoom|job|job ?site|site|bank|doctor|dentist|school|daycare|kids?|daughter|son|wife|husband|partner|mom|mum|dad|family|flight|airport|plane|train|lunch|dinner|class|practice|game|funeral|delivery|client|customer|patient|supplier|vendor|inspector|inspection|shift|errand|thing|event|store|shop|office|clinic|plant|warehouse|truck|crew|guys|staff|emergency|fire)s?`;
const ERRAND_STOP_RE = new RegExp(
  String.raw`\b(?:${I_MUST}|(?<=^|[.!?,;:—–]\s{0,3}|\b(?:sorry|ok|okay|anyway|oh|well|yeah|so|but|and)\s{1,3})(?:gotta|got to)) ${LEAVE_VERB}(?: (?:now|quickly|real quick|right now))?(?: (?:to|for|and|into|over to|out to|off to|on|meet|see|grab|get|catch|take|pick(?: [\w']+)? up)\b)(?: [\w'-]+){0,4}? ${LEAVE_FOR_DEST}\b`,
  "i",
);
const HABIT_RE =
  /\b(?:every|each|usually|normally|typically|often|sometimes|always|whenever|once a|twice a|per (?:week|month|day)|regularly|most (?:days|weeks|mornings|nights)|on (?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|weekends))\b/i;
// "…to a meeting in ten minutes, so quickly: …" — leaving is imminent.
const SOON_RE = /\b(?:right now|shortly|in (?:a (?:few|couple(?: of)?) |\d+ |five |ten |fifteen |twenty )?min(?:ute)?s?|in a (?:sec|second|bit|minute))\b/i;
const APOLOGY_START_RE = /^(?:sorry|so sorry|apologies|oh|oops|ah|actually|unfortunately|hey|listen|ok(?:ay)?|shoot|darn|argh)\b/i;
// What "later" may resume in a resume-later request: the conversation itself
// ("this", "the rest", "where we left off") — never a job, and never "it" /
// "that", which are usually a task: "Yes, I'll do that tomorrow" answering
// "could you upload the lease?", "I'll finish it tomorrow and send it over"
// (review-caught: those ended interviews). A task commitment or a deferral
// of ONE question ("Can I come back to this after I check with my
// accountant?") is the classifier's to read (seller-intent.ts), not a
// pattern's — only requests that can't be anything but ending this
// conversation are instant.
const RESUME_OBJECT = String.raw`(?: (?:this|things|the rest(?: of (?:this|it|the questions))?|this conversation|the interview|the questions|where we left off))`;
const ADDRESSED_STOP_PHRASES: string[] = [
  // "Let's stop here", "can we end it here", "I'd like to wrap this up now".
  // Never "we can …" — that is the business ("we can stop the line").
  String.raw`(?:let'?s|can we|could we|we should|i(?:'d| would)? (?:like|want|need|prefer) to|i'?d rather|please|maybe we|time to|i think we (?:should|can)|${I_MUST})\s+(?:just\s+)?(?:stop|end|pause|wrap(?: it| this| things)? up|call it(?: a day| here| quits)?|take a break|leave it (?:there|at that)|cut (?:this|it|things) short)(?: (?:it|this|things|(?:the|this|our) (?:session|call|chat|interview|conversation|meeting)))?(?: (?:here|now|there|for (?:now|today|tonight|the day))){0,2}${CLAUSE_END}`,
  // "Can we do this another time?", "let's continue later", "could we pick
  // this up tomorrow" — the seller asking the interviewer to resume later.
  // Subjects that address the interviewer only: never "I'll …" (a task: "I'll
  // do that tomorrow") and never the business "we could / we can". ("Can we
  // come back to this later?" is usually one question set aside — the
  // classifier's call.)
  String.raw`(?:let'?s|can we|could we|i(?:'d| would)? (?:like|want|prefer) to|i'?d rather|maybe we|how about we)\s+(?:just\s+)?(?:(?:finish|continue|resume|do|carry on|keep going|pick (?:this|things) (?:back )?up)${RESUME_OBJECT}|(?:continue|resume|carry on|keep going|pick (?:this|things) (?:back )?up|chat|talk|speak))(?: (?:again|maybe|then|with you))? ${LATER}${CLAUSE_END}`,
  // "Can we pick this up?" — resuming later, said as a question. (Not "can
  // we continue with the lease next?" — that's a seller who wants to go on;
  // not "can I pick it up tomorrow?" — that's a document.)
  String.raw`(?:can|could) we pick (?:this|things) (?:back )?up(?: (?:again|some ?time|at some point|another time|later))?\s*\?`,
  // "Could we do the rest on Monday?" (Not "can I come back to this after I
  // check with my accountant?" — one question set aside, and the interview
  // goes on.)
  String.raw`(?:can|could|may) (?:we|i) (?:continue|do|pick up|finish) (?:the rest|this conversation|the interview|the questions)\b[^.?!]{0,40}\?`,
  String.raw`(?<=^|[.!?,]\s{0,3}|\b(?:ok|okay|please|so|sorry|alright|right)\s{1,3})stop (?:here|now|there)${CLAUSE_END}`,
  // "I'll stop here", "I'm going to stop now", "I think I'll leave it there".
  String.raw`(?:i'?ll|i will|i'?m (?:going to|gonna)|i think i'?ll|i'?d better|i better)\s+(?:have to\s+)?(?:stop|leave it|call it)(?: (?:there|here|now|at that|a day|for (?:now|today|tonight|the day))){1,2}${CLAUSE_END}`,
  String.raw`stop (?:the interview|this (?:interview|conversation|session|chat))`,
  String.raw`end (?:this (?:interview|conversation|session|call|chat)|the (?:interview|conversation|chat))\b`,
  String.raw`${I_MUST} ${LEAVE_VERB}(?: (?:now|soon|shortly|real quick|unfortunately|in a (?:minute|sec|second|few|bit)|for (?:a bit|a while|now|today)))?${CLAUSE_END}`,
  // "Sorry, have to run." / "OK gotta go."
  String.raw`(?<=^|[.!?,;:—–]\s{0,3}|\b(?:sorry|ok|okay|anyway|oh|well|yeah|so|but|and)[,.!]?\s{1,3})(?:gotta|got to|have to|need to) (?:go|run|head out|head off|jump|dash|split|leave|bounce)${CLAUSE_END}`,
  String.raw`that(?:'| i)?s (?:all|enough|it)(?: (?:for|from) (?:me|us))?(?: i (?:have|can do|'ve got))?(?: for)? (?:now|today|tonight|the day|(?:one|a) day)${CLAUSE_END}`,
  String.raw`(?:i'?m|we'?re|i am|we are) (?:all )?done for (?:now|today|tonight|the day)`,
  String.raw`enough for (?:now|today|tonight|(?:one|a) day)${CLAUSE_END}`,
  String.raw`(?<=^|[.!?,;:—–]\s{0,3}|\b(?:ok|okay|so|thanks|thank you|bye|alright|great|anyway|cheers)[,!.]?\s{1,3})talk (?:to you )?(?:later|tomorrow|soon|next time)${CLAUSE_END}`,
  // "No more today please." — only as its own sentence.
  // (Not "No more today, we sold out by noon.")
  String.raw`(?<=^|[.!?,;:—–]\s{0,3})no more (?:for )?(?:today|tonight|right now|for now)(?=\s*(?:[.!]|$)|\s+(?:please|thanks|thank you)\b)`,
  String.raw`i (?:can'?t|cannot|don'?t think i can) (?:do|handle|take|answer) (?:any ?more|much more|this any ?more|more (?:questions|of this))(?: (?:today|tonight|right now|now|for (?:today|now)))?${CLAUSE_END}`,
  String.raw`(?:don'?t|do not|won'?t) have (?:any )?(?:more )?time (?:for (?:(?:any )?more|this|the rest|questions|it now)|today|right now|to (?:continue|keep going|finish))|no more time for (?:this|questions|today)`,
  // Self-addressed completion declarations are unambiguous stops even
  // without a wrap offer — "from me" / "I've got" removes the ambiguity
  // that keeps bare "that's everything" gated behind the wrap-offer check.
  String.raw`that(?:'| i)?s (?:everything|all|it) from me`,
  String.raw`that(?:'| i)?s (?:everything|all) i(?:'ve| have)? got${CLAUSE_END}`,
  String.raw`nothing (?:more|else) from me`,
];
const SHORT_ONLY_STOP_PHRASES: string[] = [
  String.raw`(?:i'?m|we'?re|i am|we are) (?:all )?done(?: here| now)?${CLAUSE_END}`,
  String.raw`that(?:'| i)?s enough(?: now| questions)?${CLAUSE_END}`,
  String.raw`(?:i'?m|we'?re|i am|we are) (?:about |running |nearly )?out of time${CLAUSE_END}`,
  String.raw`no more time${CLAUSE_END}`,
  String.raw`(?:i (?:have|'ve got|got) a )?hard stop(?: (?:at|in) [\w: ]{1,12})?${CLAUSE_END}`,
  String.raw`wrap (?:this|it) up${CLAUSE_END}`,
  String.raw`call it a day${CLAUSE_END}`,
  String.raw`(?:have|need|got) to get back to (?:work|the (?:shop|floor|office|store|site|clinic|kitchen|yard)|my (?:day|desk|customers|patients|crew))${CLAUSE_END}`,
  String.raw`(?:good)?bye(?: for now)?${CLAUSE_END}`,
];

// A seller who wants the questions to stop NOW — "please stop asking me
// questions", "no more questions". Not a pause-and-resume: the first one is
// the end (a goodbye, no closing question).
// Addressed to the interviewer: it opens its sentence (or follows "please",
// "can you"…) — "customers stop asking for discounts" and "the bank had no
// more questions" describe the business.
const TO_INTERVIEWER = String.raw`(?<=^|[.!?,;:—–]\s{0,3}|\b(?:please|just|ok|okay|so|now|honestly|seriously|can you|could you|would you|will you)[,]?\s{1,3})`;
const FIRM_STOP_PHRASES: string[] = [
  String.raw`${TO_INTERVIEWER}(?:please )?stop (?:asking(?: me)?(?: (?:questions|so many questions|all these questions|anything else|any more questions|things|stuff|all this))?|with (?:the|all the|these|all these) questions|the questions)(?=\s*(?:[.!?,;:—–]|$|\s(?:please|now|i|i'm|it|this|ok|okay)\b))`,
  String.raw`${TO_INTERVIEWER}(?:no|enough|not any) more questions(?: (?:for (?:now|today|tonight)|today|please))?${CLAUSE_END}`,
  String.raw`${TO_INTERVIEWER}enough (?:with the )?questions${CLAUSE_END}`,
  String.raw`i(?:'m| am) (?:done|finished) (?:answering(?: questions)?|with (?:the|these|your) questions)`,
  String.raw`i (?:don'?t|do not) want to answer any (?:more|further) questions`,
];
const FIRM_STOP_RE = new RegExp(`\\b(?:${FIRM_STOP_PHRASES.join("|")})`, "i");
// The whole message is "Stop." / "Stop now please."
const BARE_STOP_RE = /^\s*(?:(?:ok(?:ay)?|please|just)[,\s]+)?stop(?:[,\s]+(?:please|now|it|there))*\s*[.!]*\s*$/i;

const ADDRESSED_STOP_RE = new RegExp(`\\b(?:${ADDRESSED_STOP_PHRASES.join("|")})`, "i");
const SHORT_ONLY_STOP_RE = new RegExp(`\\b(?:${SHORT_ONLY_STOP_PHRASES.join("|")})`, "i");
// Words that may surround a stop phrase in a final sentence without making
// it about the business ("Anyway, I think that's it for today, thanks").
const CONVERSATIONAL_FILLER = new Set(
  "ok okay so well anyway anyways alright all right honestly look sorry but yeah yes and thanks thank you for today now really just guess think i i'm im me we us that's that it's oh um uh hey right then though yep sure cheers".split(" "),
);
const SHORT_STOP_MESSAGE_WORDS = 25;

const wordCount = (s: string) => (s.trim().match(/\S+/g) ?? []).length;
const sentencesOf = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

function isFirmStop(text: string): boolean {
  return BARE_STOP_RE.test(text) || FIRM_STOP_RE.test(text);
}

/**
 * True when the seller wants the questions to stop now ("Please stop asking
 * me questions.", "No more questions.", "Stop.") — the instant pattern tier
 * of the firm stop level (seller-intent.ts).
 */
export function detectFirmStop(sellerMessage: string): boolean {
  return isFirmStop(sellerMessage.replace(/[’‘]/g, "'").trim());
}

/** True when the seller's message asks to stop the interview (see STOP phrases above). */
function matchesStopRequest(sellerMessage: string): boolean {
  const text = sellerMessage.replace(/[’‘]/g, "'").trim();
  if (!text) return false;
  if (isFirmStop(text)) return true;
  if (ADDRESSED_STOP_RE.test(text)) return true;
  const short = wordCount(text) <= SHORT_STOP_MESSAGE_WORDS;
  const sentences = sentencesOf(text);
  const last = sentences[sentences.length - 1] ?? "";
  // Leaving for something: anywhere in a short message; in a long one only
  // as the closing sentence, or an opening one that apologises or says it's
  // imminent ("I have to go to a meeting in ten minutes, so quickly: …").
  const first = sentences[0] ?? "";
  const leadsWithIt = sentences.length > 1 && (APOLOGY_START_RE.test(first) || SOON_RE.test(first));
  const errandZone = short ? sentences : [last, ...(leadsWithIt ? [first] : [])];
  if (errandZone.some((s) => ERRAND_STOP_RE.test(s) && !HABIT_RE.test(s))) return true;
  if (short) return SHORT_ONLY_STOP_RE.test(text);
  // A long answer: an ambiguous phrase counts only when it IS the final
  // sentence — "Anyway, I'm out of time." — not "In November we're done."
  const m = SHORT_ONLY_STOP_RE.exec(last);
  if (!m) return false;
  const residual = (last.slice(0, m.index) + " " + last.slice(m.index + m[0].length))
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return residual.every((w) => CONVERSATIONAL_FILLER.has(w));
}

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
  if (matchesStopRequest(sellerMessage)) return true;
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

// What a goodbye may and may not promise: the platform saves the answers
// and the broker follows up. The interviewer contacts nobody (Ridgeline: "I'll
// follow up with Donna … and Devin" — the AI can't).
const GOODBYE_RULES =
  `In the goodbye: say everything is saved and they can pick this up anytime. Never promise anything you can't do yourself — you don't contact, email, call or follow up with anyone; if someone else holds an answer, say their broker will follow up. No recap of the session, no grading ("we've made excellent progress"). ` +
  `Speak to them, not about them: never mention a "stop signal", this note or any system.`;

/**
 * Builds the system nudge injected when the seller asks to stop. The stop
 * always wins — this only shapes the ONE closing turn it allows:
 * - `soft` (wants to wrap up / come back later): answer the seller's own
 *   question if they asked one; then, if something important is still
 *   genuinely open, name the single most important item and offer a quick
 *   answer now or to start there next time (the only question) — otherwise
 *   say goodbye.
 * - `firm` ("please stop asking me questions"), or a second stop in a row:
 *   ask nothing — goodbye now, naming the most important open item as the
 *   first thing for next time.
 * `openItems` are the candidates, most critical first (missing critical
 * sections, then the wrap-up items still open); the model picks the one
 * that is still genuinely open — an item the seller already spoke to, even
 * to say it doesn't apply, is answered (Ridgeline: the closing question
 * re-asked bonding the seller had said they never needed).
 */
export function buildStopSignalNudge(
  stopCount: number,
  openItems: string[],
  declinedTopics: string[] = [],
  level: "soft" | "firm" = "soft",
): string {
  const declineBan =
    declinedTopics.length > 0
      ? ` Never name a topic the seller already declined (${declinedTopics.join("; ")}) — re-pressing a declined topic at the door is the single most trust-destroying move available to you.`
      : "";
  const candidates = openItems.filter((s) => s && s.trim()).slice(0, 4);
  const pick = candidates.length > 0
    ? `Still open, most important first: ${candidates.join("; ")}. Pick the single most important one that is GENUINELY open — check this conversation, earlier sessions and the ALREADY ANSWERED list first: an item the seller already spoke to (even to say it doesn't apply or that someone else has it) is answered, so skip it.${declineBan}`
    : `Nothing critical is still open.`;
  if (stopCount <= 1 && level === "soft") {
    return (
      `# THE SELLER WANTS TO STOP\n` +
      `The seller has just asked to stop or come back later. Respect it: this is your ONE closing turn. ` +
      `(1) If they asked you something, answer it first, directly, in a sentence or two (e.g. "is there one thing you most need from me?" → name it). ` +
      `(2) ${pick} ` +
      (candidates.length > 0
        ? `If one is genuinely open, name it in one plain sentence and offer a choice as your only question — a quick answer now, or start there next time ("Before you go, the one thing I'd most like to pin down is your asking-price expectation — a rough number now, or shall we start there next time?"); set shouldEnd false. If none is, say goodbye and set shouldEnd true. `
        : `Say goodbye and set shouldEnd true. `) +
      `Never ask a second question, never "one last thing". ${GOODBYE_RULES}`
    );
  }
  return (
    `# SELLER STOP — END NOW\n` +
    (level === "firm" && stopCount <= 1
      ? `The seller has asked you to stop asking questions. `
      : `The seller has now asked to stop more than once. `) +
    `Ask NOTHING — no questions, no "one quick thing". If they asked you something, answer it in a sentence. ${pick} ` +
    (candidates.length > 0 ? `If one is genuinely open, name it in one plain sentence as the first thing to pick up next time — as a statement, not a question. ` : "") +
    `Then a short, warm goodbye, and set shouldEnd to true. This is mandatory. ${GOODBYE_RULES}`
  );
}

/**
 * The turn after the one closing turn a stop allowed: the seller has
 * answered it (or said "next time"). The interview ends now.
 */
export function buildClosingAnswerNudge(): string {
  return (
    `# CLOSING\n` +
    `The seller asked to stop on their last turn and you gave your one closing turn. Record anything they just told you, then say a short, warm goodbye — ask NOTHING — and set shouldEnd to true. ${GOODBYE_RULES}`
  );
}

// "I'll follow up with Donna" — the interviewer can't; the broker does.
const CLOSING_PROMISE_RE =
  /\b(I)(?:['’]ll| will| can| am going to|['’]m going to)\s+(?:also\s+|personally\s+|make sure to\s+)?(follow up|reach out|be in touch|get in touch|touch base|check in with|contact|email|e-mail|call|phone)\b/g;

/**
 * A goodbye that promises what the platform can't do ("I'll follow up with
 * Donna and Devin", "I'll email you the list") — the promise becomes the
 * broker's, which is what actually happens: the broker gets every open item.
 */
export function scrubClosingPromises(message: string): string {
  return message.replace(CLOSING_PROMISE_RE, (m, _who: string, verb: string, offset: number, whole: string) => {
    const before = whole.slice(0, offset);
    const startOfSentence = before.trim() === "" || /[.!?]\s*$|\n\s*$|[—–:]\s*$/.test(before);
    const lead = startOfSentence ? "Your broker will" : "your broker will";
    return `${lead} ${verb.toLowerCase()}`;
  });
}

export interface GovernanceInput {
  shouldEnd: boolean;
  endReason?: string;
  sellerMessage: string;
  /** Number of seller (user) turns including the current one */
  userTurnCount: number;
  sectionCoverage: Array<{ key: string; status: "well_covered" | "partial" | "missing"; importance?: string }>;
  deferredTopics: string[];
  minTurnsBeforeEnd: number;
  /** Session-manager's authoritative stop detection for this turn (sees the
   *  previous agent message; covers completion-acceptance stops). */
  sellerStopDetected?: boolean;
  /**
   * Items that must be discussed or deferred before the interview may end on
   * its own (see completion-gaps.ts): uncaptured critical checklist items in
   * partly covered critical sections, seller-only topics (reason for sale,
   * transition, owner pay, add-backs, deal structure, key-person risk) with
   * no seller source, unreconciled critical source conflicts, open flagged
   * risks. Each is a plain-language line naming the item.
   */
  blockingItems?: string[];
  /**
   * The seller-intent classifier's stop verdict for this turn
   * (seller-intent.ts): "stop", "none", or "unavailable" when it failed or
   * timed out. The model's own endReason ("the seller asked to stop") is a
   * corroborating signal: it counts only when there is no classifier verdict
   * to weigh it against — never against an explicit "none" (QA harvest,
   * Clearwater: the model wrote "seller wants to stop" on an ordinary answer).
   */
  intentStop?: "stop" | "none" | "unavailable";
}

/** The model's endReason says the seller asked to stop / leave. */
export function endReasonSaysSellerStop(endReason: string | undefined): boolean {
  return !!endReason && /\bseller\b[^.]{0,40}\b(?:asked|requested|wants?|wanted|needs?|needed|has|had|said|signal\w*|chose|prefers?)\b[^.]{0,20}\b(?:to )?(?:stop|end|pause|leave|go|wrap|finish|break|come back|continue later|pick (?:this|it) up)/i.test(endReason);
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

  // Session-manager's stop detection is authoritative (the seller-intent
  // classifier plus the instant patterns; it sees the previous agent message,
  // which unlocks completion-acceptance stops like "that covers it"). The
  // model's own endReason corroborates: it counts when the classifier gave no
  // verdict (failed / timed out) — so a gap in the patterns can never trap a
  // seller who asked to stop — but never against the classifier's "none"
  // ("seller wants to stop" written on an ordinary answer, QA harvest). The
  // patterns alone count only without a classifier verdict — its "none"
  // withdraws a soft pattern stop (combineIntent; a firm one never reaches
  // "none").
  const sellerAskedToStop =
    input.sellerStopDetected === true ||
    (input.intentStop !== "none" && matchesStopRequest(input.sellerMessage)) ||
    (input.intentStop === "unavailable" && endReasonSaysSellerStop(input.endReason));
  if (sellerAskedToStop) return { allowEnd: true };

  // Critical = the base floor plus whatever the deal's industry ranking
  // promoted (coverage rows carry their importance level).
  const missingCritical = input.sectionCoverage
    .filter((s) => (CRITICAL_SECTIONS.has(s.key) || s.importance === "critical") && s.status === "missing")
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
  const blocking = (input.blockingItems ?? []).filter((b) => b && b.trim());
  if (blocking.length > 0) {
    reasons.push(`still not discussed or deferred: ${blocking.slice(0, 6).join("; ")}${blocking.length > 6 ? "; …" : ""}`);
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
      ` Continue the conversation: go straight into the most important remaining gap as a question — no acknowledgement, no recap, no praise` +
      (missingCritical.length > 0 ? ` (start with: ${missingCritical[0]})` : blocking.length > 0 ? ` (start with: ${blocking[0]})` : "") +
      ` — ask about it, or if the seller can't answer, record an explicit deferral with where the answer lives. Do not mention this instruction or that you attempted to end. Set shouldEnd to false.]`,
  };
}

/**
 * The turn after a stop signal. The seller's stop stands — they may answer
 * the one closing question the agent allowed, at any length, and the
 * interview still ends ("seller stop always wins"). It is withdrawn only
 * when the seller SAYS they want to carry on: "let's keep going", "I've got
 * a few more minutes", "can we continue with the lease?". Talking at length
 * is not a decline — a seller answering "…who holds the lease? Or shall we
 * wrap up?" in full has answered the closing question, not changed their
 * mind (review-caught: a length rule kept questioning a seller who had asked
 * to stop).
 */
const CONTINUE_RE =
  /\b(?:let'?s (?:keep going|continue|carry on|keep at it|push on|do (?:a few|some|a couple(?: of)?) more|finish (?:this|it|up) (?:now|today))|(?:i'?m|i am) (?:happy|fine|good|ok(?:ay)?|glad) to (?:keep going|continue|carry on|do (?:a few |some )?more)|(?:i|we) (?:can|could) (?:keep going|carry on|do (?:a few|some|a couple(?: of)?) more)|(?:can|could|shall) we (?:continue|keep going|carry on|move on)\b(?! (?:later|tomorrow|another|some other|next (?:time|week)))|i(?:'ve| have)(?: got)? (?:a few|a couple(?: of)?|some|\d+|five|ten|fifteen) (?:more )?minutes|i (?:still )?(?:have|'ve got) (?:some|more|a bit of|plenty of) time|not (?:done|finished) yet|i'?m not done|no,? (?:let'?s )?(?:keep going|continue|carry on)|(?:we|i) can keep going)\b/i;
export function sellerDeclinedWrapUp(_prevAiMessage: string | undefined, sellerMessage: string): boolean {
  const text = sellerMessage.replace(/[’‘]/g, "'");
  if (matchesStopRequest(text) || COMPLETION_RE.test(text)) return false;
  return CONTINUE_RE.test(text);
}


// Praise of the seller's question itself ("Great question.", "Good
// questions — …") — never an answer to anything.
const QUESTION_PRAISE_SENTENCE_RE =
  /^(?:(?:that'?s|those are|these are|what)\s+(?:a\s+)?)?(?:really\s+|very\s+)?(?:great|good|fair|excellent|smart|important|reasonable|valid|thoughtful|interesting)\s+(?:question|questions|point|points|ask)s?\s*[.!]$/i;
const QUESTION_PRAISE_PREFIX_RE =
  /^(?:(?:that'?s|those are|these are)\s+(?:a\s+)?)?(?:really\s+|very\s+)?(?:great|good|fair|excellent|smart|important|reasonable|valid|thoughtful|interesting)\s+(?:question|questions|point|points|ask)s?\s*(?:[—–,:]|-\s)\s*/i;

// "Got it — $8,417 is confirmed." — an acknowledgement that only reports the
// seller's last answer was recorded. The "confirm" in it isn't a
// clarification, it's the recap the tone rules forbid.
const RECAP_RECORDED_RE =
  /^(?:got it|noted|understood|perfect|great|thanks|thank you|okay|ok|all right|alright|good)\b[^.?!]*\b(?:is|are|'s|has been|have been)\s+(?:now\s+)?(?:confirmed|noted|recorded|captured|locked in|on file|updated)\s*[.!]$/i;

// Words that open a direct answer ("Yes — …", "No, …", "It depends …").
const ANSWER_START_RE =
  /^(?:yes|yeah|yep|no|nope|not\b|sure|of course|absolutely|correct|right|exactly|definitely|probably|usually|typically|generally|it depends|depends|i (?:do|don'?t|can|can'?t|have|haven'?t|will|won'?t|would|wouldn'?t|see|'?ll|'?m)|we (?:do|don'?t|can|can'?t|have|will|'?ll)|you (?:can|do|don'?t|will|won'?t|'?ll|should|shouldn'?t|may|might|need|needn'?t)|it(?:'?s| is| isn'?t| was| will| won'?t| goes| stays)|they(?:'?re| are| will| won'?t| do| don'?t)|nothing|nobody|only|none|either|both|because|that(?:'?s| is) (?:up to|for|because|why|how|what|your|a question for))\b/i;

const STOPWORDS = new Set(
  "about above after again also and any are aren't because been before being below between both but can can't cannot could couldn't did didn't does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having here how i'm into its it's just like more most much must need needs other our ours out over own really same should shouldn't some such than that that's the their theirs them then there these they this those through too under until very was wasn't were weren't what what's when where which while who why will with won't would wouldn't you your yours yourself business thing things something anything question questions know think".split(" "),
);
const contentStems = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(/[a-z][a-z'’-]{3,}/g) ?? [])
      .map((w) => w.replace(/['’]s$/, ""))
      .filter((w) => !STOPWORDS.has(w))
      .map((w) => w.slice(0, 5)),
  );

/**
 * Did the seller ask the agent something? A "?" alone isn't enough — a
 * seller hedging a figure ("maybe $1.3M? I'd have to check") hasn't asked
 * anything. A question sentence opens with a question word / auxiliary, or
 * ends with a tag ("…, right?", "…, correct?").
 */
export function sellerAskedQuestion(sellerMessage: string | null | undefined): boolean {
  if (!sellerMessage || !sellerMessage.includes("?")) return false;
  const questions = sellerMessage.match(/[^.!?\n]*\?/g) ?? [];
  return questions.some((q) => {
    const s = q.trim().replace(/^["'(\s]+/, "").replace(/^(?:and|but|so|also|ok(?:ay)?|oh|well|hey|hmm|um|sorry|then)[,\s]+/i, "");
    if (/^(?:what|why|how|when|where|which|who|whom|whose|is|are|was|were|am|do|does|did|can|could|should|would|will|shall|may|might|must|have|has|had|isn'?t|aren'?t|wasn'?t|don'?t|doesn'?t|didn'?t|can'?t|couldn'?t|shouldn'?t|wouldn'?t|won'?t|haven'?t|hasn'?t|any|anything|you|your|so what|what's|how's|who's|where's)\b/i.test(s)) return true;
    return /(?:,|\bor)\s*(?:right|correct|yes|no|ok(?:ay)?|true|isn'?t (?:it|that)|don'?t (?:you|they|we)|aren'?t (?:they|we|you)|won'?t (?:it|they)|you think|agreed)\s*\?$/i.test(s) || /\b(?:right|correct)\?$/i.test(s);
  });
}

// ── Filler guard ───────────────────────────────────────────────────────
// The founder's tone rule: the reply IS the next question. A sentence in
// front of the question survives only when it does real work — answering
// the seller, reconciling a conflict with what's on file, a short human beat
// on something hard, a privacy promise, a clarification, or asking for a
// document. Everything else that merely echoes, grades or praises the
// seller's last answer ("That's a realistic read —", "Good — a clean Phase I
// removes a major due diligence risk for buyers.", "That powertrain-agnostic
// mix is actually a strength") is cut. The check is sentence-by-sentence
// over EVERY sentence before the question (not just the first two), so a
// two-sentence grade or a grade tucked after a useful sentence goes too.
//
// Three verdicts per sentence, in this order:
//   1. WORK (kept): phrase-anchored patterns for the jobs above. Anchored on
//      whole phrases — "confirm whether", "stays with your broker" — never on
//      fragments: "clarif"/"confirm"/"your broker" used to keep "That's
//      helpful — having Dana confirm…" and "That's exactly right — your
//      broker will want…" (QA harvest).
//   2. FILLER (cut): acknowledgement words, a back-reference ("That…",
//      "This…", "It…") followed by a verdict, grading vocabulary, buyer
//      cheerleading, session recaps, or a sentence that is mostly the
//      seller's own words played back.
//   3. Otherwise kept — context the question needs ("On patient records: in
//      a share sale, the records stay with the corporation.").

/** Sentences that do a job for the seller — never cut. */
const WORK_PATTERNS: RegExp[] = [
  // Privacy promises
  /\b(?:stays?|goes|go|kept|keep (?:it|that|this)) (?:only )?(?:with|to|between) (?:you and )?(?:your broker|the broker)\b|\b(?:your|the) broker only\b|\bbroker[- ]only\b|\bprivately\b|\bin private\b|\b(?:kept|keep (?:it|that|this)|stays?|remains?) private\b|\bprivate (?:to|between|note)\b|\boff the record\b|\bwon'?t (?:go|be|appear|end up) in\b|\bnot (?:go )?in(?:to)? (?:the|any) (?:sale |marketing )?(?:document|cim|memorandum|materials)|\bnever (?:in )?the (?:sale )?document\b|\bthat'?s the whole story\b|\bfrom a document perspective\b/i,
  // A human beat on something hard
  /\b(?:i'?m (?:so |really |very |truly )?sorry|sorry to hear|that (?:must|sounds|would) (?:be |have been |like )?(?:a |an )?(?:really |very |incredibly )?(?:hard|difficult|tough|rough|painful|stressful|a lot|heavy|awful)|understandable|take your time|no pressure|no rush|i (?:completely |totally )?understand (?:that|why|if|how)|that'?s a lot to (?:carry|deal with|manage))\b/i,
  // Owning a miss
  /\b(?:you'?re (?:right|correct)(?=\s*(?:[\u2014\u2013,.!:;]|-\s|$))|my mistake|my apologies|apologies|i should have|i missed that|good catch)/i,
  // Reconciling a conflict with what's on file
  /\b(?:doesn'?t|don'?t|does not|do not) (?:match|line up|square|tie out|agree)|\bconflicts? with\b|\bdiffers? from\b|\bdifferent from\b|\bdiscrepanc\w*|\bversus\b|\bvs\.?(?=\s)|\bhelp me square\b|\breconcile\b|\b(?:(?:a bit|a little|slightly|well|much|quite a bit|a lot) )?(?:above|below|higher than|lower than|short of) (?:the|what|your)\b|\bwhereas\b|\bbut (?:the|your) (?:p&l|statements?|documents?|financials?|questionnaire|file|records?|t2|tax returns?|books|reports?|lease|roster|list|schedule|notes)\b/i,
  // Clarifying (phrase-anchored)
  /\b(?:just to (?:clarify|confirm|check|be sure|make sure|be clear)|to (?:clarify|be clear)|let me (?:clarify|make sure|check)|quick clarification|double.?check(?:ing)?|(?:want|need) to make sure i (?:have|understood|got)|(?:i )?(?:want|need) to confirm (?:whether|that|which|if|what|the)|confirm(?:ing)? (?:whether|which|if)|clarify (?:whether|if|which|what))\b/i,
  // Asking for a document / naming the follow-up
  /\b(?:if (?:you|\w+) (?:can|could) (?:send|upload|share|pull|forward|dig out|grab|have \w+ (?:send|upload|pull))|(?:please|could you|can you|would you) (?:upload|send|share|forward)|upload (?:it|that|them|the|those)|(?:after|once) we (?:finish|wrap|are done)|documents? area|i'?ll (?:note|flag|add|record|make a note of|pass|leave) (?:that|it|this|those|them)(?= (?:for|as|down|with|to)\b|\s*(?:[.,;:!\u2014\u2013]|$))|i'?ll follow up\b|(?:as|for) (?:a )?follow.?up)\b/i,
  // Handing the seller a choice
  /\b(?:your call|whenever you'?re ready|we can (?:skip|leave|come back|move on|circle back)|happy to (?:skip|come back|move on)|if you'?d rather)\b/i,
];

const ACK_START_RE =
  /^(?:good|great|perfect|excellent|wonderful|fantastic|awesome|nice|lovely|brilliant|exactly|absolutely|right|okay|ok|got it|understood|noted|makes sense|(?:that|it|this|all of that|all that) (?:(?:really|totally|completely) )?makes (?:(?:complete|total|perfect|a lot of|good) )?sense|fair enough|thanks?(?: you)?|thank you|(?:i )?(?:really )?appreciate|helpful|interesting|cool|all right|alright|glad|love that|congrat\w*)\b/i;
// "That…", "This…", "It…", "Those…", "Both of those…" + a verdict verb: the
// sentence is a comment on what the seller just said.
const BACKREF_VERDICT_RE =
  /^(?:that|this|those|these|both(?: of (?:those|these|them))?|it|which|all of (?:that|this)|the fact that)(?:'s|\s+(?:[\w$€£%.,'’&/\-–]+\s+){0,12}?(?:is|are|was|were|'s|sounds?|seems?|looks?|feels?|reads?|makes?|made|confirms?|clarifies|clarified|helps?|gives?|shows?|covers?|comes? through|matters?|will (?:matter|help|land|play|give|resonate|go)|would (?:matter|help|give)|lines? up|tracks?|speaks?|removes?|reduces?|simplifies|simplify|puts?|paints?|adds? up|counts?|stands? out|resonates?|tells?))\b/i;
const GRADING_PATTERNS: RegExp[] = [
  // "That's a realistic read", "Smart planning —", "A clear picture —",
  // "Good detail on the rate structure" — sentence-initial only, so "I don't
  // have a clear read on working capital" is not a grade.
  /^(?:(?:that'?s|that is|this is|it'?s|what|such|also)\s+)?(?:a |an )?(?:really |very |pretty |quite |genuinely )?(?:realistic|candid|clear(?:-eyed)?|clean|helpful|useful|important|smart|sensible|solid|strong|healthy|impressive|reassuring|favou?rable|meaningful|straightforward|manageable|great|good|nice|excellent|fair|honest|familiar|well[- ]spec'?d|valuable|compelling|promising|positive|rare|cleaner|stronger|better|tidy|thoughtful|proactive)\s+(?:read|picture|assessment|reality check|approach|planning|plan|point|context|detail|note|structure|outcome|move|answer|call|summary|split|view|position|story|track record|record|foundation|base|number|figure|margin|mix|setup|set-?up|arrangement|signal|sign|spread|profile|acquisition|bottleneck|pass-through|facility|operation|result|place|thing|info(?:rmation)?|explanation|insight|breakdown|overview|update|news|to (?:know|hear|have|see|get))\b/i,
  // "…is actually a strength —", "…is meaningful —", "…is actually favorable
  // given…" — a verdict ending its clause; "the lease is a standard 10-year
  // term" (the word describes a noun) is context, not a grade.
  /\b(?:is|are|'s|was|looks?|sounds?|seems?)\s+(?:(?:actually|really|quite|very|pretty|genuinely|definitely|exactly|also|already|clearly|a|an)\s+)*(?:strength|differentiator|asset|plus|advantage|selling point|good sign|favou?rable|meaningful|reassuring|standard|straightforward|manageable|healthy|strong|solid|clean|impressive|significant|notable|valuable|encouraging|good news|good thing|the right (?:answer|approach|call|move|way|instinct|thing to do)|smart|sensible|exactly right|spot on|helpful|useful)(?=\s*(?:[\u2014\u2013,.;:!]|-\s|$)|\s+(?:for|given|in|at|and|to|because|here|there|now|overall|too|as well)\b)/i,
  // "…, that's a manageable transition if…", "which is a strong position"
  /\b(?:that|this|which|it)(?:'s| is) (?:a |an )?(?:really |very |pretty |quite |genuinely |actually )?(?:manageable|realistic|clean|healthy|solid|strong|smart|sensible|great|good|nice|excellent|impressive|reassuring|favou?rable|meaningful|valuable|compelling|promising|positive|rare|tidy|enviable|remarkable)\b/i,
  // "The vet clinics sound sticky", "that looks solid"
  /\b(?:sounds?|seems?|looks?|feels?)\s+(?:really |very |pretty |quite |fairly |genuinely )?(?:sticky|good|great|solid|strong|healthy|stable|reasonable|manageable|promising|positive|right|clean|smart|sensible|fine|reassuring|encouraging|well[- ]\w+|like (?:a )?(?:good|great|solid|strong|smart|sensible|healthy|clean))\b/i,
  // Buyer commentary: "A smart buyer will prioritize that conversation…"
  /^(?:a|the|any|most|every)?\s*(?:smart |savvy |serious |good |right |sophisticated )?(?:buyers?|acquirers?|purchasers?)\b[^.?!]*\b(?:will|would|should|tend to|typically|usually)\b/i,
  // Recaps of the seller's own point / the file's state
  /\byou(?:'ve| have) already (?:flagged|covered|mentioned|noted|said|addressed|identified|thought)\b|\bi (?:now )?have a (?:clear|good|full|solid|great|much (?:clearer|better)) (?:picture|sense|read|understanding)\b|\bmade (?:(?:really|very|some|such) )?(?:good|great|real|solid|excellent|terrific|tremendous|fantastic|wonderful|strong|amazing|significant|substantial|a lot of|lots of|huge) progress\b|\b(?:all |are all |is all )?(?:well|nicely|thoroughly|fully) (?:captured|covered|documented|understood)\b|\bwe (?:have|now have|'ve got) (?:strong|good|solid|great|comprehensive|thorough|detailed) (?:documentation|coverage|detail|information|data)\b|\bwhich is why\b|\b(?:will|would) likely be part of\b|\bdirectly (?:impacts?|affects?)\b/i,
  // Buyer cheerleading and valuation commentary
  /\b(?:buyers?|acquirers?|lenders?|insurers?|investors?|purchasers?|a buyer|the buyer|the right buyer)\b[^.?!]{0,60}\b(?:love|like|appreciate|value|reward|want to (?:see|hear)|need to hear|will (?:love|like|appreciate|value|notice|want to see)|pay (?:more|a premium)|look for|are looking for|tend to look for|feel confident|(?:will |would )?(?:want|need|expect) (?:certainty|comfort|confidence|assurance|clarity|to (?:know|understand|see))|prioriti[sz]e)\b/i,
  /\b(?:gives?|give|giving|provides?) (?:a |the )?(?:buyers?|them|a buyer|the buyer|buyers and their \w+)\b[^.?!]{0,30}\b(?:confidence|comfort|a clear picture|certainty|peace of mind|a sense of|real|a (?:clear |real )?path|runway|a head start)\b|\b(?:will|would|should) (?:land|play|read|sit|go over) well\b|\bland well\b|\bmatters? (?:to|for|in) (?:buyers|valuation|a buyer|the deal)\b|\bwill matter to\b|\bthe distinction that matters\b|\bwhat (?:buyers|they|a buyer) (?:want|need|like|love|expect) to (?:see|hear)\b|\bexactly (?:what|the kind)\b|\bthe kind of (?:detail|thing|answer|number|signal|stuff|insight|story)\b|\bremoves? (?:a |the |most of the |one )?(?:major |big |key |common |real )?(?:\w+ )?(?:risk|concern|obstacle|question mark)\b|\bde-?risks?\b|\b(?:a )?(?:real|genuine|clear|big|major) (?:asset|strength|differentiator|plus|advantage)\b|\bspeaks for itself\b|\b(?:will|would|should|could|is going to|are going to) (?:really |definitely |certainly )?resonate\b|\bresonates? (?:with|well)\b|\btells a (?:good|great|strong) story\b|\bcomes? through clearly\b|\bwell below (?:the )?industry\b|\bincreasingly rare\b|\bsmart (?:planning|move|approach|buyer)\b|\bgood (?:to (?:know|hear|have|see|get)|detail|news|sign)\b|\blines up with what i'?d expect\b|\bin (?:a )?(?:good|great|strong) (?:place|position|shape)\b|\bwell[- ]positioned\b|\bbuyers? (?:and their \w+ )?(?:will|would) (?:definitely |certainly )?(?:want|need) (?:that |this |it )?nailed down\b|\byou(?:'ve| have) built\b|\bsomething (?:solid|special|great|real)\b|\b(?:cleaner|stronger|better) [\w ]{0,30}(?:i'?ve seen|out there)\b/i,
];
// Session recaps in front of a question ("We've covered a lot of ground —
// your market position, referral channels…").
const RECAP_START_RE =
  /^(?:(?:\w+,\s+)?we(?:'ve| have) (?:now |really )?(?:covered|gone through|been through|talked through|walked through)|you(?:'ve| have) (?:given|shared|walked|painted|told)|that (?:covers|gives me|rounds out)|i (?:now )?have a (?:clear|good|full|solid) (?:picture|sense|read))/i;

const isWork = (s: string) => WORK_PATTERNS.some((re) => re.test(s)) && !RECAP_RECORDED_RE.test(s.trim());

/**
 * True when a sentence placed in front of the question only acknowledges,
 * grades, praises or recaps. `sellerMessage` enables the played-back check.
 */
export function isFillerSentence(sentence: string, sellerMessage?: string | null): boolean {
  const s = sentence.trim().replace(/^["'(\s]+/, "").replace(/[’‘]/g, "'");
  if (!s || s.includes("?")) return false;
  if (RECAP_RECORDED_RE.test(s)) return true;
  if (isWork(s)) return false;
  // An aside between dashes hides the verdict from the back-reference
  // check: "That differentiation — the 45-minute follow-ups, continuity of
  // care — will resonate with buyers" is "That differentiation will
  // resonate with buyers" (seen live after round 1).
  const flat = s.replace(/\s[\u2014\u2013]\s[^\u2014\u2013.?!]{1,220}?\s[\u2014\u2013]\s/g, " ");
  const any = (re: RegExp) => re.test(s) || (flat !== s && re.test(flat));
  if (QUESTION_PRAISE_SENTENCE_RE.test(s)) return true;
  if (ACK_START_RE.test(s)) return true;
  if (any(RECAP_START_RE)) return true;
  if (GRADING_PATTERNS.some(any)) return true;
  // Mostly the seller's own words played back ("A range of six to seven
  // thousand active patients, with Carol pulling the exact count.").
  if (sellerMessage) {
    const own = Array.from(contentStems(s));
    if (own.length >= 5) {
      const said = contentStems(sellerMessage);
      const echoed = own.filter((w) => said.has(w)).length;
      if (echoed / own.length >= 0.7) return true;
    }
  }
  // A figure, a comparison or an implication the question stands on is
  // context, not a comment — even when it opens with "That's": "That's
  // about $400K more than the T2 shows.", "That's net of the $180K owner
  // salary.", "That would make Leah your only senior physio." (It got here
  // without a grade, so there's nothing evaluative in it.)
  if (FACT_CONTEXT_RE.test(s)) return false;
  if (any(BACKREF_VERDICT_RE)) return true;
  return false;
}

/** A lead sentence carrying a figure, a comparison or an implication. */
const FACT_CONTEXT_RE =
  /\$\s?\d|\d[\d,.]*\s?(?:%|percent\b)|\b\d[\d,.]*\s?(?:k|m|mm|million|thousand|people|employees|staff|techs?|trucks?|units?|clients?|customers?|patients?|locations?|sites?|years?|months?|weeks?|days?|hours?|sq\.? ?ft|square feet)\b|\b(?:more|less|higher|lower|bigger|smaller|larger|fewer|greater|older|newer|longer|shorter) than\b|\bnet of\b|\b(?:before|after|excluding|including|net|gross) (?:of )?(?:the |your |any )?(?:refunds?|returns?|tax(?:es)?|salary|salaries|owner|addbacks?|add-backs?|depreciation|interest|rent|fees|discounts?|cogs|expenses|chargebacks?|hst|gst|payroll|wages)\b|\bgross (?:figure|number|revenue|sales|amount|margin)\b|\b(?:up|down) from\b|\bcompared (?:to|with)\b|\binstead of\b|\brather than\b|\bthe first i'?ve heard\b|\bnew to me\b|^(?:that|this|which) (?:would|will|could|might) (?:mean|make|leave|put)\b/i;

/** Praise of the seller or the business in a goodbye — the recap itself stays. */
const CLOSING_PRAISE_PATTERNS: RegExp[] = [
  ...GRADING_PATTERNS.slice(1),
  /^(?:that|this|it)(?:'s| is| makes)\s+(?:complete |total |perfect )?(?:sense|clear|great|exactly)\b/i,
  /^(?:both of (?:those|these)|the fact that)\b/i,
  /\b(?:strong|solid|great|impressive|clean|healthy) (?:foundation|business|operation|position|story|picture|team|track record)\b/i,
];

interface Span { text: string }

/**
 * Splits text into sentences, each carrying the whitespace that follows it,
 * so cutting one keeps everything else — paragraph breaks included — exactly
 * as written. A sentence ends at . ! ? (not in "Dr. Rao", "1.5", "e.g.")
 * followed by whitespace, or at a blank line.
 */
const ABBREVIATION_RE = /\b(Dr|Mr|Mrs|Ms|Jr|Sr|St|No|vs|Inc|Ltd|Co|Corp|approx|est|e\.g|i\.e|U\.S|Mt|Ft|Ave|Blvd|Rd)\.$/i;
function splitSentences(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  const re = /[.!?]["')\]\u201d]*\s+(?=\S)|\n\s*\n\s*(?=\S)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const head = text.slice(start, end);
    if (!/^\n/.test(m[0])) {
      const body = text.slice(start, m.index + 1);
      if (body.trim().length < 3) continue;
      if (ABBREVIATION_RE.test(body.trimEnd())) continue;
      if (/\d\.$/.test(body) && /^\d/.test(text.slice(end))) continue;
    }
    if (head.trim()) spans.push({ text: head });
    start = end;
  }
  if (text.slice(start).trim()) spans.push({ text: text.slice(start) });
  return spans;
}

/** What's left after cuts, with a capital first letter. */
function rebuild(spans: Span[], cut: Set<number>): string {
  // A cut sentence that ended a paragraph hands its break to the sentence
  // kept before it, so the question still starts its own paragraph.
  const kept: string[] = [];
  spans.forEach((s, i) => {
    if (!cut.has(i)) { kept.push(s.text); return; }
    const trailing = s.text.match(/\s*$/)?.[0] ?? "";
    if (kept.length > 0 && trailing.includes("\n") && !/\n\s*$/.test(kept[kept.length - 1])) {
      kept[kept.length - 1] = kept[kept.length - 1].replace(/\s*$/, trailing);
    }
  });
  const out = kept.join("").trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// "Good — what's the lease term?" → "What's the lease term?"
// Also "I appreciate the context on differentiation — but …" and
// "Understood on the team stability — and …" in front of the question.
const ACK_PREFIX_RE =
  /^(?:(?:good|great|perfect|excellent|got it|thanks|thank you|understood|okay|ok|exactly|absolutely|makes sense|noted|right|sure|that'?s (?:helpful|great|good|clear|useful|fair|interesting))|(?:i )?(?:really )?appreciate (?:the|that|you|it|your|all|this|these|those)[^\u2014\u2013.?!]{0,60}|(?:understood|noted|thanks?) (?:on|for|about) [^\u2014\u2013.?!]{1,60})\s*(?:[\u2014\u2013:,]|\s-)\s*(?:(?:but|and|so)\s+)?(?=\S)/i;
// A sentence left leading with a back-reference once what it referred to was
// cut: "It shows operational leverage as the 3PL side scales." (Pacific T17).
const DANGLING_BACKREF_RE = /^(?:it|this|that|which|these|those|they|so|and|but|also)\b/i;

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Removes filler sentences in front of the question (see the verdicts
 * above). Returns the message unchanged when it asks nothing and isn't a
 * closing, when every lead sentence does work, or when nothing matches.
 *
 * `sellerMessage` (the seller's last message) switches on question mode when
 * the seller asked something: the reply's opening may then BE the answer
 * ("Yes — I have $2.3M down as your asking price."), and an unanswered
 * question reads as being ignored. In that mode only these go:
 *   - praise of the question ("Great question." / a "Good question — "
 *     prefix), never an answer;
 *   - a filler sentence that neither starts like an answer nor shares a
 *     content word with what the seller asked — including one that follows
 *     the answer ("Yes — $2.3M, noted. That's a strong number. What …?"
 *     keeps the answer and drops the grade).
 * Anything that looks like an answer, clarifies or empathises is kept.
 *
 * `closing` (the reply ends the interview and asks nothing): the goodbye and
 * a factual recap stay; sentences praising the seller or the business go.
 */
export function stripFillerPreamble(
  message: string,
  opts: { sellerMessage?: string | null; closing?: boolean } = {},
): string {
  if (opts.closing && !message.includes("?")) return stripClosingPraise(message);
  const questionMode = sellerAskedQuestion(opts.sellerMessage);
  return questionMode
    ? stripInQuestionMode(message, opts.sellerMessage!)
    : stripOpeners(message, opts.sellerMessage ?? null);
}

function stripOpeners(message: string, sellerMessage: string | null): string {
  const spans = splitSentences(message.trim());
  const q = spans.findIndex((s) => s.text.includes("?"));
  if (q < 0) return message; // nothing to ask after it (the no-question guard handles these)
  const cut = new Set<number>();
  let edited = false;
  for (let i = 0; i < q; i++) {
    const s = spans[i].text;
    if (isFillerSentence(s, sellerMessage)) cut.add(i);
    else if (cut.has(i - 1) && DANGLING_BACKREF_RE.test(s.trim()) && !isWork(s)) cut.add(i);
    else {
      // A sentence kept for its work can still open with a grade: "That
      // $12-15 range is useful for now — if Kyle can send that spreadsheet…"
      // → "If Kyle can send that spreadsheet…".
      const trimmed = dropGradePrefix(s);
      if (trimmed !== s) { spans[i] = { text: trimmed }; edited = true; }
    }
  }
  // Buyer-rationale tacked on after the last question belongs in
  // whyItMatters ("Buyers will want to see whether the growth is a one-year
  // spike or part of a trend.").
  const lastQ = spans.reduce((acc, s, i) => (s.text.includes("?") ? i : acc), q);
  for (let i = lastQ + 1; i < spans.length; i++) {
    if (isFillerSentence(spans[i].text, sellerMessage)) cut.add(i);
  }
  // The question sentence itself: drop an acknowledgement prefix.
  const qTrim = spans[q].text.replace(/^\s+/, "");
  const prefix = qTrim.match(ACK_PREFIX_RE);
  if (prefix && !isWork(qTrim.slice(prefix[0].length))) {
    spans[q] = { text: capitalise(qTrim.slice(prefix[0].length)) };
    edited = true;
  }
  // …and a conjunction left leading the question once everything before it
  // was cut ("But does ClinicNest have…?" → "Does ClinicNest have…?").
  if (q > 0 && Array.from({ length: q }, (_, i) => i).every((i) => cut.has(i))) {
    const body = spans[q].text.replace(/^\s+/, "");
    const m = body.match(/^(?:but|and|so|also)\s+(?=[a-z])/i);
    if (m) { spans[q] = { text: capitalise(body.slice(m[0].length)) }; edited = true; }
  }
  if (cut.size === 0 && !edited) return message;
  return rebuild(spans, cut);
}

/**
 * "<grade> — <work>" → "<work>". Only a real grade goes (a verdict or
 * praise); a plain acknowledgement in front of a privacy promise or a
 * document request ("Understood — that stays with your broker only", "No
 * problem — if Donna can send…") is a human beat and stays.
 */
function dropGradePrefix(sentence: string): string {
  const m = sentence.match(/^(\s*)([^\u2014\u2013?]{3,200}?)\s[\u2014\u2013]\s([\s\S]+)$/);
  if (!m) return sentence;
  const head = m[2].trim().replace(/[\u2019\u2018]/g, "'");
  const rest = m[3];
  if (ACK_START_RE.test(head) || isWork(head) || !isWork(rest) || wordCount(rest) < 4) return sentence;
  const graded = GRADING_PATTERNS.some((re) => re.test(head)) || (!FACT_CONTEXT_RE.test(head) && BACKREF_VERDICT_RE.test(head));
  if (!graded) return sentence;
  return m[1] + capitalise(rest);
}

// Praise strong enough that it is never the answer to a seller's question,
// even when it shares a word with it ("That makes complete sense, and it's
// exactly the kind of insight that helps the right buyer…").
const STRONG_PRAISE_RE =
  /\bexactly (?:what|the kind|the sort|the type)\b|\bresonat\w*|\bcomes? through clearly\b|\byou(?:'ve| have) built\b|\bgenuine(?:ly)? (?:differentiator|rare|strength|asset)\b|\b(?:real|genuine|big|major|huge) (?:asset|strength|differentiator)\b|\bmakes? (?:complete|total|perfect) sense\b|\bspeaks for itself\b|\b(?:great|good|excellent|smart|fair) (?:question|point|instinct)\b|\blove (?:that|this|it)\b|\bmade (?:(?:really|very) )?(?:good|great|excellent|real|solid) progress\b/i;

function stripClosingPraise(message: string): string {
  const text = message.trim();
  const spans = splitSentences(text);
  const cut = new Set<number>();
  spans.forEach((sp, i) => {
    const s = sp.text.trim().replace(/[’‘]/g, "'");
    if (isWork(s)) return;
    if (/^(?:thanks?|thank you)\b/i.test(s) && !CLOSING_PRAISE_PATTERNS.some((re) => re.test(s))) return;
    if (CLOSING_PRAISE_PATTERNS.some((re) => re.test(s))) cut.add(i);
  });
  if (cut.size === 0 || cut.size === spans.length) return message;
  // "Thank you for being so thorough — this is one of the cleaner pictures
  // I've seen." goes as praise; the goodbye keeps a plain thanks.
  const thanksCut = Array.from(cut).find((i) => /^(?:thanks?|thank you)\b/i.test(spans[i].text.trim()));
  const thanksKept = spans.some((sp, i) => !cut.has(i) && /\b(?:thanks?|thank you)\b/i.test(sp.text));
  if (thanksCut !== undefined && !thanksKept) {
    cut.delete(thanksCut);
    const trailing = spans[thanksCut].text.match(/\s*$/)?.[0] ?? "";
    spans[thanksCut] = { text: `Thank you.${trailing}` };
  }
  return rebuild(spans, cut);
}

function stripInQuestionMode(message: string, sellerMessage: string): string {
  const original = message.trim();
  let text = original;
  // "Good question — yes, I have it." → "Yes, I have it." (only when a real
  // sentence follows the praise).
  const prefix = text.match(QUESTION_PRAISE_PREFIX_RE);
  if (prefix && /[A-Za-z]/.test(text.slice(prefix[0].length))) {
    const after = text.slice(prefix[0].length).trim();
    text = after.charAt(0).toUpperCase() + after.slice(1);
  }
  const questionText = (sellerMessage.match(/[^.!?\n]*\?/g) ?? []).join(" ");
  const asked = contentStems(questionText);
  // "Why do you need that?" names nothing to match against, and its answer
  // is an explanation that often sounds like filler ("Buyers want to see
  // who runs the day-to-day.") — the first real sentence is the answer.
  let answerExpected =
    asked.size === 0 || /\b(why|how come|what for|what does (?:that|it|this) matter|does (?:that|it|this) matter|what'?s the point)\b/i.test(questionText);
  // "Do you have my price down?" — then "Noted — $2.3M is on file." IS the
  // answer, so the first sentence may report the record.
  const askedAboutRecord = /\b(have|got|get|on file|down|recorded?|noted?|correct(?:ly)?|right|confirm\w*|captur\w*)\b/i.test(questionText);
  const spans = splitSentences(text);
  const q = spans.findIndex((s) => s.text.includes("?"));
  if (q < 0) return text === original ? message : text;
  const cut = new Set<number>();
  let first = true;
  for (let i = 0; i < q; i++) {
    const h = spans[i].text.trim();
    const praiseOfQuestion = QUESTION_PRAISE_SENTENCE_RE.test(h);
    const reportsRecord = first && askedAboutRecord && /\b(?:on file|down as|recorded|noted|confirmed|captured|i have)\b/i.test(h);
    // Only the presumed answer (the first real sentence) is protected by
    // opening like one — "It's the honest read, and sophisticated buyers will
    // appreciate the distinction." after the answer is a grade (seen live).
    const answerStart = first && ANSWER_START_RE.test(h.replace(/^["'(]+/, ""));
    const filler =
      praiseOfQuestion ||
      // "Good to know the landlord is receptive." opens with an
      // acknowledgement, not an answer — even when it names what was asked.
      (!answerExpected && !reportsRecord && !answerStart && ACK_START_RE.test(h) && isFillerSentence(h, null)) ||
      (!answerExpected && !answerStart && !isWork(h) && STRONG_PRAISE_RE.test(h)) ||
      (!answerExpected &&
        !reportsRecord &&
        isFillerSentence(h, null) &&
        !answerStart &&
        !Array.from(contentStems(h)).some((w) => asked.has(w)));
    if (!praiseOfQuestion) {
      answerExpected = false; // only the first real sentence is the presumed answer
      first = false;
    }
    if (filler) cut.add(i);
  }
  if (cut.size === 0) return text === original ? message : text;
  return rebuild(spans, cut);
}

// ── Output guards: internal vocabulary, a question every turn, a rationale
// that matches the question ─────────────────────────────────────────────

/**
 * The agent's own machinery named to the seller ("On the mandatory probes I
 * need to check off: …", "the coverage map shows revenue and EBITDA detail")
 * — the prompt's internal checklists and panels, which make the interview
 * read like the form it must never feel like (QA harvest, Pacific T15/T17).
 */
const INTERNAL_MACHINERY_RE =
  /\bmandatory probes?\b|\b(?:need|have|want) to check off\b|\bcheck(?:ing)? (?:it|them|that|this|those|these) off\b|\bcoverage (?:map|dashboard|panel|list|checklist)\b|(?<!\b(?:your|our|their|client|clients'|customer|customers'|support|internal|team|it|documentation|shared) )\bknowledge base\b|\b(?:deferral|my) ledger\b|\bopen deferrals?\b|\bsystem (?:note|override|instructions?|prompt|correction)s?\b|\bCIM sections?\b|\bsection (?:priorities|coverage)\b|\bmy (?:checklist|list of (?:questions|items|topics)|notes say|outline|playbook|coverage)\b|\b(?:industry|interview) playbook\b|\binterview (?:plan|outline)\b|\bpriorCheck\b|\bextracted ?fields\b|\bALREADY ANSWERED\b|\bmarked as (?:critical|important|helpful)\b|\bstop signals?\b/i;

export function leaksInternalMachinery(text: string): boolean {
  return INTERNAL_MACHINERY_RE.test(text);
}

/**
 * Last-resort scrub when a rewrite still names the machinery: a lead-in
 * clause that only announces the checklist is dropped ("On the mandatory
 * probes I need to check off: has your insurer…?" → "Has your insurer…?"),
 * "the coverage map shows X, but…" becomes "I have X, but…", and any other
 * sentence that names it is removed when a question remains.
 */
export function scrubInternalMachinery(text: string): string {
  let out = text.replace(
    /(^|[.!?]\s+|\n)([^.!?:\n]*?\b(?:mandatory probes?|check (?:it |them |that |this )?off|coverage (?:map|dashboard|list|checklist)|knowledge base|(?:deferral |my )ledger|my (?:checklist|list|outline|playbook))\b[^.!?:\n]*):\s*(\S)/gi,
    (_m, lead: string, _clause: string, next: string) => `${lead}${next.toUpperCase()}`,
  );
  out = out.replace(/\b(?:the |my )?(?:coverage (?:map|dashboard|panel|list)|knowledge base|interview (?:plan|outline)|checklist) (?:shows|has|lists|says)\b/gi, "I have");
  if (!leaksInternalMachinery(out)) return out.trim();
  const sentences = out.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !leaksInternalMachinery(s));
  // Drop the sentences that name it — when a question survives, or when the
  // reply never asked one (a goodbye: "Since the seller stop signal came
  // through, I want to respect your time.").
  if (kept.some((s) => s.includes("?")) || (kept.length > 0 && !out.includes("?"))) out = kept.join(" ");
  else out = out.replace(INTERNAL_MACHINERY_RE, "what I have so far");
  out = out.trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Does the reply ask the seller something? (A wrap-up offer counts.) */
export function asksQuestion(message: string): boolean {
  return /\?/.test(message);
}

/**
 * A question to append when a non-final turn still asks nothing after its
 * corrective rewrite: the agent's own planned question (reasoning.nextIntent
 * often IS one), else a plain ask about the topic it was on.
 */
export function fallbackQuestion(nextIntent: string, currentTopic: string): string {
  const q = (nextIntent.match(/[^.!?]*\?/) ?? [])[0]?.trim();
  const INSTRUCTION_RE = /^(?:ask|probe|explore|find out|understand|clarify|confirm|learn|get|cover)\b/i;
  if (q && q.length >= 12 && !INSTRUCTION_RE.test(q)) return q.charAt(0).toUpperCase() + q.slice(1);
  const intent = (q && INSTRUCTION_RE.test(q) ? q.replace(/\?$/, "") : nextIntent)
    .replace(/\s*\(.*$/, "")
    .replace(/\b(?:because|since|so that|to (?:confirm|understand|see))\b.*$/i, "")
    .trim();
  const m = intent.match(/^(?:ask|probe|explore|find out|understand|clarify|confirm|learn|get|cover)(?: the seller| them)?(?: about| on| whether| if| how| what| why| when| who)?\s+(.{6,140})$/i);
  if (m) {
    const topic = m[1].replace(/[.;:,]+$/, "");
    if (/^(?:whether|if)\b/i.test(intent.split(/\s+/).slice(1).join(" "))) return `Can you tell me whether ${topic}?`;
    return `Could you walk me through ${topic}?`;
  }
  const topic = currentTopic.replace(/^industry_specific:/, "").replace(/[_-]+/g, " ").trim();
  return topic ? `What else should I understand about ${topic}?` : "What would you like a buyer to understand next about the business?";
}

// Generic deal words that say nothing about WHICH question a rationale
// belongs to ("…during ownership transfer…" fits every transition question).
const GENERIC_RATIONALE_STEMS = new Set(
  "buyer buyers owner owners owner's ownership transfer transfers transition deal deals sale sell selling seller closing close process change changes control value valuation price revenue business company risk risks new make makes mean means help helps important matter matters often typically need needs want wants show shows clear clearly confidence certainty".split(" ").map((w) => w.slice(0, 5)),
);
const rationaleStems = (text: string) =>
  new Set(Array.from(contentStems(text)).filter((w) => !GENERIC_RATIONALE_STEMS.has(w)));

/**
 * Whether "Why we ask this" belongs to the question actually asked. Dropped
 * on a goodbye, on an open wrap-up question ("Anything else before we wrap
 * up?" carried the environmental-permits rationale), when it shares no
 * specific word with the question or the sentence leading into it, and when
 * it is the PREVIOUS question's rationale left standing — it shares more
 * with the question before than with this one (Clearwater: a patient-records
 * question explained by the direct-billing gap its predecessor asked about).
 * Measured on the QA harvest's 75 rationales: exactly the two mismatches and
 * one generic line are dropped.
 */
export function whyItMattersFits(
  message: string,
  whyItMatters: string | undefined,
  shouldEnd: boolean,
  prevAiMessage?: string | null,
): boolean {
  if (!whyItMatters) return false;
  if (shouldEnd) return false;
  const spans = message.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const qi = spans.findIndex((x) => x.includes("?"));
  if (qi < 0) return false;
  const questions = spans.filter((x) => x.includes("?")).join(" ");
  const qStems = rationaleStems(questions);
  const ctx = new Set([...Array.from(qStems), ...Array.from(rationaleStems(qi > 0 ? spans[qi - 1] : ""))]);
  const why = rationaleStems(whyItMatters);
  // A word shared with the question itself counts double; one shared only
  // with the sentence leading into it counts once. (An open "anything else
  // before we wrap up?" names nothing, so it keeps no rationale; one about a
  // named area — "anything else a buyer would need transferred on the
  // permits side?" — keeps a permits rationale.)
  const here = Array.from(why).reduce((acc, w) => acc + (qStems.has(w) ? 2 : ctx.has(w) ? 1 : 0), 0);
  if (here === 0) return false;
  const prevQ = prevAiMessage ? (prevAiMessage.match(/[^.!?\n]*\?/g) ?? []).join(" ") : "";
  const before = Array.from(rationaleStems(prevQ)).filter((w) => !ctx.has(w) && why.has(w)).length;
  return here >= before;
}

const GREETING_RE =
  /\b(?:hi|hello|hey|welcome|good (?:morning|afternoon|evening)|thanks? (?:for|you)|thank you|(?:nice|good|great|lovely|pleased) to (?:meet|talk|speak|connect|e-?meet)|glad (?:to|you))\b/i;

/** A first message that greets the seller (the opening must not jump straight to a question). */
export function hasWelcome(message: string): boolean {
  const spans = splitSentences(message.trim());
  return !!spans[0] && GREETING_RE.test(spans[0].text);
}

const MATERIALS_READ_RE = /\b(?:i'?ve|i have|i) (?:already )?(?:read|reviewed|gone through|been through|looked (?:at|through)|had a (?:look|chance to (?:read|review)))\b/i;

// "I'm here to help build the document buyers will read about Clearwater" —
// the purpose line of a first contact.
const PURPOSE_RE =
  /\b(?:i'?m here to|here to help|help (?:you )?(?:build|put together|pull together|prepare)|the document (?:that )?buyers|what buyers will (?:read|see)|this conversation (?:is|will))\b/i;

/**
 * The opening message: the welcome, the purpose line and "I've read your
 * materials" are never run through the filler guard — "thanks for" is
 * filler mid-interview but a greeting on first contact (QA harvest: openings
 * arrived with the welcome stripped, straight into a mid-priority question).
 * Anything else in front of the question is held to the usual rule. An
 * opening that still has no greeting gets a short one.
 */
export function finalizeOpeningMessage(message: string): string {
  const text = message.trim();
  const spans = splitSentences(text);
  const q = spans.findIndex((sp) => sp.text.includes("?"));
  const end = q < 0 ? spans.length : q;
  const cut = new Set<number>();
  for (let i = 0; i < end; i++) {
    const sentence = spans[i].text;
    if (GREETING_RE.test(sentence) || MATERIALS_READ_RE.test(sentence) || PURPOSE_RE.test(sentence)) continue;
    if (isFillerSentence(sentence)) cut.add(i);
  }
  const out = cut.size > 0 ? rebuild(spans, cut) : text;
  return hasWelcome(out) ? out : `Welcome, and thanks for making time for this. ${out}`;
}
