/**
 * blind-sync — keeps each section's Blind CIM version in step with its content.
 *
 * The Blind CIM is served from per-section overrides (AI-redacted copies).
 * Before the CIM builder, a section with no override was served un-redacted
 * (title-only redaction) and an edited section kept serving its old override.
 * Now:
 *   - Every content change (create, duplicate, edit, rewrite, convert,
 *     regenerate) calls markSectionsBlindStale(): the section's blind/DD
 *     overrides are dropped and `blindStaleAt` is stamped.
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
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { cimSections, cimSectionOverrides, type CimSection, type CimSectionAiTask } from "@shared/schema";
import { getCimLayout } from "@shared/cim-layouts";
import { ensureDealCodename } from "./codenames";
import { generateBlindOverrides, redactOneSection, type RedactionResult } from "./redaction-engine";

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
interface DealBlindState {
  running: boolean;
  lastError?: string;
  lastErrorAt?: number;
}
const state = new Map<string, DealBlindState>();
/** Sections whose last redaction failed → not retried until this time. */
const sectionBackoff = new Map<string, number>();
const BACKOFF_MS = 60_000;
const debounceTimers = new Map<string, NodeJS.Timeout>();

export function blindRefreshState(dealId: string): DealBlindState {
  return state.get(dealId) ?? { running: false };
}

/** True while a background AI write is filling this section (not buyer-ready). */
export function isBeingWritten(section: Pick<CimSection, "aiTask">): boolean {
  const task = section.aiTask as CimSectionAiTask | null | undefined;
  return !!task && task.kind === "write" && task.status !== "ready";
}

/**
 * Content of these sections changed: drop their blind/DD overrides and stamp
 * them stale. Call BEFORE scheduleBlindRefresh(). Returns the stamp.
 */
export async function markSectionsBlindStale(sectionIds: string[]): Promise<Date> {
  const now = new Date();
  if (sectionIds.length === 0) return now;
  await db.update(cimSections).set({ blindStaleAt: now }).where(inArray(cimSections.id, sectionIds));
  await db.delete(cimSectionOverrides).where(inArray(cimSectionOverrides.cimSectionId, sectionIds));
  for (const id of sectionIds) sectionBackoff.delete(id);
  return now;
}

/**
 * Commit one section's redaction — only if the section is still at the
 * revision the redaction was made from. Returns false when it moved on.
 */
async function commitOverride(section: CimSection, result: RedactionResult): Promise<boolean> {
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
    if ((sectionBackoff.get(s.id) ?? 0) > now) return false;
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
        await commitOverride(batch[j], r.value);
      } else {
        failures++;
        lastError = (r.reason as Error)?.message || "Redaction failed";
        sectionBackoff.set(batch[j].id, Date.now() + BACKOFF_MS);
        console.error(`[blind-sync] redaction failed for section ${batch[j].id}:`, r.reason);
      }
    }
  }
  state.set(dealId, failures > 0
    ? { running: false, lastError: `Couldn't update the blind version of ${failures} section${failures === 1 ? "" : "s"}: ${lastError}`, lastErrorAt: Date.now() }
    : { running: false });
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

/** Content changed: mark stale and queue the re-redaction in one call. */
export async function invalidateBlind(dealId: string, sectionIds: string[]): Promise<void> {
  await markSectionsBlindStale(sectionIds);
  scheduleBlindRefresh(dealId);
}

/**
 * (Re)build the WHOLE Blind CIM under the deal's existing codename (a new
 * unique one only if it never had one). Used by "Generate Blind" and by the
 * view room's first blind visit. Resolves with the number of sections done.
 */
export function regenerateAllBlind(dealId: string): Promise<{ codename: string; count: number }> {
  return runExclusive(dealId, async () => {
    const deal = await storage.getDeal(dealId);
    if (!deal) throw new Error("Deal not found");
    const all = await storage.getCimSectionsByDeal(dealId);
    const sections = all.filter((s) => !isBeingWritten(s) && getCimLayout(s.layoutType)?.blind !== "exclude");
    if (sections.length === 0) return { codename: deal.blindCodename || "", count: 0 };
    state.set(dealId, { running: true });
    try {
      const codename = await ensureDealCodename(deal);
      const { overrides } = await generateBlindOverrides(sections, deal as any, { codename });
      await storage.deleteCimSectionOverrides(dealId, "blind");
      const byId = new Map(sections.map((s) => [s.id, s]));
      let moved = false;
      for (const o of overrides) {
        const section = byId.get(o.cimSectionId);
        if (!section) continue;
        if (!(await commitOverride(section, o))) moved = true;
      }
      for (const s of sections) sectionBackoff.delete(s.id);
      state.set(dealId, { running: false });
      // A section edited mid-run keeps its stale mark — catch it up.
      if (moved) scheduleBlindRefresh(dealId);
      return { codename, count: overrides.length };
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
  fullInFlight.add(dealId);
  regenerateAllBlind(dealId)
    .then(({ count }) => console.log(`[blind-sync] generated ${count} blind overrides for deal ${dealId}`))
    .catch((err) => console.error(`[blind-sync] blind generation failed for deal ${dealId}:`, err))
    .finally(() => fullInFlight.delete(dealId));
}
