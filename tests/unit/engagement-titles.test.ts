/**
 * Page titles on the heat map (server/engagement/titles.ts): a page is
 * titled from the page itself — the kept copy, the named version buyers
 * were served — never from the section that continues it after a
 * regeneration. Pacific page 19 read "Working Capital Summary" over content
 * buyers saw as "Capital Expenditures & Fleet Replacement". No DB, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled node_modules/.bin/tsx tests/unit/engagement-titles.test.ts
 */
import assert from "node:assert/strict";
import { liveTitleSources, needsNamedNow, pageTitle, titleIndex, type TitleSources } from "../../server/engagement/titles";
import { assembleFacts, loadTitleSources, setReadingSource, type AssembleInput } from "../../server/engagement/facts";
import { buildPageIndex } from "../../server/analytics/renditions";
import { DEFAULT_ENGAGEMENT_FILTERS } from "../../shared/analytics-v2";
import type { BuyerSection } from "../../shared/cim-buyer-view";
import type { RawRendition, ReadingSource } from "../../server/engagement/queries";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

// Pacific, simplified: the kept copy (old ids o16, o18) is what buyers read;
// the draft has n08 (stored link to o18 — the wrong one), n18, n24.
const KEPT = [
  { id: "o16", sectionKey: "driver_workforce", sectionTitle: "Driver Workforce & Retention" },
  { id: "o18", sectionKey: "capex_fleet_replacement", sectionTitle: "Capital Expenditures & Fleet Replacement" },
];
const LIVE_BEFORE_REPAIR = [
  { id: "n08", sectionKey: "working_capital", sectionTitle: "Working Capital Summary", analyticsLineage: "o18" },
  { id: "n18", sectionKey: "driver_workforce", sectionTitle: "Driver Workforce & Retention", analyticsLineage: "o16" },
  { id: "n24", sectionKey: "capital_expenditures", sectionTitle: "Capital Investment & Fleet Renewal", analyticsLineage: null },
];
const LIVE_AFTER_REPAIR = LIVE_BEFORE_REPAIR.map((s) =>
  s.id === "n08" ? { ...s, analyticsLineage: null } : s.id === "n24" ? { ...s, analyticsLineage: "o18" } : s);
const src = (live = LIVE_BEFORE_REPAIR, over: Partial<TitleSources> = {}): TitleSources => ({ live, kept: KEPT, namedServed: new Map(), namedNow: null, ...over });
const page19 = { pageId: "o18", lineageId: "o18", servedTitle: "Capital Expenditures & Fleet Replacement" };

