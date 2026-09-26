/**
 * reprocess-jobs.ts — "re-read every source" runs in the background.
 *
 * A deal with 16–21 sources takes 10–15 minutes to re-read (one Sonnet
 * extraction per source, four at a time); inside the HTTP request it ran
 * into the 10-minute timeout and the broker got an empty response while the
 * work carried on unseen. Now the request starts a job and returns at once
 * (202); the broker's screen (or a script) polls the job for progress and
 * the result. One job per deal; a second start while one runs gets the
 * running job back (409). Jobs live in memory: a server restart mid-run
 * loses the job (the deal's facts are untouched until the job's final save).
 */
import { reprocessDealDocuments, type ReprocessOptions, type ReprocessProgress, type ReprocessResult } from "./reprocess";

export interface ReprocessJob {
  dealId: string;
  /**
   * "partial": the run finished but some sources couldn't be re-read (they
   * keep what they had) — result.failedSources names each, and `message`
   * says so in plain words. Never reported as "done".
   */
  status: "running" | "done" | "partial" | "failed";
  startedAt: string;
  finishedAt?: string;
  progress: ReprocessProgress;
  result?: ReprocessResult;
  error?: string;
  /** Only these sources were re-read (a retry of one source). */
  onlyDocumentIds?: string[];
  /** For the broker, when a source failed. */
  message?: string;
}

/** The job's plain-words summary of sources that couldn't be re-read, or undefined. */
export function failedSourcesMessage(result: ReprocessResult | undefined): string | undefined {
  const failed = result?.failedSources ?? [];
  if (failed.length === 0) return undefined;
  const names = failed.map((f) => `"${f.name}" (${f.reason})`).join(", ");
  return failed.length === 1
    ? `Cimple couldn't re-read ${names}, so it keeps what it had from before. Read it again on its own when the connection is back.`
    : `Cimple couldn't re-read ${failed.length} sources — ${names} — so they keep what they had from before. Read each one again on its own.`;
}

const jobs = new Map<string, ReprocessJob>();
/** A finished job is remembered this long, for the poll that follows it. */
const KEEP_FINISHED_MS = 60 * 60 * 1000;

function prune(now = Date.now()): void {
  for (const [id, job] of Array.from(jobs.entries())) {
    if (job.status !== "running" && job.finishedAt && now - Date.parse(job.finishedAt) > KEEP_FINISHED_MS) jobs.delete(id);
  }
}

/** The deal's current or last job, if any. */
export function reprocessJobFor(dealId: string): ReprocessJob | null {
  prune();
  return jobs.get(dealId) ?? null;
}

/**
 * Starts re-reading the deal's sources in the background. `after` runs once
 * the facts are saved (the route re-seeds the intake answers there). Returns
 * the job and whether this call started it (false: one was already running).
 */
export function startReprocessJob(
  dealId: string,
  after?: (dealId: string) => Promise<void>,
  run: typeof reprocessDealDocuments = reprocessDealDocuments,
  options: ReprocessOptions = {},
): { job: ReprocessJob; started: boolean } {
  const current = jobs.get(dealId);
  if (current?.status === "running") return { job: current, started: false };
  const job: ReprocessJob = {
    dealId,
    status: "running",
    startedAt: new Date().toISOString(),
    progress: { phase: "reading", done: 0, total: 0 },
    ...(options.onlyDocumentIds?.length ? { onlyDocumentIds: options.onlyDocumentIds } : {}),
  };
  jobs.set(dealId, job);
  void (async () => {
    try {
      job.result = await run(dealId, (p) => { job.progress = p; }, options);
      if (after) await after(dealId).catch((err) => console.warn(`[reprocess] follow-up failed for ${dealId}:`, err));
      job.message = failedSourcesMessage(job.result);
      job.status = job.message ? "partial" : "done";
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      console.error(`[reprocess] job failed for ${dealId}:`, err);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();
  return { job, started: true };
}
