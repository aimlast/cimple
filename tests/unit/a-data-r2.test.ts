// Round A, checker round 2 (a-data): what the first fixes left open or broke.
//  - Private notes: fee terms and the referral source are kept (CLAUDE.md:
//    broker-process info → private notes); "already a fact" needs the same
//    year and the note's own precision; a broker's "needs verification" is
//    never covered by the claim it doubts; no second fact about a matter
//    already on file (dividendHistory beside dividendsDeclared); a key's own
//    words count ("Associated with …" meets associatedCorporations); who the
//    directors are is not a share structure.
//  - Discrepancy filter: the claim's figure for the disputed measure, not its
//    first figure; "does not provide a separate figure" is no reason to drop.
//  - Analysis fact keys: a key naming one word of a longer label is not it.
//  - Analysis notes: a metric in parentheses labels a term, not the chain;
//    "Long-term debt (non-current portion)" is the long-term debt row.
//  - Facts: an older spelling is weighed as a source for its canonical fact
//    (the statements' EBITDA line is the specialist for ebitda); a row that
//    gives two figures for one year is settled by the other rows; a printed
//    "Management salary" line of the statements' expense listing is the
//    owner's salary for that year.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/a-data-r2.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { finalizeNotes } from "../../server/documents/private-notes-review";
import { chatterReason, statesBrokerTerms } from "../../server/documents/private-notes-classify";
import { getPrivateNotes, privateNoteSources, getFieldSources, getFieldAlternates, getFieldCorroborations, sourceRowLookup } from "../../server/interview/info-merger";
import { isHousekeepingNote } from "../../shared/private-notes";
import { dropReason, periodAlignment } from "../../server/cim/discrepancy-filter";
import { falseConflictReason } from "../../server/documents/conflict-measures";
import { analysisFactKey } from "../../server/financial/discrepancy-fact-key";
import { flagEarningsNotes, flagEarningsStatements } from "../../server/financial/normalization-rules";
import { correctBalanceSheetFigures } from "../../server/financial/note-figures";
import { foldAliasedFacts } from "../../server/documents/reprocess";
import { reconcileHeadlines } from "../../server/documents/merge-policy";
import { settleSelfContradictions } from "../../server/documents/self-contradiction";
import { liftPrintedOwnerPay, mergeExtractedData, normaliseExtraction } from "../../server/documents/extractor";

const notesOf = (info: any) => getPrivateNotes(info).map((n) => n.note);
const wordingsOf = (info: any) => getPrivateNotes(info).flatMap((n) => [n.note, ...privateNoteSources(n).map((x) => x.wording ?? "")]);
const docs = new Map<string, any>([
  ["minute", { id: "minute", name: "Minute book extract (articles, by-laws, registers, USA summary with ROFR, resolutions)", visibility: "shared", sourceKind: "document" }],
  ["t2", { id: "t2", name: "T2 corporate tax return 2023 (client copy)", visibility: "shared", sourceKind: "document" }],
  ["email", { id: "email", name: "Email thread — accountant FY2024 package", visibility: "shared", sourceKind: "email" }],
  ["crm", { id: "crm", name: "CRM note — site visit", visibility: "broker_only", sourceKind: "crm" }],
  ["fs24", { id: "fs24", name: "Financial statements FY2024 (review engagement)", visibility: "shared", sourceKind: "document" }],
]);
const withNotes = (facts: Record<string, unknown>, notes: Array<[string, string]>) => ({
  ...facts,
  _brokerPrivateNotes: notes.map(([note, documentId]) => ({ note, documentId, ...(docs.get(documentId)?.visibility === "broker_only" ? { brokerOnly: true } : {}) })),
});
const ctx = { docNames: [], figureOnRecord: () => false, figuresOf: () => [], substantive: () => false };

