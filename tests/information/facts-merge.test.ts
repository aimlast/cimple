// Fact accuracy core (QA-harvest stream facts1) — offline checks, no database, no AI.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/information/facts-merge.test.ts
import assert from "node:assert/strict";
import { mergeExtractedData, normaliseExtraction } from "../../server/documents/extractor";
import { overlayExistingFacts } from "../../server/documents/reprocess";
import {
  getFieldSources, getFieldAlternates, yearSource, yearEntryDocId, removeDocumentFields, type FieldSource,
} from "../../server/interview/info-merger";
import {
  cleanExtractedValue, isPlaceholderValue, normaliseYearKey, outranksFor, settleConflicts, stampSourceDetails, type MergeConflict,
} from "../../server/documents/merge-policy";
import { discrepancyForConflict } from "../../server/documents/merge-conflicts";
import { splitFactsForCim } from "../../server/information/cim-facts";
import { buildKnowledgeBase } from "../../server/cim/layout-engine";
import { useAlternate } from "../../server/information/facts";
import { dealHeadlineFigures } from "../../server/routes/deal-list";
import { buildInformationView } from "../../server/information/view";
import { sellerInterviewView } from "../../server/interview/seller-view";
import { sourceCountText, sourceContributionText } from "../../shared/information";

type Info = Record<string, unknown>;
let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
const doc = (documentId: string, extra: Record<string, unknown> = {}) => ({ documentId, source: "document" as const, ...extra });

// ── fin-headline-latest-year ─────────────────────────────────────────────
{
  const fy24 = { annualRevenue: "$3,318,600", periodEnd: "2024-12-31", yearsOfData: "2023, 2024" } as any;
  const fy23 = { annualRevenue: "$3,082,400", periodEnd: "2023-12-31", yearsOfData: "2022, 2023" } as any;
  for (const order of [[fy24, fy23], [fy23, fy24]]) {
    let info: Info = {};
    info = mergeExtractedData(info, order[0], doc(order[0] === fy24 ? "FY24" : "FY23"));
    info = mergeExtractedData(info, order[1], doc(order[1] === fy24 ? "FY24" : "FY23"));
    assert.equal(info.annualRevenue, "$3,318,600", "the newer fiscal year is the headline, whatever the order");
    assert.equal(getFieldSources(info).annualRevenue.documentId, "FY24");
    assert.equal(getFieldSources(info).annualRevenue.period, "2024-12-31");
    assert.ok(getFieldAlternates(info).annualRevenue.some((a) => a.value === "$3,082,400" && a.documentId === "FY23"), "FY2023 kept as an alternate");
    assert.match(String(info.yearsOfData), /2024/);
    assert.deepEqual(info.revenueByYear, { "2024": "$3,318,600", "2023": "$3,082,400" });
  }
  // Reprocess, both orders, over a deal whose headline came from the older year.
  for (const order of [[fy24, fy23], [fy23, fy24]]) {
    let docsMerged: Info = {};
    for (const x of order) docsMerged = mergeExtractedData(docsMerged, x, doc(x === fy24 ? "FY24" : "FY23"));
    const existing: Info = { annualRevenue: "$3,082,400", _fieldSources: { annualRevenue: { source: "document", documentId: "FY23" } } };
    const rebuilt = overlayExistingFacts(docsMerged, existing);
    assert.equal(rebuilt.annualRevenue, "$3,318,600", "reprocess agrees with ingestion");
  }
  // Suffixed keys fold into year maps; multi-year headline strings are split.
  const norm = normaliseExtraction({ sde2024: "$690,000", netIncome2023: "$410,000", ebitdaFy2022: "$500,000", revenue: "$3,082,400 (2023), $2,780,200 (2022)" });
  assert.deepEqual(Object.keys(norm).filter((k) => /\d/.test(k)), [], "no stray suffixed keys");
  assert.deepEqual(norm.sdeByYear, { "2024": "$690,000" });
  assert.deepEqual(norm.netIncomeByYear, { "2023": "$410,000" });
  assert.deepEqual(norm.ebitdaByYear, { "2022": "$500,000" });
  assert.deepEqual(norm.revenueByYear, { "2023": "$3,082,400", "2022": "$2,780,200" });
  assert.equal(norm.revenue, "$3,082,400", "headline = the latest year's single figure");
  assert.equal(norm.sde, "$690,000");
  // "(FY2024)" tag → bare value with its period; byYear from the tool
  const tagged = normaliseExtraction({ revenue: "$31,020,000 (FY2024)", byYear: { revenue: { "FY2023": "$29,180,000" }, netIncome: { "2024": "$972,960" } } });
  assert.equal(tagged.revenue, "$31,020,000");
  assert.equal((tagged._keyPeriods as any).revenue, "2024-12-31");
  assert.deepEqual(tagged.revenueByYear, { "2023": "$29,180,000", "2024": "$31,020,000" });
  assert.deepEqual(tagged.netIncomeByYear, { "2024": "$972,960" });
  ok("headline figures come from the latest fiscal year — both orders, ingest and reprocess; year keys folded into maps");
}

