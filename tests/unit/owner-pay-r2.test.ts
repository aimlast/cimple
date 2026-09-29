/**
 * Owner-pay attribution, round 2 (checker findings on the Pacific rebuild):
 *  - a speaker's label is not what a line is about ("Manpreet Grewal: Ranjit
 *    Bains retired…" is not Manpreet retiring; "Manpreet Grewal: Dad takes
 *    $285K" is not Manpreet's pay);
 *  - a relative's pay is added back only when the deal's material says it is
 *    for no real work / above market / ends at the sale — otherwise (stays,
 *    nothing said, can't tell whose) it waits for the broker;
 *  - a single owner's line is cut to their stated pay only when the line is
 *    known to hold several people's pay; otherwise the broker is told;
 *  - a salary tied to an earlier year is never taken as this year's;
 *  - the analysis's own itemised notes are retold with the attributed figure.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/owner-pay-r2.test.ts
 */
import assert from "node:assert/strict";
import { applyAddbackRules, computeCanonicalEarnings } from "../../server/financial/normalization-rules";
import { payRosterFrom, statedPay } from "../../server/financial/owner-pay-attribution";
import type { UiNormalization } from "../../server/financial/shape";

const ab = (o: Record<string, unknown>) => ({ id: String(o.label), approved: true, amounts: {}, category: "other", ...o }) as any;
const names = ["Harjit Grewal", "Manpreet Grewal", "Surinder Grewal", "Dale Hughes", "Kevin Singh"];

// ── Pacific's real sentences (as the material holds them) ──
const pacific = [
  "Manpreet Grewal (VP Operations, willing to stay 2-3 years post-sale)",
  "transitionPlan: Manpreet Grewal to stay 2-3 years minimum as GM or VP Ops; willing to roll 10-15% of proceeds into buyer's entity",
  "Manpreet replied Friday evening approving both versions and clarifying three items (keep client name confidential pre-NDA, Dale's retirement timing, Kevin's promotion, nothing on Harvest Lane).",
  "Manpreet Grewal (seller): Kevin has Red Seal and is assistant foreman as of May 1, 2026, Dale's retirement planned 2027, Alderbrook wants to extend MSA another three years.",
  "Manpreet Grewal: Ranjit Bains retired in the fall and Harmon Bains firm wound down his client list.",
  "Manpreet Grewal: Adjusted EBITDA for 2024 is just under $4.1M (EBITDA from statements $3.55M plus Dad's full salary $285K who won't be replaced, Mom's salary $62K, personal vehicles and golf).",
  "[00:04:18] Morgan Ellis: Does Manpreet want to stay on after a sale?",
  "Seller (Manpreet): likely open to staying with right buyer.",
  "Dad (Harjit Grewal) full salary $285K, will not be replaced.",
  "And Surinder's salary — I've added it back as a non-working family member.",
];
const roster = payRosterFrom({ shared: pacific, private: ["Surinder (Harjit's wife) salary $62K; no operational role since 2019, salary was income-splitting arrangement, to be removed day one"] }, names);
const P = (n: string) => roster.people.get(n)!;
assert.equal(P("manpreet").stays, true, "Manpreet stays");
assert.equal(P("manpreet").leaves, false, "nobody else's retirement (Ranjit, Dale, Dad) is Manpreet's");
assert.equal(P("manpreet").noRealCost, false);
assert.equal(statedPay(P("manpreet")), null, "\"Manpreet Grewal: … Dad's full salary $285K\" is not Manpreet's pay");
assert.equal(P("dale").leaves, true, "\"Dale's retirement\" is Dale's");
assert.equal(statedPay(P("harjit"))?.current, 285_000);
assert.equal(P("harjit").leaves, true, "\"Dad (Harjit Grewal) … will not be replaced\" is Harjit");
assert.equal(P("surinder").noRealCost, true, "the broker's note: no operational role since 2019 (read across the semicolon)");

// Speaker labels (probes D/E).
{
  const e = payRosterFrom({ shared: ["Manpreet Grewal: Dad takes $285K a year and will not be replaced."], private: [] }, names);
  assert.equal(statedPay(e.people.get("manpreet")), null, "a speaker's label is not the pay's owner");
  assert.equal(e.people.get("manpreet")!.leaves, false);
  const d = payRosterFrom({ shared: ["Harjit Grewal: my salary is $285,000 and Manpreet's is $175,000."], private: [] }, names);
  assert.equal(statedPay(d.people.get("harjit"))?.current, 285_000, "the speaker's own pay in the first person");
  const g = payRosterFrom({ shared: ["keyFacts: Gord McAllister (seller): Owner salary $260,000 in 2024;"], private: [] }, ["Gord McAllister", "Luis Ortega"]);
  assert.deepEqual(statedPay(g.people.get("gord"))?.byYear, { "2024": 260_000 });
  assert.equal(statedPay(g.people.get("gord"))?.current, null, "a figure tied to 2024 is not an undated 'current' pay");
}

