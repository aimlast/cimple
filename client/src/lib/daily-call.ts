/**
 * Daily call helpers — the audio/video transport and transcription for the
 * in-Cimple call. We use Daily's headless "call object" (no Prebuilt iframe):
 * the call screen itself is ours (components/call/CallStage.tsx), so it looks
 * like Meet/Zoom instead of Daily's own UI boxed inside our page.
 *
 * Transcript lines arrive with the speaking participant's session id, so the
 * broker's browser can label them "Broker" (local) / "Seller" (remote) with
 * certainty — no voice guessing.
 */
import DailyIframe, { type DailyCall, type DailyEventObjectTranscriptionMessage } from "@daily-co/daily-js";

export interface CallHandle {
  call: DailyCall;
  leave: () => Promise<void>;
}

export interface TranscriptLine {
  /** true when the local participant (the one whose browser this is) spoke */
  local: boolean;
  participantId: string;
  text: string;
  isFinal: boolean;
}

interface JoinOptions {
  roomUrl: string;
  token: string;
  /** Owner only: start transcription and receive lines. */
  onTranscript?: (line: TranscriptLine) => void;
  onLeft?: () => void;
  onError?: (message: string) => void;
  /** Number of other people in the call (excludes the local participant). */
  onRemoteCount?: (count: number) => void;
}

/** One call object per page — Daily allows a single instance at a time. */
export function createDailyCall(): DailyCall {
  const existing = DailyIframe.getCallInstance();
  if (existing) existing.destroy();
  return DailyIframe.createCallObject({ subscribeToTracksAutomatically: true });
}

export async function joinDailyCall(call: DailyCall, opts: JoinOptions): Promise<CallHandle> {
  let transcriptionStarted = false;
  call.on("transcription-message", (ev: DailyEventObjectTranscriptionMessage) => {
    if (!opts.onTranscript) return;
    const localId = call.participants()?.local?.session_id;
    opts.onTranscript({
      local: ev.participantId === localId,
      participantId: ev.participantId,
      text: ev.text,
      isFinal: ev.rawResponse?.is_final !== false,
    });
  });
  call.on("left-meeting", () => opts.onLeft?.());
  const reportRemote = () => {
    const all = call.participants() || {};
    opts.onRemoteCount?.(Object.keys(all).filter((k) => k !== "local").length);
  };
  call.on("participant-joined", reportRemote);
  call.on("participant-left", reportRemote);
  call.on("joined-meeting", reportRemote);
  call.on("error", (ev) => opts.onError?.(ev?.errorMsg || "Call error"));
  call.on("camera-error", (ev: any) => opts.onError?.(ev?.errorMsg?.errorMsg || ev?.error?.msg || "Camera or microphone blocked — allow access in the browser's address bar."));

  await call.join({ url: opts.roomUrl, token: opts.token, startVideoOff: false, startAudioOff: false });

  if (opts.onTranscript) {
    try {
      // Owner-only. Diarisation is per participant, so speaker labels are exact.
      // nova-3 is Deepgram's most accurate model; fall back to nova-2 if Daily
      // rejects it up front or reports a transcription error afterwards.
      const base = { language: "en", punctuate: true, profanity_filter: false, endpointing: 500 };
      let fellBack = false;
      const fallBack = async () => {
        if (fellBack) return;
        fellBack = true;
        try { await call.stopTranscription(); } catch { /* not running */ }
        await call.startTranscription({ ...base, model: "nova-2" } as any);
      };
      call.on("transcription-error", () => { void fallBack().catch((e) => opts.onError?.(`Transcription error: ${(e as Error).message}`)); });
      try {
        await call.startTranscription({ ...base, model: "nova-3" } as any);
      } catch {
        await fallBack();
      }
      transcriptionStarted = true;
    } catch (err) {
      opts.onError?.(`Transcription couldn't start: ${(err as Error).message}`);
    }
  }

  return {
    call,
    leave: async () => {
      try { if (transcriptionStarted) await call.stopTranscription(); } catch { /* fine */ }
      try { await call.leave(); } catch { /* fine */ }
      try { call.destroy(); } catch { /* already destroyed */ }
    },
  };
}
