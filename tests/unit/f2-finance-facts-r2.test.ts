// SECOND free round, stream "finance-facts", round 2: the checker's seven new
// problems, proved offline (stubbed model client — no API call).
//  F2-03  a premises lease titled by a business name ("Lease - Kingsway Auto Body") is not an
//         equipment lease; the lease's own facts (a street address, tenant / landlord terms)
//         outweigh an equipment word that only describes it
//  F2-01  a "not stated" side whose other clauses only explain why ("only 2022 and 2023
//         available", "the P&L does not break out owner salary") is still missing
//  F2-09  "X only" is a part of the business (service revenue only, commercial work only),
//         except known notes about the whole year's figure (only full year on file)
//  F2-07  Word / Excel / PowerPoint / text sources are never "scanned"; a sparse PDF deck is
//         not a scan; a PDF with (almost) nothing on most pages is
//  F2-04  the claim is pro-rated to the period the ledger covers; support above the claim is
//         "exceeds_claim" (a portion of the payments), never "partly supported"
//  F2-05  a discovered portion add-back (above-market rent, the personal share of a vehicle)
//         keeps the model's amount; only a whole account named takes the code total
//  F2-06  an Opco's and a Holdco's statements read in different parts are never merged
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-finance-facts-r2.test.ts
import assert from "node:assert/strict";
import { isEquipmentLeaseTitle, isPremisesLeaseTitle, factsSayPremises } from "../../server/documents/lease-kind";
import { _setExtractionClientForTests, extractDocumentData, mergeExtractedData, readFoundNothing, thinTextLayer, type ExtractionClient } from "../../server/documents/extractor";
import { findMatchingRequirement } from "../../server/documents/requirements";
import { getFieldSources } from "../../server/interview/info-merger";
import { dropReason, isMissingSide } from "../../server/cim/discrepancy-filter";
import { cleanYearMap, isSubsetFigure } from "../../server/documents/merge-policy";
import { addbackEvidenceLine, addbackSupport, claimWords, evidencedAmount, withEvidence } from "../../shared/addback-support";
import { settleDiscovered, settleMatch, type ParsedTransaction } from "../../server/financial/addback-verifier";
import { combinePartStatements, type ExtractedStatement } from "../../server/financial/extractor";

const ok = (msg: string) => console.log(`✓ ${msg}`);

