// Release review DEP-1 + DEP-2: reading recorded by the OLD tracker
// (analytics_events 'section_exit') must survive a CIM regeneration, and
// storing it (the backfill's "store it permanently") must not blank the
// Engagement tab's Document view.
//   DEP-1: the on-the-fly view matched old keys only to the CURRENT keys —
//          Beacon's rebuild renamed 13 of 17 and 155 of 221 exits vanished
//          silently. Pacific (370/370 today) would lose most at its rebuild.
//   DEP-2: once stored (rendition NULL), a deal nobody had opened since the
//          release had no version to draw on — Document view: 0 pages.
// The loader runs end to end (loadDealReadingFacts) over an in-memory
// reading source and stubbed storage; the CIM "as served now" is built from
// the sections with the real page indexer. No database, no AI.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/engagement-legacy-survives.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { storage } from "../../server/storage";
import { loadDealReadingFacts, setReadingSource, _setLiveRenditionForTests } from "../../server/engagement/facts";
import { buildDocumentResponse } from "../../server/engagement/responses";
import { planLegacyRows } from "../../server/engagement/legacy-store";
import { legacyKeyResolver, matchLegacyKey, type LegacyExit } from "../../server/engagement/legacy";
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
const layoutData = (layoutType: string) =>
  layoutType === "financial_table" ? { headers: ["", "2024"], rows: [{ label: "Revenue", values: ["$1"] }] }
    : layoutType === "metric_grid" ? { metrics: [{ label: "A", value: "1" }] }
      : { content: "Text." };
const asBuyerSection = (s: Sec) => ({ ...s, dealId: "deal-b", layoutData: layoutData(s.layoutType), aiDraftContent: null, brokerEditedContent: null, isVisible: true });

// Beacon before its rebuild (keys as the old tracker recorded them) …
const OLD: Sec[] = [
  { id: "o-cover", sectionKey: "cover_page", sectionTitle: "Beacon Specialty Pharmacy Inc.", layoutType: "cover_page", order: 1 },
  { id: "o-rev", sectionKey: "services_revenue_streams", sectionTitle: "Services & Revenue Streams", layoutType: "donut_chart", order: 2 },
  { id: "o-cust", sectionKey: "customers_payers_concentration", sectionTitle: "Customers, Payers & Concentration", layoutType: "horizontal_bar_chart", order: 3 },
  { id: "o-norm", sectionKey: "normalized_earnings", sectionTitle: "Normalized Earnings", layoutType: "waterfall_chart", order: 4 },
  { id: "o-hist", sectionKey: "history_milestones", sectionTitle: "History & Milestones", layoutType: "timeline", order: 5 },
  { id: "o-team", sectionKey: "team_key_personnel", sectionTitle: "Our Team", layoutType: "org_chart", order: 6 },
];
// … and after it (production's rebuilt keys and titles, 2026-09-29).
const NEW_KEYS: Array<Omit<Sec, "id" | "analyticsLineage">> = [
  { sectionKey: "cover_page", sectionTitle: "Beacon Specialty Pharmacy Inc.", layoutType: "cover_page", order: 1 },
  { sectionKey: "revenue_streams", sectionTitle: "Revenue Composition", layoutType: "donut_chart", order: 2 },
  { sectionKey: "customer_concentration", sectionTitle: "Customer & Payer Concentration", layoutType: "horizontal_bar_chart", order: 3 },
  { sectionKey: "sde_normalization", sectionTitle: "Seller's Discretionary Earnings", layoutType: "waterfall_chart", order: 4 },
  { sectionKey: "compliance_incident_history", sectionTitle: "Incident & Compliance History", layoutType: "prose_highlight", order: 5 },
  { sectionKey: "key_people", sectionTitle: "Management", layoutType: "org_chart", order: 6 },
];

