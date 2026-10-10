/**
 * D9a on Pacific FY2022: the CIM's cost of sales ($20,384,000) and operating
 * expenses ($4,127,000) disagree with the FY2022 statements ($20,948,200 /
 * $4,282,000) and nothing explains it → a broker-only warning; no check on
 * those cells reaches buyers; the FY2023 opex movement note is held; the
 * check is never offered for showing.
 *   npx tsx tests/unit/figure-cim-mismatch.test.ts
 */
import assert from "node:assert/strict";
import { fixture, fixtureRaw, noteRow, run, test } from "./helpers/figure-test";
import { mismatchMessage } from "../../server/cim/figures/checks";
import { computedNotes } from "../../server/cim/figures/computed";
import { figureInputsFor } from "../../server/cim/figures/serve";
import { buildFigureLayer, cimMismatchHeld, heldAsDerived } from "../../shared/figure-layer";
import { buildWorkspace } from "../../server/cim/figures/workspace";
import { movementTargets } from "../../server/cim/figures/candidates";
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

// ── F7 (checker r1): the hold reaches the derived totals worked out from the held lines ──

test("EBITDA FY2022 is held with the lines it is worked out from; net income (the statements agree) is not", async () => {
  const { raw } = await fixtureRaw("pacific");
  const held = cimMismatchHeld(raw.checks.checks, raw.registry);
  for (const k of ["costOfSales|2022", "operatingExpenses|2022", "grossProfit|2022", "incomeBeforeTax|2022", "ebitda|2022"]) assert.ok(held.has(k), k);
  // $4,129,000 is built from the cost of sales and opex the statements disagree with.
  assert.equal(raw.registry["ebitda|2022"].value, 4129000);
  assert.equal(raw.registry["ebitda|2022"].value - 719200, 3409800);
  assert.ok(!held.has("netIncome|2022"), "the FY2022 statements print the same net income ($1,115,900)");
  assert.ok(!held.has("ebitda|2023") && !held.has("revenue|2022"));
  assert.ok(!held.has("ebitda@statements|2022"));
  assert.ok(!heldAsDerived("costOfSales|2022", raw.checks.checks) && heldAsDerived("ebitda|2022", raw.checks.checks));
});

test("a movement note measured from FY2022 EBITDA never reaches buyers, and the broker isn't offered one", async () => {
  const { fx, raw } = await fixtureRaw("pacific");
  const ebitdaNote = noteRow({ figureKey: "ebitda|2023", kind: "movement", compareKey: "2022", origin: "broker", status: "approved", text: "Down on the new warehouse lease.", blindText: "Down on a new lease.",
    valuesSnapshot: { year: "2023", value: 3061600, fromYear: "2022", fromValue: 4129000 } });
  const { raw: raw2 } = await fixtureRaw("pacific", { notes: [ebitdaNote], ddShownAt: new Date() });
  for (const mode of ["normal", "blind", "dd"] as const) {
    const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw2, { audience: "buyer", mode })!, mode);
    const texts = JSON.stringify(layer ?? {});
    assert.ok(!/warehouse lease|new lease|1,067,400/.test(texts), `${mode}: ${texts.slice(0, 200)}`);
  }
  // Broker preview: FY2022 EBITDA is marked held (derived); FY2023 offers no "no reason / use the hint" for the change from FY2022.
  const broker = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "broker", mode: "normal" })!, "normal")!;
  const e22 = broker.figures["ebitda|2022"];
  if (e22) {
    assert.ok(e22.cimMismatch && e22.cimMismatchDerived);
    assert.ok(!e22.noReason && !e22.hint);
  }
  const e23 = broker.figures["ebitda|2023"];
  if (e23) assert.ok(!(e23.noReason && e23.noReasonFor?.kind === "change" && e23.noReasonFor.fromYear === "2022"), JSON.stringify(e23));
  // The workspace: the EBITDA FY2022 → FY2023 row is held, no hint, nothing to ask.
  const w = buildWorkspace({ raw, sections: fx.sections, build: null, autoAsk: false, autoAskChosen: false, stale: false, ddBuyers: 0, dailyLimit: false, oldDdWording: false });
  const row = w.moves.find((m) => m.figureKey === "ebitda|2023");
  assert.ok(row, w.moves.map((m) => m.figureKey).join(", "));
  assert.equal(row!.status, "held");
  assert.equal(row!.heldYear, "2022");
  assert.equal(row!.hint, null);
  assert.equal(row!.askable, false);
  // Planning never asks about it either.
  const targets = movementTargets(raw.registry, Object.keys(raw.registry), raw.checks.checks, { undecomposedTotals: true });
  assert.ok(!targets.some((t) => t.figureKey === "ebitda|2023" || t.figureKey === "ebitda|2022"));
});

test("a check on a derived held figure is never offered for showing", async () => {
  const { raw } = await fixtureRaw("pacific", { ddShownAt: new Date() });
  const t2 = raw.checks.checks.find((c) => c.figureKey === "ebitda|2022" && c.kind !== "cim_statements" && !c.blank);
  if (t2) {
    const w = buildWorkspace({ raw, sections: fixture("pacific").sections, build: null, autoAsk: false, autoAskChosen: false, stale: false, ddBuyers: 1, dailyLimit: false, oldDdWording: false });
    const row = w.checks.find((c) => c.checkKey === t2.key);
    if (row) { assert.ok(row.refusal); assert.equal(row.preTicked, false); assert.equal(row.shownToBuyers, false); }
  }
});

test("a D9a check is never pre-ticked", async () => {
  assert.equal(preTicked("match", { cimMismatch: true }), false);
});

await run("figure-cim-mismatch (D9a)");
