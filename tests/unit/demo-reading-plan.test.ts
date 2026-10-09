/**
 * The sample-reading planner for the fictional example deals
 * (server/engagement/demo-reading.ts; heat-map spec §5.6). Pure: no DB, no
 * AI. Pages are built by the real page indexer over real layouts (a
 * financial table with a Normalized view, a chart, a metric grid, a
 * collapsible callout list, prose).
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled node_modules/.bin/tsx tests/unit/demo-reading-plan.test.ts
 */
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  DEMO_READING_TAG, applyRemovalInMemory, apportion, checkPlanTotals, demoDevice, kindWeight, planDemoReading, planRemoval,
  readingDepth, refuseReason, removalSql, splitPage, type DemoInput, type DemoMemoryTables,
} from "../../server/engagement/demo-reading";
import { buildPageIndex } from "../../server/analytics/renditions";
import { isValidBlockKey } from "../../shared/cim-blocks";
import type { RenditionPage } from "../../shared/analytics-v2";
import type { BuyerSection } from "../../shared/cim-buyer-view";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

// ── A small served CIM ───────────────────────────────────────────────────
const S = (id: string, order: number, title: string, layoutType: string, layoutData: Record<string, unknown>): BuyerSection => ({
  id, dealId: "deal-A", sectionKey: `k_${id}`, sectionTitle: title, order, layoutType, layoutData,
  aiDraftContent: null, brokerEditedContent: null, isVisible: true,
});
const money = (n: number) => `$${n.toLocaleString("en-CA")}`;
const SECTIONS: BuyerSection[] = [
  S("s-over", 0, "Business Overview", "prose_highlight", { body: "Pacific moves chilled freight for grocers across the Lower Mainland.\n\nIt runs 46 tractors and 70 reefer trailers from one yard.\n\nThe owner plans a two-year transition.", highlights: [{ title: "Founded", text: "1998" }] }),
  S("s-fin", 1, "Historical Financial Performance", "financial_table", {
    headers: ["", "FY2022", "FY2023", "FY2024"],
    rows: [
      { label: "Revenue", values: [money(14_200_000), money(15_900_000), money(17_400_000)] },
      { label: "Cost of goods sold", values: [money(9_100_000), money(10_000_000), money(10_800_000)] },
      { label: "Gross profit", values: [money(5_100_000), money(5_900_000), money(6_600_000)] },
      { label: "Operating expenses", values: [money(2_400_000), money(2_600_000), money(2_800_000)] },
      { label: "Adjusted EBITDA", values: [money(2_700_000), money(3_300_000), money(3_900_000)] },
    ],
    normalizedRows: [{ label: "Owner salary add-back", values: ["$165,000", "$165,000", "$165,000"], isAdjusted: true }],
  }),
  S("s-chart", 2, "Revenue Growth Trajectory", "bar_chart", { data: [{ name: "FY2022", value: 14.2 }, { name: "FY2023", value: 15.9 }, { name: "FY2024", value: 17.4 }] }),
  S("s-metrics", 3, "Fleet Assets & Composition", "metric_grid", { metrics: [{ label: "Tractors", value: "46" }, { label: "Reefer trailers", value: "70" }, { label: "Average age", value: "4.2 yrs" }, { label: "Cash on hand", value: "$1.1M" }] }),
  S("s-more", 4, "Growth Opportunities", "callout_list", { expandable: true, summary: "Three ways to grow without new capital.", items: [1, 2, 3, 4, 5, 6].map((n) => ({ title: `Opportunity ${n}`, description: "A longer description of what the buyer could do next, with the numbers behind it." })) }),
];
const design = { brokerage: { showDisclaimerPage: true, showContactPage: true } };
const PAGES: RenditionPage[] = buildPageIndex(SECTIONS, design, []);
const pageOf = (id: string) => PAGES.find((p) => p.pageId === id)!;

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 7, h, m));
const buyers: DemoInput["buyers"] = [
  { id: "a-strong", name: "Gurdeep Randhawa", buyerType: "private_equity", accessLevel: "full", decision: "interested", email: "g@x.invalid" },
  { id: "a-mid", name: "Lillian Cho", buyerType: "individual", accessLevel: "full", decision: null, email: "l@x.invalid" },
  { id: "a-weak", name: "Julien Tremblay", buyerType: "strategic", accessLevel: "full", decision: "not_interested", email: "j@x.invalid" },
  { id: "a-none", name: "Wei Zhang", buyerType: "individual", accessLevel: "full", decision: "not_interested", email: "w@x.invalid" },
];
const visits: DemoInput["visits"] = [
  { id: "lv-1", accessId: "a-strong", startedAt: at(10), lastSeenAt: at(10, 50), wallMs: 3_000_000, activeMs: 2_400_000, path: [[0, "k_s-over"], [200, "k_s-fin"], [900, "k_s-chart"], [1100, "k_s-over"], [1200, "k_s-more"], [1500, "k_s-metrics"]] },
  { id: "lv-2", accessId: "a-strong", startedAt: at(14), lastSeenAt: at(14, 20), wallMs: 1_200_000, activeMs: 1_000_000, path: [[0, "k_s-fin"]] },
  { id: "lv-3", accessId: "a-mid", startedAt: at(11), lastSeenAt: at(11, 20), wallMs: 1_200_000, activeMs: 700_000, path: [[0, "k_s-over"], [300, "k_s-fin"], [600, "gone_page"]] },
  { id: "lv-4", accessId: "a-weak", startedAt: at(12), lastSeenAt: at(12, 5), wallMs: 300_000, activeMs: 120_000, path: [[0, "k_s-over"], [60, "k_s-fin"]] },
];
const pages: DemoInput["pages"] = [
  { visitId: "lv-1", accessId: "a-strong", pageId: "k_s-over", lineageId: null, attentionMs: 180_000 },
  { visitId: "lv-1", accessId: "a-strong", pageId: "k_s-fin", lineageId: null, attentionMs: 640_337 },
  { visitId: "lv-1", accessId: "a-strong", pageId: "k_s-chart", lineageId: null, attentionMs: 190_001 },
  { visitId: "lv-1", accessId: "a-strong", pageId: "k_s-more", lineageId: null, attentionMs: 260_000 },
  { visitId: "lv-1", accessId: "a-strong", pageId: "k_s-metrics", lineageId: null, attentionMs: 95_555 },
  { visitId: "lv-2", accessId: "a-strong", pageId: "k_s-fin", lineageId: null, attentionMs: 610_000 },
  { visitId: "lv-3", accessId: "a-mid", pageId: "k_s-over", lineageId: null, attentionMs: 120_000 },
  { visitId: "lv-3", accessId: "a-mid", pageId: "k_s-fin", lineageId: null, attentionMs: 210_000 },
  { visitId: "lv-3", accessId: "a-mid", pageId: "gone_page", lineageId: null, attentionMs: 45_000 },
  { visitId: "lv-4", accessId: "a-weak", pageId: "k_s-over", lineageId: null, attentionMs: 50_000 },
  { visitId: "lv-4", accessId: "a-weak", pageId: "k_s-fin", lineageId: null, attentionMs: 30_000 },
];
const byKey = new Map(SECTIONS.map((s) => [s.sectionKey, s.id]));
const input: DemoInput = {
  tag: DEMO_READING_TAG,
  deal: { id: "deal-A", demoKey: "pacific-coast-logistics", businessName: "Pacific Coast Logistics Ltd." },
  buyers, visits, pages,
  served: { full: { renditionId: "r-full", pages: PAGES } },
  place: (_level, pageId) => (byKey.has(pageId) ? pageOf(byKey.get(pageId)!) : null),
};
const plan = planDemoReading(input);
const rowsOf = (visitId: string, pageId: string) => plan.rollups.filter((r) => r.visitId === visitId && r.pageId === pageId);
const sampleIdOf = (legacy: string) => plan.visits.find((v) => v.legacyVisitId === legacy)!.id;

