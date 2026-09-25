/**
 * Financial analysis post-processing: distributions are never add-backs,
 * working capital is cash-free/debt-free with no single-period peg, and
 * EBITDA/SDE are computed in code (text that disagrees is flagged).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/financial-normalization.test.ts
 */
import assert from "node:assert/strict";
import {
  applyAddbackRules,
  applyWorkingCapitalRules,
  computeCanonicalEarnings,
  flagEarningsStatements,
  flagEarningsNotes,
  withCanonicalEarnings,
} from "../../server/financial/normalization-rules";
import { postProcessAnalysis, finalizeEarnings, financialDiscrepancyValues } from "../../server/financial/analyzer";
import type { UiNormalization } from "../../server/financial/shape";

const ab = (o: Record<string, unknown>) => ({ id: String(o.label), approved: true, amounts: {}, category: "other", ...o }) as any;

// ── Ridgeline: a Class D dividend is not owner compensation ──
{
  const n: UiNormalization = {
    metric: "sde",
    years: ["2024"],
    netIncome: { "2024": 1_300_000 },
    addbacks: [
      ab({ label: "Owner salary (T4)", category: "owner_comp", type: "sde", amounts: { "2024": 180_000 } }),
      ab({ label: "Class D dividend", category: "owner_comp", type: "sde", amounts: { "2024": 60_000 } }),
      ab({ label: "Interest", type: "ebitda", amounts: { "2024": 20_000 } }),
    ],
  };
  const ruled = applyAddbackRules(n)!;
  const div = ruled.addbacks.find((a) => a.label === "Class D dividend")!;
  assert.equal(div.approved, false, "a dividend line is never approved");
  assert.match(div.description!, /distribution/i);
  assert.ok(ruled.notes!.some((x) => /Class D dividend.*distribution/.test(x)));
  const c = computeCanonicalEarnings(ruled)!;
  assert.equal(c.sde["2024"], 1_300_000 + 180_000 + 20_000, "SDE excludes the dividend");
  assert.equal(c.adjustedEbitda["2024"], 1_320_000);

  // Owner comp that folded the dividend in: the dividend comes out.
  const mixed = applyAddbackRules({
    ...n,
    addbacks: [ab({ label: "Owner compensation", category: "owner_comp", type: "sde", description: "Gord's salary $180K + $60K Class D dividend + $28K benefits", amounts: { "2024": 268_000 } })],
  })!;
  assert.equal(mixed.addbacks[0].amounts["2024"], 208_000);
  assert.ok(mixed.notes!.some((x) => /\$60,000 dividend/.test(x)));

  // A broker's own decision is never undone.
  const kept = applyAddbackRules({ ...n, addbacks: [ab({ label: "Owner draws", approvedOverride: true, amounts: { "2024": 50_000 } })] })!;
  assert.equal(kept.addbacks[0].approved, true);

  // A clawback removed as income is a timing item.
  const rec = applyAddbackRules({ ...n, addbacks: [ab({ label: "ODB post-payment recovery", amounts: { "2024": -18_000 } })] })!;
  assert.equal(rec.addbacks[0].approved, false);
}

// ── Beacon: working capital excludes cash; a single-period peg is nulled ──
{
  const wc = applyWorkingCapitalRules({
    currentAssets: [{ name: "Cash", amount: 871_410 }, { name: "Accounts receivable", amount: 462_500 }, { name: "Inventory", amount: 390_000 }],
    currentLiabilities: [{ name: "Accounts payable", amount: 310_000 }, { name: "Current portion of long-term debt", amount: 60_000 }, { name: "Income taxes payable", amount: 25_000 }],
    netWorkingCapital: 1_328_910,
    pegAmount: 1_328_910,
    targetNwc: 1_328_910,
  })!;
  assert.ok(!wc.currentAssets.some((i) => /cash/i.test(i.name)), "cash row removed");
  assert.ok(wc.currentAssets.some((i) => /receivable/i.test(i.name)), "receivables kept");
  assert.deepEqual(wc.currentLiabilities.map((i) => i.name), ["Accounts payable"]);
  assert.equal(wc.netWorkingCapital, 462_500 + 390_000 - 310_000, "NWC recomputed");
  assert.equal(wc.pegAmount, null, "a peg equal to one period's NWC is nulled");
  assert.equal(wc.targetNwc, null);
  assert.ok(wc.notes!.some((x) => /cash-free, debt-free/.test(x)));
  // A real trailing-average peg survives.
  const avg = applyWorkingCapitalRules({ currentAssets: [{ name: "AR", amount: 500 }], currentLiabilities: [], netWorkingCapital: 500, pegAmount: 420 })!;
  assert.equal(avg.pegAmount, 420);
}

