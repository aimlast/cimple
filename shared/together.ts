/**
 * "Interview together" — sittings, lines and live events (specs/together.md
 * §4.4, §5.2, §7.2). Pure; shared by the server and the broker's page.
 *
 * A sitting is one session together (in person, a Cimple call, or a Zoom /
 * Meet / Teams call with Cimple's notetaker). Its lines are the
 * conversation as text — no audio is ever kept.
 */

// ─────────────────────────────────────────────────────────────────────────
// Ways of running it
// ─────────────────────────────────────────────────────────────────────────

export type TogetherVia = "person" | "cimple" | "zoom" | "meet" | "teams";
export const TOGETHER_VIAS: readonly TogetherVia[] = ["person", "cimple", "zoom", "meet", "teams"];

export const VIA_LABEL: Record<TogetherVia, string> = {
  person: "In person",
  cimple: "Cimple call",
  zoom: "Zoom",
  meet: "Google Meet",
  teams: "Teams",
};

export function isTogetherVia(v: unknown): v is TogetherVia {
  return typeof v === "string" && (TOGETHER_VIAS as readonly string[]).includes(v);
}

/** Zoom / Meet / Teams — Cimple's notetaker joins the broker's own call. */
export function isNotetakerVia(v: TogetherVia | string | null | undefined): boolean {
  return v === "zoom" || v === "meet" || v === "teams";
}

/** The kind of source the sitting's transcript is (call in person, video call otherwise). */
export function transcriptSourceKind(via: TogetherVia): "call" | "video_call" {
  return via === "person" ? "call" : "video_call";
}

/** "Seller can see this screen" starts on in person, off for remote calls (D10). */
export function defaultSellerSeesScreen(via: TogetherVia): boolean {
  return via === "person";
}

// ─────────────────────────────────────────────────────────────────────────
// Speakers and lines
// ─────────────────────────────────────────────────────────────────────────

export type SpeakerRole = "broker" | "seller" | "other" | "unknown";
export interface SpeakerInfo { role: SpeakerRole; name?: string; by: "auto" | "broker" }
export type SpeakerMap = Record<string, SpeakerInfo>;

export type LineSource = "deepgram" | "daily" | "recall" | "browser" | "typed";
export const LINE_SOURCES: readonly LineSource[] = ["deepgram", "daily", "recall", "browser", "typed"];

/** Spoken lines need the seller to know Cimple is taking notes (D15); typed lines don't. */
export function isSpokenSource(s: LineSource): boolean {
  return s !== "typed";
}

/** One line as the page sends it (POST …/lines). */
export interface IncomingLine {
  clientSeq: number | null;
  speaker: string;
  text: string;
  at?: string;
  source: LineSource;
  /** Meeting participants only (the notetaker). */
  name?: string | null;
  isHost?: boolean | null;
}

/** One line as the broker's page shows it. */
export interface TogetherLineView {
  seq: number;
  speaker: string;
  text: string;
  source: LineSource;
  at: string;
  attested?: boolean;
}

export const LINE_LIMITS = {
  perRequest: 50,
  textMax: 2000,
  speakerMax: 64,
  clientIdMax: 64,
} as const;

export const SPEAKER_ID_RE = /^[A-Za-z0-9:_\-.]+$/;
export const CLIENT_ID_RE = /^[A-Za-z0-9-]+$/;

export type LinesBodyCheck =
  | { ok: true; clientId: string; lines: IncomingLine[] }
  | { ok: false; error: string };