// 1. The broker's terms and the referral source stay notes — the recorded wordings.
{
  const kept = [
    "Broker engagement terms: success fee, modest work fee, 12-month term",
    "Engagement letter to be sent — success fee, modest work fee, 12-month term",
    "Fee agreement: Success fee per engagement letter (retainer credited)",
    "Referral from Ravi Kaur (accountant, 613-555-0164) - referral and broker engagement terms not business facts",
    "Brassline fee structure: success fee plus modest work fee (12 minutes of call discussion on this - not a business fact)",
    "Heather Kwan thanked for referral in March (from Morgan's May 20 email)",
  ];
  for (const t of kept) {
    assert.ok(statesBrokerTerms(t), `terms: ${t}`);
    assert.equal(chatterReason(t, ctx, isHousekeepingNote), null, `not chatter: ${t}`);
  }
  // Status or a mention of terms with nothing stated is still chatter.
  for (const t of [
    "Engagement letter signed Apr 7, board resolution confirms Brassline Advisory Partners as broker",
    "Morgan Ellis (broker) engagement terms and fee arrangement referenced but not detailed.",
    "Morgan's fee/engagement paper referenced in March 19 message - deal process item.",
  ]) assert.notEqual(chatterReason(t, ctx, isHousekeepingNote), null, `chatter: ${t}`);
  const out = finalizeNotes(withNotes({ companyHistory: "Referral sources: Ravi Kaur (accountant) sends clients" }, kept.map((t) => [t, "email"] as [string, string])), docs);
  for (const t of kept) assert.ok(wordingsOf(out.info).some((n) => n.includes(t.slice(0, 30))), `stays a note: ${t}`);
  console.log("✓ fee terms, retainer, term length and the referral source stay private notes; bare engagement status still goes");
}

// 2. "Already a fact" means the same year and the note's own figure.
{
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ customerNonRenewal: "Larkspur gave 90-day non-renewal notice on its maintenance contract in March 2022; renewed later that year" }, "Larkspur gave 90-day non-renewal notice on its maintenance contract in March 2025"],
    [{ shareholderLoans: "Shareholder loan to Gord McAllister of $250,000 outstanding" }, "Shareholder loan to Gord McAllister of $251,000 outstanding"],
    [{ taxNotes: "Ohio withholding on non-resident shareholder Karen Kline Adair (Arizona) filed on Form IT 1140 for 2022" }, "Karen Kline Adair is a non-resident shareholder residing in Arizona; Ohio withholding on her share of income was filed on Form IT 1140 for 2024."],
  ];
  for (const [facts, note] of cases) {
    const out = finalizeNotes(withNotes(facts, [[note, "crm"]]), docs);
    assert.equal(out.report.covered.length, 0, `not covered: ${note}`);
    assert.ok(notesOf(out.info).includes(note));
  }
  // The same year and figure (at the note's precision) is covered.
  const same = finalizeNotes(withNotes({ shareholderLoans: "Shareholder loan to Gord McAllister of $1,398,000 outstanding at year end" }, [["Shareholder loan to Gord McAllister of $1.4M outstanding", "crm"]]), docs);
  assert.equal(same.report.covered.length, 1);
  console.log("✓ a note about another year or another amount is not 'already a fact'; the same figure at the note's precision is");
}

// 3. The broker's open question is never covered by the claim it questions.
{
  const out = finalizeNotes(withNotes(
    { keyEmployees: "Gord McAllister (owner/president, no employment contract), Devin Pritchard (chief estimator, 13 years, no employment contract or non-compete)" },
    [["No employment contract for key estimator Devin P. - needs verification", "crm"], ["Devin P. (chief estimator) — no employment contract, need to check / needs verification.", "email"]],
  ), docs);
  assert.equal(out.report.covered.length, 0);
  assert.ok(notesOf(out.info).some((n) => /Devin/.test(n)), "the verification to-do stays");
  console.log("✓ 'needs verification' stays a note");
}

