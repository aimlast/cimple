/**
 * interview-sync — pure helpers that keep the interview screen in step with
 * what the server saved, and that decide when the room's live transcript
 * goes to the AI. No DOM, no fetch: unit-tested in
 * tests/unit/f-interview-client.test.ts.
 */

import { isThinkingAloud } from "@shared/together-speakers";

export interface SyncMessage {
  role: "ai" | "user" | string;
  content: string;
  timestamp: string;
}

/**
 * The AI question the seller is answering: the last AI message on screen
 * that the server saved (a local "something went wrong" bubble, or a
 * goodbye the page wrote itself, is not one). Sent as `answeringAt`, so the
 * server refuses an answer to a question that is no longer the latest.
 */
export function answeringAt(messages: SyncMessage[], localOnly: ReadonlySet<string>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "ai" && !localOnly.has(m.timestamp)) return m.timestamp;
  }
  return undefined;
}

const norm = (s: string) => s.replace(/​/g, "").replace(/\s+/g, " ").trim();

/**
 * After a send that failed (a dropped connection, a phone that locked
 * mid-turn) or was refused as out of step: did the server save that answer
 * and reply to it? Then the saved transcript is shown — never "send it
 * again" (the resend would land as the answer to a question the seller
 * never saw). "restore": the answer isn't there — it goes back in the box.
 */
export function afterFailedSend(
  history: SyncMessage[] | null | undefined,
  sentText: string,
  /** The AI question the send answered (its answeringAt). The saved answer must be the reply to IT — a
   *  seller who answers "Yes" twice in a row must not have the second "Yes" mistaken for the first. */
  answeredAt?: string | null,
): "adopt" | "restore" {
  if (!history || history.length < 2) return "restore";
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  if (last.role !== "ai" || prev.role !== "user") return "restore";
  if (norm(prev.content) !== norm(sentText)) return "restore";
  if (answeredAt) {
    const question = history[history.length - 3];
    if (!question || question.role !== "ai" || question.timestamp !== answeredAt) return "restore";
  }
  return "adopt";
}

// =====================
// Live transcript → the AI
// =====================

export interface LiveLine {
  speaker: number;
  text: string;
}

const wordsIn = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * The labelled exchange to send, or null to keep listening.
 * - `force` ("Send now"): whatever is in the transcript goes (the broker's
 *   question being read aloud is still filtered out).
 * - Automatic (the pause timer): the seller has spoken and the broker hasn't
 *   spoken since → any answer goes, however short ("We lease it.", "About
 *   forty."). When the broker spoke last (rephrasing, a follow-up), the
 *   seller's words so far must be a real answer (≥ 4 words) — the broker
 *   reading the question alone is not one.
 * `isEcho(text)` says a line is the question being read aloud.
 */
export function liveExchangeText(
  lines: LiveLine[],
  brokerSpeaker: number | null,
  opts: {
    force?: boolean;
    label: (speaker: number) => string;
    isEcho: (text: string) => boolean;
  },
): string | null {
  const kept = lines.filter((l) => l.text.trim() && !(l.speaker === brokerSpeaker && opts.isEcho(l.text)));
  if (kept.length === 0) return null;
  if (!opts.force) {
    const isSeller = (l: LiveLine) => brokerSpeaker === null || l.speaker !== brokerSpeaker;
    // (The seller thinking aloud — "Hmm, let me think." — is not an answer:
    // sent, the AI moved on and the real answer landed on the next question.)
    const sellerWords = kept.filter((l) => isSeller(l) && !isThinkingAloud(l.text)).reduce((n, l) => n + wordsIn(l.text), 0);
    if (sellerWords === 0) return null;
    const last = kept[kept.length - 1];
    if (!isSeller(last) && sellerWords < 4) return null;
  }
  return kept.map((l) => `${opts.label(l.speaker)}: ${l.text.trim()}`).join("\n");
}

// =====================
// Zoom / Meet / Teams notetaker: who is the broker? (moved to
// shared/together-speakers.ts; re-exported for existing callers and tests)
// =====================

export {
  brokerNameFromMe,
  botSpeakerFor,
  newBotSpeakerState,
  nameMatches,
  isThinkingAloud,
  looksLikeQuestionEcho,
  type BotSpeakerState,
} from "@shared/together-speakers";
