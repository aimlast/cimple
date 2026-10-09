/**
 * Live events for "Interview together" (specs/together.md §7.2, §8.3):
 * every open board tab of a sitting gets the same stream (SSE), and a tab
 * whose proxy blocks SSE polls `GET …/state?after=<eventSeq>` instead.
 *
 * In-process (single instance — §13 risk 9). Per sitting: a monotonic
 * event number, a ring buffer of the last 200 events (what a poll or a
 * reconnect catches up from), and the subscribers. Events never carry a
 * board in another audience than the sitting's ("Seller can see this
 * screen" — the publisher builds it in the sitting's current audience).
 */
import type { Request, Response } from "express";
import type { SeqEvent, TogetherEvent } from "@shared/together";

export const HUB_BUFFER = 200;
export const HEARTBEAT_MS = 15_000;

interface Subscriber {
  res: Response;
  brokerId: string;
  heartbeat: ReturnType<typeof setInterval>;
}

interface Channel {
  seq: number;
  buffer: SeqEvent[];
  subs: Set<Subscriber>;
  /** brokerId → last time one of their tabs was seen (connect, POST, heartbeat). */
  seen: Map<string, number>;
  touchedAt: number;
}

const channels = new Map<string, Channel>();

function channel(sittingId: string): Channel {
  let c = channels.get(sittingId);
  if (!c) {
    c = { seq: 0, buffer: [], subs: new Set(), seen: new Map(), touchedAt: Date.now() };
    channels.set(sittingId, c);
  }
  return c;
}

function write(res: Response, ev: SeqEvent): boolean {
  try {
    res.write(`id: ${ev.eventSeq}\ndata: ${JSON.stringify(ev)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** Publishes an event to every open tab of the sitting; returns its number. */
export function publish(sittingId: string, event: TogetherEvent): number {
  const c = channel(sittingId);
  c.seq += 1;
  c.touchedAt = Date.now();
  const ev = { ...event, eventSeq: c.seq } as SeqEvent;
  // (A `board` event is a snapshot: older ones are useless to a poller.)
  if (event.type === "board") c.buffer = c.buffer.filter((e) => e.type !== "board");
  c.buffer.push(ev);
  if (c.buffer.length > HUB_BUFFER) c.buffer.splice(0, c.buffer.length - HUB_BUFFER);
  c.subs.forEach((s) => {
    if (!write(s.res, ev)) unsubscribe(sittingId, s);
  });
  return c.seq;
}

export function eventSeqOf(sittingId: string): number {
  return channels.get(sittingId)?.seq ?? 0;
}

function unsubscribe(sittingId: string, s: Subscriber) {
  clearInterval(s.heartbeat);
  channels.get(sittingId)?.subs.delete(s);
}

/**
 * Opens the stream for one tab: headers, a `hello` with the current event
 * number (and whatever `hello` carries), a heartbeat comment every 15 s.
 * A reconnect with `Last-Event-ID` first receives the events it missed
 * (when they are still buffered).
 */
export function subscribe(
  sittingId: string,
  req: Request,
  res: Response,
  opts: { brokerId: string; hello: (eventSeq: number) => TogetherEvent },
): void {
  const c = channel(sittingId);
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as Response & { flushHeaders?: () => void }).flushHeaders?.();
  res.write("retry: 3000\n\n");
  const lastId = Number(req.get("last-event-id") ?? NaN);
  if (Number.isFinite(lastId) && lastId > 0 && c.buffer.length > 0 && c.buffer[0].eventSeq <= lastId + 1) {
    for (const ev of c.buffer) if (ev.eventSeq > lastId) write(res, ev);
  }
  write(res, { ...opts.hello(c.seq), eventSeq: c.seq } as SeqEvent);
  const sub: Subscriber = {
    res,
    brokerId: opts.brokerId,
    heartbeat: setInterval(() => {
      try {
        res.write(`: hb\n\n`);
        c.seen.set(opts.brokerId, Date.now());
      } catch {
        unsubscribe(sittingId, sub);
      }
    }, HEARTBEAT_MS),
  };
  (sub.heartbeat as { unref?: () => void }).unref?.();
  c.subs.add(sub);
  c.seen.set(opts.brokerId, Date.now());
  const done = () => unsubscribe(sittingId, sub);
  req.on("close", done);
  res.on("close", done);
}

/** Events after `after` for the poll fallback — or `reset` when they are no longer buffered. */
export function stateSince(sittingId: string, after: number): { eventSeq: number; events: SeqEvent[]; reset: boolean } {
  const c = channels.get(sittingId);
  if (!c) return { eventSeq: 0, events: [], reset: after > 0 };
  if (after >= c.seq) return { eventSeq: c.seq, events: [], reset: after > c.seq };
  const first = c.buffer[0]?.eventSeq ?? c.seq + 1;
  if (after + 1 < first) return { eventSeq: c.seq, events: c.buffer.slice(), reset: true };
  return { eventSeq: c.seq, events: c.buffer.filter((e) => e.eventSeq > after), reset: false };
}

/** Records that a broker's tab acted on the sitting (a POST, a poll). */
export function touch(sittingId: string, brokerId: string): void {
  const c = channel(sittingId);
  c.seen.set(brokerId, Date.now());
  c.touchedAt = Date.now();
}

/** Brokers with a tab on this sitting seen within `withinMs` (an open stream counts as seen). */
export function activeBrokers(sittingId: string, withinMs: number, now = Date.now()): Set<string> {
  const c = channels.get(sittingId);
  const out = new Set<string>();
  if (!c) return out;
  c.subs.forEach((s) => out.add(s.brokerId));
  c.seen.forEach((at, id) => { if (now - at <= withinMs) out.add(id); });
  return out;
}

export function subscriberCount(sittingId: string): number {
  return channels.get(sittingId)?.subs.size ?? 0;
}

/** Ends every stream of a sitting (it ended, or its transcript was deleted). */
export function closeSitting(sittingId: string): void {
  const c = channels.get(sittingId);
  if (!c) return;
  c.subs.forEach((s) => {
    clearInterval(s.heartbeat);
    try { s.res.end(); } catch { /* closed */ }
  });
  c.subs.clear();
}

// Channels idle for an hour with nobody listening are dropped.
const sweeper = setInterval(() => {
  const now = Date.now();
  channels.forEach((c, id) => {
    if (c.subs.size === 0 && now - c.touchedAt > 60 * 60_000) channels.delete(id);
  });
}, 10 * 60_000);
(sweeper as { unref?: () => void }).unref?.();

export function _resetHubForTests(): void {
  channels.forEach((c, id) => closeSitting(id));
  channels.clear();
}
