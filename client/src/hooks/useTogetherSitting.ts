/**
 * One "Interview together" session on the board (specs/together.md §8.3):
 * starts or resumes the sitting (no AI call), listens to its live events
 * (SSE; after 3 failed connections it polls `…/state` every 2 s), sends what
 * was said with this page's id and line numbers (a retry, a reload or a
 * second tab never doubles a line; while offline up to 10 minutes are kept),
 * and pauses the sitting when the page closes.
 *
 * The board arrives in the sitting's audience: while "Seller can see this
 * screen" is on, the server only ever sends the seller-safe screen board,
 * and the broker board is dropped from the cache (useCoverageBoard).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { queryClient } from "@/lib/queryClient";
import { coverageBoardKey, invalidateCoverage } from "@/hooks/useCoverageBoard";
import { LineBuffer } from "@/components/together/line-buffer";
import type { CoverageBoard } from "@shared/coverage-board";
import type {
  LineSource,
  ListenState,
  SeqEvent,
  SittingSummary,
  SpeakerRole,
  TogetherLineView,
  TogetherSittingView,
  TogetherVia,
} from "@shared/together";

const LINES_KEPT = 400;
const POLL_MS = 2_000;
const SSE_FAILURES_BEFORE_POLL = 3;

export type Connection = "connecting" | "live" | "polling" | "offline";

async function json<T>(r: Response, fallback: string): Promise<T> {
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error((body && typeof body.error === "string" && body.error) || fallback) as Error & { code?: string; status?: number; details?: unknown };
    err.code = body?.code;
    err.status = r.status;
    err.details = body;
    throw err;
  }
  return body as T;
}

function newClientId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function mergeLines(prev: TogetherLineView[], add: TogetherLineView[]): TogetherLineView[] {
  if (add.length === 0) return prev;
  const bySeq = new Map(prev.map((l) => [l.seq, l] as const));
  for (const l of add) bySeq.set(l.seq, l);
  const out = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  return out.length > LINES_KEPT ? out.slice(out.length - LINES_KEPT) : out;
}

export interface TogetherSittingApi {
  sitting: TogetherSittingView | null;
  lines: TogetherLineView[];
  starting: boolean;
  startError: string | null;
  connection: Connection;
  /** Lines said but not yet on the server (connection lost). */
  unsent: number;
  /** The notetaker's state pushed by the server (Zoom / Meet / Teams). */
  notetaker: ListenState | null;
  retryStart: () => void;
  postLine: (line: { speaker: string; text: string; source: LineSource }) => void;
  consent: () => Promise<boolean>;
  setSpeaker: (speaker: string, role: Exclude<SpeakerRole, "unknown">) => Promise<void>;
  setScreen: (on: boolean) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  loadSummary: () => Promise<SittingSummary>;
  end: (body: { completeInterview: boolean; followUps: Array<{ itemId: string; ask: string }>; documents: string[]; addToNextSession: boolean }) => Promise<{ summary: SittingSummary; followUpsAdded: number }>;
  base: string | null;
}

