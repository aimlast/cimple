/**
 * Follow-up data points in the interview outline (specs/together.md §6.2, §7.6):
 * the seller's next AI session is told to raise them first — label and the
 * (screened) ask only; there is no note field to print, and a private board
 * note on the same item never reaches the prompt. Asked items drop out.
 * (The end-of-session screening of edited asks is tested with the summary, pass 2.)
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/follow-up-items.test.ts
 */
import assert from "node:assert/strict";
import { getInterviewOutline, openFollowUpItems, outlineHasContent, renderOutlineForPrompt } from "../../server/interview/outline";

const deal: any = {
  interviewOutline: {
    updatedAt: new Date().toISOString(), customTopics: [], excludedSections: [], emphasis: [], history: [],
    followUpItems: [
      { itemId: "seasonality:seasonality", key: "seasonality", sectionKey: "seasonality", label: "Busy and slow months", ask: "Which months are your busiest, and which are the quietest?", addedAt: new Date().toISOString(), sittingId: "T1", note: "PRIVATE: he hates winter" },
      { itemId: "employees:emrRating", key: "emrRating", sectionKey: "employees", label: "WSIB experience rating (EMR)", ask: "Do you know your current WSIB experience rating?", addedAt: new Date().toISOString(), askedAt: new Date().toISOString() },
    ],
  },
};
const outline = getInterviewOutline(deal);
assert.equal(openFollowUpItems(outline).length, 1, "an item already asked drops out");
assert.ok(outlineHasContent(outline), "open follow-ups make the outline block render");
const block = renderOutlineForPrompt(outline);
assert.match(block, /raise these first, one at a time, in this order: Busy and slow months — Which months are your busiest, and which are the quietest\?/);
assert.doesNotMatch(block, /PRIVATE|hates winter/, "no note text ever reaches the prompt");
assert.doesNotMatch(block, /WSIB/, "an asked follow-up isn't raised again");
const empty = getInterviewOutline({ interviewOutline: null } as any);
assert.equal(renderOutlineForPrompt(empty), "");
console.log("✓ follow-ups reach the seller's next session as label + ask only; asked ones drop out");