console.log("sample reading planner");
test("per (visit, page): Σ attention over the parts + the page remainder = the old total, to the millisecond", () => {
  for (const p of pages) {
    const id = byKey.get(p.pageId);
    if (!id) continue;
    const got = rowsOf(sampleIdOf(p.visitId), id).reduce((s, r) => s + r.attentionMs, 0);
    assert.equal(got, p.attentionMs, `${p.visitId} ${p.pageId}`);
  }
  assert.deepEqual(checkPlanTotals(input, plan), []);
});
test("skim time is added in the spec's proportions (skim / (attention + skim) = 0.06 + 0.5·(1 − depth)², headings ½)", () => {
  const v = plan.visits.find((x) => x.legacyVisitId === "lv-4")!;
  const depth = plan.perBuyer.find((b) => b.accessId === "a-weak")!.depth;
  const text = plan.rollups.filter((r) => r.visitId === v.id && r.attentionMs > 5_000 && r.blockKey.startsWith("para"))[0];
  assert.ok(text, "a paragraph with reading");
  assert.ok(Math.abs(text.skimMs / (text.attentionMs + text.skimMs) - (0.06 + 0.5 * (1 - depth) ** 2)) < 0.02);
  for (const r of plan.rollups.filter((x) => x.blockKey === "heading" && x.attentionMs > 2000)) {
    assert.ok(Math.abs(r.skimMs / (r.attentionMs + r.skimMs) - 0.5) < 0.05);
  }
});
test("identical output on a re-run (deterministic ids and splits)", () => {
  assert.deepEqual(planDemoReading(input), plan);
});
test("every page id is on its version, every block key valid and on that page; visible ≥ attention", () => {
  for (const r of plan.rollups) {
    if (r.renditionId === null) continue;
    const p = pageOf(r.pageId);
    assert.ok(p, r.pageId);
    if (r.blockKey === "") continue;
    assert.ok(isValidBlockKey(r.blockKey), r.blockKey);
    assert.ok(p.blocks.some((b) => b.key === r.blockKey), `${r.pageId}|${r.blockKey}`);
    assert.ok(r.visibleMs >= r.attentionMs, `${r.blockKey} visible`);
  }
});
test("strong buyers put a larger share on numbers and read further down a page than weak ones", () => {
  const share = (visit: string) => {
    const rows = rowsOf(sampleIdOf(visit), "s-fin").filter((r) => r.blockKey);
    const total = rows.reduce((s, r) => s + r.attentionMs, 0);
    const numbers = rows.filter((r) => r.blockKey.startsWith("row:")).reduce((s, r) => s + r.attentionMs, 0);
    const lower = rows.filter((r) => /^row:[3-9]/.test(r.blockKey)).reduce((s, r) => s + r.attentionMs, 0);
    return { numbers: numbers / total, lower: lower / total };
  };
  const strong = share("lv-2"), weak = share("lv-4");
  assert.ok(strong.numbers > weak.numbers, `numbers ${strong.numbers} vs ${weak.numbers}`);
  assert.ok(strong.lower > weak.lower, `lower rows ${strong.lower} vs ${weak.lower}`);
});
test("headings get under 3% of the reading; the Normalized view's rows never get time", () => {
  const total = plan.rollups.reduce((s, r) => s + r.attentionMs, 0);
  const headings = plan.rollups.filter((r) => r.blockKey === "heading").reduce((s, r) => s + r.attentionMs, 0);
  assert.ok(headings / total < 0.03, `headings ${headings / total}`);
  assert.ok(!plan.rollups.some((r) => r.blockKey.startsWith("nrow:")), "no normalized rows");
  assert.ok(pageOf("s-fin").blocks.some((b) => b.key.startsWith("nrow:")), "(the fixture has a Normalized view)");
});
test("a collapsible section: a strong reader with time to spare opens it (one expand event; summary 15%); a weak one reads only the heading and summary", () => {
  const strongMore = rowsOf(sampleIdOf("lv-1"), "s-more");
  assert.ok(strongMore.some((r) => r.blockKey.startsWith("item:")), "opened: the items have time");
  const summary = strongMore.find((r) => r.blockKey === "summary")!;
  const body = strongMore.reduce((s, r) => s + r.attentionMs, 0) - strongMore.find((r) => r.blockKey === "")!.attentionMs;
  assert.ok(Math.abs(summary.attentionMs / body - 0.15) < 0.005);
  assert.equal(plan.events.filter((e) => e.type === "expand" && e.pageId === "s-more").length, 1);
  const weak = splitPage(pageOf("s-more"), 60_000, 0.2, false, "x");
  assert.deepEqual(weak.rows.map((r) => r.key).sort(), ["heading", "summary"]);
  assert.equal(weak.expanded, false);
});
test("only 'nav' and 'expand' events — no locked pages, normalized figures, maps, copy, print, contact or chat", () => {
  assert.ok(plan.events.length > 0);
  assert.ok(plan.events.every((e) => e.type === "nav" || e.type === "expand"));
  for (const e of plan.events.filter((x) => x.type === "nav")) assert.match(e.detail!, /^toc:s-/);
  // lv-1 jumps back from the chart to the overview: a contents jump.
  assert.ok(plan.events.some((e) => e.visitId === sampleIdOf("lv-1") && e.type === "nav" && e.pageId === "s-chart" && e.detail === "toc:s-over"));
});
test("event times are inside the visit and created_at = at; seq counts up within each visit", () => {
  for (const v of plan.visits) {
    const evs = plan.events.filter((e) => e.visitId === v.id);
    evs.forEach((e, i) => {
      assert.equal(e.seq, i + 1);
      assert.ok(e.at >= v.startedAt && e.at <= v.lastSeenAt);
    });
  }
});
test("every seeded buyer has exactly one device/browser and one network key (so 'opened from several places' can't fire)", () => {
  const by = new Map<string, Set<string>>();
  for (const v of plan.visits) by.set(v.accessId, new Set([...(by.get(v.accessId) ?? []), `${v.deviceClass}|${v.uaFamily}|${v.ipHash}`]));
  by.forEach((set, id) => assert.equal(set.size, 1, id));
  assert.equal(new Set(plan.visits.map((v) => v.ipHash)).size, 3, "one key per buyer");
  assert.ok(plan.visits.every((v) => /^demo[0-9a-f]{20}$/.test(v.ipHash)), "a hash of ids, never an address");
  assert.deepEqual(demoDevice("deal-A", "a-strong"), demoDevice("deal-A", "a-strong"));
});
test("old time on a page this version doesn't have is kept as an old-key row (no version) on the sample visit", () => {
  const row = plan.rollups.find((r) => r.pageId === "gone_page")!;
  assert.equal(row.renditionId, null);
  assert.equal(row.blockKey, "");
  assert.equal(row.attentionMs, 45_000);
  assert.equal(row.visitId, sampleIdOf("lv-3"));
  assert.deepEqual(plan.unplaced, [{ key: "gone_page", ms: 45_000, visits: 1 }]);
  assert.deepEqual(plan.visits.find((v) => v.legacyVisitId === "lv-3")!.path.map(([, p]) => p), ["s-over", "s-fin"], "unplaced steps dropped from the path");
});
test("sample visits copy the old clocks; one per old visit; the old ones are hidden; a buyer with no reading is listed", () => {
  assert.equal(plan.visits.length, 4);
  for (const v of plan.visits) {
    const o = visits.find((x) => x.id === v.legacyVisitId)!;
    assert.equal(v.activeMs, o.activeMs);
    assert.equal(v.wallMs, o.wallMs);
    assert.equal(v.startedAt.getTime(), o.startedAt.getTime());
    assert.equal(v.demoSeed, DEMO_READING_TAG);
  }
  assert.deepEqual(plan.supersede.sort(), ["lv-1", "lv-2", "lv-3", "lv-4"]);
  assert.deepEqual(plan.skipped, [{ accessId: "a-none", why: "no reading recorded, so nothing to convert" }]);
  assert.equal(plan.visits.find((v) => v.legacyVisitId === "lv-1")!.maxPageIndex, pageOf("s-more").order);
});
test("chart points get pointer time only (attention stays on the chart)", () => {
  const pts = plan.rollups.filter((r) => r.blockKey.startsWith("chart/point:"));
  assert.ok(pts.length > 0);
  assert.ok(pts.every((r) => r.attentionMs === 0 && r.pointerMs >= 1500 && r.pointerMs <= 8000));
});
test("readingDepth: rank of time 0.5 + decision 0.3 + visits 0.2", () => {
  const totals = new Map([["a", 100], ["b", 50], ["c", 10]]);
  const visitsBy = new Map([["a", 4], ["b", 1], ["c", 1]]);
  const all = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(readingDepth({ id: "a", decision: "interested" }, all, totals, visitsBy), 0.5 + 0.3 * 0.85 + 0.2);
  assert.equal(readingDepth({ id: "c", decision: "not_interested" }, all, totals, visitsBy), 0.3 * 0.15 + 0.2 * 0.25);
});
test("kindWeight: headings light, key-figure rows heaviest", () => {
  assert.equal(kindWeight({ kind: "heading", label: "Title: Revenue", key: "heading" }), 0.12);
  assert.equal(kindWeight({ kind: "table", label: "Row: Adjusted EBITDA", key: "row:4" }), 2.4);
  assert.equal(kindWeight({ kind: "table", label: "Row: Tractors", key: "row:1" }), 1.6);
  assert.equal(kindWeight({ kind: "table", label: "Table header", key: "head" }), 0.4);
  assert.equal(kindWeight({ kind: "metric", label: "Cash on hand", key: "metric:3" }), 2.2);
});
test("apportion: integers that sum exactly", () => {
  const out = apportion(1001, [1, 1, 1]);
  assert.equal(out.reduce((s, x) => s + x, 0), 1001);
  assert.deepEqual(apportion(10, [0, 0]), [10, 0]);
});

