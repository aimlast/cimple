// Pure pieces of the interview's latency work (round A, ACC-INT-7):
// stream-head.ts (reading the seller-facing head of a partial tool call) and
// turn-release.ts (the stop state at the gate, a forced goodbye's final text,
// the opening fingerprint).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/turn-release.test.ts
import assert from "node:assert/strict";
import { headSoFar, topLevelEntries, withRewrittenHead } from "../../server/interview/stream-head";
import { closingText, forcedGoodbye, openingBasis, outputGuardProblems, resolveStopState, unansweredOpening } from "../../server/interview/turn-release";
import { normalizeInterviewResponse } from "../../server/interview/turn-guard";
import { buildPolishContext, polishMessage } from "../../server/interview/reply-polish";
import { scrubClosingPromises } from "../../server/interview/turn-guard";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };

// ── 1. The head of a partial tool call ──
{
  const full = {
    message: "How many of the \"customer-owned\" molds need work — say, in 2026?\nRoughly.",
    whyItMatters: "Buyers price the tooling they inherit.",
    importance: "important",
    targetSection: "operations",
    suggestedAnswers: ["About ten", "I'd have to check with Rob", "None, {really}"],
    extractedFields: { moldCount: { value: "15–18 owned", confidence: "confirmed", source: "seller_statement", basis: "verbatim" } },
    reasoning: { currentTopic: "operations", nested: { a: [1, 2, { b: "}]" }] } },
    shouldEnd: false,
  };
  const json = JSON.stringify(full);
  const at = (key: string) => json.indexOf(`"${key}"`);
  // Every prefix parses without throwing, and the head is complete exactly
  // once the chips have closed.
  const chipsEnd = at("extractedFields") - 1; // the comma after the chips array
  for (let i = 0; i <= json.length; i++) {
    const { head, complete } = headSoFar(json.slice(0, i));
    if (i < chipsEnd) assert.equal(complete, false, `not complete at ${i}`);
    else {
      assert.equal(complete, true, `complete at ${i}`);
      assert.equal(head.message, full.message);
      assert.equal(head.whyItMatters, full.whyItMatters);
      assert.deepEqual(head.suggestedAnswers, full.suggestedAnswers);
    }
  }
  // A scalar at the very end is never taken as complete ("tru" → "true").
  assert.deepEqual(topLevelEntries('{"message":"Hi?","shouldEnd":tru').entries, [["message", "Hi?"]]);
  assert.equal(topLevelEntries('{"message":"Hi?","shouldEnd":tru').open, "shouldEnd");
  assert.deepEqual(topLevelEntries('{"message":"Hi?","shouldEnd":true}').entries, [["message", "Hi?"], ["shouldEnd", true]]);
  // A model that skips the chips: the head is complete once a later field starts.
  assert.equal(headSoFar('{"message":"Where is the lease?","extractedFields":{').complete, true);
  assert.equal(headSoFar('{"message":"Where is the lease?","whyItMatters":"Buy').complete, false);
  // Nothing before the message.
  assert.equal(headSoFar('{"whyItMatters":"x","suggestedAnswers":["a"]').complete, false);
  // The head normalises like a full response (chip filter included).
  const r = normalizeInterviewResponse(headSoFar(json).head).response;
  assert.deepEqual(r.suggestedAnswers, ["About ten", "I'd have to check with Rob"], "template-token chip dropped");
  ok("headSoFar: the head is complete exactly when the chips close; partial input never throws");
}

// ── 2. A head-only rewrite keeps the draft's record of the turn ──
{
  const draft = normalizeInterviewResponse({
    message: "Ohio requires an air permit. Does yours cover all 38 presses?",
    whyItMatters: "old",
    suggestedAnswers: ["Yes"],
    extractedFields: { airPermit: { value: "renewed 2023", confidence: "confirmed", source: "seller_statement", basis: "verbatim" } },
    reasoning: { newDeferrals: [{ topic: "lease", reason: "r", whereInfoLives: "Rob" }] },
    privateNotes: [{ note: "health", reason: "private" }],
    newTasks: [{ type: "follow_up", title: "t", description: "d", relatedField: "", sellerExplanation: "" }],
    shouldEnd: false,
  }).response;
  const head = normalizeInterviewResponse({ message: "Which permits does the plant hold today?", suggestedAnswers: ["Air", "Stormwater"] }).response;
  const merged = withRewrittenHead(draft, head);
  assert.equal(merged.message, head.message);
  assert.deepEqual(merged.suggestedAnswers, ["Air", "Stormwater"]);
  assert.equal(merged.whyItMatters, undefined);
  assert.ok(merged.extractedFields.airPermit, "the draft's facts stand");
  assert.equal(merged.reasoning.newDeferrals.length, 1);
  assert.equal(merged.privateNotes?.length, 1);
  assert.equal(merged.newTasks.length, 1);
  ok("withRewrittenHead: wording from the rewrite, facts/deferrals/notes/tasks from the draft");
}