// ── Beacon: EBITDA from its components; an insight stating $679,312 is flagged ──
{
  const n: UiNormalization = {
    metric: "ebitda",
    years: ["2023", "2024"],
    netIncome: { "2023": 400_000, "2024": 496_728 },
    addbacks: [
      ab({ label: "Income taxes", type: "ebitda", amounts: { "2023": 60_000, "2024": 79_423 } }),
      ab({ label: "Interest expense", type: "ebitda", amounts: { "2023": 12_000, "2024": 11_361 } }),
      ab({ label: "Amortization", type: "ebitda", amounts: { "2023": 70_000, "2024": 72_740 } }),
    ],
  };
  const c = computeCanonicalEarnings(n)!;
  assert.equal(c.reportedEbitda["2024"], 660_252);
  assert.equal(c.adjustedEbitda["2024"], 660_252);
  const stored = withCanonicalEarnings(n)!;
  assert.equal(stored.adjustedEbitda, 660_252);
  assert.equal(stored.computed!.latestYear, "2024");
  const { insights, mismatches } = flagEarningsStatements(
    {
      positive: [
        { id: "a", type: "positive", title: "Strong earnings", detail: "FY2024 EBITDA of $679,312 on revenue of $9.1M." },
        { id: "b", type: "positive", title: "Ties", detail: "FY2024 EBITDA reached $660,252." },
      ],
      negative: [],
    },
    n,
  );
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].stated, 679_312);
  assert.equal(mismatches[0].expected, 660_252);
  assert.ok((insights!.positive[0] as any).flag, "the wrong figure is flagged");
  assert.match(insights!.positive[0].detail, /computes 2024 EBITDA as \$660,252/);
  assert.ok(!(insights!.positive[1] as any).flag, "a figure that ties is left alone");
}

// ── A worked sum is judged on its result, not its first term ──
{
  const n: UiNormalization = {
    metric: "sde", years: ["2024"], netIncome: { "2024": 563_190 },
    addbacks: [ab({ label: "Owner salary above market", type: "sde", amounts: { "2024": 130_000 } }), ab({ label: "Depreciation", type: "ebitda", amounts: { "2024": 214_000 } })],
    notes: [
      "FY2024 SDE: $563,190 + $130K + $214K = $907,190.",
      "FY2024 SDE: $563,190 + $130K + $214K = $950,000.",
    ],
  };
  const flagged = flagEarningsNotes(n)!;
  const checks = flagged.notes!.filter((x) => x.startsWith("Check:"));
  assert.equal(checks.length, 1, "only the sum that doesn't tie is flagged");
  assert.match(checks[0], /states 2024 SDE as \$950,000; the add-backs listed here compute \$907,190/);
  assert.equal(flagEarningsNotes(flagged)!.notes!.filter((x) => x.startsWith("Check:")).length, 1, "idempotent");
}

// ── The analyzer's pipeline applies the rules end to end ──
{
  const out = finalizeEarnings(postProcessAnalysis({
    reclassifiedPnl: null,
    reclassifiedBalanceSheet: null,
    reclassifiedCashFlow: null,
    normalization: {
      metric: "sde", years: ["2024"], netIncome: { "2024": 100_000 },
      addbacks: [ab({ label: "Shareholder dividends", type: "sde", amounts: { "2024": 50_000 } }), ab({ label: "Owner salary above market", type: "sde", amounts: { "2024": 40_000 } })],
    },
    workingCapital: { currentAssets: [{ name: "Cash and equivalents", amount: 10 }], currentLiabilities: [], netWorkingCapital: 10 },
    insights: { positive: [{ id: "x", type: "positive", title: "SDE", detail: "2024 SDE of $190,000." }], negative: [] },
    clarifyingQuestions: null,
    discrepancies: [],
    clearedDiscrepancyIds: [],
    aiReasoning: "",
  }));
  assert.equal((out.normalization as any).adjustedSde, 140_000);
  assert.ok((out.insights as any).positive[0].flag, "$190,000 SDE (with the dividend) is flagged");
  assert.equal((out.workingCapital as any).currentAssets.length, 0);
}

