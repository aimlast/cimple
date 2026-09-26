/**
 * seller-intent — what the seller is asking the interviewer to DO this turn:
 * stop (now, or wrap up and come back later), withdraw something they said,
 * correct it, or keep it out of the sale document.
 *
 * Regexes alone read intent badly in both directions (QA round V): they
 * missed "Please stop asking me questions." and "I'm exhausted, can we do
 * this another time?", fired on "we can finish the install next week",
 * deleted a correction together with the value it corrected ("scratch that,
 * it's 12 years not 10"), and treated "keep that out of the book" as a
 * withdrawal. So each turn is read by a small supporting-model classifier
 * (tool-forced JSON) over the interviewer's previous message, the seller's
 * message and the facts the seller gave earlier. It needs nothing the
 * interview model produces, so it runs IN PARALLEL with that call and adds
 * no latency. A few very-high-precision patterns (turn-guard.ts stop
 * phrases, fact-guards.ts retraction / correction / privacy forms) are the
 * instant path — the stop nudge is in the first prompt when they fire — and
 * the fallback when the classifier fails or is late.
 *
 * Semantics (planIntentEdits):
 * - a CORRECTION keeps the new value — this turn's value for that fact is
 *   never dropped, and nothing is withdrawn;
 * - a RETRACTION withdraws exactly the claim withdrawn — inside a fact that
 *   also holds true content only that part goes — and nothing unrelated;
 * - a PRIVACY REQUEST moves the detail to the broker's private notes and
 *   keeps it out of the facts; it never deletes any other fact.
 */
import Anthropic from "@anthropic-ai/sdk";
import { agentConfig } from "./config/load-config";
import { detectStopSignal, detectFirmStop, firmStopLevel, sellerDeclinedWrapUp, sellerAskedQuestion } from "./turn-guard";
import {
  detectRetraction,
  detectCorrection,
  detectPrivacyRequest,
  guessRetractedFields,
  removeClaim,
  restatesWithdrawnValue,
  termRegex,
  claimYearsInMap,
  type Retraction,
} from "./fact-guards";
import { canonicalFieldName, getFieldSources, isLiveSellerKind, resolvedYearSources, type FieldChange } from "./info-merger";
import {
  SELLER_KEEP_OUT_REASON,
  carriesPrivateDetail,
  cutPrivateDetail,
  distinctivePrivateTerms,
  planKeepOutCuts,
  type SellerKeepOutEntry,
} from "./seller-keep-out";

export type StopLevel = "none" | "soft" | "firm";

export interface IntentRetraction {
  /** The withdrawn claim, in a few words ("~40 trucks"). */
  what: string;
  /** The key on file holding it, as the classifier read it. */
  fieldHint?: string;
  /** That fact without the claim ("" = the whole fact is the claim). */
  remainingValue?: string | null;
}
export interface IntentCorrection {
  old: string;
  new: string;
  fieldHint?: string;
  /** That fact's full value with the correction applied. */
  correctedValue?: string | null;
}
export interface IntentPrivacy {
  what: string;
  /** The private detail itself, in the seller's words — the broker's note. */
  detail: string;
  /** Words that must not reach the document ("cancer", "diagnosis"). */
  sensitiveTerms: string[];
  fieldHint?: string;
  remainingValue?: string | null;
}

export interface SellerIntent {
  stop: StopLevel;
  /** The seller says they want to keep going now ("let's keep going"). */
  continueRequest: boolean;
  /** A direct question the seller asked the interviewer, verbatim ("" if none). */
  sellerQuestion: string;
  retractions: IntentRetraction[];
  corrections: IntentCorrection[];
  privacyRequests: IntentPrivacy[];
  /** "model": the classifier read the turn; "patterns": the instant patterns only. */
  via: "model" | "patterns";
  /**
   * A firm stop said to the interviewer beyond doubt ("Stop.", "Please stop
   * asking me questions", "No more questions for today") — it stands against
   * the classifier. A firm stop the patterns are less sure of doesn't.
   */
  firmStopStands?: boolean;
}

// =====================
// Instant path (patterns)
// =====================

/**
 * The high-precision patterns' reading of the turn. Used before the
 * interview call (so a clear stop is in the first prompt) and as the whole
 * answer when the classifier fails. Precision over recall: a business
 * sentence must never read as a stop, a withdrawal or a privacy request.
 */
