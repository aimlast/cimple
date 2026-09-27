/**
 * interview-sync — pure helpers that keep the interview screen in step with
 * what the server saved, and that decide when the room's live transcript
 * goes to the AI. No DOM, no fetch: unit-tested in
 * tests/unit/f-interview-client.test.ts.
 */

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
export function afterFailedSend(history: SyncMessage[] | null | undefined, sentText: string): "adopt" | "restore" {
  if (!history || history.length < 2) return "restore";
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  if (last.role !== "ai" || prev.role !== "user") return "restore";
  return norm(prev.content) === norm(sentText) ? "adopt" : "restore";
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
    const sellerWords = kept.filter(isSeller).reduce((n, l) => n + wordsIn(l.text), 0);
    if (sellerWords === 0) return null;
    const last = kept[kept.length - 1];
    if (!isSeller(last) && sellerWords < 4) return null;
  }
  return kept.map((l) => `${opts.label(l.speaker)}: ${l.text.trim()}`).join("\n");
}

// =====================
// Zoom / Meet / Teams notetaker: who is the broker?
// =====================

/** The signed-in broker's display name from GET /api/broker-auth/me (`{ user: { name, username } }`). */
export function brokerNameFromMe(me: unknown): string {
  const m = (me ?? {}) as { user?: { name?: unknown; username?: unknown }; name?: unknown; username?: unknown };
  const pick = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return (pick(m.user?.name) || pick(m.user?.username) || pick(m.name) || pick(m.username)).toLowerCase();
}

export interface BotSpeakerState {
  /** participantId → speaker number, in order of first line. */
  speakers: Map<string, number>;
  /** The broker's speaker number, once known. */
  broker: number | null;
  /** How the broker was found: a name match is kept over a host guess. */
  brokerBy: "name" | "host" | "picked" | null;
}

export function newBotSpeakerState(): BotSpeakerState {
  return { speakers: new Map(), broker: null, brokerBy: null };
}

const nameMatches = (participant: string, broker: string) => {
  if (!participant || !broker) return false;
  if (participant === broker || participant.includes(broker) || broker.includes(participant)) return true;
  // "Morgan Ellis" vs "morgan": the broker's first name as a whole word.
  const first = broker.split(/\s+/)[0];
  return first.length >= 3 && new RegExp(`(^|\\s)${first.replace(/[^a-z0-9]/g, "")}(\\s|$)`).test(participant);
};

/**
 * The speaker number for one notetaker line (one per meeting participant,
 * so the transcript's label buttons can re-assign "this is me"), updating
 * who the broker is: the participant whose name matches the signed-in
 * broker; the host only when no broker name is known (a seller who hosts
 * the meeting must not be labelled the broker). A broker the user picked
 * is never overruled.
 */
export function botSpeakerFor(
  state: BotSpeakerState,
  line: { participantId: string | number | null | undefined; name: string | null | undefined; isHost: boolean | null | undefined },
  brokerName: string,
): number {
  const pid = String(line.participantId ?? line.name ?? "unknown");
  let speaker = state.speakers.get(pid);
  if (speaker === undefined) {
    speaker = state.speakers.size;
    state.speakers.set(pid, speaker);
  }
  const name = (line.name ?? "").trim().toLowerCase();
  if (state.brokerBy !== "picked" && state.brokerBy !== "name" && brokerName && nameMatches(name, brokerName)) {
    state.broker = speaker;
    state.brokerBy = "name";
  } else if (state.broker === null && !brokerName && line.isHost === true) {
    state.broker = speaker;
    state.brokerBy = "host";
  }
  return speaker;
}
