/**
 * F2-CIMTRUTH-2 (final review): owner-pay attribution fails closed. A pay
 * statement tied to a year of history ("since 2015") is the current pay; a
 * stated pay that covers none of the analysis years never lets a
 * several-shareholders line be added back whole — it goes to the broker.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/owner-pay-fail-closed.test.ts
 */
import assert from "node:assert/strict";
import { applyAddbackRules } from "../../server/financial/normalization-rules";
import { ownersOnFile, payRosterFrom, payTextsFrom, peopleOnFile, statedPay } from "../../server/financial/owner-pay-attribution";

const ab = (o: Record<string, unknown>) => ({ id: String(o.label), approved: true, amounts: {}, category: "other", ...o }) as any;

function run(statements: string[]) {
  const info: Record<string, unknown> = {
    ownerName: "Harjit Grewal",
    shareholders: "Harjit Singh Grewal (60.0%); Manpreet Grewal (25.0%); Surinder Kaur Grewal (15.0%)",
    managementTeam: "Harjit Grewal (President), Manpreet Grewal (VP Operations)",
    transitionPlan: "Manpreet Grewal to stay 2-3 years minimum as GM",
  };
  const people = peopleOnFile(info, ["Harjit Grewal"]);
  const factValues = Object.entries(info).filter(([k, v]) => !k.startsWith("_") && typeof v === "string").map(([, v]) => v as string);
  const roster = payRosterFrom(payTextsFrom(info, { shared: [...factValues, ...statements], private: [] }), people);
  const pnl: any = { years: ["2023", "2024"], rows: [{ category: "Owner Compensation", name: "Management salaries — shareholders", values: { "2023": 505_000, "2024": 522_000 } }] };
  const n: any = {
    metric: "ebitda", years: ["2023", "2024"], netIncome: { "2023": 665_915, "2024": 972_960 },
    addbacks: [ab({ label: "Owner compensation — Harjit Grewal (President)", category: "owner_comp", type: "sde", amounts: { "2023": 505_000, "2024": 522_000 }, marketSalary: 120_000, description: "Harjit's salary" })],
  };
  const ruled = applyAddbackRules(n, { roster, pnl, ownerName: "Harjit Grewal", owners: ownersOnFile(info) })!;
  const line = ruled.addbacks.find((a: any) => a.label === "Owner compensation — Harjit Grewal (President)");
  return { stated: statedPay(roster.people.get("harjit")!), line, notes: ruled.notes ?? [] };
}

// A: the plain statement (reference).
{
  const r = run(["Harjit takes a salary of $285,000."]);
  assert.equal(r.line.approved, true);
  assert.deepEqual(r.line.amounts, { "2024": 165_000 }, "only Harjit's pay above market");
}

// B: "since 2015" is the pay now — the same result as A (it used to add back $385K / $402K).
{
  const r = run(["Harjit has drawn a salary of $285,000 since 2015."]);
  assert.equal(r.stated?.current, 285_000, "since-year pay is current");
  assert.deepEqual(r.stated?.byYear, {});
  assert.equal(r.line.approved, true);
  assert.deepEqual(r.line.amounts, { "2024": 165_000 });
}

// A pay stated only for a year outside the analysis: never the whole line — the broker splits it.
{
  const r = run(["Harjit's salary was $285,000 in 2019."]);
  assert.deepEqual(r.stated?.byYear, { "2019": 285_000 });
  assert.equal(r.line.approved, false, "not added back whole");
  assert.equal(r.line.confidence, "low");
  assert.ok(r.notes.some((n: string) => /several people's pay/.test(n)), "the broker is told");
}

// E: no statement at all — the same fail-closed treatment (unchanged).
{
  const r = run([]);
  assert.equal(r.line.approved, false);
}

console.log("owner-pay-fail-closed: all assertions passed");