export function quickIntent(sellerMessage: string, prevAiMessage?: string): SellerIntent {
  const correction = detectCorrection(sellerMessage);
  const privacy = detectPrivacyRequest(sellerMessage);
  const firm = firmStopLevel(sellerMessage);
  const stop: StopLevel = firm ? "firm" : detectStopSignal(sellerMessage, prevAiMessage) ? "soft" : "none";
  return {
    stop,
    firmStopStands: firm === "stands",
    continueRequest: sellerDeclinedWrapUp(prevAiMessage, sellerMessage),
    sellerQuestion: sellerQuestionFromMessage(sellerMessage),
    retractions: detectRetraction(sellerMessage) && !correction && !privacy ? [{ what: sellerMessage.trim().slice(0, 300) }] : [],
    corrections: correction ? [{ old: "", new: "" }] : [],
    privacyRequests: privacy ? [{ what: "", detail: privateDetailFromMessage(sellerMessage), sensitiveTerms: [] }] : [],
    via: "patterns",
  };
}

/**
 * The seller's own question to the interviewer, verbatim — not the stop
 * request itself ("Can we wrap this up here? … Before I go, is there one
 * thing you most need from me?" → the second). A hedge ("maybe $1.3M?") is
 * not a question. The stop nudge in the FIRST prompt quotes it, so a stop
 * the patterns catch still gets the seller's question answered (Beacon: it
 * was brushed off with "we can cover that next time").
 */
export function sellerQuestionFromMessage(sellerMessage: string): string {
  const segments = (sellerMessage.replace(/[’‘]/g, "'").match(/[^.!?\n]*\?/g) ?? []).map((q) => q.trim()).filter(Boolean);
  const asked = segments.filter((q) => {
    if (detectStopSignal(q) || detectFirmStop(q)) return false;
    // "Before I go, is there one thing…?" — the question may follow a lead-in clause.
    const tails = q.split(/,\s+|\s+[—–]\s+/).map((_, i, all) => all.slice(i).join(", "));
    return tails.some((t) => sellerAskedQuestion(t));
  });
  return asked.join(" ").slice(0, 300);
}

