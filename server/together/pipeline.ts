/**
 * Live filing for "Interview together" (specs/together.md §5): lines → parts
 * (the chunker) → one extraction call per part (capture.ts) → the guards
 * (capture-guards.ts) → the deal's facts (capture-apply.ts) → a board diff
 * pushed to every open tab within seconds.
 *
 * One runner per sitting, in this process (§13 risk 9). It runs only where
 * live filing may run (captureEnabled: production, or a local replay with a
 * recorded model) and only for sittings this kind of process created
 * (capture_env), holding the sitting's lease. One extraction at a time per
 * sitting; parts are filed in order; queued parts are coalesced into one
 * call (never a ✓ Answered or a typed part).
 *
 * Failures (§5.10): an unavailable or overloaded AI is retried after 4 s and
 * 15 s, then the circuit opens — new parts wait, a probe tries the oldest
 * every minute, "Try now" tries at once; nothing said is lost. Out of credit:
 * no fast retries. A malformed answer is retried once, then its lines are
 * read again with the next part (once).
 */
import type { Deal, TogetherChunk, TogetherLine, TogetherSitting } from "@shared/schema";
import { CIM_SECTIONS } from "@shared/schema";
import type { CoverageBoard, CoverageItem } from "@shared/coverage-board";
import type { BoardDiff, BrokerUnconfirmedView, CaptureHints, SpeakerMap } from "@shared/together";
import { lineRole, rolesKnown, speakerDisplay, speakerKind } from "@shared/together-speakers";
import { storage } from "../storage";
import { boardFromCoverage, loadCoverageInputs, type CoverageInputs } from "../interview/coverage-board";
import { bestSection } from "../interview/question-rationale";
import { getSellerKeepOut } from "../interview/seller-keep-out";
import * as hub from "./hub";
import { BoardActionError } from "./errors";
import { TOGETHER_LIMITS } from "./limits";
import {
  BOOT_ID,
  answerWordsOf,
  budgetState,
  captureEnabled,
  decideChunk,
  focusRange,
  initialChunkerState,
  leaseUntil,
  type ChunkClose,
  type ChunkerLine,
  type ChunkerState,
  type ChunkReason,
} from "./chunker";
import {
  buildCaptureSystem,
  buildCaptureUser,
  catalogueFromBoard,
  CaptureError,
  renderCatalogue,
  runCapture,
  type CaptureCatalogue,
  type CaptureLine,
  type CaptureOutput,
  type CaptureUsage,
} from "./capture";
import { guardCaptured, promoteHeld, type GuardLine, type GuardedCapture, type HeldSuggestion } from "./capture-guards";
import { applyCapture, type ChunkResult } from "./capture-apply";
import { togetherStore } from "./store";

// ─────────────────────────────────────────────────────────────────────────
// Clock and timers (a seam for tests)
// ─────────────────────────────────────────────────────────────────────────

export interface PipelineDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  sleep(ms: number): Promise<void>;
}

const realDeps: PipelineDeps = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  sleep: (ms) => new Promise((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); }),
};
let deps: PipelineDeps = realDeps;

export function _setPipelineDepsForTests(d: Partial<PipelineDeps> | null): void {
  deps = d ? { ...realDeps, ...d } : realDeps;
}

/** Retry waits after an unavailable AI (§5.10). */
export const RETRY_WAITS_MS = [4_000, 15_000];
export const PROBE_EVERY_MS = 60_000;
/** The first part waits this long for "This is me" when two voices are unnamed. */
export const ROLES_WAIT_MS = 20_000;
const COALESCE_MAX_WORDS = 900;
const CONTEXT_LINES = 6;
const CONTEXT_WORDS = 120;
const HELD_MAX = 50;
const UNCONFIRMED_MAX = 20;

// ─────────────────────────────────────────────────────────────────────────
// Capture state on the sitting (capture_state jsonb — top-level keys merged)
// ─────────────────────────────────────────────────────────────────────────

export type HeldEntry = HeldSuggestion & { chunkId: string; at: string };

export interface CaptureStateShape {
  chunksDone?: number;
  chunksWaiting?: number;
  chunksFailed?: number;
  circuitOpenAt?: string | null;
  lastError?: string | null;
  sourceDeleted?: boolean;
  undone?: Array<{ chunkId: string; key: string }>;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; calls: number; modelMs: number };
  held?: HeldEntry[];
  brokerUnconfirmed?: BrokerUnconfirmedView[];
  hints?: CaptureHints;
  longSession?: boolean;
  liveHeld?: boolean;
  transcriptWrittenAt?: string;
  lastFiled?: { at: string; count: number; chunkId: string };
  /** Seller's last word → filed, per part (ms), with how long the part waited first (the roles wait, the queue). */
  timing?: Array<{ ms: number; waited: number; reason: string }>;
}

export function captureStateOf(s: Pick<TogetherSitting, "captureState">): CaptureStateShape {
  return ((s.captureState ?? {}) as CaptureStateShape) || {};
}

// ─────────────────────────────────────────────────────────────────────────
// Runners
// ─────────────────────────────────────────────────────────────────────────

interface Runner {
  sittingId: string;
  dealId: string;
  state: ChunkerState;
  timer: unknown | null;
  waitTimer: unknown | null;
  running: boolean;
  calls: number[];
  callsTotal: number;
  catalogue: { structureKey: string; text: string; values: Map<string, string | null> } | null;
  reinclude: number | null;
  circuitOpenAt: number | null;
  lastBoard: CoverageBoard | null;
  idleWaiters: Array<() => void>;
}

const runners = new Map<string, Runner>();

function runnerFor(s: Pick<TogetherSitting, "id" | "dealId">): Runner {
  let r = runners.get(s.id);
  if (!r) {
    r = { sittingId: s.id, dealId: s.dealId, state: initialChunkerState(), timer: null, waitTimer: null, running: false, calls: [], callsTotal: 0, catalogue: null, reinclude: null, circuitOpenAt: null, lastBoard: null, idleWaiters: [] };
    runners.set(s.id, r);
  }
  return r;
}

