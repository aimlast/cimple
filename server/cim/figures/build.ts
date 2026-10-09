/**
 * build — the AI pass over a deal's figures (spec D8, D19, §9.6).
 *
 *   scheduleFigureBuild(dealId, reason)  debounced 10 minutes (the broker's
 *                                        "Check the numbers again" runs now)
 *   runFigureBuild(dealId, opts)         refresh ($0) → candidates → evidence →
 *                                        model call(s) OUTSIDE the lock →
 *                                        guards → write phase UNDER the lock
 *
 * Cost control: ≤ 16 candidates a build, ≤ 10 a call, ≤ 2 calls; the
 * per-deal cap of 4 AI calls a UTC day is charged atomically in SQL before
 * every call (the keep-out review counts when it has to run). Only
 * candidates whose inputs changed are sent (scope "changed").
 *
 * Writes never race (D24): a note the broker changed while the model was
 * reading keeps the broker's version ("skippedBecauseEdited"); every new
 * note starts suggested. An API failure changes nothing — the notes on file
 * stay — and the build records why. A restart mid-run reads as
 * "interrupted" (effectiveBuild).
 */
import type { FigureBuildStatus } from "@shared/schema";
import { anchorFigures } from "@shared/figure-anchors";
import { FIGURE_LINES } from "@shared/figure-lines";
import { blindLeakTerms } from "@shared/blind-guard";
import { describeAiFailure } from "../../ai-retry";
import { aiCandidates, type FigureCandidate } from "./candidates";
import { fingerprintOf } from "./computed";
import { loadFigureEvidence, type EvidenceRef, type FigureEvidence } from "./evidence";
import { assertFigureAiAvailable, writeFigureNotes } from "./ai";
import { guardFigureNote, screenCtxFor, type FigureGuardCtx } from "./guards";
import { invalidateFigureRaw, loadFigureRaw, type FigureRaw } from "./serve";
import { runFigureRefresh } from "./refresh";
import { chargeFigureBudget, getFigureState, listNotes, setBuild, setKeepOut, upsertMachineNote, withFigureLock, FIGURE_AI_DAILY_CAP, type MachineNote } from "./store";
import type { FigureNoteSource } from "@shared/schema";

export type BuildReason = "cim_generated" | "dd_generated" | "broker" | "interview_answers";

const running = new Map<string, Promise<FigureBuildStatus>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
export const BUILD_DEBOUNCE_MS = 10 * 60 * 1000;
const MAX_CANDIDATES = 16;
const PER_CALL = 10;
const MAX_CALLS = 2;

/** The UTC day the budget is counted on. */
export function budgetDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Is a build running in this process for the deal? */
export function figureBuildRunning(dealId: string): boolean {
  return running.has(dealId);
}

/** The build status as the workspace shows it: a "running" row no process is running = interrupted (a restart). */
export function effectiveBuild(build: FigureBuildStatus | null | undefined, runningHere: boolean): FigureBuildStatus | null {
  if (!build) return null;
  if (build.status === "running" && !runningHere) return { ...build, status: "failed", error: "interrupted" };
  return build;
}

/** Has today's budget run out (before starting a build)? */
export function dailyLimitReached(state: { budgetDay?: string | null; budgetCalls?: number | null } | null | undefined, now = new Date()): boolean {
  return !!state && state.budgetDay === budgetDay(now) && (state.budgetCalls ?? 0) >= FIGURE_AI_DAILY_CAP;
}

/** Build soon (10-minute debounce). Errors are logged, never thrown. */
export function scheduleFigureBuild(dealId: string, reason: BuildReason): void {
  if (!dealId) return;
  if (process.env.ANTHROPIC_API_KEY === "disabled" && !testBuildHook) return;
  const prev = timers.get(dealId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(dealId);
    if (running.has(dealId)) return;
    runFigureBuild(dealId, { reason }).catch((err) => console.warn(`[figures] build (${reason}) failed for deal ${dealId}:`, (err as Error)?.message));
  }, BUILD_DEBOUNCE_MS);
  (t as { unref?: () => void }).unref?.();
  timers.set(dealId, t);
}

let testBuildHook: boolean = false;
/** Tests: let scheduleFigureBuild arm its timer even with the key disabled. */
export function _allowScheduledBuildsForTests(on: boolean): void {
  testBuildHook = on;
}
/** Tests / shutdown: the deals with a build waiting. */
export function _pendingBuilds(): string[] {
  return Array.from(timers.keys());
}
export function _cancelPendingBuilds(): void {
  for (const t of Array.from(timers.values())) clearTimeout(t);
  timers.clear();
}

