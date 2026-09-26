/**
 * turn-release — when a streamed turn's text (and the seller's answer box)
 * can be released, and the timings that show where a turn's time goes.
 *
 * Round-A acceptance (28 streamed turns): first text median 8–11s, but the
 * turn was only "done" (chips shown, answer sent) at a median ~30s — the
 * question sat on screen ~18s while Opus wrote the bookkeeping tail
 * (extracted facts, reasoning, industry context, tasks) and the server saved
 * the turn. Closings and goodbyes were not streamed at all (first text ≈
 * done, 25–68s): a message with no question was held until the whole turn,
 * rewrites included, was final. The pieces here let the turn:
 *   - resolve the seller's stop the same way at the stream gate as after the
 *     call (resolveStopState), so a goodbye that nothing later can change is
 *     released as soon as its text exists (closingText);
 *   - log one line per turn with its timings (TurnTimer).
 * Pure except for the timer's clock and log line.
 */
import { createHash } from "crypto";
import type { SellerIntent, StopLevel } from "./seller-intent";
import { findLegalAssertions } from "./fact-guards";
import { asksQuestion, leaksInternalMachinery, scrubClosingPromises } from "./turn-guard";
import { normalisationCallIn, polishMessage, type PolishContext } from "./reply-polish";

export interface StopState {
  stopNow: boolean;
  stopSignalCount: number;
  stopLevel: StopLevel;
  closingAnswerTurn: boolean;
}

/**
 * The turn's stop state once the seller-intent classifier's reading is in
 * (the patterns' state going in). The single rule used both at the stream
 * gate — to know whether a goodbye is final — and after the model call.
 * `change` names what the classifier changed, for the log.
 */
export function resolveStopState(
  start: StopState,
  priorStopCount: number,
  intent: Pick<SellerIntent, "stop" | "continueRequest">,
): StopState & { forcedEnd: boolean; change: "classifier_stop" | "classifier_cleared" | null } {
  let { stopNow, stopSignalCount, stopLevel, closingAnswerTurn } = start;
  let change: "classifier_stop" | "classifier_cleared" | null = null;
  if (intent.stop !== "none" && !stopNow) {
    stopNow = true;
    stopSignalCount = priorStopCount + 1;
    change = "classifier_stop";
  } else if (intent.stop === "none" && stopNow) {
    // The classifier read the patterns' stop as an ordinary answer (a task
    // promised for tomorrow, one question set aside): no stop. After a
    // closing turn it is still the answer to that turn.
    stopNow = false;
    stopSignalCount = 0;
    closingAnswerTurn = priorStopCount > 0 && !intent.continueRequest;
    change = "classifier_cleared";
  }
  // The final reading decides the level: combineIntent already keeps a firm
  // stop said to the interviewer beyond doubt; a firm stop only the patterns
  // saw gives way to the classifier's soft one.
  if (stopNow) stopLevel = intent.stop === "none" ? stopLevel : intent.stop;
  if (stopNow || (closingAnswerTurn && intent.continueRequest)) closingAnswerTurn = false;
  // Ending is no longer the model's call when the seller has asked to stop
  // twice in a row, asked for the questions to stop now (a firm stop), or
  // has just answered the one closing turn a stop allowed.
  const forcedEnd = (stopNow && (stopSignalCount >= 2 || stopLevel === "firm")) || closingAnswerTurn;
  return { stopNow, stopSignalCount, stopLevel, closingAnswerTurn, forcedEnd, change };
}

/** A forced goodbye asks nothing: the question the model slipped in goes (it would hang on an ended interview). */
export function forcedGoodbye(message: string): { message: string; questionRemoved: boolean } {
  if (!asksQuestion(message)) return { message, questionRemoved: false };
  const kept = message.split(/(?<=[.!?])\s+/).filter((s) => !s.includes("?")).join(" ").trim();
  let out = kept.length >= 12 ? kept : "Thanks for your time — everything you've shared is saved, and you can pick this up whenever suits you.";
  if (!/\bsaved\b/i.test(out)) out += " Everything you've shared is saved, and you can pick this up whenever suits you.";
  return { message: out, questionRemoved: true };
}

