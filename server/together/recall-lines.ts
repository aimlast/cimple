/**
 * Zoom / Meet / Teams: the notetaker's transcript lines join the board's
 * sitting (specs/together.md §5.2, §7.7).
 *
 * Recall posts `transcript.data` to the public webhook with the per-bot
 * token we registered. A line is appended only to the deal's open, live
 * sitting whose `bot_id` is the event's bot, and only when the URL token is
 * that bot's own (so a bot started for an earlier sitting never writes into
 * the current one). Idempotent: the page id is `rc:<botId>:<participantId>`
 * and the line number is the utterance's first-word start in ms, so a
 * redelivered webhook adds nothing. Without a timestamp the 2.5 s
 * same-text rule is the only de-duplication.
 */
import type { Deal } from "@shared/schema";
import { isNotetakerVia } from "@shared/together";
import { storage } from "../storage";
import { notetakerHeard } from "./notetaker";
import { appendLines } from "./sittings";
import { togetherStore } from "./store";

export interface RecallTogetherLine {
  botId: string | null;
  participantId: string;
  name: string | null;
  isHost: boolean | null;
  text: string;
  /** First word's start, ms from the recording's start (the idempotency key). */
  startMs: number | null;
}

const safeId = (v: unknown) => String(v ?? "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40);

/** One line from a `transcript.data` payload, or null when it carries no text. Pure. */
export function togetherLineFromWebhook(payload: unknown): RecallTogetherLine | null {
  const p = payload as { data?: { data?: { words?: Array<{ text?: string; start_timestamp?: { relative?: number } | null }>; participant?: { id?: unknown; name?: string | null; is_host?: boolean | null } }; bot?: { id?: unknown } } };
  const d = p?.data?.data;
  const words = Array.isArray(d?.words) ? d!.words! : [];
  const text = words.map((w) => w?.text ?? "").join(" ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const rel = words[0]?.start_timestamp?.relative;
  const participantId = safeId(d?.participant?.id ?? d?.participant?.name ?? "unknown") || "unknown";
  return {
    botId: p?.data?.bot?.id ? String(p.data.bot.id) : null,
    participantId,
    name: typeof d?.participant?.name === "string" ? d.participant.name.slice(0, 80) : null,
    isHost: typeof d?.participant?.is_host === "boolean" ? d.participant.is_host : null,
    text: text.slice(0, 2000),
    startMs: typeof rel === "number" && Number.isFinite(rel) && rel >= 0 ? Math.round(rel * 1000) : null,
  };
}

/** The open, live sitting this bot belongs to — only when the token is that bot's. */
async function sittingForBot(dealId: string, token: string, botId: string | null) {
  if (!botId) return null;
  const deal = (await storage.getDeal(dealId)) as (Deal & { interviewBot?: { botId?: string; webhookToken?: string; endedAt?: string | null } | null }) | undefined;
  const bot = deal?.interviewBot;
  if (!deal || !bot || bot.botId !== botId || bot.webhookToken !== token) return null;
  const sitting = (await togetherStore().openSittings(dealId)).find((s) => s.status === "live" && s.botId === botId && isNotetakerVia(s.via));
  return sitting ? { deal, sitting } : null;
}

/** Appends one notetaker line to its sitting. Returns whether it was stored. */
export async function appendRecallLine(dealId: string, token: string, line: RecallTogetherLine): Promise<boolean> {
  const found = await sittingForBot(dealId, token, line.botId);
  if (!found) return false;
  const { deal, sitting } = found;
  const brokerName = async () => String(((await storage.getUser(sitting.brokerId).catch(() => undefined)) as { name?: string | null } | undefined)?.name ?? "").trim().toLowerCase();
  const r = await appendLines(
    sitting.id,
    `rc:${line.botId}:${line.participantId}`,
    [{ clientSeq: line.startMs, speaker: `rc:${line.participantId}`, text: line.text, source: "recall", name: line.name, isHost: line.isHost }],
    { deal, brokerName },
  );
  notetakerHeard(sitting.id, line.botId!);
  return r.accepted.length > 0;
}

/** A participant joined or left: the notetaker is in the call. */
export async function recallParticipantEvent(dealId: string, token: string, payload: unknown): Promise<void> {
  const botId = (payload as { data?: { bot?: { id?: unknown } } })?.data?.bot?.id;
  const found = await sittingForBot(dealId, token, botId ? String(botId) : null);
  if (found) notetakerHeard(found.sitting.id, String(botId));
}
