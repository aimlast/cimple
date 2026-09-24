/**
 * CallStage — Cimple's own call screen (Meet/Zoom style) on top of Daily's
 * headless call object: the other person's video fills the stage edge to
 * edge, your own video sits in a small corner tile, names sit on the tiles,
 * and mic / camera / leave float at the bottom. Used by both the broker's
 * together-interview page and the seller's call page so they look the same.
 */
import type { DailyCall } from "@daily-co/daily-js";
import {
  DailyProvider,
  DailyAudio,
  DailyVideo,
  useDaily,
  useLocalSessionId,
  useParticipantIds,
  useParticipantProperty,
  useVideoTrack,
  useAudioTrack,
  useMeetingState,
} from "@daily-co/daily-react";
import { Mic, MicOff, Video, VideoOff, PhoneOff, Loader2 } from "lucide-react";

interface StageProps {
  /** Shown on your own tile. */
  selfLabel: string;
  /** Fallback name for the other person when their Daily name is empty. */
  otherLabel: string;
  /** Shown full-stage while nobody else is in the call. */
  waitingText: string;
  onLeave: () => void;
  className?: string;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
}

/** Video for one participant, or an initials avatar when their camera is off. */
function Tile({ sessionId, name, mirror, big }: { sessionId: string; name: string; mirror?: boolean; big?: boolean }) {
  const video = useVideoTrack(sessionId);
  const audio = useAudioTrack(sessionId);
  const camOff = video.isOff || video.state !== "playable";
  return (
    <div className="relative h-full w-full bg-[#0c0b0a]">
      {camOff ? (
        <div className="flex h-full w-full items-center justify-center">
          <div className={`flex items-center justify-center rounded-full bg-[#2a2622] font-semibold text-[#EDE7DA] ${big ? "h-24 w-24 text-3xl" : "h-10 w-10 text-sm"}`}>
            {initials(name)}
          </div>
        </div>
      ) : (
        <DailyVideo sessionId={sessionId} type="video" fit="cover" automirror={!!mirror} className="h-full w-full object-cover" />
      )}
      <div className={`absolute left-2 bottom-2 flex items-center gap-1 rounded-md bg-black/55 px-2 py-0.5 text-white ${big ? "text-sm" : "text-[11px]"}`}>
        {audio.isOff && <MicOff className="h-3 w-3 text-red-300" />}
        <span className="truncate max-w-[180px]">{name}</span>
      </div>
    </div>
  );
}

function Stage({ selfLabel, otherLabel, waitingText, onLeave, className = "" }: StageProps) {
  const call = useDaily();
  const meetingState = useMeetingState();
  const localId = useLocalSessionId();
  const remoteIds = useParticipantIds({ filter: "remote" });
  const remoteId = remoteIds[0];
  const remoteName = (useParticipantProperty(remoteId ?? "", "user_name") as string | undefined) || otherLabel;
  const localVideo = useVideoTrack(localId ?? "");
  const localAudio = useAudioTrack(localId ?? "");
  const joined = meetingState === "joined-meeting";

  const btn = "flex h-11 w-11 items-center justify-center rounded-full transition-colors";
  return (
    <div className={`relative overflow-hidden rounded-xl bg-[#0c0b0a] ${className}`} data-testid="call-stage">
      {/* Main stage: the other person, or yourself while waiting */}
      {joined && remoteId ? (
        <Tile sessionId={remoteId} name={remoteName} big />
      ) : joined && localId ? (
        <>
          <Tile sessionId={localId} name={selfLabel} mirror big />
          <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
            <span className="rounded-full bg-black/60 px-3 py-1 text-xs text-white">{waitingText}</span>
          </div>
        </>
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-sm text-[#9C958A]">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>{meetingState === "error" ? "Couldn't connect to the call" : "Connecting — allow your camera and microphone if the browser asks"}</span>
        </div>
      )}

      {/* Your own tile, picture-in-picture, once someone else is on stage */}
      {joined && remoteId && localId && (
        <div className="absolute right-3 top-3 aspect-video w-40 overflow-hidden rounded-lg shadow-lg ring-1 ring-white/15 sm:w-48">
          <Tile sessionId={localId} name={selfLabel} mirror />
        </div>
      )}

      {/* Floating controls */}
      {joined && (
        <div className="absolute inset-x-0 bottom-4 flex justify-center">
          <div className="flex items-center gap-3 rounded-full bg-black/55 px-3 py-2 backdrop-blur">
            <button
              type="button"
              className={`${btn} ${localAudio.isOff ? "bg-red-500/90 text-white hover:bg-red-500" : "bg-white/15 text-white hover:bg-white/25"}`}
              onClick={() => call?.setLocalAudio(localAudio.isOff)}
              title={localAudio.isOff ? "Unmute" : "Mute"}
              data-testid="call-toggle-mic"
            >
              {localAudio.isOff ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
            </button>
            <button
              type="button"
              className={`${btn} ${localVideo.isOff ? "bg-red-500/90 text-white hover:bg-red-500" : "bg-white/15 text-white hover:bg-white/25"}`}
              onClick={() => call?.setLocalVideo(localVideo.isOff)}
              title={localVideo.isOff ? "Turn camera on" : "Turn camera off"}
              data-testid="call-toggle-camera"
            >
              {localVideo.isOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
            </button>
            <button
              type="button"
              className={`${btn} w-14 bg-red-600 text-white hover:bg-red-700`}
              onClick={onLeave}
              title="Leave the call"
              data-testid="call-leave"
            >
              <PhoneOff className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      {/* Remote audio playback */}
      <DailyAudio />
    </div>
  );
}

export function CallStage({ call, ...props }: StageProps & { call: DailyCall | null }) {
  if (!call) {
    return (
      <div className={`flex items-center justify-center rounded-xl bg-[#0c0b0a] text-sm text-[#9C958A] ${props.className ?? ""}`} data-testid="call-stage">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting the call…
      </div>
    );
  }
  return (
    <DailyProvider callObject={call}>
      <Stage {...props} />
    </DailyProvider>
  );
}