// 4. No second fact about a matter already on file (the recorded Ridgeline facts).
{
  const facts = {
    dividends: "$40,000 declared and paid on Class D shares in both 2022 and 2021",
    dividendsPaid: "$60,000",
    dividendsDeclared: "December 16, 2024: non-eligible dividend of $60,000.00 on Class D shares, payable December 20, 2024 to holder of record December 16, 2024; no dividend declared on Class A shares",
    insurancePolicies: "Corporate-owned buy-sell life insurance policies in place (premiums $16,000, non-deductible).",
    unanimousShareholderAgreement: "Dated July 1, 2016; First Amending Agreement dated November 18, 2024; includes right of first refusal, tag-along rights, drag-along (80% threshold), death/disability buyout provisions",
    shareholdersAgreement: "Shareholder agreement acknowledges Luis Ortega's annual bonus arrangement as consideration for Class D structure benefiting Gord McAllister.",
    associatedCorporations: "McAllister Properties Ltd. (BN: 74388 1052 RC0001). Business limit allocation: Ridgeline Metal Fabrication Inc. $500,000, McAllister Properties Ltd. $0.",
  };
  const before = Object.keys(facts);
  const out = finalizeNotes(withNotes(facts, [
    ["Class D dividend of $60,000 declared December 16, 2024 payable only to Gord McAllister (100 Class D shares), no dividend to Class A shareholders", "minute"],
    ["Corporate-owned buy-sell life insurance policies in place (premiums $15,000)", "t2"],
    ["Shareholder agreement amended November 2024: Luis waives first refusal if Gord sells 100% to outside buyer, receives same price per share or can retain shares if buyer agrees, 80% vote forces sale", "minute"],
    ["Associated with McAllister Properties Ltd. (BN 74388 1052 RC0001) — business limit allocation: Ridgeline $500,000, McAllister Properties $0", "t2"],
  ]), docs);
  const added = Object.keys(out.info).filter((k) => !k.startsWith("_") && !before.includes(k));
  assert.deepEqual(added, [], `no duplicate facts written (${added.join(", ")})`);
  assert.deepEqual(out.report.covered.map((c) => c.key), ["associatedCorporations"], "the associated corporation is on file");
  if (process.env.SHOW) console.log(notesOf(out.info));
  for (const re of [/Class D dividend of \$60,000/, /premiums \$15,000/, /amended November 2024/]) assert.ok(wordingsOf(out.info).some((t) => re.test(t)), `${re} stays a note (it says more than the fact)`);
  // A different matter of the same kind still becomes a fact (no dividend of that year on file).
  const other = finalizeNotes(withNotes({ dividends: "$40,000 declared and paid on Class D shares in both 2022 and 2021" },
    [["Class D dividend of $60,000 declared December 16, 2024 payable only to Gord McAllister (100 Class D shares)", "minute"]]), docs);
  assert.deepEqual(other.report.promoted.map((p) => p.key), ["dividendsDeclared"]);
  console.log("✓ a matter on file under any key gets no second fact; 'Associated with …' meets associatedCorporations; a new matter still moves");
}

// 5. Who the directors are is not the share structure; pay "including a director" is neither.
{
  const out = finalizeNotes(withNotes({}, [
    ["Directors who approved statements: Harjit S. Grewal and Manpreet Grewal", "fs24"],
    ["Officers' compensation includes a non-operating director per adjusted EBITDA explanation", "fs24"],
  ]), docs);
  assert.deepEqual(out.report.promoted.map((p) => p.key), ["directors"]);
  assert.equal(out.info.shareStructure, undefined);
  assert.equal(out.info.shareClasses, undefined);
  console.log("✓ directors → directors; 'includes a non-operating director' stays a note");
}

// 6. Discrepancy filter: the disputed measure's figure; generic "does not provide" keeps the row.
{
  const ebitda = { field: "EBITDA (2024)", interviewValue: "2024 revenue of $2.3M and EBITDA around $400K", documentValue: "FY2024: revenue $2,300,000, EBITDA $250,000", severity: "significant" };
  assert.equal(dropReason(ebitda), null, "EBITDA $400K vs $250K is kept (revenue agreeing says nothing)");
  assert.equal(periodAlignment(ebitda.interviewValue, ebitda.documentValue, "Revenue (2024)"), "same", "for a revenue row the revenue figures agree");
  assert.equal(periodAlignment(ebitda.interviewValue, ebitda.documentValue), null, "no measure named: two figures, nothing decided");
  assert.equal(falseConflictReason("ebitdaByYear", { value: ebitda.interviewValue, kind: "call" } as any, { value: ebitda.documentValue, kind: "document" } as any), null);
  const owner = {
    field: "Owner compensation (2024)", interviewValue: "$260,000 owner compensation", documentValue: "Management salaries $180,000", severity: "significant",
    aiExplanation: "The statements do not provide a separate figure for the owner's salary; management salaries total $180,000 against the seller's claimed $260,000",
  };
  assert.equal(dropReason(owner), null, "a 'separate figure' names no measure: the pay dispute stands");
  // The recorded false rows still go.
  assert.equal(dropReason({ field: "Top 3 customer concentration (2022)", interviewValue: "Top 3 customers = 41% of 2024 revenue", documentValue: "FY2022: Top 3 customers 35.0% of revenue (Larkspur 15.5%, Prairie Crest 12.0%, Bowline 7.5%)", severity: "minor" }), "different_periods");
  assert.equal(dropReason({
    field: "110-ton brake replacement cost estimate", severity: "minor",
    interviewValue: "110-ton brake needs replacement in 1-2 years, estimated cost ~$180k",
    documentValue: "110-ton x 10 ft, 2-axis — due for replacement, $96,000 original cost, NBV $29,700, Est. FMV $38,000, Serviceable — replacement within 2 years",
    aiExplanation: "The seller estimates replacement cost for the 110-ton brake at approximately $180,000. The equipment list shows the original cost was $96,000 and current estimated fair market value is $38,000, but does not provide a replacement cost estimate.",
  }), "different_measures");
  console.log("✓ the claim's EBITDA is weighed, not its revenue; 'a separate figure' keeps the owner-pay row; the recorded false rows still drop");
}