console.log("refusals");
const deal = { id: "deal-A", businessName: "Pacific Coast Logistics Ltd.", demoKey: "pacific-coast-logistics" };
const okBuyers = [{ email: "a@x.invalid" }];
test("an example deal of broker_demo or qa_cimgen with fictional buyers and only old reading may be seeded", () => {
  assert.equal(refuseReason(deal, "broker_demo", okBuyers, 0, { ANTHROPIC_API_KEY: "disabled" }), null);
  assert.equal(refuseReason(deal, "qa_cimgen", okBuyers, 0, { ANTHROPIC_API_KEY: "unused" }), null);
});
test("each refusal", () => {
  const r = (d = deal, owner = "broker_demo", b = okBuyers, real = 0, env: { ANTHROPIC_API_KEY?: string } = { ANTHROPIC_API_KEY: "disabled" }) => refuseReason(d, owner, b, real, env);
  assert.match(r(deal, "broker_demo", okBuyers, 0, { ANTHROPIC_API_KEY: "sk-ant-live" })!, /ANTHROPIC_API_KEY=disabled/);
  assert.match(r({ ...deal, demoKey: null })!, /isn't an example deal/);
  assert.match(r(deal, "someone_else")!, /only for the example deals/);
  assert.match(r({ ...deal, businessName: "SariKnotSari" })!, /real deal/);
  assert.match(r({ ...deal, businessName: "180 Smoke Vape" })!, /real deal/);
  assert.match(r({ ...deal, id: "216f9bee-6bf3-4b51-8f51-bc42bbf69c83" })!, /real deal/);
  assert.match(r(deal, "broker_demo", [{ email: "someone@gmail.com" }])!, /real email address/);
  assert.match(r(deal, "broker_demo", okBuyers, 3)!, /already read this CIM part by part \(3 visits\)/);
});

console.log("removal");
test("planRemoval touches only deal A's rows: every statement is scoped to the deal", () => {
  const rm = planRemoval("deal-A", DEMO_READING_TAG);
  const d = new PgDialect();
  for (const step of rm.steps) {
    const { sql: text, params } = d.sqlToQuery(removalSql(step, ["r-serving"]));
    assert.match(text, /deal_id = \$\d/, step.op);
    assert.ok(params.includes("deal-A"), step.op);
    assert.ok(!/^\s*(DELETE|UPDATE)[^]*WHERE\s+demo_seed/i.test(text) || /deal_id/.test(text), step.op);
  }
  assert.throws(() => planRemoval("", DEMO_READING_TAG));
});
test("in memory: deal A's sample rows go and its old visits come back; deal B's rows survive; a version still used is kept untagged", () => {
  const t: DemoMemoryTables = {
    visits: [
      { id: "s1", dealId: "deal-A", demoSeed: DEMO_READING_TAG, supersededBy: null, renditionId: "rA" },
      { id: "l1", dealId: "deal-A", demoSeed: null, supersededBy: DEMO_READING_TAG, renditionId: null },
      { id: "real", dealId: "deal-A", demoSeed: null, supersededBy: null, renditionId: "rA2" },
      { id: "s2", dealId: "deal-B", demoSeed: DEMO_READING_TAG, supersededBy: null, renditionId: "rB" },
      { id: "l2", dealId: "deal-B", demoSeed: null, supersededBy: DEMO_READING_TAG, renditionId: null },
    ],
    rollups: [{ visitId: "s1", dealId: "deal-A" }, { visitId: "real", dealId: "deal-A" }, { visitId: "s2", dealId: "deal-B" }],
    events: [{ visitId: "s1", dealId: "deal-A", renditionId: "rA" }, { visitId: "s2", dealId: "deal-B", renditionId: "rB" }],
    renditions: [
      { id: "rA", dealId: "deal-A", demoSeed: DEMO_READING_TAG },
      { id: "rA2", dealId: "deal-A", demoSeed: DEMO_READING_TAG },   // a real visit uses it now
      { id: "rA3", dealId: "deal-A", demoSeed: DEMO_READING_TAG },   // served right now
      { id: "rA4", dealId: "deal-A", demoSeed: null },               // not the seed's
      { id: "rB", dealId: "deal-B", demoSeed: DEMO_READING_TAG },
    ],
  };
  const res = applyRemovalInMemory(t, planRemoval("deal-A", DEMO_READING_TAG), new Set(["rA3"]));
  assert.deepEqual(t.visits.map((v) => [v.id, v.supersededBy]), [["l1", null], ["real", null], ["s2", null], ["l2", DEMO_READING_TAG]]);
  assert.deepEqual(t.rollups.map((r) => r.visitId), ["real", "s2"]);
  assert.deepEqual(t.events.map((e) => e.visitId), ["s2"]);
  assert.deepEqual(t.renditions.map((r) => [r.id, r.demoSeed]), [["rA2", null], ["rA3", null], ["rA4", null], ["rB", DEMO_READING_TAG]]);
  assert.deepEqual(res.keptVersions.sort(), ["rA2", "rA3"]);
});

console.log(`\n${passed} passed`);
