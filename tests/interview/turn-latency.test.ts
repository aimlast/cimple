// Seller-perceived latency (round A, ACC-INT-7): whole streamed turns with a
// mocked model that streams its tool call in small deltas
// (tests/interview/turn-harness.ts), checking WHEN things reach the seller:
//   - the question and its chips ("ready") arrive while the model is still
//     writing the bookkeeping tail, and are exactly what the turn saves;
//   - a forced goodbye and a stop's closing question are released at the
//     gate, not after the whole turn;
//   - a draft held for an output-guard rewrite gets that rewrite started
//     beside its tail (head only) and shown as soon as it is clean;
//   - wording rewrites stop at the head (the tail would be thrown away);
//   - a released question is never swapped: the model's shouldEnd on it is
//     dropped instead of a governance re-call;
//   - a returning seller's opening stops at the head, is announced as soon
//     as it is final, and an unanswered one is reused while nothing changed.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/turn-latency.test.ts
import assert from "node:assert/strict";
import { installHarness, baseDeal, ai, seller, type Harness } from "./turn-harness";
import { processTurn, startOrResumeSession, type TurnReady } from "../../server/interview/session-manager";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };
const has = (h: Harness, re: RegExp) => h.logs.some((l) => re.test(l));
/** How far call `call`'s stream had got when `at` deltas had been delivered in all. */
const progressOf = (h: Harness, call: number, at: number) => {
  const seen = h.streamed.slice(0, at).filter((s) => s.call === call);
  return seen.length ? seen[seen.length - 1] : { call, upTo: 0, of: 1 };
};
const finished = (h: Harness, call: number) => {
  const all = h.streamed.filter((s) => s.call === call);
  return all.length > 0 && all[all.length - 1].upTo === all[all.length - 1].of;
};

/** A streamed turn: what the seller saw, when, and the result. */
async function streamedTurn(h: Harness, message: string) {
  let shown = "";
  let firstAt = -1;
  let readyAt = -1;
  let ready: TurnReady | null = null;
  const result = await processTurn("deal-1", "sess-1", message, (chunk) => {
    if (firstAt < 0) firstAt = h.streamed.length;
    shown += chunk;
  }, {
    onReady: (r) => {
      ready = r;
      readyAt = h.streamed.length;
    },
  });
  return { result, shown, firstAt, readyAt, ready: ready as TurnReady | null };
}

const history = [
  ai("How many presses run on each of the three shifts?"),
  seller("First shift runs about 85 people, second around 75, third maybe 50."),
  ai("Who owns the relationship with Maumee Valley's purchasing team day to day?"),
];
/** A bookkeeping tail the size the live model writes (~2.5K characters). */
const bigTail = {
  currentTopic: "operations",
  nextIntent: "Move to the equipment term loans and what a buyer assumes at closing. ".repeat(12),
  extractedFields: {
    maumeeRelationship: { value: "Diane owns the Maumee Valley purchasing relationship; Rob covers quality and PPAP.", confidence: "confirmed" },
    moldRefurbishment: { value: "About ten company-owned molds need refurbishment in the next two years.", confidence: "approximate" },
  },
};