/** Is live filing running for this sitting, here? */
export function filingOn(s: Pick<TogetherSitting, "captureEnv" | "captureState" | "status">): boolean {
  if (!captureEnabled().ok) return false;
  const env = process.env.NODE_ENV === "production" ? "production" : "local";
  return s.captureEnv === env && !captureStateOf(s).sourceDeleted;
}

/** The board the runner last pushed (its diff base); route actions that push a board call this too. */
export function rememberBoard(sittingId: string, board: CoverageBoard): void {
  const r = runners.get(sittingId);
  if (r) r.lastBoard = board;
}

function roleLine(speakers: SpeakerMap, l: Pick<TogetherLine, "seq" | "speaker" | "text" | "source" | "attestedSellerAt" | "at">): ChunkerLine {
  return {
    seq: l.seq,
    role: lineRole(speakers, { speaker: l.speaker, attested: !!l.attestedSellerAt }),
    typed: l.source === "typed",
    text: l.text,
    at: new Date(l.at).getTime(),
  };
}

function arm(r: Runner, ms: number | null): void {
  if (r.timer) deps.clearTimer(r.timer);
  r.timer = null;
  if (ms === null) return;
  r.timer = deps.setTimer(() => {
    r.timer = null;
    void onTimer(r.sittingId).catch((err) => console.warn(`[together] chunk timer failed (${r.sittingId}):`, (err as Error).message));
  }, ms);
}

async function apply(r: Runner, s: TogetherSitting, decision: ReturnType<typeof decideChunk>): Promise<string[]> {
  r.state = decision.state;
  arm(r, decision.armTimerMs);
  const ids: string[] = [];
  for (const c of decision.close) ids.push(...(await createChunks(s, r, c)));
  if (ids.length > 0) void kick(s.id);
  return ids;
}

/** New lines arrived (appendLines). */
export async function onLines(sitting: TogetherSitting, lines: TogetherLine[]): Promise<void> {
  if (!filingOn(sitting) || sitting.status === "ended" || lines.length === 0) return;
  const fresh = !runners.has(sitting.id);
  const r = runnerFor(sitting);
  // A new runner (this process just started, or the session was idle): lines
  // said since the last part that were never read go in the open part first —
  // nothing said before a restart is skipped.
  if (fresh) await seedOpenPart(sitting, r, lines[0].seq);
  const speakers = (sitting.speakers ?? {}) as SpeakerMap;
  for (const l of lines) {
    const d = decideChunk(r.state, { type: "line", line: roleLine(speakers, l) }, deps.now());
    await apply(r, sitting, d);
  }
}

async function seedOpenPart(sitting: TogetherSitting, r: Runner, firstNewSeq: number): Promise<void> {
  try {
    const chunks = await togetherStore().listChunks(sitting.id);
    const lastRead = chunks.reduce((m, c) => Math.max(m, c.seqTo), 0);
    if (firstNewSeq - 1 <= lastRead) return;
    const speakers = (sitting.speakers ?? {}) as SpeakerMap;
    const unread = (await togetherStore().linesBetween(sitting.id, lastRead + 1, firstNewSeq - 1)).slice(-60);
    for (const l of unread) {
      const d = decideChunk(r.state, { type: "line", line: roleLine(speakers, l) }, deps.now());
      await apply(r, sitting, d);
    }
  } catch (err) {
    console.warn(`[together] couldn't pick up the unread lines (${sitting.id}):`, (err as Error).message);
  }
}

async function onTimer(sittingId: string): Promise<void> {
  const s = await togetherStore().getSitting(sittingId);
  const r = runners.get(sittingId);
  if (!s || !r) return;
  await apply(r, s, decideChunk(r.state, { type: "timer" }, deps.now()));
}

/**
 * "Save this answer now" (focus omitted) or ✓ Answered (focus = the item):
 * the open part is filed now. With nothing open, ✓ Answered re-reads the
 * seller's last few minutes for that item. Returns the part's id, or null
 * when there was nothing to file from.
 */
export async function fileNow(sitting: TogetherSitting, focusItemId?: string): Promise<string | null> {
  if (!filingOn(sitting)) throw new BoardActionError("Live filing isn't running here — type what the seller said instead.", 409, "no_capture");
  const r = runnerFor(sitting);
  const now = deps.now();
  if (!focusItemId) {
    const ids = await apply(r, sitting, decideChunk(r.state, { type: "manual" }, now));
    return ids[0] ?? null;
  }
  const d = decideChunk(r.state, { type: "focus", itemId: focusItemId }, now);
  if (!d.reread) {
    const ids = await apply(r, sitting, d);
    return ids[ids.length - 1] ?? null;
  }
  r.state = d.state;
  // Nothing open: the seller's lines since the item was asked (or the last 3 minutes).
  const lines = await togetherStore().lastLines(sitting.id, 120);
  const speakers = (sitting.speakers ?? {}) as SpeakerMap;
  const asked = await askedSeqFor(sitting, focusItemId);
  const range = focusRange(lines.map((l) => roleLine(speakers, l)), { now, askedSeq: asked });
  if (!range) return null;
  const ids = await createChunks(sitting, r, { ...range, reason: "focus", focusItemId });
  void kick(sitting.id);
  return ids[0] ?? null;
}

/** The line a broker asked this item at (the "asked" mark's moment), if this session. */
async function askedSeqFor(sitting: TogetherSitting, itemId: string): Promise<number | null> {
  try {
    const { activeMarks } = await import("./marks");
    const m = (await activeMarks(sitting.dealId)).find((x) => x.itemId === itemId && x.kind === "asked" && x.sittingId === sitting.id);
    if (!m) return null;
    const at = new Date(m.createdAt).getTime();
    const lines = await togetherStore().lastLines(sitting.id, 200);
    const before = lines.filter((l) => new Date(l.at).getTime() <= at + 1000);
    return before.length > 0 ? before[before.length - 1].seq : null;
  } catch {
    return null;
  }
}

/** Pause / end: whatever is open is filed now. */
export async function flush(sitting: TogetherSitting, reason: "end" | "manual" = "end"): Promise<void> {
  if (!filingOn(sitting)) return;
  const r = runners.get(sitting.id);
  if (!r) return;
  await apply(r, sitting, decideChunk(r.state, { type: reason === "end" ? "end" : "manual" }, deps.now()));
}