(async () => {
  console.log("title order");
  await test("a kept-copy page is titled from the kept copy, never its successor (Pacific page 19)", () => {
    const t = pageTitle(page19, "blind", src());
    assert.equal(t.title, "Capital Expenditures & Fleet Replacement");
    assert.equal(t.source, "kept_copy");
    assert.equal(t.sectionKey, "capex_fleet_replacement");
  });
  await test("the update note follows the lineage: wrong before the repair, right after it", () => {
    assert.deepEqual(pageTitle(page19, "blind", src()).update, { status: "renamed", title: "Working Capital Summary" });
    assert.deepEqual(pageTitle(page19, "blind", src(LIVE_AFTER_REPAIR)).update, { status: "renamed", title: "Capital Investment & Fleet Renewal" });
  });
  await test("update: same title → null; nothing continues it → no_successor; a current section → null", () => {
    assert.equal(pageTitle({ pageId: "o16", lineageId: "o16", servedTitle: "Driver Workforce & Retention" }, "blind", src()).update, null);
    assert.deepEqual(pageTitle({ pageId: "o99", lineageId: "o99", servedTitle: "Next Steps" }, "blind", src()).update, { status: "no_successor" });
    assert.equal(pageTitle({ pageId: "n08", lineageId: "o18", servedTitle: "Working Capital Summary" }, "normal", src()).update, null);
    assert.equal(pageTitle({ pageId: "cim-contact", lineageId: "cim-contact", servedTitle: "Contact" }, "blind", src()).update, null);
  });
  await test("a named version keeps its own served title (an unapproved draft rename doesn't leak in)", () => {
    const live = [{ id: "s1", sectionKey: "rev", sectionTitle: "Revenue Mix (draft rename)", analyticsLineage: null }];
    const t = pageTitle({ pageId: "s1", lineageId: "s1", servedTitle: "Revenue by Service Line" }, "normal", liveTitleSources(live));
    assert.deepEqual([t.title, t.source, t.sectionKey], ["Revenue by Service Line", "served", "rev"]);
    assert.equal(pageTitle({ pageId: "s1", lineageId: "s1", servedTitle: "Revenue by Service Line" }, "dd", liveTitleSources(live)).title, "Revenue by Service Line");
  });
  await test("a blind page: kept copy → stored named version → approved title now → live row → served", () => {
    const live = [{ id: "s1", sectionKey: "rev", sectionTitle: "Draft Title", analyticsLineage: null }];
    const p = { pageId: "s1", lineageId: "s1", servedTitle: "Project Coastline Revenue" };
    assert.equal(pageTitle(p, "blind", { live, kept: null, namedServed: new Map(), namedNow: new Map([["s1", "Approved Title"]]) }).title, "Approved Title");
    assert.equal(pageTitle(p, "blind", { live, kept: null, namedServed: new Map([["s1", "Named Version Title"]]), namedNow: new Map([["s1", "Approved Title"]]) }).title, "Named Version Title");
    assert.equal(pageTitle(p, "blind", { live, kept: [{ id: "s1", sectionKey: "rev", sectionTitle: "Kept Title" }], namedServed: new Map([["s1", "N"]]), namedNow: null }).title, "Kept Title");
    assert.equal(pageTitle(p, "blind", liveTitleSources(live)).title, "Draft Title");
    assert.equal(pageTitle({ ...p, pageId: "gone" }, "blind", liveTitleSources(live)).title, "Project Coastline Revenue");
  });
  await test("the disclaimer and contact pages keep their served titles", () => {
    assert.equal(pageTitle({ pageId: "cim-disclaimer", lineageId: "cim-disclaimer", servedTitle: "Confidentiality & disclaimer" }, "blind", src()).title, "Confidentiality & disclaimer");
  });
  await test("namedNow is needed only for a blind version with pages no stored source names", () => {
    const pages = [{ pageId: "o18" }, { pageId: "cim-contact" }];
    assert.equal(needsNamedNow(pages, "blind", { kept: KEPT, namedServed: new Map() }), false);
    assert.equal(needsNamedNow([...pages, { pageId: "x" }], "blind", { kept: KEPT, namedServed: new Map() }), true);
    assert.equal(needsNamedNow([...pages, { pageId: "x" }], "blind", { kept: KEPT, namedServed: new Map([["x", "X"]]) }), false);
    assert.equal(needsNamedNow([{ pageId: "x" }], "normal", { kept: null, namedServed: new Map() }), false);
  });

  console.log("assembleFacts uses the same rule (and realTitles)");
  const S = (id: string, order: number, sectionKey: string, sectionTitle: string, layoutType = "two_column"): BuyerSection => ({
    id, dealId: "d", sectionKey, sectionTitle, order, layoutType,
    layoutData: { left: { heading: "A", body: "x" }, right: { heading: "B", body: "y" } }, aiDraftContent: null, brokerEditedContent: null, isVisible: true,
  });
  // The kept copy as served blind (redacted titles), with the kept copy's own lineage.
  const blindIdx = buildPageIndex(
    [S("o16", 0, "driver_workforce", "Driver Workforce & Retention", "icon_stat_row"), S("o18", 1, "capex_fleet_replacement", "Capital Expenditures & Fleet Replacement")],
    { brokerage: { showDisclaimerPage: false, showContactPage: false } },
    [{ id: "o16" }, { id: "o18" }],
  );
  const chosen: RawRendition = { id: "r-live", mode: "blind", variant: "full", createdAt: new Date("2026-09-07T00:00:00Z"), visits: 0 };
  const input = (titles: TitleSources): AssembleInput => ({
    deal: { id: "d", businessName: "Pacific" },
    filters: DEFAULT_ENGAGEMENT_FILTERS,
    now: new Date("2026-10-09T00:00:00Z"),
    accesses: [],
    live: LIVE_BEFORE_REPAIR.map((s) => ({ ...s, layoutType: "two_column", isVisible: true })),
    renditions: [chosen],
    chosen,
    indexes: new Map([["r-live", blindIdx]]),
    visits: [], sums: [], visitPages: [], events: [], questions: [], decisions: [],
    titles,
  });
  await test("page 19's title is the kept copy's, its role from its own key/title, and the update named", () => {
    const facts = assembleFacts(input(src()));
    const p19 = facts.pages.find((p) => p.pageId === "o18")!;
    assert.equal(p19.title, "Capital Expenditures & Fleet Replacement");
    assert.equal(p19.servedTitle, null);
    assert.deepEqual(p19.update, { status: "renamed", title: "Working Capital Summary" });
    assert.equal(facts.pages.find((p) => p.pageId === "o16")!.role, "employees");
    // realTitles (routes/engagement.ts) and assembleFacts use one rule.
    const ix = titleIndex(src());
    for (const fp of facts.pages) assert.equal(fp.title, pageTitle(blindIdx.find((x) => x.pageId === fp.pageId)!, "blind", ix).title);
  });
  await test("without the kept copy the old successor lookup is gone: the live row of the SAME id or the served title", () => {
    const facts = assembleFacts(input(liveTitleSources(LIVE_BEFORE_REPAIR)));
    // o18 is not a live section: no successor title, the served title stands.
    assert.equal(facts.pages.find((p) => p.pageId === "o18")!.title, "Capital Expenditures & Fleet Replacement");
  });
  await test("loadTitleSources reads the kept copy (projection) and the newest named version's titles", async () => {
    const named: RawRendition = { id: "r-named", mode: "normal", variant: "full", createdAt: new Date("2026-09-08T00:00:00Z"), visits: 1 };
    const fake = {
      async keptCopyTitles() { return { takenAt: new Date("2026-09-29T14:02:17Z"), sections: KEPT }; },
      async pageIndexes(ids: string[]) { return new Map(ids.map((id) => [id, [{ ...blindIdx[0], servedTitle: "Named Driver Page" }]])); },
    } as unknown as ReadingSource;
    setReadingSource(fake);
    const s = await loadTitleSources({ id: "d" } as never, LIVE_BEFORE_REPAIR as never, [named], chosen, new Map([["r-live", blindIdx]]));
    assert.deepEqual(s.kept, KEPT);
    assert.equal(s.namedServed.get("o16"), "Named Driver Page");
    assert.equal(s.namedNow, null);
  });

  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
