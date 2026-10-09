/**
 * The render pool (vdr spec §9.5, V14): the ONLY way the web process renders
 * a document. Rendering runs in forked child processes (render-child.ts), so
 * pdf.js and the native canvas never load into the web server, a slow page
 * never blocks its event loop, and a native-memory blow-up kills one child,
 * not the server.
 *
 *  - Up to VDR_RENDER_CHILDREN (default 2) children, forked lazily on demand,
 *    one job at a time each; extra jobs wait in a bounded queue.
 *  - Child environment: an allowlist of plain runtime variables only
 *    (CHILD_ENV_ALLOWLIST) — never the database URL, API keys or session secret.
 *  - Child heap capped with --max-old-space-size (default 384 MB).
 *  - Every job has a timeout; on timeout the child is killed (SIGKILL) and the
 *    job fails with `timeout`. A child that dies mid-job fails it with
 *    `unreadable`. A child that can't start fails it with `renderer_unavailable`.
 *    Dead children are never restarted on their own; the next job forks a new one.
 *  - Idle children exit after 5 minutes. Idle children never keep a script alive.
 *
 * Child path: next to the bundle in production (dist/index.js →
 * dist/vdr/render-child.js, the second esbuild entry); render-child.ts under
 * tsx in development and tests (the parent's execArgv carries tsx's loader).
 */
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHILD_ENV_ALLOWLIST,
  type ChildMessage,
  type RenderErrorCode,
  type RenderJob,
  type RenderResultFor,
} from "./render-jobs";
import { VDR_JOB_TIMEOUTS_MS } from "./child/limits";
import { judgeCanary } from "./canary-pdf";

export class RenderJobError extends Error {
  constructor(public readonly code: RenderErrorCode, message: string) {
    super(message);
    this.name = "RenderJobError";
  }
}

export type RenderPoolOptions = {
  /** Most children at once (env VDR_RENDER_CHILDREN, default 2). */
  maxChildren?: number;
  /** Child V8 heap cap in MB (default 384). */
  heapMb?: number;
  /** An idle child exits after this long (default 5 minutes). */
  idleMs?: number;
  /** Jobs that may wait for a free child (default 200). */
  maxQueue?: number;
  /** Override the child script (tests). */
  childPath?: string;
  /** Extra node flags for the child, after the inherited loader flags (tests: simulate an older Node). */
  extraExecArgv?: string[];
};

type Pending = {
  id: number;
  job: RenderJob;
  timeoutMs: number;
  resolve: (v: any) => void;
  reject: (e: RenderJobError) => void;
  timer?: NodeJS.Timeout;
};

type Child = {
  proc: ChildProcess;
  ready: boolean;
  job: Pending | null;
  idleTimer?: NodeJS.Timeout;
  dead: boolean;
};

export function defaultChildPath(): string {
  const here = fileURLToPath(import.meta.url);
  // Unbundled (tsx): server/vdr/render-pool.ts → server/vdr/render-child.ts.
  if (here.endsWith(".ts")) return path.join(path.dirname(here), "render-child.ts");
  // Bundled: this code lives in dist/index.js → dist/vdr/render-child.js.
  return path.join(path.dirname(here), "vdr", "render-child.js");
}

/** Node flags for the child: the parent's (tsx's loader in development), minus debugger flags, plus the heap cap. */
export function childExecArgv(parentArgv: readonly string[], childPath: string, heapMb: number, extra: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < parentArgv.length; i++) {
    const a = parentArgv[i];
    if (/^--inspect(-brk|-port|-publish-uid)?(=|$)/.test(a) || /^--debug/.test(a)) {
      if (!a.includes("=") && /^--inspect-port$/.test(a)) i++;
      continue;
    }
    if (/^--max-old-space-size(=|$)/.test(a)) {
      if (!a.includes("=")) i++;
      continue;
    }
    out.push(a);
  }
  // A .ts child needs a TypeScript loader; add tsx's when the parent didn't pass one on the command line.
  if (childPath.endsWith(".ts") && !out.some((a) => a.includes("tsx"))) out.push("--import", "tsx");
  out.push(...extra, `--max-old-space-size=${heapMb}`);
  return out;
}

/** The child's environment: allowlisted plain variables only, plus the child marker. */
export function childEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of CHILD_ENV_ALLOWLIST) {
    const v = parentEnv[k];
    if (typeof v === "string" && v !== "") env[k] = v;
  }
  env.VDR_CHILD = "1";
  return env;
}

