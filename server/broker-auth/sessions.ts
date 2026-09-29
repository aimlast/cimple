/**
 * Broker session hygiene.
 *
 *  - A new session id on every sign-in and password reset (no session
 *    fixation: an id planted before sign-in never becomes a signed-in one).
 *  - Changing or resetting the password signs the broker out everywhere
 *    else: a cookie taken from a shared or lost laptop used to keep full
 *    access to every deal for its whole 30 days, whatever the broker did.
 *
 * Sessions live in Postgres (connect-pg-simple, table user_sessions, `sess`
 * json). Signing out elsewhere removes only the broker identity from those
 * rows — a buyer signed in from the same browser stays signed in, the same
 * rule as /api/broker-auth/logout.
 */
import type { Request } from "express";
import { sql, type SQL } from "drizzle-orm";

/** The update that signs `brokerId` out of every session except `keepSid`. */
export function otherBrokerSessionsSignOut(brokerId: string, keepSid: string | null | undefined): SQL {
  return sql`UPDATE user_sessions SET sess = ((sess::jsonb) - 'brokerId')::json WHERE (sess::jsonb) ->> 'brokerId' = ${brokerId} AND sid <> ${keepSid ?? ""}`;
}

type Executor = { execute(query: SQL): Promise<unknown> };

/** Signs the broker out of every other session. Never throws (logged). */
export async function signOutOtherBrokerSessions(db: Executor, brokerId: string, keepSid: string | null | undefined): Promise<boolean> {
  try {
    await db.execute(otherBrokerSessionsSignOut(brokerId, keepSid));
    return true;
  } catch (err) {
    console.error("[broker-auth] signing out other sessions failed:", err);
    return false;
  }
}

/**
 * Replaces the session with a fresh one (new id), keeping a buyer identity
 * signed in from the same browser. Resolves once the new session exists.
 */
export function regenerateSession(req: Request): Promise<void> {
  const buyerId = req.session?.buyerId;
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.regenerate !== "function") return resolve();
    req.session.regenerate((err) => {
      if (err) return reject(err);
      if (buyerId) req.session.buyerId = buyerId;
      resolve();
    });
  });
}

/** Persists the session now (so the next request sees it). */
export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.save !== "function") return resolve();
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}