/** The disclosure in a privacy request, without the request itself. */
export function privateDetailFromMessage(sellerMessage: string): string {
  const sentences = sellerMessage.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const kept = sentences
    .map((s) =>
      s
        .replace(/[,;—–-]?\s*(?:but |and |so |just |please |honestly )*(?:(?:please )?(?:keep|leave) (?:that|this|it|those|them)(?: part| bit)? (?:out|off)|(?:please )?(?:don'?t|do not|never) (?:put|write|include|mention|share) (?:that|this|it|those|them)[^.!?]*|that'?s (?:just )?between (?:us|you and me)|off the record)[^.!?]*[.!?]?\s*$/i, "")
        .trim(),
    )
    .filter((s) => s.length > 0 && !/^(?:please|thanks|ok|okay)\W*$/i.test(s));
  return (kept.join(" ") || sellerMessage).trim().slice(0, 400);
}

/**
 * The turn's intent: the classifier's reading when there is one, the
 * patterns' otherwise.
 *
 * On a stop, the classifier's reading decides — it reads the whole message
 * in the light of the question asked, which no pattern can: a soft stop the
 * patterns saw is withdrawn when the classifier reads the turn as carrying
 * on (round-2 review: "Yes, I'll do that tomorrow" to "could you upload the
 * lease?", and "Can I come back to this after I talk to her?", ended
 * interviews because the stronger reading always won). A false stop then
 * needs BOTH readers to be wrong. A firm stop said to the interviewer
 * beyond doubt ("Please stop asking me questions.", "Stop.") stands —
 * nothing else reads that way; any other pattern stop, firm ones included
 * ("I'm tired, no more questions."), gives way to the classifier's reading
 * (review RV-INT-1: a firm reading of "…that's it, no more questions" used
 * to overrule the classifier and force-end the interview). Without a
 * classifier verdict the patterns decide.
 */
export function combineIntent(quick: SellerIntent, model: SellerIntent | null): SellerIntent {
  if (!model) return quick;
  const stands = quick.stop === "firm" && !!quick.firmStopStands;
  const stop: StopLevel = stands ? "firm" : model.stop;
  return {
    ...model,
    stop,
    firmStopStands: stands,
    sellerQuestion: model.sellerQuestion || quick.sellerQuestion,
    continueRequest: stop === "none" ? model.continueRequest || quick.continueRequest : model.continueRequest,
    via: "model",
  };
}

// =====================
// Classifier
// =====================

const INTENT_TOOL = {
  name: "seller_intent",
  description: "Record what the seller is asking the interviewer to do this turn.",
  input_schema: {
    type: "object" as const,
    required: ["stop", "continueRequest", "sellerQuestion", "retractions", "corrections", "privacyRequests"],
    properties: {
      stop: { type: "string", enum: ["none", "soft", "firm"] },
      continueRequest: { type: "boolean" },
      sellerQuestion: { type: "string", description: "A direct question the seller asked the interviewer in this message, verbatim; empty if none." },
      retractions: {
        type: "array",
        items: {
          type: "object",
          required: ["what", "fieldHint", "remainingValue"],
          properties: {
            what: { type: "string" },
            fieldHint: { type: "string" },
            remainingValue: { type: "string" },
          },
        },
      },
      corrections: {
        type: "array",
        items: {
          type: "object",
          required: ["old", "new", "fieldHint", "correctedValue"],
          properties: {
            old: { type: "string" },
            new: { type: "string" },
            fieldHint: { type: "string" },
            correctedValue: { type: "string" },
          },
        },
      },
      privacyRequests: {
        type: "array",
        items: {
          type: "object",
          required: ["what", "detail", "sensitiveTerms", "fieldHint", "remainingValue"],
          properties: {
            what: { type: "string" },
            detail: { type: "string" },
            sensitiveTerms: { type: "array", items: { type: "string" } },
            fieldHint: { type: "string" },
            remainingValue: { type: "string" },
          },
        },
      },
    },
  },
};

const INTENT_SYSTEM = `You read one turn of an interview between an AI interviewer and a business owner (the seller) who is selling their business. The interviewer is collecting facts for the sale document (the "book"). Decide what the SELLER is asking the interviewer to do with this conversation and with what they said. Read the seller's message in the light of the interviewer's previous message.

Descriptions of the business are never requests. When the seller talks about what the business, its staff or its customers do — "we stop taking orders at 9", "if the unit arrives late we can finish the install next week", "customers stop asking for discounts once they see the warranty", "I have to go to the supplier every Monday", "we take the old units back", "that's enough to cover payroll", "the bank had no more questions" — that is not a stop, not a withdrawal, not a privacy request.

stop:
- "none": carry on. Includes any business description that mentions stopping, finishing, leaving or later; a short or tired-sounding answer that still answers; "nothing else on the lease" answering a question about the lease. Also "none":
  - a promise to do a TASK later — usually answering a request for a document or a check: "Yes, I'll do that tomorrow" (asked to upload the lease), "I'll finish it tomorrow and send it over", "I'll get back to it tomorrow, Donna has the rate letters", "I can get back to you on that Monday";
  - setting ONE question aside to check something, which leaves the rest of the interview going: "Can I come back to this after I check with my accountant?", "Could we come back to this once I have the lease in front of me?", "Can I come back to this one later? I'd need Donna's numbers".
- "soft": the seller wants to end THIS SESSION now or continue the whole conversation another time — "can we wrap this up?", "I have to run", "sorry, have to go to a meeting", "can we pick this up tomorrow?", "I'm exhausted, can we do this another time?", "my head's spinning — can I come back to this after the weekend?", "I think that's enough for one day", "I'll finish this tomorrow" (said of the interview, with no task in play), "I can't do any more today" — or accepts the interviewer's offer to wrap up ("that covers it" after "anything else before we wrap up?"). If it is unclear whether "this" is one question or the whole session, and the seller gives no sign of wanting to leave (tired, busy, another commitment, "for today"), it is "none".
- "firm": they want the questions to stop right now, with no closing question — "please stop asking me questions", "no more questions", "Stop.", "I'm done, I'm not answering anything else", or clear annoyance at being asked more.

continueRequest: true only when the seller says they want to keep going now ("let's keep going", "I've got a few more minutes", "sure, what else do you need?").

sellerQuestion: a direct question the seller asks the interviewer in this message, copied verbatim ("Before I go, is there one thing you most need from me?"); "" if none. A hedge like "maybe $1.3M?" is not a question.

retractions — the seller WITHDRAWS something they said earlier and gives no replacement: "ignore what I said about 40 trucks, I was guessing — I don't know the count", "let me take those mold numbers back, Rob has the real list", "that was just a guess". For each withdrawn claim:
  what: the claim in a few words ("~40 trucks");
  fieldHint: the key in FACTS THE SELLER GAVE EARLIER that holds it, exactly as listed ("" if none holds it);
  remainingValue: if that fact also holds other content the seller did NOT withdraw, the fact's value with only the withdrawn claim removed (keep the rest word for word); "" if the whole fact is the withdrawn claim or there is no such fact.
corrections — the seller REPLACES a value with a new one: "scratch that, the lease is 12 years not 10", "sorry, I misspoke, we have 14 employees not 12", "no no, it's 9 trucks", "make that $2.4M". For each:
  old / new: the old and the new value;
  fieldHint: the key on file holding the old value ("" if none);
  correctedValue: that fact's full value with the correction applied, everything else word for word ("" if no fact holds it).
  A correction is never a retraction — list it only under corrections.
privacyRequests — the seller asks that something stay out of the sale document or private: "keep that out of the book", "don't put that in the document", "that's between us", "off the record". For each:
  what: the topic in a few words;
  detail: the private detail itself in the seller's words, written as a short note for their broker ("The real reason for sale is his wife's cancer diagnosis");
  sensitiveTerms: the specific words or short phrases, as the seller said them, that give the private detail away ("cancer", "heart attack", "Kestrel Systems") — never an everyday word the business also uses ("health", "doctor", "patient", "diagnosis", "customer", "contract", "bid"), which would keep ordinary answers out of the document;
  fieldHint: a key on file that already holds the private detail ("" if none);
  remainingValue: that fact without the private detail ("" if nothing public is left or there is no such fact).
  A privacy request is never a retraction — the information stays with the broker, just out of the document.

Most turns: stop "none" and every list empty.`;

let client: Anthropic | null = null;

export interface IntentInput {
  sellerMessage: string;
  prevAiMessage?: string;
  /** The seller's message before prevAiMessage (what "that" may point at). */
  prevSellerMessage?: string;
  /** Facts the seller gave in their own words (key → value), most recent first. */
  recentFacts: Array<{ key: string; value: string }>;
}

/** What the classifier sees (exported for the live evaluation). */
export function intentPrompt(input: IntentInput): string {
  const facts = input.recentFacts.length
    ? input.recentFacts.map((f) => `- ${f.key}: ${f.value.replace(/\s+/g, " ").slice(0, 500)}`).join("\n")
    : "(none)";
  return (
    `FACTS THE SELLER GAVE EARLIER (key: value):\n${facts}\n\n` +
    (input.prevSellerMessage ? `SELLER'S EARLIER MESSAGE:\n${input.prevSellerMessage.slice(0, 1500)}\n\n` : "") +
    `INTERVIEWER'S PREVIOUS MESSAGE:\n${(input.prevAiMessage ?? "(start of the interview)").slice(0, 1500)}\n\n` +
    `SELLER'S NEW MESSAGE:\n${input.sellerMessage.slice(0, 4000)}`
  );
}

/** How long the classifier may take before the turn goes on with the patterns' reading. */
export const INTENT_TIMEOUT_MS = 12_000;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];

