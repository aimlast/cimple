/**
 * The broker's "✓ Confirmed" reaches the seller's AI interview, read-side only
 * (specs/together.md §7.6): a confirmed key's open "verify" / "reconcile"
 * ledger entries read as resolved, its confidence reads confirmed, and its
 * label says the seller confirmed it to the broker. A confirmation whose
 * value has since changed does nothing. Coverage numbers never move.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/kb-confirmed-overlay.test.ts
 */
import assert from "node:assert/strict";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";
import { confirmedKeys, valueHash } from "../../server/interview/coverage-board";

const info = {
  annualRevenue: "about $4.8M",
  leaseDetails: "Lease to 2029, two 5-year options",
  _fieldSources: { annualRevenue: { source: "interview" }, leaseDetails: { source: "call", documentId: "c1" } },
};
const deal: any = { id: "d1", businessName: "Test Heating Ltd", industry: "", subIndustry: null, extractedInfo: info, interviewPlan: null, interviewOutline: null, sectionImportance: null, questionnaireData: null, scrapedData: null };
const docs: any[] = [{ id: "c1", name: "Call with the owner", visibility: "shared", sourceKind: "call", extractedText: "", extractedData: null }];
const session: any = { id: "s1", status: "active", messages: [], extractedInfo: { _confidenceLevels: { annualRevenue: "approximate" } }, lastActivityAt: new Date() };

const marks = [
  { itemId: "financials:annualRevenue", kind: "confirmed", note: "annualRevenue", valueHash: valueHash("about $4.8M") },
  { itemId: "real_estate:leaseDetails", kind: "confirmed", note: "leaseDetails", valueHash: valueHash("an older value") },
];
const keys = confirmedKeys(marks, info);
assert.deepEqual(keys, ["annualRevenue"], "only a confirmation whose value still matches counts");

const plain = assembleKnowledgeBase(deal, docs, [], session, []);
const kb = assembleKnowledgeBase(deal, docs, [], session, [], { confirmedByBroker: keys });
assert.equal(kb.fieldConfidence?.annualRevenue, "confirmed", "confidence reads confirmed");
assert.equal(plain.fieldConfidence?.annualRevenue, "approximate");
assert.match(kb.factSourceLabels!.annualRevenue, /the seller confirmed it to the broker$/);
assert.doesNotMatch(kb.factSourceLabels!.leaseDetails ?? "", /confirmed it to the broker/, "a lapsed confirmation does nothing");
assert.deepEqual(kb.recordedCoverage, plain.recordedCoverage, "coverage numbers never move");
assert.deepEqual(kb.sectionCoverage, plain.sectionCoverage);

// The ledger's open check on that key reads as resolved; others stay.
const ledger = [
  { topic: "verify annualRevenue", reason: "the figure filed wasn't exactly what was said", whereInfoLives: "", createdAtTurn: 4 },
  { topic: "verify leaseDetails date", reason: "the year wasn't said", whereInfoLives: "", createdAtTurn: 5 },
];
kb.openDeferrals = ledger;
plain.openDeferrals = ledger;
const withOverlay = renderKnowledgeBaseForPrompt(kb);
const without = renderKnowledgeBaseForPrompt(plain);
assert.match(without, /verify annualRevenue/);
assert.doesNotMatch(withOverlay, /- \[turn 4\] verify annualRevenue/, "the confirmed key's check reads as resolved");
assert.match(withOverlay, /verify leaseDetails date/, "an unconfirmed key's check stays open");

console.log("✓ a confirmation reaches the interview read-side only; it lapses when the value changes; coverage never moves");
