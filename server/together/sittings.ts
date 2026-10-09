/**
 * "Interview together" sittings (specs/together.md §4.4, §5.2, §7.3).
 *
 * A sitting starts (or resumes, within 2 h, for the same broker) when the
 * board opens in a listening mode. It makes no AI call and opens no
 * interview session. The first start of listening asks the broker to
 * confirm the seller knows Cimple is taking notes (D15): until then spoken
 * lines are refused (typed lines are fine). Lines are idempotent per
 * (sitting, page id, page line number), so a retried batch, a reload or a
 * second tab never doubles a line; two devices in one room (each microphone
 * hears both people) are de-duplicated across speakers within 2.5 s.
 *
 * Roles: the broker's own choice ("This is me") always wins; otherwise the
 * automatic rules of shared/together-speakers.ts. Only the seller's words
 * ever reach the transcript document (transcript.ts).
 */
import type { Deal, InsertTogetherLine, TogetherLine, TogetherSitting } from "@shared/schema";
import {
  defaultSellerSeesScreen,
  isCrossSpeakerDuplicate,
  isSpokenSource,
  type IncomingLine,
  type LineSource,
  type SpeakerMap,
  type SpeakerRole,
  type TogetherLineView,
  type TogetherSittingView,
  type TogetherVia,
} from "@shared/together";
import { applySpeakerChoice, autoRoles, lineRole } from "@shared/together-speakers";
import { TOGETHER_LIVE_MS } from "../interview/session-mode";
import { storage } from "../storage";
import { BoardActionError } from "./errors";
import * as hub from "./hub";
import { TOGETHER_LIMITS } from "./limits";
import { notetakerStateOf } from "./notetaker";
import { togetherStore } from "./store";
import { TRANSCRIPT_WRITE_EVERY_MS, ensureTranscriptDocument, hasSellerLine, writeTranscriptText } from "./transcript";

/** Where a sitting was created — a process only ever captures its own kind (§5.3). */
export function captureEnv(): "production" | "local" {
  return process.env.NODE_ENV === "production" ? "production" : "local";
}

/** Another broker's tab counts as "using it now" for this long. */
export const IN_USE_WITHIN_MS = 30_000;

const asDate = (v: unknown): Date | null => (v ? new Date(v as string) : null);
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/** The latest sign of life on a sitting. */
export function lastActiveAt(s: Pick<TogetherSitting, "startedAt" | "lastLineAt" | "pausedAt">): number {
  return Math.max(...[s.startedAt, s.lastLineAt, s.pausedAt].map((v) => (v ? new Date(v).getTime() : 0)));
}

interface CaptureStateLike {
  chunksWaiting?: number;
  sourceDeleted?: boolean;
}

/** The sitting as the broker's page sees it. */
export function sittingView(s: TogetherSitting, opts: { botActive?: boolean } = {}): TogetherSittingView {
  const state = (s.captureState ?? {}) as CaptureStateLike;
  return {
    id: s.id,
    dealId: s.dealId,
    via: s.via as TogetherVia,
    status: s.status as TogetherSittingView["status"],
    startedAt: new Date(s.startedAt).toISOString(),
    pausedAt: iso(s.pausedAt),
    endedAt: iso(s.endedAt),
    lastLineAt: iso(s.lastLineAt),
    consentAt: iso(s.consentAt),
    lineSeq: s.lineSeq,
    speakers: (s.speakers ?? {}) as SpeakerMap,
    sellerSeesScreen: !!s.sellerSeesScreen,
    hasTranscript: !!s.transcriptDocumentId,
    botActive: !!opts.botActive || (!!s.botId && s.status !== "ended"),
    interviewCompleted: !!s.interviewCompleted,
    summary: (s.summary ?? null) as TogetherSittingView["summary"],
    waiting: Number(state.chunksWaiting ?? 0),
    sourceDeleted: !!state.sourceDeleted,
    notetaker: notetakerStateOf(s.id),
  };
}