// ── F2-03: business names are not equipment ────────────────────────────────────
{
  for (const t of [
    "Lease - Kingsway Auto Body",
    "Lease - Kingsway Auto Body · Commercial lease agreement",
    "Lease - Sparkle Car Wash",
    "Lease - Sparkle Car Wash · Lease agreement",
    "Lease agreement - Main Street Printers Ltd",
    "Lease - Precision Machine Works Inc · Commercial lease",
    "Commercial lease - Bay Truck & Trailer Repair",
    "Lease - Mississauga Auto Centre (Unit 7)",
    "Lease - Fleet Services Depot",
    "lease-kingsway-auto-body.pdf",
  ]) {
    assert.ok(!isEquipmentLeaseTitle(t), t);
    assert.ok(isPremisesLeaseTitle(t), t);
  }
  for (const t of [
    "Equipment lease - Toyota forklift",
    "Vehicle lease - 2022 Ford F-150",
    "Office equipment lease - Canon copier",
    "Copier lease",
    "Excavator lease - CAT 320",
    "Capital lease schedule",
    "Forklift lease - Kingsway Auto Body",
    "Lease of two delivery vans",
  ]) assert.ok(isEquipmentLeaseTitle(t), t);
  // An equipment word that only describes the lease gives way to the lease's own facts.
  assert.ok(isEquipmentLeaseTitle("Lease - Toyota forklift"));
  assert.ok(!isEquipmentLeaseTitle("Lease - Toyota forklift", { leaseAddress: "88 Kingsway Ave" }));
  // A title that says outright what is leased is not overruled.
  assert.ok(isEquipmentLeaseTitle("Forklift lease", { leaseAddress: "88 Kingsway Ave" }));
  assert.ok(factsSayPremises({ leaseDetails: "Tenant pays base rent plus TMI on 4,200 sq ft" }));
  assert.ok(factsSayPremises({ leaseAddress: "Unit 7, 2150 Dunwin Dr, Mississauga ON L5L 5M8" }));
  assert.ok(!factsSayPremises({ leaseDetails: "60 monthly payments; buyout $1 at term end" }));
  ok("a business name with auto / car / printers / machine / truck in it is the premises lease; equipment titles still are equipment");
}
{
  // The merge keeps the premises lease's expiry and rent (it used to move them to vehicleLeases).
  for (const facts of [
    { leaseExpiry: "June 30, 2030", monthlyRent: "$6,500 per month", leaseDetails: "5-year term with one 5-year renewal" },
    { leaseExpiry: "June 30, 2030", monthlyRent: "$6,500 per month", leaseAddress: "88 Kingsway Ave" },
  ]) {
    const info = mergeExtractedData({}, facts, { source: "document", documentId: "L1", title: "Lease - Kingsway Auto Body", dated: "2025-01-10" });
    assert.equal(info.leaseExpiry, "June 30, 2030");
    assert.equal(info.monthlyRent, "$6,500 per month");
    assert.equal(info.vehicleLeases, undefined);
    assert.equal(info.equipmentLeases, undefined);
    assert.equal(getFieldSources(info).leaseExpiry.documentId, "L1");
  }
  // The car wash's premises lease, read with its address, stays the premises lease.
  const prem = mergeExtractedData({}, { leaseExpiry: "May 31, 2029", leaseAddress: "88 Kingsway Ave, Burnaby BC" },
    { source: "document", documentId: "L2", title: "Lease - Sparkle Car Wash" });
  assert.equal(prem.leaseExpiry, "May 31, 2029");
  const rows = [
    { id: "prem", documentName: "Commercial Lease Agreement", category: "legal", status: "missing", sortOrder: 1 },
    { id: "eq", documentName: "Equipment Lease Agreements", category: "legal", status: "missing", sortOrder: 2 },
  ];
  assert.equal(findMatchingRequirement(rows, "Lease - Kingsway Auto Body.pdf", "legal")?.id, "prem");
  assert.equal(findMatchingRequirement(rows, "Lease - Sparkle Car Wash.pdf", "legal")?.id, "prem");
  assert.equal(findMatchingRequirement(rows, "Equipment lease - Toyota forklift.pdf", "legal")?.id, "eq");
  ok("the Kingsway Auto Body / Sparkle Car Wash leases keep leaseExpiry + monthlyRent and tick Commercial Lease Agreement");
}

// ── F2-01: a missing side that explains why is still missing ────────────────────
{
  for (const v of [
    "Not provided (only 2022 and 2023 available) — Knowledge base fuelCosts2024",
    "Not stated in the documents; the P&L does not break out owner salary",
    "Not stated in the uploaded documents. The P&L shows total wages only.",
    "Not provided - the financial statements only show consolidated revenue",
    "Not available in the uploaded documents (only the 2023 T2 was provided)",
    "Not found in uploaded documents; only a 2022 bank statement is on file",
    "Not mentioned in the interview (the seller was asked about staff but not about the manager's contract)",
    "Not mentioned in the interview; the seller only discussed revenue trends",
    "Owner salary not specified in the P&L (wages are lumped together)",
    "No lease document uploaded; the seller said the landlord is his brother-in-law",
  ]) assert.ok(isMissingSide(v), v);
  // The round-1 cases stay compared.
  for (const v of [
    "Largest customer 31% of 2024 revenue (customer name not disclosed)",
    "Lease expires August 31, 2029; renewal options not stated",
    "31 employees per T4 summary (names not provided)",
    "T2 revenue $4,210,000 for FY2024. Cannot be verified against the GL.",
  ]) assert.ok(!isMissingSide(v), v);
  // The stored financial-analysis row the checker found is dropped, not raised.
  assert.equal(dropReason({
    source: "financial_analysis", fieldName: "Fuel costs 2024",
    interviewValue: "About $410,000 in fuel last year",
    documentValue: "Not provided (only 2022 and 2023 available) — Knowledge base fuelCosts2024",
  } as never), "missing_side");
  ok("'only 2022 and 2023 available', 'the P&L does not break out…', 'the seller only discussed…' are missing context, not a claim");
}

