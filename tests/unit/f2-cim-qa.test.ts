/**
 * Free round 2 — C4: buyer Q&A answers the AI wrote from the CIM were given
 * to later buyers after the CIM changed (a corrected revenue figure, a
 * section hidden or made full-access, a regenerate or a held CIM).
 */
import assert from "node:assert/strict";
import { answerStillHolds, isUnreviewedAiAnswer } from "../../server/qa/cim-context";

const ASKED = new Date("2026-09-20T10:00:00Z");
const ai = (answer: string, o: Record<string, unknown> = {}) => ({
  aiAnswer: answer, publishedAnswer: answer, brokerDraft: null, sellerApproved: false, createdAt: ASKED, updatedAt: ASKED, ...o,
}) as any;
const cim = (text: string, changedAt: Date | null = new Date("2026-09-19T00:00:00Z"), held = false) => ({ text, changedAt, held });

const revenue = ai("2024 revenue was $2.3M.");
// The CIM still says it, unchanged since → still given.
assert.equal(answerStillHolds(revenue, cim("## Financial summary\nRevenue FY2024: $2,300,000")), true);
// The broker resolved the discrepancy and regenerated: the CIM now says $1.82M.
assert.equal(answerStillHolds(revenue, cim("## Financial summary\nRevenue FY2024: $1,820,000", new Date("2026-09-25T00:00:00Z"))), false);
// Even if the timestamps were unhelpful, a figure the CIM no longer shows withdraws it.
assert.equal(answerStillHolds(revenue, cim("## Financial summary\nRevenue FY2024: $1,820,000", null)), false);
// Customer concentration answered for a teaser; the section is now full-access only (not in the teaser's text).
const conc = ai("The largest customer accounts for 22% of revenue and the top five for 47%.");
assert.equal(answerStillHolds(conc, cim("## Overview\nA regional carrier.")), false);
assert.equal(answerStillHolds(conc, cim("## Customers\nLargest customer 22%; top five 47%.")), true);
// Any change to the CIM after the answer withdraws an unreviewed answer without figures too.
const words = ai("The owner will stay on for a six-month transition.");
assert.equal(answerStillHolds(words, cim("transition", new Date("2026-09-21T00:00:00Z"))), false);
assert.equal(answerStillHolds(words, cim("transition")), true);
// A held CIM gives out no AI answers at all.
assert.equal(answerStillHolds(conc, cim("## Customers\nLargest customer 22%; top five 47%.", null, true)), false);

// Reviewed answers are the broker's word: kept whatever the CIM says.
assert.equal(isUnreviewedAiAnswer(ai("x", { brokerDraft: "x" })), false);
assert.equal(isUnreviewedAiAnswer(ai("x", { sellerApproved: true })), false);
assert.equal(isUnreviewedAiAnswer(ai("x", { publishedAnswer: "Edited by the broker" })), false);
assert.equal(answerStillHolds(ai("2024 revenue was $2.3M.", { publishedAnswer: "Revenue was $2.3M in 2024 (broker-confirmed)." }), cim("Revenue $1,820,000", new Date())), true);
// A broker who re-publishes an answer after the change makes it current again.
assert.equal(answerStillHolds(ai("2024 revenue was $1.82M.", { updatedAt: new Date("2026-09-26T00:00:00Z") }), cim("Revenue FY2024: $1,820,000", new Date("2026-09-25T00:00:00Z"))), true);

console.log("f2-cim-qa: ok");
