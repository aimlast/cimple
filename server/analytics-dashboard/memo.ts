/**
 * A small stale-while-revalidate memo for the analytics dashboards.
 *
 *   - younger than freshMs (and the same version): returned as is;
 *   - older (up to staleMs), or its version moved on (a reading flush in
 *     this process bumps the deal's readingVersion): returned AT ONCE and
 *     refreshed in the background — one refresh at a time per key;
 *   - missing or older than staleMs: loaded and awaited;
 *   - concurrent misses share one load (in-flight coalescing).
 *
 * So a dashboard poll never waits on a cold rebuild once the memo is warm,
 * and at most one background rebuild runs per key. A failed load is never
 * remembered (the next call tries again; a failed background refresh keeps
 * the last good value). LRU, 300 entries.
 */

interface Entry<T> {
  /** When the current value was obtained (ms). */
  at: number;
  version: unknown;
  settled: boolean;
  value: T | undefined;
  promise: Promise<T>;
  refreshing: Promise<void> | null;
}

const MAX_ENTRIES = 300;
const entries = new Map<string, Entry<unknown>>();
let clock: () => number = () => Date.now();

function touch(key: string, e: Entry<unknown>): void {
  entries.delete(key);
  entries.set(key, e);
}

function evict(): void {
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function swr<T>(
  key: string,
  opts: { freshMs: number; staleMs: number },
  load: () => Promise<T>,
  version?: unknown,
): Promise<T> {
  const now = clock();
  const hit = entries.get(key) as Entry<T> | undefined;
  if (hit) {
    if (!hit.settled) return hit.promise;
    const age = now - hit.at;
    if (age < opts.staleMs) {
      touch(key, hit as Entry<unknown>);
      const fresh = age < opts.freshMs && hit.version === version;
      if (!fresh && !hit.refreshing) {
        hit.refreshing = load()
          .then((v) => {
            hit.value = v;
            hit.at = clock();
            hit.version = version;
            hit.promise = Promise.resolve(v);
          })
          .catch((err) => {
            console.warn(`[analytics] background refresh of ${key.split(":")[0]} failed:`, (err as Error)?.message ?? err);
          })
          .finally(() => {
            hit.refreshing = null;
          });
      }
      return Promise.resolve(hit.value as T);
    }
    entries.delete(key);
  }
  const entry: Entry<T> = { at: now, version, settled: false, value: undefined, promise: undefined as unknown as Promise<T>, refreshing: null };
  entry.promise = load().then(
    (v) => {
      entry.settled = true;
      entry.value = v;
      entry.at = clock();
      return v;
    },
    (err) => {
      if (entries.get(key) === (entry as Entry<unknown>)) entries.delete(key);
      throw err;
    },
  );
  entries.set(key, entry as Entry<unknown>);
  evict();
  return entry.promise;
}

/** Forget every entry whose key starts with this prefix. */
export function dropMemo(prefix: string): void {
  for (const k of Array.from(entries.keys())) if (k.startsWith(prefix)) entries.delete(k);
}

/** Tests: start empty. */
export function _resetMemo(): void {
  entries.clear();
}

/** Tests: a fake clock (null restores Date.now). */
export function _setMemoClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

/** Tests: how many entries are held. */
export function _memoSize(): number {
  return entries.size;
}