// ── F2-09: part-of-business wordings ────────────────────────────────────────────
{
  for (const v of [
    "$1,300,000 (service revenue only)", "$3,000,000 (commercial work only)", "$900K (retail side only)",
    "$1.3M (maintenance contracts only)", "$1.8M (installs only, excludes service)", "$6.8M (Alderbrook only)",
    "$2.2M from the Hamilton branch", "$800K from one client",
  ]) assert.ok(isSubsetFigure(v), v);
  for (const v of [
    "$4.2M (audited; only full year on file)", "$4.2M (the only audited year)", "$4.1M (FY2024 only)",
    "$4.1M (only reviewed statements)", "$4.1M (only figure provided)", "$5.1M (net of customer rebates)",
    "$5.1M (per client statements)", "$12.4M (both clinics combined)",
  ]) assert.ok(!isSubsetFigure(v), v);
  const y = cleanYearMap("revenueByYear", { "2023": "$4,100,000", "2024": "$1,300,000 (service revenue only)" });
  assert.deepEqual(y.map, { "2023": "$4,100,000" });
  assert.equal(y.rejected.length, 1);
  assert.deepEqual(cleanYearMap("activeDriversDecember", { "2023": "41", "2024": "44" }).map, { "2023": "41", "2024": "44" });
  ok("'service revenue only' / 'commercial work only' / 'maintenance contracts only' are never a year's total; whole-year notes are");
}

// ── F2-07: real documents are not scans ─────────────────────────────────────────
{
  const questionnaire = [
    "Seller questionnaire - Northbeam Landscaping",
    ...["Do you own the building?", "Is there a union?", "Any pending litigation?", "Is the lease assignable?", "Are all permits current?", "Any environmental issues?",
      "Do you have key-person insurance?", "Any customer over 20%?", "Is equipment financed?", "Any related-party rent?", "Will you stay on for training?", "Any deferred maintenance?"]
      .flatMap((q, i) => [q, i % 2 ? "Yes" : "No"]),
  ].join("\n");
  assert.ok(!thinTextLayer(questionnaire, { pdf: false }));
  assert.ok(!thinTextLayer(questionnaire));
  const deckFooter = Array.from({ length: 8 }, (_, i) => `Slide ${i + 1}\nGrowth\nConfidential`).join("\n");
  assert.ok(!thinTextLayer(deckFooter, { pdf: false }), "a PPTX deck with a Confidential footer");
  const equipment = Array.from({ length: 12 }, (_, i) => `Unit ${i + 1}\nOwned`).join("\n");
  assert.ok(!thinTextLayer(equipment), "an equipment list with an Owned column (stored text, no page count)");
  // A sparse 8-slide PDF deck, page by page, is not a scan.
  const deckPages = ["Northbeam Landscaping\nCompany Overview 2025", "Founded 2009 in Barrie", "42 staff", "310 contracts",
    "Maintenance 55%", "Snow 15%", "Innisfil yard", "Thank you"].map((p) => `${p}\nConfidential - Northbeam\nwww.northbeam.ca`);
  assert.ok(!thinTextLayer(deckPages.join("\n\n"), { pages: 8, pageTexts: deckPages, pdf: true }));
  assert.ok(!thinTextLayer(deckPages.join("\n\n"), { pages: 8, pdf: true }), "by the page count alone");
  // A typed cover over image pages, and a scanner's stamp on every page, are scans.
  const cover = "COMMERCIAL LEASE AGREEMENT\nBetween 1234567 Ontario Inc. (Landlord) and Lakeshore Home Comfort Ltd. (Tenant)";
  assert.ok(thinTextLayer(cover, { pages: 12, pageTexts: [cover, ...Array(11).fill("")], pdf: true }));
  const stamped = Array(10).fill("Scanned with CamScanner\nPage 1");
  assert.ok(thinTextLayer(stamped.join("\n"), { pages: 10, pageTexts: stamped, pdf: true }));
  assert.ok(thinTextLayer(Array(12).fill("Scanned with CamScanner").join("\n")), "stored text: a scanner's stamp counts the pages");
  // A short Word file that yielded nothing is not "scanned" (its checklist row is not released as a scan).
  assert.ok(!readFoundNothing({ summary: "A cover letter." }, "Please find attached.", { pdf: false }));
  assert.ok(readFoundNothing({ summary: "Scanned pages." }, cover, { pages: 12, pdf: true }));
  ok("Yes/No answers, slide footers and status columns are the document's own text; only PDFs can be scans");
}
{
  // The questionnaire (a Word file) goes to the model; the scanned PDF does not.
  let calls = 0;
  const fake: ExtractionClient = {
    messages: {
      stream: () => ({
        finalMessage: async () => {
          calls++;
          return { content: [{ type: "tool_use", input: { _documentType: "questionnaire", summary: "Seller questionnaire.", ownsBuilding: "No" } }], stop_reason: "tool_use" };
        },
      }),
    },
  };
  _setExtractionClientForTests(fake);
  const text = Array.from({ length: 14 }, (_, i) => `Question ${i + 1} about the business and how it runs\n${i % 2 ? "Yes" : "No"}`).join("\n");
  const read = await extractDocumentData(text, "other", null, "document", { pdf: false });
  assert.equal(calls, 1, "the Word questionnaire is read");
  assert.notEqual(read.summary, undefined);
  assert.doesNotMatch(String(read._failureReason ?? ""), /scanned/);
  const scan = await extractDocumentData(Array(12).fill("Scanned with CamScanner\nHarbourline Dental tax return").join("\n"), "tax_returns", null, "document",
    { pages: 12, pageTexts: Array(12).fill("Scanned with CamScanner\nHarbourline Dental tax return"), pdf: true });
  assert.equal(calls, 1, "the scan is not sent to the model");
  assert.match(String(scan._failureReason ?? scan.summary), /scanned/);
  _setExtractionClientForTests(null);
  ok("extractDocumentData reads a Word questionnaire and returns the scanned stub for a scan without a model call");
}