// 7. Analysis fact keys: a key naming one word of a longer label is not the label's fact.
{
  const info = {
    totalExpenses: "$7,721,000", shareholdersAgreement: "USA dated 2016, amended 2024", annualRent: "$336,000", backlog: "$3.1M signed (WIP report)",
    ownerSalary: "$180,000", craneRebuild: "$64,000 rebuild of both 10-ton cranes (2024)", vehicleExpensesByYear: { "2024": "$63,000" },
  };
  const f = (field: string, a = "", b = "") => analysisFactKey({ field, sourceA: { value: a }, sourceB: { value: b } }, info);
  for (const label of ["Owner's truck expenses", "Personal expenses through company", "Hockey sponsorship expense", "Legal fees — shareholder agreement", "Rent paid to holdco"]) {
    assert.equal(f(label, "$28,000", "$0"), null, label);
  }
  assert.equal(f("Signed backlog (May 2025)", "$4.2M", "$3.1M")?.factKey, "backlog");
  assert.equal(f("Owner compensation (2024)", "$260,000", "$180,000")?.factKey, "ownerSalary");
  assert.equal(f("Crane rebuild expense", "$64,000", "$64,000")?.factKey, "craneRebuild");
  assert.equal(f("Vehicle expenses 2024", "$63,000", "$35,000")?.factKey, "vehicleExpensesByYear");
  console.log("✓ totalExpenses / shareholdersAgreement / annualRent are no longer guessed; backlog, owner pay, crane rebuild still map");
}

// 8. Analysis notes: the recorded Ridgeline normalization notes and insight are left as written.
{
  const fx = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures/ridgeline-analysis-acc2.json"), "utf8"));
  const n = fx.normalization;
  const modelNotes: string[] = n.notes.filter((x: string) => !/^Check:/.test(x) && !/does not tie/.test(x));
  const out = flagEarningsNotes({ ...n, notes: modelNotes })!;
  assert.deepEqual(out.notes, modelNotes, "no note renamed, no check line: the model's notes were right");
  const one = "2024 Adjusted EBITDA: $1,717,000 (SDE) − $165,000 (market GM salary) = $1,552,000.";
  assert.deepEqual(flagEarningsNotes({ ...n, notes: [one] })!.notes, [one]);
  const ins = { positive: [{ title: "Earnings", detail: "2024 Adjusted EBITDA: $1,717,000 (SDE) less a $165,000 market GM salary gives $1,552,000." }], negative: [] } as any;
  assert.deepEqual(flagEarningsStatements(ins, { ...n, notes: [] }).insights!.positive[0], ins.positive[0]);
  // A real mislabel is still renamed, a wrong figure still checked.
  assert.deepEqual(flagEarningsNotes({ ...n, notes: ["2024 SDE: $1,552,000."] })!.notes, ["2024 adjusted EBITDA: $1,552,000."]);
  assert.equal(flagEarningsNotes({ ...n, notes: ["2024 SDE was $1,650,000."] })!.notes.length, 2);
  // The recorded balance sheet's row is "Long-term debt (non-current portion)".
  const debt = "Debt: Long-term debt of $1,342,000 (Dec 31 2024) is modest (0.8x adjusted EBITDA). The equipment term loan matures November 2027.";
  const fixed = correctBalanceSheetFigures(debt, fx.balanceSheet);
  assert.equal(fixed.text, "Debt: Long-term debt of $624,000 (Dec 31 2024) is modest (0.4x adjusted EBITDA). The equipment term loan matures November 2027.");
  // "Current portion" never reads the non-current row.
  const bs = { years: ["2023", "2024"], rows: [{ id: "a", name: "Long-term debt (non-current portion)", values: { "2023": 1068000, "2024": 624000 } }, { id: "b", name: "Current portion of long-term debt", values: { "2023": 274000, "2024": 286000 } }] } as any;
  assert.equal(correctBalanceSheetFigures("Current portion of $274,000 (2024).", bs).text, "Current portion of $286,000 (2024).");
  assert.equal(correctBalanceSheetFigures("Current portion of $286,000 (2024).", bs).text, "Current portion of $286,000 (2024).");
  console.log("✓ '(SDE)' labels a term, not the chain; the recorded note and insight stay; the non-current row is the long-term debt (ratio redone)");
}

