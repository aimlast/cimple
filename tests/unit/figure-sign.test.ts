/**
 * Signs matter for profits (checker r2 R2-7): a CIM net loss of $50,000 never
 * "matches" a tax return's net income of +$50,000. Expenses still compare as
 * amounts ("(268,000)" and "268,000" are the same cost). A loss on one side
 * and a profit on the other is never "explained" by regrouping lines.
 *   npx tsx tests/unit/figure-sign.test.ts
 */
import assert from "node:assert/strict";
import { run, test } from "./helpers/figure-test";
import { differenceOf, sizeOf } from "../../shared/figure-compare";
import { buildChecks } from "../../server/cim/figures/checks";
import type { FinancialSource } from "../../server/cim/figures/sources";
import type { FigureRegistry } from "../../shared/figure-anchors";
import { parseTypedFigure } from "../../client/src/pages/broker/deal/figures/CheckDialogs";

test("sizeOf / differenceOf: signed lines keep the sign; expenses don't", () => {
  assert.equal(sizeOf(-50000, 50000, null, { signed: true }), "material");
  assert.equal(differenceOf(-50000, 50000, true), 100000);
  assert.equal(sizeOf(-155000, 155000), "match", "an expense in parentheses is the same cost");
  assert.equal(differenceOf(-155000, 155000), 0);
  assert.equal(sizeOf(1115900, 1115900, null, { signed: true }), "match");
});

function t2(values: FinancialSource["values"]): FinancialSource {
  return { documentId: "t2-2023", kind: "tax_return", taxForm: "T2", year: "2023", values, updatedAt: "2026-10-01T00:00:00.000Z", docKind: "tax_return" as any };
}
const fig = (key: string, line: any, label: string, value: number, expense: boolean) => ({ key, line, lineLabel: label, year: "2023", value, total: false, expense });

test("a CIM net loss vs a tax-return profit of the same size is a difference, never a match", () => {
  const registry: FigureRegistry = {
    "netIncome|2023": fig("netIncome|2023", "netIncome", "Net income", -50000, false),
    "otherIncome|2023": fig("otherIncome|2023", "otherIncome", "Other income", 50000, false),
    // A line of exactly the signed gap ($100,000): without the sign rule it would "explain" the flip.
    "line:one-time-gain|2023": { ...fig("line:one-time-gain|2023", "line:one-time-gain", "One-time gain", 100000, false), category: "Other Income" },
  };
  const r = buildChecks({ registry, sources: [t2({ netIncome: { "2023": 50000 } })], located: {}, decisions: [] });
  const c = r.checks.find((x) => x.figureKey === "netIncome|2023")!;
  assert.ok(c, "the net income is compared");
  assert.equal(c.signed, true);
  assert.equal(c.size, "material", "−$50,000 vs +$50,000");
  assert.equal(c.regrouped, false, "a sign flip is never explained by another line of $100,000 or $50,000");
});

test("an expense in parentheses on one side still matches", () => {
  const registry: FigureRegistry = { "interest|2023": fig("interest|2023", "interest", "Interest", -412000, true) };
  const r = buildChecks({ registry, sources: [t2({ interest: { "2023": 412000 } })], located: {}, decisions: [] });
  const c = r.checks.find((x) => x.figureKey === "interest|2023")!;
  assert.equal(c.size, "match");
  assert.equal(c.signed, undefined);
});

test("'Cimple read it wrong' accepts a loss as the document prints it", () => {
  assert.equal(parseTypedFigure("(86,000)"), -86000);
  assert.equal(parseTypedFigure("-86,000"), -86000);
  assert.equal(parseTypedFigure("−86,000"), -86000);
  assert.equal(parseTypedFigure("$86,000"), 86000);
  assert.equal(parseTypedFigure("86000.50"), 86000.5);
  assert.equal(parseTypedFigure("eighty"), null);
  assert.equal(parseTypedFigure(""), null);
});

await run("figure-sign (a loss never matches a profit)");
