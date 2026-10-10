/**
 * Release fix F8 (ux-journeys, Pacific copy): after one due-diligence buyer
 * read the published update, the Engagement tab drew EVERY buyer on the DD
 * version's pages — Blind buyers were "skipped" on "How the figures check
 * out" (a DD-only page they never had) and read "x of 33 pages", while
 * Analytics said "x of 30".
 * Now: the drawing prefers the version most buyers in view were given, each
 * buyer's strip and counts cover only the pages of their own version, and the
 * Buyers tab counts the same content pages Analytics does.
 * No database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/engagement-served-pages.test.ts
 */
import assert from "node:assert/strict";
import { assembleFacts, chooseRendition, type AssembleInput } from "../../server/engagement/facts";
import { buildPageIndex } from "../../server/analytics/renditions";
import { buildBuyersResponse, buildDocumentResponse } from "../../server/engagement/responses";
import { readingSummary } from "../../server/engagement/insights";
import { DEFAULT_ENGAGEMENT_FILTERS, pagesServedTo } from "../../shared/analytics-v2";
import type { BuyerSection } from "../../shared/cim-buyer-view";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

const S = (id: string, order: number, layoutType: string, sectionTitle: string, layoutData: unknown): BuyerSection => ({
  id, dealId: "d", sectionKey: `s_${id}`, sectionTitle, order, layoutType, layoutData, aiDraftContent: null, brokerEditedContent: null, isVisible: true,
});
const fin = { headers: ["", "2024"], rows: [{ label: "Revenue", values: ["$29,180,000"] }, { label: "Adjusted EBITDA", values: ["$3,900,000"] }] };
const grid = { metrics: [{ label: "Trucks", value: "84" }] };
const design = { brokerage: { showDisclaimerPage: false, showContactPage: false } };
const lineages = [{ id: "fin", analyticsLineage: "L-fin" }, { id: "grid", analyticsLineage: "L-grid" }, { id: "check", analyticsLineage: "L-check" }, { id: "team", analyticsLineage: "L-team" }];
// The Blind CIM: three pages. The DD version: the same three + "How the figures check out" after the financials.
const blindIdx = buildPageIndex([S("fin", 0, "financial_table", "Financial Performance", fin), S("grid", 1, "metric_grid", "Fleet", grid), S("team", 2, "metric_grid", "Team", { metrics: [{ label: "Drivers", value: "96" }] })], design, lineages);
const ddIdx = buildPageIndex([S("fin", 0, "financial_table", "Financial Performance", fin), S("check", 1, "dd_source_check", "How the figures check out", { rows: [] }), S("grid", 2, "metric_grid", "Fleet", grid), S("team", 3, "metric_grid", "Team", { metrics: [{ label: "Drivers", value: "96" }] })], design, lineages);
const now = new Date("2026-10-10T12:00:00Z");
const acc = (id: string, accessLevel: string) => ({ id, dealId: "d", buyerEmail: `${id}@x.invalid`, buyerName: id, accessLevel, decision: "interested", createdAt: now, accessEvents: [] }) as any;
const blindR = { id: "r-blind", mode: "blind", variant: "full", createdAt: new Date("2026-09-29T00:00:00Z"), visits: 2 };
const ddR = { id: "r-dd", mode: "dd", variant: "full", createdAt: new Date("2026-10-10T09:00:00Z"), visits: 1 };
const visit = (id: string, accessId: string, renditionId: string, maxPageIndex: number) => ({
  id, accessId, renditionId, startedAt: new Date("2026-10-01T00:00:00Z"), lastSeenAt: new Date("2026-10-01T00:20:00Z"), wallMs: 1_200_000, activeMs: 900_000,
  deviceClass: "desktop", uaFamily: null, maxPageIndex, path: [], legacy: false, ipHash: null,
});
const sum = (accessId: string, renditionId: string, pageId: string, lineageId: string, blockKey: string, ms: number) =>
  ({ accessId, renditionId, lineageId, pageId, blockKey, attentionMs: ms, skimMs: 0, visibleMs: ms, pointerMs: 0, firstAt: null, lastAt: null });
const input = (over: Partial<AssembleInput> = {}): AssembleInput => ({
  deal: { id: "d", businessName: "Deal" },
  filters: DEFAULT_ENGAGEMENT_FILTERS,
  now,
  accesses: [acc("travis", "blind"), acc("gurdeep", "blind"), acc("dd", "due_diligence")],
  live: [],
  renditions: [blindR, ddR],
  chosen: ddR,
  indexes: new Map([["r-blind", blindIdx], ["r-dd", ddIdx]]),
  visits: [visit("v1", "travis", "r-blind", 2), visit("v2", "gurdeep", "r-blind", 1), visit("v3", "dd", "r-dd", 3)],
  sums: [
    sum("travis", "r-blind", "fin", "L-fin", "row:0", 60_000), sum("travis", "r-blind", "grid", "L-grid", "metric:0", 20_000), sum("travis", "r-blind", "team", "L-team", "metric:0", 9_000),
    sum("gurdeep", "r-blind", "fin", "L-fin", "row:1", 40_000),
    sum("dd", "r-dd", "fin", "L-fin", "row:0", 30_000), sum("dd", "r-dd", "check", "L-check", "row:0", 45_000),
  ],
  visitPages: [], events: [], questions: [], decisions: [],
  ...over,
});