// ── facts-revenue-by-year ────────────────────────────────────────────────
{
  // (a) CRM first, then the statements
  let info: Info = {};
  info = mergeExtractedData(info, { revenueByYear: { "2024": "about $2.4M", "2023": "SDE ~$380K" } } as any, { documentId: "CRM", source: "crm", brokerOnly: true });
  assert.deepEqual(info.revenueByYear, { "2024": "about $2.4M" }, "SDE is never revenue");
  assert.match(String(info.keyFinancialNotes), /SDE ~\$380K/, "set aside as a note");
  info = mergeExtractedData(info, { revenueByYear: { "2024": "$2,104,800", "2023": "$1,987,000" }, periodEnd: "2024-12-31" } as any, doc("FS24"));
  assert.deepEqual(info.revenueByYear, { "2024": "$2,104,800", "2023": "$1,987,000" }, "a closed-year statement beats a CRM approximation");
  assert.ok(getFieldAlternates(info)["revenueByYear.2024"].some((a) => a.value === "about $2.4M" && a.source === "crm"));
  assert.equal(yearSource(getFieldSources(info).revenueByYear, "2024")?.documentId, "FS24");
  // (b) year keys
  assert.equal(normaliseYearKey("FY23"), "2023");
  assert.equal(normaliseYearKey("FY2023"), "2023");
  assert.equal(normaliseYearKey("fiscal 2023"), "2023");
  assert.equal(normaliseYearKey("FY2022/23"), "2023");
  assert.equal(normaliseYearKey("Last year"), null);
  assert.equal(normaliseYearKey("TTM Sep 2025"), null);
  const clean = normaliseExtraction({ revenueByYear: { FY23: "$3.1M", FY2023: "$3.1M", "2023": "$3,082,400", "Last year": "$3.3M" } });
  assert.deepEqual(clean.revenueByYear, { "2023": "$3,082,400" }, "one key per fiscal year, plain year wins");
  assert.match(String(clean.keyFinancialNotes), /Last year/);
  // (c) choosing one year relabels only that year
  let m: Info = {};
  m = mergeExtractedData(m, { revenueByYear: { "2024": "about $2.4M" } } as any, { documentId: "CRM", source: "crm", brokerOnly: true });
  m = mergeExtractedData(m, { revenueByYear: { "2022": "$1,800,000" } } as any, doc("FS22"));
  m = mergeExtractedData(m, { revenueByYear: { "2022": "$1.8M" } } as any, { documentId: "EM", source: "email" });
  const idx = getFieldAlternates(m)["revenueByYear.2022"].findIndex((a) => a.value === "$1.8M");
  useAlternate(m, "revenueByYear.2022", idx);
  const src = getFieldSources(m).revenueByYear;
  assert.equal(yearSource(src, "2024")?.source, "crm", "2024 stays a CRM year");
  assert.equal(yearSource(src, "2022")?.source, "broker");
  const displaced = getFieldAlternates(m)["revenueByYear.2022"].find((a) => a.value === "$1,800,000");
  assert.equal(displaced?.source, "document", "the displaced figure keeps its real kind");
  assert.equal(displaced?.documentId, "FS22");
  // (d) CIM split is year-aware
  const cimInfo: Info = {
    revenueByYear: { "2023": "$29.1M", "2024": "$31.0M", "2025": "~$31.8M" },
    _fieldSources: { revenueByYear: { source: "document", documentId: "FS", years: {
      "2023": { source: "document", documentId: "FS" }, "2024": { source: "document", documentId: "FS" },
      "2025": { source: "crm", documentId: "C", brokerOnly: false },
    } } },
  };
  const split = splitFactsForCim(cimInfo);
  assert.deepEqual(split.confirmed, [["revenueByYear", { "2023": "$29.1M", "2024": "$31.0M" }]]);
  assert.deepEqual(split.leads, [["revenueByYear", { "2025": "~$31.8M" }]], "a shared CRM year is a lead, never confirmed");
  ((cimInfo._fieldSources as any).revenueByYear.years["2025"] as FieldSource).brokerOnly = true;
  assert.deepEqual(splitFactsForCim(cimInfo).leads, [], "a broker-only CRM year is left out entirely");
  // Legacy bare-id year entries read as their row
  const legacy: Info = { revenueByYear: { "2024": "$31M", "FY25": "~$31.8M" }, _fieldSources: { revenueByYear: { source: "broker", years: { FY25: "CRMDOC" } } } };
  const stamped = stampSourceDetails(legacy, [{ id: "CRMDOC", sourceKind: "crm", visibility: "broker_only" }]);
  const ys = yearSource(getFieldSources(stamped).revenueByYear, "FY25")!;
  assert.equal(ys.source, "crm");
  assert.equal(ys.brokerOnly, true);
  assert.deepEqual(splitFactsForCim(stamped).confirmed, [["revenueByYear", { "2024": "$31M" }]]);
  // Deleting a statement removes only its years
  const del = removeDocumentFields(info, "FS24");
  assert.deepEqual(del.info.revenueByYear, undefined, "every year came from FS24 (CRM only as alternates)");
  ok("revenue by year: authority per year, clean keys, no SDE, per-year provenance, year-aware CIM split");
}

