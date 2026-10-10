/**
 * "Cimple read it wrong" (checker r1 F6, r2 R2-1): a correction is not a
 * decision to show. A corrected figure reaches due-diligence buyers only after
 * the broker's own "Show to buyers" — even when it now matches — and only when
 * the document prints it on its own line for that figure (the broker's typed
 * number is never "found in the tax return" because the same number happens
 * to be printed on "Inventories"). "Show" keeps the correction.
 *   npx tsx tests/unit/figure-corrected.test.ts
 */
import assert from "node:assert/strict";
import { fixtureRaw, run, test, type RawOpts } from "./helpers/figure-test";
import { figureIdFor, figureInputsFor } from "../../server/cim/figures/serve";
import { buildWorkspace } from "../../server/cim/figures/workspace";
import { refreshPlan } from "../../server/cim/figures/refresh";
import { buildFigureLayer } from "../../shared/figure-layer";
import { labelMeansLine } from "../../shared/figure-lines";
import { reviewItems } from "../../shared/figure-workspace";

type Decision = { state: "shown" | "corrected"; correctedValue: number } | null;

async function checkOf(deal: "pacific" | "lakeshore", figureKey: string, decision: Decision, opts: Pick<RawOpts, "patchText"> = {}) {
  const { raw: plain } = await fixtureRaw(deal, { ddShownAt: new Date(), ...opts });
  const t2 = plain.checks.checks.find((c) => c.figureKey === figureKey && c.kind === "tax_return")!;
  assert.ok(t2, `${deal} ${figureKey} has a tax-return check`);
  const decisions = decision ? [{ checkKey: t2.key, state: decision.state, correctedValue: decision.correctedValue, valuesSnapshot: { base: t2.base, other: decision.correctedValue } }] : [];
  const { fx, raw } = await fixtureRaw(deal, { ddShownAt: new Date(), decisions, ...opts });
  const check = raw.checks.checks.find((c) => c.key === t2.key)!;
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "dd" })!, "dd");
  const fig = layer?.figures[figureIdFor(fx.deal.id, figureKey)];
  const served = (fig?.checks ?? []).find((c) => c.kindLabel.startsWith("Tax return"));
  const ws = buildWorkspace({ raw, sections: fx.sections, build: null, autoAsk: false, autoAskChosen: false, stale: false, ddBuyers: 1, dailyLimit: false, oldDdWording: false });
  const row = ws.checks.find((c) => c.checkKey === t2.key)!;
  return { plain: t2, check, served, row, ws, raw, fx };
}

/** Pacific's FY2023 T2 with its trade-sales line printed as $29,280,000 (as if the extraction misread it). */
const tradeSales29280 = (d: { name: string }, t: string) => (/T2 .*2023/.test(d.name) ? t.replace("Trade sales of goods and services29,180,000", "Trade sales of goods and services29,280,000") : t);
/** Pacific's FY2022 T2 with its interest line printed as $268,000 (the statements' figure). */
const interest268 = (d: { name: string }, t: string) => (/T2 .*2022/.test(d.name) ? t.replace("Interest and bank charges301,000", "Interest and bank charges268,000") : t);

test("the document's own line labels: interest is never 'Inventories'; cost of sales is never revenue", () => {
  assert.equal(labelMeansLine("Interest and bank charges", "interest"), true);
  assert.equal(labelMeansLine("Inventories", "interest"), false);
  assert.equal(labelMeansLine("Professional fees", "interest"), false);
  assert.equal(labelMeansLine("Office expenses", "interest"), false);
  assert.equal(labelMeansLine("Interest income", "interest"), false);
  assert.equal(labelMeansLine("Cost of sales (direct operating costs)", "revenue"), false);
  assert.equal(labelMeansLine("Cost of sales (direct operating costs)", "costOfSales"), true);
  assert.equal(labelMeansLine("Trade sales of goods and services", "revenue"), true);
  assert.equal(labelMeansLine("Net income/loss before taxes and extraordinary items", "netIncome"), false);
  assert.equal(labelMeansLine("Net income/loss before taxes and extraordinary items", "incomeBeforeTax"), true);
  assert.equal(labelMeansLine("Net income/loss after taxes and extraordinary items", "netIncome"), true);
  assert.equal(labelMeansLine("Net income/loss after taxes and extraordinary items", "incomeTaxes"), false);
  assert.equal(labelMeansLine("Current income taxes", "incomeTaxes"), true);
  assert.equal(labelMeansLine(null, "interest"), false);
});

