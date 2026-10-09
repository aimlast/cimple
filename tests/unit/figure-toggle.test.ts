/**
 * The figure layer in the renderers (server-rendered, no browser, no DB, no AI):
 *   - without a provider every renderer draws exactly as before (no figure marks);
 *   - DD: the financial table offers "Side by side with the tax returns" in the
 *     As Reported view only; Normalized rows (nrow:i) are never anchored;
 *   - the switch records `figure_compare`, never `financial_view`;
 *   - Full CIM: a figure with a note gets a trigger; one without stays plain.
 *   npx tsx tests/unit/figure-toggle.test.ts
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
import { CimSectionRenderer } from "../../client/src/components/cim/CimSectionRenderer";
import { CimBlockScope } from "../../client/src/components/cim/blocks";
import { FigureLayerProvider } from "../../client/src/components/cim/figures/FigureLayerContext";
import { READING_INTERACTIONS } from "../../shared/analytics-v2";

(globalThis as any).window ??= { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), innerWidth: 1440, addEventListener() {}, removeEventListener() {} };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const h = React.createElement;

function render(section: any, layer: any, rowKind?: "row" | "nrow") {
  const inner = h(CimSectionRenderer, { section, branding: {} as any });
  const scoped = rowKind ? h(CimBlockScope, { pageId: section.id, rowKind }, inner) : inner;
  return renderToStaticMarkup(layer ? h(FigureLayerProvider, { layer }, scoped) : scoped);
}

test("no provider: no figure marks at all", async () => {
  const { fx } = await fixtureRaw("pacific", { locate: false });
  const s = { ...fx.sections.find((x) => x.sectionKey === "financial_performance")!, isVisible: true };
  const html = render(s, null);
  assert.ok(!html.includes("data-fig") && !html.includes("fig-trigger") && !html.includes("Side by side"));
});

test("DD, As Reported: the compare switch and the side-by-side table; Normalized: neither", async () => {
  const { fx, raw } = await fixtureRaw("lakeshore", { ddShownAt: new Date() });
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "dd" }), "dd")!;
  const s = { ...fx.sections.find((x) => x.sectionKey === "financial_performance")!, isVisible: true };
  const html = render(s, layer);
  assert.ok(html.includes("Side by side with the tax returns"));
  assert.ok(html.includes("CIM figures only"));
  assert.ok(html.includes("This CIM"));
  assert.ok(html.includes("Tax return (T2)"));
  assert.ok(html.includes("Blank: no tax return on file for that year"));
  // The reading keys stay row:i (no new block keys).
  const nrow = render({ ...s, layoutData: { ...s.layoutData, rows: s.layoutData.normalizedRows ?? s.layoutData.rows } }, layer, "nrow");
  assert.ok(!nrow.includes("Side by side"));
  assert.ok(!nrow.includes("data-fig"), "Normalized rows are never anchored");
});

test("DD: under a side-by-side table the statements and tax returns are listed once, not again as 'Sources for this page'", async () => {
  const { fx, raw } = await fixtureRaw("lakeshore", { ddShownAt: new Date() });
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "dd" }), "dd")!;
  const s = { ...fx.sections.find((x) => x.sectionKey === "financial_performance")!, isVisible: true };
  assert.ok((layer.pageSources?.[s.id]?.length ?? 0) > 0, "the page has sources");
  const html = render(s, layer);
  assert.ok(html.includes("Tax returns:"));
  assert.ok(!html.includes("Sources for this page"), "no duplicate chip row");
});

test("Full CIM: a figure with an approved note gets a trigger; others stay plain", async () => {
  const note = noteRow({ figureKey: "revenue|2023", kind: "movement", compareKey: "2022", text: "Up $660,000 (11%) from FY2022, mostly HVAC equipment.", blindText: null, valuesSnapshot: { year: "2023", value: 6840000, fromYear: "2022", fromValue: 6180000 } });
  const { fx, raw } = await fixtureRaw("lakeshore", { notes: [note] });
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "normal" }), "normal")!;
  const s = { ...fx.sections.find((x) => x.sectionKey === "financial_performance")!, isVisible: true };
  const html = render(s, layer);
  assert.equal((html.match(/data-fig=/g) ?? []).length, 1);
  assert.ok(html.includes("Notes on these figures (1)"));
  assert.ok(!html.includes("Side by side"));
});

test("print preview: the notes list starts open (expandNotes); elsewhere it starts closed", async () => {
  const note = noteRow({ figureKey: "revenue|2023", kind: "movement", compareKey: "2022", text: "Up $660,000 (11%) from FY2022, mostly HVAC equipment.", blindText: null, valuesSnapshot: { year: "2023", value: 6840000, fromYear: "2022", fromValue: 6180000 } });
  const { fx, raw } = await fixtureRaw("lakeshore", { notes: [note] });
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "normal" }), "normal")!;
  const s = { ...fx.sections.find((x) => x.sectionKey === "financial_performance")!, isVisible: true };
  const inner = h(CimSectionRenderer, { section: s, branding: {} as any });
  const printed = renderToStaticMarkup(h(FigureLayerProvider, { layer, expandNotes: true }, inner));
  assert.match(printed, /aria-expanded="true"/);
  const normal = renderToStaticMarkup(h(FigureLayerProvider, { layer }, inner));
  assert.match(normal, /aria-expanded="false"/);
  const page = readFileSync(join(ROOT, "client/src/pages/CimPrintPreview.tsx"), "utf8");
  assert.match(page, /usePreviewFigureLayer\(dealId, meta\.accessLevel, \{ audience: "buyer" \}\)/);
  assert.match(page, /<FigureLayerProvider layer=\{figures\.data\?\.layer \?\? null\} expandNotes>/);
});

test("TwoColumn: a financial table in a column anchors under left/ and its figures get triggers", async () => {
  const note = noteRow({ figureKey: "revenue|2023", kind: "movement", compareKey: "2022", text: "Up $660,000 (11%) from FY2022, mostly HVAC equipment.", blindText: null, valuesSnapshot: { year: "2023", value: 6840000, fromYear: "2022", fromValue: 6180000 } });
  const { fx, raw } = await fixtureRaw("lakeshore", { notes: [note] });
  const table = fx.sections.find((x) => x.sectionKey === "financial_performance")!;
  const two = {
    id: "two-col", dealId: table.dealId, sectionKey: "two_col_fin", sectionTitle: "Financials at a glance", order: 99, isVisible: true,
    layoutType: "two_column",
    layoutData: { left: { layoutType: "financial_table", content: table.layoutData }, right: { layoutType: "prose_highlight", content: { body: "Revenue grew in every year." } } },
  };
  const layer = buildFigureLayer([two] as any, figureInputsFor(raw, { audience: "buyer", mode: "normal" }), "normal")!;
  assert.ok(layer.anchors.length > 0 && layer.anchors.every((a) => a.block.startsWith("left/")), JSON.stringify(layer.anchors.slice(0, 3)));
  const html = render(two, layer);
  assert.equal((html.match(/data-fig=/g) ?? []).length, 1, "the one figure with a note");
});

test("the compare switch records figure_compare; As Reported/Normalized keeps financial_view", () => {
  assert.ok((READING_INTERACTIONS as readonly string[]).includes("figure_compare"));
  assert.ok((READING_INTERACTIONS as readonly string[]).includes("figure_note"));
  const table = readFileSync(join(ROOT, "client/src/components/cim/renderers/FinancialTable.tsx"), "utf8");
  assert.match(table, /interaction\("figure_compare"/);
  assert.ok(!table.includes('"financial_view"'));
  const toggle = readFileSync(join(ROOT, "client/src/components/cim/FinancialToggle.tsx"), "utf8");
  assert.match(toggle, /interaction\("financial_view"/);
});

await run("figure-toggle (renderers)");