/** Waits (≤ ms) until nothing is queued or running for the sitting. */
export async function waitForIdle(sittingId: string, ms: number): Promise<boolean> {
  const r = runners.get(sittingId);
  if (!r) return true;
  const busy = async () => (await togetherStore().listChunks(sittingId)).some((c) => c.status === "queued" || c.status === "running" || c.status === "applying");
  if (!r.running && !(await busy())) return true;
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
    r.idleWaiters.push(() => finish(true));
    deps.setTimer(() => finish(false), ms);
  });
}

function notifyIdle(r: Runner): void {
  const w = r.idleWaiters.splice(0);
  for (const f of w) f();
}

/** Drops the runner (the sitting ended and its parts are filed, or the transcript was deleted). */
export function stopRunner(sittingId: string): void {
  const r = runners.get(sittingId);
  if (!r) return;
  if (r.timer) deps.clearTimer(r.timer);
  if (r.waitTimer) deps.clearTimer(r.waitTimer);
  notifyIdle(r);
  runners.delete(sittingId);
  void togetherStore().releaseLease(sittingId, BOOT_ID).catch(() => undefined);
}

export function _resetPipelineForTests(): void {
  for (const id of Array.from(runners.keys())) stopRunner(id);
}

// ─────────────────────────────────────────────────────────────────────────
// Parts → chunk rows
// ─────────────────────────────────────────────────────────────────────────

async function createChunks(s: TogetherSitting, r: Runner, c: ChunkClose): Promise<string[]> {
  const store = togetherStore();
  let fromSeq = c.fromSeq;
  // A part the model couldn't read is read again with the next one (once).
  if (r.reinclude !== null && c.reason !== "typed" && c.reason !== "focus") {
    fromSeq = Math.min(fromSeq, r.reinclude);
    r.reinclude = null;
  }
  const ranges: Array<{ from: number; to: number }> = [];
  if (c.reason === "end" || c.reason === "backlog") {
    // The rest of a long session, in pieces of ≤ 900 answer words.
    const speakers = (s.speakers ?? {}) as SpeakerMap;
    const lines = (await store.linesBetween(s.id, fromSeq, c.toSeq)).filter((l) => l.source !== "typed");
    let start = fromSeq;
    let words = 0;
    for (const l of lines) {
      const w = answerWordsOf(roleLine(speakers, l));
      if (words + w > COALESCE_MAX_WORDS && words > 0) {
        ranges.push({ from: start, to: l.seq - 1 });
        start = l.seq;
        words = 0;
      }
      words += w;
    }
    ranges.push({ from: start, to: c.toSeq });
  } else {
    ranges.push({ from: fromSeq, to: c.toSeq });
  }
  const ids: string[] = [];
  const open = r.circuitOpenAt !== null;
  for (const range of ranges) {
    const row = await store.insertChunk({
      sittingId: s.id,
      dealId: s.dealId,
      seqFrom: range.from,
      seqTo: range.to,
      reason: c.reason,
      focusItemId: c.focusItemId ?? null,
      status: open ? "waiting" : "queued",
      attempts: 0,
      createdAt: new Date(deps.now()),
    });
    ids.push(row.id);
    // "Filing what the seller said about Seasonality…"
    const section = await sectionGuess(s.id, range.from, range.to).catch(() => null);
    hub.publish(s.id, { type: "filing", section: section?.key ?? null, sectionTitle: section?.title ?? null, chunkId: row.id });
  }
  if (open) await publishStatus(s.id);
  return ids;
}

async function sectionGuess(sittingId: string, from: number, to: number): Promise<{ key: string; title: string } | null> {
  const lines = await togetherStore().linesBetween(sittingId, from, to);
  const key = bestSection(lines.map((l) => l.text).join(" "), CIM_SECTIONS.map((x) => x.key));
  const sec = CIM_SECTIONS.find((x) => x.key === key);
  return sec ? { key: sec.key, title: sec.title } : null;
}

// ─────────────────────────────────────────────────────────────────────────
// The queue
// ─────────────────────────────────────────────────────────────────────────

const PENDING = new Set(["queued", "running", "applying", "waiting"]);
const isBlockingFailure = (c: TogetherChunk) => c.status === "failed" && c.error !== "bad_output";

/** Runs the sitting's queued parts, one at a time, in order. */
export async function kick(sittingId: string, opts: { probe?: boolean } = {}): Promise<void> {
  const s0 = await togetherStore().getSitting(sittingId);
  if (!s0 || !filingOn(s0)) return;
  const r = runnerFor(s0);
  if (r.running) return;
  r.running = true;
  try {
    for (let guard = 0; guard < 500; guard++) {
      const s = (await togetherStore().getSitting(sittingId)) ?? s0;
      if (captureStateOf(s).sourceDeleted) break;
      const now = deps.now();
      if (!(await togetherStore().acquireLease(s.id, BOOT_ID, leaseUntil(now), new Date(now)))) break;
      const chunks = await togetherStore().listChunks(s.id);
      // In order: the first part not yet filed (a failed one blocks the rest while the AI is down).
      const next = chunks.find((c) => PENDING.has(c.status) || isBlockingFailure(c));
      if (!next) break;
      const probing = !!opts.probe;
      if ((next.status === "waiting" || isBlockingFailure(next)) && r.circuitOpenAt !== null && !probing) {
        armProbe(r);
        break;
      }
      if (next.status === "applying" && next.delta) {
        // (Being filed right now by another path — a held answer's ✓ File it: wait for it.)
        if (applyingNow.has(next.id)) {
          if (r.waitTimer) deps.clearTimer(r.waitTimer);
          r.waitTimer = deps.setTimer(() => { r.waitTimer = null; void kick(sittingId); }, 500);
          break;
        }
        // (Saved before the merge — filed from it, never read again.)
        await applyFromDelta(s, next);
        continue;
      }
      // The first part waits up to 20 s for "This is me" when two voices are unnamed.
      if (r.callsTotal === 0 && next.reason !== "typed" && !(await rolesReady(s)) && now - new Date(next.createdAt).getTime() < ROLES_WAIT_MS) {
        if (r.waitTimer) deps.clearTimer(r.waitTimer);
        r.waitTimer = deps.setTimer(() => { r.waitTimer = null; void kick(sittingId); }, ROLES_WAIT_MS - (now - new Date(next.createdAt).getTime()));
        break;
      }
      const target = await coalesce(s, chunks, next);
      const ok = await runChunk(s, r, target, probing);
      opts.probe = false;
      if (!ok) break;
    }
  } finally {
    r.running = false;
    const left = (await togetherStore().listChunks(sittingId).catch(() => [] as TogetherChunk[])).some((c) => c.status === "queued" || c.status === "running" || c.status === "applying");
    if (!left) notifyIdle(r);
  }
}

