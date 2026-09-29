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

/**
 * An AI service error in the broker's words: what went wrong and what to do.
 * Only a transient failure (rate limit, overload, server error, dropped
 * connection) is worth "try again in a few minutes"; an account out of
 * credits (400) or a rejected key (401/403) fails the same way every time.
 */
export function describeAiFailure(err: unknown): { transient: boolean; reason: string; advice: string } {
  const e = err as { status?: number; message?: string } | null;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const text = String(e?.message ?? "");
  if (isTransientAiError(err)) {
    const reason = status === 429 ? "rate limit"
      : status === 529 || /overloaded/i.test(text) ? "overloaded"
      : status !== undefined ? `error ${status}`
      : "connection dropped";
    return { transient: true, reason, advice: "try again in a few minutes" };
  }
  if (status === 400 && /credit|billing|balance/i.test(text)) {
    return { transient: false, reason: "the AI account is out of credits", advice: "trying again won't help until the AI credits are topped up" };
  }
  if (status === 401 || status === 403) {
    return { transient: false, reason: "the AI service refused Cimple's key", advice: "trying again won't help; please contact support" };
  }
  if (status !== undefined) {
    return { transient: false, reason: `the AI service refused the request (error ${status})`, advice: "trying again won't help; please contact support" };
  }
  return { transient: true, reason: "no usable answer", advice: "try again in a few minutes" };
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
