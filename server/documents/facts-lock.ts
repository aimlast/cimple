/**
 * One in-process queue per deal for read-modify-write of deals.extractedInfo.
 *
 * Every writer that re-reads the deal's facts, changes them and saves them
 * (document ingestion, source deletion, broker edits, the interview turn's
 * save, questionnaire seeding, CRM re-import) runs through this, so two
 * writers finishing at the same moment can't overwrite each other's facts.
 *
 * Never call withDealFactsLock for the same deal from inside a locked
 * callback — it would wait on itself.
 */
const factLocks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after any other in-process read-merge-write of the same deal's
 * facts has finished (a simple per-deal queue).
 */
export async function withDealFactsLock<T>(dealId: string, fn: () => Promise<T>): Promise<T> {
  const prev = factLocks.get(dealId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  factLocks.set(dealId, tail);
  try {
    return await run;
  } finally {
    if (factLocks.get(dealId) === tail) factLocks.delete(dealId);
  }
}
