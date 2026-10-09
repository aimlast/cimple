/**
 * How Cimple hears the conversation on the "Interview together" board
 * (specs/together.md §4.4, §4.5) — moved here from the old question flow:
 *
 *   In person   Deepgram in the browser (voices told apart); without it,
 *               the browser's own recognition ("basic listening": every
 *               answer becomes a possible answer the broker ticks).
 *   Cimple call Daily — the broker's own microphone is the broker, the other
 *               participant the seller (exact, no voice guessing).
 *   Zoom / Meet / Teams  Cimple's notetaker joins the call; its lines reach
 *               the board through the server (Recall webhook) — this hook
 *               only sends it and shows its state.
 *
 * Every final line goes to `onLine` (the sitting posts it). The first start
 * of a sitting asks for consent first (D15). Every listening problem has a
 * plain state: microphone blocked, no microphone, listening stopped (one
 * automatic retry after 3 s), a minute of silence, the notetaker waiting to
 * be admitted / removed / couldn't join / meeting over.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DailyCall } from "@daily-co/daily-js";
import { startLiveTranscription, NotConfiguredError, type LiveTranscriptionHandle } from "@/lib/live-transcription";
import { createDailyCall, joinDailyCall, type CallHandle } from "@/lib/daily-call";
import { dailySpeaker, isSilent, listenStateForError, listenStateForRecognitionError } from "@/components/together/line-buffer";
import { SILENCE_WATCHDOG_MS, isNotetakerVia, type LineSource, type ListenState, type TogetherVia } from "@shared/together";

export interface LiveListeningOptions {
  dealId: string;
  sittingId: string | null;
  via: TogetherVia;
  /** The sitting already has the broker's "they know" (D15). */
  consented: boolean;
  /** Opens the consent dialog; resolves true once the broker confirmed (and it's recorded). */
  requestConsent: () => Promise<boolean>;
  onLine: (line: { speaker: string; text: string; source: LineSource }) => void;
  /** The notetaker's state pushed by the server. */
  notetakerState: ListenState | null;
  /** Lines arriving from the server (the notetaker's), for the silence watchdog. */
  lastServerLineAt?: number | null;
  sessionEnded?: boolean;
}

export interface LiveListening {
  state: ListenState;
  detail: string | null;
  /** Browser recognition only (no voices told apart). */
  basic: boolean;
  interim: string;
  startedAt: number | null;
  start: () => Promise<void>;
  pause: () => void;
  // Cimple call
  callObject: DailyCall | null;
  remoteCount: number;
  leaveCall: () => Promise<void>;
  // Notetaker
  sendNotetaker: (url: string) => Promise<void>;
}

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function speechRecognition(): SpeechRecognitionLike | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  const C = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return C ? new C() : null;
}

