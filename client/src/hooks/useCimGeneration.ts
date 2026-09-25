/**
 * useCimGeneration — follows a deal's background CIM generation job.
 *
 * Polls `/api/deals/:id/cim-generation` every 2s while a job is running and
 * invalidates the deal's CIM caches the moment it finishes, so whichever page
 * the broker is on shows the new sections without a manual refresh. The
 * completion toast itself lives in CimGenerationWatcher (one toast app-wide,
 * not one per mounted page).
 */
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { CimGenerationStatus } from "@shared/schema";

export const cimGenerationKey = (dealId: string) => ["/api/deals", dealId, "cim-generation"] as const;

/** Refresh everything the finished job rewrote. */
export function invalidateCimCaches(dealId: string) {
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-sections"] });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-overrides"] });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "layout"] });
  // The run may have started with the discrepancy check (and stopped at it).
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "discrepancies"] });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "discrepancy-check-status"] });
}

/** Seconds-per-section prior used before the first section has finished. */
const DEFAULT_SECONDS_PER_SECTION = 15;

export interface CimGenerationView {
  job: CimGenerationStatus | null;
  isRunning: boolean;
  /** 0–100; planning counts as a small head start so the bar isn't empty. */
  percent: number;
  /** Rough seconds remaining, or null while planning. */
  etaSeconds: number | null;
  /** One-line status for the UI. */
  label: string;
}

export function describeJob(job: CimGenerationStatus | null): Omit<CimGenerationView, "job"> {
  if (!job) return { isRunning: false, percent: 0, etaSeconds: null, label: "" };
  const isRunning = job.status === "running";
  if (job.status === "done") {
    return { isRunning: false, percent: 100, etaSeconds: 0, label: `Finished — ${job.sectionCount ?? job.done} sections` };
  }
  if (job.status === "failed") {
    return { isRunning: false, percent: 0, etaSeconds: null, label: job.error || "Generation failed" };
  }
  if (job.phase === "checking") {
    return { isRunning, percent: 2, etaSeconds: null, label: "Checking the documents against what the seller said…" };
  }
  if (job.phase === "planning" || job.total === 0) {
    return { isRunning, percent: 4, etaSeconds: null, label: "Planning the document…" };
  }
  if (job.phase === "saving") {
    return { isRunning, percent: 97, etaSeconds: 5, label: "Saving sections…" };
  }
  const elapsed = (Date.now() - new Date(job.startedAt).getTime()) / 1000;
  const perSection = job.done > 0 ? elapsed / job.done : DEFAULT_SECONDS_PER_SECTION;
  const remaining = Math.max(0, job.total - job.done);
  const etaSeconds = Math.round(remaining * perSection);
  // 4% for planning, then 4→96% across the sections, saving fills the rest.
  const percent = 4 + Math.round((job.done / job.total) * 92);
  const last = job.completedTitles[job.completedTitles.length - 1];
  const label = last
    ? `Designed “${last}” — ${job.done} of ${job.total} sections`
    : `Designing section 1 of ${job.total}…`;
  return { isRunning, percent, etaSeconds, label };
}

export function formatEta(seconds: number | null): string {
  if (seconds === null) return "";
  if (seconds < 45) return "less than a minute left";
  const mins = Math.max(1, Math.round(seconds / 60));
  return `about ${mins} min left`;
}

export function useCimGeneration(dealId: string | undefined): CimGenerationView {
  const { data } = useQuery<CimGenerationStatus | null>({
    queryKey: cimGenerationKey(dealId ?? ""),
    enabled: !!dealId,
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/cim-generation`, { credentials: "include" });
      if (!r.ok) return null;
      const body = await r.json();
      return body?.job ?? null;
    },
    refetchInterval: (query) => (query.state.data?.status === "running" ? 2000 : false),
  });
  const job = data ?? null;

  // Refresh the deal's CIM data exactly once when a run we watched finishes.
  const lastSeen = useRef<string | null>(null);
  useEffect(() => {
    if (!dealId || !job) return;
    const key = `${job.startedAt}:${job.status}`;
    if (lastSeen.current === key) return;
    const wasRunning = lastSeen.current?.startsWith(`${job.startedAt}:running`);
    lastSeen.current = key;
    if (wasRunning && job.status !== "running") invalidateCimCaches(dealId);
  }, [dealId, job]);

  return { job, ...describeJob(job) };
}
