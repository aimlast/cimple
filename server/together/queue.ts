/**
 * One action at a time per sitting (lines, roles, pause, end, the transcript
 * row) — a tiny in-process queue, shared by sittings.ts and live filing.
 */
const queues = new Map<string, Promise<unknown>>();

export function withSittingQueue<T>(sittingId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(sittingId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  queues.set(sittingId, tail);
  void tail.then(() => { if (queues.get(sittingId) === tail) queues.delete(sittingId); });
  return next;
}

/**
 * The sitting's filing lock: a part's filing (the facts merge, the transcript
 * row and the Undo list) and an Undo run one at a time, so an Undo that lands
 * while another part is being filed is never overwritten by that part's row
 * write. A separate key from the line queue (a slow merge never holds up the
 * transcript); nothing holding the line queue ever waits on this lock.
 */
export function withFilingLock<T>(sittingId: string, fn: () => Promise<T>): Promise<T> {
  return withSittingQueue(`${sittingId}#filing`, fn);
}

export function _resetSittingQueuesForTests(): void {
  queues.clear();
}
