/**
 * How each page's reading is known (heat-map spec §5.4): part by part, as a
 * page total (old tracking, or a version with different parts), or both —
 * plus the numbers that must agree across screens (opened / with reading),
 * the reach basis of the old tracking (no "6 → 0 readers" on pages it never
 * recorded) and the version note. assembleFacts + buildDocumentResponse,
 * pure. No DB, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled node_modules/.bin/tsx tests/unit/engagement-heat-basis.test.ts
 */
import assert from "node:assert/strict";
import { assembleFacts, versionNoteOf, type AssembleInput } from "../../server/engagement/facts";
import { buildBuyersResponse, buildDocumentResponse, buildJourneyResponse, buildSummaryResponse, heatBasisOf } from "../../server/engagement/responses";
import { buildPageIndex } from "../../server/analytics/renditions";
import { DEFAULT_ENGAGEMENT_FILTERS, type RenditionPage } from "../../shared/analytics-v2";
import type { BuyerSection } from "../../shared/cim-buyer-view";
import type { RawBlockSum, RawRendition, RawVisit, RawVisitPage } from "../../server/engagement/queries";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

// ── A 4-page named CIM (metric grids: heading + 3 metrics) ────────────────
const metrics = (n: number) => ({ metrics: Array.from({ length: n }, (_, i) => ({ label: `Metric ${i}`, value: `${i}` })) });
const S = (id: string, order: number, title: string, n = 3): BuyerSection => ({
  id, dealId: "d", sectionKey: `k_${id}`, sectionTitle: title, order, layoutType: "metric_grid", layoutData: metrics(n),
  aiDraftContent: null, brokerEditedContent: null, isVisible: true,
});
const design = { brokerage: { showDisclaimerPage: false, showContactPage: false } };
const SECTIONS = [S("p1", 0, "Overview"), S("p2", 1, "Customers"), S("p3", 2, "Fleet"), S("p4", 3, "Next Steps")];
const idx: RenditionPage[] = buildPageIndex(SECTIONS, design, []);
// The same pages laid out differently (p2 gained a metric): another fingerprint.
const otherIdx: RenditionPage[] = buildPageIndex([SECTIONS[0], S("p2", 1, "Customers", 4), SECTIONS[2], SECTIONS[3]], design, []);
const r1: RawRendition = { id: "r1", mode: "normal", variant: "full", createdAt: new Date("2026-09-07T00:00:00Z"), visits: 0 };
const r0: RawRendition = { id: "r0", mode: "normal", variant: "full", createdAt: new Date("2026-08-01T00:00:00Z"), visits: 0 };
const now = new Date("2026-10-09T12:00:00Z");

const acc = (id: string, over: Record<string, unknown> = {}) => ({
  id, dealId: "d", buyerEmail: `${id}@x.invalid`, buyerName: id, accessLevel: "loi", decision: "interested", createdAt: now, accessEvents: [], firstViewedAt: null, ...over,
}) as any;
let n = 0;
const visit = (accessId: string, over: Partial<RawVisit> = {}): RawVisit => ({
  id: `v${++n}`, accessId, renditionId: null, startedAt: new Date("2026-09-10T10:00:00Z"), lastSeenAt: new Date("2026-09-10T10:30:00Z"),
  wallMs: 600_000, activeMs: 300_000, deviceClass: null, uaFamily: null, maxPageIndex: null, path: [], legacy: true, ipHash: null, ...over,
});
const sum = (accessId: string, pageId: string, attentionMs: number, over: Partial<RawBlockSum> = {}): RawBlockSum => ({
  accessId, renditionId: null, lineageId: pageId, pageId, blockKey: "", attentionMs, skimMs: 0, visibleMs: attentionMs, pointerMs: 0,
  firstAt: null, lastAt: null, ...over,
});
const vp = (accessId: string, visitId: string, pageId: string, attentionMs: number, renditionId: string | null = null): RawVisitPage => ({ accessId, visitId, renditionId, lineageId: pageId, pageId, attentionMs });

