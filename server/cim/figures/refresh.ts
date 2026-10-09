/**
 * refresh — the deterministic pass over a deal's figures ($0, no AI; spec
 * §9.1): registry → locate any figure not yet located in its document's text
 * (D11) → checks → the worked-out notes (D6/D7) → (pass 2: question
 * planning) → stamp the refresh. Runs under the per-deal figure lock.
 *
 * Machine writes never overwrite the broker's work (store.ts upsertMachineNote).
 * A worked-out note that no longer applies is removed only while it is still
 * an untouched suggestion.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { cimSections, documents } from "@shared/schema";
import { anchorFigures } from "@shared/figure-anchors";
import { computedNotes } from "./computed";
import { buildChecks } from "./checks";
import { locateValues } from "./locate";
import { assembleFigureRaw, invalidateFigureRaw, loadFigureRaw, type FigureRaw } from "./serve";
import { listNotes, mergeLocated, removeMachineNote, setRefreshed, upsertMachineNote, withFigureLock, type FigureDb } from "./store";

let appDb: FigureDb | null = null;
async function dbOf(d?: FigureDb): Promise<FigureDb> {
  if (d) return d;
  if (!appDb) appDb = (await import("../../db")).db;
  return appDb;
}
function rowsOf(r: unknown): any[] {
  if (Array.isArray(r)) return r;
  const rows = (r as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? rows : [];
}

/** What a refresh depends on: facts, documents, analyses, sections and the broker's decisions. */
export async function refreshFingerprint(dealId: string, d?: FigureDb): Promise<string> {
  const db = await dbOf(d);
  const rows = rowsOf(await db.execute(sql`
    SELECT
      (SELECT updated_at::text FROM deals WHERE id = ${dealId}) AS deal_at,
      (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM documents WHERE deal_id = ${dealId}) AS docs,
      (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM financial_analyses WHERE deal_id = ${dealId}) AS analyses,
      (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM cim_sections WHERE deal_id = ${dealId}) AS sections,
      (SELECT count(*)::text || ':' || coalesce(max(decided_at)::text, '') FROM dd_check_decisions WHERE deal_id = ${dealId}) AS decisions`));
  const r = rows[0] ?? {};
  return createHash("sha256").update([r.deal_at, r.docs, r.analyses, r.sections, r.decisions].map((x) => x ?? "-").join("|")).digest("hex").slice(0, 24);
}

export interface RefreshResult {
  located: number;
  written: number;
  proposals: number;
  removed: number;
  fingerprint: string;
}

/** The pure part: what to locate, then the worked-out notes. Shared with the tests. */
export function refreshPlan(raw: FigureRaw, sections: Array<{ id: string; layoutType: string; layoutData: unknown }>) {
  const anchoredKeys = new Set(sections.flatMap((s) => anchorFigures(s, raw.registry)).map((a) => a.figureKey));
  return { anchoredKeys, toLocate: buildChecks({ registry: raw.registry, sources: raw.sources, located: (raw.state?.located ?? {}) as any, decisions: [], figureKeys: anchoredKeys }).toLocate };
}

const running = new Map<string, Promise<RefreshResult>>();

/** Run the refresh now (deduplicated: a refresh already running for the deal is joined). */
export function runFigureRefresh(dealId: string, d?: FigureDb): Promise<RefreshResult> {
  const live = running.get(dealId);
  if (live) return live;
  const p = withFigureLock(dealId, () => doRefresh(dealId, d))
    .then(async (r) => {
      if (!d) await planAfterRefresh(dealId);
      return r;
    })
    .finally(() => running.delete(dealId));
  running.set(dealId, p);
  return p;
}

