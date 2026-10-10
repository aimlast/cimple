/**
 * Figures in charts (spec §4.4) and the gl contract (spec §11.2, INTEGRATION
 * §2.7 rule 6). No DB, no AI; server-rendered where it matters.
 *   npx tsx tests/unit/figure-charts-gl.test.ts
 *
 *   - the earnings bridge (waterfall): on a phone each amount is a figure
 *     trigger; bar/line/waterfall tooltips gain the note's first sentence and
 *     "Click for more"; a click opens the popover (all three charts wired);
 *   - gl: a bridge row is a ledger add-back line only when its label AND
 *     amount agree (never by amount alone); marks in Full and DD, never in
 *     Blind; the line ids come from gl's glLineIdsForDeal; the GL mark slot
 *     renders gl's GlMark, shown only for a line whose mark is on in what the
 *     reader is served (GlMarksProvider).
 */
import "./react-global";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureRaw, noteRow, run, test } from "./helpers/figure-test";
import { figureInputsFor } from "../../server/cim/figures/serve";
import { buildFigureLayer } from "../../shared/figure-layer";
import { glBridgeMarks } from "../../shared/figure-anchors";
import { _setGlLineIdsForTests, glLineIdsFor, glLinesFrom, withGlLines } from "../../server/cim/figures/gl-contract";
import { firstSentence, tooltipLineFor } from "../../client/src/components/cim/figures/ChartFigures";
import { CimSectionRenderer } from "../../client/src/components/cim/CimSectionRenderer";
import { FigureLayerProvider } from "../../client/src/components/cim/figures/FigureLayerContext";
import { GlMarkSlot } from "../../client/src/components/cim/figures/GlMarkSlot";

(globalThis as any).window ??= { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), innerWidth: 390, addEventListener() {}, removeEventListener() {} };
(globalThis as any).window.innerWidth = 390;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const h = React.createElement;

async function beacon() {
  const r = await fixtureRaw("beacon", { locate: false });
  const bridge = r.fx.sections.find((s) => s.layoutType === "waterfall_chart")!;
  return { ...r, bridge };
}
const AUTO = { lineId: "glA", label: "Personal portion of automobile", amounts: { "2024": 12300 } };

test("gl marks: label AND amount must agree; never by amount alone", async () => {
  const { bridge } = await beacon();
  const items = (bridge.layoutData as any).items as Array<{ label: string }>;
  const autoAt = items.findIndex((i) => /automobile/i.test(i.label));
  const marks = glBridgeMarks(bridge as any, [AUTO, { lineId: "glB", label: "Charitable donations", amounts: { "2024": 9999 } }]);
  assert.deepEqual(marks, [{ pageId: bridge.id, block: `chart/point:${autoAt}`, lineId: "glA" }]);
  // The same amount under another label: no mark.
  assert.deepEqual(glBridgeMarks(bridge as any, [{ lineId: "glC", label: "Rent adjustment", amounts: { "2024": 12300 } }]), []);
  // The start and total rows are never add-back lines.
  assert.deepEqual(glBridgeMarks(bridge as any, [{ lineId: "glN", label: "Net income", amounts: { "2024": 496728 } }]), []);
  // Inside a two-column page: the column prefix.
  const two = { id: "two", layoutType: "two_column", layoutData: { left: { layoutType: "waterfall_chart", content: bridge.layoutData }, right: { layoutType: "prose_highlight", content: { body: "x" } } } };
  const inTwo = glBridgeMarks(two as any, [AUTO]);
  assert.equal(inTwo.length, 1);
  assert.equal(inTwo[0].block, `left/chart/point:${autoAt}`);
});

test("gl marks in the layer: Full and DD, never Blind", async () => {
  const { fx, raw } = await beacon();
  for (const [mode, expected] of [["normal", 1], ["dd", 1], ["blind", 0]] as const) {
    const inputs = { ...figureInputsFor(raw, { audience: "buyer", mode })!, glLines: [AUTO] };
    const layer = buildFigureLayer(fx.sections as any, inputs, mode);
    assert.equal(layer?.glMarks?.length ?? 0, expected, mode);
  }
  const noGl = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "normal" }), "normal");
  assert.equal(noGl?.glMarks, undefined, "no gl lines → no marks (today)");
});

test("gl line ids: gl's glLineIdsForDeal (wired at the dd merge); mapped through gl's add-back ids", async () => {
  const { memoryStore, _setGlStoreForTests } = await import("../../server/gl/store");
  const store = memoryStore();
  _setGlStoreForTests(store);
  try {
    assert.equal((await glLineIdsFor("d-none")).size, 0, "no traces → no lines");
    await store.upsertTrace({ dealId: "d", addbackKey: "vehicle", analysisAddbackId: "ab-1" } as any);
    await store.upsertTrace({ dealId: "d", addbackKey: "gone", analysisAddbackId: "ab-2", removedAt: new Date() } as any);
    const ids = await glLineIdsFor("d");
    assert.ok(ids.get("ab-1"), "the analysis add-back id maps to its ledger line");
    assert.equal(ids.get("ab-1"), ids.get("vehicle"), "the same line under gl's own key");
    assert.equal(ids.has("ab-2"), false, "a removed trace has no line");
  } finally {
    _setGlStoreForTests(null);
  }
  const bridge = [{ label: "Personal portion of automobile", amounts: { "2024": 12300 }, addbackId: "ab-1" }, { label: "Donations", amounts: { "2024": 6000 }, addbackId: null }];
  assert.deepEqual(glLinesFrom(bridge, new Map()), []);
  assert.deepEqual(glLinesFrom(bridge, new Map([["ab-1", "glA"]])), [{ lineId: "glA", label: "Personal portion of automobile", amounts: { "2024": 12300 } }]);
  const inputs = { registry: {} } as any;
  _setGlLineIdsForTests(async () => new Map());
  assert.equal(await withGlLines(inputs, "d", bridge), inputs, "no ledger line → unchanged");
  _setGlLineIdsForTests(async () => new Map([["ab-1", "glA"]]));
  assert.deepEqual((await withGlLines(inputs, "d", bridge))!.glLines, [{ lineId: "glA", label: "Personal portion of automobile", amounts: { "2024": 12300 } }]);
  _setGlLineIdsForTests(null);
  const contract = readFileSync(join(ROOT, "server/cim/figures/gl-contract.ts"), "utf8");
  assert.match(contract, /glLineIdsForDeal\(dealId\)/);
});

