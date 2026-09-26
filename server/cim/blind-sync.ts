/**
 * blind-sync — keeps each section's Blind CIM version in step with its content.
 *
 * The Blind CIM is served from per-section overrides (AI-redacted copies).
 * Before the CIM builder, a section with no override was served un-redacted
 * (title-only redaction) and an edited section kept serving its old override.
 * Now:
 *   - Every content change (create, duplicate, edit, rewrite, convert,
 *     regenerate) calls markSectionsBlindStale(): the section's blind
 *     override is dropped and `blindStaleAt` is stamped; its DD override is
 *     kept but stamped stale (`ddStaleAt`).
 *   - The view room serves a section in blind mode ONLY when it has an
 *     override and `blindStaleAt` is null; anything else is held back and
 *     triggers scheduleBlindRefresh().
 *   - The refresh re-redacts just the stale sections under the deal's
 *     EXISTING codename. A result is committed only if the section has not
 *     changed again since the run started (conditional on blindStaleAt), so
 *     a slow run can never mark newer content as redacted.
 *
 * All blind work for one deal runs one-at-a-time (runExclusive) so a full
 * regeneration and a per-section refresh can't interleave their writes.
 * A codename rename doesn't wait for a run: each commit re-reads the name
 * under the codename lock and writes the section under the current one.
 *
 * A section the view room keeps rejecting (its redaction passes but what a
 * buyer would get still names something, or keeps a placeholder) is not
 * re-sent to the AI forever: after LEAK_REDO_LIMIT redos it is held back
 * with the reason shown to the broker, until they edit it, click "Redo
 * blind version" or Retry (2026-09-26 — Pacific's map was re-redacted on
 * every buyer visit and never served).
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { cimSections, cimSectionOverrides, type CimSection, type CimSectionAiTask } from "@shared/schema";
import { getCimLayout } from "@shared/cim-layouts";
import { carryCodename, currentCodename, ensureDealCodename, withCodenameLock } from "./codenames";
import { generateBlindOverrides, redactOneSection, redactionErrorMessage, type RedactionResult } from "./redaction-engine";

// ── Per-deal serial queue ────────────────────────────────────────────────
const chains = new Map<string, Promise<unknown>>();

function runExclusive<T>(dealId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(dealId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  chains.set(dealId, tail);
  tail.then(() => { if (chains.get(dealId) === tail) chains.delete(dealId); });
  return next;
}

// ── State reported to the builder ────────────────────────────────────────
/**
 * `lastError` is for failures of a whole run (an exception, or a full
 * generation that redacted nothing). A failed SECTION is not recorded here:
 * it lives in `sectionBackoff` until that section is actually redacted (or
 * edited), so a later run that succeeds for other sections can't make a
 * held-back section look like it is merely "updating".
 */
interface DealBlindState {
  running: boolean;
  lastError?: string;
  lastErrorAt?: number;
}
const state = new Map<string, DealBlindState>();
/**
 * Sections whose last redaction failed → not retried until `until`. The wait
 * grows with each consecutive failure (1 min → 5 → 30 → 2 h) so a section
 * that keeps failing isn't re-sent to the AI on every buyer visit.
 */
interface SectionFailure {
  dealId: string;
  until: number;
  failures: number;
  error: string;
}
const sectionBackoff = new Map<string, SectionFailure>();
const BACKOFF_STEPS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
/** A whole-CIM run that redacted nothing → the view room waits before trying again. */
const fullBackoff = new Map<string, number>();
const debounceTimers = new Map<string, NodeJS.Timeout>();
/** View-room rejections per section since its content last changed. */
const leakRedos = new Map<string, number>();
export const LEAK_REDO_LIMIT = 3;
/** How long a section that keeps failing the view-room check stays held before the next automatic try. */
const LEAK_HOLD_MS = 24 * 60 * 60_000;

function recordSectionFailure(dealId: string, sectionId: string, error: string): void {
  const prev = sectionBackoff.get(sectionId);
  const failures = (prev?.failures ?? 0) + 1;
  const wait = BACKOFF_STEPS_MS[Math.min(failures, BACKOFF_STEPS_MS.length) - 1];
  sectionBackoff.set(sectionId, { dealId, until: Date.now() + wait, failures, error });
}

export function blindRefreshState(dealId: string): DealBlindState {
  return state.get(dealId) ?? { running: false };
}

/**
 * Why this section's blind version is held back (its last redaction failed),
 * if it is. Stays set until a redaction of it succeeds, the section is
 * edited, or the broker clicks Retry — however other sections fare meanwhile.
 */
export function blindSectionError(sectionId: string): string | null {
  return sectionBackoff.get(sectionId)?.error ?? null;
}

