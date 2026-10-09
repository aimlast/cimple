/**
 * service.ts — the steps that keep a deal's "Add-backs in the books" up to
 * date, in the order they must run, under the per-deal GL lock (D27):
 *
 *   refreshGl(dealId)      sync the add-backs with the analysis (skipped when
 *                          nothing changed) → rules proposals for changed
 *                          add-backs → reconciliation → tie-out when the
 *                          analysis or fiscal-year end changed
 *   afterLedgersChanged    a ledger was read / removed / changed audience →
 *                          proposals for every add-back (rules; AI per the
 *                          uploader's budget once pass 3 installs it) →
 *                          reconciliation → tie-out
 *   changeFiscalYearEnd    entries + links move years, proposals cleared,
 *                          everything recomputed (D26)
 *
 * Installs itself as the ledger reader's follow-up (setGlAfterLedgersChanged).
 */
import { storage } from "../storage";
import type { GlAddbackTrace } from "@shared/schema";
import { normaliseFiscalYearEnd } from "@shared/fiscal-year";
import { glStore } from "./store";
import { withGlLock } from "./lock";
import { loadGlContext } from "./context";
import { planTraces, syncFingerprint, type NormLike } from "./traces";
import { proposeUnlocked, recomputeTraces, type AiMode } from "./match-run";
import { tieOutFor } from "./tie-out";
import { setGlAfterLedgersChanged } from "./ingest";

/** The analysis the CIM uses, as traces read it. */
export async function analysisForTraces(dealId: string): Promise<{ id: string; updatedAt: unknown; normalization: NormLike | null } | null> {
  const { pickAnalysisForCim } = await import("../cim/cim-financials");
  const { normalizeFinancialAnalysisRow } = await import("../financial/shape");
  const picked = pickAnalysisForCim(await storage.getFinancialAnalysesByDeal(dealId));
  if (!picked) return null;
  const a = normalizeFinancialAnalysisRow(picked as Record<string, any>);
  return { id: a.id, updatedAt: a.updatedAt, normalization: (a.normalization as NormLike | null) ?? null };
}

/** The deal's country for the pay documents' names (T4 / W-2). */
async function payCountry(dealId: string, deal?: { location?: string | null; extractedInfo?: unknown } | null): Promise<"CA" | "US" | null> {
  const d = deal ?? (await storage.getDeal(dealId));
  const info = (d?.extractedInfo && typeof d.extractedInfo === "object" ? d.extractedInfo : {}) as Record<string, unknown>;
  const { jurisdictionOf } = await import("../interview/reply-guards");
  const text = (v: unknown) => (typeof v === "string" ? v : v && typeof v === "object" ? Object.values(v as Record<string, unknown>).filter((x) => typeof x === "string").join(", ") : "");
  return jurisdictionOf(d?.location ?? null, text(info.location), text(info.province), text(info.state), text(info.city), text(info.headquarters), text(info.address));
}

/** Sync the add-backs with the analysis (inside the lock). Returns the ids whose matching inputs changed. */
async function syncUnlocked(dealId: string, force = false): Promise<{ changed: string[]; synced: boolean }> {
  const c = await loadGlContext(dealId);
  const store = glStore();
  const analysis = await analysisForTraces(dealId);
  const fp = syncFingerprint(analysis, c.fye);
  if (!force && c.tracing.syncedFingerprint === fp) return { changed: [], synced: false };
  const existing = await store.listTraces(dealId);
  const plan = planTraces(analysis?.normalization ?? null, existing, {
    info: (c.deal?.extractedInfo as Record<string, unknown> | null) ?? null,
    country: await payCountry(dealId, c.deal),
    analysisId: analysis?.id ?? null,
  });
  const changed: string[] = [];
  let reopened = false;
  for (const ins of plan.inserts) {
    const row = await store.upsertTrace({ ...ins, dealId } as any);
    changed.push(row.id);
  }
  for (const u of plan.updates) {
    await store.updateTrace(u.id, u.patch);
    if (u.matchingChanged) changed.push(u.id);
    if (u.reopened) reopened = true;
  }
  const now = new Date();
  for (const id of plan.removed) await store.updateTrace(id, { removedAt: now } as Partial<GlAddbackTrace>);
  await store.updateTracing(dealId, {
    analysisId: analysis?.id ?? null,
    syncedFingerprint: fp,
    ...(reopened ? { sellerDoneAt: null, reviewedAt: null } : {}),
  } as any);
  return { changed, synced: true };
}

/** Brings the deal's add-backs, proposals, reconciliation and tie-out up to date. Fingerprint-skipped when nothing changed. */
export async function refreshGl(dealId: string, opts: { force?: boolean } = {}): Promise<{ synced: boolean; changed: string[] }> {
  return withGlLock(dealId, async () => {
    const { changed, synced } = await syncUnlocked(dealId, opts.force);
    if (!synced) return { synced, changed };
    const c = await loadGlContext(dealId);
    if (changed.length) await proposeUnlocked(dealId, changed, { ai: "none" }, c);
    await recomputeTraces(dealId, null, c);
    await tieOutFor(dealId, c).catch((err) => console.warn(`[gl] tie-out for ${dealId} failed:`, err));
    return { synced, changed };
  });
}

/** A ledger became ready / was removed / changed audience: proposals for every add-back, then the numbers. */
export async function afterLedgersChanged(dealId: string, info: { ledgerId: string; uploadedBy: string; change: "ready" | "removed" }): Promise<void> {
  await withGlLock(dealId, async () => {
    await syncUnlocked(dealId);
    const c = await loadGlContext(dealId);
    const ai: AiMode = info.change === "ready" ? (info.uploadedBy === "seller" ? "seller" : "broker") : "none";
    await proposeUnlocked(dealId, null, { ai }, c);
    await recomputeTraces(dealId, null, c);
    await tieOutFor(dealId, c).catch((err) => console.warn(`[gl] tie-out for ${dealId} failed:`, err));
  });
}

/** The fiscal-year end changed (D26): rows and links move years, proposals go and come back, all in one go. */
export async function changeFiscalYearEnd(dealId: string, value: string): Promise<string> {
  const fye = normaliseFiscalYearEnd(value);
  if (!fye) throw Object.assign(new Error("Pick a valid fiscal year end (month and day)."), { status: 400 });
  return withGlLock(dealId, async () => {
    const store = glStore();
    await loadGlContext(dealId); // makes sure the tracing row exists
    await store.changeFiscalYearEnd(dealId, fye);
    // Each ledger's year summaries follow its entries.
    const { recomputeLedgerYears } = await import("./ledger-years");
    await recomputeLedgerYears(dealId, fye);
    await syncUnlocked(dealId, true);
    const c = await loadGlContext(dealId);
    await proposeUnlocked(dealId, null, { ai: "none", force: true }, c);
    await recomputeTraces(dealId, null, c);
    await tieOutFor(dealId, c).catch(() => undefined);
    return fye;
  });
}

/** Recompute after a write that changed links or a trace (one add-back's numbers, or all). */
export async function recomputeAfterWrite(dealId: string, traceIds: string[] | null = null): Promise<void> {
  await recomputeTraces(dealId, traceIds);
}

setGlAfterLedgersChanged(afterLedgersChanged);