const at = (m: number) => new Date(Date.UTC(2026, 8, 5, 21, m));
const EXITS: LegacyExit[] = [
  { accessId: "a1", key: "cover_page", seconds: 20, at: at(1) },
  { accessId: "a1", key: "services_revenue_streams", seconds: 90, at: at(3) },
  { accessId: "a1", key: "normalized_earnings", seconds: 120, at: at(6) },
  { accessId: "a1", key: "history_milestones", seconds: 60, at: at(8) },
  { accessId: "a2", key: "customers_payers_concentration", seconds: 45, at: at(40) },
  { accessId: "a2", key: `s_${"o-team".replace(/[^a-z0-9]/gi, "")}`, seconds: 30, at: at(41) }, // a blind view's neutral key
];
const ACCESSES = [
  { id: "a1", dealId: "deal-b", buyerEmail: "a1@x.invalid", buyerName: "Ada", accessLevel: "full", decision: "interested", createdAt: at(0), accessEvents: [] },
  { id: "a2", dealId: "deal-b", buyerEmail: "a2@x.invalid", buyerName: "Bo", accessLevel: "teaser", decision: null, createdAt: at(0), accessEvents: [] },
] as any[];
const DEAL = { id: "deal-b", businessName: "Beacon Specialty Pharmacy Inc.", buyerDeepCheck: null } as any;

// The world the loader reads.
let sections: Sec[] = OLD;
/** What buyers are served, when it isn't the current sections (a live CIM under review: the kept copy). */
let servedOverride: Sec[] | null = null;
let stored: ReturnType<typeof planLegacyRows> | null = null;
let onTheFly: LegacyExit[] = EXITS;
const s = storage as any;
s.getBuyerAccessByDeal = async () => ACCESSES;
s.getCimSectionsByDeal = async () => sections;
const source: ReadingSource = {
  async renditions() { return []; },
  async rendition() { return null; },
  async pageIndexes() { return new Map(); },
  async visits() {
    return (stored?.visits ?? []).map((v) => ({
      id: v.id, accessId: v.accessId, renditionId: null, startedAt: v.startedAt, lastSeenAt: v.lastSeenAt, wallMs: v.wallMs, activeMs: v.activeMs,
      deviceClass: null, uaFamily: null, maxPageIndex: null, path: v.path, legacy: true, ipHash: null,
    }));
  },
  async blockSums() {
    return (stored?.rollups ?? []).map((r) => ({
      accessId: r.accessId, renditionId: null, lineageId: r.lineageId, pageId: r.pageId, blockKey: "",
      attentionMs: r.attentionMs, skimMs: 0, visibleMs: r.attentionMs, pointerMs: 0, firstAt: r.firstAt, lastAt: r.lastAt,
    }));
  },
  async visitPages() {
    return (stored?.rollups ?? []).map((r) => ({ accessId: r.accessId, visitId: r.visitId, renditionId: null, lineageId: r.lineageId, pageId: r.pageId, attentionMs: r.attentionMs }));
  },
  async events() { return []; },
  async questions() { return []; },
  async decisions() { return []; },
  // As the SQL does: nothing on the fly once legacy visits are stored.
  async legacyExits() { return stored ? [] : onTheFly; },
};
setReadingSource(source);
// The CIM as served now: the real page indexer over the current sections.
_setLiveRenditionForTests(async (_deal, _level, createdAt = new Date()) => {
  const served = servedOverride ?? sections;
  const pageIndex = buildPageIndex(served.map(asBuyerSection) as any, { brokerage: { showDisclaimerPage: false, showContactPage: false } } as any, served);
  const raw = { id: `live-${served[0].id}`, mode: "normal", variant: "full", createdAt, visits: 0 };
  return { raw, row: { ...raw, sections: [], design: null, pageIndex } };
});
const load = async () => {
  const facts = await loadDealReadingFacts(DEAL, DEFAULT_ENGAGEMENT_FILTERS, new Date("2026-09-30T12:00:00Z"));
  return { facts, doc: buildDocumentResponse(facts) };
};
const readOn = (doc: ReturnType<typeof buildDocumentResponse>, key: string) =>
  doc.pages.filter((p) => sections.find((x) => x.id === p.pageId)?.sectionKey === key).reduce((t, p) => t + p.attentionMs, 0);
