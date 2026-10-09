/**
 * Live filing after a restart, and parts that waited for the AI
 * (specs/together.md §5.10). Both run only inside server/index.ts's
 * DISABLE_SCHEDULERS gate and only where live filing may run
 * (captureEnabled), and only for sittings this kind of process created
 * (capture_env) whose lease has expired — a production server never touches
 * a local test server's sittings, and a redeploy's two instances never both
 * file one sitting.
 *
 * Per part: applying or running and already applied (the marker saved with
 * the facts) → done; applying with its saved delta → filed from it (no AI);
 * running without a delta → queued again (it never merged). Live sittings
 * with a line in the last 15 minutes are picked up again; older ones are
 * paused and their backlog filed. The transcript text is rewritten.
 */
import type { TogetherSitting } from "@shared/schema";
import { storage } from "../storage";
import { BOOT_ID, captureEnabled, leaseUntil } from "./chunker";
import { isApplied } from "./capture-apply";
import { kick } from "./pipeline";
import { captureEnv } from "./sittings";
import { togetherStore } from "./store";
import { writeTranscriptText } from "./transcript";

const LIVE_WITHIN_MS = 15 * 60_000;
const RETRY_FOR_MS = 24 * 60 * 60_000;
export const RETRY_EVERY_MS = 5 * 60_000;

export interface RecoveryReport {
  sittings: number;
  markedDone: number;
  reapplied: number;
  requeued: number;
  paused: number;
  backlog: number;
  skippedLease: number;
}

/** Boot: picks up this kind of process's sittings whose lease has expired. */
export async function recoverLiveSittings(opts: { now?: number } = {}): Promise<RecoveryReport> {
  const report: RecoveryReport = { sittings: 0, markedDone: 0, reapplied: 0, requeued: 0, paused: 0, backlog: 0, skippedLease: 0 };
  if (!captureEnabled().ok) return report;
  const now = opts.now ?? Date.now();
  const store = togetherStore();
  for (const s of await store.sittingsToRecover(captureEnv())) {
    if (!(await store.acquireLease(s.id, BOOT_ID, leaseUntil(now), new Date(now)))) {
      report.skippedLease++;
      continue;
    }
    report.sittings++;
    const deal = await storage.getDeal(s.dealId);
    const facts = ((deal?.extractedInfo ?? {}) as Record<string, unknown>);
    const chunks = await store.listChunks(s.id);
    for (const c of chunks) {
      if (c.status !== "applying" && c.status !== "running") continue;
      if (isApplied(facts, s.id, c.chunkNo)) {
        await store.updateChunk(c.id, { status: "done", appliedAt: c.appliedAt ?? new Date(now) });
        report.markedDone++;
      } else if (c.status === "applying" && c.delta) {
        report.reapplied++; // (kick files it from the saved delta — no AI)
      } else {
        await store.updateChunk(c.id, { status: "queued" });
        report.requeued++;
      }
    }
    // Lines no part has read yet (the open part when the process stopped): a backlog part.
    const lastRead = chunks.reduce((m, c) => Math.max(m, c.seqTo), 0);
    if (s.lineSeq > lastRead) {
      await store.insertChunk({ sittingId: s.id, dealId: s.dealId, seqFrom: lastRead + 1, seqTo: s.lineSeq, reason: "backlog", status: "queued", attempts: 0 });
      report.backlog++;
    }
    const last = s.lastLineAt ? new Date(s.lastLineAt).getTime() : new Date(s.startedAt).getTime();
    let row: TogetherSitting = s;
    if (s.status === "live" && now - last > LIVE_WITHIN_MS) {
      row = (await store.updateSitting(s.id, { status: "paused", pausedAt: new Date(now) })) ?? s;
      report.paused++;
    }
    if (row.transcriptDocumentId) await writeTranscriptText(row).catch(() => undefined);
    void kick(s.id);
  }
  if (report.sittings > 0) console.log(`[together] recovered ${report.sittings} session(s): ${report.reapplied} re-filed from saved parts, ${report.requeued} re-queued, ${report.backlog} backlog part(s)`);
  return report;
}

/** Every 5 minutes: parts that waited for the AI are tried again, for a day. */
export async function retryWaitingChunks(opts: { now?: number } = {}): Promise<number> {
  if (!captureEnabled().ok) return 0;
  const now = opts.now ?? Date.now();
  const store = togetherStore();
  let tried = 0;
  for (const s of await store.sittingsToRecover(captureEnv())) {
    const chunks = await store.listChunks(s.id);
    const waiting = chunks.filter((c) => (c.status === "waiting" || (c.status === "failed" && c.error !== "bad_output" && c.error !== "apply_failed")) && now - new Date(c.createdAt).getTime() < RETRY_FOR_MS);
    if (waiting.length === 0) continue;
    if (!(await store.acquireLease(s.id, BOOT_ID, leaseUntil(now), new Date(now)))) continue;
    for (const c of waiting) await store.updateChunk(c.id, { status: "queued", error: null });
    tried += waiting.length;
    void kick(s.id);
  }
  return tried;
}

let retryTimer: ReturnType<typeof setInterval> | null = null;

/** Started from the scheduler gate in server/index.ts. */
export function startTogetherRecovery(): void {
  const why = captureEnabled();
  if (!why.ok) {
    console.log(`[together] live filing recovery not started: ${why.why}`);
    return;
  }
  void recoverLiveSittings().catch((err) => console.error("[together] recovery failed:", (err as Error).message));
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    void retryWaitingChunks().catch((err) => console.error("[together] retry of waiting parts failed:", (err as Error).message));
  }, RETRY_EVERY_MS);
  (retryTimer as { unref?: () => void }).unref?.();
}