/**
 * The builder's blind summary from its section rows: held-back sections are
 * reported apart from ones merely waiting for their redaction, and the error
 * names the held ones for as long as any remain.
 */
export function summarizeBlindRows(
  dealId: string,
  rows: Array<{ blindStatus: string; blindError?: string | null }>,
): { running: boolean; error: string | null; updating: number; held: number } {
  const st = blindRefreshState(dealId);
  const held = rows.filter((r) => r.blindStatus === "held");
  const updating = rows.filter((r) => r.blindStatus === "updating").length;
  const error = held.length > 0
    ? `Couldn't make the blind version of ${held.length} section${held.length === 1 ? "" : "s"}: ${held[0].blindError || "the redaction failed"}`
    : st.lastError ?? null;
  return { running: st.running, error, updating, held: held.length };
}

/** True while a background AI write is filling this section (not buyer-ready). */
export function isBeingWritten(section: Pick<CimSection, "aiTask">): boolean {
  const task = section.aiTask as CimSectionAiTask | null | undefined;
  return !!task && task.kind === "write" && task.status !== "ready";
}

/**
 * Content of these sections changed: drop their blind overrides and stamp
 * them stale. Their DD versions are KEPT but stamped stale too (ddStaleAt):
 * a DD buyer is served the current named content for them until the broker
 * refreshes the DD version (dd-enrichment refreshSectionDd) — an edit used
 * to delete the DD version silently. Call BEFORE scheduleBlindRefresh().
 * Returns the stamp.
 */
export async function markSectionsBlindStale(sectionIds: string[]): Promise<Date> {
  const now = new Date();
  if (sectionIds.length === 0) return now;
  await db.update(cimSections).set({ blindStaleAt: now, ddStaleAt: now }).where(inArray(cimSections.id, sectionIds));
  await db.delete(cimSectionOverrides).where(and(
    inArray(cimSectionOverrides.cimSectionId, sectionIds),
    eq(cimSectionOverrides.mode, "blind"),
  ));
  for (const id of sectionIds) {
    sectionBackoff.delete(id);
    leakRedos.delete(id);
  }
  return now;
}

/**
 * Commit one section's redaction — only if the section is still at the
 * revision the redaction was made from. Returns false when it moved on.
 * `codename` is the name the redaction was written under: if the broker
 * renamed the deal while it ran, the result is carried over to the new
 * name first (under the codename lock, so a rename can't slip in between).
 */
function commitOverride(section: CimSection, result: RedactionResult, codename: string): Promise<boolean> {
  return withCodenameLock(section.dealId, async () =>
    commitUnlocked(section, carryCodename(result, codename, await currentCodename(section.dealId))),
  );
}

async function commitUnlocked(section: CimSection, result: RedactionResult): Promise<boolean> {
  const stale = section.blindStaleAt ? new Date(section.blindStaleAt) : null;
  const updated = await db
    .update(cimSections)
    .set({ blindStaleAt: null, blindTitle: result.sectionTitle || null })
    .where(and(
      eq(cimSections.id, section.id),
      stale ? eq(cimSections.blindStaleAt, stale) : isNull(cimSections.blindStaleAt),
    ))
    .returning({ id: cimSections.id });
  if (updated.length === 0) return false;
  await db.delete(cimSectionOverrides).where(and(
    eq(cimSectionOverrides.cimSectionId, section.id),
    eq(cimSectionOverrides.mode, "blind"),
  ));
  await db.insert(cimSectionOverrides).values({
    dealId: section.dealId,
    cimSectionId: section.id,
    mode: "blind",
    layoutData: result.layoutData,
    contentOverride: result.contentOverride,
  });
  return true;
}

/** Does this deal have a Blind CIM at all (any blind override)? */
async function hasBlindVersion(dealId: string): Promise<boolean> {
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(cimSectionOverrides)
    .where(and(eq(cimSectionOverrides.dealId, dealId), eq(cimSectionOverrides.mode, "blind")));
  return (r[0]?.n ?? 0) > 0;
}

/** Sections that need a (re)redaction: stale, or missing an override. */
function needsRedaction(sections: CimSection[], overrideIds: Set<string>): CimSection[] {
  const now = Date.now();
  return sections.filter((s) => {
    if (isBeingWritten(s)) return false;
    if (getCimLayout(s.layoutType)?.blind === "exclude") return false;
    if ((sectionBackoff.get(s.id)?.until ?? 0) > now) return false;
    return !!s.blindStaleAt || !overrideIds.has(s.id);
  });
}