/** Start a build now unless one runs; returns the running one's promise either way. */
export function startFigureBuild(dealId: string, opts: { reason: BuildReason; scope?: "changed" | "all"; by?: string }): { started: boolean; done: Promise<FigureBuildStatus> } {
  const live = running.get(dealId);
  if (live) return { started: false, done: live };
  const pending = timers.get(dealId);
  if (pending) {
    clearTimeout(pending);
    timers.delete(dealId);
  }
  return { started: true, done: runFigureBuild(dealId, opts) };
}

export function runFigureBuild(dealId: string, opts: { reason: BuildReason; scope?: "changed" | "all" }): Promise<FigureBuildStatus> {
  const live = running.get(dealId);
  if (live) return live;
  const p = doBuild(dealId, opts).finally(() => running.delete(dealId));
  running.set(dealId, p);
  return p;
}

/** A source the note rests on, from an evidence ref (quotes kept ≤ 240 characters). */
export function noteSourceOf(ref: EvidenceRef, quote: string): FigureNoteSource {
  const q = quote.slice(0, 240);
  switch (ref.kind) {
    case "document":
      return { kind: "document", documentId: ref.meta.documentId, page: ref.meta.page ?? null, quote: q };
    case "transcript":
      return { kind: "transcript", ...(ref.meta.documentId ? { documentId: ref.meta.documentId } : {}), ...(ref.meta.sessionId ? { sessionId: ref.meta.sessionId } : {}), ...(ref.meta.factKey ? { factKey: ref.meta.factKey } : {}), quote: q };
    case "interview":
      return { kind: "interview", sessionId: ref.meta.sessionId, messageIndex: ref.meta.messageIndex, quote: q };
    case "fact":
      return { kind: "fact", factKey: ref.meta.factKey, ...(ref.meta.sessionId ? { sessionId: ref.meta.sessionId } : {}), quote: q };
    case "discrepancy":
      return { kind: "discrepancy", discrepancyId: ref.meta.discrepancyId, quote: q, ...(ref.meta.internal ? { internal: true as const } : {}) };
  }
}

/** The guard context for a deal (no AI). */
export function guardCtxFor(deal: { businessName?: string | null; extractedInfo?: unknown; employeeChart?: unknown; blindCodename?: string | null }, info: Record<string, unknown>, keepOutNames: string[] | null | undefined, lineLabels: string[]): FigureGuardCtx {
  let blindTerms: FigureGuardCtx["blindTerms"] = [];
  try {
    blindTerms = blindLeakTerms(deal as any, { codename: deal.blindCodename || "Confidential Opportunity" });
  } catch {
    blindTerms = [];
  }
  return {
    screen: screenCtxFor(info, keepOutNames ? { names: keepOutNames } : null),
    blindTerms,
    lineLabels,
    blindWords: FIGURE_LINES.map((l) => l.blindWord),
  };
}

/** The keep-out review the build may need (counted against the cap when it must run). Test seam. */
let keepOutSeam: ((dealId: string, info: Record<string, unknown>) => Promise<{ names?: string[]; by?: string }>) | null = null;
export function _setKeepOutReviewForTests(fn: typeof keepOutSeam): void {
  keepOutSeam = fn;
}

async function keepOutNamesFor(dealId: string, info: Record<string, unknown>, stored: { names: string[]; fp?: string } | null, warnings: string[]): Promise<string[]> {
  const { keepOutCandidates, keepOutFor } = await import("../keep-out");
  const candidates = keepOutCandidates(info);
  if (candidates.length === 0) return [];
  if (!keepOutSeam) {
    const { figureAiAvailable } = await import("./ai");
    if (!figureAiAvailable()) return stored?.names ?? [];
  }
  const fp = fingerprintOf(candidates.map((c: any) => [c.kind, c.key ?? "", c.text]));
  if (stored?.fp === fp) return stored.names;
  const charged = await chargeFigureBudget(dealId, budgetDay());
  if (charged === null) {
    warnings.push("The confidentiality review couldn't run today (daily limit); the last review's holds and the plain-wording rules were used.");
    return stored?.names ?? [];
  }
  const r = keepOutSeam ? await keepOutSeam(dealId, info) : await keepOutFor(dealId, info);
  const names = Array.isArray((r as any).names) ? ((r as any).names as string[]) : [];
  await setKeepOut(dealId, { names, at: new Date().toISOString(), by: (r as any).by === "ai" ? "ai" : "rules", fp });
  return names;
}