async function rolesReady(s: TogetherSitting): Promise<boolean> {
  const lines = await togetherStore().lastLines(s.id, 60);
  const present = Array.from(new Set(lines.map((l) => l.speaker))).filter((id) => speakerKind(id) !== "typed");
  if (present.length < 2) return true;
  return rolesKnown((s.speakers ?? {}) as SpeakerMap, present);
}

/** Two or more queued spoken parts become one call (≤ 900 answer words; never a focus or typed part). */
async function coalesce(s: TogetherSitting, chunks: TogetherChunk[], first: TogetherChunk): Promise<TogetherChunk> {
  if (first.status !== "queued" || first.reason === "focus" || first.reason === "typed") return first;
  const queued = chunks.filter((c) => c.chunkNo >= first.chunkNo && c.status === "queued");
  const take: TogetherChunk[] = [first];
  for (const c of queued.slice(1)) {
    if (c.chunkNo !== take[take.length - 1].chunkNo + 1 || c.reason === "focus" || c.reason === "typed") break;
    take.push(c);
  }
  if (take.length < 2) return first;
  const speakers = (s.speakers ?? {}) as SpeakerMap;
  const lines = await togetherStore().linesBetween(s.id, first.seqFrom, take[take.length - 1].seqTo);
  let words = 0;
  let upto = 0;
  for (let i = 0; i < take.length; i++) {
    const w = lines.filter((l) => l.seq >= take[i].seqFrom && l.seq <= take[i].seqTo && l.source !== "typed").reduce((n, l) => n + answerWordsOf(roleLine(speakers, l)), 0);
    if (i > 0 && words + w > COALESCE_MAX_WORDS) break;
    words += w;
    upto = i;
  }
  if (upto === 0) return first;
  const last = take[upto];
  for (const c of take.slice(0, upto)) await togetherStore().updateChunk(c.id, { status: "skipped", error: null, doneAt: new Date(deps.now()) });
  return (await togetherStore().updateChunk(last.id, { seqFrom: first.seqFrom })) ?? last;
}

function armProbe(r: Runner): void {
  if (r.waitTimer) return;
  r.waitTimer = deps.setTimer(() => {
    r.waitTimer = null;
    void kick(r.sittingId, { probe: true });
  }, PROBE_EVERY_MS);
}

// ─────────────────────────────────────────────────────────────────────────
// One part
// ─────────────────────────────────────────────────────────────────────────

interface Prepared {
  deal: Deal;
  inputs: CoverageInputs;
  board: CoverageBoard;
  catalogue: CaptureCatalogue;
  newLines: GuardLine[];
  captureLines: CaptureLine[];
  context: CaptureLine[];
  user: string;
  system: ReturnType<typeof buildCaptureSystem>;
  sellerLabel: string;
  sessionSellerText: string;
}

const whoOf = (speakers: SpeakerMap, l: TogetherLine, order: string[], sellerName: string | null): string => {
  if (l.source === "typed") return "TYPED (broker)";
  const role = lineRole(speakers, { speaker: l.speaker, attested: !!l.attestedSellerAt });
  if (role === "broker") return "Broker";
  if (role === "seller") return sellerName ? `Seller (${sellerName})` : "Seller";
  if (role === "other") return `${speakerDisplay(l.speaker, speakers[l.speaker], order)} (someone else)`;
  return `${speakerDisplay(l.speaker, speakers[l.speaker], order)} (not identified yet)`;
};

async function prepare(s: TogetherSitting, r: Runner, chunk: TogetherChunk): Promise<Prepared | null> {
  const deal = await storage.getDeal(s.dealId);
  if (!deal) return null;
  const store = togetherStore();
  const speakers = (s.speakers ?? {}) as SpeakerMap;
  const range = await store.linesBetween(s.id, chunk.seqFrom, chunk.seqTo);
  const typedPart = chunk.reason === "typed";
  const fresh = range.filter((l) => (typedPart ? l.source === "typed" : l.source !== "typed"));
  if (fresh.length === 0) return null;
  const order = Array.from(new Set((await store.lastLines(s.id, 400)).map((l) => l.speaker)));
  const sellerName = Object.values(speakers).find((x) => x.role === "seller" && x.name)?.name ?? null;
  const before = (await store.linesBetween(s.id, Math.max(1, chunk.seqFrom - 20), chunk.seqFrom - 1)).filter((l) => l.source !== "typed");
  const context: CaptureLine[] = [];
  let ctxWords = 0;
  for (const l of before.reverse()) {
    if (context.length >= CONTEXT_LINES) break;
    const w = l.text.split(/\s+/).length;
    if (ctxWords + w > CONTEXT_WORDS && context.length > 0) break;
    ctxWords += w;
    context.unshift({ seq: l.seq, who: whoOf(speakers, l, order, sellerName), text: l.text });
  }
  const captureLines = fresh.map((l) => ({ seq: l.seq, who: whoOf(speakers, l, order, sellerName), text: l.text }));
  const newLines: GuardLine[] = fresh.map((l) => {
    const rl = roleLine(speakers, l);
    return { seq: rl.seq, role: rl.role, typed: rl.typed, text: rl.text };
  });

  const inputs = await loadCoverageInputs(deal);
  const board = boardFromCoverage(inputs, "screen");
  const catalogue = catalogueFromBoard(board);
  // The checklist text is cached (the prompt cache): re-rendered when its
  // structure changes or 20+ values changed; smaller changes go in the message.
  const values = new Map(catalogue.items.map((i) => [i.itemId, i.onFile] as const));
  let changed: string[] = [];
  if (r.catalogue && r.catalogue.structureKey === catalogue.structureKey) {
    for (const i of catalogue.items) {
      const was = r.catalogue.values.get(i.itemId) ?? null;
      if (was !== i.onFile && i.onFile) changed.push(`${i.members.find((m) => m.writable)?.key ?? i.itemId} = "${i.onFile}"`);
    }
  }
  if (!r.catalogue || r.catalogue.structureKey !== catalogue.structureKey || changed.length >= 20) {
    r.catalogue = { structureKey: catalogue.structureKey, text: renderCatalogue(catalogue), values };
    changed = [];
  }
  const brokerUser = await storage.getUser(s.brokerId).catch(() => undefined);
  const brokerName = String((brokerUser as { name?: string | null } | undefined)?.name ?? "").trim();
  const present = order.filter((id) => speakerKind(id) !== "typed");
  const speakersLine = rolesKnown(speakers, present)
    ? `Broker = ${brokerName || "the broker"}. Seller = ${sellerName || "the owner"}.`
    : `Broker = ${brokerName || "the broker"}. Some speakers not identified yet.`;
  const focusItem = chunk.focusItemId ? catalogue.items.find((i) => i.itemId === chunk.focusItemId) : undefined;
  const user = buildCaptureUser({
    speakersLine,
    changed,
    focus: focusItem ? { itemId: focusItem.itemId, label: focusItem.label } : null,
    context,
    lines: captureLines,
  });
  const sellerSoFar = (await store.lastLines(s.id, 300)).filter((l) => lineRole(speakers, { speaker: l.speaker, attested: !!l.attestedSellerAt }) === "seller").map((l) => l.text).join("\n");
  return {
    deal,
    inputs,
    board,
    catalogue,
    newLines,
    captureLines,
    context,
    user,
    system: buildCaptureSystem(r.catalogue.text),
    sellerLabel: `${sellerName || "The owner"} (seller)`,
    sessionSellerText: sellerSoFar.slice(-6000),
  };
}

