/**
 * heavy-sheet.ts — one heavy spreadsheet parse at a time, and Excel files
 * read in an isolated worker (gl spec D10, INTEGRATION §2.6 / C19).
 *
 * withHeavySheetSlot(fn): a process-wide semaphore of one. Ledger reads,
 * ledger sniffs (peeks), the generic parser's Excel branch and the data
 * room's sheet jobs all take it, so two 15 MB workbooks never sit in memory
 * at once on a Railway instance.
 *
 * readXlsxInWorker(path, …): SheetJS runs in a worker_threads worker with a
 * memory cap and a timeout (see server/gl/xlsx-worker.ts for why). A worker
 * over its cap or its time is terminated and the read fails with a plain
 * reason ("too big to read — save it as CSV"), never taking the server down.
 */
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { XLSX_WORKER_SOURCE } from "../gl/xlsx-worker";
import type { GlCell } from "@shared/gl-types";

// ── The slot ─────────────────────────────────────────────────────────────

let busy = false;
const waiters: Array<() => void> = [];

/** Runs `fn` when no other heavy spreadsheet parse is running in this process (FIFO). */
export async function withHeavySheetSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) await new Promise<void>((resolve) => waiters.push(resolve));
  busy = true;
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else busy = false;
  }
}

/** How many parses are waiting for the slot (diagnostics, tests). */
export function heavySheetQueueLength(): number {
  return waiters.length + (busy ? 1 : 0);
}

// ── The worker ───────────────────────────────────────────────────────────

export type SheetReadErrorCode = "too_big" | "timeout" | "unreadable";

export class SheetReadError extends Error {
  constructor(public readonly code: SheetReadErrorCode, message: string) {
    super(message);
    this.name = "SheetReadError";
  }
}

/** Plain words for the seller or broker, by what went wrong. */
export const SHEET_READ_MESSAGES: Record<SheetReadErrorCode, string> = {
  too_big: "This Excel file is too big to read. Save it as CSV (File → Save As → CSV) and upload that.",
  timeout: "This Excel file took too long to read. Save it as CSV (File → Save As → CSV) and upload that.",
  unreadable: "We couldn't open this file — it may be damaged or password-protected. Export it again.",
};

export const XLSX_WORKER_MAX_OLD_MB = 900;
export const XLSX_WORKER_TIMEOUT_MS = 120_000;

let xlsxPathCache: string | null = null;
function xlsxModulePath(): string {
  if (!xlsxPathCache) xlsxPathCache = createRequire(import.meta.url).resolve("xlsx");
  return xlsxPathCache;
}

export interface WorkerRow {
  rowNo: number;
  cells: GlCell[];
}

export interface ReadXlsxOptions {
  /** Read at most this many rows per sheet (a peek). */
  sheetRows?: number;
  /** Rows per message (default 2,000). */
  batch?: number;
  /** Called per batch; the worker waits until it resolves (backpressure). */
  onRows?: (rows: WorkerRow[], sheet: string) => Promise<void> | void;
  timeoutMs?: number;
  maxOldGenerationSizeMb?: number;
  /** Tests only: the worker pollutes its own Object.prototype first (proves the realm is separate). */
  testPollute?: boolean;
}

interface WorkerSpec {
  filePath: string;
  mode: "rows" | "csv";
  sheetRows?: number;
  batch?: number;
  testPollute?: boolean;
}

function runWorker<T>(
  spec: WorkerSpec,
  opts: { timeoutMs?: number; maxOldGenerationSizeMb?: number },
  onMessage: (msg: any, worker: Worker, finish: (value: T) => void, fail: (err: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(XLSX_WORKER_SOURCE, {
      eval: true,
      workerData: { ...spec, xlsxPath: xlsxModulePath() },
      resourceLimits: { maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb ?? XLSX_WORKER_MAX_OLD_MB },
      // The worker needs nothing from the server's environment (no DB URL, no keys).
      env: {},
      stdout: false,
      stderr: false,
    });
    const timer = setTimeout(() => {
      fail(new SheetReadError("timeout", SHEET_READ_MESSAGES.timeout));
    }, opts.timeoutMs ?? XLSX_WORKER_TIMEOUT_MS);
    timer.unref?.();
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      resolve(value);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      reject(err);
    };
    worker.on("message", (msg) => {
      if (settled) return;
      if (msg?.type === "error") return fail(new SheetReadError("unreadable", SHEET_READ_MESSAGES.unreadable));
      try {
        onMessage(msg, worker, finish, fail);
      } catch (err) {
        fail(err as Error);
      }
    });
    worker.on("error", (err: any) => {
      const code: SheetReadErrorCode = err?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "too_big" : "unreadable";
      fail(new SheetReadError(code, SHEET_READ_MESSAGES[code]));
    });
    worker.on("exit", (code) => {
      if (!settled) fail(new SheetReadError(code === 0 ? "unreadable" : "too_big", SHEET_READ_MESSAGES[code === 0 ? "unreadable" : "too_big"]));
    });
  });
}

/**
 * Reads every non-blank row of every sheet in a worker, handing them to
 * `onRows` in batches (the worker waits for each to be handled). Resolves
 * with each sheet's row count; rejects with SheetReadError. Does NOT take
 * the heavy slot itself — callers wrap it (a peek and the read that follows
 * are one job).
 */
export function readXlsxInWorker(filePath: string, opts: ReadXlsxOptions = {}): Promise<{ sheets: Array<{ name: string; rows: number }> }> {
  return runWorker(
    { filePath, mode: "rows", sheetRows: opts.sheetRows, batch: opts.batch, testPollute: opts.testPollute },
    opts,
    (msg, worker, finish, fail) => {
      if (msg?.type === "rows") {
        Promise.resolve(opts.onRows?.(msg.rows as WorkerRow[], String(msg.sheet)))
          .then(() => worker.postMessage("next"))
          .catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
      } else if (msg?.type === "done") {
        finish({ sheets: msg.sheets });
      }
    },
  );
}

/**
 * The generic parser's text of a workbook ("--- Sheet: name ---" + CSV per
 * sheet), produced in the worker by the same SheetJS calls parser.ts makes
 * in-thread — used for files over 2 MB.
 */
export function xlsxToTextInWorker(filePath: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  return runWorker<string>({ filePath, mode: "csv" }, opts, (msg, _w, finish) => {
    if (msg?.type === "csv") finish(String(msg.text ?? ""));
  });
}
