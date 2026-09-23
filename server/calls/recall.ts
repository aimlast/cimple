/**
 * Recall.ai — the "Cimple Notetaker" bot that joins the broker's own Zoom /
 * Google Meet / Teams call and streams a speaker-labelled transcript back.
 *
 * Flow: the broker starts a together-interview with a meeting link → we
 * create a bot that auto-joins (founder decision: no manual admit) with a
 * webhook realtime endpoint → Recall POSTs `transcript.data` events to
 * /api/calls/recall/webhook/?token=… → lines are buffered per deal in memory
 * → the broker's browser polls them and feeds the interview exactly like the
 * in-Cimple call does. Leaving the page makes the bot leave.
 */
import crypto from "crypto";

export function isRecallConfigured(): boolean {
  return !!process.env.RECALL_API_KEY;
}

function baseUrl(): string {
  const region = (process.env.RECALL_REGION || "us-west-2").trim();
  return `https://${region}.recall.ai/api/v1`;
}

async function recall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = process.env.RECALL_API_KEY!;
  const attempt = async (scheme: "Token" | "Bearer") => {
    const res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: { Authorization: `${scheme} ${key}`, "Content-Type": "application/json", Accept: "application/json", ...(init.headers || {}) },
    });
    return res;
  };
  // Recall's docs show both header styles across pages — try the documented
  // "Token" scheme first and fall back once on an auth failure.
  let res = await attempt("Token");
  if (res.status === 401 || res.status === 403) res = await attempt("Bearer");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Recall ${init.method || "GET"} ${path} → ${res.status}: ${body.slice(0, 300)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface RecallBot {
  id: string;
  status_changes?: { code: string; message?: string | null; created_at: string; sub_code?: string | null }[];
}

const MEETING_HOSTS = ["zoom.us", "meet.google.com", "teams.microsoft.com", "teams.live.com"];

/** Accepts the three supported platforms' meeting links (any subdomain). */
export function isSupportedMeetingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && MEETING_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export function newWebhookToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export async function createBot(meetingUrl: string, webhookUrl: string): Promise<RecallBot> {
  if (!isRecallConfigured()) throw new Error("Recall is not configured");
  return recall<RecallBot>("/bot/", {
    method: "POST",
    body: JSON.stringify({
      meeting_url: meetingUrl,
      bot_name: "Cimple Notetaker",
      recording_config: {
        transcript: {
          provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } },
        },
        realtime_endpoints: [
          { type: "webhook", url: webhookUrl, events: ["transcript.data", "participant_events.join", "participant_events.leave"] },
        ],
      },
    }),
  });
}

export async function getBot(botId: string): Promise<RecallBot> {
  return recall<RecallBot>(`/bot/${encodeURIComponent(botId)}/`);
}

export async function leaveCall(botId: string): Promise<void> {
  try {
    await recall(`/bot/${encodeURIComponent(botId)}/leave_call/`, { method: "POST" });
  } catch (err) {
    console.warn(`[recall] leave_call failed for ${botId}:`, (err as Error).message);
  }
}

/** Latest status code from the bot's status history (e.g. joining_call, in_call_recording, call_ended, fatal). */
export function latestStatus(bot: RecallBot | null | undefined): string | null {
  const changes = bot?.status_changes ?? [];
  return changes.length ? changes[changes.length - 1].code : null;
}

// ── Live transcript buffer (per deal, in memory) ─────────────────────────

export interface BotLine {
  seq: number;
  participantId: number | string;
  name: string | null;
  isHost: boolean | null;
  text: string;
  at: string;
}

interface Buffer { seq: number; lines: BotLine[]; status: string | null; updatedAt: number }
const buffers = new Map<string, Buffer>();
const BUFFER_CAP = 500;

export function pushBotLine(dealId: string, line: Omit<BotLine, "seq" | "at">): void {
  const buf = buffers.get(dealId) ?? { seq: 0, lines: [], status: null, updatedAt: Date.now() };
  buf.seq += 1;
  buf.lines.push({ ...line, seq: buf.seq, at: new Date().toISOString() });
  if (buf.lines.length > BUFFER_CAP) buf.lines.splice(0, buf.lines.length - BUFFER_CAP);
  buf.updatedAt = Date.now();
  buffers.set(dealId, buf);
}

export function setBotStatus(dealId: string, status: string): void {
  const buf = buffers.get(dealId) ?? { seq: 0, lines: [], status: null, updatedAt: Date.now() };
  buf.status = status;
  buf.updatedAt = Date.now();
  buffers.set(dealId, buf);
}

export function readBotLines(dealId: string, after: number): { lines: BotLine[]; seq: number; status: string | null } {
  const buf = buffers.get(dealId);
  if (!buf) return { lines: [], seq: 0, status: null };
  return { lines: buf.lines.filter((l) => l.seq > after), seq: buf.seq, status: buf.status };
}

export function clearBotBuffer(dealId: string): void {
  buffers.delete(dealId);
}

/** Turn a transcript.data payload into one line; null when it carries no text. */
export function lineFromWebhook(payload: any): Omit<BotLine, "seq" | "at"> | null {
  const d = payload?.data?.data;
  const words: { text: string }[] = Array.isArray(d?.words) ? d.words : [];
  const text = words.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const p = d?.participant ?? {};
  return { participantId: p.id ?? "unknown", name: p.name ?? null, isHost: p.is_host ?? null, text };
}
