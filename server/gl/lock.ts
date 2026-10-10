/**
 * lock.ts — one in-process queue per deal for the general-ledger steps that
 * read, change and save several rows together (D27): trace sync, proposal
 * runs, a ledger's finishing steps (dedupe, summaries), the fiscal-year-end
 * change and publishing. Same pattern as withDealFactsLock, its own map (a
 * ledger finishing never waits on a facts merge, or the other way round).
 *
 * Single tick writes (a seller ticking an entry) are single upserts and do
 * not take the lock. Never call withGlLock for the same deal from inside a
 * locked callback — it would wait on itself.
 */
const glLocks = new Map<string, Promise<unknown>>();

export async function withGlLock<T>(dealId: string, fn: () => Promise<T>): Promise<T> {
  const prev = glLocks.get(dealId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  glLocks.set(dealId, tail);
  try {
    return await run;
  } finally {
    if (glLocks.get(dealId) === tail) glLocks.delete(dealId);
  }
}

/** True while some GL step for the deal is queued or running (tests, diagnostics). */
export function glLockBusy(dealId: string): boolean {
  return glLocks.has(dealId);
}
