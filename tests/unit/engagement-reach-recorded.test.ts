/**
 * "How far buyers got" with the old tracking, through the real facts loader
 * (loadDealReadingFacts over the in-memory reading store): which pages were
 * recorded is decided deal-wide, never by the filter (HM-C1), and a page
 * nobody has any reading on — anywhere in the CIM — is never a drop or
 * "skipped" (HM-C2). A device or date filter narrows the view like a buyer
 * filter: its copy never says "nobody" about pages other buyers read, and
 * its "opened" counts only buyers with a visit in view (HM2-1). No DB, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled node_modules/.bin/tsx tests/unit/engagement-reach-recorded.test.ts
 */
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { loadDealReadingFacts, setReadingSource, _setLiveRenditionForTests } from "../../server/engagement/facts";
import { buildBuyersResponse, buildDocumentResponse } from "../../server/engagement/responses";
import { memoryReadingSource } from "../../server/engagement/queries";
import { memoryReadingStore } from "../../server/analytics/reading-ingest";
import { buildPageIndex } from "../../server/analytics/renditions";
import { DEFAULT_ENGAGEMENT_FILTERS, type EngagementFilters } from "../../shared/analytics-v2";
import type { BuyerSection } from "../../shared/cim-buyer-view";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

// A six-page CIM. "New" (page 4) and "Contact" (page 6) carry nobody's reading.
const TITLES = ["Overview", "Revenue", "Customers", "New in the update", "Fleet", "Next Steps"];
const SECTIONS: BuyerSection[] = TITLES.map((t, i) => ({
  id: `p${i + 1}`, dealId: "deal-r", sectionKey: `k${i + 1}`, sectionTitle: t, order: i, layoutType: "metric_grid",
  layoutData: { metrics: [{ label: "A", value: "1" }, { label: "B", value: "2" }] }, aiDraftContent: null, brokerEditedContent: null, isVisible: true,
}));
const PAGES = buildPageIndex(SECTIONS, { brokerage: { showDisclaimerPage: false, showContactPage: false } }, []);
const at = (d: number, m = 0) => new Date(Date.UTC(2026, 8, d, 10, m));
const BUYERS = ["Ben", "Julien", "Kim", "Lena", "Mo", "Nia"];
const s = storage as any;
s.getBuyerAccessByDeal = async () => BUYERS.map((name, i) => ({
  id: `a${i}`, dealId: "deal-r", buyerEmail: `${name.toLowerCase()}@x.invalid`, buyerName: name, accessLevel: "full",
  decision: i < 2 ? "interested" : null, createdAt: at(1), accessEvents: [], firstViewedAt: at(2),
}));
s.getCimSectionsByDeal = async () => SECTIONS.map((x) => ({ ...x, analyticsLineage: null }));
_setLiveRenditionForTests(async () => null);

// Old-tracker visits (stored, no version): Ben stops after page 2; the others
// read 1, 2, 3, 5 and (four of them) 6. Nobody has page 4. Nia (a5) read on a
// phone; everyone else on a computer.
const reads: Record<string, string[]> = {
  a0: ["p1", "p2"],
  a1: ["p1", "p2", "p3", "p5", "p6"],
  a2: ["p1", "p2", "p3", "p5", "p6"],
  a3: ["p1", "p2", "p3", "p5", "p6"],
  a4: ["p1", "p2", "p3", "p5", "p6"],
  a5: ["p1", "p2", "p3", "p5"],
};
function world() {
  const store = memoryReadingStore();
  store.renditions.set("r1", { id: "r1", dealId: "deal-r", mode: "blind", variant: "full", createdAt: at(1), pageIndex: PAGES } as any);
  Object.entries(reads).forEach(([accessId, pages], i) => {
    const id = `legacy-${i}`;
    store.visits.set(id, {
      id, dealId: "deal-r", buyerAccessId: accessId, renditionId: null, mode: "blind", accessLevel: "full", deviceClass: accessId === "a5" ? "phone" : null,
      startedAt: at(3 + i), lastSeenAt: at(3 + i, 30), wallMs: 1_800_000, activeMs: 900_000, idleMs: 0, hiddenMs: 0, awayMs: 0, outsideMs: 0,
      maxPageIndex: null, path: pages.map((p, k) => [k * 60, p]), selfView: false, clamped: false, legacy: true, viewportW: null, viewportH: null, uaFamily: null, ipHash: null,
    } as any);
    for (const p of pages) {
      store.rollups.set(`${id}|${p}|`, { visitId: id, pageId: p, blockKey: "", dealId: "deal-r", buyerAccessId: accessId, renditionId: null, lineageId: p, attentionMs: 60_000, skimMs: 0, visibleMs: 60_000, pointerMs: 0, at: at(3 + i, 10) } as any);
    }
  });
  return store;
}
const deal = { id: "deal-r", businessName: "Deal", buyerDeepCheck: null, isLive: true } as any;
const load = (filters: EngagementFilters) => loadDealReadingFacts(deal, filters, at(20));
setReadingSource(memoryReadingSource(world()));

