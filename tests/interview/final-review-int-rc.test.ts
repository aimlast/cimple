/**
 * Final review (release candidate), interview lens:
 *   INT-RC-1  the seller's stop is never turned into a "take your time" break
 *             (incl. after the interview's own "take a few minutes, or stop
 *             here for today?" offer);
 *   INT-RC-2  a Continue press after a fault reads the saved answer (it is
 *             not downgraded and re-asked);
 *   INT-RC-3  a follow-up session can't end before the broker's routed
 *             questions are raised;
 *   INT-RC-4  after a "take your time", the seller's return is never read
 *             as taking the break again.
 * Offline: scripted model + classifier (tests/interview/turn-harness.ts).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/final-review-int-rc.test.ts
 */
import assert from "node:assert/strict";
import { installHarness, baseDeal, ai, seller } from "./turn-harness";
import { processTurn } from "../../server/interview/session-manager";
import { routedQuestionsRaised } from "../../server/interview/session-manager";
import {
  PAUSE_REPLY,
  PAUSE_REPLY_AFTER_OFFER,
  TRANSIENT_RETRY,
  detectPause,
  sellerResumed,
  namesShortBreak,
  governCompletion,
  CRITICAL_SECTIONS,
} from "../../server/interview/turn-guard";
import { quickIntent, combineIntent, intentPrompt, AFTER_PAUSE_NOTE, type SellerIntent } from "../../server/interview/seller-intent";
import { completionBlockers } from "../../server/interview/completion-gaps";
import { turnFloorFor } from "../../server/interview/seller-followups";
import { CONTINUE_AFTER_FAULT, savedAnswerText } from "../../shared/interview-fault";

TRANSIENT_RETRY.delaysMs = [0, 0];

const DUAL_OFFER = "Want to take a few minutes, or stop here for today? Everything so far is saved.";
const BREAK_OFFER = "Want to take a few minutes? Everything so far is saved, and we'll carry on from here when you're back.";
const Q = "What share of revenue comes from your top customer?";
const soft = (q: SellerIntent): SellerIntent => ({ ...q, stop: "soft", pause: false, continueRequest: false, via: "model" });

// ── INT-RC-1: patterns + combine ───────────────────────────────────────
{
  // A stop to the dual offer, or leaving opened with a pause word: never a break.
  for (const [msg, prev] of [
    ["Yes, let's stop for now.", DUAL_OFFER],
    ["Ok, let's wrap up.", DUAL_OFFER],
    ["Yeah, I'm done.", DUAL_OFFER],
    ["Yes, I'd rather stop.", DUAL_OFFER],
    ["Yes, let's call it a day.", DUAL_OFFER],
    ["Yes please, I'm wiped.", DUAL_OFFER],
    ["Yes please", DUAL_OFFER],
    ["Hang on, I need to head out.", Q],
    ["One sec, I've got to run.", Q],
  ] as const) {
    const q = quickIntent(msg, prev);
    const c = combineIntent(q, soft(q));
    assert.equal(c.pause, false, `not a break: ${msg}`);
    assert.equal(c.stop, "soft", `the classifier's stop wins: ${msg}`);
  }
  // Patterns alone: stop words make it a stop, not a break.
  assert.equal(detectPause("Yes, let's call it a day.", DUAL_OFFER), false);
  assert.equal(detectPause("Hang on, I need to head out.", Q), false);
  assert.equal(quickIntent("Hang on, I need to head out.", Q).stop, "soft");

  // A break the message names itself still wins over a soft reading…
  for (const [msg, prev] of [
    ["Yes, a short break would help", DUAL_OFFER],
    ["A few minutes please", DUAL_OFFER],
    ["Yes please", BREAK_OFFER], // …as does a yes to an offer of a break and nothing else
    ["Give me five minutes, I have to run to the shop.", Q],
  ] as const) {
    const q = quickIntent(msg, prev);
    assert.equal(q.pause, true, `pattern break: ${msg}`);
    const c = combineIntent(q, soft(q));
    assert.equal(c.pause, true, `named break wins: ${msg}`);
    assert.equal(c.stop, "none");
  }
  // …never over a firm stop.
  const firm = quickIntent("Yes, a short break would help", DUAL_OFFER);
  assert.equal(combineIntent(firm, { ...soft(firm), stop: "firm" }).pause, false);
  // Unchanged: a plain break with no stop reading.
  assert.equal(quickIntent("brb", Q).pause, true);
  assert.equal(namesShortBreak("Hang on, I need to head out."), false);
}

