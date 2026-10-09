/**
 * Due diligence opens on the differences (checker r1 F4) and writes the tax
 * return's figure the way the CIM cell beside it is written (F5).
 * Server-rendered, no browser, no DB, no AI.
 *   npx tsx tests/unit/figure-dd-expanded.test.ts
 */
import "./react-global";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureRaw, run, test } from "./helpers/figure-test";
import { figureInputsFor } from "../../server/cim/figures/serve";
import { buildFigureLayer } from "../../shared/figure-layer";
import { ExpandableSection } from "../../client/src/components/cim/ExpandableSection";
import { FigureLayerProvider } from "../../client/src/components/cim/figures/FigureLayerContext";
import { formatLike } from "../../client/src/components/cim/figures/figurePaint";
import { latestYearWithDifference } from "../../client/src/components/cim/figures/DdCompareTable";

(globalThis as any).window ??= { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), innerWidth: 1440, addEventListener() {}, removeEventListener() {} };
const h = React.createElement;

async function pacificTable(opts: { ddShownAt: Date | null; mode: "dd" | "normal"; audience?: "buyer" | "broker" }) {
  const { fx, raw } = await fixtureRaw("pacific", { ddShownAt: opts.ddShownAt });
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: opts.audience ?? "buyer", mode: opts.mode }), opts.mode);
  // The income statement as the AI marks a long table: expandable (collapsed to 3 rows + "more rows").
  const s = fx.sections.find((x) => x.sectionKey === "financial_performance")!;
  const section = { ...s, isVisible: true, layoutData: { ...s.layoutData, expandable: true } } as any;
  const html = renderToStaticMarkup(h(FigureLayerProvider, { layer }, h(ExpandableSection, { section, branding: {} as any })));
  return html;
}

test("DD with the checks on: the side-by-side table opens expanded — no 'more rows' preview hiding the differences", async () => {
  const html = await pacificTable({ ddShownAt: new Date(), mode: "dd" });
  assert.ok(html.includes("Side by side with the tax returns"), "the compare table is rendered open");
  assert.ok(!/\+\d+ more rows?/.test(html), "no collapsed preview");
  assert.ok(html.includes("Show less"));
  // The interest difference (+$33,000, grouped differently) is on the first screen.
  assert.ok(html.includes("+$33,000"));
});

test("DD with the checks off (buyers): collapsed as before; the broker's preview opens", async () => {
  const off = await pacificTable({ ddShownAt: null, mode: "dd" });
  assert.match(off, /\+\d+ more rows?/);
  const broker = await pacificTable({ ddShownAt: null, mode: "dd", audience: "broker" });
  assert.ok(!/\+\d+ more rows?/.test(broker));
});

test("the Full CIM keeps its collapsed preview", async () => {
  const html = await pacificTable({ ddShownAt: new Date(), mode: "normal" });
  assert.match(html, /\+\d+ more rows?/);
});

test("the tax return's figure reads like the CIM cell beside it (F5)", async () => {
  assert.equal(formatLike("($268,000)", "$301,000"), "($301,000)");
  assert.equal(formatLike("$28,640,000", "$28,640,000"), "$28,640,000");
  assert.equal(formatLike("28,640,000", "$28,640,000"), "28,640,000");
  assert.equal(formatLike("$28.6M", "$28,640,000"), "$28.6M");
  assert.equal(formatLike("$1.25M", "$1,312,000"), "$1.31M");
  assert.equal(formatLike("-$12,000", "$15,000"), "−$15,000");
  assert.equal(formatLike(null, "$301,000"), "$301,000");
  // Pacific's table prints "$268,000" for FY2022 interest: the tax return's $301,000 keeps its "$" (it lost it before).
  const html = await pacificTable({ ddShownAt: new Date(), mode: "dd" });
  assert.ok(html.includes("$301,000"), "interest FY2022 with the CIM's $ sign");
  assert.ok(!/>301,000</.test(html) && !/>28,640,000</.test(html));
  // A table that prints expenses in parentheses gets the tax return's figure in parentheses too.
  const { fx, raw } = await fixtureRaw("pacific", { ddShownAt: new Date() });
  const s = fx.sections.find((x) => x.sectionKey === "financial_performance")!;
  const paren = { ...s, isVisible: true, layoutData: { ...s.layoutData, expandable: true, rows: s.layoutData.rows.map((r: any) => /^interest$/i.test(r.label) ? { ...r, values: r.values.map((v: string) => `(${v})`) } : r) } } as any;
  const layer = buildFigureLayer([paren], figureInputsFor(raw, { audience: "buyer", mode: "dd" }), "dd");
  const html2 = renderToStaticMarkup(h(FigureLayerProvider, { layer }, h(ExpandableSection, { section: paren, branding: {} as any })));
  assert.ok(html2.includes("($268,000)") && html2.includes("($301,000)"), "both in parentheses");
});

test("on a phone the compare table opens on the latest year with a difference (Pacific: FY2023 interest), not a year with none", () => {
  const fig = (state: string) => ({ id: "f", year: "y", display: "$1", checks: [{ id: "c", kindLabel: "Tax return (T2)", value: "$1", difference: null, differencePct: null, state, size: "match", note: null, citation: null }] }) as any;
  // FY2022 and FY2023 interest differ (grouped differently); FY2024 has no tax-return figure.
  const rows = [[fig("match"), fig("match"), fig("match")], [fig("regrouped"), fig("regrouped"), null]];
  assert.equal(latestYearWithDifference(rows, 3), 1);
  assert.equal(latestYearWithDifference([[fig("match"), fig("match")]], 2), 1, "no difference: the latest year");
});

await run("figure-dd-expanded (DD opens on the differences; one money format)");
