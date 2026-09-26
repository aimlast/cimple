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
import { blindBrief, blindFreeText, briefTerms, scrubProperNames } from "../../server/matching/external-acquirers";

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

/**
 * 2. misc's outside-buyer research brief is built on c-blind-render's blind
 *    guard. The guard now carries registry terms (a licence/permit number from
 *    the facts, and a built-in "any labelled identifier" check): the brief must
 *    strip those numbers or leave the line out — never send one to a web
 *    search. And the brief's proper-name net (used when the AI rewrite is
 *    unavailable) keeps a region wider than a province ("the Midwest",
 *    "Atlantic Canada") — c-blind-render's isBroadRegionWord — while a
 *    customer named after one ("Midwest Plastics") is still scrubbed.
 */
{
  const deal: any = {
    id: "x", businessName: "Pacific Coast Logistics Ltd.", industry: "Transportation & Logistics", subIndustry: "Regional trucking and warehousing",
    blindCodename: "Project Coastline",
    extractedInfo: {
      businessType: "Regional LTL and truckload carrier with a cross-dock in Delta, BC; NSC BC 20-487-316 Satisfactory rating; USDOT 9318842 for cross-border lanes",
      safetyCertificate: "NSC BC 20-487-316 (Satisfactory)",
      usdotNumber: "USDOT 9318842",
      address: "19220 River Road, Delta, British Columbia V4G 1B2",
      annualRevenue: "$31,250,000",
    },
  };
  const terms = briefTerms(deal);
  assert.ok(terms.some((t: any) => t.kind === "registry" && t.anyRegistryId), "the guard's built-in registry check reaches the brief");
  const { brief } = blindBrief(deal);
  assert.ok(!/20-487-316|20487316|9318842/.test(brief), brief);
  assert.ok(/Satisfactory/.test(brief), "the credential stays, without its number");
  // A number the facts don't hold is still caught by the built-in check: the line is left out.
  assert.equal(blindFreeText("Holds Licence No. 44721 for the yard", terms), null);
  // Dates are not registry numbers (c-blind-render's precision fix holds here too).
  assert.equal(blindFreeText("Operating permit renewed on 2021-03-01", terms), "Operating permit renewed on 2021-03-01");

  assert.equal(scrubProperNames("Injection moulding for automotive tier-1s across the Midwest", "a named client"), "Injection moulding for automotive tier-1s across the Midwest");
  assert.equal(scrubProperNames("Dental IT across Atlantic Canada and the Maritime provinces", "a named client"), "Dental IT across Atlantic Canada and the Maritime provinces");
  assert.equal(scrubProperNames("Parts for Midwest Plastics and Kestrel Tooling", "a named client"), "Parts for a named client");
}

console.log("v-integ-step3: all checks passed");