export function createRenderPool(options: RenderPoolOptions = {}) {
  const maxChildren = Math.max(1, Math.min(8, options.maxChildren ?? (Number(process.env.VDR_RENDER_CHILDREN) || 2)));
  const heapMb = options.heapMb ?? 384;
  const idleMs = options.idleMs ?? 5 * 60_000;
  const maxQueue = options.maxQueue ?? 200;
  const childPath = options.childPath ?? defaultChildPath();
  const children = new Set<Child>();
  const queue: Pending[] = [];
  let nextId = 1;
  let closed = false;

  function settle(c: Child, p: Pending, outcome: { ok: true; result: unknown } | { ok: false; code: RenderErrorCode; message: string }) {
    if (c.job !== p) return;
    c.job = null;
    if (p.timer) clearTimeout(p.timer);
    if (outcome.ok) p.resolve(outcome.result);
    else p.reject(new RenderJobError(outcome.code, outcome.message));
  }

  function retire(c: Child, signal: NodeJS.Signals = "SIGKILL") {
    if (c.dead) return;
    c.dead = true;
    children.delete(c);
    if (c.idleTimer) clearTimeout(c.idleTimer);
    try { c.proc.kill(signal); } catch { /* already gone */ }
  }

  function setIdle(c: Child) {
    if (c.idleTimer) clearTimeout(c.idleTimer);
    c.idleTimer = setTimeout(() => {
      if (!c.job) {
        retire(c, "SIGTERM");
        try { c.proc.disconnect(); } catch { /* gone */ }
      }
    }, idleMs);
    c.idleTimer.unref();
    // An idle child never keeps a script (or a test) alive.
    c.proc.unref();
    (c.proc.channel as { unref?: () => void } | undefined)?.unref?.();
  }

  function dispatch(c: Child, p: Pending) {
    c.job = p;
    if (c.idleTimer) clearTimeout(c.idleTimer);
    c.proc.ref();
    (c.proc.channel as { ref?: () => void } | undefined)?.ref?.();
    // The timeout covers the child's start-up too.
    p.timer = setTimeout(() => {
      // Kill first, then fail the job: the next job must never land on a child still busy with this one.
      retire(c);
      settle(c, p, { ok: false, code: "timeout", message: `no answer within ${p.timeoutMs} ms` });
      pump();
    }, p.timeoutMs);
    if (c.ready) send(c, p);
    // else: sent when the child says it's ready (a message sent earlier could arrive before its listener exists).
  }

  function send(c: Child, p: Pending) {
    try {
      c.proc.send({ id: p.id, job: p.job });
    } catch (err: any) {
      retire(c);
      settle(c, p, { ok: false, code: "renderer_unavailable", message: `couldn't reach the render process: ${err?.message || err}` });
      pump();
    }
  }

  function spawn(): Child | null {
    if (!fs.existsSync(childPath)) return null;
    const proc = fork(childPath, [], {
      execArgv: childExecArgv(process.execArgv, childPath, heapMb, options.extraExecArgv),
      env: childEnv(process.env),
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const c: Child = { proc, ready: false, job: null, dead: false };
    children.add(c);
    proc.on("message", (raw) => {
      const msg = raw as ChildMessage;
      if (msg?.type === "ready") {
        c.ready = true;
        if (c.job) send(c, c.job);
        return;
      }
      if (msg?.type === "result" && c.job && c.job.id === msg.id) {
        settle(c, c.job, msg.ok ? { ok: true, result: msg.result } : { ok: false, code: msg.code, message: msg.message });
        if (closed) retire(c, "SIGTERM");
        else if (!pump(c)) setIdle(c);
      }
    });
    const onGone = (why: string) => {
      const wasReady = c.ready;
      const p = c.job;
      c.dead = true;
      children.delete(c);
      if (c.idleTimer) clearTimeout(c.idleTimer);
      // An IPC error can leave the process running without a channel: make sure it's gone.
      if (proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill("SIGKILL"); } catch { /* gone */ }
      }
      if (p) {
        settle(c, p, wasReady
          ? { ok: false, code: "unreadable", message: `the render process stopped (${why})` }
          : { ok: false, code: "renderer_unavailable", message: `the render process didn't start (${why})` });
      }
      if (!closed) pump();
    };
    proc.on("exit", (code, signal) => onGone(signal ? `signal ${signal}` : `exit code ${code}`));
    proc.on("error", (err) => onGone(err.message));
    return c;
  }

  /** Gives queued jobs to idle children, forking new ones up to the cap. Returns true if `prefer` got a job. */
  function pump(prefer?: Child): boolean {
    let preferred = false;
    if (prefer && !prefer.dead && !prefer.job && queue.length) {
      dispatch(prefer, queue.shift()!);
      preferred = true;
    }
    while (queue.length) {
      const idle = Array.from(children).find((c) => !c.dead && !c.job);
      if (idle) {
        dispatch(idle, queue.shift()!);
        continue;
      }
      if (children.size >= maxChildren) break;
      const c = spawn();
      if (!c) {
        const rel = path.relative(process.cwd(), childPath) || childPath;
        for (const p of queue.splice(0)) p.reject(new RenderJobError("renderer_unavailable", `the render process isn't installed (${rel} is missing)`));
        break;
      }
      dispatch(c, queue.shift()!);
    }
    return preferred;
  }

  return {
    /** Runs one job in a render process. Rejects with RenderJobError (a plain `code`). */
    run<J extends RenderJob>(job: J, opts: { timeoutMs?: number } = {}): Promise<RenderResultFor<J>> {
      if (closed) return Promise.reject(new RenderJobError("renderer_unavailable", "the render pool is closed"));
      if (queue.length >= maxQueue) return Promise.reject(new RenderJobError("renderer_unavailable", "too many documents are being prepared; try again in a minute"));
      const timeoutMs = Math.max(1, opts.timeoutMs ?? defaultTimeout(job));
      return new Promise<RenderResultFor<J>>((resolve, reject) => {
        queue.push({ id: nextId++, job, timeoutMs, resolve, reject });
        pump();
      });
    },
    /** Live children (for tests and the health line). */
    stats() {
      return {
        children: Array.from(children).map((c) => ({ pid: c.proc.pid ?? null, busy: !!c.job, ready: c.ready })),
        queued: queue.length,
        maxChildren,
        childPath,
      };
    },
    /** Stops every child and fails queued jobs. */
    async close(): Promise<void> {
      closed = true;
      for (const p of queue.splice(0)) p.reject(new RenderJobError("renderer_unavailable", "the render pool is closed"));
      const exits = Array.from(children).map((c) => new Promise<void>((res) => {
        if (c.proc.exitCode !== null || c.proc.signalCode !== null) return res();
        const fallback = setTimeout(() => { try { c.proc.kill("SIGKILL"); } catch { /* gone */ } res(); }, 2000);
        c.proc.once("exit", () => { clearTimeout(fallback); res(); });
        c.proc.ref(); // an idle child is unref'd; wait for its exit
        if (c.job) settle(c, c.job, { ok: false, code: "renderer_unavailable", message: "the render pool is closed" });
        retire(c, "SIGTERM");
      }));
      await Promise.all(exits);
    },
  };
}

export type RenderPool = ReturnType<typeof createRenderPool>;

function defaultTimeout(job: RenderJob): number {
  switch (job.kind) {
    case "canary": return VDR_JOB_TIMEOUTS_MS.canary;
    case "zipCheck": return VDR_JOB_TIMEOUTS_MS.inspect;
    case "prepare": return VDR_JOB_TIMEOUTS_MS.prepare;
    default: return VDR_JOB_TIMEOUTS_MS.page;
  }
}

/** The web process's pool. Nothing is forked until the first job. */
export const renderPool = createRenderPool();

export type RendererStatus =
  | { ok: true; detail: Omit<RenderResultFor<{ kind: "canary" }>, "jpeg">; jpeg: Uint8Array }
  | { ok: false; reason: string; code?: RenderErrorCode; detail?: Omit<RenderResultFor<{ kind: "canary" }>, "jpeg"> };

/**
 * Renders the built-in PDF in a render process and judges the result
 * (the `/api/vdr/health` canary). Never throws.
 */
export async function rendererStatus(pool: RenderPool = renderPool): Promise<RendererStatus> {
  try {
    const { jpeg, ...detail } = await pool.run({ kind: "canary" });
    const verdict = judgeCanary(detail);
    return verdict === "ok" ? { ok: true, detail, jpeg } : { ok: false, reason: verdict, detail };
  } catch (err: any) {
    if (err instanceof RenderJobError) return { ok: false, reason: `${err.code}: ${err.message}`, code: err.code };
    return { ok: false, reason: `renderer_unavailable: ${String(err?.message || err).slice(0, 300)}`, code: "renderer_unavailable" };
  }
}
