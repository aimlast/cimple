// Extraction guard: derived metrics (SDE, EBITDA, add-backs, working capital,
// margins) are kept only when the source prints them; calculations, counts
// holding dollars and NAICS-as-industry are dropped. Fixtures are the values
// the extractor actually stored on the seeded demo deals (Beacon Pharmacy,
// Clearwater Physio, Lakeshore Home Comfort, Ridgeline Metal).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/extraction-guard.test.ts
import assert from "node:assert/strict";
import { guardExtraction, isDerivedMetricKey, isCountKey, onlyCurrency, looksComputed, STATED_METRIC_NOTE } from "../../server/documents/extraction-guard";
import { normaliseExtraction, mergeExtractedData } from "../../server/documents/extractor";
import { getFieldSources } from "../../server/interview/info-merger";
import { overlayExistingFacts } from "../../server/documents/reprocess";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

// A compiled statement: line items, no SDE / EBITDA / add-back wording anywhere.
const STATEMENT = `Beacon Specialty Pharmacy Inc. Statement of Income, year ended December 31, 2024 (unaudited — see Notice to Reader)
Sales: Dispensary 8,117,100  Front store 638,400  Professional services and fees 364,900  Total 9,120,400
Cost of sales 6,098,300   Gross profit 3,022,100
Salaries and wages 1,328,600   Management salary to shareholder 185,000   Amortization 72,740   Interest on long-term debt 11,361
Income before income taxes 576,151   Income taxes 79,423   Net income 496,728
Dividends paid 400,000`;

// Beacon — FY2024 compilation (stored extractedData, abridged)
const BEACON_FY2024 = {
  sde2023: "$730,870",
  sde2024: "$845,252",
  ebitda2023: "$550,870",
  ebitda2024: "$660,252",
  addbacks2024: "Management salary to shareholder $185,000, Amortization $72,740, Interest $11,361, Spouse salary $42,000 (if considered addback), Total key addbacks: $311,101",
  workingCapital2024: "$841,410",
  grossProfitMargin2024: "33.1%",
  netIncome2024: "$496,728",
  grossProfit2024: "$3,022,100",
  amortization2024: "$72,740",
  interestExpense2024: "$11,361",
  managementSalaryShareholder2024: "$185,000",
  revenueByYear: { "2023": "$8,640,200", "2024": "$9,120,400" },
  keyFinancialNotes: "Revenue growth of 5.6% year-over-year (2023 to 2024). EBITDA calculated as net income plus interest, taxes, depreciation and amortization. SDE (Seller's Discretionary Earnings) adds back owner management salary. Compounding grew 11.8%.",
  _privateNotes: ["Personal guarantee of shareholder"],
};

// Beacon — FY2023 compilation / T2
const BEACON_FY2023 = {
  sde: "$743,870 (2023) - calculated as EBITDA $550,870 plus Management salary to shareholder $180,000 plus Shareholder spouse salary $42,000 minus reasonable manager replacement salary (not specified)",
  ebitda: "$550,870 (2023) - calculated as Income Before Income Taxes $470,679 plus Amortization $67,000 plus Interest $13,191",
  netIncome: "$414,656 (2023), $358,236 (2022)",
  grossProfit: "$2,816,700 (2023), $2,618,100 (2022)",
};
const BEACON_T2_2023 = {
  ownerSalary2023: "Included in $1,442,300 salaries and wages (management salary component not separately stated)",
  salariesAndWages2023: "$1,442,300",
  industry: "456110 — Pharmacies and drug stores (NAICS)",
};
const BEACON_T2_2024 = {
  ebitda2024: "$648,891 (net income $496,728 + taxes $79,423 + interest $11,361 + amortization $72,740 - non-deductible meals $1,600 + donations $6,000)",
  businessType: "Pharmacies and drug stores (NAICS 456110)",
  netIncome2024: "$496,728 (after taxes)",
};