const regenerate = () => {
  const lineage = assignLineage(sections, NEW_KEYS);
  sections = NEW_KEYS.map((n, i) => ({ ...n, id: `n${i}`, analyticsLineage: lineage[i] }));
};
const reset = () => { sections = OLD; stored = null; onTheFly = EXITS; servedOverride = null; };

console.log("renamed keys (Beacon, whose old sections are already gone)");
await test("each old key finds the renamed page; a page the CIM no longer has is left unplaced", () => {
  const renamed = NEW_KEYS.map((n, i) => ({ ...n, id: `n${i}` }));
  const r = legacyKeyResolver(renamed, blindSectionKey);
  assert.equal(r("services_revenue_streams"), "n1");
  assert.equal(r("customers_payers_concentration"), "n2");
  assert.equal(r("normalized_earnings"), "n3");
  assert.equal(r("team_key_personnel"), null, "'Management' shares no telling word with it — not guessed");
  assert.equal(r("history_milestones"), null, "not 'Incident & Compliance History' (a different page sharing a word)");
  assert.equal(matchLegacyKey("where_we_operate", [{ id: "x", sectionKey: "compounding_operations", sectionTitle: "Non-Sterile Compounding", layoutType: "two_column" }]), null, "a broad word alone never places a page");
});
await test("on the fly after a rebuild: renamed pages keep their reading; the rest is reported, never silently dropped", async () => {
  reset();
  sections = NEW_KEYS.map((n, i) => ({ ...n, id: `n${i}` }));   // Beacon: rebuilt without lineage, old sections gone
  const { facts, doc } = await load();
  assert.ok(doc.pages.length > 0);
  assert.equal(readOn(doc, "revenue_streams"), 90_000);
  assert.equal(readOn(doc, "sde_normalization"), 120_000);
  assert.equal(readOn(doc, "customer_concentration"), 45_000);
  assert.equal(readOn(doc, "compliance_incident_history"), 0);
  assert.ok(doc.legacyUnmatched, "the reading on pages this CIM no longer has is named");
  assert.deepEqual(doc.legacyUnmatched!.pages.map((p) => p.label).sort(), ["A page of an earlier version", "History milestones"]);
  assert.equal(doc.legacyUnmatched!.attentionMs, 90_000);
  // Every exit still counts toward its visit.
  const ada = facts.buyers.find((b) => b.accessId === "a1")!;
  assert.equal(ada.visits.length, 1);
  assert.equal(ada.visits[0].activeMs, 290_000);
});

console.log("regeneration of a deal whose old keys still resolve (Pacific)");
await test("before: every exit is placed", async () => {
  reset();
  const { doc } = await load();
  assert.equal(doc.legacyUnmatched ?? null, null);
  assert.equal(doc.pages.reduce((t, p) => t + p.attentionMs, 0), 20_000 + 90_000 + 120_000 + 60_000 + 45_000 + 30_000);
});
await test("stored just before the regeneration (as persistDocument does), then regenerated: every page is found by lineage — even renamed, retitled ones", async () => {
  reset();
  stored = planLegacyRows(EXITS, ACCESSES, sections);   // what storeLegacyReading writes, against the sections read then
  assert.ok(stored.rollups.every((r) => r.lineageId), "every row carries its section's lineage");
  regenerate();
  // The team page was renamed AND retitled ("Our Team" → "Management"): only lineage can place it.
  assert.equal(matchLegacyKey("team_key_personnel", sections), null);
  const { doc } = await load();
  assert.ok(doc.pages.length > 0, "DEP-2: stored legacy reading with no stored version still draws on the CIM as served now");
  assert.equal(readOn(doc, "key_people"), 30_000, "the blind view's key, placed through the lineage");
  assert.equal(readOn(doc, "revenue_streams"), 90_000);
  assert.equal(readOn(doc, "sde_normalization"), 120_000);
  // The rebuilt CIM has no history page (lineage didn't continue it, and a
  // shared word doesn't make "Incident & Compliance History" that page).
  assert.equal(readOn(doc, "compliance_incident_history"), 0);
  assert.deepEqual(doc.legacyUnmatched, { attentionMs: 60_000, pages: [{ label: "History milestones", attentionMs: 60_000 }] });
  assert.equal(doc.legacyOnly, true);
});
await test("a second regeneration: still found (lineage carries on)", async () => {
  const before = (await load()).doc.pages.reduce((t, p) => t + p.attentionMs, 0);
  const lineage = assignLineage(sections, NEW_KEYS.map((n) => ({ ...n, sectionKey: `${n.sectionKey}_v3` })));
  sections = NEW_KEYS.map((n, i) => ({ ...n, sectionKey: `${n.sectionKey}_v3`, id: `m${i}`, analyticsLineage: lineage[i] }));
  const { doc } = await load();
  assert.equal(doc.pages.reduce((t, p) => t + p.attentionMs, 0), before);
});

