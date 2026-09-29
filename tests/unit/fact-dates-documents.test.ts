// Year stripping (fact-dates.ts) keeps a year a DOCUMENT states, and holds
// out a sentence that stripping would leave ambiguous (Lakeshore rebuild
// 2026-09-28: "renewed November 2024, valid until November 2025" printed as
// "renewed November, valid until November").
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/fact-dates-documents.test.ts
import assert from "node:assert/strict";
import { repairInferredYears, writtenMonthYear } from "../../server/cim/fact-dates";
import { assembleKnowledgeBase } from "../../server/cim/layout-engine";
import { writtenValuesFor } from "../../server/cim/generation-jobs";

const said =
  "It renews every year, we just renewed it in November, good till next November. Listen, that's one reason I want Dave to stay — he's the safety net for the licence.";
const fact =
  "TSSA contractor registration held by company (Lakeshore Home Comfort Ltd.), not owner personally. Two certificate holders required: Tony Moretti (G1) and Dave Kowalczyk (G1, since ~2010-11). Registration renewed November 2024, valid until November 2025. If owner exits, buyer needs to add a new G1 certificate holder or rely on Dave staying.";
const licence = "TSSA Fuels Contractor registration TSSA-FC 000417-2261 active, renews 2025-11-30. Certificate holders on file: A. Moretti (G1), D. Kowalczyk (G1)";

// Written dates a document can use.
assert.ok(writtenMonthYear(licence, 10, "2025"), "2025-11-30 is November 2025");
assert.ok(writtenMonthYear("expires Nov. 30, 2025", 10, "2025"));
assert.ok(writtenMonthYear("valid to 11/2025", 10, "2025"));
assert.ok(!writtenMonthYear(licence, 10, "2024"), "nothing states November 2024");
assert.ok(!writtenMonthYear("renews 2025-12-31", 10, "2025"));

// 1. Without the document: both years go, the sentence would read "renewed November, valid until November" — held.
{
  const r = repairInferredYears(fact, said)!;
  assert.ok(r, "a repair");
  assert.equal(r.held.length, 1);
  assert.match(r.held[0], /^Registration renewed November 2024, valid until November 2025\.$/);
  assert.doesNotMatch(r.text, /renewed November/, "never 'renewed November, valid until November'");
  assert.match(r.text, /Two certificate holders required/, "the rest of the fact stays");
  assert.match(r.text, /If owner exits/);
}

// 2. With the licence summary: November 2025 stays (the document's year); November 2024 can't be stripped
//    without leaving two Novembers in one sentence — held, never printed half-dated.
{
  const r = repairInferredYears(fact, said, licence)!;
  assert.equal(r.held.length, 1);
  assert.doesNotMatch(r.text, /renewed November\b(?! 2024)/);
}

// 3. A document stating BOTH years: nothing is stripped, nothing held.
{
  const both = `${licence}. Renewal certificate issued November 2024.`;
  assert.equal(repairInferredYears(fact, said, both), null);
}

// 4. The original case still works (Pacific: "in May" said, "May 2025" recorded): stripped, not held.
{
  const words = "We're promoting him to Assistant Shop Foreman in May to shadow Dale through the transition.";
  const r = repairInferredYears("Kevin Tran promoted to Assistant Shop Foreman in May 2025 to shadow Dale", words)!;
  assert.deepEqual(r.held, []);
  assert.match(r.text, /in May to shadow/);
  assert.equal(r.changes.length, 1);
}

// 5. The writer's knowledge base: the held sentence is out, and the broker is told why.
{
  const info = {
    tsaaLicenseStatus: fact,
    _fieldSources: { tsaaLicenseStatus: { source: "interview", sessionId: "s1", turn: 5, at: "2026-09-02T14:03:30.321Z" } },
    _fieldAlternates: { tsaaLicenseStatus: [{ value: licence, source: "document", brokerOnly: false, documentId: "d1" }, { value: "renews Nov 2024 (CRM)", source: "crm", brokerOnly: true }] },
  };
  const written = writtenValuesFor(info, "tsaaLicenseStatus");
  assert.match(written, /2025-11-30/);
  assert.doesNotMatch(written, /CRM/, "a broker-only value is never read");
  const kb = assembleKnowledgeBase({
    dealId: "d",
    businessName: "Lakeshore",
    industry: "HVAC",
    extractedInfo: info,
    factSourceWords: { tsaaLicenseStatus: { words: said, at: "2026-09-02T14:03:30.321Z", documentWords: written } },
    today: new Date("2026-09-28T12:00:00Z"),
  } as any);
  const text = (kb as any).text ?? (kb as any).knowledgeBase ?? JSON.stringify(kb);
  assert.doesNotMatch(text, /renewed November, valid until November/);
  assert.doesNotMatch(text, /Registration renewed/);
  assert.match(text, /Two certificate holders required/);
  const warnings: string[] = (kb as any).warnings ?? [];
  assert.ok(warnings.some((w) => /Held out of the CIM: "Tsaa License Status": "Registration renewed November 2024, valid until November 2025"\. The seller named the month but not the year/.test(w)), JSON.stringify(warnings));
}

console.log("fact-dates-documents: all passed");
