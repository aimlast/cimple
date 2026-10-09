/**
 * D9a on Pacific FY2022: the CIM's cost of sales ($20,384,000) and operating
 * expenses ($4,127,000) disagree with the FY2022 statements ($20,948,200 /
 * $4,282,000) and nothing explains it → a broker-only warning; no check on
 * those cells reaches buyers; the FY2023 opex movement note is held; the
 * check is never offered for showing.
 *   npx tsx tests/unit/figure-cim-mismatch.test.ts
 */
import assert from "node:assert/strict";
import { fixtureRaw, noteRow, run, test } from "./helpers/figure-test";
import { mismatchMessage } from "../../server/cim/figures/checks";
import { computedNotes } from "../../server/cim/figures/computed";
import { figureInputsFor } from "../../server/cim/figures/serve";
import { buildFigureLayer } from "../../shared/figure-layer";
import { anchorFigures } from "../../shared/figure-anchors";
import { preTicked } from "../../shared/figure-states";

test("the warning names $564,200 + $155,000 (the analysis's own +$719,200)", async () => {
  const { raw } = await fixtureRaw("pacific");
  const w = raw.checks.mismatches.find((m) => m.year === "2022")!;
  assert.ok(w);
  const cos = w.items.find((i) => i.line === "costOfSales")!;
  const opex = w.items.find((i) => i.line === "operatingExpenses")!;
  assert.equal(cos.statements - cos.cim, 564200);
  assert.equal(opex.statements - opex.cim, 155000);
  assert.equal(cos.statements - cos.cim + opex.statements - opex.cim, 719200);
  assert.equal(
    mismatchMessage(w),
    "Your CIM shows FY2022 cost of sales of $20,384,000 and operating expenses of $4,127,000. The FY2022 statements say $20,948,200 and $4,282,000. Fix FY2022 on the Financials tab, or explain the difference, before buyers see checks on these figures.",
  );
  assert.equal(raw.checks.mismatches.length, 1, "only FY2022");
});

test("no check on a held cell reaches buyers, even with the checks on and a 'shown' decision", async () => {
  const { fx, raw } = await fixtureRaw("pacific", { ddShownAt: new Date() });
  const t2 = raw.checks.checks.find((c) => c.figureKey === "costOfSales|2022" && c.kind === "tax_return")!;
  const { raw: raw2 } = await fixtureRaw("pacific", { ddShownAt: new Date(), decisions: [{ checkKey: t2.key, state: "shown", correctedValue: null, valuesSnapshot: { base: t2.base, other: t2.other } }] });
  const inputs = figureInputsFor(raw2, { audience: "buyer", mode: "dd" })!;
  const layer = buildFigureLayer(fx.sections as any, inputs, "dd")!;
  const held = Object.values(layer.figures).filter((f) => /^(costOfSales|operatingExpenses|grossProfit)\|2022$/.test(f.figureKey ?? "") || false);
  assert.equal(held.length, 0, "figureKey isn't sent to buyers");
  const anchors = anchorFigures(fx.sections.find((s) => s.sectionKey === "financial_performance") as any, raw.registry);
  const cosAnchor = anchors.find((a) => a.figureKey === "costOfSales|2022")!;
  const servedOnCell = layer.anchors.find((a) => a.pageId === cosAnchor.pageId && a.block === cosAnchor.block && a.cell === cosAnchor.cell);
  assert.equal(servedOnCell, undefined, "the FY2022 cost-of-sales cell is plain for buyers");
  // The broker's preview marks it instead.
  const brokerLayer = buildFigureLayer(fx.sections as any, figureInputsFor(raw2, { audience: "broker", mode: "dd" })!, "dd")!;
  const v = brokerLayer.figures["costOfSales|2022"];
  assert.ok(v?.cimMismatch);
  assert.ok(v!.checks!.every((c) => c.preview === "cim_mismatch"));
});

test("the FY2023 operating-expense movement note is never produced, and an approved one is never served", async () => {
  const { fx, raw } = await fixtureRaw("pacific", { ddShownAt: new Date() });
  const anchored = new Set(fx.sections.flatMap((s) => anchorFigures(s as any, raw.registry)).map((a) => a.figureKey));
  const notes = computedNotes({ registry: raw.registry, checks: raw.checks.checks, anchoredKeys: anchored });
  assert.equal(notes.find((n) => n.figureKey === "operatingExpenses|2023" && n.kind === "movement"), undefined);
  // Even a broker-approved one measured from the held FY2022 figure is not served to buyers.
  const approved = noteRow({ figureKey: "operatingExpenses|2023", kind: "movement", compareKey: "2022", origin: "broker", text: "Mostly the new warehouse lease.", valuesSnapshot: { year: "2023", value: 5505500, fromYear: "2022", fromValue: 4127000 } });
  const { raw: raw2 } = await fixtureRaw("pacific", { notes: [approved], ddShownAt: new Date() });
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw2, { audience: "buyer", mode: "normal" })!, "normal");
  assert.ok(!layer || !Object.values(layer.figures).some((f) => f.why?.text === "Mostly the new warehouse lease."));
});

test("a D9a check is never pre-ticked", async () => {
  assert.equal(preTicked("match", { cimMismatch: true }), false);
});

await run("figure-cim-mismatch (D9a)");