function onFileTextOf(facts: Record<string, unknown>): string {
  const parts: string[] = [];
  let n = 0;
  for (const [k, v] of Object.entries(facts)) {
    if (k.startsWith("_")) continue;
    const t = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(t);
    n += t.length;
    if (n > 20_000) break;
  }
  return parts.join("\n");
}

let stubChecked = false;

/**
 * The local replay (scripts/together-replay.ts): with TOGETHER_CAPTURE=on,
 * the key "disabled" and TOGETHER_CAPTURE_STUB set — and never in
 * production — the recorded model answers instead of the AI.
 */
async function ensureReplayModel(): Promise<void> {
  if (stubChecked) return;
  stubChecked = true;
  const env = process.env;
  if (env.NODE_ENV === "production" || env.TOGETHER_CAPTURE !== "on" || env.ANTHROPIC_API_KEY !== "disabled" || !env.TOGETHER_CAPTURE_STUB) return;
  const { captureModelInstalled, _setCaptureModelForTests } = await import("./capture");
  if (captureModelInstalled()) return;
  const { stubModelFromFile } = await import("./capture-stub");
  _setCaptureModelForTests(stubModelFromFile(env.TOGETHER_CAPTURE_STUB));
  console.log("[together] local replay: live filing answers from the recorded model (no AI)");
}

async function runChunk(s: TogetherSitting, r: Runner, chunk: TogetherChunk, probing: boolean): Promise<boolean> {
  const store = togetherStore();
  await ensureReplayModel();
  const prep = await prepare(s, r, chunk);
  if (!prep) {
    await store.updateChunk(chunk.id, { status: "skipped", doneAt: new Date(deps.now()) });
    return true;
  }
  let output: CaptureOutput | null = null;
  let usage: CaptureUsage | null = null;
  let attempts = chunk.attempts;
  const waits = [...RETRY_WAITS_MS];
  let badTries = 0;
  for (;;) {
    attempts++;
    await store.updateChunk(chunk.id, { status: "running", attempts, startedAt: new Date(deps.now()) });
    const budget = budgetState(r.calls.filter((t) => deps.now() - t < 60 * 60_000).length, r.callsTotal);
    r.state = { ...r.state, throttleMs: budget.throttleMs, held: budget.held };
    try {
      r.calls.push(deps.now());
      r.callsTotal++;
      const res = await runCapture({ system: prep.system, user: prep.user, lines: prep.captureLines, focusItemId: chunk.focusItemId ?? null });
      output = res.output;
      usage = res.usage;
      break;
    } catch (err) {
      const e = err instanceof CaptureError ? err : new CaptureError(String((err as Error)?.message ?? err), "unavailable");
      console.warn(`[together] capture failed (sitting ${s.id}, part ${chunk.chunkNo}, ${e.kind}, attempt ${attempts})`);
      if (e.kind === "bad_output" && badTries === 0) { badTries++; continue; }
      if (e.kind === "bad_output") {
        await store.updateChunk(chunk.id, { status: "failed", error: "bad_output", doneAt: new Date(deps.now()) });
        if (!["refile", "backlog", "focus", "typed"].includes(chunk.reason)) r.reinclude = chunk.seqFrom;
        return true;
      }
      if (e.kind === "unavailable" && !probing && waits.length > 0) { await deps.sleep(waits.shift()!); continue; }
      // The circuit opens: parts wait; a probe tries the oldest every minute.
      await store.updateChunk(chunk.id, { status: "failed", error: e.kind === "credit" ? "credit" : "ai_unavailable" });
      r.circuitOpenAt = r.circuitOpenAt ?? deps.now();
      for (const c of await store.listChunks(s.id)) if (c.status === "queued") await store.updateChunk(c.id, { status: "waiting" });
      await store.mergeCaptureState(s.id, { circuitOpenAt: new Date(r.circuitOpenAt).toISOString(), lastError: e.kind });
      await publishStatus(s.id);
      armProbe(r);
      return false;
    }
  }
  // The AI answered: the circuit closes, waiting parts are queued again.
  if (r.circuitOpenAt !== null) {
    r.circuitOpenAt = null;
    for (const c of await store.listChunks(s.id)) if (c.status === "waiting" || (c.status === "failed" && c.error !== "bad_output" && c.id !== chunk.id)) await store.updateChunk(c.id, { status: "queued" });
    await store.mergeCaptureState(s.id, { circuitOpenAt: null, lastError: null });
  }
  const guarded = guardCaptured(output!, {
    newLines: prep.newLines,
    catalogue: prep.catalogue,
    sellerFacts: prep.inputs.sellerFacts,
    sessionSellerText: prep.sessionSellerText,
    onFileText: onFileTextOf(prep.inputs.sellerFacts),
    keepOut: getSellerKeepOut(prep.inputs.brokerFacts),
  });
  // Saved before the merge: a restart re-applies it without asking the AI again.
  await store.updateChunk(chunk.id, { status: "applying", delta: { guarded, sellerLabel: prep.sellerLabel } as never, usage: usage as never, doneAt: new Date(deps.now()) });
  await finishChunk(s, r, { ...chunk, delta: { guarded, sellerLabel: prep.sellerLabel } } as TogetherChunk, guarded, prep.sellerLabel, prep.catalogue, usage);
  return true;
}

