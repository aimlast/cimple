/**
 * Integration step 3 of QA-harvest round V (c-truth + c-blind-render + misc onto
 * f-merge / f-conflicts-notes / d-resolution / d-analysis).
 *
 * 1. c-truth's keep-out rules read the broker's private notes; f-conflicts-notes'
 *    notes review folds restatements of one matter into ONE note and keeps each
 *    source's own words in `wording` (on the entry or in `alsoFrom`). A source's
 *    "keep it out of the CIM" must still hold when the merged note's text
 *    doesn't repeat it.
 */
import assert from "node:assert/strict";
import { keepOutFromNotes, privateNoteTexts } from "../../server/cim/sensitive-facts";
import { keepOutCandidates } from "../../server/cim/keep-out";

const facts = {
  growthOpportunities:
    "Cooler expansion by up to 15,000 square feet; potential new contract with Harvest Lane Markets (independent Fraser Valley grocery chain, 26 stores) worth $2-2.5M/year starting late 2026",
  customerBase: "Largest customer Alderbrook Grocery Distributors (22%); Kestrel Building Supply",
};

// The review merged the CRM note and the call transcript's line into one note
// whose text dropped the instruction; the CRM source keeps its own words.
const merged: Record<string, unknown> = {
  ...facts,
  _brokerPrivateNotes: [
    {
      note: "Harvest Lane Markets RFP: shortlisted for the 26-store chain, about $2-2.5M a year from late 2026",
      documentId: "call-1",
      alsoFrom: [{ documentId: "crm-1", brokerOnly: true, wording: "Harvest Lane Markets RFP (26 stores, ~$2-2.5M/yr) marked CONFIDENTIAL — keep out of CIM" }],
    },
  ],
};
const texts = privateNoteTexts(merged);
assert.equal(texts.length, 2, "the note and the CRM source's own words");
assert.deepEqual(keepOutFromNotes(merged).names, ["Harvest Lane Markets"], "the source's keep-out holds after the merge");
assert.ok(keepOutCandidates(merged).some((c) => c.kind === "note" && /keep out of CIM/.test(c.text)), "the AI review sees the source's words too");

// A wording on the entry itself (the first source's words differ from the note's).
const own: Record<string, unknown> = {
  ...facts,
  _brokerPrivateNotes: [{ note: "Harvest Lane Markets RFP pending", wording: "Harvest Lane Markets RFP — confidential, do not share with buyers" }],
};
assert.deepEqual(keepOutFromNotes(own).names, ["Harvest Lane Markets"]);

// Unchanged for plain notes: identical wordings are not doubled, strings still read.
assert.deepEqual(privateNoteTexts({ _brokerPrivateNotes: ["A", { note: "B", wording: "b" }, { note: "C" }] }), ["A", "B", "C"]);
assert.deepEqual(keepOutFromNotes({ ...facts, _brokerPrivateNotes: [{ note: "Only Carol knows about the sale — keep it from staff" }] }).names, []);

console.log("v-integ-step3: all checks passed");
