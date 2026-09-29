// fact-dates round 2 (checker findings):
//  - abbreviated months ("Sept. 2024", "Nov. 30, 2024", "Dec. 2026") are
//    checked again — the sentence splitter no longer breaks at their dot;
//  - a written source stating the same date protects the year even when its
//    facts were filed under another key ("July 2023: acquired … Pembury"
//    under acquisitionHistory vs the interview fact pemburyAcquisition);
//    an unrelated sentence with the same month-year doesn't.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/fact-dates-r2.test.ts
import assert from "node:assert/strict";
import { documentSentencesDating, repairInferredYears } from "../../server/cim/fact-dates";
import { writtenSourceTexts } from "../../server/cim/generation-jobs";

// ── Abbreviated months ──
{
  const r = repairInferredYears("Lease renewed Sept. 2024 for five years.", "We renewed the lease in September for five years.");
  assert.ok(r, "checked");
  assert.equal(r!.text, "Lease renewed Sept. for five years.");
  const n = repairInferredYears("Registration renewed Nov. 30, 2024. Dave holds the G1.", "We renewed it in November.");
  assert.equal(n!.text, "Registration renewed Nov. 30. Dave holds the G1.");
  const d = repairInferredYears("Owner plans to retire Dec. 2026.", "I want to be out by December.");
  assert.equal(d!.text, "Owner plans to retire Dec.");
  // Said by the seller: kept.
  assert.equal(repairInferredYears("Lease renewed Sept. 2024.", "We renewed in September 2024."), null);
  // "Dr. Park" / "Ltd." don't split a sentence away from its date either.
  const t = repairInferredYears("Dr. Park bought the Ltd. pharmacy in June 2019.", "I bought it in June.");
  assert.equal(t!.text, "Dr. Park bought the Ltd. pharmacy in June.");
}

// ── A written source under another key ──
const fact = "Acquired 310 Comfort Club members from Pembury in July 2023 for $80,000; just contracts, no staff or equipment.";
const said = "We bought Ron's book at Pembury in July, about 310 members, eighty grand.";
const fsNotes = "Note 7. July 2023: acquired residential maintenance-agreement customer list (approximately 310 active agreements) of Pembury Furnace Services for cash consideration of $80,000.";
const unrelated = "July 2023: the company refinanced its equipment line with the bank.";
{
  // Without the document: the year is stripped (the seller never said it).
  assert.equal(repairInferredYears(fact, said)!.text, "Acquired 310 Comfort Club members from Pembury in July for $80,000; just contracts, no staff or equipment.");
  // With the financial-statement note (filed as acquisitionHistory): the year is the document's.
  const words = documentSentencesDating(fact, [fsNotes]);
  assert.match(words, /Pembury Furnace Services/);
  assert.equal(repairInferredYears(fact, said, words), null, "July 2023 kept");
  // A sentence with the same month-year about something else doesn't protect it.
  assert.equal(documentSentencesDating(fact, [unrelated]), "");
  assert.ok(repairInferredYears(fact, said, documentSentencesDating(fact, [unrelated])));
}

// ── Which sources count as written ──
{
  const texts = writtenSourceTexts([
    { sourceKind: "document", visibility: "shared", extractedText: "doc" },
    { sourceKind: null, visibility: null, extractedText: "legacy doc" },
    { sourceKind: "email", visibility: "shared", extractedText: "email" },
    { sourceKind: "questionnaire", visibility: "shared", extractedText: "sq" },
    { sourceKind: "document", visibility: "broker_only", extractedText: "private" },
    { sourceKind: "crm", visibility: "shared", extractedText: "crm" },
    { sourceKind: "video_call", visibility: "shared", extractedText: "call" },
    { sourceKind: "website", visibility: "shared", extractedText: "site" },
  ]);
  assert.deepEqual(texts, ["doc", "legacy doc", "email", "sq"]);
}

console.log("fact-dates-r2: ok");
