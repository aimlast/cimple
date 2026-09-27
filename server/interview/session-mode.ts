/**
 * session-mode — who an interview session belongs to, and when a turn may
 * be written into it.
 *
 * Three kinds of session, fixed when the session is created:
 * - "seller": the seller alone, on their invite link;
 * - "broker_with_seller": "Interview together" — the broker runs it with the
 *   seller on a call or in the room;
 * - "broker": the broker alone ("Start AI Interview" / "Add more detail" on
 *   the deal) — the broker answers from their own notes, so what it records
 *   is the broker's word, never the seller's.
 *
 * The mode comes from the CALLER, never from the session: a request that
 * carries the seller's invite token is always the seller. A session of one
 * kind is never continued as another — a seller who comes back after a
 * broker-led sitting gets a fresh seller session (the facts carry over; the
 * room transcript does not), and a broker-alone session is never resumed,
 * shown or read to the seller.
 */
import type { ConversationMessage } from "@shared/schema";

export type ConductedBy = "seller" | "broker_with_seller" | "broker";

const MODES: readonly ConductedBy[] = ["seller", "broker_with_seller", "broker"];

type SessionLike = { extractedInfo?: unknown };

/** The mode a session was created for (legacy sessions without one were the seller's). */
export function sessionModeOf(session: SessionLike | null | undefined): ConductedBy {
  const raw = (session?.extractedInfo as Record<string, unknown> | null | undefined)?._conductedBy;
  return typeof raw === "string" && (MODES as readonly string[]).includes(raw) ? (raw as ConductedBy) : "seller";
}

/** The broker alone typed this session — none of it is the seller's word. */
export function isBrokerAloneSession(session: SessionLike | null | undefined): boolean {
  return sessionModeOf(session) === "broker";
}

/**
 * The mode of a request: the seller's invite token → "seller", whatever the
 * body says; otherwise (the owning broker) "Interview together" when asked,
 * else the broker alone.
 */
export function callerMode(viaSellerToken: boolean, requested: unknown): ConductedBy {
  if (viaSellerToken) return "seller";
  return requested === "broker_with_seller" ? "broker_with_seller" : "broker";
}

/**
 * The sessions whose transcripts may feed another session's context (the
 * prompt's earlier sessions, the on-file evidence, "what the seller said"):
 * a broker-alone session never does — its facts are on file with the
 * broker's provenance, and its words can carry broker-private material.
 * (The session in play is kept: its own transcript is the conversation.)
 */
export function contextSessions<T extends SessionLike & { id?: string }>(sessions: T[], currentSessionId?: string | null): T[] {
  return sessions.filter((s) => !isBrokerAloneSession(s) || (!!currentSessionId && s.id === currentSessionId));
}

/** Can the seller (invite token) read this session's transcript? Only their own sessions. */
export function sellerMayRead(session: SessionLike | null | undefined): boolean {
  return sessionModeOf(session) === "seller";
}

// =====================
// Turn admission
// =====================

export type TurnConflictCode =
  /** The session is not this deal's. */
  | "wrong_session"
  /** The session was ended (by the seller, the AI, or a different kind of session taking over). */
  | "session_closed"
  /** The caller is not who this session belongs to (a seller posting into a broker-led session). */
  | "mode_mismatch"
  /** The caller is answering a question that is no longer the session's latest (another tab, a resend). */
  | "out_of_sync";

/** A turn that must not be written — the client re-syncs (routes answer 409). */
export class TurnConflictError extends Error {
  readonly code: TurnConflictCode;
  constructor(code: TurnConflictCode, message?: string) {
    super(message ?? TURN_CONFLICT_TEXT[code]);
    this.name = "TurnConflictError";
    this.code = code;
  }
}

const TURN_CONFLICT_TEXT: Record<TurnConflictCode, string> = {
  wrong_session: "This conversation doesn't belong to this deal.",
  session_closed: "This conversation has ended — reload to continue.",
  mode_mismatch: "This conversation was continued in a different way — reload to continue.",
  out_of_sync: "The conversation had moved on — here is where it stands.",
};

/**
 * Pure: may a turn be written into this session? `answeringAt` is the
 * timestamp of the AI question the caller is answering (the last one on
 * their screen); when given it must be the session's last message.
 */
export function turnAdmission(args: {
  session: { dealId: string; status: string; messages: unknown; extractedInfo?: unknown };
  dealId: string;
  mode: ConductedBy;
  answeringAt?: string | null;
}): TurnConflictCode | null {
  const { session } = args;
  if (session.dealId !== args.dealId) return "wrong_session";
  if (session.status !== "active" && session.status !== "paused") return "session_closed";
  if (sessionModeOf(session) !== args.mode) return "mode_mismatch";
  if (args.answeringAt) {
    const msgs = (Array.isArray(session.messages) ? session.messages : []) as ConversationMessage[];
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "ai" || last.timestamp !== args.answeringAt) return "out_of_sync";
  }
  return null;
}

/** Validates a client-supplied answeringAt (an ISO timestamp string), else undefined. */
export function parseAnsweringAt(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length <= 40 && !Number.isNaN(Date.parse(raw)) ? raw : undefined;
}

// =====================
// One turn per session at a time
// =====================

const turnLocks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` once every earlier turn on the same session has finished (this
 * process). Two turns on one session used to run side by side and the last
 * save overwrote the other's exchange; now the second waits, and its
 * admission check (answeringAt) then sees the first one's reply.
 */
export function withSessionTurnLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prior = turnLocks.get(sessionId) ?? Promise.resolve();
  const run = prior.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  turnLocks.set(sessionId, tail);
  void tail.then(() => {
    if (turnLocks.get(sessionId) === tail) turnLocks.delete(sessionId);
  });
  return run;
}

/** Is a turn running (or waiting) on this session in this process? */
export function turnInFlight(sessionId: string): boolean {
  return turnLocks.has(sessionId);
}