test("the GL mark slot renders gl's GlMark — only for a line whose mark is on in what the reader is served", async () => {
  const { GlMarksProvider, glMarkedLineIds } = await import("../../client/src/components/cim/gl/GlLinks");
  assert.equal(renderToStaticMarkup(h(GlMarkSlot, { lineId: "glA" })), "", "no marks provider (print, heat map) → nothing");
  const on = renderToStaticMarkup(h(GlMarksProvider, { marks: new Set(["glA"]) }, h(GlMarkSlot, { lineId: "glA" })));
  assert.match(on, /Found in the books/);
  assert.match(on, /data-testid="gl-row-mark-glA"/);
  assert.equal(renderToStaticMarkup(h(GlMarksProvider, { marks: new Set(["glA"]) }, h(GlMarkSlot, { lineId: "glB" }))), "", "a line whose mark is off → nothing");
  const marks = glMarkedLineIds([
    { layoutType: "gl_evidence", layoutData: { pageId: "glsec_1", lines: [{ lineId: "glA", mark: true }, { lineId: "glB", mark: false }] } },
    { layoutType: "waterfall_chart", layoutData: { _glNote: { text: "Found in the books.", lineIds: ["glC"] } } },
    { layoutType: "financial_table", layoutData: {} },
  ]);
  assert.deepEqual([...marks].sort(), ["glA", "glC"]);
});

test("the earnings bridge on a phone: each anchored amount is a figure trigger", async () => {
  const { fx, raw, bridge } = await beacon();
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "broker", mode: "normal" }), "normal")!;
  const anchored = layer.anchors.filter((a) => a.pageId === bridge.id);
  assert.ok(anchored.length >= 2, "net income, amortization, interest, taxes anchor");
  const html = renderToStaticMarkup(h(FigureLayerProvider, { layer }, h(CimSectionRenderer, { section: { ...bridge, isVisible: true } as any, branding: {} as any })));
  assert.equal((html.match(/data-fig=/g) ?? []).length, anchored.length);
  // Without a provider: exactly as before.
  const plain = renderToStaticMarkup(h(CimSectionRenderer, { section: { ...bridge, isVisible: true } as any, branding: {} as any }));
  assert.ok(!plain.includes("data-fig"));
});

test("tooltip line: the note's first sentence; DD state words; nothing without a note", async () => {
  assert.equal(firstSentence("Up $660,000 (11%) from FY2022. Mostly HVAC."), "Up $660,000 (11%) from FY2022.");
  const note = noteRow({ figureKey: "revenue|2023", kind: "movement", compareKey: "2022", text: "Up $660,000 (11%) from FY2022, mostly HVAC equipment. Active members grew.", blindText: null, valuesSnapshot: { year: "2023", value: 6840000, fromYear: "2022", fromValue: 6180000 } });
  const { fx, raw } = await fixtureRaw("lakeshore", { notes: [note], ddShownAt: new Date() });
  const normal = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "normal" }), "normal")!;
  const rev = Object.values(normal.figures).find((f) => f.label === "Revenue" && f.year === "2023")!;
  assert.equal(tooltipLineFor(rev, "normal"), "Up $660,000 (11%) from FY2022, mostly HVAC equipment.");
  const dd = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "dd" }), "dd")!;
  const interest = Object.values(dd.figures).find((f) => f.label === "Interest" && f.year === "2022")!;
  assert.match(tooltipLineFor(interest, "dd") ?? "", /grouped differently/i);
  assert.equal(tooltipLineFor({ id: "x", year: "2023", display: "$1" }, "normal"), null);
});

test("bar, line and waterfall charts: tooltip line and click → popover", () => {
  for (const f of ["BarChart", "LineChart", "WaterfallChart"]) {
    const src = readFileSync(join(ROOT, `client/src/components/cim/renderers/${f}.tsx`), "utf8");
    assert.match(src, /<FigureTooltipLine/, f);
    assert.match(src, /onClick=\{\(s\) => onChartClick\(s\)\}/, f);
    assert.match(src, /<ChartFigurePopover/, f);
  }
  const charts = readFileSync(join(ROOT, "client/src/components/cim/figures/ChartFigures.tsx"), "utf8");
  assert.match(charts, /interaction\("figure_note"/, "opening a chart note records figure_note");
  assert.match(charts, /Tap for more/);
  assert.match(charts, /Click for more/);
});

await run("figure-charts-gl");