const base = (over: Partial<AssembleInput> = {}): AssembleInput => ({
  deal: { id: "d", businessName: "Deal", isLive: true, cimGeneration: null },
  filters: DEFAULT_ENGAGEMENT_FILTERS,
  now,
  accesses: [],
  live: SECTIONS.map((s) => ({ id: s.id, sectionKey: s.sectionKey, sectionTitle: s.sectionTitle, layoutType: s.layoutType, isVisible: true, analyticsLineage: null })),
  renditions: [r0, r1],
  chosen: r1,
  indexes: new Map([["r1", idx], ["r0", otherIdx]]),
  visits: [], sums: [], visitPages: [], events: [], questions: [], decisions: [],
  ...over,
});
const page = (doc: ReturnType<typeof buildDocumentResponse>, id: string) => doc.pages.find((p) => p.pageId === id)!;

console.log("heat basis");
test("old tracking only → whole page ('page', read before part tracking); every reader marked page-only", () => {
  const a = visit("A"), b = visit("B");
  const doc = buildDocumentResponse(assembleFacts(base({
    accesses: [acc("A"), acc("B")],
    visits: [a, b],
    sums: [sum("A", "p2", 120_000), sum("B", "p2", 40_000)],
    visitPages: [vp("A", a.id, "p2", 120_000), vp("B", b.id, "p2", 40_000)],
  })));
  const p2 = page(doc, "p2");
  assert.deepEqual(p2.heat, { basis: "page", partBuyers: 0, pageOnlyBuyers: 2, pageOnlyMs: 160_000, reason: "before_part_tracking" });
  assert.equal(p2.pageLevelOnly, true);
  assert.equal(p2.attentionMs, 160_000);
  assert.ok(p2.buyers.every((x) => x.pageOnly === true));
  assert.equal(page(doc, "p1").heat.basis, "none");
});
test("reading on a version with different parts → whole page ('other_layout')", () => {
  const a = visit("A", { legacy: false, renditionId: "r0" });
  const doc = buildDocumentResponse(assembleFacts(base({
    accesses: [acc("A")],
    visits: [a],
    sums: [sum("A", "p2", 30_000, { renditionId: "r0", blockKey: "metric:0" }), sum("A", "p2", 10_000, { renditionId: "r0", blockKey: "metric:3" })],
    visitPages: [vp("A", a.id, "p2", 40_000, "r0")],
  })));
  assert.deepEqual(page(doc, "p2").heat, { basis: "page", partBuyers: 0, pageOnlyBuyers: 1, pageOnlyMs: 40_000, reason: "other_layout" });
  // The same layout (p1 has the same fingerprint in r0): part by part.
});
test("part rows + old page totals → 'mixed', with the counts; the part tint uses part rows only", () => {
  const a = visit("A", { legacy: false, renditionId: "r1" }), b = visit("B");
  const doc = buildDocumentResponse(assembleFacts(base({
    accesses: [acc("A"), acc("B")],
    visits: [a, b],
    sums: [
      sum("A", "p2", 50_000, { renditionId: "r1", blockKey: "metric:1" }),
      sum("A", "p2", 10_000, { renditionId: "r1", blockKey: "metric:0" }),
      sum("B", "p2", 30_000),
    ],
    visitPages: [vp("A", a.id, "p2", 60_000, "r1"), vp("B", b.id, "p2", 30_000)],
  })));
  const p2 = page(doc, "p2");
  assert.deepEqual(p2.heat, { basis: "mixed", partBuyers: 1, pageOnlyBuyers: 1, pageOnlyMs: 30_000, reason: "before_part_tracking" });
  assert.equal(p2.attentionMs, 90_000);
  assert.equal(p2.blocks.find((x) => x.key === "metric:1")!.attentionMs, 50_000, "parts carry part-level reading only");
  assert.deepEqual(p2.buyers.map((x) => [x.accessId, !!x.pageOnly]), [["A", false], ["B", true]]);
  assert.equal(p2.pageLevelOnly, false);
});
test("a mixed page never claims 'Nobody stopped on' a part (the page totals can't say)", () => {
  const a = visit("A", { legacy: false, renditionId: "r1" }), b = visit("B"), c = visit("C", { legacy: false, renditionId: "r1" });
  const rows = (bTotal: boolean) => base({
    accesses: [acc("A"), acc("B"), acc("C")],
    visits: [a, b, c],
    sums: [
      sum("A", "p1", 400_000, { renditionId: "r1", blockKey: "metric:0" }),
      sum("A", "p2", 5_000, { renditionId: "r1", blockKey: "metric:0" }),
      sum("C", "p2", 5_000, { renditionId: "r1", blockKey: "metric:1" }),
      ...(bTotal ? [sum("B", "p2", 6_000)] : []),
    ],
    visitPages: [vp("A", a.id, "p1", 1, "r1"), vp("A", a.id, "p2", 1, "r1"), vp("C", c.id, "p2", 1, "r1"), vp("B", b.id, "p2", 1)],
  });
  const mixed = page(buildDocumentResponse(assembleFacts(rows(true))), "p2");
  assert.equal(mixed.heat.basis, "mixed");
  assert.doesNotMatch(mixed.headline ?? "", /Nobody stopped/);
  const parts = page(buildDocumentResponse(assembleFacts(rows(false))), "p2");
  assert.equal(parts.heat.basis, "parts");
  assert.match(parts.headline ?? "", /Nobody stopped on/);
});
test("page-only time under 5 % → 'parts'", () => {
  const a = visit("A", { legacy: false, renditionId: "r1" }), b = visit("B");
  const doc = buildDocumentResponse(assembleFacts(base({
    accesses: [acc("A"), acc("B")],
    visits: [a, b],
    sums: [sum("A", "p2", 100_000, { renditionId: "r1", blockKey: "metric:1" }), sum("B", "p2", 4_000)],
    visitPages: [vp("A", a.id, "p2", 100_000, "r1"), vp("B", b.id, "p2", 4_000)],
  })));
  assert.equal(page(doc, "p2").heat.basis, "parts");
  assert.equal(page(doc, "p2").heat.pageOnlyMs, 4_000);
});
test("the rule itself", () => {
  assert.equal(heatBasisOf(999, 0, 0), "none");
  assert.equal(heatBasisOf(5_000, 0, 5_000), "page");
  assert.equal(heatBasisOf(100_000, 1, 4_999), "parts");
  assert.equal(heatBasisOf(100_000, 1, 5_000), "mixed");
});
test("a buyer filter changes the counts (only the buyers in view)", () => {
  const a = visit("A", { legacy: false, renditionId: "r1" }), b = visit("B");
  const rows = {
    visits: [a, b],
    sums: [sum("A", "p2", 50_000, { renditionId: "r1", blockKey: "metric:1" }), sum("B", "p2", 30_000)],
    visitPages: [vp("A", a.id, "p2", 50_000, "r1"), vp("B", b.id, "p2", 30_000)],
  };
  const onlyB = buildDocumentResponse(assembleFacts(base({ ...rows, accesses: [acc("B")], filters: { ...DEFAULT_ENGAGEMENT_FILTERS, buyers: ["B"] } })));
  assert.deepEqual(page(onlyB, "p2").heat, { basis: "page", partBuyers: 0, pageOnlyBuyers: 1, pageOnlyMs: 30_000, reason: "before_part_tracking" });
  const onlyA = buildDocumentResponse(assembleFacts(base({ ...rows, accesses: [acc("A")], filters: { ...DEFAULT_ENGAGEMENT_FILTERS, buyers: ["A"] } })));
  assert.deepEqual(page(onlyA, "p2").heat, { basis: "parts", partBuyers: 1, pageOnlyBuyers: 0, pageOnlyMs: 0, reason: null });
});
test("a split section's page-only time is spread over its parts like the rest of its page-level time", () => {
  // A long financial table splits into printed parts; page-level time spreads by expected time.
  const rows = Array.from({ length: 60 }, (_, i) => ({ label: `Line ${i}`, values: [`$${i}`] }));
  const fin: BuyerSection = { id: "pf", dealId: "d", sectionKey: "fin", sectionTitle: "Financials", order: 0, layoutType: "financial_table", layoutData: { headers: ["", "2024"], rows }, aiDraftContent: null, brokerEditedContent: null, isVisible: true };
  const finIdx = buildPageIndex([fin], design, []);
  assert.ok(finIdx[0].parts >= 2, "the table splits into printed parts");
  const a = visit("A");
  const facts = assembleFacts(base({
    live: [{ id: "pf", sectionKey: "fin", sectionTitle: "Financials", layoutType: "financial_table", isVisible: true, analyticsLineage: null }],
    indexes: new Map([["r1", finIdx]]), renditions: [r1], accesses: [acc("A")], visits: [a],
    sums: [sum("A", "pf", 90_000)], visitPages: [vp("A", a.id, "pf", 90_000)],
  }));
  const doc = buildDocumentResponse(facts);
  const total = doc.pages.reduce((s, p) => s + p.heat.pageOnlyMs, 0);
  assert.ok(Math.abs(total - 90_000) <= doc.pages.length, `spread total ${total}`);
  assert.ok(doc.pages.every((p) => p.heat.basis === "page"));
});

