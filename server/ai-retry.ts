/**
 * ai-retry — small helpers for AI calls made many at a time: a concurrency
 * limit, a retry on transient failures, and a check for what "transient"
 * means. (Bursting one call per item — every statement pack, every selected
 * buyer — tripped the account's rate limits, and the failures fell back
 * quietly.)
 */

/** Rate limits, overloads, server errors, timeouts and dropped connections — worth another try. */
export function isTransientAiError(err: unknown): boolean {
  const e = err as { status?: number; name?: string; code?: string; message?: string } | null;
  if (!e) return false;
  if (typeof e.status === "number") return e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
  return /APIConnection|Timeout|AbortError/i.test(e.name ?? "") || /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|overloaded/i.test(`${e.code ?? ""} ${e.message ?? ""}`);
}

/** Runs `call`, retrying transient failures after each delay in turn; other errors (and the last) are thrown. */
export async function withAiRetry<T>(call: () => Promise<T>, delaysMs: readonly number[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!isTransientAiError(err) || attempt >= delaysMs.length) throw err;
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}

/** `fn` over every item, at most `limit` at a time; results in the items' order. */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
