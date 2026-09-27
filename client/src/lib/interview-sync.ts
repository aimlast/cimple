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
 * Thinking aloud, not an answer: "Hmm, let me think.", "Good question…",
 * "Uh, one sec." (A bare "Yeah" / "No" / "Okay" IS an answer.)
 */
const THINKING_ALOUD_RE =
  /^(?:(?:u+h+|u+m+|h+m+|m+h*m+|e+r+m*|a+h+|o+h+|well|so|hmm+|let\s+me\s+(?:think|see|check|look|remember|recall)(?:\s+(?:about\s+)?(?:it|that|this))?|let['’]?s\s+see|good\s+question|that['’]?s\s+a\s+(?:good|great|tough|hard)\s+(?:one|question)|(?:give\s+me\s+)?(?:a|one)\s+(?:sec(?:ond)?|moment|minute)|hold\s+on|bear\s+with\s+me|i['’]m\s+(?:just\s+)?thinking|how\s+do\s+i\s+put\s+(?:it|this)|i\s+(?:need|have)\s+to\s+think(?:\s+about\s+(?:it|that))?)[\s,.!?…-]*)+$/i;

/** Is this line only the seller thinking aloud? */
export function isThinkingAloud(text: string): boolean {
  const t = text.trim();
  return !!t && THINKING_ALOUD_RE.test(t);
}

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
// Zoom / Meet / Teams notetaker: who is the broker?
// =====================

/**
 * The signed-in broker's display name from GET /api/broker-auth/me
 * (`{ user: { name, username } }`), or "" when they have none. Never the
 * username: a login like "broker_demo" is no one's name in a meeting, and
 * a name that matches nobody used to switch off the host fallback.
 */
export function brokerNameFromMe(me: unknown): string {
  const m = (me ?? {}) as { user?: { name?: unknown }; name?: unknown };
  const pick = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return (pick(m.user?.name) || pick(m.name)).toLowerCase();
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

/** Words that describe a meeting device, not a person ("Morgan's iPhone", "Morgan (Zoom)"). */
const DEVICE_WORDS = new Set([
  "iphone", "ipad", "android", "phone", "mobile", "cell", "laptop", "desktop", "pc", "mac", "macbook", "galaxy", "pixel",
  "zoom", "teams", "meet", "room", "office", "guest", "host", "me", "my", "the",
]);

const nameWords = (s: string) =>
  (s.toLowerCase().replace(/['’]s\b/g, "").match(/[a-z0-9\u00c0-\u024f]+/g) ?? []).filter((w) => w.length > 1);

/** A meeting name without its label: "Morgan (Brassline)", "Morgan Ellis - Brassline", "Morgan | Advisory" → the person's part. */
const personPart = (s: string) => s.replace(/[([{][^)\]}]*[)\]}]/g, " ").split(/\s+[-–—|@·]\s+|\s*[|@·]\s*/)[0] ?? "";

/**
 * Is this participant the broker? Whole names, never a substring ("Ian" is
 * not "Brian Walsh", "Anne" is not "Joanne"): every word of the broker's name
 * appears in the participant's ("Morgan Ellis (Brassline)"), or every word
 * of the participant's own name (a bracketed or dashed label and device
 * words aside) is one of the broker's ("Morgan", "Morgan (Brassline)",
 * "Morgan's iPhone" — but not "Morgan Smith").
 */
export function nameMatches(participant: string, broker: string): boolean {
  const p = nameWords(participant);
  const b = nameWords(broker);
  if (p.length === 0 || b.length === 0) return false;
  const pSet = new Set(p);
  const bSet = new Set(b);
  if (b.every((w) => pSet.has(w))) return true;
  const own = nameWords(personPart(participant)).filter((w) => !DEVICE_WORDS.has(w));
  return own.length > 0 && own.every((w) => bSet.has(w) && w.length >= 3);
}

/**
 * The speaker number for one notetaker line (one per meeting participant,
 * so the transcript's label buttons can re-assign "this is me"), updating
 * who the broker is: the participant whose name matches the signed-in
 * broker's; the host only when the broker has no display name (a seller
 * who hosts the meeting must not be labelled the broker). A broker the user
 * picked is never overruled.
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