/** Normalises the classifier's tool input (exported for tests). */
export function parseIntent(raw: unknown): SellerIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const stop = r.stop === "soft" || r.stop === "firm" ? r.stop : r.stop === "none" ? "none" : null;
  if (!stop) return null;
  return {
    stop,
    continueRequest: r.continueRequest === true,
    sellerQuestion: str(r.sellerQuestion),
    retractions: arr(r.retractions)
      .map((x) => ({ what: str(x.what), fieldHint: str(x.fieldHint) || undefined, remainingValue: typeof x.remainingValue === "string" ? x.remainingValue.trim() : null }))
      .filter((x) => x.what),
    corrections: arr(r.corrections)
      .map((x) => ({ old: str(x.old), new: str(x.new), fieldHint: str(x.fieldHint) || undefined, correctedValue: str(x.correctedValue) || null }))
      .filter((x) => x.new),
    privacyRequests: arr(r.privacyRequests)
      .map((x) => ({
        what: str(x.what),
        detail: str(x.detail),
        sensitiveTerms: Array.isArray(x.sensitiveTerms) ? x.sensitiveTerms.map(str).filter((t) => !!termRegex(t)) : [],
        fieldHint: str(x.fieldHint) || undefined,
        remainingValue: typeof x.remainingValue === "string" ? x.remainingValue.trim() : null,
      }))
      .filter((x) => x.detail || x.what),
    via: "model",
  };
}

/**
 * The supporting model's reading of the turn. Null when it fails or takes
 * longer than `timeoutMs` — the patterns decide then.
 */