// ── A relative's pay (probe A and the spec's "only when the facts say so") ──
const n0 = (addbacks: any[]): UiNormalization => ({ metric: "ebitda", years: ["2024"], netIncome: { "2024": 1_000_000 }, addbacks } as any);
{
  const ctx = { roster, owners: ["Harjit", "Manpreet", "Surinder"], ownerName: "Harjit Grewal" };
  // The model's own add-back for Manpreet, who stays: waits for the broker.
  const a = applyAddbackRules(n0([ab({ label: "Family member salary — Manpreet Grewal (son)", description: "Son of the owner on payroll", category: "discretionary", amounts: { "2024": 175_000 } })]), ctx)!;
  assert.equal(a.addbacks[0].approved, false);
  assert.ok(a.notes!.some((x) => /Manpreet stays on after the sale/.test(x)));
  // Surinder (the material says: no operational role, income-splitting): added back.
  const s = applyAddbackRules(n0([ab({ label: "Non-working family member salary — Surinder Grewal", category: "discretionary", amounts: { "2024": 62_000 } })]), ctx)!;
  assert.equal(s.addbacks[0].approved, true);
  // A relative the material says nothing about: waits for the broker.
  const k = applyAddbackRules(n0([ab({ label: "Family member salary — Kevin Singh (nephew)", description: "Nephew, paid above market", category: "discretionary", amounts: { "2024": 30_000 } })]), ctx)!;
  assert.equal(k.addbacks[0].approved, false, "the model's description isn't the facts");
  assert.ok(k.notes!.some((x) => /nothing on file says Kevin's pay/.test(x)));
  // A line that doesn't say whose pay it is: waits for the broker.
  const u = applyAddbackRules(n0([ab({ label: "Spouse salary", category: "discretionary", amounts: { "2024": 40_000 } })]), ctx)!;
  assert.equal(u.addbacks[0].approved, false);
  assert.ok(u.notes!.some((x) => /doesn't say whose pay this is/.test(x)));
  // Not pay: a related-party rent or a family perk is left alone.
  const r = applyAddbackRules(n0([ab({ label: "Below-market yard rent adjustment", description: "Yard leased from a related party (family holding company)", amounts: { "2024": -78_000 } })]), ctx)!;
  assert.equal(r.addbacks[0].approved, true);
  assert.ok(!r.notes!.some((x) => /whose pay/.test(x)));
  // No roster (no deal material read): lines are left as the model gave them.
  assert.equal(applyAddbackRules(n0([ab({ label: "Spouse salary", category: "discretionary", amounts: { "2024": 40_000 } })]))!.addbacks[0].approved, true);
  // Ridgeline: "Donna salary over market (she makes $62k, market … $45k)" — above market, said by the material.
  const dr = payRosterFrom({ shared: ["$17,000 Donna salary over market (she makes $62k, market for part-time bookkeeper estimated $45k)", "Donna McAllister ($58,000 office management salary)"], private: [] }, ["Gord McAllister", "Donna McAllister"]);
  const dn = applyAddbackRules(n0([ab({ label: "Donna salary above market bookkeeper rate", description: "Owner's wife; paid above a part-time bookkeeper rate", category: "discretionary", amounts: { "2024": 17_000 } })]), { roster: dr })!;
  assert.equal(dn.addbacks[0].approved, true);
}

// ── One owner, one line: never cut on a guess (probe B) ──
{
  const r1 = payRosterFrom({ shared: ["Mike Chen: I take a salary of $150K plus a year-end bonus of about $60K."], private: [] }, ["Mike Chen"]);
  assert.equal(statedPay(r1.people.get("mike"))?.current, 150_000);
  const out = applyAddbackRules(n0([ab({ label: "Owner compensation — Mike Chen", description: "Owner salary and bonus; market salary $110,000", category: "owner_comp", amounts: { "2024": 210_000 }, marketSalary: 110_000 })]), {
    roster: r1, ownerName: "Mike Chen", owners: ["Mike"],
    pnl: { years: ["2024"], rows: [{ name: "Shareholder salaries", values: { "2024": 210_000 } }] } as any,
  })!;
  const e = computeCanonicalEarnings(out)!;
  assert.equal(e.adjustedEbitda["2024"], 1_000_000 + 100_000, "$210K − $110K market: counted as stated");
  assert.equal(e.sde["2024"], 1_000_000 + 210_000);
  assert.ok(out.notes!.some((x) => /more than the \$150,000 the deal's material says Mike is paid/.test(x)));
  assert.ok(!out.notes!.some((x) => /includes other people's pay/.test(x)));
}

// ── Several people's pay, proved by the figures adding up (no aggregate line name) ──
{
  const r3 = payRosterFrom({ shared: ["Harjit takes $285K.", "Manpreet is paid $175K as VP Operations.", "Surinder (Harjit's wife) salary $62K, no operational role."], private: [] }, names);
  const out = applyAddbackRules({
    metric: "ebitda", years: ["2024"], netIncome: { "2024": 1_000_000 },
    notes: ["Normalized EBITDA for 2024: $1,464,000 (net income $1,000,000 + owner comp above market $402,000 + Surinder salary $62,000)."],
    addbacks: [ab({ label: "Owner compensation — Harjit Grewal", category: "owner_comp", amounts: { "2024": 402_000 }, marketSalary: 120_000, ownerActualComp: { "2024": 522_000 } })],
  } as any, { roster: r3, ownerName: "Harjit Grewal", owners: ["Harjit"] })!;
  const excess = out.addbacks.find((a) => a.ownerCompPart === "excess")!;
  assert.deepEqual(excess.amounts, { "2024": 165_000 }, "$285K + $175K + $62K = $522K: only Harjit's $285K is his");
  // The model's itemised note is retold with the attributed figure.
  assert.ok(out.notes!.some((x) => /owner comp above market \$165,000 \+ Surinder salary \$62,000/.test(x)), out.notes!.join("\n"));
  assert.ok(!out.notes!.some((x) => /\$402,000/.test(x)));
}

console.log("owner-pay-r2: ok");