// ── Analysis discrepancies: sides, privacy, fact key ──
{
  const v = financialDiscrepancyValues(
    {
      field: "Total employee headcount",
      factKey: "employees",
      sourceA: { source: "Staff roster (Feb 2025)", value: "36 employees", documentId: "11111111-1111-1111-1111-111111111111" },
      sourceB: { source: "per broker note", value: "36 total employees including owner (per broker note)" },
      severity: "minor",
      category: "operational",
      explanation: "The broker note counts the owner; the roster doesn't.",
      suggestedResolution: "Check the CRM record.",
    },
    { "11111111-1111-1111-1111-111111111111": "Staff roster (Feb 2025)" },
    { "11111111-1111-1111-1111-111111111111": { kind: "document", brokerOnly: false } },
  );
  const text = [v.interviewValue, v.documentValue, v.aiExplanation, v.suggestedResolution].join(" | ");
  assert.doesNotMatch(text, /CRM|broker note|broker recast|site visit/i, "no private source named in stored text");
  assert.equal(v.factKey, "employees");
  const sides = v.sideSources as any;
  assert.equal(sides.interview.brokerOnly, true, "the private claim is the seller-side slot, flagged");
  assert.equal(sides.document.documentId, "11111111-1111-1111-1111-111111111111");
  assert.equal(v.documentId, "11111111-1111-1111-1111-111111111111");
}

// ── Round 2: the distribution / clawback rules are narrow ──
{
  const base = { metric: "ebitda" as const, years: ["2024"], netIncome: { "2024": 1_000_000 } };
  const ruled = applyAddbackRules({
    ...base,
    addbacks: [
      ab({ label: "Distribution centre relocation (one-time)", category: "one_time", type: "ebitda", amounts: { "2024": 120_000 } }),
      ab({ label: "Dividend income on investments (non-operating)", category: "non_recurring", type: "ebitda", amounts: { "2024": -15_000 } }),
      ab({ label: "Insurance recovery (flood claim, one-time gain)", category: "non_recurring", type: "ebitda", amounts: { "2024": -150_000 } }),
      ab({ label: "Legal settlement recovered", category: "one_time", type: "ebitda", amounts: { "2024": -90_000 } }),
    ],
  })!;
  for (const a of ruled.addbacks) assert.equal(a.approved, true, `${a.label} stays approved`);
  assert.ok(!ruled.notes!.some((x) => /distribution|clawback/i.test(x)), "no rule fired");
  const c = computeCanonicalEarnings(ruled)!;
  assert.equal(c.adjustedEbitda["2024"], 1_000_000 + 120_000 - 15_000 - 150_000 - 90_000, "one-time gains stay removed");

  // …while real distributions and clawbacks are still caught.
  const caught = applyAddbackRules({
    ...base,
    addbacks: [
      ab({ label: "Shareholder distributions", amounts: { "2024": 40_000 } }),
      ab({ label: "Owner draws", amounts: { "2024": 30_000 } }),
      ab({ label: "Distributions", amounts: { "2024": 20_000 } }),
      ab({ label: "ODB post-payment recovery", amounts: { "2024": -6_200 } }),
      ab({ label: "Drug plan clawback", amounts: { "2024": -4_000 } }),
    ],
  })!;
  for (const a of caught.addbacks) assert.equal(a.approved, false, `${a.label} is not approved`);
}

// ── Round 2: a dividend the description already excludes is not taken out again ──
{
  const n: UiNormalization = {
    metric: "sde", years: ["2024"], netIncome: { "2024": 1_300_000 },
    addbacks: [ab({
      label: "Owner compensation", category: "owner_comp", type: "sde", amounts: { "2024": 208_000 },
      description: "Gord's T4 salary $180,000 plus $28,000 benefits. The $60,000 Class D dividend is excluded (a distribution, not an add-back).",
    })],
  };
  const once = applyAddbackRules(n)!;
  assert.equal(once.addbacks[0].amounts["2024"], 208_000, "negated dividend: nothing subtracted");
  assert.equal(once.addbacks[0].description, n.addbacks[0].description, "no second 'dividend is excluded' clause");
  assert.ok(!once.notes?.some((x) => /dividend/.test(x)), "no dividend note");

  // The rule is idempotent on its own output.
  const folded = applyAddbackRules({ ...n, addbacks: [ab({ label: "Owner compensation", category: "owner_comp", type: "sde", description: "Gord's salary $180K + $60K Class D dividend + $28K benefits", amounts: { "2024": 268_000 } })] })!;
  assert.equal(folded.addbacks[0].amounts["2024"], 208_000);
  const twice = applyAddbackRules(folded)!;
  assert.equal(twice.addbacks[0].amounts["2024"], 208_000, "second pass leaves it alone");
  assert.equal((twice.addbacks[0].description!.match(/dividend is excluded/g) ?? []).length, 1);

  // Folded in without an inclusion word — the arithmetic shows it.
  const sum = applyAddbackRules({ ...n, addbacks: [ab({ label: "Owner compensation", category: "owner_comp", type: "sde", description: "Salary $180,000; the owner also received a $60,000 dividend", amounts: { "2024": 240_000 } })] })!;
  assert.equal(sum.addbacks[0].amounts["2024"], 180_000);
}

