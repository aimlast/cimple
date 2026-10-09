/**
 * Old visits hidden by an example deal's sample reading are excluded
 * everywhere, so the reading counts once (heat-map spec §5.5; INTEGRATION
 * §2.13 cimVisitConditions). Part 1 runs the facts loader end to end over
 * the in-memory reading store; part 2 checks the SQL every reader of
 * buyer_visits sends (rendered with drizzle's dialect — no database) with
 * the sample columns present and absent. No AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled node_modules/.bin/tsx tests/unit/engagement-superseded.test.ts
 */
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { storage } from "../../server/storage";
import { db } from "../../server/db";
import { loadDealReadingFacts, setReadingSource, _setLiveRenditionForTests } from "../../server/engagement/facts";
import { buildBuyersResponse, buildDocumentResponse, buildJourneyResponse, buildSummaryResponse } from "../../server/engagement/responses";
import { cimVisitConditions, dbReadingSource, memoryReadingSource } from "../../server/engagement/queries";
import { _setSampleColumnsForTest, _resetSampleColumnsProbe } from "../../server/engagement/demo-columns";
import { planLegacyReading } from "../../server/engagement/legacy-store";
import { computeDealBenchmarks } from "../../server/engagement/benchmarks";
import { engagementByAccess, profileVisitConditions, readingIntentByAccess } from "../../server/buyers/profile-data";
import { memoryReadingStore } from "../../server/analytics/reading-ingest";
import { buildPageIndex } from "../../server/analytics/renditions";
import { DEFAULT_ENGAGEMENT_FILTERS } from "../../shared/analytics-v2";
import type { BuyerSection } from "../../shared/cim-buyer-view";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}
const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q).sql;
const TAG = "demo-reading-v1";

// ── A one-page CIM, one buyer: an old visit hidden by its sample replacement ──
const SEC: BuyerSection = {
  id: "p-fin", dealId: "deal-s", sectionKey: "financial_performance", sectionTitle: "Historical Financial Performance", order: 0,
  layoutType: "metric_grid", layoutData: { metrics: [{ label: "Revenue", value: "$17.4M" }, { label: "Adjusted EBITDA", value: "$3.9M" }] },
  aiDraftContent: null, brokerEditedContent: null, isVisible: true,
};
const PAGES = buildPageIndex([SEC], { brokerage: { showDisclaimerPage: false, showContactPage: false } }, []);
const at = (m: number) => new Date(Date.UTC(2026, 8, 7, 10, m));
const s = storage as any;
s.getBuyerAccessByDeal = async () => [{ id: "a1", dealId: "deal-s", buyerEmail: "a1@x.invalid", buyerName: "Ada", accessLevel: "full", decision: "interested", createdAt: at(0), accessEvents: [], firstViewedAt: at(1) }];
s.getCimSectionsByDeal = async () => [{ ...SEC, analyticsLineage: null }];
_setLiveRenditionForTests(async () => null);

function world(hidden: boolean) {
  const store = memoryReadingStore();
  store.renditions.set("r1", { id: "r1", dealId: "deal-s", mode: "blind", variant: "full", createdAt: at(0), pageIndex: PAGES } as any);
  const base = { dealId: "deal-s", buyerAccessId: "a1", startedAt: at(1), lastSeenAt: at(20), wallMs: 1_200_000, activeMs: 600_000, idleMs: 0, hiddenMs: 0, awayMs: 0, outsideMs: 0, maxPageIndex: 0, selfView: false, clamped: false, accessLevel: "full", viewportW: 1440, viewportH: 900, uaFamily: "Chrome/Mac", ipHash: "demo1" };
  store.visits.set("legacy-1", { ...base, id: "legacy-1", renditionId: null, mode: "blind", deviceClass: "desktop", path: [[0, "financial_performance"]], legacy: true, supersededBy: hidden ? TAG : null } as any);
  store.visits.set("sample-1", { ...base, id: "sample-1", renditionId: "r1", mode: "blind", deviceClass: "desktop", path: [[0, "p-fin"]], demoSeed: TAG } as any);
  const roll = (visitId: string, pageId: string, blockKey: string, att: number, renditionId: string | null) =>
    store.rollups.set(`${visitId}|${pageId}|${blockKey}`, { visitId, pageId, blockKey, dealId: "deal-s", buyerAccessId: "a1", renditionId, lineageId: "p-fin", attentionMs: att, skimMs: 0, visibleMs: att, pointerMs: 0, at: at(5) } as any);
  roll("legacy-1", "p-fin", "", 120_000, null);
  roll("sample-1", "p-fin", "metric:0", 70_000, "r1");
  roll("sample-1", "p-fin", "metric:1", 45_000, "r1");
  roll("sample-1", "p-fin", "", 5_000, "r1");
  store.events.set("sample-1|1", { dealId: "deal-s", buyerAccessId: "a1", visitId: "sample-1", renditionId: "r1", pageId: "p-fin", blockKey: null, clientSeq: 1, eventType: "nav", detail: "toc:p-fin", clientAt: at(2).toISOString(), at: at(2) } as any);
  return store;
}

