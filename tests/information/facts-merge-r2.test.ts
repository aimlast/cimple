// Fact accuracy core, round 2 (QA-harvest stream facts1) — offline checks, no database, no AI.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/information/facts-merge-r2.test.ts
import assert from "node:assert/strict";
import { mergeExtractedData, normaliseExtraction, splitEarningsMeasures } from "../../server/documents/extractor";
import { overlayExistingFacts } from "../../server/documents/reprocess";
import { getFieldSources, getFieldAlternates, yearSource } from "../../server/interview/info-merger";
import {
  describeFiscalYears, headlineYearOnFile, isSpecialistSource, reconcileHeadlines, settleConflicts, singleYearFigure,
  type MergeConflict,
} from "../../server/documents/merge-policy";
import { discrepancyForConflict } from "../../server/documents/merge-conflicts";
import { useAlternate } from "../../server/information/facts";
import { dealHeadlineFigures } from "../../server/routes/deal-list";

type Info = Record<string, unknown>;
let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
const doc = (documentId: string, extra: Record<string, unknown> = {}) => ({ documentId, source: "document" as const, ...extra });

// ── yearsOfData follows the fiscal years the documents cover ─────────────
{
  // What the real extractions of Clearwater's statements return.
  const fy23 = { revenueByYear: { "2023": "$3,082,400", "2022": "$2,780,200" }, revenue: "$3,082,400", yearsOfData: "2 years (2023 and 2022 comparative)", periodEnd: "2023-12-31" } as any;
  const fy24 = { revenueByYear: { "2024": "$3,318,600", "2023": "$3,082,400" }, revenue: "$3,318,600", yearsOfData: "2", periodEnd: "2024-12-31" } as any;
  const t23 = { title: "Compiled financial statements FY2023 (with FY2022 comparatives)", dated: "2024-03-22" };
  const t24 = { title: "Compiled financial statements FY2024 (with FY2023 comparatives)", dated: "2025-03-27" };
  for (const order of [["FY23", "FY24"], ["FY24", "FY23"]]) {
    let info: Info = {};
    for (const id of order) info = mergeExtractedData(info, id === "FY23" ? fy23 : fy24, doc(id, id === "FY23" ? t23 : t24));
    assert.equal(info.annualRevenue, "$3,318,600");
    assert.equal(info.yearsOfData, "3 years (2022–2024)", `yearsOfData names the years (${order.join(" then ")})`);
    assert.equal(getFieldSources(info).yearsOfData.documentId, "FY24");
    assert.ok(!(getFieldAlternates(info).yearsOfData ?? []).some((a) => a.source === "document"), "documents' own counts aren't other values");
  }
  // The extractions stored on the demo deal (older prompt: multi-year strings, suffixed keys, no periodEnd)
  const old23 = { revenue: "$3,082,400 (year ended December 31, 2023), $2,780,200 (2022)", revenueByYear: { "2022": "$2,780,200", "2023": "$3,082,400" },
    netIncome: "$243,122 (2023), $141,460 (2022)", yearsOfData: "2 years (2023 and 2022 comparative)" } as any;
  const old24 = { revenueByYear: { "2023": "$3,082,400", "2024": "$3,318,600" }, netIncome2023: "$243,122", netIncome2024: "$310,796",
    accountsReceivable2024: "$214,800", yearsOfData: "2 years (2024 and 2023)" } as any;
  for (const order of [["FY23", "FY24"], ["FY24", "FY23"]]) {
    let info: Info = {};
    for (const id of order) info = mergeExtractedData(info, id === "FY23" ? old23 : old24, doc(id, id === "FY23" ? t23 : t24));
    assert.equal(info.annualRevenue, "$3,318,600", `stored extractions replayed (${order.join(" then ")})`);
    assert.equal(info.netIncome, "$310,796");
    assert.equal(info.yearsOfData, "3 years (2022–2024)");
    assert.deepEqual(info.revenueByYear, { "2022": "$2,780,200", "2023": "$3,082,400", "2024": "$3,318,600" });
    assert.equal(info.accountsReceivable, undefined, "a suffixed balance-sheet key becomes a by-year map, not a stray key");
    assert.deepEqual(info.accountsReceivableByYear, { "2024": "$214,800" });
  }
  // The seller's own answer stands; a call's count gives way (kept as another value).
  let spoken: Info = { yearsOfData: "5 years of statements", _fieldSources: { yearsOfData: { source: "interview" } } };
  spoken = mergeExtractedData(spoken, fy24, doc("FY24", t24));
  assert.equal(spoken.yearsOfData, "5 years of statements");
  let call: Info = {};
  call = mergeExtractedData(call, { yearsOfData: "three years" } as any, { documentId: "CALL", source: "call" });
  call = mergeExtractedData(call, fy24, doc("FY24", t24));
  assert.equal(call.yearsOfData, "2 years (2023–2024)");
  assert.ok(getFieldAlternates(call).yearsOfData.some((a) => a.value === "three years" && a.source === "call"));
  // CRM / broker-only years are not documents on file
  let crm: Info = {};
  crm = mergeExtractedData(crm, { revenueByYear: { "2025": "about $2.4M" } } as any, { documentId: "CRM", source: "crm", brokerOnly: true });
  assert.equal(crm.yearsOfData, undefined);
  assert.equal(describeFiscalYears(["2021", "2023", "2024"]), "3 years (2021, 2023, 2024)");
  assert.equal(describeFiscalYears(["2024"]), "1 year (2024)");
  ok("yearsOfData = the fiscal years the documents cover, whatever the last statement said");
}