// ── F2-04: pro-rated claims, over-support ───────────────────────────────────────
const monthly = (amt: number, year: number, months: number, startMonth = 1, account = "Rent") =>
  Array.from({ length: months }, (_, i) => {
    const m = startMonth + i;
    const y = year + Math.floor((m - 1) / 12);
    const mm = ((m - 1) % 12) + 1;
    return { date: `${y}-${String(mm).padStart(2, "0")}-15`, description: `${account} payment`, amount: amt, account, source: "gl" as const, category: account.toLowerCase() };
  });
{
  // Three months of bank statements, $5,000 a month against $60,000 a year: consistent.
  const q = addbackSupport({ annualAmount: 60000 }, monthly(5000, 2024, 3, 10));
  assert.equal(q.status, "matched");
  assert.equal(q.supported, 15000);
  assert.ok(Math.abs(q.claimed - 15000) < 200, String(q.claimed));
  assert.equal(q.periodMonths, 3);
  assert.equal(evidencedAmount({ verificationStatus: q.status, annualAmount: 60000, totalMatchedAmount: q.supported, claimedAmount: q.claimed }), 60000);
  // $900 a month for four months against $14,000 a year is partly supported — and the words say so.
  const part = addbackSupport({ annualAmount: 14000 }, monthly(900, 2024, 4, 1, "Vehicle"));
  assert.equal(part.status, "partial_match");
  assert.match(claimWords(14000, part.claimed), /^\$14,000 a year claimed \(\$4,\d{3} for the 4 months the ledger covers\)$/);
  // The whole ledger decides the period: 4 charges in a 12-month GL are compared with the year.
  const ledger = monthly(100, 2024, 12, 1, "Office");
  assert.equal(addbackSupport({ annualAmount: 14000 }, monthly(900, 2024, 4, 1, "Vehicle"), ledger).claimed, 14000);
  // An 18-month ledger (FY + YTD) and a 15-month ledger: pro-rated, matched.
  assert.equal(addbackSupport({ annualAmount: 120000, yearAmounts: { "2024": 120000, "2025": 120000 } }, [...monthly(10000, 2024, 12), ...monthly(10000, 2025, 6)]).status, "matched");
  assert.equal(addbackSupport({ annualAmount: 120000 }, monthly(10000, 2023, 15, 10)).status, "matched");
  // Two annual bonuses a year apart: two years' claim.
  const bonus = addbackSupport({ annualAmount: 20000 }, [{ date: "2023-12-20", amount: 20000 }, { date: "2024-12-20", amount: 20000 }]);
  assert.deepEqual(bonus, { status: "matched", supported: 40000, claimed: 40000 });
  ok("the claim is compared over the period the ledger covers (3 months → a quarter, 18 months → a year and a half)");
}
{
  // Above-market related-party rent: $12,000 out of $60,000 of rent paid.
  const ab = { id: "ab1", label: "Above-market related-party rent", category: "related_party", annualAmount: 12000, yearAmounts: { "2024": 12000 } };
  const txs = monthly(5000, 2024, 12) as unknown as ParsedTransaction[];
  const r = settleMatch(ab as never, { verificationStatus: "matched", matchedTransactionIndices: txs.map((_, i) => i), aiNotes: "Rent to holdco" }, txs, "doc1");
  assert.equal(r.verificationStatus, "exceeds_claim");
  assert.equal(r.totalMatchedAmount, 60000);
  assert.match(r.aiNotes, /portion of these payments/);
  const row = { ...ab, verificationStatus: r.verificationStatus, matchedTransactions: r.matchedTransactions, totalMatchedAmount: r.totalMatchedAmount, claimedAmount: r.claimedAmount };
  assert.equal(evidencedAmount(row), 12000);
  const line = addbackEvidenceLine(row);
  assert.match(line, /\$12,000 claimed as the add-back portion of \$60,000 paid/);
  assert.doesNotMatch(line, /partly supported|the rest is not evidenced/);
  // An older "matched" row whose transactions exceed the claim is re-read as exceeds_claim.
  assert.equal(withEvidence({ ...ab, verificationStatus: "matched", matchedTransactions: monthly(5000, 2024, 12) } as never).verificationStatus, "exceeds_claim");
  // The model judging the payments implausible still caps it at partial.
  const doubted = settleMatch(ab as never, { verificationStatus: "no_match", matchedTransactionIndices: txs.map((_, i) => i) }, txs, "doc1");
  assert.equal(doubted.verificationStatus, "partial_match");
  ok("support above the claim is 'a portion of these payments' (exceeds_claim), never 'partly supported — the rest is not evidenced'");
}

