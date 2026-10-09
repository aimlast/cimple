/**
 * The analytics dashboards' APIs (shared/analytics-dashboard.ts has every
 * shape). Registered from server/routes.ts right after the engagement
 * insight routes.
 *
 *   GET /api/broker/analytics/overview?range&examples          AnalyticsOverviewResponse
 *   GET /api/broker/analytics/call-list?examples               CallListResponse
 *   GET /api/broker/analytics/reading-now?examples             ReadingNowResponse
 *   GET /api/broker/analytics/deals?range&examples             AnalyticsDealsResponse
 *   GET /api/broker/analytics/buyers?examples                  AnalyticsBuyersResponse
 *   GET /api/broker/analytics/activity?range&deal&kind&cursor&limit&examples   ActivityResponse
 *   GET /api/broker/analytics/attention?examples               AttentionResponse
 *   GET /api/deals/:dealId/engagement/kpis?<filters>           DealKpisResponse
 *   GET /api/deals/:dealId/engagement/reading-now              ReadingNowResponse
 *   GET /api/deals/:dealId/engagement/page-titles?rendition    PageTitlesResponse
 *   GET /api/deals/:dealId/engagement/activity?<filters>&kind&cursor&limit     ActivityResponse
 *
 * Tenancy: requireBroker on everything; deal routes also requireOwnedDeal.
 * Global routes read only ownedLiveDeals(session.brokerId); a `deal` value
 * outside those deals answers 404 (the same as a missing deal). A foreign
 * access id in `buyers=` matches nothing (empty numbers, never a 500).
 * No AI anywhere. A deal whose reading couldn't load is reported in
 * `partial`, not as a 500.
 */
import type { Express, Response } from "express";
import type { Deal } from "@shared/schema";
import {
  DEFAULT_ENGAGEMENT_FILTERS,
  parseEngagementFilters,
  viewerPageKey,
  type EngagementFilters,
  type PageRole,
} from "@shared/analytics-v2";
import {
  parseActivityKind,
  parseExamplesMode,
  rangeWindow,
  type AttentionResponse,
  type PageTitlesResponse,
  type ReadingNowResponse,
} from "@shared/analytics-dashboard";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes.js";
import { industryBenchmarkRows, roleBenchmarks } from "../engagement/benchmarks";
import { parseLimit } from "../analytics-dashboard/activity";
import { extraActivity, extraHeadsUp } from "../analytics-dashboard/extra-sources";
import { allowedAccessIds } from "../analytics-dashboard/kpis";
import { loadBrokerDeals, loadBrokerInputs, loadDealFacts, loadDealInputs } from "../analytics-dashboard/load";
import { readingNowResponseRows, readingNowRows, type ReadingNowDbRow } from "../analytics-dashboard/reading-now";
import {
  activityResponse,
  attentionResponse,
  buyersResponse,
  callListResponse,
  dealKpisResponse,
  dealsResponse,
  overviewResponse,
} from "../analytics-dashboard/responses";

const CALL_LIST_SIZE = 15;
type Benchmarks = AttentionResponse["benchmarks"];

/** Anonymous industry benchmarks for the broker's industries (other brokerages only, ≥ 5 deals behind a figure). */
async function benchmarksFor(brokerId: string, deals: Deal[]): Promise<Benchmarks> {
  const industries = new Map<string, string>();
  for (const d of deals) {
    const ind = (d.industry || "").trim();
    if (ind && !industries.has(ind.toLowerCase())) industries.set(ind.toLowerCase(), ind);
  }
  const out: Benchmarks = [];
  for (const [, label] of Array.from(industries.entries()).slice(0, 8)) {
    const rows = await industryBenchmarkRows(label, { excludeBrokerId: brokerId });
    for (const b of roleBenchmarks(rows)) out.push({ role: b.role as PageRole, industry: label, medianStudyRatio: b.medianStudyRatio, deals: b.deals });
  }
  return out;
}

interface RouteDeps {
  readingNow(dealIds: string[], now: Date): Promise<ReadingNowDbRow[]>;
  benchmarks(brokerId: string, deals: Deal[]): Promise<Benchmarks>;
  clock(): Date;
}
const defaultDeps: RouteDeps = { readingNow: readingNowRows, benchmarks: benchmarksFor, clock: () => new Date() };
let deps: RouteDeps = defaultDeps;

/** Tests: replace the reading-now read, the benchmarks read or the clock (null restores them). */
export function _setAnalyticsRouteDeps(d: Partial<RouteDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

function fail(res: Response, err: unknown, where: string, message = "Couldn't load your analytics"): void {
  console.error(`[analytics] ${where}`, err);
  if (!res.headersSent) res.status(500).json({ error: message });
}

const q1 = (v: unknown): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s ? s : null;
};

/** The deal Activity view hides Device and Which CIM version: they never filter it. */
function activityFilters(f: EngagementFilters): EngagementFilters {
  return { ...f, device: "all", rendition: null };
}