/** What a build reads (injectable: the tests run the whole pass on an in-process database and fixtures). */
export interface BuildDeps {
  refresh(dealId: string): Promise<unknown>;
  loadDeal(dealId: string): Promise<{ deal: any; sections: Array<{ id: string; layoutType: string; layoutData: unknown }> } | null>;
  loadRaw(dealId: string): Promise<FigureRaw>;
  loadEvidence: typeof loadFigureEvidence;
  plan(dealId: string): Promise<unknown>;
}

const defaultDeps: BuildDeps = {
  refresh: (dealId) => runFigureRefresh(dealId),
  loadDeal: async (dealId) => {
    const { storage } = await import("../../storage");
    const [deal, sections] = await Promise.all([storage.getDeal(dealId), storage.getCimSectionsByDeal(dealId)]);
    return deal ? { deal, sections: sections as any[] } : null;
  },
  loadRaw: async (dealId) => {
    invalidateFigureRaw(dealId);
    return loadFigureRaw(dealId);
  },
  loadEvidence: loadFigureEvidence,
  plan: async (dealId) => {
    const { planExplainQuestions } = await import("./requests");
    return planExplainQuestions(dealId);
  },
};
let deps: BuildDeps = defaultDeps;
/** Tests: replace what the build reads (null restores the defaults). */
export function _setBuildDepsForTests(d: Partial<BuildDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

async function doBuild(dealId: string, opts: { reason: BuildReason; scope?: "changed" | "all" }): Promise<FigureBuildStatus> {
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  const dropped: string[] = [];
  // What the last build remembered (read before "running" replaces it).
  const before = await getFigureState(dealId).catch(() => null);
  const carried = before?.build?.noReason ?? [];
  await setBuild(dealId, { status: "running", startedAt, reason: opts.reason, ...(carried.length ? { noReason: carried } : {}) });
  try {
    await deps.refresh(dealId);
    const [loaded, state] = await Promise.all([deps.loadDeal(dealId), getFigureState(dealId)]);
    if (!loaded) throw new Error("deal not found");
    const { deal, sections } = loaded;
    const raw = await deps.loadRaw(dealId);
    const anchoredKeys = (sections as any[]).flatMap((s) => anchorFigures(s, raw.registry)).map((a) => a.figureKey);
    const previousNoReason = state?.build?.noReason ?? [];

    // Evidence for the possible candidates (before the fingerprint filter: the digest is part of it).
    const pre = aiCandidates({
      registry: raw.registry, anchoredKeys, checks: raw.checks.checks, notes: raw.notes, scope: "all",
      fingerprintFor: (c) => c.valuesFingerprint, max: MAX_CANDIDATES * 2,
    });
    if (pre.length === 0) {
      const done: FigureBuildStatus = { status: "done", startedAt, finishedAt: new Date().toISOString(), written: 0, candidates: 0, reason: opts.reason, noReason: previousNoReason };
      await setBuild(dealId, done);
      await afterBuild(dealId);
      return done;
    }
    const keepOutNames = await keepOutNamesFor(dealId, raw.info, (state?.keepOut as any) ?? null, warnings);
    const lineLabels = Object.values(raw.registry).filter((f) => String(f.line).startsWith("line:")).map((f) => f.lineLabel);
    const ctx = guardCtxFor(deal, raw.info, [...(state?.keepOut?.names ?? []), ...keepOutNames], lineLabels);
    const evidence: FigureEvidence = await deps.loadEvidence(dealId, pre.map((c) => ({ line: c.line, lineLabel: c.lineLabel, year: c.year, fromYear: c.fromYear })), {
      facts: raw.info, screen: ctx.screen, hints: raw.hintSentences,
    });
    const fingerprintFor = (c: FigureCandidate) => fingerprintOf(["ai", c.valuesFingerprint, evidence.digest]);
    const candidates = aiCandidates({
      registry: raw.registry, anchoredKeys, checks: raw.checks.checks, notes: raw.notes, scope: opts.scope ?? "changed",
      noReason: previousNoReason, fingerprintFor, max: MAX_CANDIDATES,
    }).map((c, i) => ({ ...c, id: `C${i + 1}` }));
    if (candidates.length === 0) {
      const done: FigureBuildStatus = { status: "done", startedAt, finishedAt: new Date().toISOString(), written: 0, candidates: 0, reason: opts.reason, noReason: previousNoReason, ...(warnings.length ? { warnings } : {}) };
      await setBuild(dealId, done);
      await afterBuild(dealId);
      return done;
    }
    // Before the lock: one model call per ≤ 10 candidates, each charged first.
    assertFigureAiAvailable();
    const seen = new Map((await listNotes(dealId)).map((n) => [`${n.figureKey}|${n.kind}|${n.compareKey}`, n]));
    const results: Array<{ c: (typeof candidates)[number]; note: Awaited<ReturnType<typeof writeFigureNotes>>[number] | null }> = [];
    let calls = 0;
    let limit = false;
    for (let i = 0; i < candidates.length && calls < MAX_CALLS; i += PER_CALL) {
      const chunk = candidates.slice(i, i + PER_CALL);
      if ((await chargeFigureBudget(dealId, budgetDay())) === null) {
        limit = true;
        break;
      }
      calls++;
      const notes = await writeFigureNotes(chunk, evidence);
      for (const c of chunk) results.push({ c, note: notes.find((n) => n.candidateId === c.id) ?? null });
    }
    if (limit) warnings.push(`Cimple has checked this deal's numbers ${FIGURE_AI_DAILY_CAP} times today; the rest wait until tomorrow.`);

    // Write phase, under the lock: guards, then compare-and-set against what was read before the call.
    const noReason: string[] = [...previousNoReason.filter((k) => !results.some((r) => k.startsWith(`${r.c.key}@`)))];
    let written = 0;
    let skippedBecauseEdited = 0;
    await withFigureLock(dealId, async () => {
      const now = new Map((await listNotes(dealId)).map((n) => [`${n.figureKey}|${n.kind}|${n.compareKey}`, n]));
      for (const { c, note } of results) {
        const guarded = note ? guardFigureNote(note, c, evidence, ctx) : ({ ok: false, why: "no reason on file" } as const);
        if (!guarded.ok) {
          if (note && note.status === "explained") dropped.push(`${c.lineLabel} FY${c.year}: ${guarded.why}`);
          noReason.push(`${c.key}@${c.fingerprint}`);
          continue;
        }
        const before = seen.get(c.key);
        const current = now.get(c.key);
        if (current && (!before || current.updatedAt?.toString() !== before.updatedAt?.toString())) {
          skippedBecauseEdited++;
          continue;
        }
        const machine: MachineNote = {
          figureKey: c.figureKey, kind: c.kind, compareKey: c.compareKey, origin: "ai",
          text: guarded.text, blindText: guarded.blindText,
          sources: guarded.sources.map((s) => noteSourceOf(evidence.refs.get(s.ref)!, s.quote)),
          valuesSnapshot: { year: c.year, value: c.value, ...(c.fromYear ? { fromYear: c.fromYear, fromValue: c.fromValue } : {}), ...(typeof c.other === "number" ? { other: c.other } : {}) },
          inputFingerprint: c.fingerprint,
        };
        const r = await upsertMachineNote(dealId, machine, current?.inputFingerprint ?? null);
        if (r === "written") written++;
        else skippedBecauseEdited++;
      }
    });
    invalidateFigureRaw(dealId);
    const done: FigureBuildStatus = {
      status: "done", startedAt, finishedAt: new Date().toISOString(), written, candidates: candidates.length, reason: opts.reason,
      noReason: noReason.slice(-200),
      ...(skippedBecauseEdited ? { skippedBecauseEdited } : {}),
      ...(dropped.length ? { dropped: dropped.slice(0, 20) } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(limit && written === 0 && results.length === 0 ? { error: "daily_limit" } : {}),
    };
    await setBuild(dealId, done);
    await afterBuild(dealId);
    return done;
  } catch (err) {
    const f = describeAiFailure(err);
    const failed: FigureBuildStatus = { status: "failed", startedAt, finishedAt: new Date().toISOString(), error: `${f.reason}; ${f.advice}`, reason: opts.reason, ...(carried.length ? { noReason: carried } : {}), ...(warnings.length ? { warnings } : {}) };
    console.warn(`[figures] build failed for deal ${dealId}:`, (err as Error)?.message);
    await setBuild(dealId, failed).catch(() => {});
    invalidateFigureRaw(dealId);
    return failed;
  }
}

/** After a build: candidates the AI found nothing for become questions for the seller. */
async function afterBuild(dealId: string): Promise<void> {
  await deps.plan(dealId);
}