console.log("hidden old visits count once");
await test("facts, document, buyers, summary and journey: the hidden old visit and its sample replacement count once", async () => {
  setReadingSource(memoryReadingSource(world(true)));
  const f = await loadDealReadingFacts({ id: "deal-s", businessName: "Deal", buyerDeepCheck: null, isLive: true } as any, DEFAULT_ENGAGEMENT_FILTERS, at(30));
  const b = f.buyers.find((x) => x.accessId === "a1")!;
  assert.equal(b.visits.length, 1, "one visit");
  assert.equal(b.visits[0].sample, true);
  assert.equal(f.sampleReading, true);
  assert.equal(f.legacyOnly, false);
  const doc = buildDocumentResponse(f);
  assert.equal(doc.pages[0].attentionMs, 120_000, "page time once (was 240 000 with both)");
  assert.equal(doc.pages[0].heat.basis, "parts");
  assert.equal(doc.totals.visits, 1);
  assert.equal(doc.sampleReading, true);
  const buyers = buildBuyersResponse(f);
  assert.equal(buyers.counts.opened, 1);
  assert.equal(buyers.counts.withReading, 1);
  assert.equal(buyers.sampleReading, true);
  const summary = buildSummaryResponse(f, true, "Deal");
  assert.equal(summary.sampleReading, true);
  const journey = buildJourneyResponse(f, "a1")!;
  assert.equal(journey.visits.length, 1);
  assert.equal(journey.visits[0].legacy, false);
  assert.equal(journey.sampleReading, true);
});
await test("(without the hide, the same rows would count twice — the filter is what keeps them once)", async () => {
  setReadingSource(memoryReadingSource(world(false)));
  const f = await loadDealReadingFacts({ id: "deal-s", businessName: "Deal", buyerDeepCheck: null, isLive: true } as any, DEFAULT_ENGAGEMENT_FILTERS, at(30));
  assert.equal(f.buyers[0].visits.length, 2);
  assert.equal(buildDocumentResponse(f).pages[0].attentionMs, 240_000);
});
await test("the memory source's old-reading cutoff ignores sample visits (a sample visit never ends the old reading)", async () => {
  const store = memoryReadingStore();
  store.visits.set("sample-1", { id: "sample-1", dealId: "deal-s", buyerAccessId: "a1", renditionId: "r1", startedAt: at(1), lastSeenAt: at(2), selfView: false, clamped: false, mode: "blind", demoSeed: TAG } as any);
  const exits = [{ accessId: "a1", key: "financial_performance", seconds: 30, at: at(10) }];
  assert.equal((await memoryReadingSource(store, { legacyExits: exits }).legacyExits("deal-s")).length, 1);
  (store.visits.get("sample-1") as any).demoSeed = null;
  assert.equal((await memoryReadingSource(store, { legacyExits: exits }).legacyExits("deal-s")).length, 0, "a real part-by-part visit does end it");
});

// ── The SQL ──────────────────────────────────────────────────────────────
const captured: string[] = [];
let executeResult: unknown[] = [];
(db as any).execute = async (q: SQL) => { captured.push(render(q)); return executeResult; };
function chain(result: () => unknown[]) {
  const c: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      if (prop === "where") return (cond: SQL) => { captured.push(render(cond)); return c; };
      return () => c;
    },
  });
  return c;
}
let selects = 0;
(db as any).select = () => chain(() => (selects++ === 0 ? [{ accessId: "a1", n: 1, active: 1000, first: 0, last: 0 }] : []));
(db as any).selectDistinct = () => chain(() => []);

const q = { dealId: "deal-s", since: null, device: "all" as const, accessIds: null };
async function sqlOf(fn: () => Promise<unknown>): Promise<string[]> {
  captured.length = 0;
  await fn().catch(() => undefined);
  return [...captured];
}

