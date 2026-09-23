/**
 * Live, speaker-separated transcription of the room (Deepgram) for the
 * in-person broker-led interview. The browser opens the mic, streams it to
 * Deepgram with a short-lived key issued by our server, and receives
 * transcript segments labelled by speaker.
 *
 * Throws `NotConfiguredError` when the server has no Deepgram key so the
 * caller can fall back to the browser's built-in recognition.
 */
export class NotConfiguredError extends Error {
  constructor() { super("Live transcription is not configured"); this.name = "NotConfiguredError"; }
}

export interface LiveSegment {
  /** Deepgram speaker index (0, 1, …) — arbitrary but stable within a session. */
  speaker: number;
  text: string;
  /** Deepgram finalised this chunk of audio (words won't change). */
  isFinal: boolean;
  /** Deepgram detected the end of a spoken utterance. */
  speechFinal: boolean;
}

export interface LiveTranscriptionHandle {
  stop: () => void;
}

interface StartOptions {
  dealId: string;
  sellerToken?: string;
  onSegment: (seg: LiveSegment) => void;
  /** Deepgram's silence-based end-of-utterance signal. */
  onUtteranceEnd: () => void;
  onError: (message: string) => void;
  onOpen?: () => void;
}

function pickMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
}

export async function startLiveTranscription(opts: StartOptions): Promise<LiveTranscriptionHandle> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.sellerToken) headers["X-Seller-Token"] = opts.sellerToken;
  const tokenRes = await fetch(`/api/interview/${opts.dealId}/transcription-token`, { method: "POST", headers, credentials: "include" });
  if (tokenRes.status === 503) throw new NotConfiguredError();
  if (!tokenRes.ok) {
    const body = await tokenRes.json().catch(() => ({}));
    throw new Error(body.error || "Couldn't start live transcription");
  }
  const { key, liveParams, scheme } = (await tokenRes.json()) as { key: string; liveParams: string; scheme?: "bearer" | "token" };

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${liveParams}`, [scheme ?? "token", key]);
  let stopped = false;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (keepAlive) clearInterval(keepAlive);
    try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* already stopped */ }
    stream.getTracks().forEach((t) => t.stop());
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
      ws.close();
    } catch { /* closing */ }
  };

  ws.onopen = () => {
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };
    recorder.start(250);
    // Deepgram closes idle sockets; a periodic KeepAlive covers long pauses.
    keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, 8000);
    opts.onOpen?.();
  };
  ws.onmessage = (event) => {
    let msg: any;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "UtteranceEnd") { opts.onUtteranceEnd(); return; }
    if (msg.type !== "Results") return;
    const alt = msg.channel?.alternatives?.[0];
    const text: string = (alt?.transcript || "").trim();
    if (!text) return;
    const words: { speaker?: number }[] = alt?.words || [];
    // Majority speaker of the segment (diarization labels every word).
    const counts = new Map<number, number>();
    for (const w of words) counts.set(w.speaker ?? 0, (counts.get(w.speaker ?? 0) ?? 0) + 1);
    let speaker = 0, best = -1;
    counts.forEach((n, s) => { if (n > best) { best = n; speaker = s; } });
    opts.onSegment({ speaker, text, isFinal: !!msg.is_final, speechFinal: !!msg.speech_final });
  };
  ws.onerror = () => { if (!stopped) opts.onError("Live transcription connection failed"); };
  ws.onclose = (e) => {
    if (!stopped && e.code !== 1000) opts.onError(`Live transcription disconnected (${e.code})`);
  };

  return { stop };
}
