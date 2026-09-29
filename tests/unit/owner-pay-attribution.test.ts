/**
 * Owner-pay attribution: a statement line of several people's pay is not the
 * selling owner's pay (Pacific rebuild 2026-09-28: $522K "Management
 * salaries — shareholders" = Harjit $285K + Manpreet $175K + Surinder $62K,
 * taken as Harjit's → a $402K add-back instead of $165K).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/owner-pay-attribution.test.ts
 */
import assert from "node:assert/strict";
import { applyAddbackRules, computeCanonicalEarnings } from "../../server/financial/normalization-rules";
import { ownersOnFile, payRosterFrom, payTextsFrom, peopleOnFile, statedPay } from "../../server/financial/owner-pay-attribution";
import type { UiNormalization, UiReclassifiedTable } from "../../server/financial/shape";

const ab = (o: Record<string, unknown>) => ({ id: String(o.label), approved: true, amounts: {}, category: "other", ...o }) as any;

// Pacific's facts, as stored (shortened).
const info: Record<string, unknown> = {
  ownerName: "Harjit Grewal",
  shareholders: "Harjit Singh Grewal (600 Class A voting common shares, 60.0%); Manpreet Grewal (250 Class A voting common shares, 25.0%); Surinder Kaur Grewal (150 Class B non-voting common shares, 15.0%)",
  managementTeam: "Harjit Grewal (President), Manpreet Grewal (VP Operations), Diane (books/accounting since 2019)",
  transitionPlan: "Manpreet Grewal to stay 2-3 years minimum as GM or VP Ops; willing to roll 10-15% of proceeds into buyer's entity",
  ownerInvolvement: "Harjit Grewal (President) manages Alderbrook and co-op customer relationships; broker normalized his salary assuming $120K replacement cost for customer role",
  _fieldAlternates: {
    ownerInvolvement: [
      { value: "Dad (Harjit Grewal) full salary $285K, will not be replaced. Mom's salary $62K.", source: "email", brokerOnly: false },
      { value: "Owner's father's salary: $285K. Owner's mother's salary: $62K.", source: "email", brokerOnly: false },
    ],
    keyEmployees: [
      { value: "Manpreet Grewal (Vice-President, Operations), Harjit Grewal (Dad, full salary $285K, will not be replaced), Diane Tremblay (Controller)", source: "email", brokerOnly: false },
    ],
  },
  _brokerPrivateNotes: [
    { note: "Owner (Harjit) salary $285K - noted he won't be replaced" },
    { note: "Surinder (Harjit's wife) salary $62K; no operational role since 2019, salary was income-splitting arrangement, to be removed day one" },
  ],
};
const shared = [
  // The broker's own working session: $120K is the market salary, never Harjit's pay.
  "Morgan Ellis: On adjusted EBITDA — your email had just under 4.1 for 2024. My normalization lands at 3.9. I only add back the part of Harjit's salary above what a buyer would pay to replace his customer role — I've assumed $120K — and I deduct the yard rent difference.",
  "Management salaries — shareholders 522,000 505,000",
];

// ── The roster: who is paid what, who stays ──
const people = peopleOnFile(info, ["Harjit Grewal"]);
for (const n of ["Harjit", "Manpreet", "Surinder"]) assert.ok(people.includes(n), `${n} is a person on file`);
assert.ok(!people.includes("Grewal") && !people.includes("Class"), "surnames and share classes are not first names");
assert.deepEqual(ownersOnFile(info).sort(), ["Harjit", "Manpreet", "Surinder"]);
// (Production: dealFigureTexts gives the documents and each fact's value; payTextsFrom adds the other values and notes.)
const factValues = Object.entries(info).filter(([k, v]) => !k.startsWith("_") && typeof v === "string").map(([, v]) => v as string);
const roster = payRosterFrom(payTextsFrom(info, { shared: [...factValues, ...shared], private: [] }), people);
const harjit = statedPay(roster.people.get("harjit"));
assert.equal(harjit?.current, 285_000, "Harjit's own pay is $285K (never the $120K market salary)");
assert.equal(harjit?.private, false, "an email states it — not only the broker's notes");
assert.equal(statedPay(roster.people.get("surinder"))?.current, 62_000, "\"Surinder (Harjit's wife) salary $62K\" is Surinder's pay, not Harjit's");
assert.equal(roster.people.get("manpreet")?.stays, true, "Manpreet stays on after the sale");

// ── The analysis's owner line: the whole shareholders' line, labelled Harjit ──
const pnl: UiReclassifiedTable = {
  years: ["2022", "2023", "2024"],
  rows: [{ category: "Owner Compensation", name: "Management salaries — shareholders", values: { "2022": 488_000, "2023": 505_000, "2024": 522_000 } } as any],
};
const n: UiNormalization = {
  metric: "ebitda",
  years: ["2022", "2023", "2024"],
  netIncome: { "2022": 1_115_900, "2023": 665_915, "2024": 972_960 },
  addbacks: [
    ab({ label: "Interest, taxes, D&A", type: "ebitda", amounts: { "2022": 2_411_900, "2023": 2_467_685, "2024": 2_638_240 } }),
    ab({
      label: "Owner compensation — Harjit Grewal (President)",
      category: "owner_comp",
      type: "sde",
      amounts: { "2022": 488_000, "2023": 505_000, "2024": 522_000 },
      marketSalary: 120_000,
      description: "Harjit's salary and benefits; a replacement customer relationship manager would cost approximately $120,000.",
    }),
    ab({ label: "Non-working family member salary — Surinder Grewal", category: "discretionary", amounts: { "2024": 62_000 }, description: "No active role since 2019 per seller disclosure. Income splitting; will not continue post-sale." }),
  ],
};
const ctx = { roster, pnl, ownerName: "Harjit Grewal", owners: ownersOnFile(info) };

