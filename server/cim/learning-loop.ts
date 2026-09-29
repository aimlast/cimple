/**
 * learning-loop.ts
 *
 * Turns what buyers actually read into layout hints for future CIMs in the
 * same industry (engagement_insights → the layout engine's "what buyers
 * read" prompt block).
 *
 * Source: reading_benchmarks (server/engagement/benchmarks.ts) — each deal's
 * reading time recomputed from its own rollups, by page ROLE × layout ×
 * block kind. Never a section key, title or any CIM text: the old loop
 * stored raw section-key slugs ("kitchener_clinic_team") and printed them
 * into other brokers' prompts. Rows written here are:
 *
 *   sectionType = "<role>"            e.g. "financials"          (page level)
 *   sectionType = "<role>/<group>"    e.g. "financials/tables"   (content kind on those pages)
 *   layoutType  = the registry layout key
 *   avgTimeSpentSeconds = reading time per reader
 *   completionRate      = read-through: reading time ÷ expected reading time, % (capped at 100)
 *   sampleCount         = readers behind the figure
 *
 * Only figures with ≥ LEARNING_MIN_DEALS non-demo deals behind them are
 * written (one deal's buyers never become another broker's hint), and each
 * write is an absolute, atomic set (storage.upsertEngagementInsight), so a
 * refresh run twice — or two at once — gives the same rows.
 *
 * Demo / QA deals never feed this (their benchmark rows are never written).
 */
import type { IStorage } from "../storage.js";
import { PAGE_ROLES } from "@shared/analytics-v2";
import { KIND_GROUPS, kindGroupOf, type BlockKind } from "@shared/cim-blocks";
import type { IndustryBenchmarkRow } from "../engagement/benchmarks.js";

/** A layout hint needs this many deals behind it. */
export const LEARNING_MIN_DEALS = 3;
/** A deal's refresh waits this long after its last reading write (bursts of beacons → one refresh). */
export const LEARNING_DEBOUNCE_MS = 10 * 60_000;

export interface LearningInsight {
  sectionType: string;
  layoutType: string;
  avgTimeSpentSeconds: number;
  completionRate: number;
  sampleCount: number;
  deals: number;
}

const ROLE_SET = new Set<string>(PAGE_ROLES);
const GROUP_SET = new Set<string>(KIND_GROUPS.map((g) => g.key));

/** True for a sectionType this loop writes (a role, or role/kind group) — never a legacy slug. */
export function isGenericSectionType(sectionType: string): boolean {
  const [role, group, extra] = sectionType.split("/");
  if (extra !== undefined || !ROLE_SET.has(role)) return false;
  return group === undefined || GROUP_SET.has(group);
}

/**
 * Pure: an industry's benchmark rows → the insights to store. Page-level
 * rows sum every kind on that role × layout; the per-kind rows group block
 * kinds the way the broker sees them ("Tables", "Key figures"…). Readers
 * per deal = the most readers any kind had there (a buyer reading a
 * financial table page reads its header and its rows).
 */
export function learningInsightsFrom(rows: IndustryBenchmarkRow[], minDeals = LEARNING_MIN_DEALS): LearningInsight[] {
  type Acc = { att: number; exp: number; readersByDeal: Map<string, number> };
  const acc = new Map<string, Acc>();
  const add = (sectionType: string, layoutType: string, r: IndustryBenchmarkRow) => {
    const k = `${sectionType}\u0000${layoutType}`;
    const a = acc.get(k) ?? { att: 0, exp: 0, readersByDeal: new Map() };
    a.att += r.attentionMs;
    a.exp += r.expectedMs;
    a.readersByDeal.set(r.dealId, Math.max(a.readersByDeal.get(r.dealId) ?? 0, r.readers));
    acc.set(k, a);
  };
  for (const r of rows) {
    if (!ROLE_SET.has(r.pageRole) || !/^[a-z][a-z_]{0,39}$/.test(r.layoutType) || r.pageRole === "front_matter") continue;
    add(r.pageRole, r.layoutType, r);
    const group = kindGroupOf(r.blockKind as BlockKind);
    if (group !== "other") add(`${r.pageRole}/${group}`, r.layoutType, r);
  }
  const out: LearningInsight[] = [];
  for (const [k, a] of Array.from(acc.entries())) {
    const deals = a.readersByDeal.size;
    const readers = Array.from(a.readersByDeal.values()).reduce((s, n) => s + n, 0);
    if (deals < minDeals || readers === 0 || a.exp <= 0) continue;
    const [sectionType, layoutType] = k.split("\u0000");
    out.push({
      sectionType,
      layoutType,
      avgTimeSpentSeconds: Math.round(a.att / readers / 1000),
      completionRate: Math.min(100, Math.round((a.att / a.exp) * 100)),
      sampleCount: readers,
      deals,
    });
  }
  return out.sort((x, y) => x.sectionType.localeCompare(y.sectionType) || x.layoutType.localeCompare(y.layoutType));
}

/** Recompute the industry's layout hints from reading_benchmarks and store them (atomic per row). */
export async function refreshIndustryInsights(industry: string, storage: IStorage): Promise<number> {
  const { industryBenchmarkRows } = await import("../engagement/benchmarks.js");
  const insights = learningInsightsFrom(await industryBenchmarkRows(industry));
  for (const i of insights) {
    try {
      await storage.upsertEngagementInsight(industry, i.sectionType, i.layoutType, {
        timeSeconds: i.avgTimeSpentSeconds,
        sampleCount: i.sampleCount,
        completionRate: i.completionRate,
      });
    } catch (err) {
      console.warn(`[learning-loop] couldn't store ${i.sectionType}/${i.layoutType}:`, (err as Error).message);
    }
  }
  return insights.length;
}

/** Recompute one deal's benchmark rows, then its industry's layout hints. */
export async function refreshDealLearning(dealId: string, storage: IStorage): Promise<void> {
  const { recomputeDealBenchmarks } = await import("../engagement/benchmarks.js");
  const res = await recomputeDealBenchmarks(dealId);
  if (res.skipped || !res.industry) return;
  await refreshIndustryInsights(res.industry, storage);
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced refresh after reading is written for a deal (the reading ingest
 * calls this): one refresh per deal, LEARNING_DEBOUNCE_MS after its last
 * write. Never throws; the timer doesn't keep the process alive.
 */
export function scheduleLearningRefresh(dealId: string, storage: IStorage, delayMs = LEARNING_DEBOUNCE_MS): void {
  const prev = pending.get(dealId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    pending.delete(dealId);
    refreshDealLearning(dealId, storage).catch((err) => console.warn("[learning-loop] refresh failed:", (err as Error).message));
  }, delayMs);
  (t as { unref?: () => void }).unref?.();
  pending.set(dealId, t);
}

interface AnalyticsEventLike {
  eventType: string;
  sectionKey?: string | null;
  timeSpentSeconds?: number | null;
  scrollDepthPercent?: number | null;
}

/**
 * Legacy entry point (the old /analytics/batch endpoint). Old section_exit
 * events are no longer aggregated — their section keys are exactly the
 * slugs that must not reach other brokers — it only schedules the
 * reading-based refresh for the deal.
 */
export async function aggregateEngagementInsights(
  dealId: string,
  _events: AnalyticsEventLike[],
  storage: IStorage,
): Promise<void> {
  scheduleLearningRefresh(dealId, storage);
}
