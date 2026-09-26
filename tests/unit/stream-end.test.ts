// The model's end decision read from a partial tool call (stream-head.ts
// endSoFar), and the head's completeness around it (headSoFar), plus the
// non-forced goodbye text (turn-release.ts closingText).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/stream-end.test.ts
import assert from "node:assert/strict";
import { endSoFar, headSoFar } from "../../server/interview/stream-head";
import { closingText } from "../../server/interview/turn-release";
import { INTERVIEW_RESPONSE_TOOL } from "../../server/interview/response-schema";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };

// Every prefix of a full response, in schema order.
const full = JSON.stringify({
  message: "Thanks, Gord — everything you've shared is saved.",
  suggestedAnswers: [],
  shouldEnd: true,
  endReason: "All critical sections are covered",
  extractedFields: { a: { value: "x", confidence: "confirmed" } },
  reasoning: { nextIntent: "y".repeat(200) },
});

{
  // The schema itself: the end decision right after the chips, before the tail.
  const keys = Object.keys(INTERVIEW_RESPONSE_TOOL.input_schema.properties);
  assert.deepEqual(keys.slice(0, 7), ["message", "whyItMatters", "importance", "targetSection", "suggestedAnswers", "shouldEnd", "endReason"]);
  assert.equal(keys[7], "extractedFields");
  ok("schema order: message, labels, chips, end decision, then the tail");
}

{
  let knownAt = -1;
  for (let i = 1; i <= full.length; i++) {
    const e = endSoFar(full.slice(0, i));
    if (e.known && knownAt < 0) {
      knownAt = i;
      assert.equal(e.shouldEnd, true);
      assert.equal(e.endReason, "All critical sections are covered");
    }
  }
  assert.ok(knownAt > 0 && knownAt < full.indexOf('"extractedFields"') + 2, `known once its endReason closed (${knownAt})`);
  // "tru" is never read as a decision; true needs the following comma.
  assert.equal(endSoFar('{"message":"x","shouldEnd":tru').known, false);
  assert.equal(endSoFar('{"message":"x","shouldEnd":true').known, false);
  assert.equal(endSoFar('{"message":"x","shouldEnd":true,').known, false, "waits for its endReason");
  assert.deepEqual(endSoFar('{"message":"x","shouldEnd":true,"extractedFields":{'), { known: true, shouldEnd: true, endReason: undefined }, "no endReason: known once the tail starts");
  assert.deepEqual(endSoFar('{"message":"x","shouldEnd":false,'), { known: true, shouldEnd: false, endReason: undefined }, "false needs no reason");
  assert.equal(endSoFar('{"message":"x","suggestedAnswers":[],"extractedFields":{"a":1},').known, false, "a model that writes it last: not known yet");
  ok("endSoFar: known as soon as the decision (and its reason) is complete; never from a partial literal");
}

{
  // The end decision written before the chips does not end the head.
  const h1 = headSoFar('{"message":"Which loans?","shouldEnd":false,"suggestedAnswers":["All"');
  assert.equal(h1.complete, false, "the chips are still coming");
  const h2 = headSoFar('{"message":"Which loans?","shouldEnd":false,"suggestedAnswers":["All","Some"],');
  assert.equal(h2.complete, true);
  assert.deepEqual(h2.head.suggestedAnswers, ["All", "Some"]);
  const h3 = headSoFar('{"message":"Which loans?","extractedFields":{');
  assert.equal(h3.complete, true, "a tail field: nothing more of the head is coming");
  assert.equal(h3.head.suggestedAnswers, undefined);
  ok("headSoFar: the end decision beside the head doesn't close it; a tail field does");
}

{
  const ctx = { sellerMessage: "Nothing else.", jurisdiction: null, location: "Toledo, OH", sellerText: "Nothing else.", facts: [], today: new Date("2026-09-26") } as any;
  const bye = "Thanks, Gord — I'll follow up with Rob on the lease. Everything you've shared is saved.";
  const closed = closingText(bye, ctx, "Nothing else.", { forced: false, closing: true });
  assert.ok(closed && /[Yy]our broker will follow up with Rob/.test(closed), "a promise becomes the broker's");
  assert.equal(closingText("Thanks — which lease terms matter most?", ctx, "x", { forced: false }), null, "a question is never released as a goodbye");
  assert.equal(closingText("Thanks — the coverage map shows everything is filled.", ctx, "x", { forced: false }), null, "machinery: held for the rewrite");
  const forced = closingText("Thanks. Anything else before you go?", ctx, "x");
  assert.ok(forced && !/\?/.test(forced), "forced (default): the question goes");
  ok("closingText: non-forced goodbyes keep their text, never a question, never one a guard will rewrite");
}

process.stdout.write(`\n${n} groups passed\n`);
