/**
 * D21: the broker's due-diligence preview always shows the whole layer —
 * checks, states and the check page — with `preview` marks on what buyers
 * don't see yet; suggested notes are flagged; hints and "no reason on file"
 * are broker-only.
 *   npx tsx tests/unit/figure-preview.test.ts
 */
import assert from "node:assert/strict";
import { fixtureRaw, noteRow, run, test } from "./helpers/figure-test";
import { figureInputsFor } from "../../server/cim/figures/serve";
import { buildFigureLayer, withDdSourceCheck } from "../../shared/figure-layer";

test("checks off: the broker still sees every check (marked not shown), the check page and key terms", async () => {
  const { fx, raw } = await fixtureRaw("pacific", { ddShownAt: null });
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "broker", mode: "dd" }), "dd")!;
  const checks = Object.values(layer.figures).flatMap((f) => f.checks ?? []);
  assert.ok(checks.length > 10);
  assert.ok(checks.filter((c) => c.preview === "not_shown").length > 5);
  assert.ok(checks.some((c) => c.preview === "cim_mismatch"), "the FY2022 cells are marked");
  assert.equal(layer.ddChecksOn, false);
  assert.ok(layer.sourceCheck && layer.sourceCheck.lines.length > 0, "the check page is in the preview");
  const withPage = withDdSourceCheck(fx.sections as any, layer);
  assert.ok(withPage.some((s: any) => s.id === "dd-source-check"));
  assert.ok(Object.values(layer.keyTerms ?? {}).flat().some((t) => t.label === "Lease expires"));
  assert.ok(Object.keys(layer.pageSources ?? {}).length > 0);
  // Readable ids for the broker.
  assert.ok(Object.keys(layer.figures).some((k) => k === "interest|2022"));
});

test("hints and 'no reason on file' are the broker's only", async () => {
  const { fx, raw } = await fixtureRaw("pacific", { ddShownAt: null });
  const broker = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "broker", mode: "normal" }), "normal")!;
  assert.ok(Object.values(broker.figures).some((f) => f.noReason));
  const buyer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "normal" }), "normal");
  assert.equal(buyer, null, "no approved notes → nothing for buyers");
});

test("a suggested note is flagged in the preview, served nowhere else", async () => {
  const note = noteRow({ figureKey: "revenue|2023", kind: "movement", compareKey: "2022", status: "suggested", text: "Suggested.", blindText: "Suggested blind.", valuesSnapshot: { year: "2023", value: 6840000, fromYear: "2022", fromValue: 6180000 } });
  const { fx, raw } = await fixtureRaw("lakeshore", { notes: [note] });
  const broker = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "broker", mode: "normal" }), "normal")!;
  const v = broker.figures["revenue|2023"];
  assert.equal(v.why?.suggested, true);
  assert.equal(v.why?.text, "Suggested.");
});

await run("figure-preview (D21)");
