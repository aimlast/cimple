/**
 * The heat map's acceptance check (server/engagement/heat-acceptance.ts,
 * scripts/check-demo-heat.ts; heat-map spec §7.3): passes on a seeded
 * example deal and fails on a whole-page wash, a missing sample flag and a
 * page carrying another page's title. Built over the real aggregation
 * (assembleFacts + buildDocumentResponse). No DB, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled node_modules/.bin/tsx tests/unit/demo-heat-acceptance.test.ts
 */
import assert from "node:assert/strict";
import { assembleFacts, type AssembleInput } from "../../server/engagement/facts";
import { buildDocumentResponse } from "../../server/engagement/responses";
import { heatAcceptance, heatTable } from "../../server/engagement/heat-acceptance";
import { buildPageIndex } from "../../server/analytics/renditions";
import { DEFAULT_ENGAGEMENT_FILTERS, type EngagementDocumentResponse } from "../../shared/analytics-v2";
import type { BuyerSection } from "../../shared/cim-buyer-view";
import type { RawBlockSum, RawVisit, RawVisitPage } from "../../server/engagement/queries";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

const S = (id: string, order: number, title: string): BuyerSection => ({
  id, dealId: "d", sectionKey: `k_${id}`, sectionTitle: title, order, layoutType: "metric_grid",
  layoutData: { metrics: [{ label: "Revenue", value: "$1" }, { label: "Margin", value: "20%" }] },
  aiDraftContent: null, brokerEditedContent: null, isVisible: true,
});
const SECTIONS = [S("p1", 0, "Business Overview"), S("p2", 1, "Capital Expenditures & Fleet Replacement"), S("p3", 2, "Next Steps")];
const idx = buildPageIndex(SECTIONS, { brokerage: { showDisclaimerPage: false, showContactPage: false } }, []);
const now = new Date("2026-10-09T12:00:00Z");
const r1 = { id: "r1", mode: "normal", variant: "full", createdAt: new Date("2026-09-07T00:00:00Z"), visits: 0 };
const acc = (id: string) => ({ id, dealId: "d", buyerEmail: `${id}@x.invalid`, buyerName: id, accessLevel: "full", decision: "interested", createdAt: now, accessEvents: [], firstViewedAt: now }) as any;

function docOf(opts: { sample: boolean; pageOnly?: boolean }): EngagementDocumentResponse {
  const v: RawVisit = {
    id: "v1", accessId: "A", renditionId: opts.pageOnly ? null : "r1", startedAt: new Date("2026-09-10T10:00:00Z"), lastSeenAt: new Date("2026-09-10T10:20:00Z"),
    wallMs: 1_200_000, activeMs: 600_000, deviceClass: "desktop", uaFamily: "Chrome/Mac", maxPageIndex: 1, path: [], legacy: !!opts.pageOnly, ipHash: null,
    demoSeed: opts.sample ? "demo-reading-v1" : null,
  };
  const sum = (pageId: string, blockKey: string, att: number): RawBlockSum => ({
    accessId: "A", renditionId: opts.pageOnly ? null : "r1", lineageId: pageId, pageId, blockKey: opts.pageOnly ? "" : blockKey, attentionMs: att, skimMs: 0, visibleMs: att, pointerMs: 0, firstAt: null, lastAt: null,
  });
  const sums = opts.pageOnly ? [sum("p1", "", 60_000), sum("p2", "", 90_000)] : [sum("p1", "metric:0", 60_000), sum("p2", "metric:1", 90_000)];
  const vps: RawVisitPage[] = [{ accessId: "A", visitId: "v1", renditionId: v.renditionId, lineageId: "p1", pageId: "p1", attentionMs: 60_000 }, { accessId: "A", visitId: "v1", renditionId: v.renditionId, lineageId: "p2", pageId: "p2", attentionMs: 90_000 }];
  const input: AssembleInput = {
    deal: { id: "d", businessName: "Deal", isLive: true, cimGeneration: null }, filters: DEFAULT_ENGAGEMENT_FILTERS, now,
    accesses: [acc("A")],
    live: SECTIONS.map((s) => ({ id: s.id, sectionKey: s.sectionKey, sectionTitle: s.sectionTitle, layoutType: s.layoutType, isVisible: true, analyticsLineage: null })),
    renditions: [r1], chosen: r1, indexes: new Map([["r1", idx]]),
    visits: [v], sums, visitPages: vps, events: [], questions: [], decisions: [],
  };
  return buildDocumentResponse(assembleFacts(input));
}

