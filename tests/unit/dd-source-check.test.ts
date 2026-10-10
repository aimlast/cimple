/**
 * "How the figures check out" (spec §4.7): position (after its anchor, before
 * gl's page), never in Blind / Full / teaser, reading blocks (intro, summary,
 * row:i), structure-only layoutData (a broker decision never changes the
 * rendition), and the layout is not one a broker can pick.
 *   npx tsx tests/unit/dd-source-check.test.ts
 */
import assert from "node:assert/strict";
import { fixtureRaw, run, test } from "./helpers/figure-test";
import { figureInputsFor } from "../../server/cim/figures/serve";
import { buildFigureLayer, withDdSourceCheck, DD_SOURCE_CHECK_PAGE_ID } from "../../shared/figure-layer";
import { blocksOf } from "../../shared/cim-blocks";
import { CIM_LAYOUT_KEYS, getCimLayout, isCimLayoutKey, layoutsByCategory } from "../../shared/cim-layouts";
import { renditionId } from "../../server/analytics/renditions";

async function ddSections(decisions: any[] = []) {
  const { fx, raw } = await fixtureRaw("lakeshore", { ddShownAt: new Date(), decisions });
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "dd" }), "dd")!;
  return { fx, raw, layer, sections: withDdSourceCheck(fx.sections as any[], layer) };
}

test("inserted once, right after its anchor; structure-only layoutData", async () => {
  const { sections, layer } = await ddSections();
  const pages = sections.filter((s: any) => s.id === DD_SOURCE_CHECK_PAGE_ID);
  assert.equal(pages.length, 1);
  const i = sections.findIndex((s: any) => s.id === DD_SOURCE_CHECK_PAGE_ID);
  assert.equal(sections[i - 1].sectionKey, "financial_performance");
  assert.deepEqual(Object.keys(pages[0].layoutData).sort(), ["lines", "v", "years"]);
  assert.deepEqual(pages[0].layoutData.lines, layer.sourceCheck!.lines);
  assert.ok(pages[0].order > sections[i - 1].order && pages[0].order < sections[i + 1].order);
  // Idempotent.
  assert.equal(withDdSourceCheck(sections as any, layer).filter((s: any) => s.id === DD_SOURCE_CHECK_PAGE_ID).length, 1);
  // gl's page anchored on the same section stays after it (anchor → dd_source_check → gl_evidence).
  const withGl = [...sections.slice(0, i), { id: "glsec_x", layoutType: "gl_evidence", layoutData: {}, order: sections[i - 1].order + 0.6 }, ...sections.slice(i)];
  const fresh = withDdSourceCheck((await fixtureRaw("lakeshore")).fx.sections.flatMap((s: any) => (s.sectionKey === "financial_performance" ? [s, { id: "glsec_x", layoutType: "gl_evidence", layoutData: {}, order: s.order + 0.6 }] : [s])) as any, layer);
  const at = fresh.findIndex((s: any) => s.id === DD_SOURCE_CHECK_PAGE_ID);
  assert.equal(fresh[at + 1].id, "glsec_x");
  void withGl;
});

test("reading blocks: intro, summary, row:i", () => {
  const blocks = blocksOf({ id: DD_SOURCE_CHECK_PAGE_ID, layoutType: "dd_source_check", sectionTitle: "How the figures check out", layoutData: { v: 1, lines: ["revenue", "interest"], years: ["2023", "2024"] } } as any);
  assert.deepEqual(blocks.map((b) => b.key), ["heading", "intro", "summary", "row:0", "row:1"]);
});

test("a broker decision never changes the rendition hash", async () => {
  const a = await ddSections();
  const k = a.raw.checks.checks.find((c) => c.figureKey === "interest|2022" && c.kind === "tax_return")!;
  const b = await ddSections([{ checkKey: k.key, state: "left_out", correctedValue: null, valuesSnapshot: { base: k.base, other: k.other } }]);
  const id = (sections: any[]) => renditionId({ mode: "dd", variant: "full", design: null, sections });
  assert.equal(id(a.sections), id(b.sections));
});

test("never in Blind / Full; never offered to brokers as a layout", async () => {
  const { fx, raw } = await fixtureRaw("lakeshore", { ddShownAt: new Date() });
  for (const mode of ["blind", "normal"] as const) {
    const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "broker", mode }), mode);
    assert.ok(!layer?.sourceCheck);
    assert.equal(withDdSourceCheck(fx.sections as any, layer).length, fx.sections.length);
  }
  assert.equal(getCimLayout("dd_source_check")?.blind, "exclude");
  assert.equal(isCimLayoutKey("dd_source_check"), false);
  assert.ok(!CIM_LAYOUT_KEYS.includes("dd_source_check" as any));
  assert.ok(!layoutsByCategory().some((g) => g.layouts.some((l) => l.key === "dd_source_check")));
});

await run("dd-source-check");
