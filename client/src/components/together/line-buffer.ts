/**
 * Pure helpers for the "Interview together" page (no DOM, no fetch —
 * tested in tests/unit/together-client.test.ts).
 *
 * LineBuffer: what was said waits here until the server has it. Each line
 * gets the page's next number (clientSeq, from 0 for every page load — the
 * page id makes it unique), so a retried batch is de-duplicated by the
 * server. While the connection is lost, up to 10 minutes / 2,000 lines are
 * kept and sent when it's back (§5.10).
 */
import type { LineSource, ListenState } from "@shared/together";

export interface PendingLine {
  clientSeq: number;
  speaker: string;
  text: string;
  source: LineSource;
  at: string;
  queuedAt: number;
}

export const OFFLINE_MAX_MS = 10 * 60_000;
export const OFFLINE_MAX_LINES = 2_000;
export const BATCH_MAX = 50;

export class LineBuffer {
  private next = 0;
  private pending: PendingLine[] = [];
  private inFlight = new Set<number>();

  constructor(private readonly limits = { maxAgeMs: OFFLINE_MAX_MS, maxLines: OFFLINE_MAX_LINES }) {}

  /** Queues a final line; returns it with its page number. */
  add(line: { speaker: string; text: string; source: LineSource }, now = Date.now()): PendingLine {
    const p: PendingLine = { clientSeq: this.next++, speaker: line.speaker, text: line.text.trim(), source: line.source, at: new Date(now).toISOString(), queuedAt: now };
    this.pending.push(p);
    this.prune(now);
    return p;
  }

  /** The oldest lines not already being sent (at most BATCH_MAX). Marks them in flight. */
  take(max = BATCH_MAX): PendingLine[] {
    const out = this.pending.filter((p) => !this.inFlight.has(p.clientSeq)).slice(0, max);
    for (const p of out) this.inFlight.add(p.clientSeq);
    return out;
  }

  /** The server has them. */
  ack(seqs: number[]): void {
    const done = new Set(seqs);
    this.pending = this.pending.filter((p) => !done.has(p.clientSeq));
    for (const s of seqs) this.inFlight.delete(s);
  }

  /** A send failed: they go back in line (same numbers — the retry is idempotent). */
  release(seqs: number[]): void {
    for (const s of seqs) this.inFlight.delete(s);
  }

  /** Drops what's older than the offline window or over the cap; returns how many were dropped. */
  prune(now = Date.now()): number {
    const before = this.pending.length;
    this.pending = this.pending.filter((p) => now - p.queuedAt <= this.limits.maxAgeMs);
    if (this.pending.length > this.limits.maxLines) this.pending.splice(0, this.pending.length - this.limits.maxLines);
    return before - this.pending.length;
  }

  get size(): number {
    return this.pending.length;
  }

  /** The next page number (for tests). */
  get nextSeq(): number {
    return this.next;
  }
}

/** A microphone error as a listening state (§4.5). */
export function listenStateForError(err: unknown): ListenState {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "mic_blocked";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "no_mic";
  return "stopped";
}

/** The browser's speech recognition error code as a listening state. */
export function listenStateForRecognitionError(code: string): ListenState | null {
  if (code === "not-allowed" || code === "service-not-allowed") return "mic_blocked";
  if (code === "audio-capture") return "no_mic";
  if (code === "aborted" || code === "no-speech") return null;
  return "stopped";
}

/** A Daily participant id as a speaker id ("daily:<id>"; safe characters only). */
export function dailySpeaker(local: boolean, participantId: string): string {
  if (local) return "daily:local";
  const id = String(participantId ?? "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 50) || "remote";
  return `daily:${id}`;
}

/** Is a listening session quiet for too long (60 s with nothing final heard)? */
export function isSilent(lastHeardAt: number | null, startedAt: number | null, now: number, threshold = 60_000): boolean {
  const since = lastHeardAt ?? startedAt;
  return since !== null && now - since >= threshold;
}
