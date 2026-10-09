/**
 * "Cimple read it wrong" (checker r1 F6): a correction is not a decision to
 * show. A corrected figure that still differs reaches due-diligence buyers
 * only after the broker's own "Show to buyers", and only when the document's
 * text has it (the broker's typed number is never presented as the tax
 * return's unless the tax return says so). "Show" keeps the correction.
 *   npx tsx tests/unit/figure-corrected.test.ts
 */
import assert from "node:assert/strict";
import { fixtureRaw, run, test } from "./helpers/figure-test";
import { figureIdFor, figureInputsFor } from "../../server/cim/figures/serve";
import { buildWorkspace } from "../../server/cim/figures/workspace";
import { buildFigureLayer } from "../../shared/figure-layer";
import { reviewItems } from "../../shared/figure-workspace";

async function revenue2023(decision: { state: "shown" | "corrected"; correctedValue: number } | null) {
  const { raw: plain } = await fixtureRaw("pacific", { ddShownAt: new Date() });
  const t2 = plain.checks.checks.find((c) => c.figureKey === "revenue|2023" && c.kind === "tax_return")!;
  assert.ok(t2 && t2.size === "match", "the fixture's T2 revenue 2023 matches ($29,180,000)");
  const decisions = decision ? [{ checkKey: t2.key, state: decision.state, correctedValue: decision.correctedValue, valuesSnapshot: { base: t2.base, other: decision.correctedValue } }] : [];
  const { fx, raw } = await fixtureRaw("pacific", { ddShownAt: new Date(), decisions });
  const check = raw.checks.checks.find((c) => c.key === t2.key)!;
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "dd" })!, "dd");
  const fig = layer?.figures[figureIdFor(fx.deal.id, "revenue|2023")];
  const served = (fig?.checks ?? []).find((c) => c.kindLabel.startsWith("Tax return"));
  if (served) assert.equal(served.value, `$${(decision?.correctedValue ?? 29180000).toLocaleString("en-US")}`);
  const ws = buildWorkspace({ raw, sections: fx.sections, build: null, autoAsk: false, autoAskChosen: false, stale: false, ddBuyers: 1, dailyLimit: false, oldDdWording: false });
  const row = ws.checks.find((c) => c.checkKey === t2.key)!;
  return { check, served, row, ws };
}

test("a correction that isn't in the tax return's text is never found there, never served, and can't be shown", async () => {
  const { check, served, row, ws } = await revenue2023({ state: "corrected", correctedValue: 29280000 });
  assert.equal(check.other, 29280000);
  assert.equal(check.corrected, true);
  assert.equal(check.located, false, "the broker's figure is not 'found in the document' by itself");
  assert.equal(served, undefined);
  assert.equal(row.group, "needs_checking");
  assert.equal(row.corrected, true);
  assert.ok(row.refusal);
  assert.equal(row.shownToBuyers, false);
  assert.match(row.notLocatedMessage ?? "", /couldn't find \$29,280,000 in the tax return's text/);
  assert.ok(!reviewItems(ws).differences.some((d) => d.checkKey === row.checkKey));
});

test("a correction found in the document that still differs waits for the broker's own Show", async () => {
  // 20,612,900 is printed in the FY2023 tax return (its cost of sales): located, and it differs.
  const { check, served, row, ws } = await revenue2023({ state: "corrected", correctedValue: 20612900 });
  assert.equal(check.located, true);
  assert.equal(check.decision, "corrected");
  assert.equal(served, undefined, "not shown by the correction alone");
  assert.equal(row.shownToBuyers, false);
  assert.equal(row.state, "ask");
  const look = reviewItems(ws).needsLook.find((n) => n.checkKey === row.checkKey);
  assert.ok(look && look.canShow, "offered unticked: ask the seller first");
});

test("Show keeps the correction (the same row), and only then do buyers see it", async () => {
  const { check, served } = await revenue2023({ state: "shown", correctedValue: 20612900 });
  assert.equal(check.other, 20612900);
  assert.equal(check.decision, "shown");
  assert.ok(served, "shown with the corrected figure");
});

test("no correction: the match shows with the checks, as before", async () => {
  const { served, row } = await revenue2023(null);
  assert.ok(served);
  assert.equal(row.corrected, false);
});

await run("figure-corrected (Cimple read it wrong)");