// ── INT-RC-1 end to end (turn harness) ─────────────────────────────────
const history = [
  ai("How many people work at the clinic, full- and part-time?"),
  seller("Eleven full-time, four part-time."),
  ai("Roughly what were revenues last fiscal year, and what share came from your largest customer?"),
];
{
  const h = installHarness(baseDeal(), { messages: [...history.slice(0, 2), ai(DUAL_OFFER)] });
  h.intents.push({ stop: "soft" });
  h.script.push({ message: "Understood — the one thing to start with next time is last year's revenue. Everything is saved.", shouldEnd: false });
  const t = await processTurn("deal-1", "sess-1", "Yes, let's call it a day.");
  assert.notEqual(t.message, PAUSE_REPLY_AFTER_OFFER, "the stop is not answered with 'take your time'");
  assert.equal(h.sessions[0].extractedInfo._stopSignalCount, 1, "the stop is counted");
}
{
  const h = installHarness(baseDeal(), { messages: [...history] });
  h.intents.push({ stop: "soft" });
  h.script.push({ message: "No problem — next time let's start with last year's revenue. Everything is saved.", shouldEnd: false });
  const t = await processTurn("deal-1", "sess-1", "Hang on, I need to head out.");
  assert.notEqual(t.message, PAUSE_REPLY);
  assert.equal(h.sessions[0].extractedInfo._stopSignalCount, 1);
}

// ── INT-RC-2: Continue after a fault reads the saved answer ────────────
{
  // The saved answer: every seller message since the last real reply, Continue presses aside.
  assert.equal(
    savedAnswerText([
      ai("Q?"),
      seller("About $2.4M."),
      ai("fault", { degraded: true }),
      seller("Continue"),
      ai("fault", { degraded: true }),
      seller("Halton is ~30%."),
      ai("fault", { degraded: true }),
    ] as any),
    "About $2.4M.\n\nHalton is ~30%.",
  );
  assert.equal(savedAnswerText([ai("Q?")] as any), "");

  const h = installHarness(baseDeal(), { messages: [...history] });
  const t1 = await processTurn("deal-1", "sess-1", "About $2.4M last fiscal year. Our biggest customer, Halton Health, is roughly 30% of that.");
  assert.equal(t1.degraded, true, "precondition: the turn faulted (no scripted model reply)");
  h.intents.push({ stop: "none" });
  h.script.push({
    message: "How long has Halton Health been a customer?",
    targetSection: "customers",
    extractedFields: {
      annualRevenue: { value: "$2.4M (last fiscal year)", confidence: "confirmed" },
      customerConcentration: { value: "Largest customer Halton Health ~30% of revenue", confidence: "confirmed" },
    },
  });
  await processTurn("deal-1", "sess-1", CONTINUE_AFTER_FAULT);
  const meta = h.sessions[0].extractedInfo;
  assert.equal(meta._confidenceLevels?.annualRevenue, "confirmed", "the saved figure stays confirmed");
  assert.equal(meta._confidenceLevels?.customerConcentration, "confirmed");
  const ledger = (meta._deferralLedger ?? []).map((e: any) => e.topic);
  assert.ok(!ledger.some((t: string) => /^verify /.test(t)), `no verify re-ask queued: ${JSON.stringify(ledger)}`);
  assert.ok(!h.logs.some((l) => /Grounding guard downgraded/.test(l)), "the grounding guard read the saved answer");
  // The transcript keeps what the seller pressed.
  const msgs = h.sessions[0].messages;
  assert.equal(msgs.filter((m: any) => m.role === "user").pop().content, CONTINUE_AFTER_FAULT);
}

