/**
 * Analytics ship notes integrator step 11 (checker AN2-7), proved on the
 * merged tree (teaser + heatmap + analytics): a deal whose only rendition is
 * the teaser's has no CIM pages anywhere —
 *   - the facts loader never picks a teaser rendition and never counts a
 *     teaser visit (cimVisitConditions + renditions(kind "cim"));
 *   - the Engagement Document view draws no teaser pages;
 *   - the Analytics Deals tab shows "—" for How far (never "0 of 7"), and
 *     the teaser-only link is not a CIM link in any number.
 * In-memory reading store; no database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-teaser-renditions.test.ts
 */
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { loadDealReadingFacts, setReadingSource, _setLiveRenditionForTests } from "../../server/engagement/facts";
import { buildDocumentResponse } from "../../server/engagement/responses";
import { memoryReadingSource } from "../../server/engagement/queries";
import { _setSampleColumnsForTest } from "../../server/engagement/demo-columns";
import { memoryReadingStore } from "../../server/analytics/reading-ingest";
import { buildPageIndex } from "../../server/analytics/renditions";
import { dealRows } from "../../server/analytics-dashboard/deals";
import { computeKpis } from "../../server/analytics-dashboard/kpis";
import { DEFAULT_ENGAGEMENT_FILTERS } from "../../shared/analytics-v2";
import type { BuyerSection } from "../../shared/cim-buyer-view";
import { NOW, accessOf, dealOf } from "./fixtures/analytics-fixtures";

const at = (m: number) => new Date(NOW.getTime() - (600 - m) * 60_000);
const SECS: BuyerSection[] = [
  { id: "t-head", dealId: "deal-t", sectionKey: "opportunity", sectionTitle: "The opportunity", order: 0, layoutType: "prose_highlight", layoutData: { text: "A profitable regional carrier." }, aiDraftContent: null, brokerEditedContent: null, isVisible: true },
  { id: "t-nums", dealId: "deal-t", sectionKey: "key_numbers", sectionTitle: "Key numbers", order: 1, layoutType: "metric_grid", layoutData: { metrics: [{ label: "Revenue", value: "$15M–$20M" }] }, aiDraftContent: null, brokerEditedContent: null, isVisible: true },
];
const TEASER_PAGES = buildPageIndex(SECS, { brokerage: { showDisclaimerPage: false, showContactPage: false } }, []);

const s = storage as any;
s.getBuyerAccessByDeal = async () => [
  { id: "t1", dealId: "deal-t", buyerEmail: "t1@x.invalid", buyerName: "Tess Teaser", accessLevel: "teaser_only", decision: null, createdAt: at(0), accessEvents: [], firstViewedAt: null },
  { id: "b1", dealId: "deal-t", buyerEmail: "b1@x.invalid", buyerName: "Bo Blind", accessLevel: "full", decision: null, createdAt: at(0), accessEvents: [], firstViewedAt: null },
];
s.getCimSectionsByDeal = async () => [];
_setLiveRenditionForTests(async () => null);
_setSampleColumnsForTest(true);

const store = memoryReadingStore();
store.renditions.set("rt", { id: "rt", dealId: "deal-t", mode: "teaser", variant: "teaser", createdAt: at(1), pageIndex: TEASER_PAGES } as any);
store.visits.set("vt", {
  id: "vt", dealId: "deal-t", buyerAccessId: "t1", renditionId: "rt", mode: "teaser", startedAt: at(2), lastSeenAt: at(6), wallMs: 240_000, activeMs: 180_000,
  idleMs: 0, hiddenMs: 0, awayMs: 0, outsideMs: 0, maxPageIndex: 1, selfView: false, clamped: false, accessLevel: "teaser_only",
  viewportW: 1440, viewportH: 900, uaFamily: "Chrome/Mac", ipHash: "t", deviceClass: "desktop", path: [[0, TEASER_PAGES[0].pageId], [60, TEASER_PAGES[1].pageId]],
} as any);
store.rollups.set(`vt|${TEASER_PAGES[1].pageId}|metric:0`, { visitId: "vt", pageId: TEASER_PAGES[1].pageId, blockKey: "metric:0", dealId: "deal-t", buyerAccessId: "t1", renditionId: "rt", lineageId: null, attentionMs: 90_000, skimMs: 0, visibleMs: 90_000, pointerMs: 0, at: at(4) } as any);
setReadingSource(memoryReadingSource(store));

const deal = { id: "deal-t", businessName: "Teaser Proof Logistics", buyerDeepCheck: null, isLive: true } as any;
const facts = await loadDealReadingFacts(deal, DEFAULT_ENGAGEMENT_FILTERS, NOW);

assert.equal(facts.renditions.length, 0, "the teaser rendition is never a CIM version");
assert.equal(facts.pages.length, 0, "no CIM pages: the teaser's blocks are not the CIM's");
assert.deepEqual(facts.buyers.map((b) => b.accessId), ["b1"], "only the CIM link (seesCim); the teaser link is not a CIM buyer");
assert.equal(facts.buyers[0].visits.length, 0, "the teaser visit never counts as CIM reading");

const doc = buildDocumentResponse(facts);
assert.equal(doc.pages.length, 0, "the Document view draws no teaser pages");
assert.equal(doc.openedTotal, 0);

const inputs = {
  deals: [dealOf({ id: "deal-t", name: "Teaser Proof Logistics", links: [] })],
  items: [{ deal: dealOf({ id: "deal-t", name: "Teaser Proof Logistics", links: [] }), facts, demo: false, live: true }],
  access: [accessOf("deal-t", { id: "t1", name: "Tess Teaser", level: "teaser_only" }), accessOf("deal-t", { id: "b1", name: "Bo Blind", level: "full" })],
  questions: [], approvals: [], decisions: [], failed: [],
  examples: { included: true, canToggle: false, count: 0 }, ownDeals: 1,
} as any;
const [row] = dealRows(inputs, "all", NOW);
assert.equal(row.contentPages, 0, "no CIM pages to count");
assert.equal(row.medianPagesReached, null, "How far they got: '—', never '0 of 7'");
const ks = computeKpis(inputs, { range: "all", now: NOW, scope: "broker" }).kpis;
const reading = ks.find((k) => k.id === "reading")!;
assert.equal(reading.value, 0, "the teaser reader is not a CIM reader");
assert.ok(!(reading.ids ?? []).includes("t1"));

// Control: the same rendition and visit served as the Blind CIM ARE drawn and counted —
// so the zeros above come from the teaser rule, not from an empty fixture.
{
  const ctl = memoryReadingStore();
  ctl.renditions.set("rb", { ...(store.renditions.get("rt") as any), id: "rb", mode: "blind", variant: "full" });
  ctl.visits.set("vb", { ...(store.visits.get("vt") as any), id: "vb", buyerAccessId: "b1", renditionId: "rb", mode: "blind", accessLevel: "full" });
  setReadingSource(memoryReadingSource(ctl));
  const f2 = await loadDealReadingFacts(deal, DEFAULT_ENGAGEMENT_FILTERS, NOW);
  assert.equal(f2.renditions.length, 1);
  assert.ok(f2.pages.length >= 2, "a Blind CIM rendition's pages are drawn");
  assert.equal(f2.buyers.find((b) => b.accessId === "b1")!.visits.length, 1, "a Blind CIM visit counts");
  assert.ok(buildDocumentResponse(f2).pages.length >= 2);
}

console.log("analytics-teaser-renditions: all assertions passed");