// ── facts-document-authority ─────────────────────────────────────────────
{
  const conflicts: MergeConflict[] = [];
  let info: Info = {};
  info = mergeExtractedData(info, { leaseExpiry: "about 2029" } as any, { documentId: "CALL", source: "call" }, { conflicts });
  info = mergeExtractedData(info, { leaseExpiry: "August 31, 2028" } as any, doc("LEASE", { title: "Lease agreement" }), { conflicts });
  assert.equal(info.leaseExpiry, "August 31, 2028", "the lease outranks the call");
  assert.ok(getFieldAlternates(info).leaseExpiry.some((a) => a.value === "about 2029" && a.source === "call"));
  assert.ok(conflicts.some((c) => c.factKey === "leaseExpiry" && c.winner.value === "August 31, 2028"), "a discrepancy candidate");
  const d = discrepancyForConflict(conflicts.find((c) => c.factKey === "leaseExpiry")!, () => "Lease agreement");
  assert.equal(d.source, "merge");
  assert.equal(d.factKey, "leaseExpiry");
  assert.equal(d.interviewValue, "about 2029", "the spoken side");
  assert.equal(d.documentValue, "August 31, 2028");
  assert.equal((d.sideSources as any).interview.kind, "call");

  const c2: MergeConflict[] = [];
  let rev: Info = {};
  rev = mergeExtractedData(rev, { annualRevenue: "about $2.3M" } as any, { documentId: "CALL", source: "call" }, { conflicts: c2 });
  rev = mergeExtractedData(rev, { annualRevenue: "$1,820,000", periodEnd: "2024-12-31" } as any, doc("FS24"), { conflicts: c2 });
  assert.equal(rev.annualRevenue, "$1,820,000", "the statement wins");
  assert.ok(c2.some((c) => c.factKey === "annualRevenue"), "a discrepancy is raised");
  assert.equal(discrepancyForConflict(c2.find((c) => c.factKey === "annualRevenue")!, () => undefined).severity, "critical");

  const c3: MergeConflict[] = [];
  let conc: Info = { customerConcentration: "no customer over 20%", _fieldSources: { customerConcentration: { source: "interview" } } };
  conc = mergeExtractedData(conc, { customerConcentration: "Largest customer 22% of revenue" } as any, doc("CUST"), { conflicts: c3 });
  assert.equal(conc.customerConcentration, "no customer over 20%", "the seller live keeps the claim");
  assert.ok(c3.some((c) => c.factKey === "customerConcentration"), "…and a discrepancy is raised");

  // A call's ~18% vs the documents' 22.0%: the document is the authority
  let pac: Info = {};
  pac = mergeExtractedData(pac, { customerConcentration: "Alderbrook about 18%" } as any, { documentId: "CALL", source: "call" });
  pac = mergeExtractedData(pac, { customerConcentration: "Alderbrook 22.0% of FY2024 revenue" } as any, doc("CUSTREV"));
  assert.equal(pac.customerConcentration, "Alderbrook 22.0% of FY2024 revenue");

  // Specialist: the org chart outranks a call for key employees
  let ge: Info = {};
  ge = mergeExtractedData(ge, { keyPersonnel: "Diane (CEO), Tom (Controller), Rob" } as any, { documentId: "CALL", source: "call" });
  ge = mergeExtractedData(ge, { keyPersonnel: "Diane Kline-Morrow (CEO, 34 yrs); Megan Pryor (Director Sales, 5 yrs)" } as any,
    doc("ORG", { title: "Organizational chart and key people (212 employees)" }));
  assert.match(String(ge.keyEmployees), /Megan Pryor \(Director Sales, 5 yrs\)/);
  assert.equal(getFieldSources(ge).keyEmployees.specialist, true);
  // …but a questionnaire vs a narrative document keeps the plain order
  assert.equal(outranksFor("companyHistory", { source: "document" }, { source: "questionnaire" }), false);
  assert.equal(outranksFor("leaseAddress", { source: "document" }, { source: "questionnaire" }), true);
  ok("document authority by field class, specialist sources, material conflicts become merge discrepancies");
}

