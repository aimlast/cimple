/**
 * Integration of findisc (discrepancy check / resolution) with facts1's
 * per-year provenance and merge discrepancies.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/findisc-facts-integration.test.ts
 */
import assert from "node:assert/strict";
import { buildDiscrepancyInput, isSameDiscrepancy, type CheckDocument } from "../../server/cim/discrepancy-engine";
import { applyResolutionToInfo } from "../../server/information/facts";
import { getFieldAlternates } from "../../server/interview/info-merger";
import { discrepancySideHeading } from "../../shared/discrepancy-sides";

const doc = (o: Partial<CheckDocument> & { id: string }): CheckDocument =>
  ({ name: o.id, category: "financial", extractedText: "text", extractedData: {}, sourceKind: "document", visibility: "shared", ...o }) as CheckDocument;

// ── Per-year entries are full FieldSources (facts1): each year keeps its own kind and privacy ──
{
  const info = {
    revenueByYear: { "2023": "$4,100,000", "2024": "$4,500,000" },
    _fieldSources: {
      revenueByYear: {
        source: "document",
        documentId: "fs23",
        years: {
          "2023": { source: "document", documentId: "fs23" },
          "2024": { source: "email", documentId: "em1" },
        },
      },
    },
  };
  const input = buildDiscrepancyInput(info, [
    doc({ id: "fs23", name: "FY2023 statements" }),
    doc({ id: "em1", name: "Email", sourceKind: "email", visibility: "broker_only", category: "correspondence" }),
  ]);
  const clsOf = new Map(input.refs.map((r) => [r.ref, r.cls]));
  const y23 = input.evidence.find((e) => e.key === "revenueByYear" && e.year === "2023");
  const y24 = input.privateClaims.find((e) => e.key === "revenueByYear" && e.year === "2024");
  assert.ok(y23, "the statements' year is evidence");
  assert.equal(clsOf.get(y23!.ref), "evidence");
  assert.ok(y24, "a broker-only email's year is a private claim, not document evidence");
}

// ── Older rows: a bare-id year on a map labelled the broker's reads as its document row ──
{
  const info = {
    ebitdaByYear: { "2023": "$920,600" },
    _fieldSources: { ebitdaByYear: { source: "broker", years: { "2023": "fs23" } } },
  };
  const input = buildDiscrepancyInput(info, [doc({ id: "fs23", name: "FY2023 statements" })]);
  assert.ok(input.evidence.some((e) => e.key === "ebitdaByYear" && e.year === "2023"), "bare id → its document row");
}

// ── A FieldSource stamped brokerOnly is private even without a documents row ──
{
  const info = {
    employeeCount: "42",
    _fieldSources: { employeeCount: { source: "email", brokerOnly: true } },
  };
  const input = buildDiscrepancyInput(info, []);
  assert.ok(input.privateClaims.some((e) => e.key === "employeeCount"));
  assert.ok(!input.claims.some((e) => e.key === "employeeCount"));
}

// ── The check re-finding a merge conflict on the by-year map is the same row ──
{
  const merge = { id: "m1", field: "EBITDA", status: "open", severity: "critical", factKey: "ebitda", factYear: null, interviewValue: "~$1.5M", documentValue: "$1,199,100" } as any;
  assert.ok(isSameDiscrepancy({ field: "EBITDA FY2024", factKey: "ebitdaByYear", factYear: "2024", interviewValue: "~$1.5M", documentValue: "$1,199,100" }, merge));
  // A different pair of values on another fact family is not.
  assert.ok(!isSameDiscrepancy({ field: "Lease expiry", factKey: "leaseExpiry", factYear: null, interviewValue: "2034", documentValue: "2029" }, merge));
}

// ── Resolving a merge row: a broker-only side stays broker-only as an alternate; a broker side keeps its kind ──
{
  const info: Record<string, unknown> = { ebitda: "$3.9M", _fieldSources: { ebitda: { source: "broker" } } };
  const row = {
    field: "EBITDA",
    source: "merge",
    factKey: "ebitda",
    factYear: null,
    interviewValue: "$3.55M",
    documentValue: "$3.9M",
    documentId: null,
    resolvedValue: "$3,720,000",
    sideSources: { interview: { kind: "email", documentId: "em1", brokerOnly: true }, document: { kind: "broker" } },
  } as any;
  assert.equal(applyResolutionToInfo(info, row), "ebitda");
  const alts = getFieldAlternates(info).ebitda ?? [];
  const email = alts.find((a) => a.value === "$3.55M");
  const broker = alts.find((a) => a.value === "$3.9M");
  assert.ok(email?.brokerOnly, "the broker-only email value stays broker-only");
  assert.equal(broker?.source, "broker", "the broker's earlier value is recorded as the broker's");
  assert.equal(discrepancySideHeading(row, "document"), "Your edit");
  assert.equal(discrepancySideHeading(row, "interview"), "Your private notes");
}

console.log("findisc-facts-integration: ok");
