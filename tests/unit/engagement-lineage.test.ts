/**
 * Section lineage across a CIM regeneration (server/analytics/lineage.ts)
 * and the merge rules that use it (server/engagement/facts.ts assembleFacts):
 * block heat merges only between pages with the same block structure;
 * otherwise page totals merge by lineage and the page says "Changed since
 * N buyers read it". No database, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/engagement-lineage.test.ts
 */
import assert from "node:assert/strict";
import { assignLineage } from "../../server/analytics/lineage";
import { assembleFacts, chooseRendition, renditionLabel, type AssembleInput } from "../../server/engagement/facts";
import { buildPageIndex } from "../../server/analytics/renditions";
import { buildDocumentResponse } from "../../server/engagement/responses";
import { DEFAULT_ENGAGEMENT_FILTERS, viewerPageKey } from "../../shared/analytics-v2";
import type { BuyerSection } from "../../shared/cim-buyer-view";
import { legacySessions } from "../../scripts/backfill-legacy-reading";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

console.log("lineage");
const old = [
  { id: "o1", sectionKey: "executive_summary", sectionTitle: "Executive Summary", layoutType: "metric_grid" },
  { id: "o2", sectionKey: "fin_hist", sectionTitle: "Historical Financial Performance", layoutType: "financial_table", analyticsLineage: "L-fin" },
  { id: "o3", sectionKey: "team_x", sectionTitle: "Our People", layoutType: "org_chart" },
  { id: "o4", sectionKey: "lease_1", sectionTitle: "Facility & Lease", layoutType: "location_card" },
  { id: "o5", sectionKey: "growth_a", sectionTitle: "Growth Opportunities", layoutType: "callout_list" },
  { id: "o6", sectionKey: "growth_b", sectionTitle: "Expansion Levers", layoutType: "callout_list" },
];
test("same key, then same title, then a unique page role; each old section once", () => {
  const next = [
    { sectionKey: "executive_summary", sectionTitle: "At a Glance", layoutType: "metric_grid" },            // key
    { sectionKey: "financials_v2", sectionTitle: "historical financial performance!", layoutType: "financial_table" }, // title (case/punct)
    { sectionKey: "leadership", sectionTitle: "Management & Staff", layoutType: "org_chart" },               // role: employees (unique)
    { sectionKey: "site", sectionTitle: "Premises", layoutType: "location_card" },                            // role: location (unique)
    { sectionKey: "upside", sectionTitle: "Growth Plan", layoutType: "callout_list" },                        // role growth: ambiguous (2 old)
    { sectionKey: "executive_summary", sectionTitle: "Executive Summary", layoutType: "metric_grid" },       // duplicate key: o1 already taken → title? o1 taken → new
  ];
  const out = assignLineage(old, next);
  assert.deepEqual(out, ["o1", "L-fin", "o3", "o4", null, null]);
});
test("a lineage continues through several regenerations (analyticsLineage is kept, not the id)", () => {
  const gen2 = [{ id: "n2", sectionKey: "x", sectionTitle: "Historical Financial Performance", layoutType: "financial_table", analyticsLineage: "L-fin" }];
  assert.deepEqual(assignLineage(gen2, [{ sectionKey: "y", sectionTitle: "Historical Financial Performance", layoutType: "financial_table" }]), ["L-fin"]);
  assert.deepEqual(assignLineage([], [{ sectionKey: "a", sectionTitle: "A", layoutType: "metric_grid" }]), [null]);
});

console.log("merge rules");
const S = (id: string, order: number, layoutType: string, sectionTitle: string, layoutData: unknown): BuyerSection => ({
  id, dealId: "d", sectionKey: `s_${id}`, sectionTitle, order, layoutType, layoutData, aiDraftContent: null, brokerEditedContent: null, isVisible: true,
});
const fin = (rows: number, title = "Historical Financial Performance") =>
  ({ headers: ["", "2024"], rows: Array.from({ length: rows }, (_, i) => ({ label: `Line ${i}`, values: [`$${i}`] })) });
const design = { brokerage: { showDisclaimerPage: false, showContactPage: false } };
// The old CIM (before a regeneration): page "old-fin" with 3 rows, "old-team" metric grid.
const oldIdx = buildPageIndex([S("old-fin", 0, "financial_table", "Historical Financial Performance", fin(3)), S("old-grid", 1, "metric_grid", "Key Figures", { metrics: [{ label: "A", value: "1" }] })], design,
  [{ id: "old-fin", analyticsLineage: "L-fin" }, { id: "old-grid", analyticsLineage: "L-grid" }]);