// ── facts-placeholders-inferred ──────────────────────────────────────────
{
  // (a)
  let maple: Info = {};
  maple = mergeExtractedData(maple, { leaseAddress: "118 Wyndham St N, Guelph, ON" } as any, { documentId: "CRM", source: "crm" });
  maple = mergeExtractedData(maple, { leaseAddress: "Wyndham Street (downtown Guelph, implied from context)" } as any, { documentId: "CALL", source: "call" });
  assert.equal(maple.leaseAddress, "118 Wyndham St N, Guelph, ON", "a worked-out value never displaces an explicit one");
  // leaseExpiry computed by the reader
  let exp: Info = {};
  exp = mergeExtractedData(exp, { leaseExpiry: "October 2029 (4 years remaining from October 2025 renewal)" } as any, { documentId: "CALL", source: "call" });
  assert.equal(getFieldSources(exp).leaseExpiry.valueInferred, true);
  exp = mergeExtractedData(exp, { leaseExpiry: "September 30, 2030" } as any, { documentId: "CRM", source: "crm" });
  assert.equal(exp.leaseExpiry, "September 30, 2030", "any explicit value replaces a worked-out one");
  // (b)
  let nb: Info = {};
  nb = mergeExtractedData(nb, { leaseAddress: "412 Hartwell Rd, Barrie, ON" } as any, doc("LEASE", { title: "Lease" }));
  nb = mergeExtractedData(nb, { leaseAddress: "Hartwell, Barrie area (specific address not stated)", leaseRenewalOptions: "terms not specified" } as any, { documentId: "CALL", source: "call" });
  assert.equal(nb.leaseAddress, "412 Hartwell Rd, Barrie, ON");
  assert.equal(nb.leaseRenewalOptions, undefined, "a placeholder is never a fact");
  assert.ok(!(getFieldAlternates(nb).leaseAddress ?? []).some((a) => /not stated/.test(a.value)));
  // (c)
  const c = normaliseExtraction({ accountant: "Pam (surname not provided)", debtObligations: "specific amounts not stated", owner: "Unknown" });
  assert.equal(c.accountant, "Pam");
  assert.equal(c.debtObligations, undefined);
  assert.equal(c.owner, undefined);
  assert.equal(isPlaceholderValue("N/A"), true);
  assert.equal(cleanExtractedValue("Bank loan (amounts not disclosed)").value, "Bank loan");
  // (d)
  let beacon: Info = {};
  beacon = mergeExtractedData(beacon, { saleType: "Share sale (owner wants LCGE)" } as any, { documentId: "CALL1", source: "call" });
  beacon = mergeExtractedData(beacon, { saleType: "Asset sale implied (buyer would take the lease)" } as any, { documentId: "ZOOM", source: "video_call" });
  assert.equal(beacon.saleType, "Share sale (owner wants LCGE)");
  let rev: Info = {};
  rev = mergeExtractedData(rev, { saleType: "Asset sale implied (buyer would take the lease)" } as any, { documentId: "ZOOM", source: "video_call" });
  rev = mergeExtractedData(rev, { saleType: "Share sale (owner wants LCGE)" } as any, { documentId: "CALL1", source: "call" });
  assert.equal(rev.saleType, "Share sale (owner wants LCGE)", "…in either order");
  ok("placeholders are never facts; worked-out values only fill empty fields");
}

