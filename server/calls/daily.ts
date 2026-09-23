/**
 * Daily — the video call inside Cimple for broker-led interviews.
 *
 * The broker starts a private room for the deal; the seller joins from their
 * own link with a non-owner token. Daily's built-in transcription (owner
 * starts it from the broker's browser) delivers per-participant transcript
 * events, which is how the interview knows who said what without any voice
 * guessing. Rooms expire on their own; nothing here stores audio.
 */
const API = "https://api.daily.co/v1";
const ROOM_TTL_SECONDS = 4 * 60 * 60;
const TOKEN_TTL_SECONDS = 4 * 60 * 60;

export function isDailyConfigured(): boolean {
  return !!process.env.DAILY_API_KEY;
}

async function daily<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.DAILY_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Daily ${init.method || "GET"} ${path} → ${res.status}: ${body.slice(0, 200)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export interface DailyRoom {
  name: string;
  url: string;
  expiresAt: string;
}

/** A private room for one interview; the name embeds the deal so it's recognisable in Daily's dashboard. */
export async function createRoom(dealId: string): Promise<DailyRoom> {
  if (!isDailyConfigured()) throw new Error("Daily is not configured");
  const exp = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
  const name = `cimple-${dealId.slice(0, 8)}-${Date.now().toString(36)}`;
  const room = await daily<{ name: string; url: string }>("/rooms", {
    method: "POST",
    body: JSON.stringify({
      name,
      privacy: "private",
      properties: {
        exp,
        max_participants: 4,
        enable_chat: false,
        enable_screenshare: false,
        enable_knocking: false,
        enable_prejoin_ui: true,
        start_video_off: false,
        start_audio_off: false,
        eject_at_room_exp: true,
        lang: "en",
      },
    }),
  });
  return { name: room.name, url: room.url, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Owner tokens (broker) may start transcription; the seller gets a plain participant token. */
export async function createMeetingToken(roomName: string, userName: string, isOwner: boolean): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const data = await daily<{ token: string }>("/meeting-tokens", {
    method: "POST",
    body: JSON.stringify({
      properties: { room_name: roomName, user_name: userName, is_owner: isOwner, exp, enable_recording: false },
    }),
  });
  return data.token;
}

export async function deleteRoom(roomName: string): Promise<void> {
  try {
    await daily(`/rooms/${encodeURIComponent(roomName)}`, { method: "DELETE" });
  } catch (err) {
    console.warn(`[daily] could not delete room ${roomName}:`, (err as Error).message);
  }
}