// Clearwater — compiled statements
const CLEARWATER_FY2023 = {
  sde: "$537,300 (2023 calculation: Net income $243,122 + Shareholder salary $180,000 + Interest $18,900 + Amortization $64,500 + Income taxes $30,778), $410,000 (2022: $141,460 + $180,000 + $21,600 + $67,900 + $18,040)",
  ebitda: "$357,300 (2023 calculation: Income before taxes $273,900 + Interest $18,900 + Amortization $64,500), $249,000 (2022: $159,500 + $21,600 + $67,900)",
  netIncome: "$243,122 (2023), $141,460 (2022)",
};
const CLEARWATER_FY2024 = {
  sde2024: "Approximately $606,100 (calculated as net income $310,796 plus shareholder salary $180,000 plus interest $14,300 plus amortization $61,800 plus income taxes $39,204)",
  ebitda2024: "Approximately $426,100 (calculated as income before taxes $350,000 plus amortization $61,800 plus interest $14,300)",
  interestExpense2024: "$14,300",
};
// Clearwater's location P&L report DOES print EBITDA.
const LOCATION_REPORT = `Hillhurst location EBITDA (after shared overhead allocation),449851
Seton location EBITDA (after shared overhead allocation),-23751
LOCATION EBITDA,449851,-23751,426100`;

