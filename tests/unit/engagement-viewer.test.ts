/**
 * The broker's document heat map (viewer stream): the pure rules behind it
 * (client/src/components/engagement/document/viewer-model.ts), the real
 * rendered page it paints over (PageCanvas — the served section with every
 * measured part marked, a split page trimmed to its own part, the blind
 * version showing only what the buyer saw), and the words on screen.
 * Server-rendered, no database, no AI, no browser.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/engagement-viewer.test.ts
 */
import "./react-global";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  blocksOf, blockFingerprint, expectedMsOf, partCount, topSegment,
} from "../../shared/cim-blocks";
import type {
  BlockAttention, DocumentPage, EngagementRenditionResponse, RenditionPage,
} from "../../shared/analytics-v2";
import {
  effectiveScope, heatIntensity, heatMaxMs, interactionLines, legendTicks, msAtIntensity, orderPages, paperTint,
  parsePageParam, partVisibility, partVisibilityCss, pathWidths, reachFallback, readersText, selectPageIndex,
  steepestDrop, topBlocks, unreadBlocks, TINT_STRENGTH, defaultSectionView, inView, isUnread, pageInView, pageOfText,
  drawMode, statusSentence, whyNotes, washFill, WASH_MAX_ALPHA, pageRank, railTint, pageLegendTicks, recordedReach, reachCountsLine,
  pageHeatMaxMs, ordinal, shortDate, type StatusContext,
} from "../../client/src/components/engagement/document/viewer-model";
import { PageCanvas } from "../../client/src/components/engagement/document/PageCanvas";
import { updateNote } from "../../client/src/components/engagement/document/PagePanel";