console.log("numbers that agree");
test("opened = a visit or a stamped first view (the pulse); with reading = a visit of ≥ 3 s (the reader rule)", () => {
  const a = visit("A"), tiny = visit("T", { activeMs: 1_000 });
  const facts = assembleFacts(base({
    accesses: [acc("A"), acc("T"), acc("W", { firstViewedAt: new Date("2026-09-12T00:00:00Z") }), acc("N")],
    visits: [a, tiny],
    sums: [sum("A", "p1", 60_000), sum("T", "p1", 900)],
    visitPages: [vp("A", a.id, "p1", 60_000), vp("T", tiny.id, "p1", 900)],
  }));
  const doc = buildDocumentResponse(facts);
  const buyers = buildBuyersResponse(facts);
  const summary = buildSummaryResponse(facts, true, "Deal");
  assert.equal(doc.openedTotal, 3, "A, T and W (first view only)");
  assert.equal(doc.openedBy, 1, "only A has ≥ 3 s of reading");
  assert.equal(buyers.counts.opened, doc.openedTotal);
  assert.equal(buyers.counts.withReading, doc.openedBy);
  assert.equal(summary.pulse.opened, doc.openedTotal, "the pulse says the same");
  // Over a date range, a stamped first view alone doesn't count (no visit in the range).
  const ranged = assembleFacts(base({ accesses: [acc("W", { firstViewedAt: new Date() })], filters: { ...DEFAULT_ENGAGEMENT_FILTERS, range: "7d" } }));
  assert.equal(buildDocumentResponse(ranged).openedTotal, 0);
});