// The new CIM: financials gained a row (different structure); the grid is unchanged in structure.
const newIdx = buildPageIndex([S("new-fin", 0, "financial_table", "Historical Financial Performance", fin(4)), S("new-grid", 1, "metric_grid", "Key Figures", { metrics: [{ label: "B", value: "2" }] })], design,
  [{ id: "new-fin", analyticsLineage: "L-fin" }, { id: "new-grid", analyticsLineage: "L-grid" }]);
const now = new Date("2026-09-28T12:00:00Z");
const acc = (id: string) => ({ id, dealId: "d", buyerEmail: `${id}@x.invalid`, buyerName: id, accessLevel: "loi", decision: "interested", createdAt: now, accessEvents: [] }) as any;
const base = (over: Partial<AssembleInput> = {}): AssembleInput => ({
  deal: { id: "d", businessName: "Deal" },
  filters: DEFAULT_ENGAGEMENT_FILTERS,
  now,
  accesses: [acc("oldReader"), acc("newReader")],
  live: [
    { id: "new-fin", sectionKey: "fin", sectionTitle: "Historical Financial Performance", layoutType: "financial_table", isVisible: true, analyticsLineage: "L-fin" },
    { id: "new-grid", sectionKey: "grid", sectionTitle: "Key Figures", layoutType: "metric_grid", isVisible: true, analyticsLineage: "L-grid" },
  ],
  renditions: [
    { id: "r-old", mode: "normal", variant: "full", createdAt: new Date("2026-09-10T00:00:00Z"), visits: 1 },
    { id: "r-new", mode: "normal", variant: "full", createdAt: new Date("2026-09-20T00:00:00Z"), visits: 1 },
  ],
  chosen: { id: "r-new", mode: "normal", variant: "full", createdAt: new Date("2026-09-20T00:00:00Z"), visits: 1 },
  indexes: new Map([["r-old", oldIdx], ["r-new", newIdx]]),
  visits: [
    { id: "v1", accessId: "oldReader", renditionId: "r-old", startedAt: new Date("2026-09-11T00:00:00Z"), lastSeenAt: new Date("2026-09-11T00:10:00Z"), wallMs: 600_000, activeMs: 500_000, deviceClass: "desktop", uaFamily: null, maxPageIndex: 1, path: [[0, "old-fin"], [200, "old-grid"]], legacy: false, ipHash: null },
    { id: "v2", accessId: "newReader", renditionId: "r-new", startedAt: new Date("2026-09-21T00:00:00Z"), lastSeenAt: new Date("2026-09-21T00:10:00Z"), wallMs: 600_000, activeMs: 300_000, deviceClass: "desktop", uaFamily: null, maxPageIndex: 0, path: [[0, "new-fin"]], legacy: false, ipHash: null },
  ],
  sums: [
    { accessId: "oldReader", renditionId: "r-old", lineageId: "L-fin", pageId: "old-fin", blockKey: "row:1", attentionMs: 40_000, skimMs: 0, visibleMs: 50_000, pointerMs: 0, firstAt: null, lastAt: null },
    { accessId: "oldReader", renditionId: "r-old", lineageId: "L-grid", pageId: "old-grid", blockKey: "metric:0", attentionMs: 9_000, skimMs: 0, visibleMs: 9_000, pointerMs: 0, firstAt: null, lastAt: null },
    { accessId: "newReader", renditionId: "r-new", lineageId: "L-fin", pageId: "new-fin", blockKey: "row:3", attentionMs: 20_000, skimMs: 1_000, visibleMs: 25_000, pointerMs: 0, firstAt: null, lastAt: null },
  ],
  visitPages: [],
  events: [],
  questions: [],
  decisions: [],
  ...over,
});

