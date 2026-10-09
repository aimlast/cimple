/**
 * The analytics dashboards' routes (server/routes/analytics-dashboard.ts)
 * through real Express: tenancy with BOTH brokers' data present, 404s for
 * another broker's deal, partial loads, lenient query parsing and the rate
 * limit. In-memory rows; no database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-routes.test.ts
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { DEFAULT_ENGAGEMENT_FILTERS, type EngagementFilters } from "../../shared/analytics-v2";
import type { ActivityResponse, AnalyticsBuyersResponse, AnalyticsDealsResponse, AnalyticsOverviewResponse, DealKpisResponse, PageTitlesResponse, ReadingNowResponse } from "../../shared/analytics-dashboard";
import { NOW, accessOf, dealOf, factsOf, questionRow, type DealSpec } from "./fixtures/analytics-fixtures";

const A1: DealSpec = {
  id: "dealA1", name: "Alpha Logistics", brokerId: "brokerA", live: true,
  links: [
    { id: "accA1", name: "Gurdeep Randhawa", firstViewedDaysAgo: 3, ndaDaysAgo: 4, decision: "interested", decisionDaysAgo: 2 },
    { id: "accA2", name: "Natalie Unopened", createdDaysAgo: 8 },
  ],
  visits: [{ id: "visA1", access: "accA1", daysAgo: 3, activeMs: 20 * 60_000, pages: ["exec", "fin"] }],
  reading: [{ visit: "visA1", page: "fin", ms: 600_000, block: "row:0" }],
  questions: [{ id: "qA1", access: "accA1", text: "Is the yard leased?", daysAgo: 1, status: "pending_broker" }],
};
const A2: DealSpec = { id: "dealA2", name: "Alpha Bakery", brokerId: "brokerA", live: false, links: [{ id: "accA3", name: "Bea Baker" }] };
const B1: DealSpec = {
  id: "dealB1", name: "Bravo Secret Holdings", brokerId: "brokerB", live: true,
  links: [{ id: "accB1", name: "Zed Competitor", firstViewedDaysAgo: 2, ndaDaysAgo: 2 }],
  visits: [{ id: "visB1", access: "accB1", daysAgo: 2, activeMs: 30 * 60_000 }],
  reading: [{ visit: "visB1", page: "exec", ms: 400_000 }],
  questions: [{ id: "qB1", access: "accB1", text: "Bravo question?", daysAgo: 1, status: "pending_broker" }],
};
const SPECS = [A1, A2, B1];
const specOf = (id: string) => SPECS.find((s) => s.id === id)!;

async function main() {
  const { storage } = await import("../../server/storage");
  const { registerAnalyticsDashboardRoutes, _setAnalyticsRouteDeps } = await import("../../server/routes/analytics-dashboard");
  const { _setLoaderDeps, loadBrokerInputs } = await import("../../server/analytics-dashboard/load");
  const { _resetMemo } = await import("../../server/analytics-dashboard/memo");
  const { applyAnalyticsRateLimits } = await import("../../server/analytics-dashboard/limits");

  const deals = SPECS.map(dealOf);
  const S = storage as any;
  // MemStorage.getAllDeals returns [] — a tenancy test would pass with nothing to see — so filter by broker like the DB.
  S.getAllDeals = async (brokerId?: string) => deals.filter((d) => !brokerId || d.brokerId === brokerId);
  S.getDeal = async (id: string) => deals.find((d) => d.id === id);

  const failing = new Set<string>();
  _setLoaderDeps({
    accessRows: async (ids) => SPECS.filter((s) => ids.includes(s.id)).flatMap((s) => s.links.map((l) => accessOf(s.id, l))),
    questions: async (ids) => SPECS.filter((s) => ids.includes(s.id)).flatMap((s) => (s.questions ?? []).map((q) => questionRow(s.id, q))),
    approvals: async () => [],
    decisions: async () => [],
    facts: async (deal, filters: EngagementFilters) => {
      if (failing.has(deal.id)) throw new Error("reading store down");
      return factsOf(specOf(deal.id), filters);
    },
    readingVersion: () => 0,
    invalidateFacts: () => {},
  });
  const readingNowCalls: string[][] = [];
  _setAnalyticsRouteDeps({
    clock: () => NOW,
    benchmarks: async () => [],
    readingNow: async (ids) => {
      readingNowCalls.push(ids);
      return [
        { accessId: "accA1", dealId: "dealA1", mode: "normal", lastSeenAt: new Date(NOW.getTime() - 20_000), name: "Gurdeep Randhawa", email: "g@x.invalid", company: null },
        { accessId: "accB1", dealId: "dealB1", mode: "normal", lastSeenAt: new Date(NOW.getTime() - 10_000), name: "Zed Competitor", email: "z@x.invalid", company: null },
      ].filter((r) => ids.includes(r.dealId));
    },
  });

  const app = express();
  app.use((req: any, _res, next) => { req.session = { brokerId: req.get("x-test-broker") || undefined }; next(); });
  registerAnalyticsDashboardRoutes(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string, broker: string | null = "brokerA") => {
    const r = await fetch(`${base}${path}`, { headers: broker ? { "x-test-broker": broker } : {} });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, text };
  };
  const noB = (text: string, where: string) => {
    for (const s of ["Bravo", "Zed Competitor", "dealB1", "accB1"]) assert.ok(!text.includes(s), `${where}: none of broker B's data (${s})`);
  };

  try {
    // ── Tenancy: A's data present, none of B's ──
    const ov = await get("/api/broker/analytics/overview");
    assert.equal(ov.status, 200);
    const o = ov.body as AnalyticsOverviewResponse;
    assert.equal(o.counts.deals, 2, "broker A's two deals");
    assert.equal(o.counts.buyers, 3);
    assert.ok(o.kpis.find((k) => k.id === "reading")!.ids!.includes("accA1"), "A's reader is counted");
    assert.equal(o.kpis.find((k) => k.id === "waiting")!.value, 1, "A's question waits");
    noB(ov.text, "overview");

    const dl = await get("/api/broker/analytics/deals?range=all");
    assert.deepEqual((dl.body as AnalyticsDealsResponse).rows.map((r) => r.dealId).sort(), ["dealA1", "dealA2"]);
    noB(dl.text, "deals");

    const by = await get("/api/broker/analytics/buyers");
    assert.deepEqual((by.body as AnalyticsBuyersResponse).rows.map((r) => r.accessId).sort(), ["accA1", "accA2", "accA3"]);
    noB(by.text, "buyers");

    const ac = await get("/api/broker/analytics/activity?range=all");
    assert.ok((ac.body as ActivityResponse).items.some((i) => i.accessId === "accA1"), "A's activity present");
    noB(ac.text, "activity");

    const rn = await get("/api/broker/analytics/reading-now");
    assert.deepEqual((rn.body as ReadingNowResponse).rows.map((r) => r.accessId), ["accA1"]);
    assert.ok(readingNowCalls.every((ids) => !ids.includes("dealB1")), "the reading-now read is restricted to A's deals");
    noB(rn.text, "reading-now");

    const cl = await get("/api/broker/analytics/call-list");
    assert.equal(cl.status, 200);
    noB(cl.text, "call-list");
    const at = await get("/api/broker/analytics/attention");
    assert.equal(at.status, 200);
    noB(at.text, "attention");

    // ── 404 for B's deal, 401 signed out ──
    assert.equal((await get("/api/broker/analytics/activity?deal=dealB1")).status, 404, "a deal filter outside A's deals");
    assert.deepEqual((await get("/api/broker/analytics/activity?deal=dealB1")).body, { error: "Not found" });
    for (const p of ["kpis", "activity", "reading-now", "page-titles"]) {
      assert.equal((await get(`/api/deals/dealB1/engagement/${p}`)).status, 404, `B's deal ${p} as A`);
    }
    for (const p of ["/api/broker/analytics/overview", "/api/broker/analytics/buyers", "/api/deals/dealA1/engagement/kpis"]) {
      assert.equal((await get(p, null)).status, 401, `${p} signed out`);
    }

    // ── The deal routes ──
    const k = await get("/api/deals/dealA1/engagement/kpis");
    assert.equal(k.status, 200);
    const kb = k.body as DealKpisResponse;
    assert.equal(kb.kpis.find((x) => x.id === "opened")!.display, "1 of 2");
    assert.equal(kb.readingNow[0]?.accessId, "accA1");
    assert.equal(kb.readingNow[0]?.page?.title, "Income Statement", "the page they're on, from the facts");
    assert.equal(kb.published, true);
    assert.equal(kb.forText, "All time · All buyers");
    const foreign = await get("/api/deals/dealA1/engagement/kpis?buyers=accB1");
    assert.equal(foreign.status, 200, "a foreign buyer id: never a 500");
    assert.ok((foreign.body as DealKpisResponse).kpis.every((x) => x.value === 0), "and matches nothing");
    const titles = await get("/api/deals/dealA1/engagement/page-titles");
    assert.deepEqual((titles.body as PageTitlesResponse).pages.map((p) => p.title), ["Project Coastal", "Executive Summary", "Income Statement", "Customer Base", "Transaction Overview"]);
    assert.equal((titles.body as PageTitlesResponse).pages[2].key, "fin#0");
    const dact = await get("/api/deals/dealA1/engagement/activity?range=all&kind=question");
    assert.ok((dact.body as ActivityResponse).items.length > 0 && (dact.body as ActivityResponse).items.every((i) => i.kind === "question"));
    const drn = await get("/api/deals/dealA1/engagement/reading-now");
    assert.deepEqual((drn.body as ReadingNowResponse).rows.map((r) => r.accessId), ["accA1"]);

    // ── Lenient parsing ──
    const bogus = await get("/api/broker/analytics/activity?kind=bogus&range=all");
    assert.equal(bogus.body.total, ac.body.total, "kind=bogus → all");
    const big = await get("/api/broker/analytics/activity?range=all&limit=10000");
    assert.equal(big.status, 200);
    assert.ok(big.body.items.length <= 100, "limit capped at 100");
    const xyz = await get("/api/broker/analytics/overview?range=xyz");
    assert.equal(xyz.body.rangeAuto, true, "range=xyz → automatic");
    assert.equal(xyz.body.range, "30d", "activity in the last 30 days → last 30 days");
    const explicit = await get("/api/broker/analytics/overview?range=7d");
    assert.equal(explicit.body.rangeAuto, false);

    // ── Partial loads ──
    _resetMemo();
    failing.add("dealA1");
    const part = await get("/api/broker/analytics/overview");
    assert.equal(part.status, 200, "a deal whose reading can't load is not a 500");
    assert.deepEqual((part.body as AnalyticsOverviewResponse).partial, { failedDeals: [{ dealId: "dealA1", dealName: "Alpha Logistics" }] });
    failing.clear();
    _resetMemo();

    // ── An empty broker id throws ──
    await assert.rejects(loadBrokerInputs("", { examples: null }), /broker id/);

    // ── The limiter ──
    const limited = express();
    limited.use((req: any, _res, next) => { req.session = { brokerId: "brokerA" }; next(); });
    applyAnalyticsRateLimits(limited, 3);
    registerAnalyticsDashboardRoutes(limited);
    const s2 = limited.listen(0);
    const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await fetch(`${b2}/api/broker/analytics/reading-now`)).status);
      assert.deepEqual(codes, [200, 200, 200, 429, 429], "429 after the limit");
      assert.equal((await fetch(`${b2}/api/deals/dealA1/engagement/reading-now`)).status, 429, "the deal paths share it");
    } finally {
      s2.close();
    }
    void DEFAULT_ENGAGEMENT_FILTERS;
    console.log("analytics-routes: all assertions passed");
  } finally {
    server.close();
    _setLoaderDeps(null);
    _setAnalyticsRouteDeps(null);
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
