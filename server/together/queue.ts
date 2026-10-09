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

export function _resetSittingQueuesForTests(): void {
  queues.clear();
}