console.log("heat acceptance");
test("passes on a seeded example deal: every read page coloured part by part, marked as sample", () => {
  const doc = docOf({ sample: true });
  const res = heatAcceptance(doc, null);
  assert.equal(res.pass, true, res.lines.join("\n"));
  assert.match(res.lines[0], /^2 of 3 pages coloured part by part/);
  assert.equal(heatTable(doc).length, 3);
  assert.match(heatTable(doc)[1], /Capital Expenditures & Fleet Replacement\s+parts\s+1 min 30 s/);
});
test("fails on a whole-page wash (old page totals not converted)", () => {
  const res = heatAcceptance(docOf({ sample: false, pageOnly: true }), null);
  assert.equal(res.pass, false);
  assert.ok(res.lines.some((l) => /page 2 “Capital Expenditures & Fleet Replacement” has 1 min 30 s of reading but is shaded as a whole page/.test(l)));
});
test("fails when the reading isn't marked as sample data — skipped in preview mode", () => {
  const doc = docOf({ sample: false });
  assert.ok(heatAcceptance(doc, null).lines.includes("FAIL the reading isn't marked as sample data (sampleReading is false)"));
  assert.equal(heatAcceptance(doc, null, { preview: true }).pass, true);
});
test("fails on the page-19 mix-up: a page titled with the page that continues it, or two pages with one title", () => {
  const doc = docOf({ sample: true });
  const mixed = { ...doc, pages: doc.pages.map((p) => (p.pageId === "p2" ? { ...p, update: { status: "renamed" as const, title: p.title } } : p)) };
  assert.ok(heatAcceptance(mixed, null).lines.some((l) => /titled “Capital Expenditures & Fleet Replacement”, the title of the page that continues it/.test(l)));
  const dup = { ...doc, pages: doc.pages.map((p) => (p.pageId === "p1" ? { ...p, title: "Capital Expenditures & Fleet Replacement" } : p)) };
  assert.ok(heatAcceptance(dup, null).lines.some((l) => /two different pages are both titled/.test(l)));
});
test("the Pacific expectations name what's missing (counts, pages coloured, last recorded page)", () => {
  const res = heatAcceptance(docOf({ sample: true }), "pacific");
  assert.equal(res.pass, false);
  assert.ok(res.lines.includes("FAIL only 2 of 3 pages are coloured part by part (need ≥ 24)"));
  assert.ok(res.lines.includes("FAIL “opened it” is 1, expected 13"));
  assert.ok(res.lines.some((l) => /“Capital Expenditures & Fleet Replacement”/.test(l)) === false, "the capex page itself is coloured");
});
test("the Beacon expectations need the held + sample note and the 3 pages this version doesn't have", () => {
  const res = heatAcceptance(docOf({ sample: true }), "beacon");
  assert.ok(res.lines.some((l) => /version note is null, expected held with sample/.test(l)));
  assert.ok(res.lines.some((l) => /0 page\(s\) reported, expected 3/.test(l)));
});

test("Beacon (HM-C2): pages with no reading never count as recorded, and the reach sentence names a page with reading", () => {
  const doc = docOf({ sample: true });
  // The seeded fixture is right: page 3 has no reading and is not recorded; the sentence names page 2.
  assert.deepEqual(doc.pages.map((p) => p.reachRecorded), [true, true, false]);
  assert.match(doc.reachHeadline ?? "", /page 2 · Capital Expenditures & Fleet Replacement/);
  const ok = heatAcceptance(doc, "beacon");
  assert.ok(!ok.lines.some((l) => /no reading but counts as recorded|names page|no reading$|labelled/.test(l)), ok.lines.join("\n"));
  // The bug: a rebuild page with no reading counted as recorded, labelled "skipped", and the drop named on it.
  const bug = {
    ...doc,
    reachHeadline: "The biggest drop is around page 3 · Next Steps (10 → 7 readers).",
    pages: doc.pages.map((p) => (p.pageId === "p3" ? { ...p, reachRecorded: true, readLabel: "skipped" as const } : p)),
  };
  const res = heatAcceptance(bug, "beacon");
  assert.ok(res.lines.includes("FAIL page 3 “Next Steps” has no reading but counts as recorded (it can show a drop or “skipped”)"), res.lines.join("\n"));
  assert.ok(res.lines.includes("FAIL the reach sentence names page 3, which has no reading"));
  const labelled = { ...doc, pages: doc.pages.map((p) => (p.pageId === "p3" ? { ...p, readLabel: "skipped" as const } : p)) };
  assert.ok(heatAcceptance(labelled, null).lines.includes("FAIL page 3 “Next Steps” wasn't recorded but is labelled “skipped”"));
  // No sentence at all is a failure on Beacon (outside preview).
  assert.ok(heatAcceptance({ ...doc, reachHeadline: null }, "beacon").lines.includes("FAIL there is no “how far buyers got” sentence"));
});

console.log(`\n${passed} passed`);
