/**
 * Who is speaking in "Interview together" (specs/together.md §5.2) — pure
 * helpers shared by the server (roles on a sitting's lines) and the broker's
 * page. Moved here from client/src/lib/interview-sync.ts and
 * AIConversationInterface.tsx, which re-export them for the existing tests.
 *
 * Speaker ids on a sitting's lines:
 *   dg:<n>               Deepgram diarisation in the room (in person)
 *   daily:local          the broker's own microphone on a Cimple call
 *   daily:<sessionId>    the other participant on a Cimple call (the seller)
 *   rc:<participantId>   a Zoom / Meet / Teams participant (the notetaker)
 *   room                 the browser's basic recognition (no voices told apart)
 *   typed:broker         what the broker typed
 */
import type { SpeakerInfo, SpeakerMap, SpeakerRole } from "./together";

// ─────────────────────────────────────────────────────────────────────────
// Echo: the broker reading a question aloud
// ─────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(["the","a","an","and","or","of","to","in","on","for","with","is","are","do","does","did","you","your","it","that","this","what","how","any","have","has","be","at","as","by","we","i","so","if","about","from","there","their","they","them","can","would","could","which","who","when"]);

export function echoTokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * A transcript segment whose content words mostly (≥ 60%) appear in the
 * question is the question being read aloud, not an answer.
 */
export function looksLikeQuestionEcho(segment: string, question: string | undefined): boolean {
  if (!question) return false;
  const seg = echoTokens(segment);
  if (seg.length < 3) return false;
  const q = new Set(echoTokens(question));
  const hits = seg.filter((w) => q.has(w)).length;
  return hits / seg.length >= 0.6;
}