export async function classifySellerIntent(input: IntentInput, timeoutMs = INTENT_TIMEOUT_MS): Promise<SellerIntent | null> {
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const call = client.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 1500,
    temperature: 0,
    tools: [INTENT_TOOL],
    tool_choice: { type: "tool", name: "seller_intent" },
    // (The same instructions every turn — served from the prompt cache.)
    system: [{ type: "text", text: INTENT_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: intentPrompt(input) }],
  });
  call.catch(() => {}); // a late failure after the timeout is not an unhandled rejection
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    const res = await Promise.race([call, timeout]);
    if (!res) {
      console.warn("[seller-intent] classifier timed out — using the patterns");
      return null;
    }
    const block = res.content.find((b) => b.type === "tool_use");
    const parsed = parseIntent(block && block.type === "tool_use" ? block.input : null);
    if (!parsed) console.warn("[seller-intent] classifier returned nothing usable — using the patterns");
    return parsed;
  } catch (err: any) {
    console.warn("[seller-intent] classifier failed — using the patterns:", err?.message || err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Facts the seller gave in their own live words (interview, call, video
 * call), most recent first — what a withdrawal or a correction can be about.
 * Read from the seller-safe view only.
 */
export function sellerSpokenFacts(view: Record<string, unknown>, limit = 60): Array<{ key: string; value: string }> {
  const sources = getFieldSources(view);
  return Object.entries(view)
    .filter(([k, v]) => !k.startsWith("_") && v !== null && v !== undefined && v !== "" && isLiveSellerKind(sources[k]?.source))
    .sort(([a], [b]) => String(sources[b]?.at ?? "").localeCompare(String(sources[a]?.at ?? "")) || (sources[b]?.turn ?? 0) - (sources[a]?.turn ?? 0))
    .slice(0, limit)
    .map(([key, v]) => ({ key, value: typeof v === "string" ? v : JSON.stringify(v) }));
}

// =====================
// What the intent does to the facts
// =====================

export interface PartialEdit {
  key: string;
  /** The value on file the edit was planned against (applied only if it is still that). */
  from: string;
  /** The value to keep; "" removes the fact. */
  to: string;
  /** What came out. */
  removed: string;
  /** withdrawn by the seller, or moved to the broker's private notes. */
  kind: "withdrawn" | "private";
}

export interface IntentPlan {
  changes: FieldChange[];
  /** Whole facts the seller withdrew (applySellerRetractions). */
  retractions: Retraction[];
  /** A claim taken out of a fact that also holds true content, or a private detail moved out. */
  partialEdits: PartialEdit[];
  /** Broker-private notes to add. */
  privateNotes: Array<{ note: string; reason: string }>;
  /** Withdrawn claims no fact on file holds (still remembered, still followed up). */
  unrecordedWithdrawals: string[];
  /** Keys this turn corrected (never withdrawn, never blocked later as a withdrawn value). */
  correctedKeys: string[];
  /** The privacy requests, kept on the deal (seller-keep-out.ts) — screened in every fact and held out of every CIM. */
  keepOut: SellerKeepOutEntry[];
  /** The requests' specific terms (the session's later turns won't record them). */
  keptPrivateTerms: string[];
  /** Keys, counts and kinds only — never what the seller said (PRIV-V-3: these go to the server log). */
  log: string[];
}

export interface IntentPlanInput {
  intent: SellerIntent;
  /** The deal's facts before this turn. */
  info: Record<string, unknown>;
  /** This turn's changes (as merged). */
  changes: FieldChange[];
  /** retractedFields the interview model listed. */
  modelRetracted: Array<{ field: string; reason: string }>;
  /** privateNotes the interview model wrote. */
  modelPrivateNotes: Array<{ note: string; reason: string }>;
  sellerMessage: string;
  sessionId: string;
  turn: number;
  /** Confidence on file per key (a correction written for the model keeps it). */
  confidenceLevels?: Record<string, string>;
  /** The seller's previous message (what "keep that out" may point back to). */
  prevSellerMessage?: string;
}

const valueText = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v));
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9$][a-z0-9$.,%'-]*/g) ?? []).map((w) => w.replace(/[.,]+$/, "")));

/** "12 years" is in "Lease runs 12 years from 2019": every word of the new value appears in the corrected one. */
function carries(correctedValue: string, newValue: string): boolean {
  const need = Array.from(words(newValue)).filter((w) => w.length > 1 && !/^(?:the|a|an|of|and|or|not|it's|its|is|are|we|have|about|around)$/.test(w));
  const have = words(correctedValue);
  return need.length > 0 && need.every((w) => have.has(w) || Array.from(have).some((h) => h.replace(/,/g, "") === w.replace(/,/g, "")));
}

const isPlainMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Turns the turn's intent into edits of the facts. Pure: returns the
 * changes to keep (a correction's value always stays; a value carrying a
 * detail the seller asked kept private never lands), the whole facts to
 * withdraw, the partial edits (a withdrawn claim inside a fact, a private
 * detail moved out of one), and the private notes to add.
 */
export function planIntentEdits(input: IntentPlanInput): IntentPlan {
  const { intent, info, sellerMessage } = input;
  let changes = [...input.changes];
  const log: string[] = [];
  const keys = Object.keys(info);
  const sources = getFieldSources(info);
  const hasValue = (k: string) => info[k] !== undefined && info[k] !== null && info[k] !== "";
  const live = (k: string) => hasValue(k) && isLiveSellerKind(sources[k]?.source);
  const resolve = (hint?: string): string | null => {
    if (!hint) return null;
    const k = canonicalFieldName(hint, keys);
    const key = hasValue(k) ? k : hasValue(hint) ? hint : null;
    return key && !key.startsWith("_") ? key : null;
  };
  const changed = (k: string) => changes.some((c) => c.fieldName === k);

  // ── Corrections: the new value stands ──
  const correctedKeys = new Set<string>();
  for (const c of intent.corrections) {
    const key = resolve(c.fieldHint);
    if (!key) continue;
    if (changed(key)) {
      correctedKeys.add(key);
      continue;
    }
    // The interview model recorded nothing for it (or withdrew it): write
    // the corrected value — only when it really carries the new value.
    const corrected = (c.correctedValue ?? "").trim();
    if (corrected && corrected !== valueText(info[key]).trim() && c.new && carries(corrected, c.new)) {
      changes.push({
        fieldName: key,
        previousValue: valueText(info[key]),
        previousConfidence: input.confidenceLevels?.[key] ?? null,
        newValue: corrected,
        newConfidence: "confirmed",
        source: "seller_statement",
      });
      correctedKeys.add(key);
      log.push(`correction written for ${key}`);
    }
  }
  // A key the interview model withdrew but also gave a new value for this
  // turn is a correction, not a withdrawal (QA round V: "scratch that, it's
  // 12 years not 10" deleted both).
  for (const r of input.modelRetracted) {
    const key = canonicalFieldName(r.field, keys);
    if (changed(key)) correctedKeys.add(key);
  }

  // ── Retractions ──
  const retractions: Retraction[] = [];
  const partialEdits: PartialEdit[] = [];
  const unrecordedWithdrawals: string[] = [];
  const withdraw = (key: string, reason: string) => {
    if (correctedKeys.has(key) || retractions.some((r) => r.field === key) || partialEdits.some((p) => p.key === key)) return;
    retractions.push({ field: key, reason });
  };
  if (intent.via === "model") {
    const modelKeys = input.modelRetracted.map((r) => canonicalFieldName(r.field, keys)).filter(live);
    for (const r of intent.retractions) {
      const candidates: string[] = [];
      const hinted = resolve(r.fieldHint);
      // A withdrawal only ever touches the seller's own words. A hint at a
      // document's fact is the document's: nothing is withdrawn, and no
      // other fact is searched instead.
      if (hinted) {
        if (live(hinted)) candidates.push(hinted);
      } else {
        // The interview model's named key, else the seller's facts from this
        // session that hold the claim — its figure AND what it counts
        // (removeClaim), so a withdrawn "40 trucks" never finds "40 hours a
        // week" (round-2 review). An empty hint usually means the claim was
        // never recorded: the AI probed it against a document instead.
        const holding = (k: string) => removeClaim(valueText(info[k]), r.what) !== null;
        const named = modelKeys.filter(holding);
        if (named.length > 0) candidates.push(...named);
        else {
          const pool = keys.filter((k) => !k.startsWith("_") && live(k) && sources[k]?.sessionId === input.sessionId && holding(k));
          const latest = Math.max(-1, ...pool.map((k) => sources[k]?.turn ?? 0));
          candidates.push(...pool.filter((k) => (sources[k]?.turn ?? 0) === latest));
        }
      }
      const targets = candidates.filter((k) => !correctedKeys.has(k));
      if (targets.length === 0) {
        unrecordedWithdrawals.push(r.what);
        log.push("a withdrawn claim no fact on file holds");
        continue;
      }
      for (const key of targets) {
        // The interview model rewrote the fact this turn: its new value is
        // what gets checked — already without the claim, it stands.
        const ch = changes.find((c) => c.fieldName === key);
        const onFile = valueText(info[key]);
        if (ch) {
          const restNew = removeClaim(ch.newValue, r.what);
          // A claim named without its figures ("those mold numbers") can't be
          // found by them — a new value that repeats the withdrawn figures
          // (and the seller didn't say them again) is the guess again.
          const restated =
            restNew === null && !/\d/.test(r.what) && /\d/.test(ch.newValue) && !!onFile &&
            restatesWithdrawnValue(ch.newValue, onFile, sellerMessage);
          if (restated) {
            changes = changes.filter((c) => c !== ch);
          } else if (restNew === null) {
            log.push(`${key}: this turn's value already leaves the withdrawn claim out`);
            continue;
          } else if (restNew !== "") {
            ch.newValue = restNew;
            log.push(`${key}: the withdrawn claim was taken out of this turn's value`);
            continue;
          } else {
            changes = changes.filter((c) => c !== ch);
          }
        }
        // A by-year map (revenueByYear): only the year(s) the claim is about,
        // and only a year the seller stated — never the statements' years
        // (review R2: the whole map, statement years included, went).
        if (isPlainMap(info[key])) {
          const map = info[key] as Record<string, unknown>;
          const ys = resolvedYearSources(sources[key], map);
          const named = claimYearsInMap(r.what, map);
          const all = Object.keys(map);
          const sellerYears = (named.length > 0 ? named : all).filter((y) => isLiveSellerKind(ys[y]?.source));
          if (sellerYears.length === 0 || (named.length === 0 && sellerYears.length !== all.length)) {
            log.push(`${key}: couldn't tell which of the seller's years was withdrawn — left alone`);
            continue;
          }
          if (!correctedKeys.has(key) && !retractions.some((x) => x.field === key)) {
            retractions.push({ field: key, reason: `withdrew "${r.what}"`, years: sellerYears });
            log.push(`${key}: ${sellerYears.length} year(s) withdrawn`);
          }
          continue;
        }
        const value = valueText(info[key]);
        const rest = removeClaim(value, r.what, key === hinted ? r.remainingValue : undefined);
        if (rest === "" || (rest === null && key === hinted && !(r.remainingValue ?? "").trim())) {
          withdraw(key, `withdrew "${r.what}"`);
        } else if (rest !== null) {
          partialEdits.push({ key, from: value, to: rest, removed: r.what, kind: "withdrawn" });
          log.push(`part of ${key} withdrawn`);
        } else {
          log.push(`couldn't find the withdrawn claim in ${key} — left alone`);
        }
      }
    }
    const ignored = input.modelRetracted.filter((r) => {
      const k = canonicalFieldName(r.field, keys);
      return !correctedKeys.has(k) && !retractions.some((x) => x.field === k) && !partialEdits.some((p) => p.key === k);
    });
    if (ignored.length > 0 && intent.retractions.length === 0) {
      log.push(`the interview model withdrew ${ignored.map((r) => r.field).join(", ")} but the seller withdrew nothing — kept`);
    }
  } else if (intent.retractions.length > 0) {
    // Patterns only: the interview model's named keys (live, not corrected),
    // else the previous answer's fact the withdrawal talks about.
    const named = input.modelRetracted
      .map((r) => ({ field: canonicalFieldName(r.field, keys), reason: r.reason }))
      .filter((r) => live(r.field) && !correctedKeys.has(r.field));
    if (named.length > 0) for (const r of named) withdraw(r.field, r.reason || "the seller withdrew it");
    else {
      for (const k of guessRetractedFields(info, sellerMessage, { sessionId: input.sessionId, turn: input.turn })) {
        withdraw(k, "the seller withdrew their previous answer");
      }
      if (retractions.length > 0) log.push(`model named no field — withdrawing ${retractions.map((r) => r.field).join(", ")} from the seller's previous answer`);
    }
  }
  // Nothing withdrawn is written again this turn.
  const gone = new Set([...retractions.map((r) => r.field), ...partialEdits.map((p) => p.key)]);
  changes = changes.filter((c) => !gone.has(c.fieldName) || correctedKeys.has(c.fieldName));

  // ── Privacy requests: to the broker, out of the facts ──
  // Scoped to the disclosure (review RV-INT-3): only the classifier's terms
  // the seller really said, that are part of the detail and specific enough
  // to stand for it ("heart attack", not "health") — a physio clinic's
  // "extended health insurance" payer mix is not the owner's heart attack.
  // Kept on the deal (PRIV-V-2): every fact in the seller's own words that
  // carries the detail is cut, not only the one the classifier hinted at,
  // and the request is an explicit hold for every CIM (keepOut).
  const privateNotes: Array<{ note: string; reason: string }> = [];
  const keepOut: SellerKeepOutEntry[] = [];
  const saidText = `${sellerMessage}\n${input.prevSellerMessage ?? ""}`;
  const noteText = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.!\s]+$/, "").trim();
  const noteCovers = (entry: SellerKeepOutEntry) =>
    !entry.detail ||
    [...input.modelPrivateNotes, ...privateNotes].some((n) =>
      entry.terms.length > 0 ? carriesPrivateDetail(n.note, entry) : n.note.trim().length > 0,
    );
  const addNote = (note: string) => {
    if ([...input.modelPrivateNotes, ...privateNotes].some((n) => noteText(n.note) === noteText(note))) return;
    privateNotes.push({ note, reason: SELLER_KEEP_OUT_REASON });
  };
  for (const p of intent.privacyRequests) {
    const detail = (p.detail || p.what).trim();
    const entry: SellerKeepOutEntry = {
      detail,
      terms: distinctivePrivateTerms(p.sensitiveTerms, saidText, detail),
      turn: input.turn,
      sessionId: input.sessionId,
    };
    if (detail) keepOut.push(entry);
    if (!noteCovers(entry)) {
      addNote(detail);
      log.push("private note added");
    }
    // This turn's values: the private detail never lands. A value replacing
    // one on file isn't written (the value on file — "Retirement after 30
    // years" — stays, rather than a remnant of the rewrite); a new fact keeps
    // its other sentences, and a list is never cut in the middle — the whole
    // value is held back instead. Nothing disappears silently: a held-back
    // value that says more than the detail goes to the broker's notes.
    for (const c of changes.filter((x) => carriesPrivateDetail(x.newValue, entry))) {
      const replacing = hasValue(c.fieldName);
      const rest = replacing ? "" : cutPrivateDetail(c.newValue, entry);
      if (rest) {
        c.newValue = rest;
        log.push(`kept private: the detail was cut from ${c.fieldName}`);
      } else {
        changes = changes.filter((x) => x !== c);
        if ((c.newValue.match(/\S+/g) ?? []).length > 8) addNote(`${c.fieldName}: ${c.newValue}`);
        log.push(`kept private (not written): ${c.fieldName}`);
      }
    }
    // A fact already on file that holds the detail: the detail moves out.
    // The hinted one by the classifier's own rewrite (checked by
    // removeClaim); every other fact in the seller's own words by whole
    // sentences. A document's fact stays as the document says it — the CIM
    // keep-out holds the detail there.
    const key = resolve(p.fieldHint);
    const moved = new Set<string>();
    if (key && !changed(key) && !gone.has(key)) {
      const value = valueText(info[key]);
      const rest = entry.terms.length > 0
        ? removeClaim(value, detail, p.remainingValue, entry.terms, { termsOnly: true })
        : live(key) ? cutPrivateDetail(value, entry) : null;
      if (rest !== null && rest !== value) {
        partialEdits.push({ key, from: value, to: rest, removed: detail, kind: "private" });
        moved.add(key);
      }
    }
    const skip = new Set<string>([...Array.from(moved), ...(key ? [key] : []), ...Array.from(gone), ...changes.map((c) => c.fieldName), ...partialEdits.map((e) => e.key)]);
    for (const cut of planKeepOutCuts(info, [entry], { skip })) {
      partialEdits.push({ key: cut.key, from: cut.from, to: cut.to, removed: detail, kind: "private" });
      moved.add(cut.key);
    }
    if (moved.size > 0) log.push(`private detail moved out of ${Array.from(moved).join(", ")} (kept in the broker's private notes)`);
  }

  return {
    changes,
    retractions,
    partialEdits,
    privateNotes,
    unrecordedWithdrawals,
    correctedKeys: Array.from(correctedKeys),
    keepOut,
    keptPrivateTerms: Array.from(new Set(keepOut.flatMap((e) => e.terms))),
    log,
  };
}

/**
 * Applies the partial edits to the facts as they are NOW (under the facts
 * lock): only where the value is still the one the edit was planned
 * against. "" removes the fact (its source goes too). Returns the keys
 * edited. Mutates `info`.
 */
export function applyPartialEdits(info: Record<string, unknown>, edits: PartialEdit[]): string[] {
  const done: string[] = [];
  for (const e of edits) {
    if (valueText(info[e.key]).trim() !== e.from.trim()) continue;
    if (e.to === "") {
      delete info[e.key];
      const sources = { ...getFieldSources(info) };
      delete sources[e.key];
      info["_fieldSources"] = sources;
    } else {
      info[e.key] = e.to;
    }
    done.push(e.key);
  }
  return done;
}