// ── headline-revenue-from-crm-lead + ui-deal-card-ebitda ─────────────────
{
  const conflicts: MergeConflict[] = [];
  let maple: Info = {};
  maple = mergeExtractedData(maple, { annualRevenue: "~$590K gross (described as a little under six hundred)" } as any, { documentId: "CRM", source: "crm", brokerOnly: true }, { conflicts });
  maple = mergeExtractedData(maple, { revenueByYear: { "2025": "about $520,000" } } as any, { documentId: "CALL", source: "call", brokerOnly: false }, { conflicts });
  assert.equal(maple.annualRevenue, "about $520,000");
  assert.equal(getFieldSources(maple).annualRevenue.source, "call");
  assert.ok(getFieldAlternates(maple).annualRevenue.some((a) => a.source === "crm" && /590K/.test(a.value)));
  const cand = conflicts.find((c) => c.factKey === "annualRevenue");
  assert.ok(cand, "a discrepancy candidate");
  assert.equal(discrepancyForConflict(cand!, () => undefined).severity, "minor", "a CRM side is minor");
  assert.equal(dealHeadlineFigures(maple).revenue?.value, 520000);
  assert.equal(dealHeadlineFigures(maple).revenue?.unverified, undefined);
  const crmOnly: Info = { annualRevenue: "~$590K", _fieldSources: { annualRevenue: { source: "crm", documentId: "CRM" } } };
  assert.deepEqual(dealHeadlineFigures(crmOnly).revenue, { value: 590000, unverified: true }, "a CRM-only figure is flagged");
  // Earnings: EBITDA on large deals
  const pac: Info = { annualRevenue: "$31,020,000", ebitda: "$3,547,000", _fieldSources: { annualRevenue: { source: "document", documentId: "F" }, ebitda: { source: "document", documentId: "F" } } };
  assert.deepEqual(dealHeadlineFigures(pac).earnings, { label: "EBITDA", value: 3547000 });
  assert.deepEqual(dealHeadlineFigures({ ebitda: "$3,547,000" }).earnings, { label: "EBITDA", value: 3547000 });
  assert.deepEqual(dealHeadlineFigures({ annualRevenue: "$1.2M", sde: "$310K", ebitda: "$200K" }).earnings, { label: "SDE", value: 310000 });
  ok("headline revenue reconciled with revenue by year; deal card revenue + labelled earnings, leads flagged");
}

// ── cim-kb-private-leads ─────────────────────────────────────────────────
{
  const info: Info = {
    annualRevenue: "$31,020,000",
    revenueByYear: { "2024": "$31,020,000", "2025": "~$31.8M (mgmt, verbal only)" },
    referralSource: "Gary Lindqvist (sold his company through us)",
    priorApproaches: "lowball national-carrier approach in 2019",
    adjustedEbitda: "adj $6.1M",
    _fieldSources: {
      annualRevenue: { source: "document", documentId: "FS" },
      revenueByYear: { source: "document", documentId: "FS", years: {
        "2024": { source: "document", documentId: "FS" },
        "2025": { source: "crm", documentId: "CRMDOC", brokerOnly: true },
      } },
      referralSource: { source: "call", documentId: "CALL" },
      priorApproaches: { source: "crm", documentId: "CRMDOC" },
      adjustedEbitda: { source: "crm", documentId: "CRM2" },
    },
  };
  const kb = buildKnowledgeBase({ dealId: "d", businessName: "Pacific", industry: "Logistics", extractedInfo: info } as any);
  assert.doesNotMatch(kb, /2025|31\.8M/, "a broker-only year never reaches the writer");
  assert.doesNotMatch(kb, /Lindqvist|lowball|adj \$6\.1M/i, "no referral source, no CRM facts");
  assert.match(kb, /Revenue By Year: 2024: \$31,020,000/);
  const merged = mergeExtractedData({}, { referralSource: "Gary Lindqvist", brokerFee: "5%" } as any, { documentId: "CALL", source: "call" });
  assert.deepEqual(Object.keys(merged).filter((k) => !k.startsWith("_")), [], "broker process data writes no fact");
  const norm = normaliseExtraction({ referralSource: "Gary Lindqvist", summary: "Intro call" });
  assert.match(String(norm._privateNotes), /Referral Source: Gary Lindqvist/);
  // The seller interview never sees the broker-only year either
  const seller = sellerInterviewView(info, [{ id: "CRMDOC", visibility: "broker_only" } as any, { id: "FS", visibility: "shared" } as any]);
  assert.deepEqual(seller.revenueByYear, { "2024": "$31,020,000" });
  ok("CIM knowledge base: no broker-only years, CRM facts or broker process data");
}