{
  // Before: the whole $522K is taken as Harjit's pay ($402K add-back).
  const before = computeCanonicalEarnings(applyAddbackRules(n)!)!;
  assert.equal(before.adjustedEbitda["2024"], 972_960 + 2_638_240 + 402_000 + 62_000);
  // After: only Harjit's $285K — $165K above the $120K market salary.
  const ruled = applyAddbackRules(n, ctx)!;
  const excess = ruled.addbacks.find((a) => a.ownerCompPart === "excess")!;
  assert.deepEqual(excess.amounts, { "2024": 165_000 }, "2024: $285K − $120K");
  assert.deepEqual(excess.ownerActualComp, { "2024": 285_000 });
  assert.equal(excess.approved, true);
  assert.equal(excess.confidence, "low", "earlier years aren't stated — flagged");
  const after = computeCanonicalEarnings(ruled)!;
  assert.equal(after.adjustedEbitda["2024"], 972_960 + 2_638_240 + 165_000 + 62_000, "Surinder counted once, Manpreet's pay stays a cost");
  assert.equal(after.sde["2024"], after.adjustedEbitda["2024"] + 120_000, "SDE adds back Harjit's full $285K");
  // Years with no stated pay for Harjit add back nothing — and the broker is told.
  assert.equal(after.adjustedEbitda["2023"], 665_915 + 2_467_685);
  assert.ok(ruled.notes!.some((x) => /isn't stated for 2022 and 2023/.test(x)), "the broker is told which years to complete");
  assert.ok(ruled.notes!.some((x) => /includes other people's pay/.test(x)));
}

{
  // No stated pay for the person, several shareholders: left for the broker.
  const bare = payRosterFrom({ shared: [], private: [] }, people);
  const ruled = applyAddbackRules(n, { ...ctx, roster: bare })!;
  const owner = ruled.addbacks.filter((a) => a.ownerCompPart);
  assert.ok(owner.length > 0 && owner.every((a) => a.approved === false), "not added back until the broker splits it");
  assert.ok(ruled.notes!.some((x) => /several people's pay/.test(x)));
  // One shareholder on file: a "Shareholders' salaries" line is that owner's pay.
  const solo = applyAddbackRules(n, { ...ctx, roster: bare, owners: ["Harjit"] })!;
  assert.ok(solo.addbacks.filter((a) => a.ownerCompPart).every((a) => a.approved === true));
}

{
  // A broker's own decision on the line is never rewritten.
  const mine = { ...n, addbacks: n.addbacks.map((a) => (a.category === "owner_comp" ? { ...a, approvedOverride: true } : a)) };
  const ruled = applyAddbackRules(mine, ctx)!;
  assert.deepEqual(ruled.addbacks.find((a) => a.category === "owner_comp")!.amounts, { "2022": 488_000, "2023": 505_000, "2024": 522_000 });
}

{
  // A relative who stays on, with nothing saying the pay is for no work: a real cost.
  const staying = applyAddbackRules({ ...n, addbacks: [ab({ label: "Family member salary — Manpreet Grewal (son)", category: "discretionary", amounts: { "2024": 175_000 }, description: "Son of the owner, VP Operations." })] }, ctx)!;
  assert.equal(staying.addbacks[0].approved, false);
  assert.ok(staying.notes!.some((x) => /Manpreet stays on/.test(x)));
  // The model's own description saying he is paid above market isn't the facts saying so…
  const aboveLine = { ...n, addbacks: [ab({ label: "Family member salary — Manpreet Grewal (son)", category: "discretionary", amounts: { "2024": 50_000 }, description: "Paid $50K above market for the role." })] };
  assert.equal(applyAddbackRules(aboveLine, ctx)!.addbacks[0].approved, false);
  // …the deal's material saying it is.
  const said = payRosterFrom(payTextsFrom(info, { shared: [...factValues, ...shared, "Manpreet is paid about $50K above market for a VP Operations role."], private: [] }), people);
  assert.equal(applyAddbackRules(aboveLine, { ...ctx, roster: said })!.addbacks[0].approved, true);
  // Surinder (non-working, leaving) stays approved.
  assert.equal(applyAddbackRules(n, ctx)!.addbacks.find((a) => /Surinder/.test(a.label))!.approved, true);
}

{
  // The owner's pay already stated as the line (v1's "$285K − $120K") is untouched.
  const v1 = { ...n, addbacks: [ab({ label: "Harjit's salary above replacement cost", category: "owner_comp", type: "sde", amounts: { "2024": 165_000 }, description: "Harjit takes $285K; market replacement for customer-facing role is $120K. Addback: $165K." })] };
  const ruled = applyAddbackRules(v1, ctx)!;
  const excess = ruled.addbacks.find((a) => a.ownerCompPart === "excess")!;
  assert.deepEqual(excess.amounts, { "2024": 165_000 });
  assert.ok(!ruled.notes!.some((x) => /other people's pay|several people/.test(x)));
}

console.log("owner-pay-attribution: ok");