console.log("how far buyers got (old tracking)");
const reachFixture = () => {
  const va = visit("A"), vb = visit("B"), vc = visit("C");
  return base({
    accesses: [acc("A"), acc("B"), acc("C")],
    visits: [va, vb, vc],
    sums: [
      sum("A", "p1", 30_000), sum("A", "p2", 30_000), sum("A", "p3", 30_000),
      sum("B", "p1", 30_000), sum("B", "p2", 30_000), sum("B", "p3", 30_000),
      sum("C", "p1", 30_000),
    ],
    visitPages: [vp("A", va.id, "p1", 1), vp("B", vb.id, "p1", 1), vp("C", vc.id, "p1", 1)],
  });
};
test("pages after the last page with any reading are not recorded; the headline never names one", () => {
  const doc = buildDocumentResponse(assembleFacts(reachFixture()));
  assert.equal(doc.reachBasis, "old_tracking");
  assert.equal(doc.lastRecordedIndex, 2);
  assert.deepEqual(doc.pages.map((p) => p.reachRecorded), [true, true, true, false]);
  // Without the rule this said "Most buyers stopped around page 4 · Next Steps (2 → 0 readers)."
  assert.equal(doc.reachHeadline, "2 of 3 buyers got to page 3 · Fleet, the last page recorded.");
  assert.ok(!/Next Steps/.test(doc.reachHeadline ?? ""));
});
test("a marked drop inside the recorded pages is still named (Pacific: page 10, 11 → 9)", () => {
  const f = reachFixture();
  const extra = ["D", "E", "F", "G", "H"].map((id) => ({ id, v: visit(id) }));
  f.accesses.push(...extra.map((x) => acc(x.id)));
  f.visits.push(...extra.map((x) => x.v));
  for (const x of extra) f.sums.push(sum(x.id, "p1", 30_000), sum(x.id, "p2", 30_000), sum(x.id, "p3", 30_000));
  // C stops after p1, D and E after p2: 8 → 7 → 5.
  f.sums = f.sums.filter((s) => !((s.accessId === "D" || s.accessId === "E") && s.pageId === "p3"));
  const doc = buildDocumentResponse(assembleFacts(f));
  assert.equal(doc.reachHeadline, "The biggest drop is around page 3 · Fleet (7 → 5 readers).");
});
test("part-by-part tracking ('tracked') keeps every page recorded", () => {
  const a = visit("A", { legacy: false, renditionId: "r1", maxPageIndex: 1 });
  const doc = buildDocumentResponse(assembleFacts(base({
    accesses: [acc("A")], visits: [a],
    sums: [sum("A", "p1", 30_000, { renditionId: "r1", blockKey: "metric:0" })],
    visitPages: [vp("A", a.id, "p1", 30_000, "r1")],
  })));
  assert.equal(doc.reachBasis, "tracked");
  assert.equal(doc.lastRecordedIndex, null);
  assert.ok(doc.pages.every((p) => p.reachRecorded));
});
test("sample reading counts as old tracking for reach and is flagged on every response", () => {
  const f = reachFixture();
  f.visits = f.visits.map((v) => ({ ...v, legacy: false, renditionId: "r1", demoSeed: "demo-reading-v1" }));
  f.sums = f.sums.map((s) => ({ ...s, renditionId: "r1", blockKey: "metric:0" }));
  const facts = assembleFacts(f);
  const doc = buildDocumentResponse(facts);
  assert.equal(doc.sampleReading, true);
  assert.equal(doc.reachBasis, "old_tracking");
  assert.equal(buildBuyersResponse(facts).sampleReading, true);
  assert.equal(buildSummaryResponse(facts, true, "Deal").sampleReading, true);
  assert.equal(buildJourneyResponse(facts, "A")!.sampleReading, true);
  assert.ok(facts.buyers.find((b) => b.accessId === "A")!.visits.every((v) => v.sample));
  assert.equal(buildDocumentResponse(assembleFacts(reachFixture())).sampleReading, false);
});

