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
 *                          everything recomputed (D26). The broker's choice
 *                          sticks; until the broker sets it, the fiscal-year
 *                          end FOLLOWS the deal's facts and statements
 *                          (followFiscalYearEnd — run first by refreshGl,
 *                          afterLedgersChanged and before every ledger read),
 *                          so a row created early on Dec 31 moves once the
 *                          facts say March 31.
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
import { setGlAfterLedgersChanged, setGlFollowFiscalYearEnd } from "./ingest";
import { fiscalYearEndFor } from "./fiscal";

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

/** The fiscal-year end the deal's facts and statements give now (D26). */
async function derivedFiscalYearEnd(dealId: string): Promise<string> {
  const [deal, docs] = await Promise.all([storage.getDeal(dealId), storage.getDocumentsByDeal(dealId)]);
  return fiscalYearEndFor(deal, docs);
}

/**
 * While the broker hasn't set it, the fiscal-year end follows the facts and
 * statements: when they now say otherwise, every entry and link moves years
 * and everything is worked out again (inside the lock). True when it moved.
 */
async function followFiscalYearEndUnlocked(dealId: string): Promise<boolean> {
  const tr = await glStore().getTracing(dealId);
  if (!tr || tr.fiscalYearEndByBroker) return false;
  const derived = await derivedFiscalYearEnd(dealId);
  if (derived === tr.fiscalYearEnd) return false;
  console.log(`[gl] ${dealId}: fiscal year end follows the facts — ${tr.fiscalYearEnd} → ${derived}`);
  await changeFyeUnlocked(dealId, derived);
  return true;
}

/** The same, taking the lock (before a ledger is read — ingest.ts calls it through its hook). */
export async function followFiscalYearEnd(dealId: string): Promise<boolean> {
  return withGlLock(dealId, () => followFiscalYearEndUnlocked(dealId));
}

/** Brings the deal's add-backs, proposals, reconciliation and tie-out up to date. Fingerprint-skipped when nothing changed. */
export async function refreshGl(dealId: string, opts: { force?: boolean } = {}): Promise<{ synced: boolean; changed: string[] }> {
  return withGlLock(dealId, async () => {
    // A fiscal-year end the facts have overtaken moves first (it re-syncs everything itself).
    if (await followFiscalYearEndUnlocked(dealId)) return { synced: true, changed: [] };
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
    await followFiscalYearEndUnlocked(dealId);
    await syncUnlocked(dealId);
    const c = await loadGlContext(dealId);
    const ai: AiMode = info.change === "ready" ? (info.uploadedBy === "seller" ? "seller" : "broker") : "none";
    await proposeUnlocked(dealId, null, { ai }, c);
    await recomputeTraces(dealId, null, c);
    await tieOutFor(dealId, c).catch((err) => console.warn(`[gl] tie-out for ${dealId} failed:`, err));
  });
}

/** Rows and links move years, proposals go and come back, all in one go (inside the lock). */
async function changeFyeUnlocked(dealId: string, fye: string): Promise<void> {
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
}

/**
 * The broker set the fiscal-year end (D26): it sticks from now on. "auto"
 * hands it back to the facts and statements. Returns the end in use.
 */
export async function changeFiscalYearEnd(dealId: string, value: string): Promise<string> {
  const auto = value === "auto";
  const fye = auto ? null : normaliseFiscalYearEnd(value);
  if (!auto && !fye) throw Object.assign(new Error("Pick a valid fiscal year end (month and day)."), { status: 400 });
  return withGlLock(dealId, async () => {
    const store = glStore();
    await loadGlContext(dealId); // makes sure the tracing row exists
    await store.updateTracing(dealId, { fiscalYearEndByBroker: !auto } as Partial<import("@shared/schema").GlTracing>);
    if (auto) {
      await followFiscalYearEndUnlocked(dealId);
    } else if ((await store.getTracing(dealId))?.fiscalYearEnd !== fye) {
      await changeFyeUnlocked(dealId, fye!);
    }
    return (await store.getTracing(dealId))?.fiscalYearEnd ?? fye ?? "12-31";
  });
}

/** Recompute after a write that changed links or a trace (one add-back's numbers, or all). */
export async function recomputeAfterWrite(dealId: string, traceIds: string[] | null = null): Promise<void> {
  await recomputeTraces(dealId, traceIds);
}

setGlAfterLedgersChanged(afterLedgersChanged);
setGlFollowFiscalYearEnd(followFiscalYearEnd);
