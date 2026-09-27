/**
 * Recall webhook token → deal, without reading the deals table per request.
 *
 * The webhook is public; after a restart the in-memory token map is empty,
 * and the old fallback loaded EVERY deal row (extractedInfo, CIM, jsonb…)
 * for each unknown token — so a flood of `?token=x` requests tied up the DB
 * pool and the event loop for every broker. Now:
 *   - a token that can't be one of ours (newWebhookToken: 24 random bytes,
 *     base64url = 32 chars) is refused without any query;
 *   - a well-formed token is resolved with one small
 *     query that reads only the id of one row;
 *   - a miss is remembered briefly, so repeating it costs nothing.
 */
import { sql } from "drizzle-orm";

export const WEBHOOK_TOKEN_SHAPE = /^[A-Za-z0-9_-]{32}$/;

const MISS_TTL_MS = 60_000;
const MISS_CACHE_MAX = 5_000;

export type DealIdByToken = (token: string) => Promise<string | null>;

export function createWebhookTokenResolver(
  known: Map<string, string>,
  lookup: DealIdByToken,
  now: () => number = Date.now,
) {
  const misses = new Map<string, number>();
  return async function resolve(token: string): Promise<string | null> {
    if (!token || !WEBHOOK_TOKEN_SHAPE.test(token)) return null;
    const hit = known.get(token);
    if (hit) return hit;
    const missAt = misses.get(token);
    if (missAt !== undefined && now() - missAt < MISS_TTL_MS) return null;
    const dealId = await lookup(token);
    if (dealId) {
      misses.delete(token);
      known.set(token, dealId);
      return dealId;
    }
    if (misses.size >= MISS_CACHE_MAX) misses.clear();
    misses.set(token, now());
    return null;
  };
}

/** The live bot's deal for this token — one row, id only. */
export async function dealIdForWebhookToken(token: string): Promise<string | null> {
  const [{ db }, { deals }] = await Promise.all([import("../db"), import("@shared/schema")]);
  const rows = await db
    .select({ id: deals.id })
    .from(deals)
    .where(sql`${deals.interviewBot}->>'webhookToken' = ${token} and ${deals.interviewBot}->>'endedAt' is null`)
    .limit(1);
  return rows[0]?.id ?? null;
}