export function lineView(l: TogetherLine): TogetherLineView {
  return {
    seq: l.seq,
    speaker: l.speaker,
    text: l.text,
    source: l.source as LineSource,
    at: new Date(l.at).toISOString(),
    ...(l.attestedSellerAt ? { attested: true } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// One action at a time per sitting (lines, roles, pause, end)
// ─────────────────────────────────────────────────────────────────────────

const queues = new Map<string, Promise<unknown>>();

export function withSittingQueue<T>(sittingId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(sittingId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  queues.set(sittingId, tail);
  void tail.then(() => { if (queues.get(sittingId) === tail) queues.delete(sittingId); });
  return next;
}

// ─────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────

/** The sitting, only when it belongs to this deal. */
export async function sittingForDeal(dealId: string, sittingId: string): Promise<TogetherSitting | null> {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(sittingId)) return null;
  const s = await togetherStore().getSitting(sittingId);
  return s && s.dealId === dealId ? s : null;
}

/**
 * The deal's sitting that is happening right now: live, with a line (or its
 * start) in the last 30 minutes. The seller's own AI interview waits while
 * one exists (§7.4); a paused or ended sitting never locks.
 */
export async function liveSittingFor(dealId: string, now = Date.now()): Promise<TogetherSitting | null> {
  const open = await togetherStore().openSittings(dealId);
  return open.find((s) => s.status === "live" && now - lastActiveAt({ ...s, pausedAt: null }) < TOGETHER_LIVE_MS) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// Start / resume / pause / consent
// ─────────────────────────────────────────────────────────────────────────

export interface StartResult {
  sitting: TogetherSitting;
  resumed: boolean;
  /** Sittings this start ended (stale ones), for their summaries. */
  ended: TogetherSitting[];
}

/**
 * Start or resume (§7.3): a live or paused sitting this broker started in
 * the last 2 h is resumed (with its consent); another broker's sitting in
 * use right now (a tab seen in the last 30 s) refuses with 409; anything
 * else still open is ended, and a new sitting starts. No interview session,
 * no AI call.
 */
export async function startOrResumeSitting(
  deal: Pick<Deal, "id">,
  brokerId: string,
  via: TogetherVia,
  opts: { now?: number; endStale?: (s: TogetherSitting) => Promise<void> } = {},
): Promise<StartResult> {
  const now = opts.now ?? Date.now();
  const store = togetherStore();
  const open = await store.openSittings(deal.id);
  for (const s of open) {
    if (s.brokerId === brokerId || s.status !== "live") continue;
    const tabs = hub.activeBrokers(s.id, IN_USE_WITHIN_MS, now);
    if (tabs.size > 0 && !tabs.has(brokerId)) {
      throw new BoardActionError("Someone else is running Interview together on this deal right now.", 409, "in_use");
    }
  }
  const mine = open.find((s) => s.brokerId === brokerId && now - lastActiveAt(s) < TOGETHER_LIMITS.resumeWithinMs);
  const ended: TogetherSitting[] = [];
  for (const s of open) {
    if (s === mine) continue;
    const endedAt = new Date(Math.max(lastActiveAt(s), new Date(s.startedAt).getTime()));
    if (opts.endStale) await opts.endStale(s).catch((err) => console.warn(`[together] couldn't summarise stale sitting ${s.id}:`, (err as Error).message));
    const row = await store.updateSitting(s.id, { status: "ended", endedAt });
    if (row) ended.push(row);
    hub.publish(s.id, { type: "sitting", sitting: sittingView(row ?? s) });
    hub.closeSitting(s.id);
  }
  if (mine) {
    const patch: Partial<TogetherSitting> = {};
    if (mine.status === "paused") Object.assign(patch, { status: "live", pausedAt: null });
    // (A different way of running it on the same day continues the same
    // sitting — its transcript keeps the kind it started with.)
    if (mine.via !== via && !mine.transcriptDocumentId) patch.via = via;
    const row = Object.keys(patch).length ? (await store.updateSitting(mine.id, patch)) ?? mine : mine;
    hub.touch(row.id, brokerId);
    if (Object.keys(patch).length) hub.publish(row.id, { type: "sitting", sitting: sittingView(row) });
    return { sitting: row, resumed: true, ended };
  }
  const sitting = await store.insertSitting({
    dealId: deal.id,
    brokerId,
    via,
    status: "live",
    startedAt: new Date(now),
    speakers: {},
    sellerSeesScreen: defaultSellerSeesScreen(via),
    captureEnv: captureEnv(),
    captureState: {},
  });
  hub.touch(sitting.id, brokerId);
  return { sitting, resumed: false, ended };
}

/** "Pause listening" / the page closing (pagehide): the text is written; the sitting resumes on return. */
export async function pauseSitting(s: TogetherSitting): Promise<TogetherSitting> {
  return withSittingQueue(s.id, async () => {
    const fresh = (await togetherStore().getSitting(s.id)) ?? s;
    if (fresh.status !== "live") return fresh;
    const row = (await togetherStore().updateSitting(s.id, { status: "paused", pausedAt: new Date() })) ?? fresh;
    await writeTranscriptText(row).catch((err) => console.warn(`[together] transcript write failed on pause (${s.id}):`, (err as Error).message));
    hub.publish(s.id, { type: "sitting", sitting: sittingView(row) });
    return row;
  });
}

export async function resumeSitting(s: TogetherSitting): Promise<TogetherSitting> {
  return withSittingQueue(s.id, async () => {
    const fresh = (await togetherStore().getSitting(s.id)) ?? s;
    if (fresh.status === "ended") throw new BoardActionError("This session has ended. Start a new session to keep going.", 409, "ended");
    if (fresh.status === "live") return fresh;
    const row = (await togetherStore().updateSitting(s.id, { status: "live", pausedAt: null })) ?? fresh;
    hub.publish(s.id, { type: "sitting", sitting: sittingView(row) });
    return row;
  });
}

/** "They know — start": the broker confirmed the seller knows Cimple is taking notes. */
export async function recordConsent(s: TogetherSitting): Promise<TogetherSitting> {
  if (s.status === "ended") throw new BoardActionError("This session has ended. Start a new session to keep going.", 409, "ended");
  if (s.consentAt) return s;
  const row = (await togetherStore().updateSitting(s.id, { consentAt: new Date() })) ?? s;
  hub.publish(s.id, { type: "sitting", sitting: sittingView(row) });
  return row;
}

// ─────────────────────────────────────────────────────────────────────────
// Lines
// ─────────────────────────────────────────────────────────────────────────

export interface AppendContext {
  /** The visible items' suggested questions (the room's broker guess). Loaded lazily. */
  asks?: () => Promise<string[]>;
  /** The broker's display name (meeting participants). */
  brokerName?: () => Promise<string>;
  /** For the transcript document. */
  deal?: Pick<Deal, "id">;
  now?: number;
}

export interface AppendResult {
  accepted: TogetherLineView[];
  /** Lines already stored (a retried batch) or the other microphone's copy. */
  skipped: number;
  lastSeq: number;
}

const ASKS_TTL_MS = 5 * 60_000;
const askCache = new Map<string, { at: number; asks: string[] }>();

/**
 * Appends lines (§5.2): idempotent per (page id, page line number); spoken
 * lines need consent (409 `consent_required`); the other microphone's copy
 * of a line is dropped; the server numbers them. Updates automatic roles,
 * creates the transcript document at the first seller line, publishes a
 * `lines` event to every open tab.
 */
export async function appendLines(sittingId: string, clientId: string | null, incoming: IncomingLine[], ctx: AppendContext = {}): Promise<AppendResult> {
  return withSittingQueue(sittingId, async () => {
    const store = togetherStore();
    const s = await store.getSitting(sittingId);
    if (!s) throw new BoardActionError("That session isn't there any more.", 404, "not_found");
    if (s.status === "ended") throw new BoardActionError("This session has ended. Start a new session to keep going.", 409, "ended");
    const state = (s.captureState ?? {}) as CaptureStateLike;
    if (state.sourceDeleted) {
      throw new BoardActionError("This session's transcript was deleted, so Cimple has stopped filing from it. Start a new session to keep going.", 409, "source_deleted");
    }
    if (!s.consentAt && incoming.some((l) => isSpokenSource(l.source))) {
      throw new BoardActionError("Let the seller know Cimple is taking notes first.", 409, "consent_required");
    }
    const now = ctx.now ?? Date.now();

    // Already stored (a retry of the same batch, or a webhook redelivered).
    let fresh = incoming;
    if (clientId) {
      const seqs = incoming.map((l) => l.clientSeq).filter((n): n is number => typeof n === "number");
      const have = await store.existingClientSeqs(s.id, clientId, seqs);
      fresh = incoming.filter((l) => l.clientSeq === null || !have.has(l.clientSeq));
    }
    // The other microphone's copy of the same words (stored or in this batch).
    const recent = (await store.lastLines(s.id, 20)).map((l) => ({ speaker: l.speaker, text: l.text, at: l.at }));
    const kept: IncomingLine[] = [];
    for (const l of fresh) {
      if (l.source !== "typed" && isCrossSpeakerDuplicate(recent, l, now)) continue;
      kept.push(l);
      recent.push({ speaker: l.speaker, text: l.text, at: new Date(now) });
    }
    const skipped = incoming.length - kept.length;
    if (kept.length === 0) return { accepted: [], skipped, lastSeq: s.lineSeq };

    const at = new Date(now);
    const first = await store.reserveSeq(s.id, kept.length, at);
    const rows: InsertTogetherLine[] = kept.map((l, i) => ({
      sittingId: s.id,
      dealId: s.dealId,
      seq: first + i,
      speaker: l.speaker,
      text: l.text.slice(0, TOGETHER_LIMITS.lineTextMax),
      source: l.source,
      clientId,
      clientSeq: l.clientSeq,
      at,
    }));
    const inserted = await store.insertLines(rows);
    const lastSeq = first + kept.length - 1;
    s.lineSeq = lastSeq;
    s.lastLineAt = at;

    // Automatic roles (never over the broker's choice).
    const speakers = (s.speakers ?? {}) as SpeakerMap;
    const meta = new Map(kept.map((l) => [l.speaker, l] as const));
    const needAsks = inserted.some((l) => l.speaker.startsWith("dg:") && !speakers[l.speaker]);
    const needName = inserted.some((l) => l.speaker.startsWith("rc:") && !speakers[l.speaker]);
    const roleLines = (await store.lastLines(s.id, 40)).map((l) => ({ speaker: l.speaker, text: l.text, name: meta.get(l.speaker)?.name ?? null, isHost: meta.get(l.speaker)?.isHost ?? null }));
    const asks = needAsks && ctx.asks ? await cachedAsks(s.id, ctx.asks) : undefined;
    const brokerName = needName && ctx.brokerName ? await ctx.brokerName().catch(() => "") : undefined;
    const roles = autoRoles(speakers, roleLines, { asks, brokerName });
    if (roles.changed) {
      s.speakers = roles.speakers;
      await store.updateSitting(s.id, { speakers: roles.speakers });
    }

    // The transcript row, at the first seller line; its text every 5 minutes.
    if (ctx.deal) {
      const sellerNow = hasSellerLine(roles.speakers, inserted);
      if (sellerNow && !s.transcriptDocumentId) {
        await ensureTranscriptDocument(s, ctx.deal).catch((err) => console.warn(`[together] transcript row failed (${s.id}):`, (err as Error).message));
      }
      const writtenAt = Date.parse(String((s.captureState as { transcriptWrittenAt?: string } | null)?.transcriptWrittenAt ?? ""));
      if (s.transcriptDocumentId && (sellerNow || roles.changed) && (Number.isNaN(writtenAt) || now - writtenAt >= TRANSCRIPT_WRITE_EVERY_MS)) {
        await writeTranscriptText(s).catch((err) => console.warn(`[together] transcript write failed (${s.id}):`, (err as Error).message));
      }
    }

    hub.publish(s.id, { type: "lines", lines: inserted.map(lineView) });
    if (roles.changed) hub.publish(s.id, { type: "sitting", sitting: sittingView(s) });
    return { accepted: inserted.map(lineView), skipped, lastSeq };
  });
}

async function cachedAsks(sittingId: string, load: () => Promise<string[]>): Promise<string[]> {
  const hit = askCache.get(sittingId);
  if (hit && Date.now() - hit.at < ASKS_TTL_MS) return hit.asks;
  const asks = await load().catch(() => [] as string[]);
  askCache.set(sittingId, { at: Date.now(), asks });
  return asks;
}

/** The broker says who a speaker is. Returns the updated sitting. */
export async function setSpeakerRole(sittingId: string, speaker: string, role: Exclude<SpeakerRole, "unknown">, ctx: { deal?: Pick<Deal, "id"> } = {}): Promise<TogetherSitting> {
  return withSittingQueue(sittingId, async () => {
    const store = togetherStore();
    const s = await store.getSitting(sittingId);
    if (!s) throw new BoardActionError("That session isn't there any more.", 404, "not_found");
    const lines = await store.lastLines(s.id, 400);
    const present = Array.from(new Set(lines.map((l) => l.speaker)));
    if (!present.includes(speaker)) throw new BoardActionError("Nobody with that label has spoken yet.", 400, "unknown_speaker");
    const speakers = applySpeakerChoice((s.speakers ?? {}) as SpeakerMap, present, speaker, role);
    const row = (await store.updateSitting(s.id, { speakers })) ?? { ...s, speakers };
    if (ctx.deal && !row.transcriptDocumentId && hasSellerLine(speakers, lines)) {
      await ensureTranscriptDocument(row, ctx.deal).catch(() => null);
    }
    if (row.transcriptDocumentId) await writeTranscriptText(row).catch(() => undefined);
    hub.publish(s.id, { type: "sitting", sitting: sittingView(row) });
    return row;
  });
}

/** "Seller can see this screen" on the sitting (the board follows it on every path). */
export async function setSellerSeesScreen(s: TogetherSitting, on: boolean): Promise<TogetherSitting> {
  if (!!s.sellerSeesScreen === on) return s;
  const row = (await togetherStore().updateSitting(s.id, { sellerSeesScreen: on })) ?? s;
  hub.publish(s.id, { type: "sitting", sitting: sittingView(row) });
  return row;
}

/** Lines whose speaker counts as the seller (attested or by role). */
export function sellerLines(s: Pick<TogetherSitting, "speakers">, lines: TogetherLine[]): TogetherLine[] {
  const speakers = (s.speakers ?? {}) as SpeakerMap;
  return lines.filter((l) => lineRole(speakers, { speaker: l.speaker, attested: !!l.attestedSellerAt }) === "seller");
}

/** The sitting's audience for every board it sends. */
export function sittingAudience(s: Pick<TogetherSitting, "sellerSeesScreen">): "broker" | "screen" {
  return s.sellerSeesScreen ? "screen" : "broker";
}

/** Exported for tests. */
export function _resetSittingCachesForTests(): void {
  askCache.clear();
  queues.clear();
}

export { asDate };