// ── F2-05: discovered portion add-backs keep the model's amount ─────────────────
{
  const rent = monthly(5000, 2024, 12) as unknown as ParsedTransaction[];
  const all = new Set(rent.map((_, i) => i));
  const portion = settleDiscovered({ id: "ab_1", label: "Above-market rent to related party", category: "related_party", annualAmount: 12000,
    yearAmounts: { "2024": 12000 }, matchedTransactionIndices: rent.map((_, i) => i), aiNotes: "Market rent ~$4,000/mo" }, rent, all);
  assert.equal(portion.annualAmount, 12000);
  assert.equal(portion.verificationStatus, "exceeds_claim");
  assert.equal(portion.totalMatchedAmount, 60000);
  assert.equal(evidencedAmount(portion as never), 12000);
  const vehicle = monthly(1500, 2024, 12, 1, "Vehicle") as unknown as ParsedTransaction[];
  const half = settleDiscovered({ label: "Personal use of company vehicle (50%)", category: "discretionary", annualAmount: 9000,
    matchedTransactionIndices: vehicle.map((_, i) => i) }, vehicle, new Set(vehicle.map((_, i) => i)));
  assert.equal(half.annualAmount, 9000);
  assert.equal(half.verificationStatus, "exceeds_claim");
  // A whole account named is the add-back: its transactions' total, summed in code.
  const salary = monthly(10000, 2024, 12, 1, "Owner salary") as unknown as ParsedTransaction[];
  const whole = settleDiscovered({ label: "Owner's salary", category: "owner_compensation", annualAmount: 100000, accounts: ["Owner salary"],
    matchedTransactionIndices: [0, 1] }, salary, new Set([0, 1]));
  assert.equal(whole.annualAmount, 120000);
  assert.equal(whole.verificationStatus, "matched");
  assert.equal(whole.matchedTransactions.length, 12);
  // An amount close to the cited payments is the same figure, summed in code.
  const close = settleDiscovered({ label: "Owner's salary", category: "owner_compensation", annualAmount: 118000,
    matchedTransactionIndices: salary.map((_, i) => i) }, salary, new Set(salary.map((_, i) => i)));
  assert.equal(close.annualAmount, 120000);
  assert.equal(close.verificationStatus, "matched");
  ok("'above-market rent' $12,000 and 'personal use (50%)' $9,000 keep their amounts; a named account takes its code total");
}