/** Validates a POST …/lines body (§5.2). Pure. */
export function validateLinesBody(body: unknown): LinesBodyCheck {
  const b = (body ?? {}) as { clientId?: unknown; lines?: unknown };
  if (typeof b.clientId !== "string" || !b.clientId || b.clientId.length > LINE_LIMITS.clientIdMax || !CLIENT_ID_RE.test(b.clientId)) {
    return { ok: false, error: "This page's id is missing or not valid — reload the page." };
  }
  if (!Array.isArray(b.lines) || b.lines.length === 0) return { ok: false, error: "No lines to add." };
  if (b.lines.length > LINE_LIMITS.perRequest) return { ok: false, error: `At most ${LINE_LIMITS.perRequest} lines at a time.` };
  const out: IncomingLine[] = [];
  for (const raw of b.lines as unknown[]) {
    const l = (raw ?? {}) as Record<string, unknown>;
    const text = typeof l.text === "string" ? l.text.trim() : "";
    if (!text) return { ok: false, error: "A line has no text." };
    if (text.length > LINE_LIMITS.textMax) return { ok: false, error: `A line is longer than ${LINE_LIMITS.textMax} characters.` };
    const speaker = typeof l.speaker === "string" ? l.speaker : "";
    if (!speaker || speaker.length > LINE_LIMITS.speakerMax || !SPEAKER_ID_RE.test(speaker)) return { ok: false, error: "A line has no valid speaker." };
    const source = l.source as LineSource;
    if (!LINE_SOURCES.includes(source) || source === "recall") return { ok: false, error: "A line has no valid source." };
    if (source === "typed" && speaker !== "typed:broker") return { ok: false, error: "A typed line must be yours." };
    if (source !== "typed" && speaker === "typed:broker") return { ok: false, error: "A spoken line can't be marked as typed." };
    const seq = l.clientSeq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > 2_000_000_000) return { ok: false, error: "A line has no valid number." };
    const at = typeof l.at === "string" && !Number.isNaN(Date.parse(l.at)) ? l.at : undefined;
    out.push({ clientSeq: seq, speaker, text, source, ...(at ? { at } : {}) });
  }
  return { ok: true, clientId: b.clientId, lines: out };
}

/** Text as compared for the cross-speaker duplicate rule (two devices in one room). */
export function duplicateKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Two devices in one room double every line: a line equal to ANOTHER speaker's line within the window is dropped. */
export const CROSS_SPEAKER_DUPLICATE_MS = 2_500;

export function isCrossSpeakerDuplicate(
  recent: ReadonlyArray<{ speaker: string; text: string; at: Date | string }>,
  line: { speaker: string; text: string },
  now: number,
): boolean {
  const key = duplicateKey(line.text);
  if (!key) return false;
  return recent.some((r) => r.speaker !== line.speaker && now - new Date(r.at).getTime() <= CROSS_SPEAKER_DUPLICATE_MS && duplicateKey(r.text) === key);
}

/**
 * For legacy "Interview together" interview sessions (before the board),
 * each user message was a "Broker: … / Seller: …" exchange. Only the
 * seller's parts — what readers may quote as the owner's words (§5.8).
 */
export function sellerPartOfExchange(text: string): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => /^\s*(?:broker|seller|speaker \d+)\s*:/i.test(l))) return text.trim();
  const out: string[] = [];
  let current: "seller" | "other" | null = null;
  for (const l of lines) {
    const m = l.match(/^\s*(broker|seller|speaker \d+)\s*:\s*(.*)$/i);
    if (m) {
      current = m[1].toLowerCase() === "seller" ? "seller" : "other";
      if (current === "seller" && m[2].trim()) out.push(m[2].trim());
    } else if (current === "seller" && l.trim()) {
      out.push(l.trim());
    }
  }
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Sittings
// ─────────────────────────────────────────────────────────────────────────

export type SittingStatus = "live" | "paused" | "ended";

/** What the broker's page knows about a sitting (never the capture lease or bookkeeping). */
export interface TogetherSittingView {
  id: string;
  dealId: string;
  via: TogetherVia;
  status: SittingStatus;
  startedAt: string;
  pausedAt: string | null;
  endedAt: string | null;
  lastLineAt: string | null;
  consentAt: string | null;
  lineSeq: number;
  speakers: SpeakerMap;
  sellerSeesScreen: boolean;
  hasTranscript: boolean;
  botActive: boolean;
  interviewCompleted: boolean;
  summary: SittingSummary | null;
  /** Chunks waiting to be filed (Cimple's AI was unavailable). */
  waiting: number;
  sourceDeleted: boolean;
  /** The Zoom / Meet / Teams notetaker's last known state (the server watches it). */
  notetaker: ListenState | null;
}