console.log("every reader of buyer_visits");
for (const cols of [true, false]) {
  await test(`sample columns ${cols ? "present" : "absent"}: visits, block sums, visit pages, events, versions and the old-reading cutoffs`, async () => {
    _setSampleColumnsForTest(cols);
    const readers: Array<[string, () => Promise<unknown>]> = [
      ["visits", () => dbReadingSource.visits(q)],
      ["blockSums", () => dbReadingSource.blockSums(q)],
      ["visitPages", () => dbReadingSource.visitPages(q)],
      ["events", () => dbReadingSource.events(q)],
      ["renditions", () => dbReadingSource.renditions("deal-s")],
    ];
    for (const [name, fn] of readers) {
      const [text] = await sqlOf(fn);
      assert.ok(text, name);
      assert.match(text, /NOT v\.self_view AND NOT v\.clamped AND v\.mode IS DISTINCT FROM 'teaser'/, name);
      assert.equal(/v\.superseded_by IS NULL/.test(text), cols, `${name}: superseded_by filter`);
    }
    const [vis] = await sqlOf(() => dbReadingSource.visits(q));
    assert.equal(/v\.demo_seed/.test(vis), cols, "visits select demo_seed only when the column exists");
    const [ren] = await sqlOf(() => dbReadingSource.renditions("deal-s"));
    assert.match(ren, /r\.mode <> 'teaser'/);
    const [legacy] = await sqlOf(() => dbReadingSource.legacyExits("deal-s"));
    assert.match(legacy, /NOT EXISTS \(SELECT 1 FROM buyer_visits v WHERE v\.deal_id = \$\d+ AND v\.legacy\)/, "a stored legacy visit (hidden or not) suppresses on-the-fly exits");
    assert.match(legacy, /MIN\(v\.started_at\)[^)]*NOT v\.legacy AND NOT v\.self_view\s+AND v\.mode IS DISTINCT FROM 'teaser'/);
    assert.equal(/AND v\.demo_seed IS NULL/.test(legacy), cols, "legacyExits cutoff ignores sample visits");
    s.getCimSectionsByDeal = async () => [];
    const store = await sqlOf(() => planLegacyReading("deal-s"));
    const loadExits = store.find((x) => /section_exit/.test(x))!;
    assert.ok(loadExits, "loadExits ran");
    assert.match(loadExits, /v\.mode IS DISTINCT FROM 'teaser'/);
    assert.equal(/AND v\.demo_seed IS NULL/.test(loadExits), cols, "loadExits cutoff ignores sample visits");
    const bench = await sqlOf(() => computeDealBenchmarks("deal-s"));
    assert.match(bench[0], /NOT v\.self_view AND NOT v\.clamped AND v\.mode IS DISTINCT FROM 'teaser'/);
    assert.equal(/v\.superseded_by IS NULL/.test(bench[0]), cols);
    assert.equal(/v\.demo_seed IS NULL/.test(bench[0]), cols, "benchmarks never read sample reading");
  });
}
await test("profile-data: its three buyer_visits reads carry the same conditions (drizzle where clauses)", async () => {
  _setSampleColumnsForTest(true);
  assert.match(render(await profileVisitConditions()), /NOT buyer_visits\.self_view AND NOT buyer_visits\.clamped AND buyer_visits\.mode IS DISTINCT FROM 'teaser' AND buyer_visits\.superseded_by IS NULL/);
  selects = 0;
  const reads = await sqlOf(() => engagementByAccess(["a1"]));
  const visitReads = reads.filter((x) => /buyer_visits\.self_view/.test(x));
  assert.equal(visitReads.length, 2, "readingByAccess: visits + pages");
  assert.ok(visitReads.every((x) => /buyer_visits\.superseded_by IS NULL/.test(x)));
  const intent = await sqlOf(() => readingIntentByAccess([{ id: "a1", dealId: "deal-s" }]));
  assert.ok(intent.some((x) => /buyer_visits\.superseded_by IS NULL/.test(x)), "readingIntentByAccess");
  assert.match(render(cimVisitConditions("x", { sampleColumns: false })), /^NOT x\.self_view AND NOT x\.clamped AND x\.mode IS DISTINCT FROM 'teaser'$/);
});
await test("the column probe: one probe, a missing answer re-probed at most every minute", async () => {
  const { sampleColumns } = await import("../../server/engagement/demo-columns");
  let calls = 0;
  _setSampleColumnsForTest(null, async () => { calls++; return false; });
  assert.equal(await sampleColumns(), false);
  assert.equal(await sampleColumns(), false);
  assert.equal(calls, 1, "cached for a minute");
  assert.equal(await sampleColumns(Date.now() + 61_000), false);
  assert.equal(calls, 2, "re-probed after a minute");
  _setSampleColumnsForTest(null, async () => { calls++; return true; });
  assert.equal(await sampleColumns(), true);
  assert.equal(await sampleColumns(Date.now() + 3_600_000), true);
  assert.equal(calls, 3, "a yes is never re-probed");
  _resetSampleColumnsProbe();
});

console.log(`\n${passed} passed`);
process.exit(0);
