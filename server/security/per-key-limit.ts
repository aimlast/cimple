/**
 * A small in-memory sliding-window counter keyed by anything (an account id,
 * an email address, a broker id) — for limits the per-IP express-rate-limit
 * can't express: "at most 3 confirmation emails to one address an hour,
 * whichever IPs ask". Per process; a restart forgets (fine for a ceiling).
 */
export interface PerKeyLimiter {
  /** Records one use of `key` when allowed; false when the key is at its limit. */
  take(key: string, now?: number): boolean;
  /** For tests. */
  reset(): void;
}

export function createPerKeyLimiter(opts: { limit: number; windowMs: number; maxKeys?: number }): PerKeyLimiter {
  const hits = new Map<string, number[]>();
  const maxKeys = opts.maxKeys ?? 50_000;
  return {
    take(key: string, now: number = Date.now()): boolean {
      const since = now - opts.windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > since);
      if (recent.length >= opts.limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.delete(key);
      hits.set(key, recent);
      // Bounded memory: drop the least recently used keys.
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
      }
      return true;
    },
    reset() {
      hits.clear();
    },
  };
}
