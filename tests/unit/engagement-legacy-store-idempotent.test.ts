// Release review follow-up (DEP-1/DEP-2): storing the OLD tracker's reading
// must be idempotent across regenerations. A blind view's neutral s_<id> key
// is stored under the key of the section it resolves to at store time; after
// a regeneration renamed that section, the next store (automatic at every
// regeneration, or a backfill run) planned the same reading under the new
// key, ON CONFLICT (visit, page) didn't catch it, and the page's time was
// doubled (checker's clone: 705 s true → 870 s after a 2nd regeneration →
// 990 s after a backfill). A visit already stored is now never written again.
// The store runs over an in-memory table with the SQL's semantics (visit
// skip + ON CONFLICT DO NOTHING); the reader is the real loader.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/engagement-legacy-store-idempotent.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { storage } from "../../server/storage";
import { loadDealReadingFacts, setReadingSource, _setLiveRenditionForTests } from "../../server/engagement/facts";
import { buildDocumentResponse } from "../../server/engagement/responses";
import { planLegacyRows, unstoredRows, type LegacyRollupRow, type LegacyVisitRow } from "../../server/engagement/legacy-store";
import type { LegacyExit } from "../../server/engagement/legacy";
import { assignLineage } from "../../server/analytics/lineage";
import { buildPageIndex } from "../../server/analytics/renditions";
import { blindSectionKey } from "../../shared/cim-buyer-view";
import { DEFAULT_ENGAGEMENT_FILTERS } from "../../shared/analytics-v2";
import type { ReadingSource } from "../../server/engagement/queries";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

type Sec = { id: string; sectionKey: string; sectionTitle: string; layoutType: string; order: number; analyticsLineage?: string | null };
const asBuyerSection = (s: Sec) => ({ ...s, dealId: "deal-h", layoutData: { content: "Text." }, aiDraftContent: null, brokerEditedContent: null, isVisible: true });

// Harbourline-like CIM; the team and revenue pages are renamed by each regeneration.
const V1: Sec[] = [
  { id: "sec-overview-1", sectionKey: "company_overview", sectionTitle: "Company Overview", layoutType: "prose_highlight", order: 1 },
  { id: "sec-team-1", sectionKey: "clinical_team", sectionTitle: "Clinical Team", layoutType: "org_chart", order: 2 },
  { id: "sec-revenue-1", sectionKey: "service_revenue", sectionTitle: "Service Revenue", layoutType: "donut_chart", order: 3 },
];
const at = (m: number) => new Date(Date.UTC(2026, 8, 5, 21, m));
// A blind-view buyer (neutral keys) and a normal-view buyer (real keys).
const EXITS: LegacyExit[] = [
  { accessId: "b1", key: blindSectionKey("sec-overview-1"), seconds: 40, at: at(1) },
  { accessId: "b1", key: blindSectionKey("sec-team-1"), seconds: 50, at: at(2) },
  { accessId: "b1", key: blindSectionKey("sec-revenue-1"), seconds: 70, at: at(4) },
  { accessId: "b2", key: "clinical_team", seconds: 60, at: at(50) },
  { accessId: "b2", key: "service_revenue", seconds: 30, at: at(51) },
];
const TRUE_MS = (40 + 50 + 70 + 60 + 30) * 1000;
const ACCESSES = [
  { id: "b1", dealId: "deal-h", buyerEmail: "b1@x.invalid", buyerName: "Blind", accessLevel: "teaser", decision: null, createdAt: at(0), accessEvents: [] },
  { id: "b2", dealId: "deal-h", buyerEmail: "b2@x.invalid", buyerName: "Full", accessLevel: "full", decision: null, createdAt: at(0), accessEvents: [] },
] as any[];
const DEAL = { id: "deal-h", businessName: "Harbourline Dental Group", buyerDeepCheck: null } as any;

// ── The tables, with the SQL's semantics ─────────────────────────────────
let sections: Sec[] = V1;
const visits = new Map<string, LegacyVisitRow>();
const rollups = new Map<string, LegacyRollupRow>();   // (visit, page, '') primary key
/** storeLegacyReading, table for table: skip stored visits, then INSERT … ON CONFLICT DO NOTHING. */
function store() {
  const plan = planLegacyRows(EXITS, ACCESSES, sections);
  const todo = unstoredRows(plan, new Set(visits.keys()));
  for (const v of todo.visits) if (!visits.has(v.id)) visits.set(v.id, v);
  for (const r of todo.rollups) { const k = `${r.visitId}|${r.pageId}|`; if (!rollups.has(k)) rollups.set(k, r); }
  return { plan, todo };
}
/** Before this fix: every planned row, ON CONFLICT DO NOTHING only. */
function storeUnguarded() {
  const plan = planLegacyRows(EXITS, ACCESSES, sections);
  for (const v of plan.visits) if (!visits.has(v.id)) visits.set(v.id, v);
  for (const r of plan.rollups) { const k = `${r.visitId}|${r.pageId}|`; if (!rollups.has(k)) rollups.set(k, r); }
}
let gen = 1;
function regenerate() {
  gen++;
  const next = V1.map((s) => ({ sectionKey: `${s.sectionKey}_v${gen}`, sectionTitle: s.sectionTitle, layoutType: s.layoutType, order: s.order }));
  const lineage = assignLineage(sections, next);
  sections = next.map((n, i) => ({ ...n, id: `${V1[i].id.replace(/-1$/, "")}-${gen}`, analyticsLineage: lineage[i] }));
}
const storedMs = () => Array.from(rollups.values()).reduce((t, r) => t + r.attentionMs, 0);
const reset = () => { sections = V1; visits.clear(); rollups.clear(); gen = 1; };