async function applyFromDelta(s: TogetherSitting, chunk: TogetherChunk): Promise<void> {
  const d = chunk.delta as { guarded?: GuardedCapture; sellerLabel?: string } | null;
  if (!d?.guarded) {
    await togetherStore().updateChunk(chunk.id, { status: "queued" });
    return;
  }
  const r = runnerFor(s);
  await finishChunk(s, r, chunk, d.guarded, d.sellerLabel ?? "The owner (seller)", null, null);
}

/** Parts being filed by this process right now (the queue never files one twice at once). */
const applyingNow = new Set<string>();

/** Merge, then the chunk's result, the sitting's bookkeeping and the push. */
async function finishChunk(
  s: TogetherSitting,
  r: Runner,
  chunk: TogetherChunk,
  guarded: GuardedCapture,
  sellerLabel: string,
  catalogue: CaptureCatalogue | null,
  usage: CaptureUsage | null,
): Promise<void> {
  const store = togetherStore();
  if (applyingNow.has(chunk.id)) return;
  applyingNow.add(chunk.id);
  try {
    // (Already filed — a second path reached it: its stored result stands.)
    if ((await store.getChunk(chunk.id))?.status === "done") return;
    let result: ChunkResult;
    try {
      result = await applyCapture({ sitting: s, chunk, guarded, sellerLabel });
    } catch (err) {
      console.error(`[together] filing part ${chunk.chunkNo} of ${s.id} failed:`, (err as Error).message);
      await store.updateChunk(chunk.id, { status: "failed", error: "apply_failed" });
      return;
    }
    const now = new Date(deps.now());
    await store.updateChunk(chunk.id, { status: "done", result: result as never, appliedAt: now, doneAt: now });
    await recordOnSitting(s, chunk, result, guarded, catalogue, usage);
    await publishFiled(s, r, chunk, result);
  } finally {
    applyingNow.delete(chunk.id);
  }
}

async function recordOnSitting(s: TogetherSitting, chunk: TogetherChunk, result: ChunkResult, guarded: GuardedCapture, catalogue: CaptureCatalogue | null, usage: CaptureUsage | null): Promise<void> {
  const fresh = (await togetherStore().getSitting(s.id)) ?? s;
  const st = captureStateOf(fresh);
  const at = new Date(deps.now()).toISOString();
  const labelOf = (itemId: string | null) => (itemId && catalogue?.items.find((i) => i.itemId === itemId)?.label) || "";
  // Held possible answers: the newest per item; ones the item no longer needs drop off the board on read.
  const held: HeldEntry[] = [...(st.held ?? []).filter((h) => !result.suggestions.some((n) => n.itemId === h.itemId)), ...guarded.suggestions.map((h) => ({ ...h, chunkId: chunk.id, at }))].slice(-HELD_MAX);
  const unconfirmed: BrokerUnconfirmedView[] = [
    ...(st.brokerUnconfirmed ?? []),
    ...result.brokerUnconfirmed.filter((b) => b.itemId).map((b) => ({ itemId: b.itemId!, key: b.key, label: labelOf(b.itemId), value: b.value, quote: b.quote, chunkId: chunk.id, at })),
  ].slice(-UNCONFIRMED_MAX);
  const u = st.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, modelMs: 0 };
  const usageNext = usage ? { input: u.input + usage.input, output: u.output + usage.output, cacheRead: u.cacheRead + usage.cacheRead, cacheWrite: u.cacheWrite + usage.cacheWrite, calls: u.calls + 1, modelMs: u.modelMs + usage.ms } : u;
  const r = runners.get(s.id);
  const budget = r ? budgetState(r.calls.filter((t) => deps.now() - t < 60 * 60_000).length, r.callsTotal) : { throttleMs: 0, held: false };
  const hints: CaptureHints = {
    followUp: result.followUp ? { ...result.followUp, at: deps.now() } : st.hints?.followUp ?? null,
    topicSections: result.topicSections.length > 0 ? result.topicSections : st.hints?.topicSections ?? [],
  };
  // Latency: from the part's last line to now; and how long it waited before its call started.
  const last = (await togetherStore().linesBetween(s.id, chunk.seqTo, chunk.seqTo))[0];
  const fresh2 = await togetherStore().getChunk(chunk.id);
  const latency = last ? Math.max(0, deps.now() - new Date(last.at).getTime()) : 0;
  const waited = fresh2?.startedAt ? Math.max(0, new Date(fresh2.startedAt).getTime() - new Date(fresh2.createdAt).getTime()) : 0;
  await togetherStore().mergeCaptureState(s.id, {
    chunksDone: (st.chunksDone ?? 0) + 1,
    held,
    brokerUnconfirmed: unconfirmed,
    usage: usageNext,
    hints,
    longSession: budget.throttleMs > 0 || budget.held,
    liveHeld: budget.held,
    ...(result.filed.length > 0 ? { lastFiled: { at, count: result.filed.filter((f) => !f.undoneAt).length, chunkId: chunk.id } } : {}),
    timing: [...(st.timing ?? []), { ms: latency, waited, reason: chunk.reason }].slice(-200),
  });
}

