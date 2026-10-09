/**
 * The chunker (specs/together.md §5.3): when does a part of the conversation
 * get read and filed?
 *
 * Pure: `decideChunk(state, event, now)` returns the new state, the parts to
 * close and when to look again. The pipeline (pipeline.ts) holds one state
 * per sitting, arms the timer and turns each closed part into a chunk row.
 *
 *  - An ANSWER WORD is a word in a seller or unknown-speaker line that isn't
 *    thinking aloud ("hmm, let me think").
 *  - TURN CHANGE: a broker line of ≥ 4 words or one ending in "?", after ≥ 4
 *    answer words since the part began, closes the part BEFORE that line
 *    (the next part starts with the broker's question). Back-channels
 *    ("mm-hmm", "right", "okay"…) are ignored.
 *  - PAUSE: 2.5 s with no new line after a seller line (≥ 1 answer word — a
 *    bare "Yes." after a question counts).
 *  - LONG ANSWER: 60 s since the part's first answer word, or 350 answer words.
 *  - "Save this answer now", pause and end close whatever is open.
 *  - ✓ Answered (focus) closes the open part for that item; with nothing open
 *    the pipeline re-reads the last few minutes for it.
 *  - Typed lines ("Add what they said…") are their own part.
 *  - A long session (the soft cap) closes parts only every 2 minutes; past
 *    the hard cap nothing closes live — the rest is filed at the end.
 *
 * Also here: who may run live filing at all (`captureEnabled`) and the lease.
 */
import { randomUUID } from "crypto";
import type { SpeakerRole } from "@shared/together";
import { isThinkingAloud } from "@shared/together-speakers";
import { TOGETHER_LIMITS } from "./limits";

export type ChunkReason = "turn_change" | "pause" | "long_answer" | "manual" | "focus" | "typed" | "end" | "backlog" | "refile" | "promote";

export interface ChunkerLine {
  seq: number;
  role: SpeakerRole;
  typed: boolean;
  text: string;
  /** ms */
  at: number;
}

export interface OpenPart {
  fromSeq: number;
  toSeq: number;
  answerWords: number;
  firstAnswerAt: number | null;
  lastLineAt: number;
  lastRole: SpeakerRole;
  /** Lines in the part (typed ones excluded — they're their own part). */
  lines: number;
}

export interface ChunkerState {
  open: OpenPart | null;
  lastCloseAt: number;
  /** 0 normally; 120 s past the soft cap (a long session). */
  throttleMs: number;
  /** Past the hard cap: nothing closes live; the rest is filed at the end. */
  held: boolean;
}

export type ChunkerEvent =
  | { type: "line"; line: ChunkerLine }
  | { type: "timer" }
  | { type: "manual" }
  | { type: "end" }
  | { type: "focus"; itemId: string };

export interface ChunkClose {
  fromSeq: number;
  toSeq: number;
  reason: ChunkReason;
  focusItemId?: string;
}

export interface ChunkDecision {
  state: ChunkerState;
  close: ChunkClose[];
  /** Look again in this many ms (null: nothing pending). */
  armTimerMs: number | null;
  /** ✓ Answered with nothing open: re-read the last few minutes for this item. */
  reread?: { focusItemId: string };
}

export function initialChunkerState(): ChunkerState {
  return { open: null, lastCloseAt: 0, throttleMs: 0, held: false };
}

const BACKCHANNEL_RE = /^(?:mm+[- ]?hmm+|uh[- ]?huh|right|okay|ok|yeah|yep|yes|sure|great|got it|i see|cool|nice|perfect|good|wow|really|exactly|true)[.!,]*$/i;