// 9. Facts: the statements' EBITDA line under its old spelling is the specialist for ebitda.
{
  const fs24 = "db627daa", call = "d408ae13";
  const rows = [
    { id: fs24, sourceKind: "document", visibility: "shared", name: "Compiled financial statements FY2024" },
    { id: call, sourceKind: "call", visibility: "shared", name: "Phone call — Morgan Ellis & Gord McAllister (discovery deep-dive)" },
  ];
  const doc = (y: string) => ({ source: "document", documentId: fs24, period: `${y}-12-31`, dated: "2025-03-28", brokerOnly: false, at: "2026-09-26T19:28:22.214Z" });
  const callSrc = { source: "call", documentId: call, period: "2024-12-31", dated: "2025-06-05", brokerOnly: false, at: "2026-09-26T19:28:22.259Z", note: "Stated in the source (not calculated)" };
  const info: any = {
    ebitda: "$1,398,000 (2024, after adjustments per compiled statements)",
    ebitdaByYear: { "2024": "$1,398,000" },
    earningsBeforeInterestAmortizationAndIncomeTaxesByYear: { "2022": "$1,038,000", "2023": "$1,282,000", "2024": "$1,398,000" },
    _fieldSources: {
      ebitda: callSrc,
      ebitdaByYear: { ...callSrc, years: { "2024": callSrc } },
      earningsBeforeInterestAmortizationAndIncomeTaxesByYear: { ...doc("2024"), years: { "2022": doc("2022"), "2023": doc("2023"), "2024": doc("2024") } },
    },
  };
  const lookup = sourceRowLookup(rows);
  foldAliasedFacts(info, { lookup });
  reconcileHeadlines(info, { lookup, conflicts: [] });
  assert.equal(info.ebitda, "$1,398,000", "the headline is the statements' figure, without the call's label");
  assert.equal(getFieldSources(info).ebitda?.documentId, fs24);
  assert.deepEqual(info.ebitdaByYear, { "2022": "$1,038,000", "2023": "$1,282,000", "2024": "$1,398,000" });
  assert.ok((getFieldAlternates(info).ebitda ?? []).some((a) => /after adjustments/.test(a.value)), "the call's wording is kept as another value");
  console.log("✓ the EBITDA headline follows the statements (credited to them), the call's label kept aside");
}

