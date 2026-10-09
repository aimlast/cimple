/**
 * The DD checks on the three demo copies reproduce the spec's §1.1 table
 * exactly (fictional fixtures; no DB, no AI), plus D11 and the decisions.
 *   npx tsx tests/unit/figure-checks.test.ts
 */
import assert from "node:assert/strict";
import { fixtureRaw, run, test } from "./helpers/figure-test";
import { buildChecks } from "../../server/cim/figures/checks";
import { financialSources, sourceKindOf } from "../../server/cim/figures/sources";

const find = (checks: any[], figureKey: string, kind: string) => checks.find((c) => c.figureKey === figureKey && c.kind === kind);

test("sources: statements and tax returns are recognised; interim, CRM and email material is not", async () => {
  const { fx, raw } = await fixtureRaw("pacific", { locate: false });
  assert.deepEqual(raw.sources.map((s) => `${s.kind} ${s.year}`).sort(), ["statements 2022", "statements 2023", "statements 2024", "tax_return 2022", "tax_return 2023", "tax_return 2024"]);
  assert.equal(sourceKindOf({ name: "Interim statements 6 months 2025", extractedData: { _documentType: "Interim financial statements" } }), null);
  // A broker-only copy of a statement is never a source.
  const docs = fx.documents.map((d) => (d.name.startsWith("T2 corporate income tax return 2023") ? { ...d, visibility: "broker_only" } : d));
  assert.ok(!financialSources(docs as any).some((s) => s.kind === "tax_return" && s.year === "2023"));
});

test("Lakeshore: interest = bank charges & merchant fees; opex 2022 = amortization + interest (worked out, regrouped)", async () => {
  const { raw } = await fixtureRaw("lakeshore");
  const c = raw.checks.checks;
  for (const [year, diff] of [["2022", 57000], ["2023", 64000], ["2024", 71000]] as const) {
    const k = find(c, `interest|${year}`, "tax_return");
    assert.ok(k, year);
    assert.equal(Math.abs(k.other) - Math.abs(k.base), diff);
    assert.equal(k.regrouped, true);
    assert.equal(k.located, true);
    assert.equal(k.sourceLabel, "Interest and bank charges");
    assert.match(k.regroupedText, /bank charges & merchant fees \(\$\d{2},000\)/);
  }
  const o = find(c, "operatingExpenses|2022", "tax_return");
  assert.equal(o.other - o.base, 205000);
  assert.equal(o.regroupedText, "The tax return's operating expenses also include amortization ($176,000) and interest ($29,000); the financial statements show them below operating expenses.");
});

test("Pacific: interest +$33,000 / +$36,000; opex 2023/2024 vs T2 = amortization + interest", async () => {
  const { raw } = await fixtureRaw("pacific");
  const c = raw.checks.checks;
  assert.equal(find(c, "interest|2022", "tax_return").regroupedText, "The tax return's interest line includes bank charges ($33,000), which the financial statements show on their own line.");
  assert.equal(find(c, "interest|2023", "tax_return").other - find(c, "interest|2023", "tax_return").base, 36000);
  const o23 = find(c, "operatingExpenses|2023", "tax_return");
  assert.equal(o23.other - o23.base, 2292000);
  assert.match(o23.regroupedText, /amortization \(\$1,880,000\) and interest \(\$412,000\)/);
  const o24 = find(c, "operatingExpenses|2024", "tax_return");
  assert.equal(o24.base, 5766500, "the tax return is compared with the statements as issued");
  assert.equal(o24.other - o24.base, 2345000);
});

test("Pacific FY2024: the CIM's opex differs from the statements by the two one-time lines (worked out)", async () => {
  const { raw } = await fixtureRaw("pacific");
  const k = find(raw.checks.checks, "operatingExpenses|2024", "cim_statements");
  assert.equal(k.base, 5639500);
  assert.equal(k.other, 5766500);
  assert.equal(k.regrouped, true);
  assert.match(k.asIssuedText, /^Financial statements as issued: \$5,766,500\. This CIM shows .* on their own line as one-time costs\.$/);
});

test("Beacon: the statements' opex vs the T2 = amortization + interest ($80,191 / $84,101)", async () => {
  const { raw } = await fixtureRaw("beacon");
  const c = raw.checks.checks;
  const k23 = find(c, "operatingExpenses@statements|2023", "tax_return");
  const k24 = find(c, "operatingExpenses@statements|2024", "tax_return");
  assert.equal(k23.other - k23.base, 80191);
  assert.equal(k24.other - k24.base, 84101);
  assert.ok(k23.regrouped && k24.regrouped);
  assert.equal(find(c, "revenue|2022", "tax_return"), undefined, "no 2022 tax return on file");
});

test("revenue, gross profit, net income and income taxes match in every year", async () => {
  for (const name of ["pacific", "beacon", "lakeshore"] as const) {
    const { raw } = await fixtureRaw(name);
    for (const c of raw.checks.checks.filter((x: any) => x.kind === "tax_return" && /^(revenue|grossProfit|netIncome|incomeTaxes)\|/.test(x.figureKey))) {
      if (name === "pacific" && c.figureKey === "grossProfit|2022") continue; // follows the FY2022 cost-of-sales mismatch (D9a)
      assert.ok(c.size === "match" || c.size === "rounding", `${name} ${c.figureKey} ${c.base} vs ${c.other}`);
    }
  }
});

test("D11: a figure not found in its document's text is not located (never shown); found once located", async () => {
  const { raw } = await fixtureRaw("lakeshore", { locate: false });
  const k = find(raw.checks.checks, "interest|2022", "tax_return");
  assert.equal(k.located, false, "a document new since the last refresh counts as not found");
  assert.ok(raw.checks.toLocate.length > 0);
});

test("decisions: left_out always applies; shown only while the values are the ones decided on; corrected replaces the value", async () => {
  const { raw } = await fixtureRaw("lakeshore");
  const k = find(raw.checks.checks, "interest|2022", "tax_return");
  const base = { registry: raw.registry, sources: raw.sources, located: raw.state!.located as any };
  let r = buildChecks({ ...base, decisions: [{ checkKey: k.key, state: "shown", correctedValue: null, valuesSnapshot: { base: k.base, other: k.other } }] });
  assert.equal(find(r.checks, "interest|2022", "tax_return").decision, "shown");
  r = buildChecks({ ...base, decisions: [{ checkKey: k.key, state: "shown", correctedValue: null, valuesSnapshot: { base: k.base, other: 1 } }] });
  assert.equal(find(r.checks, "interest|2022", "tax_return").decision, null, "values moved: the broker decides again");
  r = buildChecks({ ...base, decisions: [{ checkKey: k.key, state: "left_out", correctedValue: null, valuesSnapshot: { base: 1, other: 1 } }] });
  assert.equal(find(r.checks, "interest|2022", "tax_return").decision, "left_out");
  r = buildChecks({ ...base, decisions: [{ checkKey: k.key, state: "corrected", correctedValue: 29000, valuesSnapshot: { base: k.base, other: k.other } }] });
  const corrected = find(r.checks, "interest|2022", "tax_return");
  assert.equal(corrected.other, 29000);
  assert.equal(corrected.size, "match");
  assert.equal(corrected.decision, "corrected");
});

await run("figure-checks (§1.1)");