console.log("version note");
const kept = SECTIONS.map((s) => ({ id: s.id }));
test("kept copy: buyers read the version kept while the update waits (and this is it)", () => {
  const deal = { isLive: true, cimGeneration: { buyerHold: { since: "2026-09-29T14:02:17.000Z", servingPublished: true } } };
  assert.deepEqual(versionNoteOf(deal, idx, kept, [], false), { kind: "kept_copy", since: "2026-09-29T14:02:17.000Z" });
  // Not the kept copy's pages (an older version drawn): older_version.
  assert.deepEqual(versionNoteOf(deal, idx, [{ id: "zz" }], [{ id: "p1" }], false), { kind: "older_version", changedPages: 3 });
});
test("held: an update waiting with nothing served — with the sample flag", () => {
  const deal = { isLive: false, cimGeneration: { buyerHold: { since: "2026-09-28T00:00:00Z", wasLive: true, buyers: 12, ddCleared: false } } };
  assert.deepEqual(versionNoteOf(deal, idx, null, SECTIONS, false), { kind: "held", sample: false });
  assert.deepEqual(versionNoteOf(deal, idx, null, SECTIONS, true), { kind: "held", sample: true });
});
test("older version / nothing to say", () => {
  assert.deepEqual(versionNoteOf({ isLive: true }, idx, null, SECTIONS.slice(0, 2), false), { kind: "older_version", changedPages: 2 });
  assert.equal(versionNoteOf({ isLive: true }, idx, null, SECTIONS, false), null);
  assert.equal(versionNoteOf({ isLive: true }, [], null, SECTIONS, false), null);
});
test("the document response carries the note from the facts", () => {
  const a = visit("A");
  const doc = buildDocumentResponse(assembleFacts(base({
    deal: { id: "d", businessName: "Deal", isLive: false, cimGeneration: { buyerHold: { since: "x", wasLive: true, buyers: 1, ddCleared: false } } },
    accesses: [acc("A")], visits: [a], sums: [sum("A", "p1", 30_000)], visitPages: [vp("A", a.id, "p1", 30_000)],
  })));
  assert.deepEqual(doc.versionNote, { kind: "held", sample: false });
});

console.log(`\n${passed} passed`);
