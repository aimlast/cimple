/**
 * Deepgram — live speech-to-text with speaker separation for the in-person
 * ("one laptop on the table") broker-led interview.
 *
 * The browser streams microphone audio directly to Deepgram's live endpoint
 * using a SHORT-LIVED key minted here (Deepgram's recommended browser
 * pattern). The real DEEPGRAM_API_KEY never leaves the server. Without the
 * key configured, everything degrades to the browser's built-in speech
 * recognition (single speaker) and the UI says so.
 */
const API = "https://api.deepgram.com/v1";
const TEMP_KEY_TTL_SECONDS = 15 * 60;

export function isDeepgramConfigured(): boolean {
  return !!process.env.DEEPGRAM_API_KEY;
}

let cachedProjectId: string | null = null;

async function dg<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Deepgram ${init.method || "GET"} ${path} → ${res.status}: ${body.slice(0, 200)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

async function projectId(): Promise<string> {
  if (cachedProjectId) return cachedProjectId;
  const data = await dg<{ projects: { project_id: string; name: string }[] }>("/projects");
  const first = data.projects?.[0];
  if (!first) throw new Error("Deepgram account has no project");
  cachedProjectId = first.project_id;
  return first.project_id;
}

export interface TemporaryKey {
  key: string;
  /** WebSocket subprotocol scheme: "bearer" for a JWT from /auth/grant, "token" for a project key. */
  scheme: "bearer" | "token";
  expiresAt: string;
  /** Query string for the live endpoint — model + diarization + formatting. */
  liveParams: string;
}

function liveParams(): string {
  return new URLSearchParams({
    model: "nova-3",
    language: "en",
    smart_format: "true",
    punctuate: "true",
    diarize: "true",
    interim_results: "true",
    utterance_end_ms: "1500",
    vad_events: "true",
    endpointing: "400",
  }).toString();
}

/**
 * Short-lived credential for the browser. Preferred: Deepgram's token grant
 * (a JWT, works with any Member-or-higher key, only needs to be valid while
 * the socket opens). Fallback: a temporary project key (needs a key that may
 * create keys).
 */
export async function createTemporaryKey(label: string): Promise<TemporaryKey> {
  if (!isDeepgramConfigured()) throw new Error("Deepgram is not configured");
  try {
    const grant = await dg<{ access_token: string; expires_in: number }>("/auth/grant", {
      method: "POST",
      body: JSON.stringify({ ttl_seconds: 60 }),
    });
    return {
      key: grant.access_token,
      scheme: "bearer",
      expiresAt: new Date(Date.now() + (grant.expires_in || 30) * 1000).toISOString(),
      liveParams: liveParams(),
    };
  } catch (err) {
    console.warn("[deepgram] token grant failed, trying a temporary project key:", (err as Error).message);
  }
  const pid = await projectId();
  const data = await dg<{ key: string; api_key_id: string; expiration_date?: string }>(`/projects/${pid}/keys`, {
    method: "POST",
    body: JSON.stringify({
      comment: `cimple live interview — ${label}`.slice(0, 120),
      scopes: ["usage:write"],
      time_to_live_in_seconds: TEMP_KEY_TTL_SECONDS,
    }),
  });
  return {
    key: data.key,
    scheme: "token",
    expiresAt: data.expiration_date ?? new Date(Date.now() + TEMP_KEY_TTL_SECONDS * 1000).toISOString(),
    liveParams: liveParams(),
  };
}