const st = storage as any;
st.getBuyerAccessByDeal = async () => ACCESSES;
st.getCimSectionsByDeal = async () => sections;
const source: ReadingSource = {
  async renditions() { return []; },
  async rendition() { return null; },
  async pageIndexes() { return new Map(); },
  async visits() {
    return Array.from(visits.values()).map((v) => ({
      id: v.id, accessId: v.accessId, renditionId: null, startedAt: v.startedAt, lastSeenAt: v.lastSeenAt, wallMs: v.wallMs, activeMs: v.activeMs,
      deviceClass: null, uaFamily: null, maxPageIndex: null, path: v.path, legacy: true, ipHash: null,
    }));
  },
  async blockSums() {
    return Array.from(rollups.values()).map((r) => ({
      accessId: r.accessId, renditionId: null, lineageId: r.lineageId, pageId: r.pageId, blockKey: "",
      attentionMs: r.attentionMs, skimMs: 0, visibleMs: r.attentionMs, pointerMs: 0, firstAt: r.firstAt, lastAt: r.lastAt,
    }));
  },
  async visitPages() {
    return Array.from(rollups.values()).map((r) => ({ accessId: r.accessId, visitId: r.visitId, renditionId: null, lineageId: r.lineageId, pageId: r.pageId, attentionMs: r.attentionMs }));
  },
  async events() { return []; },
  async questions() { return []; },
  async decisions() { return []; },
  async legacyExits() { return visits.size ? [] : EXITS; },
};
setReadingSource(source);
_setLiveRenditionForTests(async (_deal, _level, createdAt = new Date()) => {
  const pageIndex = buildPageIndex(sections.map(asBuyerSection) as any, { brokerage: { showDisclaimerPage: false, showContactPage: false } } as any, sections);
  const raw = { id: `live-${sections[0].id}`, mode: "normal", variant: "full", createdAt, visits: 0 };
  return { raw, row: { ...raw, sections: [], design: null, pageIndex } };
});
const doc = async () => buildDocumentResponse(await loadDealReadingFacts(DEAL, DEFAULT_ENGAGEMENT_FILTERS, new Date("2026-09-30T12:00:00Z")));
const readOn = (d: Awaited<ReturnType<typeof doc>>, title: string) =>
  d.pages.filter((p) => sections.find((x) => x.id === p.pageId)?.sectionTitle === title).reduce((t, p) => t + p.attentionMs, 0);

console.log("the failure (before this fix): blind keys are re-stored under the renamed key");
await test("a second regeneration and a backfill doubled the blind buyer's pages", () => {
  reset();
  storeUnguarded();              // regeneration 1 stores
  assert.equal(storedMs(), TRUE_MS);
  regenerate();
  storeUnguarded();              // regeneration 2 stores
  assert.ok(storedMs() > TRUE_MS, "reproduces the checker's 705 s → 870 s");
});

console.log("idempotent: a stored visit is never written again");
await test("store → regenerate → store → regenerate → backfill: the same rows, the same time", async () => {
  reset();
  store();                       // just before regeneration 1 replaces V1
  const rows1 = rollups.size;
  assert.equal(storedMs(), TRUE_MS);
  regenerate();
  const second = store();        // just before regeneration 2
  assert.equal(second.todo.visits.length, 0, "every visit is already stored");
  assert.equal(second.todo.rollups.length, 0, "so none of its page rows are planned again");
  assert.ok(second.plan.rollups.some((r) => !rollups.has(`${r.visitId}|${r.pageId}|`)), "the plan alone does name the renamed keys (why the visit skip is needed)");
  regenerate();
  store();                       // a backfill --apply
  store();                       // and again
  assert.equal(rollups.size, rows1);
  assert.equal(storedMs(), TRUE_MS);
  const d = await doc();
  assert.equal(readOn(d, "Clinical Team"), 110_000, "50 s (blind) + 60 s (full), not 150 s");
  assert.equal(readOn(d, "Service Revenue"), 100_000, "70 s + 30 s, not 140 s");
  assert.equal(readOn(d, "Company Overview"), 40_000);
  assert.equal(d.legacyUnmatched ?? null, null, "every stored row still finds its page through the lineage");
  assert.equal(d.pages.reduce((t, p) => t + p.attentionMs, 0), TRUE_MS);
});
await test("a visit not stored yet is still stored whole (new buyers' old reading)", () => {
  reset();
  store();
  const b1 = Array.from(visits.keys()).find((id) => visits.get(id)!.accessId === "b1")!;
  visits.delete(b1);
  for (const [k, r] of Array.from(rollups.entries())) if (r.visitId === b1) rollups.delete(k);
  regenerate();
  const { todo } = store();
  assert.deepEqual(todo.visits.map((v) => v.accessId), ["b1"]);
  assert.equal(storedMs(), TRUE_MS);
});
await test("the store skips stored visits in the database too (one transaction, locked per deal)", () => {
  const src = readFileSync("server/engagement/legacy-store.ts", "utf8");
  assert.match(src, /pg_advisory_xact_lock/);
  assert.match(src, /SELECT id FROM buyer_visits WHERE deal_id = \$\{dealId\} AND legacy/);
  assert.match(src, /const todo = unstoredRows\(plan, storedIds\)/);
  assert.doesNotMatch(src, /plan\.rollups\.slice/, "only the unstored rows are inserted");
});

_setLiveRenditionForTests(null);
console.log(`\n${passed} passed`);