function words(text: string): number {
  return (text.trim().match(/[A-Za-z0-9$%'’.,-]+/g) ?? []).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/** Words that count as an answer (seller or unknown speaker, not thinking aloud). */
export function answerWordsOf(line: Pick<ChunkerLine, "role" | "typed" | "text">): number {
  if (line.typed) return 0;
  if (line.role !== "seller" && line.role !== "unknown") return 0;
  if (isThinkingAloud(line.text)) return 0;
  return words(line.text);
}

export function isBackchannel(text: string): boolean {
  return BACKCHANNEL_RE.test(text.trim());
}

/** A broker line that turns the conversation to the next question. */
export function isTurnChange(text: string): boolean {
  const t = text.trim();
  if (!t || isBackchannel(t)) return false;
  return words(t) >= 4 || /\?\s*$/.test(t);
}

/** At most this many lines are kept in a part nobody has answered yet (the broker talking on). */
const UNANSWERED_KEEP = 12;

function timerFor(state: ChunkerState, now: number): number | null {
  const o = state.open;
  if (!o || o.answerWords < 1 || state.held) return null;
  const due: number[] = [];
  if (o.lastRole === "seller" || o.lastRole === "unknown") due.push(o.lastLineAt + TOGETHER_LIMITS.pauseMs);
  if (o.firstAnswerAt !== null) due.push(o.firstAnswerAt + TOGETHER_LIMITS.longAnswerMs);
  if (due.length === 0) return null;
  let next = Math.min(...due);
  // (A long session: never sooner than every couple of minutes.)
  if (state.throttleMs > 0) next = Math.max(next, state.lastCloseAt + state.throttleMs);
  return Math.max(0, next - now);
}

function throttled(state: ChunkerState, now: number): boolean {
  return state.throttleMs > 0 && now - state.lastCloseAt < state.throttleMs;
}

/** The pure rule. Never mutates `state`. */
export function decideChunk(state: ChunkerState, event: ChunkerEvent, now: number): ChunkDecision {
  const s: ChunkerState = { ...state, open: state.open ? { ...state.open } : null };
  const close: ChunkClose[] = [];
  const closeOpen = (reason: ChunkReason, extra: Partial<ChunkClose> = {}) => {
    if (!s.open) return;
    close.push({ fromSeq: s.open.fromSeq, toSeq: s.open.toSeq, reason, ...extra });
    s.open = null;
    s.lastCloseAt = now;
  };

  switch (event.type) {
    case "line": {
      const l = event.line;
      if (l.typed) {
        // Typed lines are their own part (the open part is untouched).
        close.push({ fromSeq: l.seq, toSeq: l.seq, reason: "typed" });
        break;
      }
      const aw = answerWordsOf(l);
      if (l.role === "broker" && s.open && s.open.answerWords >= 4 && isTurnChange(l.text) && !s.held && !throttled(s, now)) {
        // The seller answered; the broker moves on: close BEFORE this line.
        closeOpen("turn_change");
      }
      if (!s.open) {
        s.open = { fromSeq: l.seq, toSeq: l.seq, answerWords: 0, firstAnswerAt: null, lastLineAt: now, lastRole: l.role, lines: 0 };
      }
      const o = s.open;
      o.toSeq = l.seq;
      o.lines += 1;
      o.lastLineAt = now;
      o.lastRole = l.role;
      if (aw > 0) {
        o.answerWords += aw;
        if (o.firstAnswerAt === null) o.firstAnswerAt = now;
      } else if (o.answerWords === 0 && o.lines > UNANSWERED_KEEP) {
        // Nobody has answered yet: keep only the last few lines in the part.
        o.fromSeq = Math.max(o.fromSeq, l.seq - UNANSWERED_KEEP + 1);
        o.lines = UNANSWERED_KEEP;
      }
      if (!s.held && !throttled(s, now) && o.answerWords > 0 && ((o.firstAnswerAt !== null && now - o.firstAnswerAt >= TOGETHER_LIMITS.longAnswerMs) || o.answerWords >= TOGETHER_LIMITS.longAnswerWords)) {
        closeOpen("long_answer");
      }
      break;
    }
    case "timer": {
      const o = s.open;
      if (!o || o.answerWords < 1 || s.held || throttled(s, now)) break;
      if ((o.lastRole === "seller" || o.lastRole === "unknown") && now - o.lastLineAt >= TOGETHER_LIMITS.pauseMs) closeOpen("pause");
      else if (o.firstAnswerAt !== null && now - o.firstAnswerAt >= TOGETHER_LIMITS.longAnswerMs) closeOpen("long_answer");
      break;
    }
    case "manual": {
      if (s.open && s.open.answerWords >= 1) closeOpen("manual");
      break;
    }
    case "end": {
      if (s.open && s.open.answerWords >= 1) closeOpen("end");
      else s.open = null;
      break;
    }
    case "focus": {
      if (s.open && s.open.answerWords >= 1) closeOpen("focus", { focusItemId: event.itemId });
      else return { state: s, close, armTimerMs: timerFor(s, now), reread: { focusItemId: event.itemId } };
      break;
    }
  }
  return { state: s, close, armTimerMs: timerFor(s, now) };
}

// ─────────────────────────────────────────────────────────────────────────
// Focus re-read (✓ Answered with nothing open)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The range a ✓ Answered re-reads: the seller's lines since the item was
 * last asked (or the last 3 minutes), at most 400 of their words, counted
 * back from the latest line. Null when the seller said nothing in it.
 */
export function focusRange(
  lines: Array<Pick<ChunkerLine, "seq" | "role" | "typed" | "text" | "at">>,
  opts: { now: number; askedSeq?: number | null; windowMs?: number; maxWords?: number },
): { fromSeq: number; toSeq: number } | null {
  const windowMs = opts.windowMs ?? 3 * 60_000;
  const maxWords = opts.maxWords ?? 400;
  const spoken = lines.filter((l) => !l.typed).sort((a, b) => a.seq - b.seq);
  if (spoken.length === 0) return null;
  let words = 0;
  let from = spoken[spoken.length - 1].seq;
  for (let i = spoken.length - 1; i >= 0; i--) {
    const l = spoken[i];
    if (opts.now - l.at > windowMs) break;
    if (opts.askedSeq != null && l.seq < opts.askedSeq) break;
    const w = answerWordsOf(l);
    if (words + w > maxWords && words > 0) break;
    words += w;
    from = l.seq;
  }
  if (words === 0) return null;
  return { fromSeq: from, toSeq: spoken[spoken.length - 1].seq };
}

// ─────────────────────────────────────────────────────────────────────────
// Who may run live filing (§5.3)
// ─────────────────────────────────────────────────────────────────────────

let enabledOverride: boolean | null = null;

/** For tests: force live filing on or off (null = the real rule). */
export function _setCaptureEnabledForTests(on: boolean | null): void {
  enabledOverride = on;
}

/**
 * Live filing runs only in production, or on a local replay server with the
 * key switched off AND a recorded model stub (scripts/together-replay.ts).
 * Any other local combination refuses — and says why.
 */
export function captureEnabled(env: NodeJS.ProcessEnv = process.env): { ok: boolean; why: string } {
  if (enabledOverride !== null) return { ok: enabledOverride, why: enabledOverride ? "forced on (tests)" : "forced off (tests)" };
  if (env.NODE_ENV === "production") return { ok: true, why: "production" };
  if (env.TOGETHER_CAPTURE === "on") {
    if (env.ANTHROPIC_API_KEY !== "disabled") return { ok: false, why: "TOGETHER_CAPTURE=on needs ANTHROPIC_API_KEY=disabled locally (a local server never files with a real key)" };
    if (!env.TOGETHER_CAPTURE_STUB) return { ok: false, why: "TOGETHER_CAPTURE=on needs TOGETHER_CAPTURE_STUB=<recorded model outputs>" };
    return { ok: true, why: "local replay with a recorded model" };
  }
  return { ok: false, why: "live filing runs only in production (or a local replay)" };
}

// ─────────────────────────────────────────────────────────────────────────
// The lease
// ─────────────────────────────────────────────────────────────────────────

/** This process's id — a redeploy's old and new instance never both file one sitting. */
export const BOOT_ID = `p-${randomUUID()}`;

export function leaseUntil(now: number): Date {
  return new Date(now + TOGETHER_LIMITS.leaseMs);
}

/** Should the runner take a soft-capped pace or stop live filing? (calls in the last hour, calls in the sitting) */
export function budgetState(callsLastHour: number, callsTotal: number): { throttleMs: number; held: boolean } {
  if (callsTotal >= TOGETHER_LIMITS.hardCallsPerSitting) return { throttleMs: 0, held: true };
  if (callsLastHour >= TOGETHER_LIMITS.softCallsPerHour) return { throttleMs: 120_000, held: false };
  return { throttleMs: 0, held: false };
}
