/**
 * Round F-2 (analysis): the round-1 fixes went too far or not far enough.
 *
 *  1–4 (known-1): prose was rewritten wherever a figure could be placed —
 *    a workbook's weighted SDE, counterfactuals, industry benchmarks, a
 *    three-year average, and whole sentences replaced by a bridge. Now only
 *    what the text pins down (metric + year, a small misstatement; a
 *    sentence that is only a worked sum; the same misstatement repeated) is
 *    corrected; everything else keeps its words and, if it doesn't tie, a check.
 *  5 (known-2): a malformed analysis object returned a piece of itself.
 *  6 (F-01): a dated source label ("Seller call (September 2025)") became
 *    the fiscal year a resolution wrote.
 *  7 (F-04): any pay word exempted a dividend line from being a distribution.
 *  8 (F-07): a stale reviewed analysis blocked the CIM after the re-run.
 *  9: the owner-pay split text reached the seller interview.
 *  10 (F-05): statements in thousands / glued PDF text withheld a real year.
 *  11: object facts treated as by-year maps; deleted non-financial sources
 *    made the analysis "out of date"; DD refresh on a stale analysis 500'd.
 *
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f-analysis-r2.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  applyAddbackRules,
  clarifyOwnerPayAddbacks,
  computeCanonicalEarnings,
  earningsCorrections,
  flagEarningsNotes,
  flagEarningsStatements,
  isDistributionLine,
  revenueByYear,
  reviseEarningsText,
  type CanonicalEarnings,
} from "../../server/financial/normalization-rules";
import { parseJsonLoose } from "../../server/financial/shape";
import { isAnalysisObject, finalizeEarnings } from "../../server/financial/analyzer";
import { yearForMapResolution, planResolution, isYearMap } from "../../server/information/resolution-write";
import { applyResolutionToInfo, editFact } from "../../server/information/facts";
import { settleResolvedFacts, resolvedNotes } from "../../server/cim/resolved-block";
import { cimFinancialsFor, StaleFinancialAnalysisError } from "../../server/cim/cim-financials";
import { analysisSourceStatus } from "../../server/financial/source-status";
import { buildFigureIndex, markPrivateStatements } from "../../server/financial/private-figures";
import { sellerSafeGuidance } from "../../server/interview/knowledge-base";

const fx = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures/ridgeline-analysis-d9.json"), "utf8"));
const ridge = computeCanonicalEarnings(fx.normalization)!;
const ridgeCtx = { normalization: fx.normalization, revenue: revenueByYear(fx.reclassifiedPnl) };
const same = (t: string, c: CanonicalEarnings = ridge, ctx: any = ridgeCtx) => assert.equal(reviseEarningsText(t, c, ctx).text, t, t);

// ── 1. Prose the text doesn't pin down keeps its words (prod replay cases) ──
{
  const sk: CanonicalEarnings = { reportedEbitda: { "2024": 150_000, "2025": 190_000 }, adjustedEbitda: { "2024": 170_000, "2025": 207_832 }, sde: { "2024": 209_139, "2025": 239_062 }, latestYear: "2025" };
  // SariKnotSari v4: the workbook's weighted SDE is quoted, not the analysis's figure.
  same("Weighted SDE per workbook methodology: 2024 SDE $208,032 × 30% + 2025 SDE $216,018 × 70% = $213,622 weighted average.", sk, {});
  assert.equal(reviseEarningsText("Weighted SDE per workbook methodology: 2024 SDE $208,032 × 30% + 2025 SDE $216,018 × 70% = $213,622 weighted average.", sk).found.length, 0);
  // f572fe0b: a market salary after a minus is not SDE; the sentence is an assumption.
  same("EBITDA calculation assumes replacement GM at $80K (mid-point of market range), so EBITDA = SDE - $80K for 2024", sk, {});
  // a759e5a7 v1: 25% off is another basis — the words stay (with the CAGR), a check is left.
  const far = reviseEarningsText("2025 SDE of $216K represents 3-year CAGR of 31% from 2022", { ...sk, sde: { "2024": 209_139, "2025": 269_520 } });
  assert.equal(far.text, "2025 SDE of $216K represents 3-year CAGR of 31% from 2022");
  assert.equal(far.found[0].corrected, false);
  // c901abec: a margin with no figure corrected beside it is never rewritten.
  const c9: CanonicalEarnings = { reportedEbitda: { "2024": 300_000 }, adjustedEbitda: { "2024": 290_200 }, sde: { "2024": 470_200 }, latestYear: "2024" };
  same("SDE margin of 14.9% is within normal range for small construction contractors (typically 12-18%)", c9, { revenue: { "2024": 3_200_000 } });
  const c9i = flagEarningsStatements({ positive: [{ id: "p", type: "positive", title: "Profitable Operations", detail: "Business generates $215K net income plus $180K owner salary. SDE of $476K on $3.2M revenue (14.9% margin) provides good returns." }], negative: [] } as any, { metric: "sde", years: ["2024"], netIncome: { "2024": 215_000 }, addbacks: [{ id: "o", label: "Owner salary", type: "sde", amounts: { "2024": 180_000 }, approved: true }, { id: "d", label: "Depreciation", amounts: { "2024": 75_200 }, approved: true }] } as any, { revenue: { "2024": 3_200_000 } });
  assert.match(c9i.insights!.positive[0].detail, /SDE of \$476K on \$3\.2M revenue \(14\.9% margin\)/, "no year: the figure and its margin stay together");
  assert.match(c9i.insights!.positive[0].detail, /\(Check: \$476,000 matches no year's SDE \(nearest: 2024, \$470,200\)\.\)$/);
  // Pacific: margins "per confirmed facts" are quoted from the facts, not the table.
  const pac: CanonicalEarnings = { reportedEbitda: { "2022": 3_500_000, "2023": 3_300_000, "2024": 3_600_000 }, adjustedEbitda: { "2022": 3_520_000, "2023": 3_070_000, "2024": 3_600_000 }, sde: { "2022": 3_700_000, "2023": 3_300_000, "2024": 3_800_000 }, latestYear: "2024" };
  same("EBITDA margin trend (per confirmed facts): 13.2% (2022) → 11.3% (2023) → 12.6% (2024).", pac, { revenue: { "2022": 28_600_000, "2023": 28_700_000, "2024": 31_000_000 } });
  same("EBITDA margin recovered from 11.3% (2023) to 12.6% (2024) after a dip.", pac, { revenue: { "2022": 28_600_000, "2023": 28_700_000, "2024": 31_000_000 } });
  console.log("✓ 1: workbook weighting, assumptions, far-off figures, unpinned margins and quoted margins keep their words");
}

// ── 2. Benchmarks are never rewritten ──
{
  same("SDE margin of 17.5% in 2024, above the 16% industry norm.");
  same("Adjusted EBITDA margin of 15.8% in 2024 compares with an industry average of 14.5%.");
  same("EBITDA margin rose to 16% in 2024 (industry 15%).");
  same("Construction industry typical SDE margins: 10-15% for contractors of this size");
  // The margin itself, pinned to its year and a little off, is corrected; the benchmark beside it isn't.
  assert.equal(
    reviseEarningsText("SDE margin of 17.3% in 2024, compared with 16% for peers.", ridge, ridgeCtx).text,
    "SDE margin of 17.5% in 2024, compared with 16% for peers.",
  );
  console.log("✓ 2: industry averages, norms and ranges are never touched");
}

// ── 3. Counterfactuals, run-rates and averages are never rewritten or questioned ──
{
  for (const t of [
    "A buyer using a $120,000 manager salary would see 2024 adjusted EBITDA of $1,597,000.",
    "If the $17,000 Donna excess is not accepted, 2024 adjusted EBITDA would be $1,535,000.",
    "Excluding the crane rebuild, 2024 adjusted EBITDA would have been $1,488,000.",
    "Run-rate adjusted EBITDA of $1,600,000 reflects the new Suncor contract.",
    "Three-year average adjusted EBITDA is $1,300,000.",
    "Pro forma adjusted EBITDA after the rent reset would be about $1,500,000.",
  ]) {
    same(t);
    assert.equal(reviseEarningsText(t, ridge, ridgeCtx).found.length, 0, t);
  }
  // A bare figure is never pinned to the year it happens to be near…
  const n = flagEarningsNotes({ ...fx.normalization, notes: ["Adjusted EBITDA of $1,540,000 is strong for the sector."] }, { revenue: ridgeCtx.revenue })!;
  assert.equal(n.notes![0], "Adjusted EBITDA of $1,540,000 is strong for the sector.");
  // …only the same misstatement, corrected on explicit evidence elsewhere, follows it.
  const prop = flagEarningsNotes({ ...fx.normalization, notes: ["2024 adjusted EBITDA was $1,537,000.", "Adjusted EBITDA of $1,537,000 is strong for the sector."] }, { revenue: ridgeCtx.revenue })!;
  assert.deepEqual(prop.notes, ["2024 adjusted EBITDA was $1,552,000.", "Adjusted EBITDA of $1,552,000 is strong for the sector."]);
  console.log("✓ 3: 'would', 'if', 'excluding', run-rate, average, pro forma keep their figures; a bare figure follows only a correction made on evidence");
}

// ── 4. A worked sum that says more keeps its words ──
{
  const t = "2024 Adjusted EBITDA: $896,410 + $312,000 + $58,000 + $131,590 + $64,000 + $18,000 + $12,000 + $28,000 + $17,000 = $1,537,000, which is 4.2x on the $6,500,000 asking price.";
  const r = reviseEarningsText(t, ridge, ridgeCtx);
  assert.equal(r.text, t, "the asking-price multiple is not lost");
  assert.equal(r.found[0].corrected, false);
  const notes = flagEarningsNotes({ ...fx.normalization, notes: [t] })!.notes!;
  assert.equal(notes[0], t);
  assert.match(notes[1], /^Check: the note above states 2024 adjusted EBITDA as \$1,537,000; the add-backs listed here compute \$1,552,000\.$/);
  // Lakeshore: an alternative definition, with its own years, is left as the model wrote it.
  const lake = "Adjusted EBITDA (normalizing only owner comp, not one-time items): FY2024 $917K + $130K + $85K + $28K + $9K + $11K = $1,180K; FY2023 $1,076K; FY2022 $882K.";
  const lc: CanonicalEarnings = { reportedEbitda: { "2024": 988_000 }, adjustedEbitda: { "2024": 1_010_000 }, sde: { "2024": 1_140_000 }, latestYear: "2024" };
  assert.equal(reviseEarningsText(lake, lc, { normalization: { metric: "sde", years: ["2024"], netIncome: { "2024": 563_190 }, addbacks: [] } as any }).text, lake);
  // A sentence that is only the sum is rebuilt (nothing lost).
  const only = flagEarningsNotes({ ...fx.normalization, notes: ["2024 Adjusted EBITDA: $896,410 + $312,000 + $58,000 + $131,590 + $64,000 + $18,000 + $12,000 + $28,000 + $17,000 = $1,537,000."] })!.notes!;
  assert.match(only[0], /^2024 adjusted EBITDA: \$896,410 \(net income\) .* = \$1,552,000\.$/);
  console.log("✓ 4: a sum carrying a multiple or other years keeps its words (+ check); a bare sum is rebuilt");
}

// ── 1–4 end to end: finalizeEarnings over Ridgeline still ties, idempotently ──
{
  const out = finalizeEarnings({
    reclassifiedPnl: fx.reclassifiedPnl, reclassifiedBalanceSheet: null, reclassifiedCashFlow: null,
    normalization: fx.normalization, workingCapital: null, insights: fx.insights, clarifyingQuestions: null,
    discrepancies: [], clearedDiscrepancyIds: [], aiReasoning: "",
  });
  const all = [...out.normalization!.notes!, ...out.insights.positive.map((i: any) => i.detail)].join("\n");
  assert.ok(!/1,537,000|1,702,000|\$875,000/.test(all), all);
  assert.ok(!/^Check:/m.test(all));
  const again = finalizeEarnings({ ...out, discrepancies: [], clearedDiscrepancyIds: [], aiReasoning: "" });
  assert.deepEqual(again.normalization!.notes, out.normalization!.notes);
  assert.deepEqual(earningsCorrections(out.normalization, out.insights, { revenue: ridgeCtx.revenue }), []);
  console.log("✓ 1–4: Ridgeline's notes and insights still tie ($1,552,000 / $1,717,000) and a second pass changes nothing");
}

// ── 5. A malformed analysis is an error, never a piece of itself ──
{
  const big = `{"reclassifiedPnl": {"years":["2024"],"rows":[{"name":"Revenue","category":"Revenue","values":{"2024":100}}]}, "normalization": {"metric":"sde","addbacks":[{"label":"x","amounts":{"2024":1}},]}, "insights": {"positive":[],"negative":[]}}`;
  assert.throws(() => parseJsonLoose(big, isAnalysisObject), /Malformed JSON/);
  assert.throws(() => parseJsonLoose(big), /Malformed JSON/, "not even without a validator");
  const quote = `{"reclassifiedPnl": {"years":["2024"],"rows":[]}, "aiReasoning": "the "seller" said", "normalization": {"metric":"sde","addbacks":[]}}`;
  assert.throws(() => parseJsonLoose(quote, isAnalysisObject), /Malformed JSON/);
  // A well-formed analysis after prose is read; an inner piece alone is not an analysis.
  assert.deepEqual(Object.keys(parseJsonLoose(`Here you go:\n{"reclassifiedPnl": null, "normalization": {"metric":"sde"}, "insights": null}`, isAnalysisObject)), ["reclassifiedPnl", "normalization", "insights"]);
  assert.equal(isAnalysisObject({ years: ["2024"], rows: [] }), false);
  // An example in the preface is not the answer: the last value wins.
  const statement = (x: unknown) => Array.isArray(x) || (!!x && typeof x === "object" && Array.isArray((x as any).lineItems));
  assert.deepEqual(parseJsonLoose(`For example {"statementType":"income_statement","lineItems":[{"name":"Revenue","values":{"2024":123}}]} — but this document has none: []`, statement), []);
  // Prose in brackets is read through.
  assert.deepEqual(parseJsonLoose(`[Note: the answer is {"a": 1}]`), { a: 1 });
  console.log("✓ 5: a trailing comma or stray quote fails the analysis loudly; an example never beats the answer");
}

// ── 6. A dated source is not the figure's fiscal year ──
{
  const REV = () => ({ revenueByYear: { "2022": "$8,400,000", "2023": "$9,160,000", "2024": "$9,815,000" } } as any);
  const row: any = { field: "Annual revenue", factKey: "revenueByYear", factYear: null, source: "interview", interviewValue: "$10.4M — Seller call (September 2025)", documentValue: "$9,815,000 — Compiled financial statements", documentId: null, resolvedValue: "$9,815,000" };
  assert.equal(yearForMapResolution(row), null);
  const info = REV();
  assert.equal(planResolution(REV(), { key: "revenueByYear" }, row).kind, "needs_mapping", "the broker picks the year");
  applyResolutionToInfo(info, row);
  assert.deepEqual(info.revenueByYear, REV().revenueByYear, "no phantom FY2025");
  const settled = settleResolvedFacts(REV(), resolvedNotes([{ ...row, id: "r", dealId: "d", status: "resolved", resolvedAt: new Date(), createdAt: new Date(), severity: "critical" }]));
  assert.deepEqual(settled.facts.revenueByYear, REV().revenueByYear, "the CIM overlay shows no FY2025 either");
  assert.equal(yearForMapResolution({ field: "Revenue", interviewValue: "$10.4M, growing every year since 2019", documentValue: "$9,815,000" }), null);
  // A fiscal-year tag still places it; only years the fact has.
  assert.equal(yearForMapResolution({ field: "Revenue", interviewValue: "$10.4M — seller", documentValue: "$9,815,000 — Financial statements FY2024" }, ["2022", "2023", "2024"]), "2024");
  assert.equal(yearForMapResolution({ field: "Revenue", interviewValue: "$10.4M", documentValue: "$9,815,000 (FY24)" }), "2024");
  assert.equal(yearForMapResolution({ field: "Revenue", interviewValue: "$10.4M", documentValue: "$9,815,000 — FY2021" }, ["2022", "2023", "2024"]), null);
  assert.equal(planResolution(REV(), { key: "revenueByYear" }, { ...row, interviewValue: "$10.4M — seller", documentValue: "$9,815,000 — FY2024 statements" }, { brokerChoseFact: true }).kind, "write");
  console.log("✓ 6: 'Seller call (September 2025)' and 'since 2019' never pick the year; 'FY2024' / 'FY24' do");
}

// ── 7. Dividends are distributions, whatever pay word the label carries ──
{
  const run = (ab: any) => {
    const n: any = { metric: "sde", years: ["2024"], netIncome: { "2024": 500_000 }, addbacks: [ab] };
    const out = applyAddbackRules(n)!;
    return { out, c: computeCanonicalEarnings(out)! };
  };
  for (const ab of [
    { id: "d1", label: "Dividends in lieu of salary", description: "Owner took $150,000 of dividends instead of a salary", category: "other", amounts: { "2024": 150_000 }, approved: true },
    { id: "d2", label: "Owner dividends paid in lieu of salary", description: "Owner was paid $150,000 as dividends instead of a salary", category: "owner_comp", amounts: { "2024": 150_000 }, approved: true, marketSalary: 125_000 },
    { id: "d3", label: "Shareholder dividend (bonus)", description: "$90,000", category: "other", amounts: { "2024": 90_000 }, approved: true },
    { id: "d4", label: "Salary paid as dividends", description: "$120,000", category: "owner_comp", amounts: { "2024": 120_000 }, approved: true },
  ]) {
    assert.equal(isDistributionLine(ab), true, ab.label);
    const { c } = run(ab);
    assert.equal(c.sde["2024"], 500_000, ab.label);
    assert.equal(c.adjustedEbitda["2024"], 500_000, ab.label);
  }
  // Pay with a dividend part but no figures: nothing added back, the broker is asked for the salary.
  const vague = run({ id: "a1", label: "Owner compensation (T4 salary + T5 dividends)", description: "Gord's salary plus his dividends", category: "owner_comp", amounts: { "2024": 240_000 }, approved: true, marketSalary: 125_000 });
  assert.equal(vague.c.sde["2024"], 500_000);
  assert.ok(vague.out.notes!.some((x) => /doesn't say how much of it is salary.*Add the owner's salary as its own add-back/.test(x)));
  // With the figures: the dividend is carved out, the salary kept (round F).
  const clear = run({ id: "a2", label: "Owner's salary and dividends", description: "salary $180,000; dividends $60,000", category: "owner_comp", amounts: { "2024": 240_000 }, approved: true, marketSalary: 125_000 });
  assert.equal(clear.c.sde["2024"], 680_000);
  assert.equal(clear.c.adjustedEbitda["2024"], 555_000);
  console.log("✓ 7: 'Dividends in lieu of salary', 'Shareholder dividend (bonus)', 'Salary paid as dividends' are distributions; a pay line keeps only a stated salary");
}

// ── 8. A stale reviewed analysis gives way to the newer re-run ──
{
  const pnl = { years: ["2024"], rows: [{ id: "r", name: "Sales", category: "Revenue", values: { "2024": 1_000_000 } }, { id: "c", name: "COGS", category: "COGS", values: { "2024": 600_000 } }] };
  const norm = { metric: "sde", years: ["2024"], netIncome: { "2024": 400_000 }, addbacks: [] };
  const docs = [{ id: "B", name: "2024 P&L (correct).pdf", category: "financials", isProcessed: true, extractedText: "x" }];
  const v1: any = { id: "1", version: 1, status: "reviewed", brokerReviewedAt: new Date(), reclassifiedPnl: pnl, normalization: norm, sourceDocumentIds: [{ id: "A", name: "2024 P&L (wrong client).pdf", role: "statements" }] };
  const v2: any = { id: "2", version: 2, status: "completed", brokerReviewedAt: null, reclassifiedPnl: pnl, normalization: norm, sourceDocumentIds: [{ id: "B", name: "2024 P&L (correct).pdf", role: "statements" }] };
  const fin = cimFinancialsFor([v1, v2], docs as any)!;
  assert.equal(fin.version, 2);
  assert.match(fin.sourceWarnings![0], /reviewed financial analysis \(v1\).*uses the newer run \(v2\), which hasn't been reviewed yet/);
  // No re-run yet: still stopped, with the reason.
  assert.throws(() => cimFinancialsFor([v1], docs as any), StaleFinancialAnalysisError);
  console.log("✓ 8: v1 reviewed but built from a deleted P&L → the CIM uses the re-run v2 (with a review warning), not a dead end");
}

// ── 9. The owner-pay split never reaches the seller interview ──
{
  const d = fx.ownerCompDiscrepancy;
  const expl = sellerSafeGuidance(clarifyOwnerPayAddbacks(d.explanation, fx.normalization));
  const sugg = sellerSafeGuidance(clarifyOwnerPayAddbacks(d.suggestedResolution, fx.normalization));
  for (const t of [expl, sugg]) {
    if (t === null) continue;
    assert.ok(!/add-?backs?|added back|\bSDE\b|EBITDA|market salary|\$165,000|\$15,000/i.test(t), t);
  }
  assert.ok(expl && /T2 tax return and compiled financial statements show only \$180,000 in management salary/.test(expl), expl ?? "");
  assert.equal(sugg, null, "the suggestion is all broker working");
  assert.equal(sellerSafeGuidance("The statements show $9.8M; the seller said $10.4M. Ask which is right."), "The statements show $9.8M; the seller said $10.4M. Ask which is right.");
  console.log("✓ 9: the interview gets the documents' facts, never 'adjusted EBITDA adds back only the $15,000 above a $165,000 market salary'");
}

// ── 10. Statements printed another way never withhold a real year ──
{
  const table = { years: ["2024"], rows: [{ id: "r", name: "Sales", category: "Revenue", values: { "2024": 9_815_000 } }, { id: "t", name: "Income taxes", category: "Taxes", values: { "2024": -12_000 } }] };
  const crm = ["CRM: 2024 sales 9,815,000 and a tax recovery of 12,000"];
  for (const shared of ["(in thousands of dollars) Sales 9,815 Income taxes (12)", "Sales $9.815M", "Sales9,160,0009,815,000 Net income700,000896,410"]) {
    const m = markPrivateStatements({ reclassifiedPnl: table, reclassifiedBalanceSheet: null, normalization: { metric: "sde", years: ["2024"], netIncome: { "2024": 896_410 }, addbacks: [] }, workingCapital: null } as any, buildFigureIndex([shared], [...crm, "net income 896,410"]), null);
    assert.equal(m.reclassifiedPnl!.privateYears, undefined, shared);
  }
  // A column only the broker's interim P&L states is still held (round F).
  const interim = markPrivateStatements(
    { reclassifiedPnl: { years: ["2024", "2025"], rows: [{ id: "r", name: "Sales", category: "Revenue", values: { "2024": 9_815_000, "2025": 11_240_000 } }] }, reclassifiedBalanceSheet: null, normalization: null, workingCapital: null } as any,
    buildFigureIndex(["Sales 9,815"], ["Interim P&L 2025: sales 11,240,000"]),
    null,
  );
  assert.deepEqual(interim.reclassifiedPnl!.privateYears, ["2025"]);
  console.log("✓ 10: '(in thousands)', '$9.815M' and glued PDF digits support the real year; a private interim column is still held");
}

// ── 11. Minor ──
{
  // An object fact that isn't a list by year can be edited as text.
  assert.equal(isYearMap({ top1: "22%", top5: "61%" }), false);
  assert.equal(isYearMap({ "2023": 1, FY2024: 2 }), true);
  const info: any = { customerConcentration: { top1: "22%", top5: "61%" }, revenueByYear: { "2024": "$9,815,000" } };
  editFact(info, "customerConcentration", "Top customer is 22% of revenue, top five 61%.");
  assert.equal(info.customerConcentration, "Top customer is 22% of revenue, top five 61%.");
  assert.throws(() => editFact(info, "revenueByYear", "$9,900,000"), /list of values by year/);
  // Deleting a photo or a transcript doesn't make the analysis out of date.
  const docs = [{ id: "fs", name: "FY2024 statements.pdf", category: "financials", isProcessed: true, extractedText: "x" }];
  const a: any = { sourceDocumentIds: [{ id: "fs", role: "statements" }, { id: "photo", name: "Shop floor.jpg", role: "other" }, { id: "crm", name: "CRM note", role: "private" }] };
  assert.equal(analysisSourceStatus(a, docs as any).message, null);
  // The stale-analysis stop says why (the DD refresh route answers 409 with this).
  try {
    cimFinancialsFor([{ id: "1", version: 1, status: "reviewed", sourceDocumentIds: [{ id: "gone", name: "P&L.pdf", role: "statements" }] } as any], docs as any);
    assert.fail("should stop");
  } catch (e: any) {
    assert.ok(e instanceof StaleFinancialAnalysisError);
    assert.match(e.message, /“P&L\.pdf”/);
  }
  console.log("✓ 11: object facts edit as text; only financial sources make the analysis stale; the stale stop names the document");
}

console.log("f-analysis-r2: all passed");