async function refreshStaleSections(dealId: string): Promise<void> {
  const deal = await storage.getDeal(dealId);
  if (!deal) return;
  // No Blind CIM yet → nothing to keep in step. The first blind viewer (or
  // the broker's "Generate Blind") builds the whole version at once.
  if (!(await hasBlindVersion(dealId))) return;

  const [sections, overrides] = await Promise.all([
    storage.getCimSectionsByDeal(dealId),
    storage.getCimSectionOverrides(dealId, "blind"),
  ]);
  const todo = needsRedaction(sections, new Set(overrides.map((o) => o.cimSectionId)));
  if (todo.length === 0) return;

  const st: DealBlindState = { running: true };
  state.set(dealId, st);
  const codename = await ensureDealCodename(deal);
  let failures = 0;
  let lastError: string | undefined;
  for (let i = 0; i < todo.length; i += 3) {
    const batch = todo.slice(i, i + 3);
    const results = await Promise.allSettled(batch.map((s) => redactOneSection(s, deal as any, codename)));
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        if (await commitOverride(batch[j], r.value, codename)) sectionBackoff.delete(batch[j].id);
      } else {
        // Fail closed: no override is written, so the section stays held
        // back from blind buyers until a redaction succeeds.
        failures++;
        lastError = redactionErrorMessage(r.reason);
        recordSectionFailure(dealId, batch[j].id, lastError);
        console.error(`[blind-sync] redaction failed for section ${batch[j].id}:`, (r.reason as Error)?.message ?? r.reason);
      }
    }
  }
  // Failed sections stay reported as held back through sectionBackoff.
  state.set(dealId, { running: false });
  if (lastError) console.warn(`[blind-sync] deal ${dealId}: ${failures} section(s) held back — ${lastError}`);
  console.log(`[blind-sync] deal ${dealId}: re-redacted ${todo.length - failures}/${todo.length} section(s) under ${codename}`);
}

/**
 * Re-redact this deal's stale sections soon (debounced — a burst of edits
 * becomes one run). Safe to call from request handlers; never throws.
 */
export function scheduleBlindRefresh(dealId: string, delayMs = 1500): void {
  const existing = debounceTimers.get(dealId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(dealId);
    runExclusive(dealId, () => refreshStaleSections(dealId)).catch((err) => {
      console.error(`[blind-sync] refresh failed for deal ${dealId}:`, err);
      state.set(dealId, { running: false, lastError: err?.message || "Blind refresh failed", lastErrorAt: Date.now() });
    });
  }, delayMs);
  timer.unref?.();
  debounceTimers.set(dealId, timer);
}

/** Drop just these sections' blind overrides and mark them stale (DD untouched). */
async function dropBlindOverrides(sectionIds: string[]): Promise<void> {
  if (sectionIds.length === 0) return;
  await db.update(cimSections).set({ blindStaleAt: new Date() }).where(inArray(cimSections.id, sectionIds));
  await db.delete(cimSectionOverrides).where(and(
    inArray(cimSectionOverrides.cimSectionId, sectionIds),
    eq(cimSectionOverrides.mode, "blind"),
  ));
}

/**
 * These sections' blind versions still name something identifying, or keep
 * a placeholder (found by the view room's final check): drop just their
 * blind overrides, mark them stale and redo them. Their DD versions are
 * untouched. A section rejected LEAK_REDO_LIMIT times is held back with
 * the reason instead of being redone again.
 */
export async function redoLeakedBlind(dealId: string, sectionIds: string[], reasons: Record<string, string> = {}): Promise<void> {
  if (sectionIds.length === 0) return;
  const redo: string[] = [];
  for (const id of sectionIds) {
    const n = (leakRedos.get(id) ?? 0) + 1;
    leakRedos.set(id, n);
    if (n > LEAK_REDO_LIMIT) {
      const what = reasons[id] ? reasons[id].replace(/^it /, "") : "kept failing the identity check";
      sectionBackoff.set(id, {
        dealId,
        until: Date.now() + LEAK_HOLD_MS,
        failures: n,
        error: `its blind version ${what} after ${LEAK_REDO_LIMIT} tries`,
      });
      console.warn(`[blind-sync] section ${id} held back from the Blind CIM after ${LEAK_REDO_LIMIT} redos — ${what}`);
    } else {
      redo.push(id);
    }
  }
  // Held sections lose their override too, so the builder shows them as held.
  await dropBlindOverrides(sectionIds);
  if (redo.length > 0) scheduleBlindRefresh(dealId, 0);
}

/**
 * The broker's "Redo blind version" on chosen sections: forget their
 * failures and re-redact them now under the deal's codename. Requires a
 * Blind CIM to exist (the first one is built by "Generate").
 */
