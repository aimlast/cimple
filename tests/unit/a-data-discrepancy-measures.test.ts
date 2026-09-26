// ACC2-03: the one discrepancy check on the Ridgeline clone raised exactly two
// rows, both false — a per-year statement compared with another year's line
// of the same schedule, and a replacement cost compared with book / market
// values. These are the recorded rows (acc2/disc-check-ridge.json), replayed
// through the deterministic filter and through the check itself with the
// model's recorded output stubbed in.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/a-data-discrepancy-measures.test.ts
import assert from "node:assert/strict";
import { dropReason, periodYears, periodAlignment, moneyMeasures, differentMoneyMeasures } from "../../server/cim/discrepancy-filter";
import { falseConflictReason } from "../../server/documents/conflict-measures";
import { runDiscrepancyCheck, _setCheckModelForTests } from "../../server/cim/discrepancy-engine";

const concentration = {
  field: "Top 3 customer concentration (2022)",
  interviewValue: "Top 3 customers = 41% of 2024 revenue",
  documentValue: "FY2022: Top 3 customers 35.0% of revenue (Larkspur 15.5%, Prairie Crest 12.0%, Bowline 7.5%)",
  severity: "minor",
  aiExplanation: "The seller states top 3 customers represent 41% of 2024 revenue. The customer concentration document confirms this for 2024 (41.0%) but shows 35.0% for 2022, not 41%. The claim appears to conflate 2024 concentration with historical years. The 2022 figure of 35% is materially different from 41%.",
};
const brake = {
  field: "110-ton brake replacement cost estimate",
  interviewValue: "110-ton brake needs replacement in 1-2 years, estimated cost ~$180k",
  documentValue: "110-ton x 10 ft, 2-axis — due for replacement, $96,000 original cost, NBV $29,700, Est. FMV $38,000, Serviceable — replacement within 2 years",
  severity: "minor",
  aiExplanation: "The seller estimates replacement cost for the 110-ton brake at approximately $180,000. The equipment list shows the original cost was $96,000 and current estimated fair market value is $38,000, but does not provide a replacement cost estimate. The seller's $180k figure is nearly double the original cost, which may reflect current market pricing for new equipment, but the document does not confirm this estimate.",
};

// 1. The recorded false rows are dropped — each for its own reason, even without the model's words.
{
  assert.deepEqual(Array.from(periodYears(concentration.interviewValue)), ["2024"]);
  assert.deepEqual(Array.from(periodYears(concentration.documentValue)), ["2022"]);
  assert.equal(periodAlignment(concentration.interviewValue, concentration.documentValue), "different_periods");
  assert.equal(dropReason(concentration), "different_periods");
  assert.equal(dropReason({ ...concentration, aiExplanation: "" }), "different_periods", "the values alone decide");
  assert.deepEqual(moneyMeasures(brake.documentValue), ["book", "book", "market"]);
  assert.deepEqual(moneyMeasures(brake.interviewValue), ["replacement"]);
  assert.equal(dropReason(brake), "different_measures");
  assert.equal(dropReason({ ...brake, aiExplanation: "" }), "different_measures");
  console.log("✓ 41% of 2024 vs FY2022 35% → different periods; ~$180k replacement vs NBV/FMV → different measures");
}

// 2. The same pairs as the merge sees them (conflict-measures) are not disputes either.
{
  assert.ok(falseConflictReason("customerConcentration", { value: concentration.interviewValue, kind: "call" }, { value: concentration.documentValue, kind: "document" }));
  assert.ok(falseConflictReason("oldBrakeCondition", { value: brake.interviewValue, kind: "video_call" }, { value: brake.documentValue, kind: "document" }));
  console.log("✓ the merge's rules agree");
}

// 3. Aligned by year: the schedule's line for the seller's year decides.
{
  const schedule = "FY2022: Top 3 customers 35.0%; FY2023: Top 3 customers 39.0%; FY2024: Top 3 customers 41.0% of revenue";
  assert.equal(periodAlignment("Top 3 customers = 41% of 2024 revenue", schedule), "same");
  assert.equal(dropReason({ field: "Customer concentration", interviewValue: "Top 3 customers = 41% of 2024 revenue", documentValue: schedule }), "equal");
  assert.equal(periodAlignment("Top 3 customers = 48% of 2024 revenue", schedule), null, "the seller's year disagrees: a real conflict");
  assert.equal(dropReason({ field: "Customer concentration", interviewValue: "Top 3 customers = 48% of 2024 revenue", documentValue: schedule }), null);
  console.log("✓ the claim is compared with its own year's line: equal → dropped, different → kept");
}