test("a changed page merges page totals by lineage, not part heat, and says who read the old version", () => {
  const facts = assembleFacts(base());
  const doc = buildDocumentResponse(facts);
  const page = doc.pages.find((p) => p.pageId === "new-fin")!;
  assert.equal(page.attentionMs, 60_000, "both buyers' time on the page");
  assert.equal(page.readers, 2);
  const row1 = page.blocks.find((b) => b.key === "row:1")!;
  assert.equal(row1.attentionMs, 0, "old row heat is NOT drawn on the new rows");
  assert.equal(page.blocks.find((b) => b.key === "row:3")!.attentionMs, 20_000);
  assert.equal(page.changedSince, 1);
  const old = facts.buyers.find((b) => b.accessId === "oldReader")!;
  assert.equal(old.pages[viewerPageKey("new-fin", 0)].attentionMs, 40_000);
  assert.deepEqual(old.visits[0].path, [[0, "new-fin"], [200, "new-grid"]], "paths are mapped onto the chosen version");
  assert.equal(old.visits[0].maxPageIndex, 1);
});
test("an unchanged structure merges part by part (blind and named, or before/after an edit)", () => {
  const doc = buildDocumentResponse(assembleFacts(base()));
  const grid = doc.pages.find((p) => p.pageId === "new-grid")!;
  assert.equal(grid.blocks.find((b) => b.key === "metric:0")!.attentionMs, 9_000);
  assert.equal(grid.changedSince, null);
  assert.equal(grid.pageLevelOnly, false);
});
test("the version shown: asked for, else the latest with reading, else the latest; labels in words", () => {
  const r = base().renditions;
  assert.equal(chooseRendition(r, [], "r-old")!.id, "r-old");
  assert.equal(chooseRendition(r, [{ renditionId: "r-old" } as any], null)!.id, "r-old");
  assert.equal(chooseRendition(r, [], null)!.id, "r-new");
  assert.equal(chooseRendition([], [], null), null);
  assert.equal(renditionLabel({ mode: "blind", variant: "full", createdAt: new Date("2026-09-12T10:00:00Z") }), "Blind · published 12 Sep");
  assert.equal(renditionLabel({ mode: "blind", variant: "teaser", createdAt: new Date("2026-09-12T10:00:00Z") }), "Blind teaser · published 12 Sep");
});
test("real titles on blind pages: the buyer's words are kept as servedTitle", () => {
  const blindIdx = buildPageIndex([S("new-fin", 0, "financial_table", "Financial Performance", fin(4))], design, [{ id: "new-fin", analyticsLineage: "L-fin" }]);
  const facts = assembleFacts(base({ indexes: new Map([["r-new", blindIdx]]), renditions: [], sums: [], visits: [] }));
  assert.equal(facts.pages[0].title, "Historical Financial Performance");
  assert.equal(facts.pages[0].servedTitle, "Financial Performance");
});

console.log("version choice");
test("one publish = several versions: the full one most buyers read, not the teaser", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 8, 20, h));
  const rs = [
    { id: "old", mode: "blind", variant: "full", createdAt: new Date(Date.UTC(2026, 7, 1)), visits: 30 },
    { id: "blind", mode: "blind", variant: "full", createdAt: t(1), visits: 2 },
    { id: "named", mode: "normal", variant: "full", createdAt: t(1), visits: 3 },
    { id: "teaser", mode: "blind", variant: "teaser", createdAt: t(2), visits: 5 },
  ];
  const v = (id: string, n: number) => Array.from({ length: n }, () => ({ renditionId: id }) as any);
  assert.equal(chooseRendition(rs, [...v("old", 30), ...v("blind", 2), ...v("named", 3), ...v("teaser", 5)], null)!.id, "named");
  assert.equal(chooseRendition(rs, v("old", 3), null)!.id, "old", "only the old version has reading in this filter");
});

console.log("legacy backfill");
test("old section exits → one page-level visit per 30-min session, overlaps scaled to the wall clock", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 8, 1, 10, m));
  const exits = [
    { accessId: "a", key: "fin", seconds: 120, at: at(5) },
    { accessId: "a", key: "team", seconds: 200, at: at(6) },     // overlapped: 320 s claimed in a 3-min span → scaled to 180 s
    { accessId: "a", key: "gone", seconds: 30, at: at(7) },      // no longer in the CIM
    { accessId: "a", key: "fin", seconds: 60, at: at(120) },     // a new session 2 h later
    { accessId: "b", key: "team", seconds: 500, at: at(3) },     // claims 500 s in a 500 s span
    { accessId: "b", key: "fin", seconds: 400, at: at(4) },      // …plus 400 s one minute later: scaled
  ];
  const s = legacySessions(exits, (k) => (k === "fin" ? "P-fin" : k === "team" ? "P-team" : null));
  assert.equal(s.length, 3);
  const a1 = s.find((x) => x.accessId === "a" && x.pages.has("P-team"))!;
  assert.equal(a1.pages.get("P-fin"), 67_500);
  assert.equal(a1.pages.get("P-team"), 112_500);
  assert.equal(a1.activeMs, a1.wallMs);
  assert.deepEqual(a1.path, [[0, "P-fin"], [67, "P-team"]]);
  const b = s.find((x) => x.accessId === "b")!;
  assert.ok(b.activeMs <= b.wallMs);
  assert.ok((b.pages.get("P-team")! + b.pages.get("P-fin")!) <= b.wallMs + 1);
  assert.equal(legacySessions(exits, (k) => (k === "fin" ? "P-fin" : null)).length, 3);
  assert.equal(s[0].visitId, legacySessions(exits, (k) => (k === "fin" ? "P-fin" : k === "team" ? "P-team" : null))[0].visitId, "stable ids: re-runs change nothing");
});

console.log(`\n${passed} passed`);
