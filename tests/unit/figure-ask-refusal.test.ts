/**
 * "Ask the seller" never reaches the seller with a question they may not be
 * asked (checker r2 R2-4): EBITDA, net income, income taxes, pay and one-time
 * lines (the money-talk rule), and no figure held because the CIM doesn't
 * match the statements (D9a). The route's plan refuses them — a single
 * refused item is a 422 — and the workspace never offers the button.
 *   npx tsx tests/unit/figure-ask-refusal.test.ts
 */
import assert from "node:assert/strict";
import { fixtureRaw, run, test } from "./helpers/figure-test";
import { askableLine, planSellerAsk, sellerAskRefusal } from "../../server/cim/figures/candidates";
import { buildWorkspace } from "../../server/cim/figures/workspace";
import { standardLine } from "../../shared/figure-lines";

const { fx, raw } = await fixtureRaw("pacific");
const q = (id: string, figureKey: string, kind = "movement") => ({ id, figureKey, kind });

test("income taxes are never a seller question (the standard line and any 'Taxes' line)", () => {
  assert.equal(standardLine("incomeTaxes")!.askable, false);
  const taxes = Object.values(raw.registry).filter((f) => f.line === "incomeTaxes" || f.category === "Taxes");
  assert.ok(taxes.length > 0);
  for (const f of taxes) assert.equal(askableLine(f), false, f.key);
  // A standard line the seller may be asked about stays askable unless its category says otherwise.
  assert.equal(askableLine({ line: "revenue", category: undefined } as any), true);
  assert.equal(askableLine({ line: "revenue", category: "Taxes" } as any), false);
});

test("checker r2: EBITDA, net income, income taxes and the held FY2022 cost of sales are all refused; the request is rejected", () => {
  const keys = ["ebitda|2023", "netIncome|2024", "incomeTaxes|2024", "costOfSales|2022"];
  for (const k of keys) assert.ok(raw.registry[k], `${k} is in the fixture`);
  const plan = planSellerAsk(raw, { figureKeys: keys });
  assert.deepEqual(plan.figureKeys, []);
  assert.equal(plan.refused.length, 4);
  assert.ok(plan.reject, "nothing left to ask → 422");
  assert.match(sellerAskRefusal(raw.registry, raw.checks.checks, "costOfSales|2022")!, /FY2022 figures don't match the statements/);
  assert.match(sellerAskRefusal(raw.registry, raw.checks.checks, "incomeTaxes|2024")!, /doesn't ask the seller about income taxes/);
});

test("a single refused figure is a 422 with its own reason", () => {
  const plan = planSellerAsk(raw, { figureKeys: ["incomeTaxes|2024"] });
  assert.match(plan.reject ?? "", /income taxes/);
});

test("a movement measured from a held year is refused; an askable figure in the same request still goes", () => {
  const ok = Object.values(raw.registry).find((f) => f.year === "2024" && askableLine(f) && !sellerAskRefusal(raw.registry, raw.checks.checks, f.key))!;
  assert.ok(ok, "some askable FY2024 figure");
  const plan = planSellerAsk(raw, { figureKeys: ["costOfSales|2023", ok.key] });
  assert.deepEqual(plan.figureKeys, [ok.key]);
  assert.equal(plan.refused[0].figureKey, "costOfSales|2023");
  assert.match(plan.refused[0].reason, /Fix FY2022 first/);
  assert.equal(plan.reject, null);
});

test("existing questions are checked too (a question planned before a hold, or about a tax line)", () => {
  const withQs = { ...raw, questions: [q("q-held", "costOfSales|2023"), q("q-tax", "incomeTaxes|2024"), q("q-diff-held", "costOfSales|2022", "difference")] as any };
  const plan = planSellerAsk(withQs, { questionIds: ["q-held", "q-tax", "q-diff-held"] });
  assert.deepEqual(plan.questionIds, []);
  assert.equal(plan.refused.length, 3);
  assert.ok(plan.reject);
  // An unknown question id is passed through (the follow-up path ignores ids it doesn't have).
  assert.deepEqual(planSellerAsk(withQs, { questionIds: ["q-unknown"] }).questionIds, ["q-unknown"]);
});

test("the workspace never offers 'Ask the seller' on income taxes", () => {
  const ws = buildWorkspace({ raw, sections: fx.sections, build: null, autoAsk: false, autoAskChosen: false, stale: false, ddBuyers: 0, dailyLimit: false, oldDdWording: false });
  const taxes = ws.moves.filter((m) => /income tax/i.test(m.label));
  for (const m of taxes) assert.equal(m.askable, false, m.figureKey);
});

await run("figure-ask-refusal (money-talk rule + Fix first)");