test("the drawing prefers the version most buyers in view were given (not the newest DD one)", () => {
  const visits = input().visits as any[];
  assert.equal(chooseRendition([blindR, ddR] as any, visits, null)!.id, "r-dd", "the old rule: the newest generation with reading");
  assert.equal(chooseRendition([blindR, ddR] as any, visits, null, "blind")!.id, "r-blind");
  assert.equal(chooseRendition([blindR, ddR] as any, visits, null, "normal")!.id, "r-blind", "no Full CIM version: anything but DD");
  assert.equal(chooseRendition([blindR, ddR] as any, visits, null, "dd")!.id, "r-dd", "a DD-only view draws the DD version");
  assert.equal(chooseRendition([blindR, ddR] as any, visits, "r-dd", "blind")!.id, "r-dd", "the broker's pick always wins");
});

test("drawn on the DD version: Blind buyers' strips leave out the DD-only page — never 'skipped'", () => {
  const facts = assembleFacts(input());
  const travis = facts.buyers.find((b) => b.accessId === "travis")!;
  assert.deepEqual(travis.servedPageIds, ["fin", "grid", "team"]);
  assert.equal(facts.buyers.find((b) => b.accessId === "dd")!.servedPageIds, undefined, "the DD buyer has every drawn page");
  assert.deepEqual(pagesServedTo(travis, facts.pages).map((p) => p.pageId), ["fin", "grid", "team"]);
  const cards = buildBuyersResponse(facts).buyers;
  const t = cards.find((c) => c.accessId === "travis")!;
  assert.ok(!t.pageStrip.some((c) => c.pageId === "check"), "no DD page in a Blind buyer's strip");
  assert.equal(t.totalPages, 3, "out of 3 pages, not 4");
  assert.equal(t.pagesReached, 3);
  const g = cards.find((c) => c.accessId === "gurdeep")!;
  assert.ok(!g.pageStrip.some((c) => c.readLabel === "skipped" && c.pageId === "check"));
  const d = cards.find((c) => c.accessId === "dd")!;
  assert.equal(d.totalPages, 4, "the DD buyer's own version has the check page");
  assert.ok(d.pageStrip.some((c) => c.pageId === "check"));
  // The heat map: only the DD buyer reached the check page.
  const doc = buildDocumentResponse(facts);
  assert.equal(doc.pages.find((p) => p.pageId === "check")!.reachedBy, 1);
  assert.equal(doc.pages.find((p) => p.pageId === "team")!.reachedBy, 2, "Travis and the DD buyer");
});

test("one denominator: the Buyers tab's 'of N pages' = Analytics' content pages for the same buyer", () => {
  const facts = assembleFacts(input());
  const cards = buildBuyersResponse(facts).buyers;
  for (const b of facts.buyers) {
    const card = cards.find((c) => c.accessId === b.accessId)!;
    assert.equal(card.totalPages, readingSummary(b, facts.pages).contentPages, b.accessId);
  }
});

test("old tracking (no version on a visit): every drawn page — except a due-diligence-only page for a buyer who isn't DD", () => {
  const facts = assembleFacts(input({ visits: [{ ...visit("v1", "travis", "r-blind", 2), renditionId: null, legacy: true } as any, visit("v3", "dd", "r-dd", 3)] }));
  // The DD check page here is a dd_source_check layout: never in a Blind buyer's version.
  assert.deepEqual(facts.buyers.find((b) => b.accessId === "travis")!.servedPageIds, ["fin", "grid", "team"]);
  assert.equal(facts.buyers.find((b) => b.accessId === "dd")!.servedPageIds, undefined, "the DD buyer keeps every page");
  const cards = buildBuyersResponse(facts).buyers;
  assert.ok(!cards.find((c) => c.accessId === "travis")!.pageStrip.some((c) => c.pageId === "check"));
  // A drawing with no DD-only page: old tracking counts every page.
  const blindDrawn = assembleFacts(input({ chosen: blindR, visits: [{ ...visit("v1", "travis", "r-blind", 2), renditionId: null, legacy: true } as any] }));
  assert.equal(blindDrawn.buyers.find((b) => b.accessId === "travis")!.servedPageIds, undefined);
});

console.log(`engagement-served-pages: ${passed} passed`);
