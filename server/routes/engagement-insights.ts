/**
 * Engagement intelligence APIs across the broker's own deals, plus the
 * optional AI brief. Owned by the INTELLIGENCE stream; registered from
 * server/routes.ts.
 *
 *   GET  /api/broker/engagement/call-list                         CallListResponse  (top 15, own non-archived deals)
 *   GET  /api/broker/engagement/compare                           EngagementCompareResponse
 *   POST /api/deals/:dealId/engagement/buyers/:accessId/brief     BuyerBriefResponse (broker-triggered, cached; AI limiter)
 *
 * Tenancy: requireBroker; global routes only ever read deals where
 * brokerId = session.brokerId; the brief also requireOwnedDeal + the access
 * must belong to the deal. The brief uses the supporting model (Sonnet,
 * tool-forced) through an injectable client so tests never call the API;
 * for a blind (teaser/full) buyer it never names the business.
 *
 * The cross-brokerage benchmark on "compare" is anonymous: it is built only
 * from OTHER brokerages' non-demo deals in the same industry, and only where
 * at least BENCHMARK_MIN_DEALS deals stand behind a figure.
 */
import type { Express } from "express";
import {
  DEFAULT_ENGAGEMENT_FILTERS,
  blockId,
  type CallListEntry,
  type CallListResponse,
  type DealEngagementRow,
  type DealReadingFacts,
  type EngagementCompareResponse,
  type KindAttention,
  type LayoutAttention,
  type PageRole,
} from "@shared/analytics-v2";
import { KIND_GROUPS, kindGroupOf, type KindGroup } from "@shared/cim-blocks";
import { getCimLayout } from "@shared/cim-layouts";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes.js";
import { getDealAccess, ownedLiveDeals } from "../engagement/access";
import { loadDealReadingFacts } from "../engagement/facts";
import { buyerInsight, rankBuyers, readingSummary, type InsightContext } from "../engagement/insights";
import { BriefNothingToSayError, BriefUnavailableError, buyerBrief } from "../engagement/narrative";
import { industryBenchmarkRows, roleBenchmarks } from "../engagement/benchmarks";
import type { Deal } from "@shared/schema";

const CALL_LIST_SIZE = 15;
const CACHE_MS = 30_000;
const DAY = 86_400_000;

/** Load facts for several deals, a few at a time (each is a handful of SQL reads). */
async function factsForDeals(deals: Deal[], now: Date): Promise<Array<{ deal: Deal; facts: DealReadingFacts }>> {
  const out: Array<{ deal: Deal; facts: DealReadingFacts }> = [];
  for (let i = 0; i < deals.length; i += 4) {
    const batch = await Promise.all(deals.slice(i, i + 4).map(async (deal) => {
      try {
        return { deal, facts: await loadDealReadingFacts(deal, DEFAULT_ENGAGEMENT_FILTERS, now) };
      } catch (err) {
        console.warn(`[engagement] facts for deal ${deal.id} failed:`, (err as Error).message);
        return null;
      }
    }));
    for (const b of batch) if (b) out.push(b);
  }
  return out;
}

function ctxOf(facts: DealReadingFacts): InsightContext {
  return { now: new Date(facts.now), pages: facts.pages, buyers: facts.buyers };
}