(globalThis as any).window ??= { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

function block(key: string, attentionMs: number, kind: BlockAttention["kind"] = "text", extra: Partial<BlockAttention> = {}): BlockAttention {
  return {
    key, kind, label: `Paragraph: ${key}`, attentionMs, skimMs: 0, visibleMs: attentionMs, pointerMs: 0, skimShare: 0,
    readers: attentionMs > 0 ? 1 : 0, topBuyer: null, topPoint: null, ...extra,
  };
}
function page(index: number, blocks: BlockAttention[], extra: Partial<DocumentPage> = {}): DocumentPage {
  return {
    pageId: `p${index}`, part: 0, index, label: String(index + 1), lineageId: `p${index}`, title: `Page ${index + 1}`, servedTitle: null,
    layoutType: "prose_highlight", role: "other", locked: false, readers: 1, reachedBy: 1,
    attentionMs: blocks.reduce((s, b) => s + b.attentionMs, 0), skimMs: 0, expectedMs: 10_000, readLabel: "read", headline: null,
    blocks, buyers: [], interactions: {}, questions: [], changedSince: null, pageLevelOnly: false, ...extra,
  };
}

console.log("viewer-model");

test("the ?page value parses to a page id and part; junk is ignored", () => {
  assert.deepEqual(parsePageParam("abc-123#1"), { pageId: "abc-123", part: 1 });
  assert.deepEqual(parsePageParam("cim-contact"), { pageId: "cim-contact", part: 0 });
  assert.equal(parsePageParam("<script>#1"), null);
  assert.equal(parsePageParam(""), null);
  assert.equal(parsePageParam(null), null);
});

test("the open page: the URL wins, a missing part falls back to the page, else the most-read page", () => {
  const pages = [page(0, [block("a", 5_000)]), page(1, [block("a", 90_000)]), { ...page(2, [block("a", 1_000)]), pageId: "p1", part: 1 }];
  assert.equal(selectPageIndex(pages, "p0#0"), 0);
  assert.equal(selectPageIndex(pages, "p1#1"), 2);
  assert.equal(selectPageIndex(pages, "p1#7"), 1, "unknown part → first part of that page");
  assert.equal(selectPageIndex(pages, "gone#0"), 1, "unknown page → the most-read page");
  assert.equal(selectPageIndex(pages, null), 1);
  assert.equal(selectPageIndex([], "p0#0"), -1);
});

test("rail order: document order, or most time first with ties in document order", () => {
  const pages = [page(0, [block("a", 10)]), page(1, [block("a", 30)]), page(2, [block("a", 30)])];
  assert.deepEqual(orderPages(pages, "document").map((p) => p.index), [0, 1, 2]);
  assert.deepEqual(orderPages(pages, "time").map((p) => p.index), [1, 2, 0]);
});

test("heat scale: busiest part within the page, or across the CIM; chart points and column containers never count", () => {
  const a = page(0, [block("heading", 500, "heading"), block("para:0", 20_000), block("para:1", 8_000), block("para:2", 4_000), block("chart/point:1", 999_000, "point")]);
  const b = page(1, [block("row:0", 60_000, "table"), block("left", 500_000, "column")]);
  assert.equal(heatMaxMs([a, b], "document", a), 60_000);
  assert.equal(heatMaxMs([a, b], "page", a), 20_000);
});

test("'within this page' falls back to the whole CIM when a page has too few parts to compare", () => {
  const single = page(0, [block("heading", 500, "heading"), block("page", 30_000, "page")]);
  const many = page(1, [block("para:0", 1), block("para:1", 1), block("para:2", 1)]);
  assert.equal(effectiveScope("page", single), "document");
  assert.equal(effectiveScope("page", many), "page");
  assert.equal(effectiveScope("document", many), "document");
  assert.equal(heatMaxMs([single, page(2, [block("row:0", 90_000, "table")])], "page", single), 90_000);
});

test("intensity and the legend agree, and the legend speaks in seconds, never percent", () => {
  for (const ms of [1_000, 12_000, 47_000, 120_000]) {
    const t = heatIntensity(ms, 120_000);
    assert.ok(Math.abs(msAtIntensity(t, 120_000) - ms) < 1, `round-trip ${ms}`);
  }
  assert.equal(heatIntensity(0, 100), 0);
  assert.equal(heatIntensity(50, 0), 0);
  assert.equal(heatIntensity(500, 100), 1);
  const ticks = legendTicks(120_000);
  assert.equal(ticks.length, 4);
  assert.equal(ticks[3].label, "2 min");
  for (const t of ticks) assert.match(t.label, /^\d+ (s|min)( \d+ s)?$/);
  assert.deepEqual(legendTicks(0), []);
});

test("the paper tint is the shared ramp at a lighter strength (text stays readable)", () => {
  assert.equal(paperTint(0), null);
  const full = paperTint(1)!;
  const alpha = Number(/rgba\(\d+, \d+, \d+, ([\d.]+)\)/.exec(full)![1]);
  assert.ok(Math.abs(alpha - 0.8 * TINT_STRENGTH) < 0.011, `alpha ${alpha}`);
});

test("pins 1–3 go to the parts with the most time; parts under a second, chart points and columns never get one", () => {
  const p = page(0, [block("a", 9_000), block("b", 30_000), block("c", 500), block("d", 12_000), block("e", 11_000), block("chart/point:0", 99_000, "point"), block("left", 99_000, "column")]);
  assert.deepEqual(topBlocks(p), ["b", "d", "e"]);
  assert.deepEqual(topBlocks(page(1, [block("x", 200)])), []);
  assert.deepEqual(topBlocks(page(2, [block("heading", 50_000, "heading"), block("chart", 9_000, "chart")])), ["chart"]);
});

test("'Nobody read this' marks parts under a second on pages buyers reached — not headings, not unreached pages", () => {
  const p = page(0, [block("heading", 0, "heading"), block("para:0", 400), block("para:1", 8_000), block("row:2", 0, "table")]);
  assert.deepEqual(unreadBlocks(p), ["para:0", "row:2"]);
  assert.deepEqual(unreadBlocks({ ...p, reachedBy: 0 }), []);
  // A table's Normalized rows are only on screen after a switch: never "nobody read".
  const q = page(1, [block("row:0", 5_000, "table"), block("nrow:0", 0, "table"), block("summary", 0, "summary")]);
  assert.deepEqual(unreadBlocks(q, [{ key: "row:0" }, { key: "nrow:0", when: "normalized" }, { key: "summary", when: "collapsed" }]), []);
});

test("a part that sat on screen isn't 'nobody read this' (small KPI items beside the reading)", () => {
  const p = page(0, [
    block("metric:0", 400, "metric", { visibleMs: 60_000 }),   // on screen the whole minute
    block("metric:1", 0, "metric", { visibleMs: 1_200 }),      // scrolled past
    block("para:0", 30_000),
  ]);
  assert.deepEqual(unreadBlocks(p), ["metric:1"]);
  assert.equal(isUnread({ attentionMs: 400, visibleMs: 60_000 }), false);
  assert.equal(isUnread({ attentionMs: 400, visibleMs: 0 }), true);
});

test("a collapsible section: drawn collapsed as buyers first saw it; its rows count only once someone opened it", () => {
  const rp = { blocks: [{ key: "heading" }, { key: "row:0" }, { key: "row:1" }, { key: "summary", when: "collapsed" as const }] } as any;
  const read = page(0, [
    block("heading", 0, "heading"), block("row:0", 0, "table"), block("row:1", 0, "table"),
    block("summary", 16_900, "summary", { visibleMs: 17_000 }),
  ]);
  // Nobody opened it: collapsed, the summary is painted; no row is "nobody read".
  assert.equal(defaultSectionView(read, rp), "collapsed");
  assert.deepEqual(unreadBlocks(read, rp.blocks, "collapsed"), []);
  assert.deepEqual(unreadBlocks(read, rp.blocks, "opened"), [], "rows never on screen are not 'nobody read'");
  assert.deepEqual(pageInView(read, "collapsed").blocks.map((b) => b.key), ["summary"]);
  assert.deepEqual(topBlocks(pageInView(read, "collapsed")), ["summary"]);
  assert.ok(!pageInView(read, "opened").blocks.some((b) => b.key === "summary"));
  assert.equal(inView("row:0", null), true);
  // A summary nobody read, on a page buyers reached, is outlined in the collapsed view.
  const skipped = page(0, [block("summary", 0, "summary", { visibleMs: 0 }), block("row:0", 0, "table")]);
  assert.deepEqual(unreadBlocks(skipped, rp.blocks, "collapsed"), ["summary"]);
  // Opened by buyers who read the rows more than the summary: opened first; unopened rows can be "nobody read".
  const opened = page(0, [block("summary", 4_000, "summary"), block("row:0", 30_000, "table"), block("row:1", 0, "table", { visibleMs: 0 })], { interactions: { expand: 2 } });
  assert.equal(defaultSectionView(opened, rp), "opened");
  assert.deepEqual(unreadBlocks(opened, rp.blocks, "opened"), ["row:1"]);
  // Not collapsible: no view.
  assert.equal(defaultSectionView(read, { blocks: [{ key: "row:0" }] } as any), null);
});

test("page numbers count the CIM's pages, not its printed parts", () => {
  const ps = ["1", "2", "3a", "3b", "4", "32"].map((label) => ({ label }));
  assert.equal(pageOfText("4", ps), "Page 4 of 32");
  assert.equal(pageOfText("3a", ps), "Page 3 of 32 (3a)");
  assert.equal(pageOfText("x", [{ label: "x" }]), "Page x of 1");
});

test("what buyers did, in words, most frequent first; video progress folds into plays", () => {
  const lines = interactionLines({ financial_view: 3, copy: 1, media_play: 2, media_progress: 5, contact_click: 1 });
  assert.deepEqual(lines.map((l) => l.type), ["financial_view", "media_play", "copy", "contact_click"]);
  assert.equal(lines[0].text, "Switched a table to Normalized · 3 times");
  assert.equal(lines.find((l) => l.type === "contact_click")!.text, "Clicked your email or phone");
  assert.deepEqual(interactionLines({}), []);
});

test("readers read as 'x of y' and never claim more buyers than read it", () => {
  assert.equal(readersText(5, 6), "5 of 6");
  assert.equal(readersText(3, 0), "3 of 3");
});

test("how far buyers got: the steepest drop, and a facts-only sentence when no headline came back", () => {
  const reach = [9, 9, 8, 4, 4, 3].map((buyers, i) => ({ buyers, index: i }));
  assert.deepEqual(steepestDrop(reach), { index: 3, from: 8, to: 4 });
  assert.equal(steepestDrop([{ buyers: 2 }, { buyers: 2 }]), null);
  assert.equal(steepestDrop([{ buyers: 1 }, { buyers: 1 }, { buyers: 0 }]), null, "one buyer stopping is not marked");
  assert.equal(steepestDrop([{ buyers: 6 }, { buyers: 5 }, { buyers: 5 }]), null, "a one-buyer drop is not marked");
  assert.equal(steepestDrop([{ buyers: 40 }, { buyers: 38 }]), null, "a drop under 10% is not marked");
  assert.equal(reachFallback([{ buyers: 3 }, { buyers: 3 }], 3), "All 3 buyers who opened the CIM reached the last page.");
  assert.equal(reachFallback([{ buyers: 6 }, { buyers: 2 }], 6), "6 buyers opened the CIM; 2 reached the last page.");
  assert.equal(reachFallback([], 0), null);
});

test("path strip widths sum to the whole strip and short stops keep a sliver", () => {
  const w = pathWidths([600, 2, 300, 1, 100]);
  assert.ok(Math.abs(w.reduce((s, x) => s + x, 0) - 1) < 1e-9);
  assert.ok(w[1] >= 0.012 && w[3] >= 0.012);
  assert.ok(w[0] > w[2] && w[2] > w[4]);
  assert.deepEqual(pathWidths([0, 0]), [0.5, 0.5]);
  assert.deepEqual(pathWidths([]), []);
});

// ── A split section and the rendered page ────────────────────────────────

const rows = Array.from({ length: 48 }, (_, i) => ({ label: `Line item ${i + 1}`, values: [`$${i + 1},000`, `$${i + 2},000`, `$${i + 3},000`] }));
const longTable = {
  id: "00000000-0000-4000-8000-00000000f001", dealId: "d1", sectionKey: "financialOverview", sectionTitle: "Income Statement",
  order: 1, layoutType: "financial_table", isVisible: true, aiDraftContent: null, brokerEditedContent: null,
  layoutData: { headers: ["", "FY2022", "FY2023", "FY2024"], rows, footnotes: ["Unaudited."] },
};
const tableBlocks = blocksOf(longTable);
const tablePage: RenditionPage = {
  pageId: longTable.id, lineageId: longTable.id, order: 0, parts: partCount(tableBlocks), servedTitle: "Income Statement",
  layoutType: "financial_table", locked: false, expectedMs: expectedMsOf(tableBlocks),
  blockFingerprint: blockFingerprint("financial_table", tableBlocks.filter((b) => !b.virtual && !b.when)),
  blocks: tableBlocks.map((b) => ({ key: b.key, kind: b.kind, label: b.label, expectedMs: b.expectedMs, part: b.part, ...(b.virtual ? { virtual: true as const } : {}), ...(b.when ? { when: b.when } : {}) })),
};

test("a long table splits into printed parts, and part b hides part a's rows but keeps the heading and header faded", () => {
  assert.ok(tablePage.parts >= 2, `expected a split, got ${tablePage.parts} part(s)`);
  const v1 = partVisibility(tablePage, 1);
  const v0 = partVisibility(tablePage, 0);
  const part0Rows = tablePage.blocks.filter((b) => b.part === 0 && /^row:\d+$/.test(b.key)).map((b) => b.key);
  const part1Rows = tablePage.blocks.filter((b) => b.part === 1 && /^row:\d+$/.test(b.key)).map((b) => b.key);
  assert.ok(part0Rows.length > 0 && part1Rows.length > 0);
  for (const k of part0Rows) assert.ok(v1.hide.includes(k), `part b hides ${k}`);
  for (const k of part1Rows) assert.ok(v0.hide.includes(k) && !v1.hide.includes(k), `only part a hides ${k}`);
  assert.ok(v1.fade.includes("heading") && !v1.hide.includes("heading"));
  assert.ok(!v0.fade.length, "part a fades nothing");
  for (const k of [...v0.hide, ...v1.hide]) assert.equal(topSegment(k), k, "only top-level parts are hidden");
  assert.deepEqual(partVisibility({ parts: 1, blocks: tablePage.blocks }, 0), { hide: [], fade: [] });
  const css = partVisibilityCss("#ev-x", v1);
  assert.match(css, /#ev-x \[data-cim-block="row:0"\]/);
  assert.match(css, /display:none/);
  assert.match(css, /opacity:\.45/);
  assert.equal(partVisibilityCss("#ev-x", { hide: [], fade: [] }), "");
});

function rendition(sections: any[], mode: "normal" | "blind", pages: RenditionPage[], realTitles: Record<string, string> = {}): EngagementRenditionResponse {
  return { id: "a".repeat(32), mode, variant: "full", createdAt: new Date(0).toISOString(), sections, design: null, pages, realTitles };
}
function renderCanvas(r: EngagementRenditionResponse, pageId: string, part: number, rp: RenditionPage | undefined): string {
  return renderToStaticMarkup(React.createElement(PageCanvas, {
    rendition: r, pageId, part, renditionPage: rp, page: null, paint: true, showHeat: true, showUnread: false, maxMs: 1,
    selectedKey: null, hoveredKey: null, onSelectKey() {}, onHoverKey() {}, touch: false,
  }));
}

console.log("rendered page");

test("the page renders the served section on theme-locked paper with every measured part marked", () => {
  const html = renderCanvas(rendition([longTable], "normal", [tablePage]), longTable.id, 0, tablePage);
  assert.match(html, /class="cim-doc cim-sheet/);
  assert.match(html, new RegExp(`data-cim-page="${longTable.id}"`));
  const keys = new Set([...html.matchAll(/data-cim-block="([^"]*)"/g)].map((m) => m[1]));
  for (const b of tablePage.blocks) if (!b.virtual && !b.when) assert.ok(keys.has(b.key), `marked ${b.key}`);
  const style = /<style>([^<]*)<\/style>/.exec(html)?.[1] ?? "";
  const own = tablePage.blocks.filter((b) => b.part === 0 && !b.virtual && !b.when).map((b) => b.key);
  for (const k of own) assert.ok(!style.includes(`&quot;${k}&quot;`), `part a keeps its own ${k}`);
  assert.ok(style.includes("&quot;foot&quot;"), "part a hides part b's footnotes");
});

test("part b of a split page carries the rule that hides part a", () => {
  const html = renderCanvas(rendition([longTable], "normal", [tablePage]), longTable.id, 1, tablePage);
  assert.match(html, /<style>[^<]*\[data-cim-block=&quot;row:0&quot;\][^<]*display:none/);
});

test("the disclaimer and contact pages render as the brokerage pages", () => {
  const r = rendition([longTable], "normal", [tablePage]);
  assert.match(renderCanvas(r, "cim-disclaimer", 0, undefined), /data-cim-page="cim-disclaimer"/);
  assert.match(renderCanvas(r, "cim-contact", 0, undefined), /data-cim-page="cim-contact"/);
});

test("a blind version renders what the blind buyer saw — never the real title on the page itself", () => {
  const blind = { ...longTable, sectionTitle: "Historical Financial Summary", layoutData: { ...longTable.layoutData, caption: "Project Atlas — three years" } };
  const r = rendition([blind], "blind", [{ ...tablePage, servedTitle: "Historical Financial Summary" }], { [longTable.id]: "Harbourline Dental — Income Statement" });
  const html = renderCanvas(r, blind.id, 0, r.pages[0]);
  assert.match(html, /Historical Financial Summary/);
  assert.match(html, /Project Atlas/);
  assert.doesNotMatch(html, /Harbourline/);
});

const collapsible = {
  id: "00000000-0000-4000-8000-00000000f002", dealId: "d1", sectionKey: "financialPerformance", sectionTitle: "Financial Performance",
  order: 2, layoutType: "financial_table", isVisible: true, aiDraftContent: null, brokerEditedContent: null,
  layoutData: { headers: ["", "FY2024", "FY2025"], rows: rows.slice(0, 12), expandable: true, summary: "Revenue grew 11% to $3.2M." },
};
function renderView(view: "collapsed" | "opened"): string {
  const b = blocksOf(collapsible);
  const rp: RenditionPage = {
    pageId: collapsible.id, lineageId: collapsible.id, order: 0, parts: partCount(b), servedTitle: collapsible.sectionTitle, layoutType: "financial_table", locked: false,
    expectedMs: expectedMsOf(b), blockFingerprint: "x", blocks: b.map((x) => ({ key: x.key, kind: x.kind, label: x.label, expectedMs: x.expectedMs, part: x.part, ...(x.when ? { when: x.when } : {}) })),
  };
  return renderToStaticMarkup(React.createElement(PageCanvas, {
    rendition: rendition([collapsible], "normal", [rp]), pageId: collapsible.id, part: 0, renditionPage: rp, page: null, paint: true, showHeat: true,
    showUnread: false, maxMs: 1, selectedKey: null, hoveredKey: null, onSelectKey() {}, onHoverKey() {}, touch: false, view,
  }));
}

test("a collapsible income statement renders collapsed (its summary is the painted part) or opened, as picked", () => {
  const closed = renderView("collapsed");
  assert.match(closed, /data-cim-block="summary"/);
  assert.match(closed, /Show full details/);
  const open = renderView("opened");
  assert.doesNotMatch(open, /data-cim-block="summary"/);
  assert.match(open, /data-cim-block="row:0"/);
  assert.match(open, /Show less/);
  // The summary sits on the section's first printed part.
  assert.equal(blocksOf(collapsible).find((x) => x.key === "summary")!.part, 0);
});

test("a page missing from this version says so instead of rendering something else", () => {
  const html = renderCanvas(rendition([longTable], "normal", [tablePage]), "00000000-0000-4000-8000-0000000000ff", 0, undefined);
  assert.match(html, /isn(&#x27;|')t in this version of the CIM/);
});

console.log("whole-page heat, status line and Why? (heat-map spec §3)");

type Heat = DocumentPage["heat"];
const heat = (basis: Heat["basis"], over: Partial<Heat> = {}): Heat => ({ basis, partBuyers: basis === "parts" || basis === "mixed" ? 3 : 0, pageOnlyBuyers: basis === "page" ? 8 : basis === "mixed" ? 2 : 0, pageOnlyMs: basis === "page" ? 1_660_000 : basis === "mixed" ? 250_000 : 0, reason: basis === "page" || basis === "mixed" ? "before_part_tracking" : null, ...over });
const hp = (attentionMs: number, h: Heat) => ({ attentionMs, heat: h });
const ctx = (over: Partial<StatusContext> = {}): StatusContext => ({ blind: false, showNamed: false, sameLayout: true, ...over });
const docOf = (over: Record<string, unknown> = {}) => ({ versionNote: null, sampleReading: false, reachBasis: "tracked", lastRecordedIndex: null, legacyUnmatched: null, pages: [], ...over }) as any;

test("what is drawn: each part, the whole page, or nothing", () => {
  assert.equal(drawMode(hp(60_000, heat("parts"))), "parts");
  assert.equal(drawMode(hp(60_000, heat("mixed"))), "parts");
  assert.equal(drawMode(hp(60_000, heat("page"))), "wash");
  assert.equal(drawMode(hp(60_000, heat("parts")), false), "wash", "the named version with different parts: whole page");
  assert.equal(drawMode(hp(500, heat("none"))), "none");
  assert.equal(drawMode(null), "none");
});
test("the wash stays light enough to read through (alpha ≤ 0.37) and grows with time", () => {
  const a = (c: string | null) => Number(/, ([\d.]+)\)$/.exec(c ?? "")?.[1]);
  assert.equal(washFill(0), null);
  assert.ok(a(washFill(1)) <= WASH_MAX_ALPHA + 1e-9 && a(washFill(1)) > 0.36);
  assert.ok(a(washFill(0.2)) < a(washFill(0.8)));
  assert.ok(a(washFill(0.01)) >= 0.1, "even a little reading shows");
  assert.match(washFill(0.5)!, /^rgba\(\d+, \d+, \d+, /, "explicit rgba on the theme-locked paper");
});
test("rank on the page: '3rd most-read of 29', 'Most-read of 29', nothing for an unread page", () => {
  const pages = [5, 30, 10, 20, 0].map((m, i) => ({ pageId: `p${i}`, part: 0, index: i, attentionMs: m * 1000 }));
  assert.equal(pageRank(pages, pages[1])!.text, "Most-read of 5");
  assert.equal(pageRank(pages, pages[2])!.text, "3rd most-read of 5");
  assert.equal(pageRank(pages, pages[4]), null);
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st"]);
  assert.equal(pageHeatMaxMs(pages), 30_000);
});
test("rail tiles are tinted by reading time in the brass token (both themes); unread tiles aren't", () => {
  assert.equal(railTint(0), null);
  assert.equal(railTint(1), "hsl(var(--teal) / 0.300)");
  assert.equal(railTint(0.5), "hsl(var(--teal) / 0.175)");
});
test("the whole-page legend speaks in seconds of page reading time", () => {
  const ticks = pageLegendTicks(36 * 60_000 + 46_000);
  assert.equal(ticks.length, 4);
  assert.equal(ticks[3].label, "36 min 46 s");
  assert.ok(ticks.every((t) => !/%/.test(t.label)));
});
test("the status line: one sentence, first match wins (spec §3.4)", () => {
  const d = docOf();
  assert.equal(statusSentence(hp(0, heat("none")), d, ctx()), "Nobody has read this page yet.");
  assert.equal(statusSentence(hp(60_000, heat("page")), docOf({ versionNote: { kind: "kept_copy", since: "2026-09-29T14:02:17Z" } }), ctx({ blind: true })),
    "Shaded as a whole page: read before Cimple tracked each part of a page.");
  assert.equal(statusSentence(hp(60_000, heat("page", { reason: "other_layout" })), d, ctx()), "Shaded as a whole page: buyers read a version of it with different parts.");
  assert.equal(statusSentence(hp(60_000, heat("mixed", { partBuyers: 1, pageOnlyBuyers: 2, pageOnlyMs: 250_000 })), d, ctx()),
    "Colours show where 1 buyer read; 2 more read it as a whole page (4 min 10 s).");
  assert.equal(statusSentence(hp(60_000, heat("parts")), docOf({ versionNote: { kind: "held", sample: true } }), ctx({ blind: true })), "Buyers can't open this CIM until you publish your update.");
  assert.equal(statusSentence(hp(60_000, heat("parts")), docOf({ versionNote: { kind: "kept_copy", since: "2026-09-29T14:02:17Z" } }), ctx()), "Buyers are still reading the version from before your 29 Sep update.");
  assert.equal(statusSentence(hp(60_000, heat("parts")), docOf({ versionNote: { kind: "older_version", changedPages: 3 } }), ctx()), "This is the version these buyers read; your CIM has changed since.");
  assert.equal(statusSentence(hp(60_000, heat("parts")), d, ctx({ blind: true })), "Blind version: exactly what blind buyers saw.");
  assert.equal(statusSentence(hp(60_000, heat("parts")), d, ctx()), null);
  assert.equal(shortDate("not a date"), null);
});
test("Why? lists every note that applies, in plain words", () => {
  const pages = [0, 1, 2, 3].map((i) => ({ index: i, label: String(27 + i), title: ["Transaction", "Next Steps & Contact", "Disclaimer", "Contact"][i], reachRecorded: i === 0 }));
  const notes = whyNotes(hp(60_000, heat("page")), docOf({
    versionNote: { kind: "kept_copy", since: "2026-09-29T14:02:17Z" }, sampleReading: true, reachBasis: "old_tracking", lastRecordedIndex: 0, pages,
    legacyUnmatched: { attentionMs: 660_000, pages: [{ label: "History milestones", attentionMs: 400_000 }, { label: "Where we operate", attentionMs: 260_000 }] },
  }), ctx({ blind: true }));
  assert.deepEqual(notes.map((n) => n.key), ["basis", "version", "blind", "not_recorded", "unmatched", "sample"]);
  assert.match(notes[0].text, /^Cimple recorded these visits before it tracked each part of a page/);
  assert.match(notes[1].text, /before your 29 Sep update, while the update waits for your review/);
  assert.equal(notes[3].text, `Cimple's earlier tracking didn't record pages 28–30 (Next Steps & Contact, Disclaimer, Contact), so "how far buyers got" stops at page 27.`);
  assert.match(notes[4].text, /^11 min of earlier reading was on pages this version of the CIM doesn't show \(History milestones, Where we operate\)/);
  assert.match(notes[5].text, /^This is an example deal\./);
  const held = whyNotes(hp(60_000, heat("parts")), docOf({ versionNote: { kind: "held", sample: true } }), ctx());
  assert.equal(held[0].text, "Buyers haven't seen this version yet. This sample reading is drawn on the version they'll get when you publish.");
  const heldReal = whyNotes(hp(60_000, heat("parts")), docOf({ versionNote: { kind: "held", sample: false } }), ctx());
  assert.equal(heldReal[0].text, "Buyers haven't seen this version yet. Shading shows the time they spent on the matching page of the version they read.");
  const named = whyNotes(hp(60_000, heat("parts")), docOf(), ctx({ blind: true, showNamed: true, sameLayout: false }));
  assert.equal(named[0].text, "The named version's parts differ from what blind buyers saw, so the whole page is shaded by its reading time.");
  // Never the internal words on screen.
  for (const n of [...notes, ...held, ...named]) assert.doesNotMatch(`${n.title} ${n.text}`, /legacy|rendition|dwell/i);
  assert.deepEqual(whyNotes(hp(60_000, heat("parts")), docOf(), ctx()), []);
});
test("how far buyers got: pages never recorded are left out of the drop; the counts match the Buyers view", () => {
  // Pacific: 12 ×8, 11, 9, 9, 8 ×13, 7, 6, 6, then 0 0 on the two pages the old tracking never recorded.
  const counts = [...Array(8).fill(12), 11, 9, 9, ...Array(13).fill(8), 7, 6, 6, 0, 0];
  const reach = counts.map((b, i) => ({ buyers: b, label: String(i + 1) }));
  const pagesRec = counts.map((_, i) => ({ reachRecorded: i < 27 }));
  assert.equal(steepestDrop(reach)!.index, 27, "without the rule: the stray drop onto page 28");
  assert.equal(steepestDrop(recordedReach(reach, pagesRec))!.index, 9, "with it: page 10 (11 → 9)");
  assert.equal(reachCountsLine({ openedTotal: 13, openedBy: 12, reach, pages: pagesRec, oldTracking: true }),
    "13 opened it · 12 with reading recorded · 6 got to page 27, the last page recorded");
  // No marked drop: the sentence above already says how far they got.
  const flat = [5, 5, 5].map((b, i) => ({ buyers: b, label: String(i + 1) }));
  assert.equal(reachCountsLine({ openedTotal: 5, openedBy: 5, reach: flat, pages: flat.map(() => ({ reachRecorded: true })), oldTracking: false }), "5 opened it");
});
test("the update note on a kept copy: renamed in the update, or nothing carries it on", () => {
  const kept = { versionNote: { kind: "kept_copy", since: "x" } } as any;
  assert.equal(updateNote({ update: { status: "renamed", title: "Capital Investment & Fleet Renewal" } }, kept), "In your update this page is “Capital Investment & Fleet Renewal”.");
  assert.equal(updateNote({ update: { status: "no_successor" } }, kept), "No page in your update carries on this page's reading history.");
  assert.equal(updateNote({ update: { status: "renamed", title: "X" } }, { versionNote: null }), null);
  assert.equal(updateNote({ update: null }, kept), null);
});

function renderWash(showHeat: boolean, modeOver: "wash" | "parts" = "wash", h: Heat = heat("page")): string {
  const pg = { ...page(0, [block("heading", 0, "heading"), block("row:0", 0)]), attentionMs: 1_660_000, heat: h };
  return renderToStaticMarkup(React.createElement(PageCanvas, {
    rendition: rendition([longTable], "normal", [tablePage]), pageId: longTable.id, part: 0, renditionPage: tablePage, page: pg as DocumentPage,
    paint: modeOver === "parts", showHeat, showUnread: false, maxMs: 1, selectedKey: null, hoveredKey: null, onSelectKey() {}, onHoverKey() {}, touch: false,
    mode: modeOver, washT: 0.8, washCard: { time: "27 min 40 s", buyers: 8, rankText: "3rd most-read of 29" },
  }));
}
test("a page known only as a total is washed, with its edge bar and rank badge — no part buttons", () => {
  const html = renderWash(true);
  const overlay = html.slice(html.indexOf("data-heat-overlay"));
  assert.ok(/data-heat-wash="true"/.test(overlay), "the wash is drawn");
  assert.ok(/role="img" aria-label="Whole page: 27 min 40 s of reading time from 8 buyers, 3rd most-read of 29 pages"/.test(overlay), "described for screen readers");
  assert.ok(/data-heat-wash-edge/.test(overlay), "edge bar");
  assert.ok(/3rd most-read of 29 · 27 min 40 s/.test(overlay), "rank badge");
  assert.ok(!/data-heat-block=/.test(html), "no part buttons");
  assert.ok(/mix-blend-mode:multiply/.test(overlay), "multiplied onto the paper");
});
test("colours off: no wash and no badge", () => {
  const html = renderWash(false);
  assert.ok(!/data-heat-wash/.test(html), "no wash");
  assert.ok(!/most-read/.test(html), "no badge");
});
test("mixed reading: the parts are painted and a badge says how much was read as a whole page", () => {
  const html = renderWash(true, "parts", heat("mixed", { pageOnlyMs: 250_000 }));
  assert.ok(!/data-heat-wash=/.test(html), "no wash");
  assert.ok(/\+ 4 min 10 s read as a whole page/.test(html), "the mixed badge");
});

console.log("words and removals");

const VIEWER_FILES = [
  "client/src/components/engagement/document/DocumentView.tsx",
  "client/src/components/engagement/document/StatusLine.tsx",
  "client/src/components/engagement/document/PageCanvas.tsx",
  "client/src/components/engagement/document/PagePanel.tsx",
  "client/src/components/engagement/document/PageRail.tsx",
  "client/src/components/engagement/document/PageTable.tsx",
  "client/src/components/engagement/document/ReachChart.tsx",
  "client/src/components/engagement/journey/JourneyDrawer.tsx",
  "client/src/components/engagement/journey/PathStrip.tsx",
  "client/src/components/engagement/FilterBar.tsx",
  "client/src/pages/broker/deal/EngagementTab.tsx",
  "client/src/pages/Analytics.tsx",
];

test("screens say 'reading time' in seconds and minutes: no dwell, engagement score, heat samples or old teal", () => {
  for (const f of VIEWER_FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    // Only user-visible strings matter; comments may explain what was removed.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\bdwell/i, f);
    assert.doesNotMatch(code, /engagement score/i, f);
    assert.doesNotMatch(code, /heat samples?|cursor samples?/i, f);
    assert.doesNotMatch(code, /hsla?\(\s*162/i, f);
    assert.doesNotMatch(code, /% of (all )?reading/i, f);
  }
});

test("the global Analytics page no longer has the cursor heat map, Drop-off or per-section average cards", () => {
  const src = fs.readFileSync(path.join(ROOT, "client/src/pages/Analytics.tsx"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /HeatMapViz|heatGrid|scrollDistribution/);
  assert.doesNotMatch(code, /value="heatmap"|value="dropoff"|Drop-off/);
  assert.doesNotMatch(code, /Per section read|Avg\. Time/);
  assert.match(code, /<CallListPanel \/>/);
  assert.match(code, /<ComparePanel \/>/);
  assert.match(code, /engagement\?view=document/);
});

console.log(`\n${passed} passed`);