// ── F2-06: an Opco and a Holdco are two statements ──────────────────────────────
{
  const is = (periods: string[], lines: Array<[string, string, number[]]>, extra: Partial<ExtractedStatement> = {}): ExtractedStatement => ({
    statementType: "income_statement", periods, currency: "CAD", sourceDocumentId: "d", confidence: 0.9, notes: [],
    lineItems: lines.map(([label, category, vals]) => ({ label, category, amounts: Object.fromEntries(periods.map((p, i) => [p, vals[i]])) })) as never,
    ...extra,
  });
  const std = (v: number): Array<[string, string, number[]]> => [["Revenue", "revenue", [v]], ["Cost of sales", "cogs", [v * 0.6]], ["Gross profit", "gross_profit", [v * 0.4]], ["Net income", "net_income", [v * 0.1]]];
  const holdco: Array<[string, string, number[]]> = [["Revenue", "revenue", [240000]], ["Cost of sales", "cogs", [0]], ["Gross profit", "gross_profit", [240000]], ["Mortgage interest", "interest", [60000]], ["Net income", "net_income", [120000]]];
  // Same year, standard labels, no company named: their amounts disagree.
  const same = combinePartStatements([[is(["2024"], std(9.7e6))], [is(["2024"], holdco)]]);
  assert.equal(same.length, 2);
  assert.ok(!same[0].lineItems.some((l) => l.label === "Mortgage interest"));
  // Different years, companies named.
  const named = combinePartStatements([[is(["2023"], std(3e6), { entity: "Lakeshore Home Comfort Ltd." })], [is(["2024"], holdco.map(([l, c, v]) => [l, c, v.map((x) => x * 8)] as [string, string, number[]]), { entity: "Bayfront Holdings Inc." })]]);
  assert.equal(named.length, 2);
  // Different years, no company named, a tenfold revenue gap.
  assert.equal(combinePartStatements([[is(["2023"], std(9.7e6))], [is(["2024"], holdco)]]).length, 2);
  // The same company's years (named with and without "Ltd.") still become one statement.
  const one = combinePartStatements([[is(["2022"], std(8e6), { entity: "Lakeshore Home Comfort Ltd." })], [is(["2023"], std(9e6), { entity: "Lakeshore Home Comfort" })], [is(["2024"], std(9.7e6))]]);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].periods, ["2022", "2023", "2024"]);
  // The overlap between parts (the same year, the same amounts) is one statement.
  assert.equal(combinePartStatements([[is(["2023", "2024"], std(9e6).map(([l, c, v]) => [l, c, [v[0], v[0] * 1.1]] as [string, string, number[]]))], [is(["2024"], std(9.9e6))]]).length, 1);
  ok("a Holdco's statement read in another part is never merged into the Opco's (by company, same-year amounts, or a tenfold revenue gap)");
}

console.log("f2-finance-facts-r2: all passed");