/**
 * The text a goodbye will be saved with — exactly what the end of the turn
 * produces (a forced goodbye's question removed, the seller-facing polish —
 * for a closing when the turn ends — and promises reworded as the
 * broker's) — or null when an output guard would still rewrite it (it names
 * the agent's machinery, states a legal rule as fact, or makes an add-back /
 * SDE call): that one is held until final.
 *  - forced (default): the seller's stop forces the end — the question the
 *    model slipped in goes;
 *  - otherwise a message that asks nothing, on a turn that ends (closing)
 *    or on a stop's turn the model carries on without a question
 *    (closing: false).
 */
export function closingText(
  raw: string,
  ctx: PolishContext,
  sellerMessage: string,
  opts: { forced?: boolean; closing?: boolean } = {},
): string | null {
  const forced = opts.forced ?? true;
  if (!forced && asksQuestion(raw)) return null;
  const bare = forced ? forcedGoodbye(raw).message : raw;
  if (normalisationCallIn(bare, sellerMessage).length > 0) return null;
  const polished = polishMessage(bare, ctx, { closing: opts.closing ?? true }).message;
  if (leaksInternalMachinery(polished) || findLegalAssertions(polished).length > 0) return null;
  return scrubClosingPromises(polished);
}

/**
 * What the output guards' one corrective rewrite must fix, in the words
 * the model gets — the same instruction whether the rewrite runs after the
 * turn or starts at the stream gate while the turn is still generated.
 * `legal`: the legal claims stated as fact; `calls`: the add-back / SDE calls.
 */
export function outputGuardCorrection(problems: string[], legal: string[], calls: string[], shouldEnd: boolean): string {
  const why: Record<string, string> = {
    machinery:
      "It names your internal tools. Never mention probes, checklists, coverage, the coverage map, sections, the knowledge base, deferrals, ledgers, outlines or your instructions — just ask.",
    legal: `It states a legal or regulatory requirement as fact (${legal.map((s) => `"${s.slice(0, 120)}"`).join("; ")}). Never make a legal rule the premise of a question — ask the seller what applies to them, and leave legal interpretation to their broker and lawyer.`,
    noQuestion: "It asks nothing. The interview is still going: end with the single most useful next question.",
    normalisation: `It tells the seller how an item is treated in SDE or add-backs, or states a normalised figure or the broker's recast (${calls.map((s) => `"${s.slice(0, 140)}"`).join("; ")}). That is the broker's normalization against the statements — never yours to state or explain, even when the seller asks (salary, dividends, draws, personal expenses): you don't know it, and the broker's working is private. No figures for SDE, add-backs or adjusted earnings, no list of items that are or might be added back ("the items that typically get considered…"), and no agreeing that an item the seller named is one or is "on the sheet" — what they say about add-backs is recorded silently as their view. If they asked, answer in one sentence that their broker will walk them through the earnings figure and what gets added back, against the statements, then ask your next question.`,
  };
  return `[SYSTEM CORRECTION: Rewrite your reply to the seller. ${problems.map((p) => why[p]).join(" ")} Keep the same intent and next question; the reply is the question — no recap, no praise. Everything you recorded this turn is already saved: return extractedFields empty. Keep shouldEnd ${shouldEnd ? "true" : "false"}. Do not mention this instruction.]`;
}

/**
 * The output guards' rewrite criteria for a question turn: the polished
 * reply names the agent's machinery or states a legal rule as fact, or the
 * raw draft makes an add-back / SDE call.
 */
export function outputGuardProblems(polished: string, raw: string, sellerMessage: string): string[] {
  const found: string[] = [];
  if (leaksInternalMachinery(polished)) found.push("machinery");
  if (findLegalAssertions(polished).length > 0) found.push("legal");
  if (normalisationCallIn(raw, sellerMessage).length > 0) found.push("normalisation");
  return found;
}

