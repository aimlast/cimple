/**
 * Discrepancy noise filter + the provenance-built check input.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/discrepancy-filter.test.ts
 */
import assert from "node:assert/strict";
import { filterDiscrepancyItems, dropReason, sidesEquivalent } from "../../server/cim/discrepancy-filter";
import { buildDiscrepancyInput } from "../../server/cim/discrepancy-engine";

const today = new Date("2026-09-25T12:00:00Z");
const item = (interviewValue: string, documentValue: string, field = "x") => ({ field, interviewValue, documentValue });

// ── Acceptance: equal values, unit equivalents, missing documents are dropped ──
{
  const { kept, dropped } = filterDiscrepancyItems(
    [
      item("$38,700", "$38,700", "coldbrookReceivableAmount"),
      item("$3,900/month", "$46,800/year", "strip packaging lease"),
      item("23", "23 employees", "employeeCount"),
      item("Change-of-control clause in the MSA", "no MSA uploaded to verify", "larkspurMSAChangeOfControl"),
      item("about a quarter", "41%", "Maplecrest share of LTC revenue"),
    ],
    today,
  );
  assert.deepEqual(kept.map((k) => k.interviewValue), ["about a quarter"], "only the real conflict survives");
  assert.deepEqual(dropped.map((d) => d.reason), ["equal", "equal", "equal", "missing_side"]);
}

// ── More of the seeding run's noise, and its real conflicts ──
{
  const drop = (a: string, b: string, f = "x") => dropReason(item(a, b, f), today);
  assert.equal(drop("110,000 square feet", "110,000 square feet", "warehouseSize"), "equal");
  assert.equal(drop("$8,000/month ($96,000 annually)", "$8,000/month ($96,000 annually)", "yardRentActual"), "equal");
  assert.equal(drop("42", "more than 40 / ~40", "employeeCount"), "equal", "hedged count within 10%");
  assert.equal(drop("Approximately 150 people", "148 total employees (96 drivers + 52 other staff)"), "equal");
  assert.equal(drop("Mei-Lin since 2018", "7.1 years", "Mei-Lin tenure"), "equal", "start year vs tenure");
  assert.equal(drop("adjusted EBITDA ~$780K", "EBITDA $648,891 per financial statements", "EBITDA 2024"), "adjusted_vs_reported");
  // kept
  assert.equal(drop("2034", "June 30, 2029", "Lease expiry"), null, "a different year is a conflict");
  assert.equal(drop("24 licensed technicians", "22 licensed technicians"), null);
  assert.equal(drop("Over 110 professional drivers", "96 drivers at December 31, 2024"), null);
  assert.equal(drop("~18% (approximately, under 20%)", "22.0% in FY2024", "Alderbrook revenue percentage"), null);
  assert.equal(drop("$2.3M", "$1,820,000", "annualRevenue"), null);
  assert.equal(drop("$4.1M (initial calculation) — call", "$3.9M (normalized) — workbook", "2024 Adjusted EBITDA"), null, "both adjusted: a real conflict");
  assert.equal(drop("EBITDA 2024: $1,204,900 (reported) with addbacks ~$150K", "Reported EBITDA 2024: $1,269,300"), null);
  assert.equal(drop("15 years", "since 2014", "Daniel's tenure"), null);
  assert.equal(drop("3,100 members", "2,900 active members as of March 31, 2025"), null);
  assert.ok(sidesEquivalent("$640/month", "$7,680/year"));
  assert.ok(sidesEquivalent("Aug 2027", "August 31, 2027"), "a day adds precision, not a conflict");
  assert.ok(sidesEquivalent("186 clients as of March 2025", "186 managed clients with 2,330 covered users"), "a year is not a quantity");
  assert.ok(!sidesEquivalent("August 2027", "August 2029"));
}

// ── Input from provenance: claims vs evidence, alternates as candidates ──
{
  const docs = [
    { id: "call1", name: "Intro call", category: "transcripts", sourceKind: "call", visibility: "shared", extractedText: "call text", extractedData: null },
    { id: "ltc", name: "LTC contracts summary", category: "operations", sourceKind: "document", visibility: "shared", extractedText: "Maplecrest portfolio ~41% of LTC revenue", extractedData: null },
    { id: "crm1", name: "CRM note — referral intake", category: "other", sourceKind: "crm", visibility: "broker_only", extractedText: "Lease to 2034", extractedData: null },
    { id: "lease", name: "Premises lease", category: "legal", sourceKind: "document", visibility: "shared", extractedText: "term ends June 30, 2029", extractedData: null },
  ];
  const info = {
    customerConcentration: "about a quarter",
    leaseExpiry: "2034",
    employees: "23",
    _fieldSources: {
      customerConcentration: { source: "call", documentId: "call1" },
      leaseExpiry: { source: "crm", documentId: "crm1" },
      employees: { source: "document", documentId: "ltc" },
    },
    _fieldAlternates: {
      customerConcentration: [{ value: "41%", source: "document", documentId: "ltc" }],
      leaseExpiry: [{ value: "June 30, 2029", source: "document", documentId: "lease" }],
      employees: [{ value: "23 employees", source: "interview" }],
    },
  };
  const input = buildDiscrepancyInput(info, docs);
  const c = input.candidates.find((x) => x.factKey === "customerConcentration");
  assert.ok(c, "the call's 'about a quarter' vs the document's 41% is a candidate");
  assert.equal(c!.claim.value, "about a quarter");
  assert.equal(c!.evidence.value, "41%");
  const refOf = (r: string) => input.refs.find((x) => x.ref === r)!;
  assert.equal(refOf(c!.claim.ref).kind, "call");
  assert.equal(refOf(c!.evidence.ref).documentId, "ltc");
  // A CRM value is a private claim — compared, never a document.
  const lease = input.candidates.find((x) => x.factKey === "leaseExpiry");
  assert.ok(lease && refOf(lease.claim.ref).cls === "private");
  // Equal values never become candidates ("23" vs "23 employees").
  assert.ok(!input.candidates.some((x) => x.factKey === "employees"));
  // Only shared documents are evidence: no transcript, no broker-only file.
  assert.deepEqual(input.evidenceDocs.map((d) => d.id).sort(), ["lease", "ltc"]);
  assert.ok(input.claims.some((e) => e.key === "customerConcentration"));
  assert.ok(input.evidence.some((e) => e.key === "employees"), "a document's winning fact is evidence, not a seller claim");
}

console.log("discrepancy-filter: ok");