export async function redoSectionsBlind(dealId: string, sectionIds: string[]): Promise<void> {
  if (sectionIds.length === 0) return;
  for (const id of sectionIds) {
    sectionBackoff.delete(id);
    leakRedos.delete(id);
  }
  await dropBlindOverrides(sectionIds);
  scheduleBlindRefresh(dealId, 0);
}

/** Does this deal have a Blind CIM (any blind override)? */
export async function dealHasBlindVersion(dealId: string): Promise<boolean> {
  return hasBlindVersion(dealId);
}

/** Content changed: mark stale and queue the re-redaction in one call. */
/** Resolves with the stale stamp written (blind_stale_at = dd_stale_at), so callers can return the row as stored. */
export async function invalidateBlind(dealId: string, sectionIds: string[]): Promise<Date> {
  const at = await markSectionsBlindStale(sectionIds);
  scheduleBlindRefresh(dealId);
  return at;
}

/**
 * (Re)build the WHOLE Blind CIM under the deal's existing codename (a new
 * unique one only if it never had one). Used by "Generate Blind" and by the
 * view room's first blind visit. Resolves with the number of sections done.
 */
export function regenerateAllBlind(dealId: string): Promise<{ codename: string; count: number; failed: number }> {
  return runExclusive(dealId, async () => {
    const deal = await storage.getDeal(dealId);
    if (!deal) throw new Error("Deal not found");
    const all = await storage.getCimSectionsByDeal(dealId);
    const sections = all.filter((s) => !isBeingWritten(s) && getCimLayout(s.layoutType)?.blind !== "exclude");
    if (sections.length === 0) return { codename: deal.blindCodename || "", count: 0, failed: 0 };
    state.set(dealId, { running: true });
    try {
      const codename = await ensureDealCodename(deal);
      const { overrides, failures } = await generateBlindOverrides(sections, deal as any, { codename });
      if (overrides.length === 0 && failures.length > 0) {
        // Nothing redacted: keep whatever blind version existed and report.
        fullBackoff.set(dealId, Date.now() + BACKOFF_STEPS_MS[0]);
        for (const f of failures) recordSectionFailure(dealId, f.cimSectionId, f.error);
        throw new Error(`Couldn't create the blind version: ${failures[0].error}`);
      }
      // Sections that failed get NO override (the old one is deleted with
      // the rest) — they're held back from blind buyers, never served raw.
      await storage.deleteCimSectionOverrides(dealId, "blind");
      const byId = new Map(sections.map((s) => [s.id, s]));
      let moved = false;
      for (const o of overrides) {
        const section = byId.get(o.cimSectionId);
        if (!section) continue;
        if (!(await commitOverride(section, o, codename))) moved = true;
        sectionBackoff.delete(section.id);
        leakRedos.delete(section.id);
      }
      for (const f of failures) recordSectionFailure(dealId, f.cimSectionId, f.error);
      fullBackoff.delete(dealId);
      // Failed sections stay reported as held back through sectionBackoff.
      state.set(dealId, { running: false });
      // A section edited mid-run keeps its stale mark — catch it up.
      if (moved) scheduleBlindRefresh(dealId);
      return { codename: (await currentCodename(dealId)) || codename, count: overrides.length, failed: failures.length };
    } catch (err: any) {
      state.set(dealId, { running: false, lastError: err?.message || "Blind generation failed", lastErrorAt: Date.now() });
      throw err;
    }
  });
}

/** Background form of regenerateAllBlind with a stampede guard. */
const fullInFlight = new Set<string>();
export function regenerateAllBlindInBackground(dealId: string): void {
  if (fullInFlight.has(dealId)) return;
  if ((fullBackoff.get(dealId) ?? 0) > Date.now()) return;
  fullInFlight.add(dealId);
  regenerateAllBlind(dealId)
    .then(({ count }) => console.log(`[blind-sync] generated ${count} blind overrides for deal ${dealId}`))
    .catch((err) => console.error(`[blind-sync] blind generation failed for deal ${dealId}:`, err))
    .finally(() => fullInFlight.delete(dealId));
}

/**
 * The broker's "Retry": forget this deal's failure back-offs and redo what's
 * missing now — the whole Blind CIM if none exists yet, else the held-back
 * sections.
 */
export async function retryBlindNow(dealId: string): Promise<void> {
  for (const [id, f] of Array.from(sectionBackoff.entries())) {
    if (f.dealId !== dealId) continue;
    sectionBackoff.delete(id);
    leakRedos.delete(id);
  }
  fullBackoff.delete(dealId);
  if (await hasBlindVersion(dealId)) scheduleBlindRefresh(dealId, 0);
  else regenerateAllBlindInBackground(dealId);
}