/** Pure: the merged call list across deals (top N, best lead first; decided-against and unopened buyers left out). */
export function buildCallList(items: Array<{ deal: Pick<Deal, "id" | "businessName">; facts: DealReadingFacts }>, size = CALL_LIST_SIZE): CallListEntry[] {
  const all: Array<{ entry: CallListEntry; priority: number; lastSeen: number }> = [];
  for (const { deal, facts } of items) {
    const ctx = ctxOf(facts);
    const ranked = rankBuyers(facts.buyers.filter((b) => b.visits.length > 0).map((f) => ({ facts: f, insight: buyerInsight(f, ctx) })));
    for (const { facts: b, insight } of ranked) {
      if (insight.status === "not_interested" || insight.status === "lapsed" || insight.priority <= 0) continue;
      const lastSeen = b.visits.reduce((m, v) => Math.max(m, Date.parse(v.lastSeenAt) || 0), 0);
      all.push({
        priority: insight.priority,
        lastSeen,
        entry: {
          dealId: deal.id,
          dealName: deal.businessName,
          accessId: b.accessId,
          name: b.name,
          company: b.company,
          status: insight.status,
          statusLabel: insight.statusLabel,
          why: insight.why,
          talkingPoints: insight.talkingPoints,
          lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null,
        },
      });
    }
  }
  return all
    .sort((a, b) => b.priority - a.priority || b.lastSeen - a.lastSeen)
    .slice(0, size)
    .map((x) => x.entry);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

const KIND_LABEL = new Map<string, string>(KIND_GROUPS.map((g) => [g.key, g.label]));

function layoutLabel(layoutType: string): string {
  return getCimLayout(layoutType)?.label ?? layoutType.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Pure: one deal's row on "Your deals compared". */
export function dealCompareRow(deal: Pick<Deal, "id" | "businessName">, facts: DealReadingFacts): DealEngagementRow {
  const now = new Date(facts.now).getTime();
  const opened = facts.buyers.filter((b) => b.visits.length > 0 || !!b.firstViewedAt);
  const withReading = facts.buyers.filter((b) => b.visits.length > 0);
  const sums = withReading.map((b) => readingSummary(b, facts.pages));
  return {
    dealId: deal.id,
    dealName: deal.businessName,
    granted: facts.buyers.length,
    opened: opened.length,
    readingThisWeek: sums.filter((s) => s.lastSeenAt && now - s.lastSeenAt <= 7 * DAY).length,
    // Median reading time per buyer who read (the whole CIM; visit active time when only page totals exist).
    medianActiveMs: median(withReading.map((b, i) => sums[i].attentionMs || b.visits.reduce((s, v) => s + v.activeMs, 0))),
    reachedEnd: sums.filter((s) => s.reachedEnd).length,
    ndaSigned: facts.buyers.filter((b) => !!b.ndaSignedAt).length,
    interested: facts.buyers.filter((b) => b.decision === "interested").length,
  };
}

/**
 * Pure: reading time by kind of content and by layout across deals. A page
 * counts for a buyer once they read it; its blocks' expected time then
 * counts whether or not each block was read, so attention ÷ expected is how
 * much of what was in front of them they took in.
 */
export function attentionMix(items: Array<{ facts: DealReadingFacts }>): { byKind: KindAttention[]; byLayout: LayoutAttention[] } {
  const kinds = new Map<KindGroup, { att: number; exp: number; blocks: Set<string> }>();
  const layouts = new Map<string, { att: number; exp: number; pages: Set<string> }>();
  for (const { facts } of items) {
    for (const b of facts.buyers) {
      if (b.visits.length === 0) continue;
      for (const p of facts.pages) {
        if (p.role === "front_matter" || p.locked) continue;
        const r = b.pages[`${p.pageId}#${p.part}`];
        if (!r || r.attentionMs <= 0) continue;
        const l = layouts.get(p.layoutType) ?? { att: 0, exp: 0, pages: new Set<string>() };
        l.att += r.attentionMs;
        l.exp += p.expectedMs;
        l.pages.add(`${facts.dealId}|${p.pageId}|${p.part}`);
        layouts.set(p.layoutType, l);
        for (const bl of p.blocks) {
          if (bl.virtual || bl.when || bl.part !== p.part || bl.kind === "column" || bl.kind === "point") continue;
          const g = kindGroupOf(bl.kind);
          const k = kinds.get(g) ?? { att: 0, exp: 0, blocks: new Set<string>() };
          k.att += b.blocks[blockId(p.pageId, bl.key)]?.[0] ?? 0;
          k.exp += bl.expectedMs;
          k.blocks.add(`${facts.dealId}|${p.pageId}|${bl.key}`);
          kinds.set(g, k);
        }
      }
    }
  }
  const byKind: KindAttention[] = Array.from(kinds.entries())
    .filter(([g]) => g !== "other")
    .map(([group, k]) => ({ group, label: KIND_LABEL.get(group) ?? group, attentionMs: Math.round(k.att), expectedMs: Math.round(k.exp), blocks: k.blocks.size }))
    .sort((a, b) => b.attentionMs - a.attentionMs);
  const byLayout: LayoutAttention[] = Array.from(layouts.entries())
    .map(([layoutType, l]) => ({ layoutType, label: layoutLabel(layoutType), attentionMs: Math.round(l.att), expectedMs: Math.round(l.exp), pages: l.pages.size }))
    .sort((a, b) => b.attentionMs - a.attentionMs);
  return { byKind, byLayout };
}

/** Anonymous industry benchmarks for the broker's industries (other brokerages only, ≥ 5 deals). */
async function benchmarksFor(brokerId: string, deals: Deal[]): Promise<EngagementCompareResponse["benchmarks"]> {
  const industries = new Map<string, string>();
  for (const d of deals) {
    const ind = (d.industry || "").trim();
    if (ind && !industries.has(ind.toLowerCase())) industries.set(ind.toLowerCase(), ind);
  }
  const out: EngagementCompareResponse["benchmarks"] = [];
  for (const [, label] of Array.from(industries.entries()).slice(0, 8)) {
    const rows = await industryBenchmarkRows(label, { excludeBrokerId: brokerId });
    for (const b of roleBenchmarks(rows)) out.push({ role: b.role as PageRole, industry: label, medianStudyRatio: b.medianStudyRatio, deals: b.deals });
  }
  return out;
}

const callListCache = new Map<string, { at: number; body: CallListResponse }>();
const compareCache = new Map<string, { at: number; body: EngagementCompareResponse }>();

/** Drop a broker's cached call list (after "Mark contacted"). */
export function invalidateBrokerEngagement(brokerId: string): void {
  callListCache.delete(brokerId);
  compareCache.delete(brokerId);
}

export function registerEngagementInsightRoutes(app: Express): void {
  app.get("/api/broker/engagement/call-list", requireBroker, async (req, res) => {
    try {
      const brokerId = req.session.brokerId!;
      const hit = callListCache.get(brokerId);
      if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.body);
      const deals = await ownedLiveDeals(brokerId);
      const items = await factsForDeals(deals, new Date());
      const body: CallListResponse = { entries: buildCallList(items) };
      callListCache.set(brokerId, { at: Date.now(), body });
      res.json(body);
    } catch (err) {
      console.error("[engagement] call-list", err);
      res.status(500).json({ error: "Couldn't load who to call" });
    }
  });

  app.get("/api/broker/engagement/compare", requireBroker, async (req, res) => {
    try {
      const brokerId = req.session.brokerId!;
      const hit = compareCache.get(brokerId);
      if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.body);
      const deals = await ownedLiveDeals(brokerId);
      const items = await factsForDeals(deals, new Date());
      const rows = items.map(({ deal, facts }) => dealCompareRow(deal, facts));
      // Deals whose facts couldn't load still get a row (zeros), so the list matches the broker's deals.
      for (const d of deals) if (!rows.some((r) => r.dealId === d.id)) {
        rows.push({ dealId: d.id, dealName: d.businessName, granted: 0, opened: 0, readingThisWeek: 0, medianActiveMs: null, reachedEnd: 0, ndaSigned: 0, interested: 0 });
      }
      rows.sort((a, b) => b.opened - a.opened || b.granted - a.granted || a.dealName.localeCompare(b.dealName));
      const mix = attentionMix(items);
      let benchmarks: EngagementCompareResponse["benchmarks"] = [];
      try {
        benchmarks = await benchmarksFor(brokerId, deals);
      } catch (err) {
        console.warn("[engagement] benchmarks unavailable:", (err as Error).message);
      }
      const body: EngagementCompareResponse = { deals: rows, byKind: mix.byKind, byLayout: mix.byLayout, benchmarks };
      compareCache.set(brokerId, { at: Date.now(), body });
      res.json(body);
    } catch (err) {
      console.error("[engagement] compare", err);
      res.status(500).json({ error: "Couldn't compare your deals" });
    }
  });

  app.post("/api/deals/:dealId/engagement/buyers/:accessId/brief", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const access = await getDealAccess(deal.id, req.params.accessId);
      if (!access) return res.status(404).json({ error: "Not found" });
      const facts = await loadDealReadingFacts(deal, DEFAULT_ENGAGEMENT_FILTERS);
      res.json(await buyerBrief(deal, facts, access.id));
    } catch (err) {
      if (err instanceof BriefNothingToSayError) return res.status(409).json({ error: "They haven't read any of the CIM yet — there's nothing to summarise." });
      if (err instanceof BriefUnavailableError) return res.status(503).json({ error: "The summary needs the AI service, which isn't available right now." });
      console.error("[engagement] brief", err);
      res.status(502).json({ error: "Couldn't write the summary right now. Try again in a moment." });
    }
  });
}