export function useLiveListening(o: LiveListeningOptions): LiveListening {
  const [state, setState] = useState<ListenState>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [basic, setBasic] = useState(false);
  const [interim, setInterim] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [callObject, setCallObject] = useState<DailyCall | null>(null);
  const [remoteCount, setRemoteCount] = useState(0);
  const stateRef = useRef<ListenState>("idle");
  stateRef.current = state;
  const lastHeard = useRef<number | null>(null);
  const deepgram = useRef<LiveTranscriptionHandle | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const wantRecognition = useRef(false);
  const callHandle = useRef<CallHandle | null>(null);
  const callStarted = useRef(false);
  const botSent = useRef(false);
  const retriedAt = useRef(0);
  const onLineRef = useRef(o.onLine);
  onLineRef.current = o.onLine;
  const notetaker = isNotetakerVia(o.via);

  const heard = useCallback((speaker: string, text: string, source: LineSource) => {
    const t = text.trim();
    if (!t) return;
    lastHeard.current = Date.now();
    setInterim("");
    if (stateRef.current === "silent") setState("listening");
    onLineRef.current({ speaker, text: t, source });
  }, []);

  const stopAll = useCallback(() => {
    deepgram.current?.stop();
    deepgram.current = null;
    wantRecognition.current = false;
    try { recognition.current?.stop(); } catch { /* stopped */ }
    recognition.current = null;
    setInterim("");
  }, []);

  // ── In person ──
  const startBrowserRecognition = useCallback(() => {
    const rec = speechRecognition();
    if (!rec) {
      setState("unavailable");
      setDetail("This browser can't listen — use Chrome or Edge, or type what the seller says below.");
      return;
    }
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e: any) => {
      let partial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) heard("room", r[0].transcript, "browser");
        else partial += r[0].transcript;
      }
      setInterim(partial);
    };
    rec.onerror = (e: any) => {
      const s = listenStateForRecognitionError(String(e?.error ?? ""));
      if (s) {
        wantRecognition.current = false;
        setState(s);
      }
    };
    rec.onend = () => {
      // Chrome ends recognition after a stretch of silence — start it again.
      if (wantRecognition.current) setTimeout(() => { if (wantRecognition.current) try { rec.start(); } catch { /* starting */ } }, 400);
    };
    wantRecognition.current = true;
    recognition.current = rec;
    try {
      rec.start();
      setBasic(true);
      setState("listening");
      setStartedAt((t) => t ?? Date.now());
    } catch (err) {
      setState(listenStateForError(err));
    }
  }, [heard]);

  const startInPerson = useCallback(async () => {
    setState("starting");
    setDetail(null);
    try {
      deepgram.current = await startLiveTranscription({
        dealId: o.dealId,
        onSegment: (seg) => {
          if (!seg.isFinal) { setInterim(seg.text); return; }
          heard(`dg:${seg.speaker}`, seg.text, "deepgram");
        },
        onUtteranceEnd: () => {},
        onError: (message) => {
          deepgram.current?.stop();
          deepgram.current = null;
          setState("stopped");
          setDetail(message);
          // One automatic retry after 3 s (not more than once a minute).
          if (Date.now() - retriedAt.current > 60_000) {
            retriedAt.current = Date.now();
            setTimeout(() => { if (stateRef.current === "stopped") void startInPersonRef.current(); }, 3_000);
          }
        },
      });
      setBasic(false);
      setState("listening");
      setStartedAt((t) => t ?? Date.now());
      lastHeard.current = Date.now();
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        startBrowserRecognition();
        return;
      }
      setState(listenStateForError(err));
      setDetail((err as Error)?.message ?? null);
    }
  }, [o.dealId, heard, startBrowserRecognition]);
  const startInPersonRef = useRef(startInPerson);
  startInPersonRef.current = startInPerson;

  // ── Cimple call ──
  const startCall = useCallback(async () => {
    if (callStarted.current) return;
    callStarted.current = true;
    setState("call_joining");
    setDetail(null);
    try {
      const r = await fetch(`/api/interview/${o.dealId}/call/start`, { method: "POST", credentials: "include" });
      if (r.status === 503) {
        callStarted.current = false;
        setState("unavailable");
        setDetail("Cimple calls aren't set up on this server. Use Zoom, Meet or Teams, or meet in person.");
        return;
      }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn't start the call");
      const { roomUrl, token } = await r.json();
      const call = createDailyCall();
      setCallObject(call);
      call.on("transcription-stopped", () => { if (callHandle.current) setState("stopped"); });
      callHandle.current = await joinDailyCall(call, {
        roomUrl,
        token,
        onTranscript: (line) => {
          if (!line.isFinal) { setInterim(line.text); return; }
          heard(dailySpeaker(line.local, line.participantId), line.text, "daily");
        },
        onLeft: () => { setState("call_left"); },
        onError: (m) => setDetail(m),
        onRemoteCount: (n) => {
          setRemoteCount(n);
          setState((s) => (s === "call_waiting" && n > 0 ? "listening" : s === "listening" && n === 0 ? "call_waiting" : s));
        },
      });
      setStartedAt((t) => t ?? Date.now());
      lastHeard.current = Date.now();
      setState(remoteCountNow(call) > 0 ? "listening" : "call_waiting");
    } catch (err) {
      callStarted.current = false;
      setState(listenStateForError(err));
      setDetail((err as Error)?.message ?? "Couldn't start the call");
    }
  }, [o.dealId, heard]);

  const leaveCall = useCallback(async () => {
    const h = callHandle.current;
    callHandle.current = null;
    callStarted.current = false;
    setCallObject(null);
    setState("call_left");
    if (h) await h.leave();
  }, []);

  // ── Zoom / Meet / Teams notetaker ──
  const sendNotetaker = useCallback(async (url: string) => {
    if (!url.trim() || !o.sittingId) return;
    if (!o.consented && !(await o.requestConsent())) return;
    setState("notetaker_joining");
    setDetail(null);
    try {
      const r = await fetch(`/api/interview/${o.dealId}/call/bot/start`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingUrl: url.trim(), sittingId: o.sittingId }),
      });
      if (r.status === 503) {
        setState("unavailable");
        setDetail("The notetaker isn't set up on this server. Type what the seller says below, or tick answers as you go.");
        return;
      }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn't send the notetaker");
      botSent.current = true;
      setStartedAt((t) => t ?? Date.now());
    } catch (err) {
      setState("notetaker_failed");
      setDetail((err as Error)?.message ?? null);
    }
  }, [o.dealId, o.sittingId, o.consented, o.requestConsent]);

  // ── Start / pause ──
  const start = useCallback(async () => {
    if (o.sessionEnded) return;
    if (!o.consented && !(await o.requestConsent())) return;
    if (o.via === "cimple") {
      if (stateRef.current === "stopped" && callHandle.current) {
        try {
          await callHandle.current.call.startTranscription({ language: "en", model: "nova-2", punctuate: true, endpointing: 500 } as never);
          setState(remoteCount > 0 ? "listening" : "call_waiting");
        } catch (err) {
          setDetail((err as Error)?.message ?? null);
        }
        return;
      }
      await startCall();
      return;
    }
    if (notetaker) return;
    stopAll();
    await startInPerson();
  }, [o.sessionEnded, o.consented, o.requestConsent, o.via, startCall, startInPerson, stopAll, notetaker, remoteCount]);

  const pause = useCallback(() => {
    if (o.via === "cimple") { void leaveCall(); return; }
    stopAll();
    setState("paused");
  }, [o.via, leaveCall, stopAll]);

  // The notetaker's state comes from the server.
  useEffect(() => {
    if (notetaker && o.notetakerState) setState(o.notetakerState);
  }, [notetaker, o.notetakerState]);

  // Silence watchdog: a minute with nothing heard (nothing is stopped).
  useEffect(() => {
    if (notetaker) return;
    const id = setInterval(() => {
      if (stateRef.current !== "listening") return;
      if (isSilent(lastHeard.current, startedAt, Date.now(), SILENCE_WATCHDOG_MS)) setState("silent");
    }, 5_000);
    return () => clearInterval(id);
  }, [notetaker, startedAt]);

  // The session ended (here or in another tab): stop hearing.
  useEffect(() => {
    if (!o.sessionEnded) return;
    stopAll();
    if (callHandle.current) void leaveCall();
  }, [o.sessionEnded, stopAll, leaveCall]);

  // Leaving the page: the microphone stops, the call ends for everyone, the notetaker leaves.
  useEffect(() => {
    const dealId = o.dealId;
    const leave = () => {
      if (callStarted.current || callHandle.current) {
        void callHandle.current?.leave();
        callHandle.current = null;
        void fetch(`/api/interview/${dealId}/call/end`, { method: "POST", credentials: "include", keepalive: true }).catch(() => {});
        callStarted.current = false;
      }
      if (botSent.current) {
        botSent.current = false;
        void fetch(`/api/interview/${dealId}/call/bot/stop`, { method: "POST", credentials: "include", keepalive: true }).catch(() => {});
      }
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      stopAll();
      leave();
    };
  }, [o.dealId, stopAll]);

  return { state, detail, basic, interim, startedAt, start, pause, callObject, remoteCount, leaveCall, sendNotetaker };
}

function remoteCountNow(call: DailyCall): number {
  try {
    return Object.keys(call.participants() ?? {}).filter((k) => k !== "local").length;
  } catch {
    return 0;
  }
}