console.log("which pages were recorded is a fact about the deal");
await test("everyone: page 4 (in between) is not recorded; the last page recorded is 6; the drop skips page 4", async () => {
  const doc = buildDocumentResponse(await load(DEFAULT_ENGAGEMENT_FILTERS));
  assert.equal(doc.reachBasis, "old_tracking");
  assert.deepEqual(doc.pages.map((p) => p.reachRecorded), [true, true, true, false, true, true]);
  assert.equal(doc.pages[doc.lastRecordedIndex!].title, "Next Steps");
  assert.equal(doc.pages[3].readLabel, null);
  assert.equal(doc.pages[3].headline, null);
  assert.doesNotMatch(doc.reachHeadline ?? "", /New in the update/);
});
await test("filtered to Ben (who stopped after page 2): pages 3–6 other buyers read stay recorded; 'This buyer got as far as page 2'", async () => {
  const doc = buildDocumentResponse(await load({ ...DEFAULT_ENGAGEMENT_FILTERS, buyers: ["a0"] }));
  assert.deepEqual(doc.pages.map((p) => p.reachRecorded), [true, true, true, false, true, true]);
  assert.equal(doc.pages[doc.lastRecordedIndex!].title, "Next Steps", "never Ben's own last page");
  assert.equal(doc.reachHeadline, "This buyer got as far as page 2 · Revenue.");
});
await test("filtered to a segment, a date range or a device: the same recorded pages", async () => {
  for (const f of [
    { ...DEFAULT_ENGAGEMENT_FILTERS, segment: "interested" as const },
    { ...DEFAULT_ENGAGEMENT_FILTERS, range: "30d" as const },
    { ...DEFAULT_ENGAGEMENT_FILTERS, buyers: ["a5"] },
    { ...DEFAULT_ENGAGEMENT_FILTERS, device: "phone" as const },
  ]) {
    const doc = buildDocumentResponse(await load(f));
    assert.deepEqual(doc.pages.map((p) => p.reachRecorded), [true, true, true, false, true, true], JSON.stringify(f));
  }
});
await test("on phones only (HM2-1): pages other buyers read are never 'nobody'; opened counts buyers with a visit in view", async () => {
  const facts = await load({ ...DEFAULT_ENGAGEMENT_FILTERS, device: "phone" });
  const doc = buildDocumentResponse(facts);
  // Only Nia read on a phone; she stopped at page 5. Everyone else (computer) read page 6.
  assert.equal(doc.openedBy, 1);
  assert.equal(doc.openedTotal, 1, "never the 6 stamped first views: a first view alone carries no device");
  assert.equal(buildBuyersResponse(facts).counts.opened, doc.openedTotal, "the Buyers view says the same");
  const next = doc.pages.find((p) => p.title === "Next Steps")!;
  assert.equal(next.reachedBy, 0);
  assert.equal(next.headline, "No buyer in this view has reached this page.");
  for (const p of doc.pages) assert.doesNotMatch(p.headline ?? "", /^No buyer has reached|^Most studied page in the CIM/, p.title);
  assert.match(doc.pages[0].headline ?? "", /^Most studied page in this view — 1 of 1 buyer read it/);
  assert.equal(doc.reachHeadline, "The one buyer in this view got as far as page 5 · Fleet.");
  // On a computer: the five buyers with a computer visit (Nia read on her phone).
  const desk = buildDocumentResponse(await load({ ...DEFAULT_ENGAGEMENT_FILTERS, device: "desktop" }));
  assert.equal(desk.openedTotal, 5);
  assert.equal(desk.reachHeadline, "4 of 5 buyers got to page 6 · Next Steps, the last page recorded.");
  // One buyer on a phone is a narrower view too (she may have read more on a computer).
  const niaPhone = buildDocumentResponse(await load({ ...DEFAULT_ENGAGEMENT_FILTERS, buyers: ["a5"], device: "phone" }));
  assert.equal(niaPhone.pages.find((p) => p.title === "Next Steps")!.headline, "No buyer in this view has reached this page.");
  // Unfiltered, one buyer filter: unchanged.
  const ben = buildDocumentResponse(await load({ ...DEFAULT_ENGAGEMENT_FILTERS, buyers: ["a0"] }));
  assert.equal(ben.pages.find((p) => p.title === "Fleet")!.headline, "This buyer hasn't reached this page.");
  assert.equal(ben.openedTotal, 1);
  const all = buildDocumentResponse(await load(DEFAULT_ENGAGEMENT_FILTERS));
  assert.equal(all.openedTotal, 6);
});
await test("the Buyers view's strips never call the unrecorded page skipped", async () => {
  const buyers = buildBuyersResponse(await load(DEFAULT_ENGAGEMENT_FILTERS));
  for (const b of buyers.buyers) assert.equal(b.pageStrip[3].readLabel, null, b.name);
});
await test("if the deal-wide read fails, the view's own reading stands in (no crash)", async () => {
  const src = memoryReadingSource(world());
  // Only the deal-wide read (no buyers, no date) fails.
  setReadingSource({ ...src, visitPages: async (q) => { if (q.accessIds === null && q.since === null) throw new Error("db down"); return src.visitPages(q); } });
  const doc = buildDocumentResponse(await load({ ...DEFAULT_ENGAGEMENT_FILTERS, buyers: ["a0"] }));
  assert.equal(doc.reachBasis, "old_tracking");
  assert.deepEqual(doc.pages.map((p) => p.reachRecorded), [true, true, false, false, false, false]);
  setReadingSource(memoryReadingSource(world()));
});

console.log(`\n${passed} passed`);