// 4. Real conflicts still stand.
{
  const real = [
    { field: "Top 3 customer concentration", interviewValue: "Top 3 customers = 41% of 2024 revenue", documentValue: "FY2024: Top 3 customers 35.0% of revenue" },
    { field: "Customer concentration", interviewValue: "about a quarter of revenue", documentValue: "Maplecrest 41% of 2024 revenue" },
    { field: "Lease expiry", interviewValue: "Lease expires in 2034", documentValue: "Lease term to June 30, 2029, with an unexercised option to 2034" },
    { field: "Revenue (2024)", interviewValue: "$2.3M in 2024", documentValue: "FY2024 revenue $1,820,000" },
    { field: "Signed backlog (May 2025)", interviewValue: "$4.2M as of end of May 2025 — Seller statements (June 5, 2025 call)", documentValue: "$3.1M signed backlog — WIP & backlog report as of May 31, 2025" },
    { field: "Equipment value", interviewValue: "the equipment is worth about $900K", documentValue: "Appraised value $520,000 (fair market value)" },
    { field: "Press brake replacement", interviewValue: "replacing the brake will cost ~$180k", documentValue: "Quote for a new 110-ton brake: $142,000 (replacement cost)" },
  ];
  for (const r of real) assert.equal(dropReason(r as any), null, `kept: ${r.field}`);
  assert.ok(!differentMoneyMeasures(real[5].interviewValue, real[5].documentValue));
  console.log("✓ same-year, same-measure, date and share conflicts are kept");
}

// 5. Replay through the check: the model's recorded findings for Ridgeline, stubbed in.
{
  const info: any = {
    customerConcentration: "FY2024: Top 3 customers 41.0% of revenue (Larkspur 16.5%, Prairie Crest 14.0%, Bowline 10.5%)",
    oldBrakeCondition: "110-ton brake needs replacement in 1-2 years, estimated cost ~$180k",
    _fieldSources: {
      customerConcentration: { source: "document", documentId: "conc" },
      oldBrakeCondition: { source: "video_call", documentId: "teams" },
    },
    _fieldAlternates: {
      customerConcentration: [{ value: "Top 3 customers = 41% of 2024 revenue", source: "call", documentId: "call" }],
    },
  };
  const docs: any[] = [
    { id: "conc", name: "Customer concentration FY2022-FY2024", category: "financial", extractedText: "FY2022 Top 3 35.0%\nFY2023 Top 3 39.0%\nFY2024 Top 3 41.0%", sourceKind: "document", visibility: "shared" },
    { id: "equip", name: "Equipment & fixed asset list", category: "operations", extractedText: "110-ton x 10 ft press brake, original cost $96,000, NBV $29,700, Est. FMV $38,000", sourceKind: "document", visibility: "shared" },
    { id: "call", name: "Phone call — Morgan Ellis & Gord McAllister (discovery deep-dive)", category: "other", extractedText: "Gord: top three are about 41% of 2024 revenue.", sourceKind: "call", visibility: "shared" },
    { id: "teams", name: "Teams video call — operations", category: "other", extractedText: "Gord: the old brake will need replacing, maybe 180 grand.", sourceKind: "video_call", visibility: "shared" },
  ];
  _setCheckModelForTests(async (_system, user) => {
    const ref = (name: string) => (user.match(new RegExp(`- (S\\d+): [^\\n]*${name}`)) ?? [])[1];
    return {
      discrepancies: [
        { relation: "conflict", field: concentration.field, factKey: "customerConcentration", claimValue: concentration.interviewValue, claimSource: ref("Phone call"), evidenceValue: concentration.documentValue, evidenceSource: ref("Customer concentration"), severity: "minor", category: "factual", explanation: concentration.aiExplanation, suggestedResolution: "Clarify the trend." },
        { relation: "conflict", field: brake.field, factKey: "oldBrakeCondition", claimValue: brake.interviewValue, claimSource: ref("Teams video call"), evidenceValue: brake.documentValue, evidenceSource: ref("Equipment"), severity: "minor", category: "operational", explanation: brake.aiExplanation, suggestedResolution: "Obtain a quote." },
      ],
      dismissedCandidates: [],
      clearedIds: [],
    };
  });
  const out = await runDiscrepancyCheck({ id: "D", businessName: "Ridgeline", extractedInfo: info }, docs);
  _setCheckModelForTests(null);
  assert.equal(out.items.length, 0, `no rows: ${out.items.map((i) => i.field).join(", ")}`);
  assert.equal(out.dropped, 2);
  console.log("✓ the recorded check output raises no rows");
}

console.log("a-data-discrepancy-measures: all passed");