export function registerAnalyticsDashboardRoutes(app: Express): void {
  // ── The Analytics page ──────────────────────────────────────────────────

  app.get("/api/broker/analytics/overview", requireBroker, async (req, res) => {
    try {
      const inputs = await loadBrokerInputs(req.session.brokerId!, { examples: parseExamplesMode(req.query.examples) });
      const now = deps.clock();
      res.json(overviewResponse(inputs, req.query.range, now, await extraHeadsUp(inputs.deals, now)));
    } catch (err) {
      fail(res, err, "overview");
    }
  });

  app.get("/api/broker/analytics/call-list", requireBroker, async (req, res) => {
    try {
      const inputs = await loadBrokerInputs(req.session.brokerId!, { examples: parseExamplesMode(req.query.examples) });
      res.json(callListResponse(inputs, CALL_LIST_SIZE));
    } catch (err) {
      fail(res, err, "call-list", "Couldn't load who to call");
    }
  });

  app.get("/api/broker/analytics/reading-now", requireBroker, async (req, res) => {
    try {
      const { counted } = await loadBrokerDeals(req.session.brokerId!, { examples: parseExamplesMode(req.query.examples) });
      const names = new Map(counted.map((d) => [d.id, d.businessName]));
      const rows = await deps.readingNow(counted.map((d) => d.id), deps.clock());
      const body: ReadingNowResponse = { rows: readingNowResponseRows(rows.filter((r) => names.has(r.dealId)), (id) => names.get(id) ?? "") };
      res.json(body);
    } catch (err) {
      fail(res, err, "reading-now");
    }
  });

  app.get("/api/broker/analytics/deals", requireBroker, async (req, res) => {
    try {
      const inputs = await loadBrokerInputs(req.session.brokerId!, { examples: parseExamplesMode(req.query.examples) });
      res.json(dealsResponse(inputs, req.query.range, deps.clock()));
    } catch (err) {
      fail(res, err, "deals");
    }
  });

  app.get("/api/broker/analytics/buyers", requireBroker, async (req, res) => {
    try {
      const inputs = await loadBrokerInputs(req.session.brokerId!, { examples: parseExamplesMode(req.query.examples) });
      res.json(buyersResponse(inputs, deps.clock()));
    } catch (err) {
      fail(res, err, "buyers");
    }
  });

  app.get("/api/broker/analytics/activity", requireBroker, async (req, res) => {
    try {
      const brokerId = req.session.brokerId!;
      const examples = parseExamplesMode(req.query.examples);
      const dealId = q1(req.query.deal);
      if (dealId) {
        const { all } = await loadBrokerDeals(brokerId, { examples });
        if (!all.some((d) => d.id === dealId)) return res.status(404).json({ error: "Not found" });
      }
      const inputs = await loadBrokerInputs(brokerId, { examples, forceDealId: dealId });
      const now = deps.clock();
      const deals = dealId ? inputs.deals.filter((d) => d.id === dealId) : inputs.deals;
      const extra = await extraActivity(deals, { since: null, now });
      res.json(activityResponse(inputs, {
        range: req.query.range, now, kinds: parseActivityKind(req.query.kind), dealId, extra,
        cursor: q1(req.query.cursor), limit: parseLimit(req.query.limit),
      }));
    } catch (err) {
      fail(res, err, "activity", "Couldn't load the activity");
    }
  });

  app.get("/api/broker/analytics/attention", requireBroker, async (req, res) => {
    try {
      const brokerId = req.session.brokerId!;
      const inputs = await loadBrokerInputs(brokerId, { examples: parseExamplesMode(req.query.examples) });
      let benchmarks: Benchmarks = [];
      try {
        benchmarks = await deps.benchmarks(brokerId, inputs.deals);
      } catch (err) {
        console.warn("[analytics] benchmarks unavailable:", (err as Error)?.message ?? err);
      }
      res.json(attentionResponse(inputs, benchmarks));
    } catch (err) {
      fail(res, err, "attention");
    }
  });

  // ── One deal (Engagement tab, pulse) ────────────────────────────────────

  app.get("/api/deals/:dealId/engagement/kpis", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const filters = parseEngagementFilters(req.query as Record<string, unknown>);
      const now = deps.clock();
      const [inputs, reading] = await Promise.all([
        loadDealInputs(deal, filters),
        deps.readingNow([deal.id], now).catch((err) => {
          console.warn("[analytics] reading now unavailable:", (err as Error)?.message ?? err);
          return [] as ReadingNowDbRow[];
        }),
      ]);
      res.json(dealKpisResponse(inputs, reading, now));
    } catch (err) {
      fail(res, err, "deal kpis");
    }
  });

  app.get("/api/deals/:dealId/engagement/reading-now", requireBroker, requireOwnedDeal, async (_req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const rows = await deps.readingNow([deal.id], deps.clock());
      const body: ReadingNowResponse = { rows: readingNowResponseRows(rows.filter((r) => r.dealId === deal.id), () => deal.businessName) };
      res.json(body);
    } catch (err) {
      fail(res, err, "deal reading-now");
    }
  });

  app.get("/api/deals/:dealId/engagement/page-titles", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const { rendition } = parseEngagementFilters({ rendition: req.query.rendition });
      const facts = await loadDealFacts(deal, { ...DEFAULT_ENGAGEMENT_FILTERS, rendition });
      const body: PageTitlesResponse = {
        pages: facts.pages.map((p) => ({ key: viewerPageKey(p.pageId, p.part), label: p.label, title: p.title, blindTitle: p.blindTitle ?? null })),
      };
      res.json(body);
    } catch (err) {
      fail(res, err, "page-titles");
    }
  });

  app.get("/api/deals/:dealId/engagement/activity", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const filters = activityFilters(parseEngagementFilters(req.query as Record<string, unknown>));
      const now = deps.clock();
      const inputs = await loadDealInputs(deal, filters);
      const allowed = allowedAccessIds(inputs, filters);
      const extra = await extraActivity([deal], { since: rangeWindow(filters.range, now).since, now });
      res.json(activityResponse(inputs, {
        range: filters.range, now, kinds: parseActivityKind(req.query.kind), dealId: deal.id,
        accessIds: allowed ? Array.from(allowed) : null, extra,
        cursor: q1(req.query.cursor), limit: parseLimit(req.query.limit),
      }));
    } catch (err) {
      fail(res, err, "deal activity", "Couldn't load the activity");
    }
  });
}