/** One line in the Interview tab / the Overview: "Interview together — 9 Oct · 24 min · in person · 9 filed". */
export interface SittingListRow {
  id: string;
  via: TogetherVia;
  status: SittingStatus;
  startedAt: string;
  endedAt: string | null;
  durationMin: number;
  filed: number;
  lines: number;
}

export function sittingDurationMin(s: { startedAt: string | Date; endedAt?: string | Date | null; lastLineAt?: string | Date | null; pausedAt?: string | Date | null }, now = Date.now()): number {
  const start = new Date(s.startedAt).getTime();
  const endRaw = s.endedAt ?? s.lastLineAt ?? s.pausedAt ?? null;
  const end = endRaw ? new Date(endRaw).getTime() : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 60_000));
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

/** "9 Oct" */
export function shortDate(iso: string | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function sittingListText(row: Pick<SittingListRow, "via" | "startedAt" | "durationMin" | "filed">): string {
  return `Interview together — ${shortDate(row.startedAt)} · ${row.durationMin < 1 ? "under a minute" : `${row.durationMin} min`} · ${row.via === "person" ? "in person" : VIA_LABEL[row.via]} · ${row.filed} filed`;
}

// ─────────────────────────────────────────────────────────────────────────
// Listening (the mode card and the pill, §4.5)
// ─────────────────────────────────────────────────────────────────────────

export type ListenState =
  | "idle"                 // not listening yet
  | "consent"              // waiting for "They know — start"
  | "starting"
  | "listening"
  | "paused"
  | "mic_blocked"          // NotAllowedError
  | "no_mic"               // NotFoundError
  | "stopped"              // socket closed / laptop slept / transcription stopped
  | "silent"               // 60 s with nothing heard (nothing is stopped)
  | "unavailable"          // the service isn't set up on this server
  | "call_joining"
  | "call_waiting"         // in the call, the seller hasn't joined
  | "call_left"            // the broker left the call (room still open)
  | "notetaker_joining"
  | "notetaker_waiting_room"
  | "notetaker_live"
  | "notetaker_silent"
  | "notetaker_removed"
  | "notetaker_failed"
  | "notetaker_ended";

/** The pill is amber for every listening problem (§4.5). */
export function listenIsProblem(s: ListenState): boolean {
  return s === "mic_blocked" || s === "no_mic" || s === "stopped" || s === "silent" || s === "notetaker_waiting_room" || s === "notetaker_silent" || s === "notetaker_removed" || s === "notetaker_failed" || s === "unavailable";
}

export function listenIsActive(s: ListenState): boolean {
  return s === "listening" || s === "silent" || s === "notetaker_live" || s === "notetaker_silent" || s === "call_waiting";
}

/** Plain-language copy for every listening state (exact strings from §4.5). */
export function listenCopy(s: ListenState, platform = "the meeting"): string {
  switch (s) {
    case "idle": return "Nothing heard yet. Start listening, or type what the seller says below.";
    case "consent": return "Let the seller know Cimple is taking notes of this conversation. No audio is kept — only the words, as text.";
    case "starting": return "Starting…";
    case "listening": return "Listening";
    case "paused": return "Paused";
    case "mic_blocked": return "Your browser blocked the microphone. Click the lock icon in the address bar, allow Microphone, then Try again.";
    case "no_mic": return "No microphone found. Plug one in or pick one in your computer's sound settings, then Try again.";
    case "stopped": return "Listening stopped.";
    case "silent": return "Cimple hasn't heard anything for a minute — is the microphone on?";
    case "unavailable": return "Live listening isn't set up on this server. Type what the seller says below, or tick answers as you go.";
    case "call_joining": return "Joining the call…";
    case "call_waiting": return "In the call — waiting for the seller to join.";
    case "call_left": return "You left the call. The room is still open.";
    case "notetaker_joining": return "The notetaker is joining the call…";
    case "notetaker_waiting_room": return `The notetaker is waiting to be let into the meeting — admit “Cimple Notetaker” in ${platform}.`;
    case "notetaker_live": return "In the call — transcribing. Cimple files the seller's answers as they talk.";
    case "notetaker_silent": return "The notetaker hasn't sent anything for a minute.";
    case "notetaker_removed": return "The notetaker was removed from the meeting.";
    case "notetaker_failed": return "The notetaker couldn't join — check the meeting link and that the meeting has started.";
    case "notetaker_ended": return "The meeting ended — the notetaker left.";
  }
}

/** A Recall status (code + sub-code) as the board's listening state. */
export function notetakerState(code: string | null | undefined, subCode?: string | null): ListenState {
  const c = String(code ?? "");
  const sub = String(subCode ?? "").toLowerCase();
  if (!c) return "notetaker_joining";
  if (c === "in_waiting_room") return "notetaker_waiting_room";
  if (c === "in_call_recording" || c === "in_call_not_recording" || c === "recording_permission_allowed") return "notetaker_live";
  if (c === "fatal") return "notetaker_failed";
  if (c === "call_ended" || c === "done" || c === "analysis_done" || c === "recording_done") {
    if (/kick|remov|denied|waiting_room_timeout|timeout_exceeded_waiting_room/.test(sub)) return "notetaker_removed";
    return "notetaker_ended";
  }
  return "notetaker_joining";
}

/** Who carries the listening state: the server for the notetaker, the broker's browser otherwise. */
export const SILENCE_WATCHDOG_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────
// Live events (SSE, §7.2)
// ─────────────────────────────────────────────────────────────────────────

export type TogetherEvent =
  | { type: "hello"; eventSeq: number; sitting: TogetherSittingView }
  | { type: "lines"; lines: TogetherLineView[] }
  | { type: "filing"; section?: string | null }
  | { type: "filed"; items: unknown[]; totals: unknown; version: string; prevVersion: string }
  | { type: "board"; board: unknown }
  | { type: "listen"; state: ListenState; detail?: string }
  | { type: "status"; captureState: Record<string, unknown> }
  | { type: "sitting"; sitting: TogetherSittingView };

/** An event with its sequence number, as the poll fallback returns them. */
export type SeqEvent = TogetherEvent & { eventSeq: number };

// ─────────────────────────────────────────────────────────────────────────
// End of a sitting (§4.7)
// ─────────────────────────────────────────────────────────────────────────

export interface SummaryFiledRow {
  itemId: string;
  label: string;
  sectionKey: string;
  sectionTitle: string;
  value: string | null;
  /** The seller's words, or null for the broker's own note. */
  quote: string | null;
  yourNote: boolean;
  status: "on_file" | "partial" | "verify" | "missing";
  chunkId?: string;
}

export interface SummaryOpenRow {
  itemId: string;
  label: string;
  sectionKey: string;
  sectionTitle: string;
  status: "partial" | "verify" | "missing";
  critical: boolean;
  ask: string;
  /** Ticked by default: critical, marked "come back later", or someone else has the answer. */
  ticked: boolean;
}

export interface SummaryDocRow {
  requirementId: string;
  name: string;
  required: boolean;
  promised: boolean;
  ticked: boolean;
}

export interface SittingSummary {
  sittingId: string;
  via: TogetherVia;
  startedAt: string;
  endedAt: string | null;
  durationMin: number;
  filed: SummaryFiledRow[];
  alsoNoted: number;
  privateNotes: number;
  toVerify: number;
  stillToGet: SummaryOpenRow[];
  criticalOpen: number;
  documents: SummaryDocRow[];
  /** Parts of the conversation still waiting to be filed. */
  waiting: number;
  /** Built while "Seller can see this screen" was on. */
  screen: boolean;
  /** Stored at the end: what the broker chose. */
  completeInterview?: boolean;
  followUpsAdded?: number;
  emailedAt?: string;
}

/** "24 min · 9 answers filed · 2 to verify" */
export function summaryLine(s: Pick<SittingSummary, "durationMin" | "filed" | "toVerify">): string {
  const parts = [s.durationMin < 1 ? "Under a minute" : `${s.durationMin} min`, `${s.filed.length} ${s.filed.length === 1 ? "answer" : "answers"} filed`];
  if (s.toVerify > 0) parts.push(`${s.toVerify} to verify`);
  return parts.join(" · ");
}

/** The plain message a refused follow-up ask shows (§4.7). */
export const PRIVATE_ASK_MESSAGE = "This question mentions something private to you — reword it before it goes to the seller.";