// 10. A row that gave two figures for one year: the other rows decide.
{
  const fy23 = "4193db8d", fy24 = "db627daa";
  const s = (id: string, dated: string) => ({ source: "document", documentId: id, period: "2023-12-31", dated, brokerOnly: false, specialist: true, at: "2026-09-26T19:28:22Z" });
  const base = () => ({
    longTermDebtByYear: { "2023": "$1,058,000", "2024": "$624,000" },
    _fieldSources: { longTermDebtByYear: { ...s(fy24, "2025-03-28"), years: { "2023": s(fy24, "2025-03-28"), "2024": { ...s(fy24, "2025-03-28"), period: "2024-12-31" } } } },
    _fieldAlternates: { "longTermDebtByYear.2023": [{ ...s(fy23, "2024-03-22"), value: "$1,068,000" }, { ...s(fy24, "2025-03-28"), value: "$1,068,000" }] },
  }) as any;
  const info = base();
  assert.deepEqual(settleSelfContradictions(info), ["longTermDebtByYear.2023"]);
  assert.equal(info.longTermDebtByYear["2023"], "$1,068,000");
  assert.equal(getFieldSources(info).longTermDebtByYear?.years?.["2023"]?.documentId, fy24, "the row keeps the credit");
  assert.ok((getFieldAlternates(info)["longTermDebtByYear.2023"] ?? []).some((a) => a.value === "$1,058,000"), "the other figure is kept");
  assert.ok((getFieldCorroborations(info)["longTermDebtByYear.2023"] ?? []).some((c) => c.documentId === fy23), "the FY2023 statements confirm it");
  assert.deepEqual(settleSelfContradictions(info), [], "settled once");
  // Nobody else speaks, or the others are split: nothing is decided.
  const silent = base(); silent._fieldAlternates["longTermDebtByYear.2023"] = [{ ...s(fy24, "2025-03-28"), value: "$1,068,000" }];
  assert.deepEqual(settleSelfContradictions(silent), []);
  const backed = base(); backed._fieldAlternates["longTermDebtByYear.2023"].push({ ...s("other", "2024-06-01"), value: "$1,058,000" });
  assert.deepEqual(settleSelfContradictions(backed), [], "another row states the figure on file");
  console.log("✓ FY2023 long-term debt $1,058,000 → $1,068,000 (both statements say so); silent or split rows decide nothing");
}

// 11. The statements' printed "Management salary" line is the owner's salary for its year.
{
  const listing = "Salaries (office, estimating & project management) $560,000, Management salary $180,000, Rent $336,000, Insurance $94,000";
  assert.deepEqual(liftPrintedOwnerPay({ operatingExpenseBreakdown: listing, periodEnd: "2024-12-31" }).ownerSalaryByYear, { "2024": "$180,000" });
  assert.deepEqual(liftPrintedOwnerPay({ operatingExpensesDetail: "2023: Salaries — office $538,000, Management salary — shareholder $180,000, Rent — related party $322,000" }).ownerSalaryByYear, { "2023": "$180,000" });
  assert.equal(liftPrintedOwnerPay({ operatingExpenseBreakdown: "Management salary $180,000, Management salary — shareholder $150,000", periodEnd: "2024-12-31" }).ownerSalaryByYear, undefined, "two figures: left alone");
  assert.equal(liftPrintedOwnerPay({ ownerSalary: "$200,000", operatingExpenseBreakdown: listing }).ownerSalaryByYear, undefined, "the model's own figure stands");
  assert.equal(liftPrintedOwnerPay({ salariesAndWages: "management salary $180,000 (GIFI 9060)" }).ownerSalaryByYear, undefined, "a tax return's wages are not the statements' listing");
  assert.deepEqual(normaliseExtraction({ operatingExpenseBreakdown: listing, periodEnd: "2024-12-31" }).ownerSalaryByYear, { "2024": "$180,000" });
  const fy22 = { source: "document", documentId: "fs22", period: "2022-12-31", dated: "2023-03-24", brokerOnly: false, at: "2026-09-26T19:28:22Z" };
  const info: any = {
    ownerSalary: "$180,000",
    ownerSalaryByYear: { "2022": "$180,000", "2023": "$180,000" },
    _fieldSources: { ownerSalary: fy22, ownerSalaryByYear: { ...fy22, years: { "2022": fy22, "2023": { ...fy22, documentId: "fs23", period: "2023-12-31" } } } },
  };
  const merged = mergeExtractedData(info, { operatingExpenseBreakdown: listing, periodEnd: "2024-12-31" }, { documentId: "fs24", source: "document", period: "2024-12-31", dated: "2025-03-28", title: "Compiled financial statements FY2024" });
  assert.deepEqual(merged.ownerSalaryByYear, { "2022": "$180,000", "2023": "$180,000", "2024": "$180,000" });
  assert.equal(getFieldSources(merged).ownerSalary?.documentId, "fs24", "the headline is credited to the latest year's statements");
  assert.ok((getFieldCorroborations(merged).ownerSalary ?? []).some((c) => c.documentId === "fs22"), "the FY2022 statements confirm it");
  console.log("✓ ownerSalaryByYear gains 2024 from the FY2024 statements' printed line; the headline is credited to them");
}

console.log("a-data-r2: all passed");