// ─────────────────────────────────────────────────────────────────────────
// Thinking aloud
// ─────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────
// Zoom / Meet / Teams notetaker: who is the broker?
// ─────────────────────────────────────────────────────────────────────────

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
  (s.toLowerCase().replace(/['’]s\b/g, "").match(/[a-z0-9À-ɏ]+/g) ?? []).filter((w) => w.length > 1);

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

// ─────────────────────────────────────────────────────────────────────────
// Roles on a sitting (§5.2)
// ─────────────────────────────────────────────────────────────────────────

/** A speaker id's kind. */
export function speakerKind(id: string): "deepgram" | "daily_local" | "daily" | "recall" | "room" | "typed" | "other" {
  if (id === "typed:broker") return "typed";
  if (id === "room") return "room";
  if (id === "daily:local") return "daily_local";
  if (id.startsWith("daily:")) return "daily";
  if (id.startsWith("rc:")) return "recall";
  if (id.startsWith("dg:")) return "deepgram";
  return "other";
}

/** "Speaker 1", "Speaker 2" … for diarised ids; names for meeting participants. */
export function speakerDisplay(id: string, info: SpeakerInfo | undefined, order: string[]): string {
  if (info?.name) return info.name;
  const kind = speakerKind(id);
  if (kind === "typed") return "You (typed)";
  if (kind === "room") return "The room";
  if (kind === "daily_local") return "You";
  const n = order.indexOf(id);
  return `Speaker ${n >= 0 ? n + 1 : "?"}`;
}

/** The role a speaker id has before anyone says otherwise (no lines needed). */
export function defaultRole(id: string): SpeakerRole {
  const kind = speakerKind(id);
  if (kind === "typed" || kind === "daily_local") return "broker";
  if (kind === "daily") return "seller";
  return "unknown";
}

export interface RoleLine { speaker: string; text: string; name?: string | null; isHost?: boolean | null }

/**
 * Automatic roles for the speakers present (never over a broker's choice):
 *  - typed:broker and daily:local are the broker; another Cimple-call
 *    participant is the seller;
 *  - Zoom / Meet / Teams: the participant whose name matches the broker's
 *    display name is the broker, else the host (only when the broker has no
 *    display name); the first other participant is the seller; anyone else
 *    stays unknown (their words are only ever possible answers);
 *  - in the room (Deepgram): a speaker whose line echoes a visible item's
 *    suggested question, or who asked ≥ 2 of the first 4 questions, is
 *    guessed to be the broker; with exactly one other speaker, that one is
 *    the seller;
 *  - the browser's basic recognition ("room") is never anyone.
 * Returns a new map; `changed` says whether anything moved.
 */
export function autoRoles(
  current: SpeakerMap,
  lines: RoleLine[],
  opts: { asks?: string[]; brokerName?: string } = {},
): { speakers: SpeakerMap; changed: boolean } {
  const next: SpeakerMap = { ...current };
  let changed = false;
  const set = (id: string, info: SpeakerInfo) => {
    const prev = next[id];
    if (prev?.by === "broker") return; // the broker's choice always wins
    if (prev && prev.role === info.role && (prev.name ?? undefined) === (info.name ?? undefined)) return;
    next[id] = info;
    changed = true;
  };
  const order: string[] = [];
  for (const l of lines) if (!order.includes(l.speaker)) order.push(l.speaker);

  // Fixed kinds.
  for (const id of order) {
    const kind = speakerKind(id);
    if (kind === "typed" || kind === "daily_local") set(id, { role: "broker", by: "auto", ...(next[id]?.name ? { name: next[id]!.name } : {}) });
    else if (kind === "daily") set(id, { role: "seller", by: "auto", ...(next[id]?.name ? { name: next[id]!.name } : {}) });
    else if (kind === "room" && !next[id]) set(id, { role: "unknown", by: "auto" });
  }

  // Meeting participants (Recall).
  const rc = order.filter((id) => speakerKind(id) === "recall");
  if (rc.length > 0) {
    const nameOf = (id: string) => lines.find((l) => l.speaker === id && l.name)?.name ?? next[id]?.name ?? null;
    const hostOf = (id: string) => lines.some((l) => l.speaker === id && l.isHost === true);
    const brokerName = (opts.brokerName ?? "").trim().toLowerCase();
    const chosen = (role: SpeakerRole) => rc.find((id) => next[id]?.by === "broker" && next[id]?.role === role) ?? null;
    let broker = chosen("broker");
    if (!broker && brokerName) broker = rc.find((id) => next[id]?.by !== "broker" && nameMatches(String(nameOf(id) ?? ""), brokerName)) ?? null;
    if (!broker && !brokerName) broker = rc.find((id) => next[id]?.by !== "broker" && hostOf(id)) ?? null;
    // The seller: the broker's pick, else the first other participant to
    // speak — only once the broker is known (a third participant, e.g. the
    // seller's accountant, stays unknown: their words are possible answers).
    const seller = chosen("seller") ?? (broker ? rc.find((id) => id !== broker && next[id]?.by !== "broker") ?? null : null);
    for (const id of rc) {
      const name = nameOf(id) ?? undefined;
      const role: SpeakerRole = id === broker ? "broker" : id === seller ? "seller" : "unknown";
      set(id, { role, by: "auto", ...(name ? { name } : {}) });
    }
  }

  // In the room (Deepgram diarisation).
  const dg = order.filter((id) => speakerKind(id) === "deepgram");
  if (dg.length > 0 && !dg.some((id) => next[id]?.by === "broker")) {
    const asks = (opts.asks ?? []).filter(Boolean);
    let broker: string | null = dg.find((id) => next[id]?.role === "broker") ?? null;
    if (!broker && asks.length > 0) {
      broker = dg.find((id) => lines.some((l) => l.speaker === id && asks.some((a) => looksLikeQuestionEcho(l.text, a)))) ?? null;
    }
    if (!broker) {
      const firstQuestions = lines.filter((l) => speakerKind(l.speaker) === "deepgram" && /\?\s*$/.test(l.text.trim())).slice(0, 4);
      const tally = new Map<string, number>();
      for (const q of firstQuestions) tally.set(q.speaker, (tally.get(q.speaker) ?? 0) + 1);
      tally.forEach((n, id) => { if (!broker && n >= 2) broker = id; });
    }
    if (broker) {
      set(broker, { role: "broker", by: "auto" });
      const others = dg.filter((id) => id !== broker);
      if (others.length === 1) set(others[0], { role: "seller", by: "auto" });
      else for (const id of others) if (!next[id]) set(id, { role: "unknown", by: "auto" });
    } else {
      for (const id of dg) if (!next[id]) set(id, { role: "unknown", by: "auto" });
    }
  } else if (dg.length > 0) {
    // The broker has chosen for at least one room speaker: in a two-voice
    // room the other one follows (unless also chosen).
    const chosen = dg.filter((id) => next[id]?.by === "broker");
    const rest = dg.filter((id) => next[id]?.by !== "broker");
    if (dg.length === 2 && chosen.length === 1 && rest.length === 1) {
      const other = chosen[0] && next[chosen[0]]?.role === "broker" ? "seller" : next[chosen[0]]?.role === "seller" ? "broker" : null;
      if (other) set(rest[0], { role: other, by: "auto" });
    } else {
      for (const id of rest) if (!next[id]) set(id, { role: "unknown", by: "auto" });
    }
  }
  return { speakers: next, changed };
}

/**
 * The broker says who a speaker is ("This is me / This is the seller /
 * Someone else"). The broker's choice is final; in a two-voice room or a
 * two-person meeting the other speaker follows automatically (until the
 * broker says otherwise for them too). Pure.
 */
export function applySpeakerChoice(current: SpeakerMap, present: string[], speaker: string, role: Exclude<SpeakerRole, "unknown">): SpeakerMap {
  const next: SpeakerMap = { ...current };
  const named = (id: string) => (current[id]?.name ? { name: current[id]!.name } : {});
  next[speaker] = { ...named(speaker), role, by: "broker" };
  if (role !== "broker" && role !== "seller") return next;
  const kind = speakerKind(speaker);
  if (kind !== "deepgram" && kind !== "recall" && kind !== "room") return next;
  const peers = present.filter((id) => id !== speaker && speakerKind(id) === kind);
  const complement: SpeakerRole = role === "broker" ? "seller" : "broker";
  // The latest choice wins: in a two-voice room or a two-person meeting the
  // other voice takes the other role (unless the broker called it "someone
  // else"); with more voices, whoever held this role before no longer does.
  if (peers.length === 1) {
    const peer = peers[0];
    if (!(next[peer]?.by === "broker" && next[peer]?.role === "other")) next[peer] = { ...named(peer), role: complement, by: "auto" };
  } else {
    for (const id of peers) if (next[id]?.role === role) next[id] = { ...named(id), role: "unknown", by: "auto" };
  }
  return next;
}

/** A line's role (a broker-attested line counts as the seller's). */
export function lineRole(speakers: SpeakerMap, line: { speaker: string; attested?: boolean | null }): SpeakerRole {
  if (line.attested) return "seller";
  return speakers[line.speaker]?.role ?? defaultRole(line.speaker);
}

/** Do we know who the broker and the seller are among the speakers present? */
export function rolesKnown(speakers: SpeakerMap, present: string[]): boolean {
  const spoken = present.filter((id) => speakerKind(id) !== "typed");
  if (spoken.length === 0) return true;
  if (spoken.some((id) => speakerKind(id) === "room")) return false;
  return spoken.some((id) => speakers[id]?.role === "seller") && (spoken.length === 1 || spoken.some((id) => speakers[id]?.role === "broker"));
}