// ── the headline never steps back, never takes a run-rate / YTD year ─────
{
  // Harborview as it is on file: a by-year map an older version labelled the
  // broker's as a whole, with an ARR run-rate and quarter keys in it; the
  // headline an old multi-year string.
  const legacy = (): Info => ({
    annualRevenue: "$5,487,300 (2023); $4,812,600 (2022)",
    revenueByYear: {
      "2022": "$4,812,600", "2023": "$5,487,300", "2024": "$6,212,400",
      "2025": "$4,711,680 ARR (annualized from March 31, 2025 MRR)", "Q1 2025": "$1,628,000", "Q1 2025 recurring": "$1,160,000+",
    },
    _fieldSources: {
      revenueByYear: { source: "broker", at: "2026-09-25T15:36:52.423Z" },
      annualRevenue: { source: "document", documentId: "FS23" },
    },
  });
  assert.equal(headlineYearOnFile("$5,487,300 (2023); $4,812,600 (2022)", { source: "document" }, {}), "2023");
  assert.equal(headlineYearOnFile("FY2024 reported EBITDA $1,199,100 (FY2023 $920,600; FY2022 $638,200)", { source: "broker" }, {}), "2024");
  assert.equal(headlineYearOnFile("$3,082,400 (year ended December 31, 2023)", { source: "document" }, {}), "2023");
  assert.equal(headlineYearOnFile("about $520,000", { source: "call" }, { "2025": "about $520,000" }), "2025");
  assert.equal(headlineYearOnFile("$690,000 (FY2024, after normalization add-backs); FY2023 $600,800", { source: "interview" }, {}), "2024");
  // The seller's FY2024 SDE vs the FY2023 statements' SDE: two periods, not a conflict
  const sc: MergeConflict[] = [];
  let sd: Info = mergeExtractedData({}, { sde: "$537,300 (2023 calculation: …), $410,000 (2022: …)" } as any, doc("FS23", { title: "Compiled financial statements FY2023" }), { conflicts: sc });
  sd = { ...sd, sde: "$690,000 (FY2024, after normalization add-backs); FY2023 $600,800", _fieldSources: { ...(sd._fieldSources as object), sde: { source: "interview" } } };
  sd = mergeExtractedData(sd, { employees: "22" } as any, doc("ROSTER"), { conflicts: sc });
  assert.ok(!settleConflicts(sd, sc).some((c) => c.factKey === "sde"), "no SDE conflict across periods");
  // The old multi-year headline replaced by FY2024 is history, not a conflict
  const hc: MergeConflict[] = [];
  const h0: Info = { annualRevenue: "$5,487,300 (2023); $4,812,600 (2022)", _fieldSources: { annualRevenue: { source: "document", documentId: "FS23" } } };
  const h1 = mergeExtractedData(h0, { revenue: "$6,212,400", periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Financial statements FY2024" }), { conflicts: hc });
  assert.equal(h1.annualRevenue, "$6,212,400");
  assert.deepEqual(settleConflicts(h1, hc), []);
  // Any later ingest (an unrelated source)
  const a = mergeExtractedData(legacy(), { employees: "38" } as any, doc("ROSTER"));
  assert.equal(a.annualRevenue, "$6,212,400", "the latest FULL year, never the ARR run-rate");
  assert.doesNotMatch(String(a.annualRevenue), /ARR/);
  assert.equal(getFieldSources(a).annualRevenue.period, "2024-12-31");
  // When a statement also states that year's figure, the headline is credited to it.
  const withCorr = legacy();
  withCorr._fieldCorroborations = { "revenueByYear.2024": [{ source: "document", documentId: "FS24", value: "$6,212,400", period: "2024-12-31" }] };
  const c = mergeExtractedData(withCorr, { employees: "38" } as any, doc("ROSTER"));
  assert.equal(c.annualRevenue, "$6,212,400");
  assert.equal(getFieldSources(c).annualRevenue.source, "document");
  assert.equal(getFieldSources(c).annualRevenue.documentId, "FS24");
  // Re-reading the FY2024 statements
  const b = mergeExtractedData(legacy(), { revenueByYear: { "2024": "$6,212,400", "2023": "$5,487,300" }, revenue: "$6,212,400", periodEnd: "2024-12-31" } as any,
    doc("FS24", { title: "Financial statements FY2024" }));
  assert.equal(b.annualRevenue, "$6,212,400");
  assert.equal(getFieldSources(b).annualRevenue.source, "document", "credited to the statements, not 'Broker edit'");
  assert.equal(getFieldSources(b).annualRevenue.documentId, "FS24");
  assert.equal(dealHeadlineFigures(b).revenue?.value, 6212400);
  // Reprocess of the same deal (docs re-merged, the facts on file laid over them)
  let docsMerged: Info = {};
  docsMerged = mergeExtractedData(docsMerged, { revenueByYear: { "2024": "$6,212,400", "2023": "$5,487,300" }, revenue: "$6,212,400", periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Financial statements FY2024" }));
  docsMerged = mergeExtractedData(docsMerged, { revenue: "$4,711,680", periodEnd: "2025-03-31" } as any, doc("MRR", { title: "MRR schedule by client (Mar 31, 2025)" }));
  const rebuilt = overlayExistingFacts(docsMerged, legacy());
  reconcileHeadlines(rebuilt);
  assert.equal(rebuilt.annualRevenue, "$6,212,400", "reprocess: FY2024, not the run-rate");
  assert.notEqual(getFieldSources(rebuilt).annualRevenue.source, "broker");

  // A year-to-date figure is never the headline
  const ytd: Info = {
    annualRevenue: "$6,212,400",
    revenueByYear: { "2024": "$6,212,400", "2025": "$4,180,000 (Jan-May YTD, unaudited)" },
    _fieldSources: {
      annualRevenue: { source: "document", documentId: "FS24", period: "2024-12-31" },
      revenueByYear: { source: "broker", years: { "2024": { source: "document", documentId: "FS24", period: "2024-12-31" }, "2025": { source: "broker", note: "Chose Email" } } },
    },
  };
  assert.equal(mergeExtractedData(ytd, { employees: "38" } as any, doc("R")).annualRevenue, "$6,212,400");

  // A newer year's estimate never displaces the last final year as the headline (it stays that year's figure)
  let est: Info = mergeExtractedData({}, { revenue: "$3,318,600", revenueByYear: { "2024": "$3,318,600" }, periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Compiled financial statements FY2024" }));
  est = mergeExtractedData(est, { revenueByYear: { "2025": "$3,450,000 to $3,460,000 (unaudited management estimate, pending compilation)" } } as any, { documentId: "ZOOM", source: "video_call" });
  assert.equal(est.annualRevenue, "$3,318,600");
  // An unreviewed management estimate is not the year's figure: never on the map (kept in the source's notes).
  assert.equal((est.revenueByYear as any)["2025"], undefined);
  assert.match(String(est.keyFinancialNotes), /estimate/);
  // …but with nothing final, the seller's figure for the year is the headline (Maple: "about $520,000")
  const only = mergeExtractedData({}, { revenueByYear: { "2025": "about $520,000" } } as any, { documentId: "CALL", source: "call" });
  assert.equal(only.annualRevenue, "about $520,000");

  // Pacific: reviewed FY2024 statements + the seller on a Zoom call "2025 … about 31.8 million" (not reviewed)
  let pac: Info = mergeExtractedData({}, { revenue: "$31,020,000", revenueByYear: { "2024": "$31,020,000", "2023": "$29,180,000" }, periodEnd: "2024-12-31" } as any,
    doc("FS24", { title: "Reviewed financial statements FY2024" }));
  pac = mergeExtractedData(pac, { revenueByYear: { "2024": "$31M", "2025": "$31.8M" }, periodEnd: "2025-12-31" } as any, { documentId: "ZOOM", source: "video_call" });
  assert.equal(pac.annualRevenue, "$31,020,000", "the last statements year is the headline; the spoken 2025 is that year's figure");
  assert.equal((pac.revenueByYear as any)["2025"], "$31.8M");
  // …and a headline an earlier run moved to the spoken 2025 figure goes back to the statements' year
  const bad: Info = { ...pac, annualRevenue: "$31.8M", _fieldSources: { ...(pac._fieldSources as object), annualRevenue: { source: "video_call", documentId: "ZOOM", period: "2025-12-31" } } };
  assert.equal(mergeExtractedData(bad, { employees: "180" } as any, doc("ROSTER")).annualRevenue, "$31,020,000");
  // …while the seller live in the interview does close a year
  const live: Info = { ...pac, revenueByYear: { ...(pac.revenueByYear as object), "2025": "$31.8M" },
    _fieldSources: { ...(pac._fieldSources as object), revenueByYear: { source: "document", documentId: "FS24", years: {
      "2023": { source: "document", documentId: "FS24" }, "2024": { source: "document", documentId: "FS24" }, "2025": { source: "interview" } } } } };
  assert.equal(mergeExtractedData(live, { employees: "180" } as any, doc("ROSTER")).annualRevenue, "$31.8M");

  // Maple's intro call: "this year is trending up 2-3%" is not 2026's revenue
  const trend = normaliseExtraction({ revenueByYear: { "2024": "$505,000", "2025": "$520,000", "2026": "trending up 2-3% (summer slow as usual when students leave)" } });
  assert.deepEqual(trend.revenueByYear, { "2024": "$505,000", "2025": "$520,000" });
  assert.equal(trend.revenue, "$520,000");

  // The broker choosing another value for an OLDER year leaves the headline alone
  let m: Info = {};
  m = mergeExtractedData(m, { revenueByYear: { "2024": "$2,104,800", "2023": "$1,987,000", "2022": "$1,800,000" }, revenue: "$2,104,800", periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Financial statements FY2024" }));
  m = mergeExtractedData(m, { revenueByYear: { "2022": "$1,860,000" } } as any, { documentId: "EM", source: "email" });
  const idx = getFieldAlternates(m)["revenueByYear.2022"].findIndex((x) => x.value === "$1,860,000");
  useAlternate(m, "revenueByYear.2022", idx);
  assert.equal((m.revenueByYear as any)["2022"], "$1,860,000");
  const after = mergeExtractedData(m, { employees: "12" } as any, doc("ROSTER"));
  assert.equal(after.annualRevenue, "$2,104,800", "a 2022 pick is 2022's figure, not the headline");
  assert.equal(getFieldSources(after).annualRevenue.source, "document");

  // …and the broker's pick for the LATEST year does become the headline.
  const i24 = getFieldAlternates(m)["revenueByYear.2024"]?.length ?? 0;
  assert.equal(i24, 0);
  let p: Info = mergeExtractedData(m, { revenueByYear: { "2024": "$2.1M" } } as any, { documentId: "EM2", source: "email" });
  useAlternate(p, "revenueByYear.2024", getFieldAlternates(p)["revenueByYear.2024"].findIndex((x) => x.value === "$2.1M"));
  p = mergeExtractedData(p, { employees: "12" } as any, doc("ROSTER"));
  assert.equal(p.annualRevenue, "$2.1M");

  // A newer statement moves the headline on; an older one never takes it back.
  let s: Info = mergeExtractedData({}, { revenue: "$3,082,400", revenueByYear: { "2023": "$3,082,400" }, periodEnd: "2023-12-31" } as any, doc("FS23", { title: "Financial statements FY2023" }));
  s = mergeExtractedData(s, { revenue: "$3,318,600", revenueByYear: { "2024": "$3,318,600" }, periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Financial statements FY2024" }));
  s = mergeExtractedData(s, { revenue: "$2,780,200", revenueByYear: { "2022": "$2,780,200" }, periodEnd: "2022-12-31" } as any, { documentId: "BRK", source: "broker" } as any);
  assert.equal(s.annualRevenue, "$3,318,600", "even a broker-ranked older year never replaces the latest");
  ok("headline: latest full fiscal year only — no step-back, no run-rate / YTD year, no broker relabelling");
}

// ── a management report never overrides the statements ───────────────────
{
  const stmts = { netIncome: "$310,796", byYear: { netIncome: { "2024": "$310,796", "2023": "$243,122" } }, periodEnd: "2024-12-31" } as any;
  const report = { netIncome: "$350,000 (income before taxes, FY2024)", periodEnd: "2024-12-31" } as any;
  const tStmts = { title: "Compiled financial statements FY2024 (with FY2023 comparatives)", dated: "2025-03-27" };
  const tReport = { title: "Payer mix, location P&L, seasonality and AR report FY2024 · Financial Report - Payer Mix, Location P&L and Receivables", dated: "2026-01-20" };
  assert.equal(isSpecialistSource("netIncome", tReport.title), false, "a report with a P&L inside is not the statements");
  assert.equal(isSpecialistSource("netIncome", tStmts.title), true);
  assert.equal(isSpecialistSource("netIncome", "2024 P&L"), true, "an internal P&L still is");
  assert.equal(isSpecialistSource("revenueByYear", "Payer mix & monthly volumes FY2024 (ODB vs private) · Financial statements - revenue detail by payer mix and service line"), false,
    "the source's own name decides, not the reader's document type");
  assert.equal(isSpecialistSource("revenueByYear", "Scan_0012.pdf · Financial statements (compilation)"), true);
  assert.equal(isSpecialistSource("netIncome", "Reviewed financial statements FY2024 (with management's adjusted EBITDA schedule)"), true);
  // Pre-tax income is never recorded as net income
  const norm = normaliseExtraction(report);
  assert.equal(norm.netIncome, undefined);
  assert.equal(norm.incomeBeforeTax, "$350,000 (income before taxes, FY2024)");
  // Even when an older stored extraction still calls it net income
  const legacyReport = { netIncome: "$350,000", periodEnd: "2024-12-31" } as any;
  for (const order of ["stmts-first", "report-first"]) {
    const conflicts: MergeConflict[] = [];
    let info: Info = {};
    const steps: Array<[any, any]> = order === "stmts-first"
      ? [[stmts, doc("FS24", tStmts)], [legacyReport, doc("RPT", tReport)]]
      : [[legacyReport, doc("RPT", tReport)], [stmts, doc("FS24", tStmts)]];
    for (const [data, src] of steps) info = mergeExtractedData(info, data, src, { conflicts });
    assert.equal(info.netIncome, "$310,796", `the statements' net income stands (${order})`);
    assert.equal((info.netIncomeByYear as any)["2024"], "$310,796");
    const settled = settleConflicts(info, conflicts);
    assert.ok(settled.every((c) => discrepancyForConflict(c, () => undefined).severity !== "critical"), "never a blocking discrepancy");
  }
  // A newer year's figure (the report's FY2024 EBITDA) becomes the headline over the FY2023 statements' figure
  let eb: Info = {};
  eb = mergeExtractedData(eb, { ebitda: "$357,300 (2023 calculation: Income before taxes $273,900 + …), $249,000 (2022: $159,500 + …)" } as any, doc("FS23", { title: "Compiled financial statements FY2023 (with FY2022 comparatives)", dated: "2024-03-22" }));
  assert.equal(eb.ebitda, "$357,300");
  eb = mergeExtractedData(eb, { ebitda: "$426,100 (FY2024) - ties to compiled statements: income before taxes $350,000 + amortization $61,800 + interest $14,300" } as any, doc("RPT", tReport));
  assert.equal(eb.ebitda, "$426,100");
  assert.deepEqual(eb.ebitdaByYear, { "2022": "$249,000", "2023": "$357,300", "2024": "$426,100" });
  // Two premises, two leases: not one lease disputed
  const lc: MergeConflict[] = [];
  let two: Info = mergeExtractedData({}, { leaseExpiry: "May 31, 2027" } as any, doc("L1", { title: "Lease - Hillhurst clinic" }), { conflicts: lc });
  two = mergeExtractedData(two, { leaseExpiry: "August 31, 2031" } as any, doc("L2", { title: "Lease - Seton clinic" }), { conflicts: lc });
  assert.deepEqual(settleConflicts(two, lc), []);
  // …and an email about the first lease agrees with that lease, not a dispute with the second
  const le: MergeConflict[] = [];
  const three = mergeExtractedData(two, { leaseExpiry: "May 31, 2027" } as any, { documentId: "EM", source: "email" }, { conflicts: le });
  assert.deepEqual(settleConflicts(three, le), []);
  // …while a call's other date for a one-lease business is still a conflict
  const lo: MergeConflict[] = [];
  let one = mergeExtractedData({}, { leaseExpiry: "June 30, 2029" } as any, doc("L1", { title: "Lease - Merivale" }), { conflicts: lo });
  one = mergeExtractedData(one, { leaseExpiry: "2034" } as any, { documentId: "CALL", source: "call" }, { conflicts: lo });
  assert.ok(settleConflicts(one, lo).some((c) => c.factKey === "leaseExpiry"));
  ok("management reports never outrank the statements; pre-tax income is not net income");
}

// ── reported vs adjusted EBITDA ──────────────────────────────────────────
{
  // A stored call extraction that put both measures under one key
  const call = normaliseExtraction({ adjustedEbitda: "Reported EBITDA 2024: $5,274,900. Adjusted EBITDA 2024: $6,105,400. Adjusted EBITDA 2023: $5,311,310. Adjusted EBITDA 2022: $4,129,930. Clean progression showing consistent growth.", periodEnd: "2024-12-31" });
  assert.equal(call.adjustedEbitda, "$6,105,400", "the adjusted figure, not the reported one");
  assert.deepEqual(call.adjustedEbitdaByYear, { "2024": "$6,105,400", "2023": "$5,311,310", "2022": "$4,129,930" });
  assert.equal(call.ebitda, "$5,274,900");
  assert.deepEqual(call.ebitdaByYear, { "2024": "$5,274,900" });
  // …and under the plain key
  const same = normaliseExtraction({ ebitda: "Reported EBITDA 2024: $5,274,900. Adjusted EBITDA 2024: $6,105,400. Adjusted EBITDA 2023: $5,311,310." });
  assert.equal(same.ebitda, "$5,274,900");
  assert.equal(same.adjustedEbitda, "$6,105,400");
  // The controller's email, stored under ebitda
  const email = normaliseExtraction({ ebitda: "Tom Brennan: Adjusted EBITDA $6,105,400 in 2024 (10.5% margin), $5,311,310 in 2023, $4,129,930 in 2022; EBITDA as reported $5,274,900 in 2024" });
  assert.deepEqual(email.adjustedEbitdaByYear, { "2024": "$6,105,400", "2023": "$5,311,310", "2022": "$4,129,930" });
  assert.equal(email.ebitda, "$5,274,900");
  assert.equal(splitEarningsMeasures("EBITDA $5.2M"), null);
  assert.deepEqual(singleYearFigure("EBITDA as reported about $5.27M in 2024"), { year: "2024", value: "about $5.27M" });

  // Great Lakes: statements + a mislabelled email + the call → no blocking conflict
  const conflicts: MergeConflict[] = [];
  let gl: Info = {};
  gl = mergeExtractedData(gl, { ebitda: "$5,274,900 (2024), $4,799,710 (2023), $3,568,230 (2022)", periodEnd: "2024-12-31" } as any,
    doc("FS24", { title: "Reviewed financial statements FY2024 (with FY2023 comparatives + management's three-year adjusted EBITDA schedule)" }), { conflicts });
  gl = mergeExtractedData(gl, { ebitda: "$6,105,400", periodEnd: "2024-12-31" } as any, { documentId: "EMAIL", source: "email", title: "Email — Controller sends FY2024 package and add-back notes" }, { conflicts });
  gl = mergeExtractedData(gl, { adjustedEbitda: "Reported EBITDA 2024: $5,274,900. Adjusted EBITDA 2024: $6,105,400. Adjusted EBITDA 2023: $5,311,310." } as any, { documentId: "CALL", source: "call" }, { conflicts });
  assert.equal(gl.ebitda, "$5,274,900");
  assert.equal(gl.adjustedEbitda, "$6,105,400");
  const settled = settleConflicts(gl, conflicts);
  assert.ok(!settled.some((c) => /ebitda/i.test(c.factKey) && /6,105,400/.test(c.loser.value + c.winner.value)),
    "the adjusted figure is not a disputed reported EBITDA");
  ok("reported and adjusted EBITDA are kept apart — no false blocking conflict");
}

// ── the deal card says which year an older earnings figure is for ────────
{
  const cw: Info = {
    annualRevenue: "$3,318,600", sde: "$537,300",
    _fieldSources: { annualRevenue: { source: "document", documentId: "FS24", period: "2024-12-31" }, sde: { source: "document", documentId: "FS23", period: "2023-12-31" } },
  };
  assert.deepEqual(dealHeadlineFigures(cw).earnings, { label: "SDE", value: 537300, year: "2023" });
  const same: Info = { ...cw, _fieldSources: { ...(cw._fieldSources as object), sde: { source: "document", documentId: "FS24", period: "2024-12-31" } } };
  assert.deepEqual(dealHeadlineFigures(same).earnings, { label: "SDE", value: 537300 }, "same year: no label");
  // Pacific: the broker filed the adjusted figure under EBITDA — the card shows reported EBITDA
  const pac: Info = {
    annualRevenue: "$31,020,000", ebitda: "$3,900,000 adjusted EBITDA (FY2024)", ebitdaByYear: { "2023": "$3,061,600", "2024": "$3,547,200" },
    _fieldSources: {
      annualRevenue: { source: "document", documentId: "FS24", period: "2024-12-31" }, ebitda: { source: "broker" },
      ebitdaByYear: { source: "document", documentId: "FS24", years: { "2023": { source: "document", documentId: "FS24" }, "2024": { source: "document", documentId: "FS24" } } },
    },
  };
  assert.deepEqual(dealHeadlineFigures(pac).earnings, { label: "EBITDA", value: 3547200 });
  // …and "$3,547,200" against "$3,900,000 adjusted EBITDA" is two measures, not a conflict
  const c: MergeConflict = { factKey: "ebitda", winner: { value: "$3,900,000 adjusted EBITDA (FY2024)", src: { source: "broker" } }, loser: { value: "$3,547,200", src: { source: "document", documentId: "FS24", period: "2024-12-31" } } };
  assert.deepEqual(settleConflicts(pac, [c]), []);
  // A text giving both measures is not "adjusted only"
  const both: Info = { ...pac, ebitda: "FY2024 reported EBITDA $1,199,100; FY2024 adjusted EBITDA $1,350,000." };
  assert.deepEqual(dealHeadlineFigures(both).earnings, { label: "EBITDA", value: 1199100 });
  // Beacon: a 2023 figure on file as the broker's (an older whole-map label) that the statements also state
  // is weighed as the statements' — a management report's other figure is a minor discrepancy, not a blocking one.
  const bc: Info = {
    revenueByYear: { "2023": "$8,640,200", "2024": "$9,120,400" },
    _fieldSources: { revenueByYear: { source: "broker", years: { "2023": { source: "broker" }, "2024": { source: "broker" } } } },
    _fieldCorroborations: { "revenueByYear.2023": [{ source: "document", documentId: "FS24", value: "$8,640,200", specialist: true }] },
  };
  const rc: MergeConflict = { factKey: "revenueByYear", factYear: "2023", winner: { value: "$8,640,200", src: { source: "broker" } },
    loser: { value: "$7,646,600", src: { source: "document", documentId: "PAYER", period: "2023-12-31" } } };
  const settled = settleConflicts(bc, [rc]);
  assert.equal(settled.length, 1);
  assert.equal(discrepancyForConflict(settled[0], () => undefined).severity, "minor");
  ok("deal card: an earnings figure older than the revenue names its year; reported EBITDA, not adjusted");
}

console.log(`\n${n} checks passed`);