// ── ui-information-counts ────────────────────────────────────────────────
{
  const info: Info = {
    annualRevenue: "$1.8M", employees: "12",
    _fieldSources: { annualRevenue: { source: "document", documentId: "PL" }, employees: { source: "interview" } },
    _fieldCorroborations: { annualRevenue: [{ source: "document", documentId: "MINUTES", value: "$1.8M" }] },
    _fieldAlternates: { employees: [{ source: "document", documentId: "MINUTES", value: "14" }] },
  };
  const docRow = (id: string, name: string) => ({ id, name, dealId: "d", sourceKind: "document", visibility: "shared", sourceMeta: null, extractedData: null, extractedText: "x", createdAt: new Date("2025-01-01"), status: "extracted", uploadedBy: "broker", fileUrl: "", category: "financials" });
  const view = buildInformationView({
    deal: { id: "d", industry: "Dental", extractedInfo: info, questionnaireData: null, scrapedData: null } as any,
    documents: [docRow("PL", "2024 P&L"), docRow("MINUTES", "Minute book")] as any,
    sessions: [],
  });
  const minutes = view.sources.find((s) => s.id === "MINUTES")!;
  assert.equal(minutes.factCount, 0);
  assert.equal(minutes.corroboratedCount, 1);
  assert.equal(minutes.alternateCount, 1);
  assert.equal(sourceContributionText(minutes), "confirms 1 · 1 other value");
  const kindSum = Object.values(view.counts).reduce((a, b) => a + (b ?? 0), 0);
  assert.equal(kindSum, view.totalFacts, "kind counts add up to the total");
  // Header and panel share one wording
  const eight = Array.from({ length: 8 }, (_, i) => ({ factCount: i < 6 ? 3 : 0 }));
  assert.equal(sourceCountText(eight), "8 sources · 6 contributed facts");
  assert.equal(sourceCountText([{ factCount: 1 }]), "1 source");
  ok("Information counts: one wording; corroborating / alternate-only sources aren't '0 facts'");
}

