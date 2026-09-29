/**
 * dd-run — following one full due-diligence run (POST generate-dd) to its
 * result. Pure, so the CIM tab and the builder announce the same outcome
 * (tests/unit/f2-resilience-dd-run.test.ts).
 *
 * The run is written in the background (202). Its result is the builder
 * state's `dd.lastRun` whose startedAt matches the one the 202 returned —
 * never inferred from having seen `dd.running` (a run that fails in under a
 * second, e.g. credits out, finishes before the first poll), and never
 * announced as "ready" up front.
 */
import type { DdRunSummary } from "./api";

/** A run the server accepted, still to be announced. */
export interface PendingDdRun {
  /** The run's startedAt, from the generate-dd response. */
  startedAt: string;
  /** When the page received the 202 (client clock). */
  acceptedAt: number;
}

export type DdRunCheck =
  | { kind: "wait" }
  | { kind: "finished"; run: DdRunSummary }
  /** The server lost the run (a restart mid-run): nothing was written — the run writes only at its end. */
  | { kind: "lost" };

/**
 * A fetch that completes this long after the 202 was surely sent after it
 * too (a poll already in flight when the run started can still say "not
 * running").
 */
export const DD_LOST_AFTER_MS = 3000;

export function checkDdRun(
  pending: PendingDdRun,
  dd: { running: boolean; lastRun?: DdRunSummary | null } | undefined,
  fetchedAt: number,
): DdRunCheck {
  if (!dd) return { kind: "wait" };
  const last = dd.lastRun ?? null;
  if (!dd.running && last && last.startedAt === pending.startedAt) return { kind: "finished", run: last };
  // The server marks the run as running before it answers 202 and keeps it
  // so until the result is stored: not running with no result = lost.
  if (!dd.running && fetchedAt >= pending.acceptedAt + DD_LOST_AFTER_MS) return { kind: "lost" };
  return { kind: "wait" };
}

export interface DdRunToast {
  title: string;
  description?: string;
  variant?: "destructive";
  duration?: number;
}

/** What to tell the broker when the run ends. */
export function ddRunToast(check: Exclude<DdRunCheck, { kind: "wait" }>): DdRunToast {
  if (check.kind === "lost") {
    return {
      title: "Due-diligence version not updated",
      description: "The server restarted while it was being written. Nothing was changed — start it again.",
      variant: "destructive",
      duration: 12000,
    };
  }
  const run = check.run;
  if (run.error) return { title: "Due-diligence version not updated", description: run.error, variant: "destructive", duration: 12000 };
  if (run.notWritten > 0 || run.warnings.length > 0) {
    return {
      title: "Due-diligence version written with gaps",
      description: `${run.written} section${run.written === 1 ? "" : "s"} written${run.notWritten > 0 ? ` · ${run.notWritten} couldn't be written and kept their previous version — refresh them later` : ""}. The notes are on the CIM tab's Due diligence card.`,
      variant: run.notWritten > 0 ? "destructive" : undefined,
      duration: 12000,
    };
  }
  return { title: "Due-diligence version ready" };
}