(async () => {
  // ── 1. A question turn: shown, then ready, both before the tail is written ──
  {
    const h = installHarness(baseDeal(), { messages: [...history] });
    h.script.push({
      message: "Which of the equipment term loans would a buyer be expected to assume?",
      whyItMatters: "Buyers price the debt they take on, so they want to know which loans come with the business.",
      importance: "critical",
      targetSection: "financials",
      suggestedAnswers: ["All of them", "Only the newest press loan", "I'd have to check with Rob"],
      ...bigTail,
    });
    const t = await streamedTurn(h, "Diane handles Maumee herself; Rob covers the quality side.");
    assert.ok(t.firstAt > 0 && !(progressOf(h, 0, t.firstAt).upTo === progressOf(h, 0, t.firstAt).of), "the question is shown while the model is still writing");
    assert.ok(t.ready, "a ready event was sent");
    const atReady = progressOf(h, 0, t.readyAt);
    assert.ok(atReady.upTo < atReady.of * 0.5, `ready came before half the response was written (${atReady.upTo}/${atReady.of})`);
    assert.equal(t.shown, t.result.message, "the text shown is the text saved");
    assert.equal(t.ready!.message, t.result.message);
    assert.deepEqual(t.ready!.suggestedAnswers, t.result.suggestedAnswers, "the chips the seller got are the saved chips");
    assert.equal(t.ready!.whyItMatters, t.result.whyItMatters);
    assert.equal(t.ready!.importance, t.result.importance);
    assert.equal(t.ready!.targetSection, t.result.targetSection);
    assert.equal(t.result.turnMessages?.ai.content, t.shown);
    assert.ok(h.deal.extractedInfo.maumeeRelationship, "the tail's facts are still recorded");
    assert.ok(has(h, /\[turn-timing\] session sess-1 turn 2: .*shown=\d+ .*ready=\d+ .*model_done=\d+ .*saved=\d+/), "one timing line per turn");
    ok("question turn: shown and ready (chips, why we ask this) mid-stream; the saved turn is identical");
  }

  // ── 2. The forced goodbye is shown at the gate ──
  {
    const closing = "Before you go — who holds the Toledo lease, you or the corporation?";
    const h = installHarness(baseDeal(), { messages: [...history, seller("Sorry, I have to go to a meeting."), ai(closing)], sessionMeta: { _stopSignalCount: 1 } });
    h.script.push({
      message: "Thanks, Diane — I'll follow up with Rob on the lease. Everything you've shared is saved. Anything else before you go?",
      shouldEnd: false,
      ...bigTail,
    });
    const t = await streamedTurn(h, "The corporation holds it. That's all I have time for today — bye for now.");
    assert.equal(t.result.shouldEnd, true, "the stop wins");
    const at = progressOf(h, 0, t.firstAt);
    assert.ok(at.upTo < at.of, `the goodbye was shown before the tail was written (${at.upTo}/${at.of})`);
    assert.equal(t.shown, t.result.message, "shown = saved");
    assert.doesNotMatch(t.result.message, /\?/, "a forced goodbye asks nothing");
    assert.match(t.result.message, /[Yy]our broker will follow up with Rob/, "the promise is the broker's");
    assert.equal(t.ready, null, "no chips on a goodbye");
    ok("forced goodbye: released at the gate (question removed, promise reworded) — identical to the saved one");
  }

  // ── 3. A stop's one closing question goes through the question gate ──
  {
    const h = installHarness(baseDeal(), { messages: [...history] });
    h.script.push({ message: "Understood — before you go, one last one: when does the Toledo lease come up for renewal?", ...bigTail });
    const t = await streamedTurn(h, "I need to run soon, I have a meeting in ten minutes.");
    assert.ok(has(h, /Seller stop signal #1/));
    assert.equal(t.result.shouldEnd, false);
    const at = progressOf(h, 0, t.firstAt);
    assert.ok(at.upTo < at.of, "the closing question was shown mid-stream (it used to wait for the whole turn)");
    assert.ok(t.ready, "its chips are ready early too");
    assert.equal(t.shown, t.result.message);
    ok("stop #1: the closing question is released at the gate and ready early");
  }

  // ── 4. A draft held for an add-back call: the rewrite starts beside its tail ──
  {
    const h = installHarness(baseDeal(), { messages: [...history] });
    h.script.push({
      message: "Maria's $85K salary would be added back to SDE, along with the vehicle loan interest. Are there other one-time expenses in 2024?",
      ...bigTail,
      nextIntent: "x ".repeat(1500), // a long tail: the rewrite must not wait for it
    });
    h.script.push({
      message: "Are there other expenses in 2024 that were one-time or personal, such as a vehicle the business pays for?",
      suggestedAnswers: ["No, that's everything", "A couple of vehicles", "I'd have to check"],
      whyItMatters: "Buyers look for one-time and personal costs so the earnings they see reflect the business itself.",
    });
    const t = await streamedTurn(h, "My wife Maria is on payroll at $85K and the company pays for two vehicles.");
    assert.equal(h.calls.length, 2, "one draft, one rewrite");
    assert.match(h.calls[1], /SYSTEM CORRECTION: Rewrite your reply/);
    const firstRewriteDelta = h.streamed.findIndex((s) => s.call === 1);
    assert.ok(h.streamed.slice(firstRewriteDelta).some((s) => s.call === 0), "the rewrite ran while the draft's tail was still being written");
    assert.ok(!finished(h, 1), "the rewrite stopped at its head");
    const at = progressOf(h, 0, t.firstAt);
    assert.ok(at.upTo < at.of, "the rewrite was shown before the draft finished");
    assert.equal(t.shown, t.result.message);
    assert.doesNotMatch(t.shown, /added back|SDE/);
    assert.deepEqual(t.ready?.suggestedAnswers, t.result.suggestedAnswers);
    assert.ok(h.deal.extractedInfo.maumeeRelationship, "the draft's facts are recorded");
    assert.ok(has(h, /corrective rewrite written beside the draft and shown/));
    ok("held add-back draft: the corrective rewrite starts at the gate, stops at its head, and shows before the draft's tail is done");
  }

  // ── 5. A released question is never swapped for a continuation ──
  {
    const h = installHarness(baseDeal(), { messages: [...history] });
    h.script.push({ message: "Which programs are you quoting right now that could start in 2026?", shouldEnd: true, endReason: "covered", ...bigTail });
    const t = await streamedTurn(h, "Diane handles Maumee herself.");
    assert.equal(t.result.shouldEnd, false, "the question on screen is where the conversation goes");
    assert.equal(h.calls.length, 1, "no governance re-call");
    assert.equal(t.shown, t.result.message);
    assert.equal(h.deal.interviewCompleted, false);
    assert.ok(has(h, /ended on a question already shown/));
    ok("a released question with shouldEnd: the interview carries on, nothing on screen changes");
  }

  // ── 6. The re-ask guard's re-call (after the fact) stops at the head ──
  {
    const deal = baseDeal({
      extractedInfo: {
        evVsIceSplit: "70% EV platforms / 30% ICE",
        _fieldSources: { evVsIceSplit: { source: "interview", sessionId: "s0", turn: 4 } },
      },
    });
    const h = installHarness(deal, { messages: [...history] });
    h.script.push({ message: "What's your EV vs ICE split?", ...bigTail });
    h.script.push({ message: "Which resin grades are hardest to source right now?", suggestedAnswers: ["Nylon", "PC"] });
    // The plain endpoint: nothing is streamed, the guard runs on the finished draft.
    const r = await processTurn("deal-1", "sess-1", "Diane handles Maumee herself.");
    assert.equal(h.calls.length, 2);
    assert.equal(r.message, "Which resin grades are hardest to source right now?");
    assert.ok(!finished(h, 1), "the rewrite stopped at its head (its tail would be discarded)");
    assert.ok(h.deal.extractedInfo.maumeeRelationship, "the draft's facts stand");
    ok("after-the-fact re-ask rewrite: head only, the draft's record of the turn kept");
  }

  // ── 7. A returning seller's opening: head only, announced when final, reused while unchanged ──
  {
    const earlier = {
      id: "sess-0",
      dealId: "deal-1",
      participantId: "p",
      status: "completed",
      messages: [ai("How many toolmakers work in the tool room?"), seller("Nine, led by Greg.")],
      extractedInfo: { _industryContext: { industry: "Manufacturing", subIndustry: "Injection molding", location: "Toledo, OH", industrySpecificAreas: [], regulatoryNotes: [] } },
      questionsAsked: 1,
      questionsAnswered: 1,
      questionsSkipped: 0,
      lastActivityAt: new Date(Date.now() - 86_400_000),
      completedAt: new Date(Date.now() - 86_400_000),
    };
    const h = installHarness(baseDeal({ interviewCompleted: true }));
    h.sessions.push(earlier);
    const opening = "Good to pick up where we left off on the tool room. Which programs are you quoting right now that could start in 2026?";
    h.script.push({ message: opening, suggestedAnswers: ["Two medical programs", "Nothing firm yet"], ...bigTail });
    const announced: string[] = [];
    const open = await startOrResumeSession("deal-1", { resume: true, onOpeningText: (t) => announced.push(t) });
    assert.equal(open.message, opening);
    assert.deepEqual(announced, [opening], "the final text was announced once, before the save");
    assert.ok(!finished(h, 0), "the draft stopped at its head (the industry is already known)");
    assert.ok(has(h, /\[turn-timing\] opening of session .* \(returning seller\): .*opening_text=\d+/));
    const created = h.sessions.find((s) => s.id !== "sess-0")!;
    assert.equal(typeof created.extractedInfo._openingBasis, "string");

    // The seller leaves; a page visit closes the unanswered opening; they come back.
    const idle = await startOrResumeSession("deal-1");
    assert.equal(idle.status, "completed");
    assert.equal(created.status, "completed");
    const calls = h.calls.length;
    const again = await startOrResumeSession("deal-1", { resume: true });
    assert.equal(h.calls.length, calls, "no model call: the unanswered opening is reused");
    assert.equal(again.message, opening);
    assert.equal(again.sessionId, created.id);
    assert.equal(created.status, "active");
    assert.ok(has(h, /Reopened the unanswered opening/));

    // Something on file changed: a new opening is written.
    const idle2 = await startOrResumeSession("deal-1");
    assert.equal(idle2.status, "completed");
    h.deal = { ...h.deal, extractedInfo: { ...h.deal.extractedInfo, quotingPipeline: "two medical programs" } };
    h.script.push({ message: "Good to pick up where we left off on the tool room. How many press operators work nights?", ...bigTail });
    const fresh = await startOrResumeSession("deal-1", { resume: true });
    assert.equal(h.calls.length, calls + 1, "a new opening after the facts changed");
    assert.notEqual(fresh.sessionId, created.id);
    ok("returning opening: stops at its head, announced when final; an unanswered one is reused only while nothing changed");
  }

  // ── 8. The model fails after the question was shown: the question stays ──
  {
    const h = installHarness(baseDeal(), { messages: [...history] });
    h.script.push({ message: "Which of the equipment term loans would a buyer be expected to assume?", ...bigTail, streamBreaksAt: 0.6 });
    const t = await streamedTurn(h, "Diane handles Maumee herself.");
    assert.equal(t.shown, "Which of the equipment term loans would a buyer be expected to assume?");
    assert.equal(t.result.message, t.shown, "never swapped for the fault notice");
    assert.deepEqual(t.result.suggestedAnswers, t.ready?.suggestedAnswers);
    const saved = h.sessions[0].extractedInfo;
    assert.equal(saved._degradedTurns, 1, "the next turn recovers what this one didn't record");
    ok("a tail that breaks off after the question is shown: the question stays; the turn is marked for recovery");
  }

  // ── 9. A response cut off after the question was shown is retried: the shown question stays ──
  {
    const h = installHarness(baseDeal(), { messages: [...history] });
    h.script.push({ message: "Which of the equipment term loans would a buyer be expected to assume?", ...bigTail, stopReason: "max_tokens" });
    h.script.push({ message: "What share of 2024 revenue came from medical programs?", ...bigTail });
    const t = await streamedTurn(h, "Diane handles Maumee herself.");
    assert.equal(h.calls.length, 2, "the cut-off response was retried");
    assert.equal(t.result.message, t.shown, "the retry's wording never replaces what the seller read");
    assert.ok(h.deal.extractedInfo.maumeeRelationship, "the retry's record of the turn is used");
    assert.ok(has(h, /re-generated after the reply was shown/));
    ok("a max_tokens retry after the question was shown: the shown question stays");
  }

  process.stdout.write(`\n${n} groups passed\n`);
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