/** After a filing: a diff of the board (or the whole board) to every open tab. */
async function publishFiled(s: TogetherSitting, r: Runner, chunk: TogetherChunk, result: ChunkResult): Promise<void> {
  const fresh = (await togetherStore().getSitting(s.id)) ?? s;
  const deal = await storage.getDeal(s.dealId);
  let diff: BoardDiff | null = null;
  if (deal) {
    const board = await sittingBoardFor(deal, fresh);
    diff = diffBoards(r.lastBoard, board);
    if (!diff) hub.publish(s.id, { type: "board", board });
    r.lastBoard = board;
  }
  const st = captureStateOf(fresh);
  hub.publish(s.id, {
    type: "filed",
    chunkId: chunk.id,
    filedCount: result.filed.length,
    nothing: result.nothing,
    brokerUnconfirmed: (st.brokerUnconfirmed ?? []).filter((b) => b.chunkId === chunk.id),
    hints: st.hints,
    diff,
  });
  await publishStatus(s.id);
}

/** The board as the sitting's tabs get it (its audience; held answers on it). */
export async function sittingBoardFor(deal: Deal, sitting: TogetherSitting): Promise<CoverageBoard> {
  const inputs = await loadCoverageInputs(deal);
  const board = boardFromCoverage(inputs, sitting.sellerSeesScreen ? "screen" : "broker");
  return withHeldAnswers(board, sitting);
}

/**
 * Held possible answers on their items (broker board only — the screen
 * board never carries them): "Possible answer: '…'" with ✓ File it.
 */
export function withHeldAnswers(board: CoverageBoard, sitting: Pick<TogetherSitting, "id" | "captureState" | "status">): CoverageBoard {
  if (board.audience !== "broker" || sitting.status === "ended") return board;
  const held = captureStateOf(sitting).held ?? [];
  if (held.length === 0) return board;
  // (Several possible answers for one item — "busy months" and "quiet months" — show together, from the newest part.)
  const byItem = new Map<string, HeldEntry[]>();
  for (const h of held) byItem.set(h.itemId, [...(byItem.get(h.itemId) ?? []).filter((x) => x.chunkId === h.chunkId), h]);
  return {
    ...board,
    sections: board.sections.map((sec) => ({
      ...sec,
      items: sec.items.map((i): CoverageItem => {
        const hs = byItem.get(i.id);
        if (!hs || hs.length === 0 || i.status === "on_file") return i;
        const h = hs[0];
        const quote = hs.map((x) => x.quote).join(" … ");
        return { ...i, suggestion: { value: hs.map((x) => x.value).join("; "), quote, chunkId: h.chunkId, memberKey: h.memberKey } };
      }),
    })),
  };
}

/** The changes between two boards of one audience with the same items, or null (send the whole board). Pure. */
export function diffBoards(prev: CoverageBoard | null, next: CoverageBoard): BoardDiff | null {
  if (!prev || prev.audience !== next.audience) return null;
  const ids = (b: CoverageBoard) => b.sections.map((s) => `${s.key}:${s.items.map((i) => i.id).join(",")}`).join("|");
  if (ids(prev) !== ids(next)) return null;
  if (JSON.stringify(prev.routed) !== JSON.stringify(next.routed) || JSON.stringify(prev.documents) !== JSON.stringify(next.documents) || JSON.stringify(prev.plan) !== JSON.stringify(next.plan)) return null;
  const prevItems = new Map(prev.sections.flatMap((s) => s.items).map((i) => [i.id, JSON.stringify(i)] as const));
  const items = next.sections.flatMap((s) => s.items).filter((i) => prevItems.get(i.id) !== JSON.stringify(i));
  const sectionCounts: Record<string, unknown> = {};
  for (const s of next.sections) {
    const p = prev.sections.find((x) => x.key === s.key);
    if (!p || JSON.stringify(p.counts) !== JSON.stringify(s.counts) || p.figureQuestions !== s.figureQuestions) sectionCounts[s.key] = { counts: s.counts, figureQuestions: s.figureQuestions };
  }
  return { items, sectionCounts, totals: next.totals, percentCollected: next.percentCollected, quality: next.quality, version: next.version, prevVersion: prev.version };
}

/** The sitting's capture status to every tab (AI down, long session, parts waiting). */
export async function publishStatus(sittingId: string): Promise<void> {
  const s = await togetherStore().getSitting(sittingId);
  if (!s) return;
  const { sittingView } = await import("./sittings");
  hub.publish(sittingId, { type: "sitting", sitting: sittingView(s, { chunks: await togetherStore().listChunks(sittingId) }) });
}

// ─────────────────────────────────────────────────────────────────────────
// Held answers, retries, re-filing
// ─────────────────────────────────────────────────────────────────────────

/**
 * Files held possible answers whose lines are now known to be the seller's
 * (the broker said who's who, or ticked ✓ File it — the lines are then
 * attested). Answers citing the broker's lines become "you said … — the
 * seller didn't confirm". No AI call.
 */