// ── Round 2: SDE adds back the owner's FULL pay; EBITDA only the excess ──
{
  const NI = 1_000_000;
  // The model's "salary minus market" line (Ridgeline re-run wording).
  const r = applyAddbackRules({
    metric: "sde", years: ["2024"], netIncome: { "2024": NI },
    addbacks: [ab({ label: "Owner compensation above market", category: "owner_comp", type: "sde", description: "$180K salary minus $125K market replacement = $55K", amounts: { "2024": 55_000 } })],
  })!;
  const c = computeCanonicalEarnings(r)!;
  assert.equal(c.sde["2024"], NI + 180_000, "SDE = NI + the full $180K");
  assert.equal(c.adjustedEbitda["2024"], NI + 55_000, "EBITDA = NI + the $55K above market");
  const mkt = r.addbacks.find((a) => a.ownerCompPart === "market")!;
  assert.equal(mkt.type, "sde");
  assert.equal(mkt.amounts["2024"], 125_000);
  assert.equal(r.addbacks.find((a) => a.ownerCompPart === "excess")!.type, "ebitda");
  // Idempotent: a second pass doesn't split again.
  assert.equal(applyAddbackRules(r)!.addbacks.length, 2);

  // Structured fields (the prompt's format) — Beacon: SDE = adjusted EBITDA + the $140K market salary.
  const b = applyAddbackRules({
    metric: "ebitda", years: ["2023", "2024"], netIncome: { "2023": 400_000, "2024": 496_728 },
    addbacks: [
      ab({ label: "Owner compensation (Dr. Park)", category: "owner_comp", ownerActualComp: { "2023": 180_000, "2024": 185_000 }, marketSalary: 140_000, amounts: { "2023": 180_000, "2024": 185_000 } }),
      ab({ label: "Amortization", type: "ebitda", amounts: { "2023": 70_000, "2024": 72_740 } }),
    ],
  })!;
  const bc = computeCanonicalEarnings(b)!;
  assert.equal(bc.adjustedEbitda["2024"], 496_728 + 72_740 + 45_000);
  assert.equal(bc.sde["2024"], bc.adjustedEbitda["2024"] + 140_000);
  assert.equal(bc.sde["2023"], 400_000 + 70_000 + 180_000);

  // An owner paid below market: EBITDA is reduced, SDE still = NI + actual pay.
  const low = computeCanonicalEarnings(applyAddbackRules({
    metric: "sde", years: ["2024"], netIncome: { "2024": NI },
    addbacks: [ab({ label: "Owner compensation", category: "owner_comp", ownerActualComp: { "2024": 60_000 }, marketSalary: 125_000, amounts: { "2024": 60_000 } })],
  }))!;
  assert.equal(low.adjustedEbitda["2024"], NI - 65_000);
  assert.equal(low.sde["2024"], NI + 60_000);

  // A full-salary line with no market figure is left as it is (SDE right, as before).
  const plain = applyAddbackRules({
    metric: "sde", years: ["2024"], netIncome: { "2024": NI },
    addbacks: [ab({ label: "Owner salary (T4)", category: "owner_comp", type: "sde", amounts: { "2024": 180_000 } })],
  })!;
  assert.equal(plain.addbacks.length, 1);
  assert.equal(computeCanonicalEarnings(plain)!.sde["2024"], NI + 180_000);

  // A broker's own owner line is never split.
  const broker = applyAddbackRules({
    metric: "sde", years: ["2024"], netIncome: { "2024": NI },
    addbacks: [ab({ label: "Owner compensation", category: "owner_comp", custom: true, marketSalary: 100_000, ownerActualComp: { "2024": 150_000 }, amounts: { "2024": 150_000 } })],
  })!;
  assert.equal(broker.addbacks.length, 1);
}

// ── Round 2: an aside about the seller's figure doesn't hide the analysis's own wrong figure ──
{
  const n: UiNormalization = {
    metric: "sde", years: ["2024"], netIncome: { "2024": 896_410 },
    addbacks: [ab({ label: "Owner salary (T4 wages)", category: "owner_comp", type: "sde", amounts: { "2024": 180_000 } }), ab({ label: "Depreciation", type: "ebitda", amounts: { "2024": 640_590 } })],
    notes: [
      "2024 SDE = $896,410 + $180,000 + $60,000 + $640,590 = $1,777,000 (rounds to seller's claimed ~$1.8M).",
      "Seller initially claimed $1.8M SDE for 2024.",
      "2024 SDE of $1,800,000 as claimed by the seller.",
    ],
  };
  const checks = flagEarningsNotes(n)!.notes!.filter((x) => x.startsWith("Check:"));
  assert.equal(checks.length, 1, "only the analysis's own worked sum is flagged");
  assert.match(checks[0], /states 2024 SDE as \$1,777,000; the add-backs listed here compute \$1,717,000/);
}