test("checker r2: Pacific interest FY2022 corrected to the statements' $268,000 — printed on the T2 only as 'Inventories' — needs checking, never a served match", async () => {
  const { plain, check, served, row, ws } = await checkOf("pacific", "interest|2022", { state: "corrected", correctedValue: 268000 });
  assert.equal(plain.other, 301000, "the T2 reads $301,000 (interest and bank charges)");
  assert.equal(check.other, 268000);
  assert.equal(check.corrected, true);
  assert.equal(check.size, "match", "the typed figure equals the statements'");
  assert.equal(check.located, false, "268,000 is on the T2's Inventories line, not its interest line");
  assert.equal(served, undefined, "never served to due-diligence buyers");
  assert.equal(row.group, "needs_checking", "a real difference never moves into Matches by a correction");
  assert.equal(row.shownToBuyers, false);
  assert.ok(row.refusal);
  assert.match(row.notLocatedMessage ?? "", /couldn't find your figure, \$268,000, on the tax return's interest line/);
  assert.ok(ws.fixFirst.some((f) => f.checkKey === row.checkKey && /interest line/.test(f.message)));
  assert.ok(ws.kpis.differences >= 1, "still counted as a difference");
  assert.ok(!reviewItems(ws).differences.some((d) => d.checkKey === row.checkKey));
  assert.equal(reviewItems(ws).needsLook.find((n) => n.checkKey === row.checkKey)?.canShow, false);
});

test("checker r2: Lakeshore interest FY2022 ($29,000 on 'Professional fees') and FY2024 ($38,000 on 'Office expenses') need checking too", async () => {
  for (const key of ["interest|2022", "interest|2024"]) {
    const { plain, check, served, row } = await checkOf("lakeshore", key, null);
    const { check: c2, served: s2, row: r2 } = await checkOf("lakeshore", key, { state: "corrected", correctedValue: plain.base });
    assert.equal(c2.located, false, `${key}: found only on another line`);
    assert.equal(s2, undefined, key);
    assert.equal(r2.group, "needs_checking", key);
    void check; void served; void row;
  }
});

test("a correction printed on its own line that still differs waits for the broker's own Show", async () => {
  const { check, served, row, ws } = await checkOf("pacific", "revenue|2023", { state: "corrected", correctedValue: 29280000 }, { patchText: tradeSales29280 });
  assert.equal(check.located, true, "found on the T2's trade-sales line");
  assert.equal(check.sourceLabel, "Trade sales of goods and services");
  assert.equal(check.decision, "corrected");
  assert.equal(served, undefined, "not shown by the correction alone");
  assert.equal(row.shownToBuyers, false);
  assert.equal(row.state, "ask");
  const look = reviewItems(ws).needsLook.find((n) => n.checkKey === row.checkKey);
  assert.ok(look && look.canShow, "offered unticked: ask the seller first");
});

test("a correction found on a different line is not found — whatever line printed the number (the cost of sales is not revenue)", async () => {
  // 20,612,900 is printed in the FY2023 tax return as its cost of sales.
  const { check, served, row } = await checkOf("pacific", "revenue|2023", { state: "corrected", correctedValue: 20612900 });
  assert.equal(check.located, false);
  assert.equal(served, undefined);
  assert.equal(row.group, "needs_checking");
});

test("a correction that now matches, on its own line, is listed with the differences and never shown until the broker shows it", async () => {
  const { check, served, row, ws } = await checkOf("pacific", "interest|2022", { state: "corrected", correctedValue: 268000 }, { patchText: interest268 });
  assert.equal(check.located, true);
  assert.equal(check.size, "match");
  assert.equal(served, undefined, "never auto-shown (checks on, matches)");
  assert.equal(row.group, "difference");
  assert.equal(row.preTicked, false);
  assert.equal(row.refusal, null);
  const offered = reviewItems(ws).differences.find((d) => d.checkKey === row.checkKey);
  assert.ok(offered && !offered.ticked && /matches · your figure/.test(offered.label), offered?.label);
  // The broker shows it: now served, as a match, with the T2 line it was found on.
  const { served: after, row: shownRow } = await checkOf("pacific", "interest|2022", { state: "shown", correctedValue: 268000 }, { patchText: interest268 });
  assert.ok(after, "served once shown");
  assert.equal(after!.state, "match");
  assert.equal(after!.sourceLabel, "Interest and bank charges");
  assert.equal(shownRow.group, "match");
});

test("Show keeps the correction (the same row), and only then do buyers see it", async () => {
  const { check, served } = await checkOf("pacific", "revenue|2023", { state: "shown", correctedValue: 29280000 }, { patchText: tradeSales29280 });
  assert.equal(check.other, 29280000);
  assert.equal(check.decision, "shown");
  assert.ok(served, "shown with the corrected figure");
  assert.equal(served!.value, "$29,280,000");
});

test("no correction: the match shows with the checks, as before", async () => {
  const { served, row } = await checkOf("pacific", "revenue|2023", null);
  assert.ok(served);
  assert.equal(row.corrected, false);
  assert.equal(row.group, "match");
});

test("the refresh locates the broker's corrections (on their line), not only the figures Cimple read", async () => {
  const { raw, fx } = await checkOf("pacific", "interest|2022", { state: "corrected", correctedValue: 268000 });
  const plan = refreshPlan(raw, fx.sections as any);
  assert.ok(plan.toLocate.some((t) => t.value === 268000 && t.line === "interest"), "the corrected figure is located on the interest line");
});

await run("figure-corrected (Cimple read it wrong)");