export async function promoteHeldAnswers(sitting: TogetherSitting, opts: { only?: { itemId: string; chunkId: string } } = {}): Promise<{ filed: number }> {
  const store = togetherStore();
  const s = (await store.getSitting(sitting.id)) ?? sitting;
  const st = captureStateOf(s);
  const held = (st.held ?? []).filter((h) => !opts.only || (h.itemId === opts.only.itemId && h.chunkId === opts.only.chunkId));
  if (held.length === 0) return { filed: 0 };
  const speakers = (s.speakers ?? {}) as SpeakerMap;
  const allSeqs = Array.from(new Set(held.flatMap((h) => h.lines)));
  const lines = new Map<number, TogetherLine>();
  for (const seq of allSeqs) for (const l of await store.linesBetween(s.id, seq, seq)) lines.set(l.seq, l);
  const roleOf = (seq: number) => {
    const l = lines.get(seq);
    return l ? lineRole(speakers, { speaker: l.speaker, attested: !!l.attestedSellerAt }) : "unknown";
  };
  const split = promoteHeld(held, roleOf);
  const deal = await storage.getDeal(s.dealId);
  if (!deal) return { filed: 0 };
  let filed = 0;
  if (split.file.length > 0) {
    const inputs = await loadCoverageInputs(deal);
    const catalogue = catalogueFromBoard(boardFromCoverage(inputs, "screen"));
    const newLines: GuardLine[] = Array.from(new Set(split.file.flatMap((h) => h.lines))).map((seq) => {
      const l = lines.get(seq)!;
      return { seq, role: roleOf(seq), typed: l.source === "typed", text: l.text };
    });
    const output: CaptureOutput = {
      answers: split.file.map((h) => ({ key: h.memberKey, value: h.value, quote: h.quote, lines: h.lines, speaker: "seller", confidence: h.confidence, basis: "verbatim" })),
      notKnown: [], brokerUnconfirmed: [], private: [], withdrawn: [], otherFacts: [], followUp: null, topicSections: [],
    };
    const guarded = guardCaptured(output, { newLines, catalogue, sellerFacts: inputs.sellerFacts, keepOut: getSellerKeepOut(inputs.brokerFacts), onFileText: onFileTextOf(inputs.sellerFacts) });
    const first = Math.min(...newLines.map((l) => l.seq));
    const last = Math.max(...newLines.map((l) => l.seq));
    // (Inserted as "held" — the queue never picks it up — then filed here at once; a restart
    // before that leaves a held part with its saved delta, which recovery files.)
    const chunk = await store.insertChunk({ sittingId: s.id, dealId: s.dealId, seqFrom: first, seqTo: last, reason: "promote", status: "held", attempts: 0, createdAt: new Date(deps.now()), delta: { guarded, sellerLabel: `${Object.values(speakers).find((x) => x.role === "seller" && x.name)?.name || "The owner"} (seller)` } as never });
    const r = runnerFor(s);
    await store.updateChunk(chunk.id, { status: "applying" });
    await finishChunk(s, r, { ...chunk, status: "applying" }, guarded, (chunk.delta as { sellerLabel: string }).sellerLabel, catalogue, null);
    filed = guarded.spoken.length;
  }
  const done = new Set([...split.file, ...split.brokerUnconfirmed]);
  const after = (await store.getSitting(s.id)) ?? s;
  const keep = (captureStateOf(after).held ?? []).filter((h) => !Array.from(done).some((d) => d.itemId === h.itemId && d.quote === h.quote));
  const unconfirmed = [
    ...(captureStateOf(after).brokerUnconfirmed ?? []),
    ...split.brokerUnconfirmed.map((h) => ({ itemId: h.itemId, key: h.memberKey, label: "", value: h.value, quote: h.quote, chunkId: (h as HeldEntry).chunkId, at: new Date(deps.now()).toISOString() })),
  ].slice(-UNCONFIRMED_MAX);
  await store.mergeCaptureState(s.id, { held: keep, brokerUnconfirmed: unconfirmed });
  if (filed === 0) {
    const r = runnerFor(s);
    const d2 = await storage.getDeal(s.dealId);
    if (d2) {
      const board = await sittingBoardFor(d2, (await store.getSitting(s.id)) ?? s);
      r.lastBoard = board;
      hub.publish(s.id, { type: "board", board });
    }
  }
  return { filed };
}

/** "Try now" / "Try again": waiting and failed parts are tried again at once (in order). */
export async function retryNow(sitting: TogetherSitting): Promise<{ queued: number }> {
  if (!filingOn(sitting)) throw new BoardActionError("Live filing isn't running here.", 409, "no_capture");
  const store = togetherStore();
  let queued = 0;
  for (const c of await store.listChunks(sitting.id)) {
    if (c.status === "waiting" || (c.status === "failed" && c.error !== "bad_output")) {
      await store.updateChunk(c.id, { status: "queued", error: null });
      queued++;
    }
  }
  const r = runnerFor(sitting);
  r.circuitOpenAt = null;
  if (r.waitTimer) { deps.clearTimer(r.waitTimer); r.waitTimer = null; }
  await store.mergeCaptureState(sitting.id, { circuitOpenAt: null, lastError: null });
  await publishStatus(sitting.id);
  void kick(sitting.id);
  return { queued };
}

/**
 * "Re-file the last 10 minutes" (wrong speakers discovered late; costs AI):
 * that range's filings still current are undone, and the range is read
 * again with the corrected speakers.
 */
export async function refile(sitting: TogetherSitting, minutes: number): Promise<{ undone: number; chunkId: string | null }> {
  if (!filingOn(sitting)) throw new BoardActionError("Live filing isn't running here.", 409, "no_capture");
  const store = togetherStore();
  const since = deps.now() - Math.max(1, Math.min(30, minutes)) * 60_000;
  const lines = (await store.lastLines(sitting.id, 400)).filter((l) => new Date(l.at).getTime() >= since);
  if (lines.length === 0) return { undone: 0, chunkId: null };
  const from = lines[0].seq;
  const to = lines[lines.length - 1].seq;
  const { undoCapture } = await import("./capture-apply");
  let undone = 0;
  for (const c of await store.listChunks(sitting.id)) {
    if (c.status !== "done" || c.seqTo < from) continue;
    const res = c.result as ChunkResult | null;
    for (const f of res?.filed ?? []) {
      if (f.undoneAt) continue;
      try {
        const fresh = (await store.getChunk(c.id)) ?? c;
        await undoCapture({ sitting, chunk: fresh, key: f.key });
        undone++;
      } catch { /* changed since — it stays */ }
    }
  }
  const r = runnerFor(sitting);
  const ids = await createChunks(sitting, r, { fromSeq: from, toSeq: to, reason: "refile" as ChunkReason });
  void kick(sitting.id);
  return { undone, chunkId: ids[0] ?? null };
}

/**
 * The transcript row was deleted (onTogetherSourceDeleted): filing stops for
 * good; the runner goes.
 */
export function stopFiling(sittingId: string): void {
  stopRunner(sittingId);
}

/** Counts for the sitting's view: parts waiting, parts that couldn't be filed after a day. */
export function chunkCounts(chunks: TogetherChunk[], now = Date.now()): { waiting: number; failed: number } {
  let waiting = 0;
  let failed = 0;
  for (const c of chunks) {
    if (c.status === "waiting" || (c.status === "failed" && c.error !== "bad_output" && c.error !== "apply_failed" && now - new Date(c.createdAt).getTime() < 24 * 60 * 60_000)) waiting++;
    else if (c.status === "failed" && c.error !== "bad_output") failed++;
  }
  return { waiting, failed };
}

export const CAPTURE_LIMITS = TOGETHER_LIMITS;