async function doRefresh(dealId: string, d?: FigureDb): Promise<RefreshResult> {
  const db = await dbOf(d);
  const fingerprint = await refreshFingerprint(dealId, d);
  invalidateFigureRaw(dealId);
  let raw = await loadFigureRaw(dealId, d);
  const sections = await db.select({ id: cimSections.id, layoutType: cimSections.layoutType, layoutData: cimSections.layoutData })
    .from(cimSections).where(and(eq(cimSections.dealId, dealId)));
  const plan = refreshPlan(raw, sections);

  // D11: locate what isn't located yet (reads the text of those documents only).
  let locatedCount = 0;
  const known = (raw.state?.located ?? {}) as Record<string, any>;
  const docIds = Array.from(new Set(plan.toLocate.map((t) => t.documentId)));
  if (docIds.length > 0) {
    const texts = await db.select({ id: documents.id, extractedText: documents.extractedText })
      .from(documents).where(and(eq(documents.dealId, dealId), inArray(documents.id, docIds)));
    const byId = new Map<string, string | null>(texts.map((t: { id: string; extractedText: string | null }) => [t.id, t.extractedText]));
    const found = locateValues(plan.toLocate, (id) => byId.get(id) ?? null, known);
    locatedCount = Object.keys(found).length;
    if (locatedCount > 0) {
      await mergeLocated(dealId, found, d);
      invalidateFigureRaw(dealId);
      raw = await loadFigureRaw(dealId, d);
    }
  }

  // D6 / D7: the worked-out notes for the figures the CIM shows.
  const produced = computedNotes({ registry: raw.registry, checks: raw.checks.checks, anchoredKeys: plan.anchoredKeys });
  const existing = await listNotes(dealId, d);
  const keyOf = (n: { figureKey: string; kind: string; compareKey: string }) => `${n.figureKey}|${n.kind}|${n.compareKey}`;
  const byKey = new Map(existing.map((n) => [keyOf(n), n]));
  let written = 0, proposals = 0, removed = 0;
  for (const note of produced) {
    const row = byKey.get(keyOf(note));
    if (row && row.inputFingerprint === note.inputFingerprint && row.text === note.text) continue;
    if (row && row.proposal?.inputFingerprint === note.inputFingerprint) continue;
    const r = await upsertMachineNote(dealId, note, row?.inputFingerprint ?? null, d);
    if (r === "written") written++;
    else proposals++;
  }
  const producedKeys = new Set(produced.map(keyOf));
  for (const row of existing) {
    if (row.origin !== "computed" || row.status !== "suggested" || row.editedAt || producedKeys.has(keyOf(row))) continue;
    if (await removeMachineNote(dealId, row.id, row.inputFingerprint, d)) removed++;
  }

  await setRefreshed(dealId, fingerprint, d);
  invalidateFigureRaw(dealId);
  return { located: locatedCount, written, proposals, removed, fingerprint };
}

/** After a refresh (outside the lock): the questions for the seller follow the new checks and notes. Never throws. */
async function planAfterRefresh(dealId: string): Promise<void> {
  if (!planHook) return;
  await planHook(dealId).catch(() => {});
}

/** The planner (requests.ts) — injected so the refresh's own tests run without it. */
let planHook: ((dealId: string) => Promise<unknown>) | null = (dealId) => import("./requests").then((m) => m.planExplainQuestions(dealId));
export function _setRefreshPlanHookForTests(fn: ((dealId: string) => Promise<unknown>) | null): void {
  planHook = fn;
}

/**
 * A document was added, changed, deleted or changed visibility: drop the
 * cached inputs now (a buyer is never served a citation to a document that
 * just went private) and refresh soon.
 */
export function invalidateAndRefreshFigures(dealId: string, reason: string): void {
  if (!dealId) return;
  invalidateFigureRaw(dealId);
  scheduleFigureRefresh(dealId, reason);
}

// ── Scheduling (debounced; never blocks the caller) ────────────────────────

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const REFRESH_DEBOUNCE_MS = 5_000;

/** Refresh the deal's figures soon (5 s debounce). Errors are logged, never thrown. */
export function scheduleFigureRefresh(dealId: string, reason: string): void {
  if (!dealId) return;
  const prev = timers.get(dealId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(dealId);
    runFigureRefresh(dealId).catch((err) => console.warn(`[figures] refresh (${reason}) failed for deal ${dealId}:`, (err as Error)?.message));
  }, REFRESH_DEBOUNCE_MS);
  (t as { unref?: () => void }).unref?.();
  timers.set(dealId, t);
}

export { assembleFigureRaw };