// ── INT-RC-3: routed questions block a self-initiated end ──────────────
{
  const coverage = Array.from(CRITICAL_SECTIONS).map((key) => ({ key, title: key, status: "well_covered" as const, fields: [] }));
  const routed = [
    { field: "2023 revenue", valueA: "$1.74M — P&L", valueB: "$1.61M — T2" },
    { field: "Customer concentration", valueA: "Top customer 30%", valueB: "Top customer 18%" },
  ];
  const transcript = [ai("The 2023 revenue in your T2 is $1.61M and the P&L shows $1.74M — which is right?"), seller("The P&L; the T2 was filed before the year-end adjustments.")];
  const raised = routedQuestionsRaised(routed, transcript);
  assert.deepEqual(raised.map((r) => r.discussed), [true, false], "the revenue one was raised, the concentration one not");
  const blockers = completionBlockers({
    sectionCoverage: coverage as any,
    criticalSections: new Set(CRITICAL_SECTIONS),
    info: {},
    ledger: [],
    exchanges: [{ question: transcript[0].content, answer: transcript[1].content }],
    conflicts: [],
    risks: [],
    onFileTopics: [],
    routedQuestions: raised,
  });
  // (The rest of this bare fixture's items are the base checklist's.)
  assert.equal(blockers[0], "the broker's question: Customer concentration", "first, most important");
  assert.equal(blockers.filter((b) => b.startsWith("the broker's question")).length, 1, "the raised one doesn't block");
  const verdict = (stop: boolean) =>
    governCompletion({
      shouldEnd: true,
      endReason: "All the broker's questions are covered",
      sellerMessage: transcript[1].content,
      userTurnCount: 1,
      sectionCoverage: coverage as any,
      deferredTopics: [],
      minTurnsBeforeEnd: turnFloorFor(true, 10),
      sellerStopDetected: stop,
      blockingItems: [blockers[0]],
      intentStop: stop ? "stop" : "none",
    } as any);
  assert.equal(turnFloorFor(true, 10), 0, "precondition: a follow-up session has no turn floor");
  assert.equal(verdict(false).allowEnd, false, "the model can't end before the routed question is raised");
  assert.equal(verdict(true).allowEnd, true, "the seller's stop still wins");
  // Deferred → no longer blocks.
  const deferred = completionBlockers({
    sectionCoverage: coverage as any, criticalSections: new Set(CRITICAL_SECTIONS), info: {}, exchanges: [], conflicts: [], risks: [], onFileTopics: [],
    ledger: [{ topic: "Customer concentration", reason: "seller will check with the bookkeeper", whereInfoLives: "bookkeeper", status: "open", createdAtTurn: 0 } as any],
    routedQuestions: [{ label: "Customer concentration", discussed: false }],
  });
  assert.ok(!deferred.some((b) => b.startsWith("the broker's question")), "a deferred routed question doesn't block");
}

// ── INT-RC-4: the return after a break ─────────────────────────────────
{
  assert.equal(sellerResumed("ok", { afterPause: true }), true);
  assert.equal(sellerResumed("Back.", { afterPause: true }), true);
  assert.equal(sellerResumed("ok"), false, "a bare ok is a return only right after a break");
  assert.equal(quickIntent("Yes please", BREAK_OFFER, { afterPause: true }).pause, false);
  assert.ok(intentPrompt({ sellerMessage: "ok", prevAiMessage: Q, recentFacts: [], afterPause: true }).startsWith(AFTER_PAUSE_NOTE));
  assert.ok(!intentPrompt({ sellerMessage: "ok", prevAiMessage: Q, recentFacts: [] }).includes(AFTER_PAUSE_NOTE));

  const h = installHarness(baseDeal(), { messages: [ai("How many people work at the clinic?"), seller("Eleven full-time."), ai(BREAK_OFFER)] });
  h.intents.push({ stop: "none", pause: true });
  h.script.push({ message: "Sure.", shouldEnd: false });
  const t1 = await processTurn("deal-1", "sess-1", "Yes please");
  assert.equal(t1.message, PAUSE_REPLY_AFTER_OFFER, "the break is taken");
  // Even if the classifier reads the return as taking the break again:
  h.intents.push({ stop: "none", pause: true });
  h.script.push({ message: "How many part-time staff?", shouldEnd: false });
  const t2 = await processTurn("deal-1", "sess-1", "ok");
  assert.equal(t2.message, "How many part-time staff?", "no second 'take your time'");
}

process.stdout.write("final-review-int-rc: all assertions passed\n");
process.exit(0);
