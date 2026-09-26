// PRIV-V-5: a stored "on file" FACTS entry must stop quoting a value once
// the source it came from is made broker-only. Before the fix, onFileItems
// only checked that the fact key still had a value in the seller view, so
// "21 robots" (from document D) kept being shown to the interview as on file
// after D went broker-only and the view fell back to "about 18 robots".
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/rv-on-file-facts.test.ts
import assert from "node:assert/strict";
import { onFileItems, validateEvidence, type EvidenceTarget } from "../../server/interview/on-file-evidence";
import { sellerInterviewView } from "../../server/interview/seller-view";

const info: Record<string, unknown> = {
  robotCount: "21 robots",
  _fieldSources: { robotCount: { source: "document", documentId: "D" } },
  _fieldAlternates: { robotCount: [{ value: "about 18 robots", source: "document", documentId: "E" }] },
};
const shared = [
  { id: "D", name: "Press list", visibility: "shared", sourceKind: "document" },
  { id: "E", name: "Plant tour notes", visibility: "shared", sourceKind: "document" },
] as any[];
const target: EvidenceTarget = { id: "field:robotAutomationLevel", kind: "field", key: "robotAutomationLevel", label: "Robot automation level", sellerAccount: false };

// Build time: the model's FACTS answer, validated against the seller view.
const viewBefore = sellerInterviewView(info as any, shared);
const entries = validateEvidence(
  [{ id: "T1", status: "yes", sourceId: "FACTS", factKey: "robotCount", answer: "21 robots on file", quote: "21 robots" }],
  new Map([["T1", target]]),
  new Map(),
  viewBefore,
);
assert.equal(entries[target.id]?.factSourceId, "D", "the entry records where the fact came from");
const deal = { interviewEvidence: { version: 1, fingerprint: "x", computedAt: new Date().toISOString(), status: "ready", checked: [target.id], entries } };

// While D is shared, the entry stands.
assert.equal(onFileItems(deal, [target], { documents: shared, view: viewBefore }).length, 1);

// D made broker-only: the view shows E's value, and the entry quoting D's figure goes at once.
const nowPrivate = shared.map((d) => (d.id === "D" ? { ...d, visibility: "broker_only" } : d));
const viewAfter = sellerInterviewView(info as any, nowPrivate);
assert.match(String(viewAfter.robotCount), /18/, "the seller view falls back to the other value");
assert.deepEqual(onFileItems(deal, [target], { documents: nowPrivate, view: viewAfter }), [], "the stale entry is dropped");
console.log("✓ a fact entry goes when its source is made broker-only");

// An older entry without a recorded source: its figures must still be in the value on file.
{
  const legacy = { interviewEvidence: { ...deal.interviewEvidence, entries: { [target.id]: { answer: "21 robots on file", source: "on file as robotCount", sourceKind: "fact", factKey: "robotCount" } } } };
  assert.equal(onFileItems(legacy, [target], { documents: shared, view: viewBefore }).length, 1);
  assert.deepEqual(onFileItems(legacy, [target], { documents: nowPrivate, view: viewAfter }), []);
  console.log("✓ an older fact entry goes when the value on file no longer states its figures");
}

console.log("rv-on-file-facts: all passed");
