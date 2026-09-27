/**
 * Round F (analysis): the analysis's words tie to its own add-back table,
 * and an owner-pay line that folds in a dividend keeps the salary.
 *
 *  - known-1 (recheck D9): Ridgeline's stored analysis said "2024 Adjusted
 *    EBITDA … = $1,537,000", "2024 SDE … = $1,702,000", "EBITDA grew 76%
 *    from $875,000 in 2021 to $1,537,000" and margins from those figures,
 *    while its add-backs compute $1,552,000 / $1,717,000; the owner-comp
 *    discrepancy said "the correct owner compensation add-back is $180,000"
 *    while the normalization adds back $15,000 (+ the $165,000 market salary
 *    for SDE only).
 *  - F-04: "Owner compensation (T4 salary + T5 dividends)" was dropped
 *    whole as a distribution (SDE understated by the $180,000 salary).
 *
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f-analysis-prose.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  applyAddbackRules,
  clarifyOwnerPayAddbacks,
  computeCanonicalEarnings,
  flagEarningsNotes,
  flagEarningsStatements,
  formatLike,
  isDistributionLine,
  revenueByYear,
  reviseEarningsText,
} from "../../server/financial/normalization-rules";
import { finalizeEarnings, _persistFinancialDiscrepanciesForTests } from "../../server/financial/analyzer";

const fx = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures/ridgeline-analysis-d9.json"), "utf8"));

// ── known-1: the recorded Ridgeline notes are rebuilt / corrected ──
{
  const n = fx.normalization;
  const revenue = revenueByYear(fx.reclassifiedPnl);
  assert.deepEqual(revenue, { "2021": 7_680_000, "2022": 8_420_000, "2023": 9_160_000, "2024": 9_815_000 });
  const c = computeCanonicalEarnings(n)!;
  assert.equal(c.adjustedEbitda["2024"], 1_552_000);
  assert.equal(c.sde["2024"], 1_717_000);
  const out = flagEarningsNotes(n, { revenue })!;
  const notes = out.notes!;
  const all = notes.join("\n");
  // No figure the add-backs don't compute, and no leftover check line.
  assert.ok(!/1,537,000|1,702,000/.test(all), all);
  assert.ok(!notes.some((x) => x.startsWith("Check:")), "stale check lines are worked out again, none left");
  // The worked sums are rebuilt from the add-backs, the $15,000 owner excess included.
  const adj = notes.find((x) => x.startsWith("2024 adjusted EBITDA:"))!;
  assert.ok(adj, all);
  assert.match(adj, /\+ \$15,000 \(Owner compensation \(President — Gord McAllister\) above the market salary\)/);
  assert.match(adj, /= \$1,552,000\.$/);
  assert.equal(notes.find((x) => x.startsWith("2024 SDE:")), "2024 SDE: $1,552,000 (adjusted EBITDA) + $165,000 (Owner compensation (President — Gord McAllister) — market salary) = $1,717,000.");
  // Growth and margins are worked out again from the computed figures.
  assert.ok(notes.includes("Growth trajectory: Adjusted EBITDA has grown from $890,000 in 2021 to $1,552,000 in 2024 (74% growth over 3 years), driven by revenue growth (29% over same period) and improving margins."), all);
  assert.ok(notes.includes("Margin analysis: Adjusted EBITDA margin improved from 11.6% in 2021 to 15.8% in 2024. SDE margin improved from 13.7% in 2021 to 17.5% in 2024."), all);
  // The seller's own figure stays as quoted; the comparison with ours is corrected.
  assert.ok(notes.some((x) => x.includes("Seller's claimed adjusted EBITDA of 'close to 1.8' ($1,800,000)") && x.includes("closer to SDE ($1,717,000) than adjusted EBITDA ($1,552,000)")), all);
  // Idempotent: a second pass (a later broker edit) changes nothing.
  assert.deepEqual(flagEarningsNotes(out, { revenue })!.notes, notes);
  console.log("✓ known-1: Ridgeline's notes tie to the add-back table ($1,552,000 / $1,717,000), growth 74%, margins 15.8% / 17.5%");
}

// ── known-1: the recorded insight is corrected in place (flag cleared) ──
{
  const revenue = revenueByYear(fx.reclassifiedPnl);
  const { insights, mismatches } = flagEarningsStatements(fx.insights, fx.normalization, { revenue });
  const i = insights!.positive[0] as any;
  assert.equal(i.flag, undefined);
  assert.equal(
    i.detail,
    "Adjusted EBITDA grew 74% from $890,000 in 2021 to $1,552,000 in 2024. Adjusted EBITDA margin improved from 11.6% to 15.8%. SDE margin improved from 13.7% to 17.5%. Gross margin stable at 28.7%-30.0%.",
  );
  assert.ok(mismatches.every((m) => m.corrected));
  console.log("✓ known-1: 'EBITDA grew 76% … $1,537,000' → 'Adjusted EBITDA grew 74% … $1,552,000'; margins recomputed");
}

// ── known-1: the owner-pay add-back is stated the way the analysis counts it ──
{
  const n = fx.normalization;
  const d = fx.ownerCompDiscrepancy;
  const sugg = clarifyOwnerPayAddbacks(d.suggestedResolution, n);
  assert.match(sugg, /The correct owner compensation add-back is \$180,000 \(T4 salary; for SDE — adjusted EBITDA adds back only the \$15,000 above a \$165,000 market salary\)\./);
  assert.match(sugg, /use \$180,000 \(for SDE — adjusted EBITDA adds back only the \$15,000 above a \$165,000 market salary\) as the owner compensation add-back/);
  const expl = clarifyOwnerPayAddbacks(d.explanation, n);
  assert.match(expl, /Only the salary \(\$180,000; for SDE — adjusted EBITDA adds back only the \$15,000 above a \$165,000 market salary\) is an add-back/);
  // Idempotent, and a sentence that already names the split or is arithmetic is left alone.
  assert.equal(clarifyOwnerPayAddbacks(sugg, n), sugg);
  const sum = "It appears to include salary ($180,000) + dividends ($60,000) = $240,000, which is not an add-back.";
  assert.equal(clarifyOwnerPayAddbacks(sum, n), sum);
  const split = "The owner's $180,000 is only partially an add-back to adjusted EBITDA ($15,000 above market).";
  assert.equal(clarifyOwnerPayAddbacks(split, n), split);
  // No owner-pay split in the normalization: nothing to say.
  assert.equal(clarifyOwnerPayAddbacks(d.suggestedResolution, { ...n, addbacks: [] }), d.suggestedResolution);
  console.log("✓ known-1: 'the correct owner compensation add-back is $180,000' gains the SDE / adjusted EBITDA split");
}

// ── known-1: through the persistence step (the discrepancy row the broker reads) ──
{
  (async () => {
    const rows: any[] = [];
    const store: any = {
      async updateDiscrepancy(id: string, p: any) { Object.assign(rows.find((r) => r.id === id), p); return rows.find((r) => r.id === id); },
      async createDiscrepancy(row: any) { const r = { id: `N${rows.length}`, createdAt: new Date(), ...row }; rows.push(r); return r; },
    };
    const d = fx.ownerCompDiscrepancy;
    await _persistFinancialDiscrepanciesForTests(
      "D", store,
      [{ field: d.field, factKey: d.factKey, factYear: "2024", sourceA: { source: "Seller's add-back list", value: "$260,000 total owner compensation" }, sourceB: { source: "T2 2024", value: "$180,000 T4 salary" }, severity: "critical", category: "financial", explanation: d.explanation, suggestedResolution: d.suggestedResolution } as any],
      [], {}, [], {}, undefined, { ownerSalary: "$180,000" }, fx.normalization,
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].suggestedResolution, /\$180,000 \(T4 salary; for SDE — adjusted EBITDA adds back only the \$15,000 above a \$165,000 market salary\)/);
    console.log("✓ known-1: the stored owner-comp row's suggestion states the split");
  })().catch((e) => { console.error(e); process.exit(1); });
}

// ── known-1: finalizeEarnings reports what it corrected ──
{
  const out = finalizeEarnings({
    reclassifiedPnl: fx.reclassifiedPnl, reclassifiedBalanceSheet: null, reclassifiedCashFlow: null,
    normalization: fx.normalization, workingCapital: null, insights: fx.insights, clarifyingQuestions: null,
    discrepancies: [], clearedDiscrepancyIds: [], aiReasoning: "(5) The correct add-back is $180,000 (T4 salary only).",
  });
  assert.match(out.aiReasoning, /Figures corrected in code: Insight "Improving profitability and margins" stated 2021 adjusted EBITDA 875,000; computed 890,000; Insight "Improving profitability and margins" stated 2024 adjusted EBITDA 1,537,000; computed 1,552,000\./);
  assert.match(out.aiReasoning, /\$180,000 \(T4 salary only; for SDE — adjusted EBITDA adds back only the \$15,000/);
  assert.ok((out.normalization!.notes ?? []).some((x) => /only the salary \(\$180,000; for SDE/.test(x)));
  console.log("✓ known-1: finalizeEarnings corrects, clarifies and says what it corrected");
}

// ── Guards: what is never rewritten ──
{
  const computed = { reportedEbitda: { "2023": 800_000, "2024": 900_000 }, adjustedEbitda: { "2023": 1_000_000, "2024": 1_100_000 }, sde: { "2023": 1_200_000, "2024": 1_300_000 }, latestYear: "2024" };
  const same = (t: string) => assert.equal(reviseEarningsText(t, computed).text, t, t);
  same("Seller initially claimed $1.8M SDE for 2024.");
  same("The seller states SDE is $1,500,000.");
  same("2024 SDE of $1,800,000 as claimed by the seller.");
  same("2025 SDE is forecast at $1,500,000."); // a year the analysis doesn't cover
  same("2024 adjusted EBITDA of $1,100,000 and SDE of $1,300,000.");
  same("Revenue grew 12% to $9,815,000.");
  // A figure with its own format, corrected in that format.
  assert.equal(formatLike("$1.54M", 1_552_000), "$1.55M");
  assert.equal(formatLike("$1,537,000", 1_552_000), "$1,552,000");
  assert.equal(formatLike("$890K", 875_000), "$875K");
  assert.equal(reviseEarningsText("2024 adjusted EBITDA reached $1.2M.", computed).text, "2024 adjusted EBITDA reached $1.1M.");
  // Unqualified EBITDA that is the reported figure is left alone.
  same("2024 EBITDA of $900,000.");
  // A multiple of a corrected figure is worked out again from the price in the text.
  assert.equal(
    reviseEarningsText("Asking price $6,500,000. At 2024 adjusted EBITDA of $1,250,000, this is 5.2x.", computed).text,
    "Asking price $6,500,000. At 2024 adjusted EBITDA of $1,100,000, this is 5.9x.",
  );
  same("Asking price $6,500,000. At 2024 adjusted EBITDA of $1,100,000, this is 5.9x.");
  console.log("✓ attributed, forecast and correct figures are never rewritten; corrections keep the text's format");
}

// ── F-04: owner pay with a dividend in its label keeps the salary ──
{
  const n: any = {
    metric: "sde", years: ["2024"], netIncome: { "2024": 500_000 },
    addbacks: [{ id: "a1", label: "Owner compensation (T4 salary + T5 dividends)", description: "Gord's T4 salary $180,000 plus T5 dividends $60,000", category: "owner_comp", amounts: { "2024": 240_000 }, approved: true, marketSalary: 125_000 }],
  };
  // Before: isDistributionLine(label) → the whole $240,000 line unapproved, SDE = $500,000.
  assert.equal(isDistributionLine(n.addbacks[0]), false, "a pay line is not a distribution");
  const out = applyAddbackRules(n)!;
  const c = computeCanonicalEarnings(out)!;
  assert.equal(c.sde["2024"], 680_000, "SDE adds back the full $180,000 salary, not the $60,000 dividend");
  assert.equal(c.adjustedEbitda["2024"], 555_000, "adjusted EBITDA adds back the $55,000 above market");
  assert.ok(out.addbacks.every((a: any) => a.approved));
  assert.equal(out.addbacks[0].label, "Owner compensation (T4 salary)");
  assert.ok(out.notes!.some((x) => /included a \$60,000 dividend/.test(x)));
  // A pure distribution line is still not an add-back.
  const div = applyAddbackRules({ ...n, addbacks: [{ id: "d", label: "Dividends paid (Class D)", category: "other", amounts: { "2024": 60_000 }, approved: true }] })!;
  assert.equal(div.addbacks[0].approved, false);
  console.log("✓ F-04: 'Owner compensation (T4 salary + T5 dividends)' → SDE $680,000 / adjusted EBITDA $555,000 (was $500,000 / $500,000)");
}

console.log("f-analysis-prose: all passed");
