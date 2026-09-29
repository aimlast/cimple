// Release review DEP-2, as the release candidate's own backfill wrote it: legacy
// visits and rows stored with rendition NULL (page id = section id). The
// on-the-fly read then returns nothing (stored legacy visits exist), and a deal
// nobody has opened since the release has no stored version — the Document
// view showed 0 pages while the Buyers view listed every reader (Pacific:
// 29 pages → 0). Now any legacy visit, stored or not, draws on the CIM as it
// would be served now.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/engagement-legacy-stored.test.ts
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import * as facts from "../../server/engagement/facts";
import { buildDocumentResponse } from "../../server/engagement/responses";
import { buildPageIndex } from "../../server/analytics/renditions";
import { DEFAULT_ENGAGEMENT_FILTERS } from "../../shared/analytics-v2";
import type { ReadingSource } from "../../server/engagement/queries";

const SECTIONS = [
  { id: "p-exec", sectionKey: "executive_summary", sectionTitle: "Executive Summary", layoutType: "prose_highlight", order: 1, analyticsLineage: null },
  { id: "p-fin", sectionKey: "financial_performance", sectionTitle: "Historical Financial Performance", layoutType: "financial_table", order: 2, analyticsLineage: null },
];
const at = (m: number) => new Date(Date.UTC(2026, 8, 3, 15, m));
const s = storage as any;
s.getBuyerAccessByDeal = async () => [{ id: "a1", dealId: "deal-p", buyerEmail: "a1@x.invalid", buyerName: "Ada", accessLevel: "full", decision: "interested", createdAt: at(0), accessEvents: [] }];
s.getCimSectionsByDeal = async () => SECTIONS;
const stored: ReadingSource = {
  async renditions() { return []; },
  async rendition() { return null; },
  async pageIndexes() { return new Map(); },
  async visits() {
    return [{ id: "lv1", accessId: "a1", renditionId: null, startedAt: at(0), lastSeenAt: at(5), wallMs: 300_000, activeMs: 200_000, deviceClass: null, uaFamily: null, maxPageIndex: null, path: [[0, "p-exec"], [60, "p-fin"]], legacy: true, ipHash: null }];
  },
  async blockSums() {
    return [
      { accessId: "a1", renditionId: null, lineageId: "p-exec", pageId: "p-exec", blockKey: "", attentionMs: 60_000, skimMs: 0, visibleMs: 60_000, pointerMs: 0, firstAt: at(0), lastAt: at(5) },
      { accessId: "a1", renditionId: null, lineageId: "p-fin", pageId: "p-fin", blockKey: "", attentionMs: 140_000, skimMs: 0, visibleMs: 140_000, pointerMs: 0, firstAt: at(0), lastAt: at(5) },
    ];
  },
  async visitPages() {
    return [
      { accessId: "a1", visitId: "lv1", renditionId: null, lineageId: "p-exec", pageId: "p-exec", attentionMs: 60_000 },
      { accessId: "a1", visitId: "lv1", renditionId: null, lineageId: "p-fin", pageId: "p-fin", attentionMs: 140_000 },
    ];
  },
  async events() { return []; },
  async questions() { return []; },
  async decisions() { return []; },
  async legacyExits() { return []; },   // stored → none on the fly
};
facts.setReadingSource(stored);
// The CIM as the view room would serve it now (the real page indexer over the sections).
const seam = (facts as Record<string, unknown>)._setLiveRenditionForTests as undefined | ((fn: unknown) => void);
seam?.(async (_d: unknown, _l: unknown, createdAt = new Date()) => {
  const withData = SECTIONS.map((x) => ({ ...x, dealId: "deal-p", layoutData: x.layoutType === "financial_table" ? { headers: ["", "2024"], rows: [{ label: "Revenue", values: ["$1"] }] } : { content: "Text." }, aiDraftContent: null, brokerEditedContent: null, isVisible: true }));
  const pageIndex = buildPageIndex(withData as any, { brokerage: { showDisclaimerPage: false, showContactPage: false } } as any, SECTIONS);
  const raw = { id: "live", mode: "normal", variant: "full", createdAt, visits: 0 };
  return { raw, row: { ...raw, sections: [], design: null, pageIndex } };
});

const f = await facts.loadDealReadingFacts({ id: "deal-p", businessName: "Pacific", buyerDeepCheck: null } as any, DEFAULT_ENGAGEMENT_FILTERS, new Date("2026-09-30T00:00:00Z"));
const doc = buildDocumentResponse(f);
assert.equal(f.buyers.filter((b) => b.visits.length > 0).length, 1, "the Buyers view lists the reader");
assert.equal(doc.pages.length, 2, "…and the Document view draws the pages (was 0)");
assert.deepEqual(doc.pages.map((p) => p.attentionMs), [60_000, 140_000]);
assert.equal(doc.legacyOnly, true);
console.log("  ✓ stored legacy reading with no stored version still draws on the CIM as served now\n\n1 passed");
