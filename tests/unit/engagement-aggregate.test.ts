/**
 * Aggregation end to end, in memory: view-room sends → ingest → the grouped
 * reads → DealReadingFacts → the broker responses (buyers, document heat map,
 * summary, journey) through the real routes. Blind and named buyers, several
 * visits, a chart hover, a self view, filters. No database, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/engagement-aggregate.test.ts
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { ingestReading, memoryReadingStore } from "../../server/analytics/reading-ingest";
import { buildPageIndex, renditionId } from "../../server/analytics/renditions";
import { memoryReadingSource } from "../../server/engagement/queries";
import type { ReadingPayload } from "../../shared/analytics-v2";
import type { BuyerSection } from "../../shared/cim-buyer-view";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

// ── A small CIM, served blind (teaser/full) and named (loi) ──────────────
const ids = {
  cover: "c0000000-0000-4000-8000-000000000000",
  fin: "f0000000-0000-4000-8000-000000000000",
  chart: "b0000000-0000-4000-8000-000000000000",
  team: "e0000000-0000-4000-8000-000000000000",
};
const S = (id: string, order: number, layoutType: string, sectionTitle: string, layoutData: unknown): BuyerSection => ({
  id, dealId: "deal1", sectionKey: `k_${order}`, sectionTitle, order, layoutType, layoutData, aiDraftContent: null, brokerEditedContent: null, isVisible: true,
});
const finData = { headers: ["", "2023", "2024"], rows: [{ label: "Revenue", values: ["$1.2M", "$1.4M"] }, { label: "Adjusted EBITDA", values: ["$300K", "$380K"] }, { label: "Net income", values: ["$200K", "$250K"] }] };
const chartData = { data: [{ name: "2022", value: 1 }, { name: "2023", value: 2 }, { name: "2024", value: 3 }] };
const named = [
  S(ids.cover, 0, "cover_page", "Harbourline Dental", {}),
  S(ids.fin, 1, "financial_table", "Harbourline Financial Performance", finData),
  S(ids.chart, 2, "bar_chart", "Revenue Growth", chartData),
  S(ids.team, 3, "metric_grid", "The Team", { metrics: [{ label: "Dentists", value: "3" }, { label: "Hygienists", value: "5" }] }),
];
const blind = named.map((s) => ({ ...s, sectionKey: `s_${s.id.slice(0, 12)}`, sectionTitle: s.sectionTitle.replace("Harbourline", "Project Coastal").replace("Harbourline Dental", "Project Coastal") }));
const design = { brokerage: { showDisclaimerPage: true, showContactPage: true } };
const T0 = new Date(Date.now() - 3 * 86_400_000);
const store = memoryReadingStore();
const live = named.map((s) => ({ ...s, analyticsLineage: null }));
const R = {
  blind: renditionId({ mode: "blind", variant: "full", design, sections: blind }),
  named: renditionId({ mode: "normal", variant: "full", design, sections: named }),
};
store.renditions.set(R.blind, { id: R.blind, dealId: "deal1", mode: "blind", variant: "full", createdAt: new Date(T0.getTime() - 86_400_000), pageIndex: buildPageIndex(blind, design, live) });
store.renditions.set(R.named, { id: R.named, dealId: "deal1", mode: "normal", variant: "full", createdAt: new Date(T0.getTime() - 86_400_000), pageIndex: buildPageIndex(named, design, live) });

const deals: any[] = [
  { id: "deal1", brokerId: "brokerA", businessName: "Harbourline Dental", isLive: true, ndaRequired: true, buyerDeepCheck: { results: { u1: { verdict: "strong", fitScore: 88 } } } },
];
const accesses: any[] = [
  { id: "accPE", dealId: "deal1", accessToken: "t1", buyerEmail: "pe@x.invalid", buyerName: "Jordan Lee", buyerCompany: "Harbor Capital", buyerType: "private_equity", buyerUserId: "u1", accessLevel: "full", ndaSigned: true, decision: "interested", createdAt: T0, firstViewedAt: T0, accessEvents: [], matchBreakdown: { criteriaMatched: 4, criteriaTested: 6 } },
  { id: "accStrat", dealId: "deal1", accessToken: "t2", buyerEmail: "st@x.invalid", buyerName: "Sam Park", buyerType: "strategic", accessLevel: "loi", ndaSigned: true, decision: "not_interested", createdAt: T0, firstViewedAt: T0, accessEvents: [] },
  { id: "accPhone", dealId: "deal1", accessToken: "t3", buyerEmail: "ph@x.invalid", buyerName: "Ari Phone", buyerType: "individual", accessLevel: "full", ndaSigned: true, decision: "interested", createdAt: T0, firstViewedAt: T0, accessEvents: [] },
  { id: "accNone", dealId: "deal1", accessToken: "t4", buyerEmail: "no@x.invalid", buyerName: "Not Yet", accessLevel: "full", ndaSigned: false, decision: "not_interested", createdAt: T0, firstViewedAt: null, accessEvents: [] },
];

let seq = 0;
const vid = () => `dddddddd-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
async function send(accessId: string, rendition: string, at: Date, blocks: ReadingPayload["blocks"], opts: Partial<ReadingPayload> & { self?: boolean } = {}) {
  const a = accesses.find((x) => x.id === accessId)!;
  const active = Object.values(blocks).reduce((s, v) => s + v[0] + v[1], 0) + 5_000;
  const p: ReadingPayload = {
    visitId: opts.visitId ?? vid(),
    renditionId: rendition,
    sentAt: at.toISOString(),
    device: opts.device ?? { w: 1440, h: 900, touch: false, dpr: 2 },
    visit: { wallMs: active + 10_000, activeMs: active, idleMs: 10_000, hiddenMs: 0, awayMs: 0, outsideMs: 5_000, maxPageIndex: opts.visit?.maxPageIndex ?? 3 },
    blocks,
    path: opts.path ?? { from: 0, entries: [] },
    events: opts.events ?? [],
  };
  const r = await ingestReading(store, { deal: { id: "deal1" }, access: { id: a.id, dealId: "deal1", accessLevel: a.accessLevel }, payload: p, now: at, selfView: !!opts.self, ipHash: "n", uaFamily: "Chrome/Mac" });
  assert.equal(r.status, 204, r.reason);
  return p.visitId;
}
const B = (page: string, key: string) => `${page}|${key}`;

// Jordan (PE, blind): two visits, studies the financials, hovers 2024 on the chart, switches to Normalized, jumps via the contents.
await send("accPE", R.blind, new Date(T0.getTime() + 600_000), {
  [B(ids.cover, "page")]: [4_000, 0, 5_000, 0],
  [B(ids.fin, "row:1")]: [60_000, 1_000, 70_000, 12_000],
  [B(ids.fin, "row:0")]: [20_000, 0, 70_000, 0],
  [B(ids.fin, "")]: [6_000, 0, 70_000, 0],
  [B(ids.chart, "chart")]: [15_000, 0, 20_000, 9_000],
  [B(ids.chart, "chart/point:2")]: [0, 0, 0, 8_000],
}, {
  path: { from: 0, entries: [[0, ids.cover], [4, ids.fin], [95, ids.chart]] },
  events: [
    { seq: 1, type: "nav", pageId: ids.cover, detail: `toc:${ids.fin}`, at: T0.toISOString() },
    { seq: 2, type: "financial_view", pageId: ids.fin, detail: "normalized", at: T0.toISOString() },
  ],
  visit: { maxPageIndex: 3 } as any,
});
await send("accPE", R.blind, new Date(T0.getTime() + 2 * 86_400_000), { [B(ids.fin, "row:1")]: [30_000, 0, 35_000, 0] }, { path: { from: 0, entries: [[0, ids.fin]] }, visit: { maxPageIndex: 2 } as any });
// Sam (strategic, named): one visit, skims fast, reads the team.
await send("accStrat", R.named, new Date(T0.getTime() + 3_600_000), {
  [B(ids.cover, "page")]: [2_000, 0, 2_000, 0],
  [B(ids.fin, "row:0")]: [1_500, 6_000, 8_000, 0],
  [B(ids.team, "metric:0")]: [12_000, 0, 12_000, 0],
  [B(ids.team, "metric:1")]: [9_000, 0, 9_000, 0],
}, { visit: { maxPageIndex: 5 } as any });
// Ari (phone): only the cover.
await send("accPhone", R.blind, new Date(T0.getTime() + 7_200_000), { [B(ids.cover, "page")]: [3_500, 0, 4_000, 0] }, { device: { w: 390, h: 844, touch: true, dpr: 3 }, visit: { maxPageIndex: 0 } as any });
// The broker previewing (self view): never counted.
await send("accPE", R.blind, new Date(T0.getTime() + 7_300_000), { [B(ids.team, "metric:0")]: [500_000, 0, 500_000, 0] }, { self: true });

// ── Routes over the in-memory data ────────────────────────────────────────
const questions = [{ id: "q1", accessId: "accPE", text: "Is the lease transferable?", askedAt: new Date(T0.getTime() + 700_000), pageId: ids.fin, status: "pending_broker", answered: false }];
const { storage } = await import("../../server/storage");
Object.assign(storage as any, {
  getDeal: async (id: string) => deals.find((d) => d.id === id),
  getAllDeals: async (b?: string) => deals.filter((d) => d.brokerId === b),
  getBuyerAccess: async (id: string) => accesses.find((a) => a.id === id),
  getBuyerAccessByDeal: async (dealId: string) => accesses.filter((a) => a.dealId === dealId),
  getCimSectionsByDeal: async () => live,
  updateBuyerAccess: async (id: string, patch: any) => Object.assign(accesses.find((a) => a.id === id), patch),
});
const { setReadingSource } = await import("../../server/engagement/facts");
setReadingSource(memoryReadingSource(store, {
  questions,
  decisions: [{ accessId: "accPE", decision: "interested", at: new Date(T0.getTime() + 86_400_000) }],
  sections: new Map([[R.blind, blind], [R.named, named]]),
}));
const { registerEngagementRoutes } = await import("../../server/routes/engagement");
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as any).session = { brokerId: "brokerA" }; next(); });
registerEngagementRoutes(app);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const get = async (u: string) => {
  const r = await fetch(`http://127.0.0.1:${port}${u}`);
  assert.equal(r.status, 200, u);
  return r.json() as Promise<any>;
};

try {
  console.log("document (the heat map)");
  const doc = await get("/api/deals/deal1/engagement/document");
  await test("drawn on the latest version with reading; pages in order with real titles", () => {
    assert.ok(doc.rendition);
    assert.equal(doc.pages.length, 6, "cover, disclaimer, 3 sections, contact");
    assert.deepEqual(doc.pages.map((p: any) => p.label), ["1", "2", "3", "4", "5", "6"]);
    const fin = doc.pages.find((p: any) => p.pageId === ids.fin);
    assert.equal(fin.title, "Harbourline Financial Performance");
    if (doc.rendition.mode === "blind") assert.equal(fin.servedTitle, "Project Coastal Financial Performance");
  });
  await test("blind and named reading merge (same structure); self views never count", () => {
    const fin = doc.pages.find((p: any) => p.pageId === ids.fin);
    assert.equal(fin.attentionMs, 60_000 + 20_000 + 6_000 + 30_000 + 1_500);
    assert.equal(fin.readers, 1, "Sam's 1.5 s skim isn't reading");
    assert.equal(fin.reachedBy, 2, "Jordan and Sam got that far; Ari stopped at the cover");
    const team = doc.pages.find((p: any) => p.pageId === ids.team);
    assert.equal(team.attentionMs, 21_000, "the broker's 500 s preview is excluded");
    assert.equal(doc.openedBy, 3);
  });
  await test("parts: seconds, readers, top buyer, most-pointed chart point, skim share", () => {
    const fin = doc.pages.find((p: any) => p.pageId === ids.fin);
    const ebitda = fin.blocks.find((b: any) => b.key === "row:1");
    assert.equal(ebitda.label, "Row: Adjusted EBITDA");
    assert.equal(ebitda.attentionMs, 90_000);
    assert.equal(ebitda.topBuyer.name, "Jordan Lee");
    assert.equal(ebitda.readers, 1);
    const revenue = fin.blocks.find((b: any) => b.key === "row:0");
    assert.equal(revenue.readers, 2);
    assert.ok(revenue.skimShare > 0.2);
    const chart = doc.pages.find((p: any) => p.pageId === ids.chart).blocks.find((b: any) => b.key === "chart");
    assert.equal(chart.topPoint.label, "2024");
    assert.equal(chart.topPoint.pointerMs, 8_000);
    assert.ok(!doc.pages.some((p: any) => p.blocks.some((b: any) => /point:/.test(b.key))), "chart points fold into their chart");
  });
  await test("what they did and asked on the page", () => {
    const fin = doc.pages.find((p: any) => p.pageId === ids.fin);
    assert.equal(fin.interactions.financial_view, 1);
    assert.equal(fin.questions.length, 1);
    assert.equal(fin.questions[0].name, "Jordan Lee");
    assert.equal(doc.pages.find((p: any) => p.pageId === ids.cover).interactions.nav, 1);
  });
  await test("how far buyers got, by kind, totals", () => {
    assert.deepEqual(doc.reach.map((r: any) => r.buyers), [3, 2, 2, 2, 1, 1]);
    const tables = doc.byKind.find((k: any) => k.group === "tables");
    assert.equal(tables.attentionMs, 111_500, "rows only: time elsewhere on the page is not a part");
    assert.ok(tables.expectedMs > 0);
    assert.equal(doc.totals.readers, 3);
    assert.equal(doc.totals.visits, 4);
  });

  console.log("buyers, summary, journey");
  const buyers = await get("/api/deals/deal1/engagement/buyers");
  await test("cards: strip per page, pages reached, visits, fit; not-opened listed apart", () => {
    assert.equal(buyers.buyers.length, 3);
    assert.deepEqual(buyers.notOpened.map((b: any) => b.accessId), ["accNone"]);
    const jordan = buyers.buyers.find((b: any) => b.accessId === "accPE");
    assert.equal(jordan.visits, 2);
    assert.equal(jordan.pageStrip.length, 6);
    assert.equal(jordan.pageStrip.find((c: any) => c.pageId === ids.fin).attentionMs, 116_000);
    assert.equal(jordan.pageStrip[4].reached, false, "never got to the team page");
    assert.equal(jordan.pagesReached, 4);
    assert.deepEqual(jordan.fit, { criteriaMatched: 4, criteriaTotal: 6, deepCheckVerdict: "strong", deepCheckFit: 88 });
    const ari = buyers.buyers.find((b: any) => b.accessId === "accPhone");
    assert.equal(ari.pagesReached, 1);
  });
  await test("filters: device, buyers, segment, range", async () => {
    const phone = await get("/api/deals/deal1/engagement/document?device=phone");
    assert.equal(phone.openedBy, 1);
    const one = await get("/api/deals/deal1/engagement/document?buyers=accStrat");
    assert.equal(one.pages.find((p: any) => p.pageId === ids.fin).attentionMs, 1_500);
    const interested = await get("/api/deals/deal1/engagement/buyers?segment=interested");
    assert.deepEqual(interested.buyers.map((b: any) => b.accessId).sort(), ["accPE", "accPhone"]);
    const week = await get("/api/deals/deal1/engagement/document?range=7d");
    assert.equal(week.openedBy, 3);
    const pe = await get("/api/deals/deal1/engagement/buyers?segment=type:private_equity");
    assert.deepEqual(pe.buyers.map((b: any) => b.accessId), ["accPE"]);
  });
  await test("summary: pulse, most studied page (never the cover)", async () => {
    const s = await get("/api/deals/deal1/engagement/summary");
    assert.equal(s.pulse.granted, 4);
    assert.equal(s.pulse.opened, 3);
    assert.equal(s.mostStudiedPage.title, "Harbourline Financial Performance");
    assert.equal(s.published, true);
    assert.ok(s.renditions.length === 2);
  });
  await test("journey: visits latest first, path segments with durations and jumps, decisions", async () => {
    const j = await get("/api/deals/deal1/engagement/buyers/accPE/journey");
    assert.equal(j.visits.length, 2);
    const first = j.visits[1];
    assert.deepEqual(first.path.map((s: any) => [s.label, s.startSec, s.durationSec]), [["1", 0, 4], ["3", 4, 91], ["4", 95, first.path[2].durationSec]]);
    assert.equal(first.path[1].via, "toc");
    assert.equal(first.pagesReached, 3);
    assert.equal(j.decisions[0].decision, "interested");
    assert.equal(j.questions.length, 1);
  });
  await test("rendition: served sections + real titles for the viewer; another deal's id is 404", async () => {
    const r = await get(`/api/deals/deal1/engagement/renditions/${R.blind}`);
    assert.equal(r.mode, "blind");
    assert.equal(r.sections.length, 4);
    assert.equal(r.pages.find((p: any) => p.pageId === ids.fin).servedTitle, "Project Coastal Financial Performance");
    assert.equal(r.realTitles[ids.fin], "Harbourline Financial Performance");
    store.renditions.set("e".repeat(32), { id: "e".repeat(32), dealId: "deal2", mode: "blind", variant: "full", createdAt: T0, pageIndex: [] });
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/deals/deal1/engagement/renditions/${"e".repeat(32)}`)).status, 404);
  });
} finally {
  server.close();
}

console.log(`\n${passed} passed`);
process.exit(0);