// ── Real-run findings (Great Lakes / Harborview / Pacific replays) ─────────
{
  // A same figure repeated by an email never becomes the recorded source over the statement,
  // so a later spoken figure has to beat the statement.
  let gl: Info = {};
  gl = mergeExtractedData(gl, { revenueByYear: { "2023": "$54,708,210" }, periodEnd: "2023-12-31" } as any, doc("FS23", { title: "Reviewed financial statements FY2023" }));
  gl = mergeExtractedData(gl, { revenueByYear: { "2023": "$54,708,210" } } as any, { documentId: "EM", source: "email" });
  gl = mergeExtractedData(gl, { revenueByYear: { "2023": "$54,700,000" } } as any, { documentId: "CALL", source: "call" });
  assert.equal((gl.revenueByYear as any)["2023"], "$54,708,210");
  assert.equal(yearSource(getFieldSources(gl).revenueByYear, "2023")?.documentId, "FS23");
  // Statements outrank a tax return for book figures
  let ni: Info = {};
  ni = mergeExtractedData(ni, { netIncome: "$2,403,570", periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Reviewed financial statements FY2024", dated: "2025-03-12" }));
  ni = mergeExtractedData(ni, { netIncome: "$1,708,970", periodEnd: "2024-12-31" } as any, doc("TAX", { title: "Form 1120-S summary — tax year 2024", dated: "2025-03-14" }));
  assert.equal(ni.netIncome, "$2,403,570");
  // A headline never steps back to an older year
  const back: Info = {
    annualRevenue: "$58M", revenueByYear: { "2022": "$49,862,450" },
    _fieldSources: { annualRevenue: { source: "call", documentId: "C", period: "2024-12-31" }, revenueByYear: { source: "document", documentId: "F22", years: { "2022": { source: "document", documentId: "F22", period: "2022-12-31" } } } },
  };
  const again = mergeExtractedData(back, {} as any, doc("X"));
  assert.equal(again.annualRevenue, "$58M");
  // Budgets, quarters and interim run-rates are not a fiscal year's revenue
  assert.equal(normaliseExtraction({ revenueByYear: { "2025": "$61,500,000 (budget)", "2024": "$58,241,630" } }).revenueByYear?.["2025" as any], undefined);
  let hv: Info = {};
  hv = mergeExtractedData(hv, { revenueByYear: { "2023": "$5,487,300", "2024": "$6,212,400" }, periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Financial statements FY2024" }));
  hv = mergeExtractedData(hv, { revenueByYear: { "2022": "$4,812,600", "2023": "$5,487,300" }, periodEnd: "2023-12-31" } as any, doc("FS23", { title: "Financial statements FY2023" }));
  hv = mergeExtractedData(hv, { revenue: "$4,711,680", periodEnd: "2025-03-31" } as any, doc("MRR", { title: "MRR schedule by client (Mar 31, 2025)" }));
  assert.deepEqual(Object.keys(hv.revenueByYear as object).sort(), ["2022", "2023", "2024"], "an MRR run-rate is not FY2025 revenue");
  assert.equal(hv.annualRevenue, "$6,212,400");
  assert.ok(getFieldAlternates(hv)["revenueByYear.2025"].some((a) => a.value === "$4,711,680"), "kept as another value");
  // Adjusted EBITDA under the plain key goes to adjustedEbitda
  const adj = normaliseExtraction({ ebitda: "adj $6.1M", byYear: { ebitda: { "2024": "~$6M adj EBITDA per the controller" } } });
  assert.equal(adj.ebitda, undefined);
  assert.equal(adj.adjustedEbitda, "adj $6.1M");
  assert.deepEqual(adj.adjustedEbitdaByYear, { "2024": "~$6M adj EBITDA per the controller" });
  // A lease summary that says the lease runs to another year is a conflict
  const lc: MergeConflict[] = [];
  let ls: Info = {};
  ls = mergeExtractedData(ls, { leaseDetails: "6,200 sq ft on Kempt Road. Lease runs to 2029." } as any, { documentId: "CALL", source: "call" }, { conflicts: lc });
  ls = mergeExtractedData(ls, { leaseDetails: "Term: 5 years, expiring August 31, 2027; one 5-year renewal." } as any, doc("LEASE", { title: "Office lease" }), { conflicts: lc });
  assert.match(String(ls.leaseDetails), /2027/);
  assert.ok(lc.some((c) => c.factKey === "leaseDetails"));
  // Transient conflicts are settled against the final facts
  const tc: MergeConflict[] = [];
  let pc: Info = {};
  pc = mergeExtractedData(pc, { annualRevenue: "$31 million" } as any, { documentId: "CALL", source: "call" }, { conflicts: tc });
  pc = mergeExtractedData(pc, { annualRevenue: "$28,640,000", periodEnd: "2022-12-31" } as any, doc("FS22", { title: "Financial statements FY2022" }), { conflicts: tc });
  pc = mergeExtractedData(pc, { annualRevenue: "$31,020,000", periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Financial statements FY2024" }), { conflicts: tc });
  assert.equal(pc.annualRevenue, "$31,020,000");
  assert.ok(tc.length > 0, "a conflict was seen along the way");
  assert.deepEqual(settleConflicts(pc, tc), [], "…but the call's $31M agrees with the final FY2024 figure");
  ok("real-run findings: statement stays recorded over repeats, statements over tax returns, no step-back, no interim years, adjusted EBITDA, lease-end conflicts, settled conflicts");
}

console.log(`\n${n} checks passed`);
