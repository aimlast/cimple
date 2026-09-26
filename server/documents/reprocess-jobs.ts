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
import { reprocessDealDocuments, type ReprocessProgress, type ReprocessResult } from "./reprocess";

export interface ReprocessJob {
  dealId: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  progress: ReprocessProgress;
  result?: ReprocessResult;
  error?: string;
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
): { job: ReprocessJob; started: boolean } {
  const current = jobs.get(dealId);
  if (current?.status === "running") return { job: current, started: false };
  const job: ReprocessJob = {
    dealId,
    status: "running",
    startedAt: new Date().toISOString(),
    progress: { phase: "reading", done: 0, total: 0 },
  };
  jobs.set(dealId, job);
  void (async () => {
    try {
      job.result = await run(dealId, (p) => { job.progress = p; });
      if (after) await after(dealId).catch((err) => console.warn(`[reprocess] follow-up failed for ${dealId}:`, err));
      job.status = "done";
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