// ── 3. The stop state at the gate is the stop state after the call ──
{
  // The previous inline rule, kept verbatim as the reference.
  const reference = (s: { stopNow: boolean; stopSignalCount: number; stopLevel: any; closingAnswerTurn: boolean }, prior: number, intent: { stop: any; continueRequest: boolean }) => {
    let { stopNow, stopSignalCount, stopLevel, closingAnswerTurn } = s;
    if (intent.stop !== "none" && !stopNow) { stopNow = true; stopSignalCount = prior + 1; }
    else if (intent.stop === "none" && stopNow) { stopNow = false; stopSignalCount = 0; closingAnswerTurn = prior > 0 && !intent.continueRequest; }
    if (stopNow) stopLevel = intent.stop === "none" ? stopLevel : intent.stop;
    if (stopNow || (closingAnswerTurn && intent.continueRequest)) closingAnswerTurn = false;
    const forcedEnd = (stopNow && (stopSignalCount >= 2 || stopLevel === "firm")) || closingAnswerTurn;
    return { stopNow, stopSignalCount, stopLevel, closingAnswerTurn, forcedEnd };
  };
  let cases = 0;
  for (const prior of [0, 1, 2]) for (const quick of ["none", "soft", "firm"] as const) for (const stop of ["none", "soft", "firm"] as const) for (const cont of [false, true]) {
    const start = { stopNow: quick !== "none", stopSignalCount: quick !== "none" ? prior + 1 : 0, stopLevel: quick, closingAnswerTurn: quick === "none" && prior > 0 && !cont };
    const got = resolveStopState(start, prior, { stop, continueRequest: cont });
    const { change, paused, ...rest } = got;
    assert.equal(paused, false); // (no pause in these cases — see tests/unit/f2-interview.test.ts)
    assert.deepEqual(rest, reference(start, prior, { stop, continueRequest: cont }));
    // Idempotent: resolving an already-resolved state changes nothing.
    const again = resolveStopState(rest, prior, { stop, continueRequest: cont });
    assert.deepEqual({ ...again, change: null }, { ...rest, paused: false, change: null });
    cases++;
  }
  ok(`resolveStopState matches the previous rule and is idempotent (${cases} cases)`);
}

// ── 4. A forced goodbye's text at the gate is the text the turn saves ──
{
  const ctx = buildPolishContext({
    kb: { business: { location: "Toledo, OH" }, sourceDigests: [] } as any,
    dealLocation: "Toledo, OH",
    questionnaireData: null,
    sessions: [],
    sellerMessage: "Okay, that's all I have time for today — bye for now.",
    info: {},
  });
  const raw = "Great talking with you, Diane — I'll follow up with Rob on the lease. Everything is saved. When does the lease renew?";
  // The end of the turn: forced-goodbye strip → closing polish → promises reworded.
  const endOfTurn = scrubClosingPromises(polishMessage(forcedGoodbye(raw).message, ctx, { closing: true }).message);
  assert.equal(closingText(raw, ctx, "bye"), endOfTurn);
  assert.doesNotMatch(endOfTurn, /\?/);
  assert.match(endOfTurn, /[Yy]our broker will follow up/);
  // Held when an output guard would still rewrite it.
  assert.equal(closingText("Thanks — the mandatory probes I need to check off are done. Everything is saved.", ctx, "bye"), null);
  assert.equal(closingText("Thanks. Maria's $85K salary would be added back to SDE. Everything is saved.", ctx, "bye"), null);
  ok("closingText: the goodbye released at the gate equals the saved goodbye; guard cases are held");
}

// ── 5. The output guards' criteria at the gate ──
{
  assert.deepEqual(outputGuardProblems("Ohio requires that the plant hold an air permit for the molding lines. Does it cover all presses?", "x", "s"), ["legal"]);
  assert.deepEqual(outputGuardProblems("Any other one-time expenses in 2024?", "Maria's $85K salary would be added back to SDE, along with the vehicle loan interest. Any other one-time expenses in 2024?", "s"), ["normalisation"]);
  assert.deepEqual(outputGuardProblems("Which programs start in 2026?", "Which programs start in 2026?", "s"), []);
  ok("outputGuardProblems: legal on the polished text, add-back calls on the draft");
}

// ── 6. The opening fingerprint ──
{
  const base = {
    extractedInfo: { revenue: "$42M" },
    questionnaireData: { a: 1 },
    interviewOutline: null,
    documents: [{ id: "d2", status: "processed", visibility: "shared", updatedAt: new Date("2026-09-01") }, { id: "d1", status: "processed", visibility: "shared", updatedAt: new Date("2026-09-01") }],
    sessions: [{ id: "s1", messages: [{ role: "ai" }, { role: "user" }] }, { id: "s2", messages: [{ role: "ai" }] }],
    openDiscrepancies: [{ id: "x", status: "open" }],
    tasks: [{ id: "t1", status: "pending" }],
  };
  const b = openingBasis(base);
  // Order doesn't matter; an unanswered session (the opening itself) doesn't count.
  assert.equal(openingBasis({ ...base, documents: [...base.documents].reverse(), sessions: [base.sessions[0]] }), b);
  // Anything the opening is written from changes it.
  assert.notEqual(openingBasis({ ...base, extractedInfo: { revenue: "$43M" } }), b);
  assert.notEqual(openingBasis({ ...base, documents: [{ ...base.documents[0], visibility: "broker_only" }, base.documents[1]] }), b);
  assert.notEqual(openingBasis({ ...base, sessions: [{ id: "s1", messages: [{ role: "ai" }, { role: "user" }, { role: "ai" }, { role: "user" }] }] }), b);
  assert.notEqual(openingBasis({ ...base, tasks: [{ id: "t1", status: "completed" }] }), b);
  assert.equal(unansweredOpening({ messages: [{ role: "ai", content: "Hi?" }] }), true);
  assert.equal(unansweredOpening({ messages: [{ role: "ai" }, { role: "user" }] }), false);
  assert.equal(unansweredOpening({ messages: [] }), false);
  ok("openingBasis: stable across order, changes with facts, sources, answers and tasks");
}

process.stdout.write(`\n${n} groups passed\n`);
