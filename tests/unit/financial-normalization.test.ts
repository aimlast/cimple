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

console.log("financial-normalization: ok");