// ── Round 2: Beacon's stored add-backs reproduce the broker-reviewed figures ──
// (adjusted EBITDA $780,052, SDE = adjusted EBITDA + the $140K market salary = $920,052)
{
  const beacon = applyAddbackRules({
    metric: "sde", years: ["2022", "2024"], netIncome: { "2022": 358_236, "2024": 496_728 },
    addbacks: [
      ab({ label: "Management salary to shareholder", category: "owner_comp", type: "sde", amounts: { "2022": 175_000, "2024": 185_000 }, description: "Owner Dr. Helen Park's management salary. SDE adds back the full owner salary; adjusted EBITDA adds back only the excess over a $140,000 market pharmacist-manager salary." }),
      ab({ label: "Shareholder spouse salary (Richard Park)", category: "owner_comp", type: "sde", amounts: { "2022": 40_000, "2024": 42_000 }, description: "Owner's spouse on payroll with minimal bookkeeping function; the role ends at closing." }),
      ab({ label: "Amortization", type: "ebitda", amounts: { "2022": 65_450, "2024": 72_740 } }),
      ab({ label: "Interest expense", type: "ebitda", amounts: { "2022": 15_021, "2024": 11_361 } }),
      ab({ label: "Income taxes", type: "ebitda", amounts: { "2022": 50_618, "2024": 79_423 } }),
      ab({ label: "Personal portion of automobile (75% of travel/auto line)", category: "discretionary", type: "sde", amounts: { "2022": 11_175, "2024": 12_300 } }),
      ab({ label: "Charitable donations", category: "discretionary", type: "sde", amounts: { "2022": 5_000, "2024": 6_000 } }),
      ab({ label: "Pharmacist recruitment fee (2024)", category: "one_time", type: "ebitda", amounts: { "2024": 14_500 } }),
    ],
  })!;
  const c = computeCanonicalEarnings(beacon)!;
  assert.equal(c.adjustedEbitda["2024"], 780_052);
  assert.equal(c.sde["2024"], 920_052);
  assert.equal(c.adjustedEbitda["2022"], 580_500, "the bible's FY2022 adjusted EBITDA");
  assert.equal(c.sde["2022"], 720_500, "the bible's FY2022 SDE");
  // The spouse's pay is not the owner's: it is not split.
  assert.equal(beacon.addbacks.filter((a) => a.ownerCompPart === "market").length, 1);

  // Ridgeline: family pay above market is an EBITDA add-back, never an owner market salary.
  const donna = applyAddbackRules({
    metric: "sde", years: ["2024"], netIncome: { "2024": 896_410 },
    addbacks: [ab({ label: "Donna salary above market bookkeeper rate", category: "owner_comp", type: "sde", amounts: { "2024": 17_000 }, description: "Donna McAllister (owner's spouse) paid $62,000 for part-time bookkeeping in 2024. Market rate for part-time bookkeeper estimated $45,000 per seller. Excess $17,000 is owner-related." })],
  })!;
  assert.equal(donna.addbacks.length, 1);
  assert.equal(donna.addbacks[0].type, "ebitda");
  assert.equal(donna.addbacks[0].amounts["2024"], 17_000);

  // Two working owners: SDE adds back one owner's full pay; the other's market salary is a cost.
  const two = applyAddbackRules({
    metric: "sde", years: ["2024"], netIncome: { "2024": 500_000 },
    addbacks: [
      ab({ label: "Owner salary — Harjit", category: "owner_comp", ownerActualComp: { "2024": 285_000 }, marketSalary: 120_000, amounts: { "2024": 285_000 } }),
      ab({ label: "Owner salary — Aman", category: "owner_comp", ownerActualComp: { "2024": 150_000 }, marketSalary: 110_000, amounts: { "2024": 150_000 } }),
    ],
  })!;
  const tc = computeCanonicalEarnings(two)!;
  assert.equal(tc.adjustedEbitda["2024"], 500_000 + 165_000 + 40_000);
  assert.equal(tc.sde["2024"], tc.adjustedEbitda["2024"] + 120_000, "only the larger market salary is SDE-only");
  assert.ok(two.notes!.some((x) => /one working owner's full pay/.test(x)));
}

console.log("financial-normalization: ok");