export function useTogetherSitting(dealId: string, via: TogetherVia, opts: { enabled: boolean }): TogetherSittingApi {
  const [sitting, setSitting] = useState<TogetherSittingView | null>(null);
  const [lines, setLines] = useState<TogetherLineView[]>([]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [unsent, setUnsent] = useState(0);
  const [notetaker, setNotetaker] = useState<ListenState | null>(null);
  const clientId = useRef(newClientId());
  const buffer = useRef(new LineBuffer());
  const eventSeq = useRef(0);
  const sittingRef = useRef<TogetherSittingView | null>(null);
  sittingRef.current = sitting;
  const flushing = useRef(false);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const base = sitting ? `/api/deals/${dealId}/together/sittings/${sitting.id}` : null;

  const applyBoard = useCallback((board: CoverageBoard) => {
    const audience = board.audience === "screen" ? "screen" : "broker";
    queryClient.setQueryData(coverageBoardKey(dealId, audience), board);
    // (The other audience's copy never stays in the page.)
    queryClient.removeQueries({ queryKey: coverageBoardKey(dealId, audience === "screen" ? "broker" : "screen") });
  }, [dealId]);

  const applyEvent = useCallback((ev: SeqEvent) => {
    if (typeof ev.eventSeq === "number" && ev.eventSeq > eventSeq.current) eventSeq.current = ev.eventSeq;
    switch (ev.type) {
      case "hello":
        setSitting(ev.sitting);
        if (ev.sitting.notetaker) setNotetaker(ev.sitting.notetaker);
        break;
      case "sitting":
        setSitting(ev.sitting);
        if (ev.sitting.notetaker) setNotetaker(ev.sitting.notetaker);
        break;
      case "lines":
        setLines((prev) => mergeLines(prev, ev.lines));
        break;
      case "board":
        applyBoard(ev.board as CoverageBoard);
        break;
      case "filed":
        // (Live filing — the next board read carries the change.)
        invalidateCoverage(dealId);
        break;
      case "listen":
        setNotetaker(ev.state);
        break;
      default:
        break;
    }
  }, [applyBoard, dealId]);

  // ── Start or resume ──
  useEffect(() => {
    if (!opts.enabled || !dealId) return;
    let cancelled = false;
    setStarting(true);
    setStartError(null);
    (async () => {
      try {
        const r = await fetch(`/api/deals/${dealId}/together/sittings`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ via }),
        });
        const data = await json<{ sitting: TogetherSittingView; board: CoverageBoard; lines: TogetherLineView[] }>(r, "Couldn't start the session");
        if (cancelled) return;
        setSitting(data.sitting);
        setLines(data.lines);
        if (data.sitting.notetaker) setNotetaker(data.sitting.notetaker);
        applyBoard(data.board);
      } catch (e) {
        if (!cancelled) setStartError((e as Error).message);
      } finally {
        if (!cancelled) setStarting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dealId, via, opts.enabled, attempt, applyBoard]);

  // ── Live events: SSE, falling back to polling ──
  const sittingId = sitting?.id ?? null;
  const ended = sitting?.status === "ended";
  useEffect(() => {
    if (!sittingId || ended) return;
    const url = `/api/deals/${dealId}/together/sittings/${sittingId}`;
    let es: EventSource | null = null;
    let failures = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let inFlight = false;
    const poll = async () => {
      // (One poll at a time — a slow answer never piles requests up.)
      if (inFlight) return;
      inFlight = true;
      try {
        const r = await fetch(`${url}/state?after=${eventSeq.current}`, { credentials: "include" });
        const data = await json<{ eventSeq: number; events: SeqEvent[]; reset: boolean; sitting?: TogetherSittingView; board?: CoverageBoard; lines?: TogetherLineView[] }>(r, "");
        if (closed) return;
        setConnection("polling");
        if (data.reset) {
          if (data.sitting) setSitting(data.sitting);
          if (data.lines) setLines(data.lines);
          if (data.board) applyBoard(data.board);
          eventSeq.current = data.eventSeq;
        } else {
          for (const ev of data.events) applyEvent(ev);
        }
      } catch {
        if (!closed) setConnection("offline");
      } finally {
        inFlight = false;
      }
    };
    const startPolling = () => {
      if (pollTimer) return;
      void poll();
      pollTimer = setInterval(poll, POLL_MS);
    };
    // (?events=poll forces the fallback — for a proxy that blocks streams, and for testing it.)
    const forcePoll = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("events") === "poll";
    if (typeof EventSource === "undefined" || forcePoll) {
      startPolling();
    } else {
      es = new EventSource(`${url}/events`, { withCredentials: true });
      es.onopen = () => { failures = 0; setConnection("live"); };
      es.onmessage = (m) => {
        failures = 0;
        try { applyEvent(JSON.parse(m.data) as SeqEvent); } catch { /* not ours */ }
      };
      es.onerror = () => {
        failures++;
        setConnection("connecting");
        if (failures >= SSE_FAILURES_BEFORE_POLL) {
          es?.close();
          es = null;
          startPolling();
        }
      };
    }
    return () => {
      closed = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [sittingId, ended, dealId, applyEvent, applyBoard]);

  // ── Sending what was said ──
  const flush = useCallback(async () => {
    const s = sittingRef.current;
    if (!s || flushing.current || s.status === "ended") return;
    const batch = buffer.current.take();
    if (batch.length === 0) return;
    flushing.current = true;
    const seqs = batch.map((b) => b.clientSeq);
    try {
      const r = await fetch(`/api/deals/${dealId}/together/sittings/${s.id}/lines`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: clientId.current, lines: batch.map((b) => ({ clientSeq: b.clientSeq, speaker: b.speaker, text: b.text, source: b.source, at: b.at })) }),
      });
      if (r.ok || r.status === 400 || r.status === 409) {
        // (Refused for good — consent, an ended session, a bad line — is not retried.)
        buffer.current.ack(seqs);
        if (connection === "offline") setConnection("live");
      } else {
        buffer.current.release(seqs);
        setConnection("offline");
      }
    } catch {
      buffer.current.release(seqs);
      setConnection("offline");
    } finally {
      flushing.current = false;
      setUnsent(buffer.current.size);
      if (buffer.current.size > 0) {
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(() => void flush(), connection === "offline" ? 3_000 : 250);
      }
    }
  }, [dealId, connection]);

  const postLine = useCallback((line: { speaker: string; text: string; source: LineSource }) => {
    if (!line.text.trim()) return;
    buffer.current.add(line);
    setUnsent(buffer.current.size);
    void flush();
  }, [flush]);

  // Back online: send what waited.
  useEffect(() => {
    const online = () => { setConnection("connecting"); void flush(); };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [flush]);

  // ── Leaving the page pauses the sitting (it resumes on return) ──
  useEffect(() => {
    if (!sittingId || ended) return;
    const url = `/api/deals/${dealId}/together/sittings/${sittingId}/pause`;
    const leave = () => { void fetch(url, { method: "POST", credentials: "include", keepalive: true }).catch(() => {}); };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
    };
  }, [sittingId, ended, dealId]);

  const call = useCallback(async <T,>(path: string, method: string, body?: unknown, fallback = "That didn't work"): Promise<T> => {
    const s = sittingRef.current;
    if (!s) throw new Error("The session hasn't started yet.");
    const r = await fetch(`/api/deals/${dealId}/together/sittings/${s.id}${path}`, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return json<T>(r, fallback);
  }, [dealId]);

  const consent = useCallback(async () => {
    const out = await call<{ sitting: TogetherSittingView }>("/consent", "POST", {}, "Couldn't save that");
    setSitting(out.sitting);
    return true;
  }, [call]);

  const setSpeaker = useCallback(async (speaker: string, role: Exclude<SpeakerRole, "unknown">) => {
    const out = await call<{ sitting: TogetherSittingView }>("/speakers", "POST", { speaker, role }, "Couldn't save who that is");
    setSitting(out.sitting);
  }, [call]);

  const setScreen = useCallback(async (on: boolean) => {
    const out = await call<{ sitting: TogetherSittingView; board: CoverageBoard }>("", "PATCH", { sellerSeesScreen: on }, "Couldn't change that");
    setSitting(out.sitting);
    applyBoard(out.board);
  }, [call, applyBoard]);

  const pause = useCallback(async () => {
    const out = await call<{ sitting: TogetherSittingView }>("/pause", "POST", {}, "Couldn't pause");
    setSitting(out.sitting);
  }, [call]);

  const resume = useCallback(async () => {
    const out = await call<{ sitting: TogetherSittingView }>("/resume", "POST", {}, "Couldn't resume");
    setSitting(out.sitting);
  }, [call]);

  const loadSummary = useCallback(() => call<SittingSummary>("/summary", "GET", undefined, "Couldn't build the summary"), [call]);

  const end = useCallback(async (body: Parameters<TogetherSittingApi["end"]>[0]) => {
    // (What's still waiting goes first.)
    await flush();
    const out = await call<{ sitting: TogetherSittingView; summary: SittingSummary; followUpsAdded: number }>("/end", "POST", body, "Couldn't end the session");
    setSitting(out.sitting);
    invalidateCoverage(dealId);
    queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "together-sittings"] });
    queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
    return { summary: out.summary, followUpsAdded: out.followUpsAdded };
  }, [call, flush, dealId]);

  return useMemo(() => ({
    sitting,
    lines,
    starting,
    startError,
    connection,
    unsent,
    notetaker,
    retryStart: () => setAttempt((n) => n + 1),
    postLine,
    consent,
    setSpeaker,
    setScreen,
    pause,
    resume,
    loadSummary,
    end,
    base,
  }), [sitting, lines, starting, startError, connection, unsent, notetaker, postLine, consent, setSpeaker, setScreen, pause, resume, loadSummary, end, base]);
}