await test("a LIVE CIM regenerated and under review: buyers read the kept copy, and the stored reading lands on its old pages", async () => {
  reset();
  stored = planLegacyRows(EXITS, ACCESSES, sections);
  regenerate();
  servedOverride = OLD;   // published-snapshot.ts: the kept copy is what the view room serves until the broker publishes
  const { doc } = await load();
  const onOld = (key: string) => doc.pages.filter((p) => OLD.find((x) => x.id === p.pageId)?.sectionKey === key).reduce((t, p) => t + p.attentionMs, 0);
  assert.equal(onOld("services_revenue_streams"), 90_000);
  assert.equal(onOld("history_milestones"), 60_000, "the kept copy still has the history page");
  assert.equal(onOld("team_key_personnel"), 30_000);
  assert.equal(doc.legacyUnmatched ?? null, null);
});

console.log("DEP-2: the backfill ('store it permanently') keeps the Document view");
await test("stored against the current sections with no stored version: the same pages as on the fly", async () => {
  reset();
  const fly = (await load()).doc;
  stored = planLegacyRows(EXITS, ACCESSES, sections);
  const kept = (await load()).doc;
  assert.equal(kept.pages.length, fly.pages.length);
  assert.ok(kept.pages.length > 0);
  assert.deepEqual(kept.pages.map((p) => p.attentionMs), fly.pages.map((p) => p.attentionMs));
  assert.equal(kept.openedBy, fly.openedBy);
});
await test("storing is idempotent (same visit and row ids every run)", () => {
  const a = planLegacyRows(EXITS, ACCESSES, OLD);
  const b = planLegacyRows(EXITS, ACCESSES, OLD);
  assert.deepEqual(a.visits.map((v) => v.id), b.visits.map((v) => v.id));
  assert.deepEqual(a.rollups.map((r) => `${r.visitId}|${r.pageId}`), b.rollups.map((r) => `${r.visitId}|${r.pageId}`));
  assert.equal(a.exits, EXITS.length);
  assert.equal(a.rollups.reduce((t, r) => t + r.attentionMs, 0), 365_000, "every exit is stored");
});
await test("regeneration stores the old reading first; the backfill and the regeneration share the store", () => {
  const gen = readFileSync("server/cim/generation-jobs.ts", "utf8");
  const store = gen.indexOf("await storeLegacyReading(deal.id)");
  assert.ok(store > 0 && store < gen.indexOf("await storage.replaceDealCim("), "before the sections are replaced");
  assert.match(readFileSync("scripts/backfill-legacy-reading.ts", "utf8"), /storeLegacyReading\(deal\.id\)/);
  assert.match(readFileSync("server/engagement/legacy-store.ts", "utf8"), /ON CONFLICT \(visit_id, page_id, block_key\) DO NOTHING/);
});

_setLiveRenditionForTests(null);
console.log(`\n${passed} passed`);