(async () => {
  // ── 1. Key classification ──
  for (const k of ["sde", "sde2024", "ebitda2023", "adjustedEbitda", "addbacks2024", "workingCapital2024", "grossProfitMargin2024", "fy2024Ebitda", "hillhurstEbitda2024", "ownerBenefit"]) {
    assert.ok(isDerivedMetricKey(k), `${k} is derived`);
  }
  for (const k of ["netIncome2024", "grossProfit", "revenue", "amortization2024", "interestExpense", "ownerSalary", "leaseDetails", "debtDetails"]) {
    assert.ok(!isDerivedMetricKey(k), `${k} is a line item`);
  }
  assert.ok(isCountKey("fleetSize") && isCountKey("vehicleCount") && isCountKey("employees") && isCountKey("numberOfLocations"));
  assert.ok(!isCountKey("averageTicketSize") && !isCountKey("leaseSqft") && !isCountKey("dealSize"));
  assert.ok(onlyCurrency("Motor vehicles valued at $1,318,000 gross, $606,000 net book value"));
  assert.ok(!onlyCurrency("14 service vans ($1.3M gross)"));
  assert.ok(!looksComputed("Base rent $9,700 plus HST per month"), "a rent with HST is stated, not a sum");
  assert.ok(looksComputed("$648,891 (net income $496,728 + taxes $79,423)"));
  ok("keys: derived metrics, line items and counts are told apart");

  // ── 2. Beacon FY2024: the statement never says SDE / EBITDA / add-back → none survive; line items stay ──
  {
    const out = normaliseExtraction(BEACON_FY2024, STATEMENT) as Record<string, unknown>;
    for (const k of ["sde2023", "sde2024", "ebitda2023", "ebitda2024", "addbacks2024", "workingCapital2024", "grossProfitMargin2024"]) {
      assert.equal(out[k], undefined, `${k} dropped`);
    }
    assert.equal(out.netIncome2024, "$496,728");
    assert.equal(out.grossProfit2024, "$3,022,100");
    assert.equal(out.amortization2024, "$72,740");
    assert.equal(out.managementSalaryShareholder2024, "$185,000");
    assert.deepEqual(out.revenueByYear, { "2023": "$8,640,200", "2024": "$9,120,400" });
    // A company transaction filed as a private note is the business fact it is (round 2).
    assert.equal(out._privateNotes, undefined);
    assert.equal(out.personalGuarantees, "Personal guarantee of shareholder");
    const notes = String(out.keyFinancialNotes);
    assert.ok(!/EBITDA calculated/.test(notes), "the EBITDA calculation sentence is gone");
    assert.ok(/Revenue growth of 5\.6%/.test(notes) && /Compounding grew/.test(notes), "the rest of the note stays");
    assert.equal(out._statedMetrics, undefined, "nothing flagged as stated");
  }
  ok("Beacon FY2024: no SDE, EBITDA, add-backs, working capital or margin from a statement that prints none");

  // ── 3. 'calculated as' values go even without the source text; line items and NAICS handled ──
  {
    const fy23 = normaliseExtraction(BEACON_FY2023) as Record<string, unknown>;
    assert.equal(fy23.sde, undefined);
    assert.equal(fy23.ebitda, undefined);
    assert.equal(fy23.netIncome, "$414,656 (2023), $358,236 (2022)");
    const t2 = normaliseExtraction(BEACON_T2_2023, "T2 ... Salaries and wages 1,442,300 ... NAICS 456110") as Record<string, unknown>;
    assert.equal(t2.ownerSalary2023, undefined, "'Included in $1,442,300' is not a salary");
    assert.equal(t2.salariesAndWages2023, "$1,442,300");
    assert.equal(t2.industry, undefined, "NAICS text is not the industry");
    assert.equal(t2.naicsCode, "456110 — Pharmacies and drug stores (NAICS)");
    const t24 = normaliseExtraction(BEACON_T2_2024, "T2 2024 net income 496,728 NAICS 456110") as Record<string, unknown>;
    assert.equal(t24.ebitda2024, undefined);
    assert.equal(t24.businessType, undefined);
    assert.equal(t24.naicsCode, "Pharmacies and drug stores (NAICS 456110)");
  }
  ok("Beacon FY2023 / T2: calculated SDE/EBITDA and 'included in' salary dropped, NAICS → naicsCode");

  // ── 4. Clearwater: calculated SDE / EBITDA dropped, the report's printed EBITDA kept and flagged ──
  {
    const fy23 = normaliseExtraction(CLEARWATER_FY2023, "Net income 243,122 ...") as Record<string, unknown>;
    assert.equal(fy23.sde, undefined);
    assert.equal(fy23.ebitda, undefined);
    assert.equal(fy23.netIncome, "$243,122 (2023), $141,460 (2022)");
    const fy24 = normaliseExtraction(CLEARWATER_FY2024, "Interest 14,300 ...") as Record<string, unknown>;
    assert.equal(fy24.sde2024, undefined);
    assert.equal(fy24.ebitda2024, undefined);
    assert.equal(fy24.interestExpense2024, "$14,300");
    const report = normaliseExtraction({ ebitda: "$426,100 (FY2024)", hillhurstEbitda2024: "$449,851", sde: "$606,100" }, LOCATION_REPORT) as Record<string, unknown>;
    assert.equal(report.ebitda, "$426,100 (FY2024)", "a printed EBITDA is kept");
    assert.equal(report.hillhurstEbitda2024, "$449,851", "a printed location EBITDA is kept");
    assert.equal(report.sde, undefined, "the report never says SDE");
    assert.equal(report._statedMetrics, "ebitda,hillhurstEbitda2024");
    // …and the fact it becomes says it was stated, not calculated.
    const merged = mergeExtractedData({}, report as any, { documentId: "doc-report", source: "document" });
    assert.equal(merged.ebitda, "$426,100 (FY2024)");
    assert.equal(getFieldSources(merged).ebitda?.note, STATED_METRIC_NOTE);
    assert.equal(merged._statedMetrics, undefined, "bookkeeping never becomes a fact");
  }
  ok("Clearwater: calculated SDE/EBITDA dropped; the location report's printed EBITDA kept and flagged as stated");

  // ── 5. A statement fixture without the word SDE yields no sde key, whatever the model wrote ──
  {
    const out = guardExtraction({ sde: "$845,252", netIncome: "$496,728" }, STATEMENT);
    assert.equal(out.data.sde, undefined);
    assert.equal(out.data.netIncome, "$496,728");
    assert.ok(out.dropped.some((d) => d.key === "sde"));
    // A broker recast that prints SDE keeps it.
    const recast = guardExtraction({ sde: "$845,252" }, "Seller's discretionary earnings (SDE) 2024: $845,252");
    assert.equal(recast.data.sde, "$845,252");
    // …but not a different figure than the one it prints.
    const wrong = guardExtraction({ sde: "$900,000" }, "SDE 2024: $845,252");
    assert.equal(wrong.data.sde, undefined);
  }
  ok("statement without 'SDE' → no sde; a recast that prints SDE keeps exactly that figure");

  // ── 6. Lakeshore: a count holding a dollar amount; Ridgeline: stray 'ebitda' in prose ──
  {
    const lake = normaliseExtraction({ fleetSize: "Motor vehicles valued at $1,318,000 gross", vehiclesCost: "$1,318,000 gross" }, "Class 10 motor vehicles 1,318,000") as Record<string, unknown>;
    assert.equal(lake.fleetSize, undefined, "no fleetSize from a dollar value");
    assert.equal(lake.vehiclesCost, "$1,318,000 gross");
    assert.equal((normaliseExtraction({ fleetSize: "22 service vans" }, "22 service vans") as any).fleetSize, "22 service vans");
    const ridge = normaliseExtraction(
      { businessDescription: "Custom structural and miscellaneous steel fabricator and welding contractor serving the oil & gas, ebitda agricultural and commercial construction sectors" },
      "Custom structural steel fabricator serving the oil & gas, agricultural and commercial construction sectors",
    ) as Record<string, unknown>;
    assert.equal(ridge.businessDescription, "Custom structural and miscellaneous steel fabricator and welding contractor serving the oil & gas, agricultural and commercial construction sectors");
  }
  ok("Lakeshore fleetSize-as-dollars dropped; Ridgeline stray 'ebitda' removed from the description");

  // ── 6b. Plain statements that merely use the words stay; spoken figures are the seller's ──
  {
    const out = normaliseExtraction({
      revenueStreams: "Revenue derived from LTC homes (30%) and community Rx",
      transitionPlan: "Owner will stay 6 months; implied handover to the pharmacist-manager",
      commissionTerms: "Commission calculated on gross sales",
      rent: "$9,700 plus HST per month",
    }, "Revenue derived from LTC homes ... 9,700 plus HST") as Record<string, unknown>;
    assert.ok(out.revenueStreams && out.transitionPlan && out.commissionTerms && out.rent, "none dropped");
    // Seen on the Pacific re-extraction: a tax-return line isn't SDE; a related-party fact that
    // mentions a total it sits inside is still a stated fact; the source's own red flags stay whole.
    assert.ok(!isDerivedMetricKey("ccaDiscretionaryClaim"));
    const pac = normaliseExtraction({
      relatedPartyTransactions: "Due from related parties $330,000; rental expense for the related-party yard included in $2,433,500 total rent",
      facilitySquareFootage: "28,000 sq ft (calculated from $336,000 annual rent at $12.00/sq ft)",
      redFlags: "EBITDA calculated by the broker differs from the statements, Alderbrook = 22% of revenue",
    }, "Due from related parties 330,000 ...") as Record<string, unknown>;
    assert.ok(pac.relatedPartyTransactions, "related-party fact kept");
    assert.equal(pac.facilitySquareFootage, undefined, "a square footage worked out from rent is not stated");
    assert.ok(pac.redFlags, "the source's red flags are kept whole");
    // A lease that prints the arithmetic itself states the figure.
    const lease = normaliseExtraction(
      { annualRent: "Years 1-2: $11.50 per sq ft per annum = $322,000.00 per annum" },
      "Basic rent: Years 1-2 (2022-2023): $11.50 per square foot per annum = $322,000.00 per annum",
    ) as Record<string, unknown>;
    assert.ok(lease.annualRent, "printed lease arithmetic kept");
    const call = "Seller: EBITDA last year was about seven-eighty adjusted, give or take.";
    const spoken = guardExtraction({ adjustedEbitda2024: "~$780,000 (seller's estimate)" }, call, { spoken: true });
    assert.equal(spoken.data.adjustedEbitda2024, "~$780,000 (seller's estimate)", "a seller naming EBITDA on a call is kept");
    const spokenNoTerm = guardExtraction({ sde: "~$900,000" }, "Seller: we clear about nine hundred after my salary", { spoken: true });
    assert.equal(spokenNoTerm.data.sde, undefined, "…but not a metric nobody named");
    assert.equal(guardExtraction({ ebitda: "$780,000 (calculated as net income + tax)" }, call, { spoken: true }).data.ebitda, undefined);
  }
  ok("plain wording kept; a seller's spoken EBITDA kept, an unnamed or calculated one dropped");

  // ── 7. Reprocess: a computed SDE a source row no longer yields is not carried over ──
  {
    const existing: Record<string, unknown> = {
      sde2024: "$845,252",
      netIncome2024: "$496,728",
      sde: "$690,000",
      _fieldSources: {
        sde2024: { source: "document", documentId: "fy24" },
        netIncome2024: { source: "document", documentId: "fy24" },
        sde: { source: "broker", at: "2026-09-20T00:00:00Z" },
      },
    };
    const fresh = mergeExtractedData({}, { netIncome2024: "$496,728" } as any, { documentId: "fy24", source: "document" });
    const rebuilt = overlayExistingFacts(fresh, existing);
    assert.equal(rebuilt.sde2024, undefined, "the calculated SDE is gone");
    assert.equal(rebuilt.sde, "$690,000", "the broker's SDE stays");
    assert.equal(rebuilt.netIncome2024, "$496,728");
  }
  ok("reprocess drops a calculated SDE the document no longer yields, keeps the broker's");

  console.log(`\n${n} extraction-guard checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