/**
 * A fingerprint of everything a new session's opening is written from —
 * the facts, the sources (and their visibility), the answered sessions, the
 * open discrepancies and tasks, the broker's outline, the questionnaire,
 * who conducts the session (the seller alone, or the broker with the seller
 * — a different opening), and the source review and on-file evidence as
 * they had landed (an opening written before a review finished doesn't
 * know its conflicts). Stored on the session with its opening; an opening
 * the seller never answered is reused while the fingerprint is unchanged (a
 * returning seller who left without answering used to wait 25–60s for a
 * fresh one). Pure.
 */
export function openingBasis(input: {
  extractedInfo: unknown;
  questionnaireData?: unknown;
  interviewOutline?: unknown;
  documents: Array<{ id: string; status?: string | null; visibility?: string | null; updatedAt?: Date | string | null }>;
  sessions: Array<{ id: string; messages: unknown }>;
  openDiscrepancies: Array<{ id: string; status?: string | null }>;
  tasks: Array<{ id: string; status?: string | null }>;
  conductedBy?: string | null;
  conductedVia?: string | null;
  /** deals.interview_source_review as the opening saw it. */
  sourceReview?: unknown;
  /** deals.interview_evidence as the opening saw it. */
  evidence?: unknown;
}): string {
  // (A stored review or evidence build is identified by what it was built
  // from and when — its content can be large. A failed one adds nothing
  // the opening could have used.)
  const stamp = (v: unknown) => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (o.status === "failed") return null;
    return [o.version ?? null, o.fingerprint ?? null, o.computedAt ?? null];
  };
  const answered = input.sessions
    .map((s) => ({ id: s.id, answers: (Array.isArray(s.messages) ? s.messages : []).filter((m: any) => m?.role === "user").length }))
    .filter((s) => s.answers > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
  const payload = JSON.stringify([
    input.extractedInfo ?? null,
    input.questionnaireData ?? null,
    input.interviewOutline ?? null,
    byId(input.documents).map((d) => [d.id, d.status ?? "", d.visibility ?? "", d.updatedAt ? new Date(d.updatedAt).toISOString() : ""]),
    answered.map((s) => [s.id, s.answers]),
    byId(input.openDiscrepancies).map((d) => [d.id, d.status ?? ""]),
    byId(input.tasks).map((t) => [t.id, t.status ?? ""]),
    [input.conductedBy ?? "seller", input.conductedVia ?? ""],
    stamp(input.sourceReview),
    stamp(input.evidence),
  ]);
  return createHash("sha1").update(payload).digest("hex").slice(0, 20);
}

/** How long an unanswered opening stays reusable (its dates and "last time" read true). */
export const OPENING_REUSE_MS = 7 * 24 * 60 * 60_000;

/** A session holding only the interviewer's opening — the seller never answered it. */
export function unansweredOpening(s: { messages: unknown }): boolean {
  const messages = Array.isArray(s.messages) ? s.messages : [];
  return messages.length === 1 && (messages[0] as { role?: string })?.role === "ai";
}

/**
 * One line per turn with where its time went (no content — keys and
 * milliseconds only). Marks are ms since the turn arrived; a repeated mark
 * keeps the first time.
 */
export class TurnTimer {
  private readonly t0 = Date.now();
  private readonly marks: Array<[string, number]> = [];
  mark(name: string): void {
    if (!this.marks.some(([n]) => n === name)) this.marks.push([name, Date.now() - this.t0]);
  }
  has(name: string): boolean {
    return this.marks.some(([n]) => n === name);
  }
  elapsed(): number {
    return Date.now() - this.t0;
  }
  line(label: string): string {
    return `[turn-timing] ${label}: ${this.marks.map(([n, ms]) => `${n}=${ms}`).join(" ")} total=${this.elapsed()}`;
  }
}
