// Seller-perceived latency, round 2 (ACC-INT-7 review): whole streamed turns
// with a mocked model that streams its tool call in small deltas
// (tests/interview/turn-harness.ts), checking:
//   - a goodbye the model chooses (governance allows it) and a goodbye after
//     a soft stop are shown as soon as the model's end decision is in —
//     not after the ~5K-character tail — and are exactly what is saved;
//   - an early goodbye the turn floor is certain to block starts its
//     continuation beside the tail; the continuation is what is saved;
//   - a model that writes its end decision last, or a goodbye an output
//     guard will rewrite, is held until final (as before);
//   - an output-guard rewrite started at the gate during an intent re-call
//     or a governance continuation is adopted (never swapped on screen);
//   - a stop's one closing question is never turned into a reconcile of a
//     figure the seller just gave;
//   - a model that writes its facts before its chips: the ready event
//     carries the model's own chips, not the generic backfill;
//   - an unanswered opening is reused only for the same mode and the same
//     source review / evidence.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/turn-latency-r2.test.ts
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { installHarness, baseDeal, ai, seller, type Harness } from "./turn-harness";
import { processTurn, startOrResumeSession, type TurnReady } from "../../server/interview/session-manager";
import { openingBasis } from "../../server/interview/turn-release";
import type { ConversationMessage } from "@shared/schema";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };
const has = (h: Harness, re: RegExp) => h.logs.some((l) => re.test(l));
/** How far call `call`'s stream had got when `at` deltas had been delivered in all. */
const progressOf = (h: Harness, call: number, at: number) => {
  const seen = h.streamed.slice(0, at).filter((s) => s.call === call);
  return seen.length ? seen[seen.length - 1] : { call, upTo: 0, of: 1 };
};
/** Index in h.streamed of call `call`'s last delta. */
const lastDeltaOf = (h: Harness, call: number) => {
  let at = -1;
  h.streamed.forEach((s, i) => { if (s.call === call) at = i; });
  return at;
};

async function streamedTurn(h: Harness, message: string) {
  let shown = "";
  let firstAt = -1;
  let readyAt = -1;
  let ready: TurnReady | null = null;
  let endingAt = -1;
  let shownAtEnding = "";
  const result = await processTurn("deal-1", "sess-1", message, (chunk) => {
    if (firstAt < 0) firstAt = h.streamed.length;
    shown += chunk;
  }, {
    onReady: (r) => {
      ready = r;
      readyAt = h.streamed.length;
    },
    onEnding: () => {
      endingAt = h.streamed.length;
      shownAtEnding = shown;
    },
  });
  return { result, shown, firstAt, readyAt, ready: ready as TurnReady | null, endingAt, shownAtEnding };
}

const history = [
  ai("How many presses run on each of the three shifts?"),
  seller("First shift runs about 85 people, second around 75, third maybe 50."),
  ai("Who owns the relationship with Maumee Valley's purchasing team day to day?"),
];
/** A bookkeeping tail the size the live model writes (~5K characters). */
const bigTail = {
  currentTopic: "operations",
  nextIntent: "Move to the equipment term loans and what a buyer assumes at closing. ".repeat(60),
  extractedFields: {
    maumeeRelationship: { value: "Diane owns the Maumee Valley purchasing relationship; Rob covers quality and PPAP.", confidence: "confirmed" },
  },
};

/** A deal far enough along that governance lets the model end on its own: every critical section covered, 40 answers in. */
function coveredDeal() {
  return baseDeal({
    businessName: "Great Lakes Plastics",
    industry: "Injection molding",
    extractedInfo: {
      businessName: "Great Lakes Plastics",
      industry: "Injection molding",
      revenueStreams: "Automotive 60%, medical 40%",
      customerConcentration: "Top customer 22%",
      annualRevenue: "$41.8M (FY2024)",
      employees: "210 across three shifts",
      employeeStructure: "Plant manager, three shift leads, quality team",
      ownerInvolvement: "Owner works on strategy only",
      reasonForSale: "Retirement",
      askingPrice: "$42M",
      saleType: "Share sale",
      assetsIncluded: "All presses and molds",
      entityType: "S-corp",
      yearsOperating: "38 years",
    },
  });
}
function longHistory(): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  for (let i = 1; i <= 39; i++) {
    out.push(ai(`Question ${i}: what else should a buyer know about area ${i}?`));
    out.push(seller(`Answer ${i}: that part of the business is steady and documented.`));
  }
  out.push(ai("Is there anything about the tool room a buyer should know?"));
  return out;
}

(async () => {
  // ── 1. A goodbye the model chooses, governance allows: shown at the end decision ──
  {
    const h = installHarness(coveredDeal(), { messages: longHistory() });
    h.intents.push({ stop: "none" });
    h.script.push({
      message: "Thanks, Gord — that gives your broker everything needed for the memorandum. Everything you've shared is saved.",
      shouldEnd: true,
      endReason: "All critical sections are covered",
      suggestedAnswers: [],
      ...bigTail,
    });
    const t = await streamedTurn(h, "Nothing else on the tool room — Greg runs it and it's all documented.");
    assert.equal(t.result.shouldEnd, true, "the end stands");
    assert.ok(t.firstAt > 0, "the goodbye was shown");
    const at = progressOf(h, 0, t.firstAt);
    assert.ok(at.upTo < at.of * 0.5, `the goodbye was shown before half the response was written (${at.upTo}/${at.of})`);
    assert.equal(t.shown, t.result.message, "shown = saved");
    assert.equal(h.calls.length, 1, "no rewrite, no continuation");
    assert.equal(has(h, /Blocked premature interview end/), false);
    assert.equal(h.deal.interviewCompleted, true);
    assert.ok(h.deal.extractedInfo.maumeeRelationship, "the tail's facts are still recorded");
    assert.ok(has(h, /\[turn-timing\] .*end=\d+ .*shown=\d+ .*model_done=\d+/), "the end decision and the release are timed before the model finished");
    assert.ok(t.endingAt >= 0 && t.endingAt < lastDeltaOf(h, 0), "the answer box is told to close with the goodbye, while the turn saves");
    assert.ok(t.shownAtEnding.length > 0 && t.result.message.startsWith(t.shownAtEnding), "announced as the goodbye types out");
    ok("model-chosen goodbye (governance allows it): shown at the end decision, identical to the saved one");
  }

  // ── 2. The same goodbye from a model that writes shouldEnd last: held until final ──
  {
    const h = installHarness(coveredDeal(), { messages: longHistory() });
    h.intents.push({ stop: "none" });
    h.script.push({
      message: "Thanks, Gord — that gives your broker everything needed for the memorandum. Everything you've shared is saved.",
      shouldEnd: true,
      endReason: "All critical sections are covered",
      suggestedAnswers: [],
      endLast: true,
      ...bigTail,
    });
    const t = await streamedTurn(h, "Nothing else on the tool room — Greg runs it and it's all documented.");
    assert.equal(t.result.shouldEnd, true);
    assert.ok(t.firstAt >= lastDeltaOf(h, 0), "shown only once the whole response was in (its end decision came last)");
    assert.equal(t.shown, t.result.message);
    ok("a model that writes its end decision last: the goodbye waits for it, as before (no swap)");
  }

  // ── 3. A goodbye an output guard will rewrite is never shown early ──
  {
    const h = installHarness(coveredDeal(), { messages: longHistory() });
    h.intents.push({ stop: "none" });
    h.script.push({
      message: "Thanks, Gord — the coverage map shows every section is filled. Everything you've shared is saved.",
      shouldEnd: true,
      endReason: "All critical sections are covered",
      suggestedAnswers: [],
      ...bigTail,
    });
    h.script.push({ message: "Thanks, Gord — that's everything for today. Everything you've shared is saved.", suggestedAnswers: [] });
    const t = await streamedTurn(h, "Nothing else on the tool room — Greg runs it and it's all documented.");
    assert.equal(h.calls.length, 2, "the output guard rewrote it");
    assert.ok(t.firstAt >= lastDeltaOf(h, 0), "held until the rewrite was final");
    assert.equal(t.shown, t.result.message);
    assert.doesNotMatch(t.result.message, /coverage map/);
    assert.equal(t.result.shouldEnd, true);
    ok("a goodbye naming the agent's machinery: held for the rewrite, never shown then swapped");
  }

  // ── 4. A soft stop, the model's goodbye: shown at the end decision ──
  {
    const h = installHarness(baseDeal(), { messages: [...history] });
    h.intents.push({ stop: "soft" });
    h.script.push({
      message: "Understood — thanks for your time today. Everything you've shared is saved, and we can pick up the lease next time.",
      shouldEnd: true,
      endReason: "Seller needs to go",
      suggestedAnswers: [],
      ...bigTail,
    });
    const t = await streamedTurn(h, "I need to run soon, I have a meeting in ten minutes.");
    assert.equal(t.result.shouldEnd, true);
    const at = progressOf(h, 0, t.firstAt);
    assert.ok(at.upTo < at.of * 0.5, `shown before half the response was written (${at.upTo}/${at.of})`);
    assert.equal(t.shown, t.result.message);
    assert.equal(h.calls.length, 1);
    assert.ok(t.endingAt >= 0, "the answer box closes");
    ok("soft stop + the model's goodbye: shown at the end decision (governance can't block a seller's stop)");

    // A forced goodbye (the answer to the one closing question) also closes the box at once.
    const closing = "Before you go — who holds the Toledo lease, you or the corporation?";
    const h2 = installHarness(baseDeal(), { messages: [...history, seller("Sorry, I have to go to a meeting."), ai(closing)], sessionMeta: { _stopSignalCount: 1 } });
    h2.intents.push({ stop: "none" });
    h2.script.push({ message: "Thanks, Diane — everything you've shared is saved.", shouldEnd: true, ...bigTail });
    const f = await streamedTurn(h2, "The corporation holds it.");
    assert.equal(f.result.shouldEnd, true);
    assert.ok(f.endingAt >= 0 && f.endingAt < lastDeltaOf(h2, 0), "ending announced with the forced goodbye");
    assert.equal(f.shown, f.result.message);
    ok("forced goodbye: the answer box closes as soon as it is shown");
  }

  // ── 5. A soft stop, the model carries on without a question: shown at the end decision ──
  {
    const h = installHarness(baseDeal(), { messages: [...history] });
    h.intents.push({ stop: "soft" });
    h.script.push({
      message: "Understood — I'll follow up with Rob on the lease. Everything you've shared is saved.",
      shouldEnd: false,
      suggestedAnswers: [],
      ...bigTail,
    });
    const t = await streamedTurn(h, "I need to run soon, I have a meeting in ten minutes.");
    assert.equal(t.result.shouldEnd, false, "the model's call on a soft stop");
    assert.equal(t.endingAt, -1, "the interview goes on: the answer box stays open");
    const at = progressOf(h, 0, t.firstAt);
    assert.ok(at.upTo < at.of * 0.5, `shown before half the response was written (${at.upTo}/${at.of})`);
    assert.equal(t.shown, t.result.message, "shown = saved (promise reworded as the broker's)");
    assert.match(t.result.message, /[Yy]our broker will follow up with Rob/);
    ok("soft stop, no question, no end: the reply shows at the end decision, exactly as saved");
  }

  // ── 6. An early goodbye the turn floor blocks: the continuation starts beside the tail ──
  {
    const h = installHarness(baseDeal(), { messages: [...history] });
    h.intents.push({ stop: "none" });
    h.script.push({
      message: "Thanks, Diane — that's everything I need for today. Everything you've shared is saved.",
      shouldEnd: true,
      endReason: "covered",
      suggestedAnswers: [],
      ...bigTail,
    });
    h.script.push({
      message: "Which of the equipment term loans would a buyer be expected to assume?",
      suggestedAnswers: ["All of them", "Only the newest press loan", "I'd have to check with Rob"],
      whyItMatters: "Buyers price the debt they take on, so they want to know which loans come with the business.",
    });
    const t = await streamedTurn(h, "Diane handles Maumee herself; Rob covers the quality side.");
    assert.equal(h.calls.length, 2, "the draft and its continuation");
    assert.match(h.calls[1], /SYSTEM OVERRIDE: Do not end the interview yet/);
    const firstOfContinuation = h.streamed.findIndex((s) => s.call === 1);
    assert.ok(firstOfContinuation >= 0 && firstOfContinuation < lastDeltaOf(h, 0), "the continuation started while the draft's tail was still being written");
    assert.ok(t.firstAt < lastDeltaOf(h, 0), "its question was shown before the draft's tail was done");
    assert.equal(t.shown, t.result.message, "shown = saved");
    assert.equal(t.result.shouldEnd, false, "governance is authoritative");
    assert.equal(t.endingAt, -1, "the interview goes on");
    assert.equal(t.ready?.message, t.result.message);
    assert.deepEqual(t.ready?.suggestedAnswers, t.result.suggestedAnswers);
    assert.ok(has(h, /Blocked premature interview end: only 2 of a minimum 10 turns.*decided at the stream gate/));
    assert.ok(h.deal.extractedInfo.maumeeRelationship, "the first draft's facts are recorded");
    assert.equal(h.deal.interviewCompleted, false);
    ok("early goodbye below the turn floor: the continuation runs beside the tail and is shown early; nothing swapped");
  }

  // ── 7. The same early goodbye without the classifier's reading: the turn's own governance ──
  {
    const h = installHarness(baseDeal(), { messages: [...history] });
    h.script.push({ message: "Thanks, Diane — that's everything I need for today. Everything you've shared is saved.", shouldEnd: true, endReason: "covered", suggestedAnswers: [], ...bigTail });
    h.script.push({ message: "Which of the equipment term loans would a buyer be expected to assume?" });
    const t = await streamedTurn(h, "Diane handles Maumee herself; Rob covers the quality side.");
    assert.equal(h.calls.length, 2);
    assert.ok(h.streamed.findIndex((s) => s.call === 1) > lastDeltaOf(h, 0), "no early continuation (the model's endReason could still count)");
    assert.equal(t.shown, t.result.message);
    assert.equal(t.result.shouldEnd, false);
    ok("patterns-only intent: governance decides after the tail, as before");
  }

  // ── 8. Output fix during a governance continuation / an intent re-call is adopted ──
  const ADDBACK = "Maria's $85K salary would be added back to SDE, along with the vehicle loan interest. Are there other one-time expenses in 2024?";
  const FIX = "Are there other expenses in 2024 that were one-time or personal, such as a vehicle the business pays for?";
  {
    const h = installHarness(baseDeal(), { messages: [...history] });
    h.script.push({ message: "Thanks, that's everything I need for today. Everything you've shared is saved.", shouldEnd: true, endReason: "covered", ...bigTail });
    h.script.push({ message: ADDBACK, ...bigTail });
    h.script.push({ message: FIX, suggestedAnswers: ["No", "A couple of vehicles", "I'd have to check"] });
    h.script.push({ message: "Which costs in 2024 would you call one-off, rather than part of running the business every year?" });
    const t = await streamedTurn(h, "My wife Maria is on payroll at $85K and the company pays for two vehicles.");
    assert.equal(h.calls.length, 3, "draft, continuation, its fix — no second rewrite");
    assert.equal(t.shown, FIX);
    assert.equal(t.result.message, FIX, "the fix on screen is the saved reply");
    assert.equal(t.ready?.message, t.result.message);
    assert.equal(has(h, /differs from the final message|changed after the seller was given it/), false);
    ok("governance continuation held for an add-back call: its gate fix is adopted (shown = saved)");
  }
  {
    const h = installHarness(baseDeal(), { messages: [...history, seller("I need to run soon."), ai("Before you go — who holds the Toledo lease?")], sessionMeta: { _stopSignalCount: 1 } });
    h.intents.push({ stop: "none", continueRequest: true });
    h.script.push({ message: "Thanks — that's all for today. Everything you've shared is saved.", ...bigTail });
    h.script.push({ message: ADDBACK, ...bigTail });
    h.script.push({ message: FIX, suggestedAnswers: ["No", "A couple of vehicles", "I'd have to check"] });
    h.script.push({ message: "Which costs in 2024 would you call one-off, rather than part of running the business every year?" });
    const t = await streamedTurn(h, "The corporation holds it. Actually my wife Maria is on payroll at $85K and the company pays for two vehicles, happy to keep going.");
    assert.ok(has(h, /Intent re-call on session sess-1: seller chose to continue/));
    assert.equal(h.calls.length, 3, "draft, re-call, its fix");
    assert.equal(t.result.message, FIX);
    assert.equal(t.shown, t.result.message);
    assert.equal(t.result.shouldEnd, false);
    assert.equal(has(h, /differs from the final message|changed after the seller was given it/), false);
    ok("intent re-call held for an add-back call: its gate fix is adopted (shown = saved)");
  }

  // ── 9. A stop only the classifier sees + a contradicted figure: the closing question stays ──
  {
    const deal = baseDeal({
      extractedInfo: {
        annualRevenue: "$4.1M (FY2024, per the financial statements)",
        _fieldSources: { annualRevenue: { source: "document", documentId: "doc-1" } },
      },
    });
    const h = installHarness(deal, { messages: [ai("How many presses run on each of the three shifts?"), seller("About 85 on first."), ai("What were total sales in your last full fiscal year?")] });
    const proto = (Anthropic as any).Messages.prototype;
    const create = proto.create;
    proto.create = async function (params: any) {
      if (params?.tools?.[0]?.name === "claim_conflicts") {
        return { content: [{ type: "tool_use", id: "c", name: "claim_conflicts", input: { conflicts: [{ said: "$5.2 million", onFile: "$4.1M", materialId: "M1", topic: "annual revenue", key: "annualRevenue" }] } }], stop_reason: "tool_use" };
      }
      return create.call(this, params);
    };
    h.intents.push({ stop: "soft" });
    h.script.push({ message: "What share of that came from medical programs versus automotive?" });
    h.script.push({ message: "Understood — before you go, one last one: when does the Toledo lease come up for renewal?" });
    h.script.push({ message: "You mentioned $5.2 million, but the statements show $4.1M for 2024 — which figure is right?" });
    const t = await streamedTurn(h, "Sales were $5.2 million last year. My head's spinning. I need a coffee and a lie-down.");
    proto.create = create;
    assert.ok(has(h, /Intent re-call on session sess-1: seller stop \(soft\)/));
    assert.equal(h.calls.length, 2, "no reconcile rewrite of the closing question");
    assert.match(t.result.message, /Toledo lease/);
    assert.equal(t.shown, t.result.message);
    ok("stop the classifier saw: the one closing question is never turned into a reconcile of the figure just given");
  }

  // ── 10. Facts before chips: the ready event carries the model's own chips ──
  {
    const h = installHarness(baseDeal(), { messages: [...history] });
    const chips = ["All of them", "Only the newest press loan", "I'd have to check with Rob"];
    h.script.push({
      message: "Which of the equipment term loans would a buyer be expected to assume?",
      whyItMatters: "Buyers price the debt they take on, so they want to know which loans come with the business.",
      suggestedAnswers: chips,
      chipsLast: true,
      ...bigTail,
    });
    const t = await streamedTurn(h, "Diane handles Maumee herself; Rob covers the quality side.");
    assert.ok(t.ready, "a ready event was sent");
    assert.deepEqual(t.ready!.suggestedAnswers, chips, "the model's chips, not the generic backfill");
    assert.deepEqual(t.result.suggestedAnswers, chips);
    assert.equal(t.ready!.whyItMatters, t.result.whyItMatters);
    assert.equal(t.shown, t.result.message);
    ok("a model that writes its facts before its chips: ready carries its real chips (no generic backfill saved)");
  }

  // ── 11. The tail breaks off after a goodbye was shown: the goodbye and the end stand ──
  {
    const h = installHarness(coveredDeal(), { messages: longHistory() });
    h.intents.push({ stop: "none" });
    h.script.push({
      message: "Thanks, Gord — that gives your broker everything needed for the memorandum. Everything you've shared is saved.",
      shouldEnd: true,
      endReason: "All critical sections are covered",
      suggestedAnswers: [],
      ...bigTail,
      streamBreaksAt: 0.6,
    });
    const t = await streamedTurn(h, "Nothing else on the tool room — Greg runs it and it's all documented.");
    assert.equal(t.result.message, t.shown, "never swapped for the fault notice");
    assert.equal(t.result.shouldEnd, true, "the goodbye the seller read ends the interview");
    ok("a tail that breaks off after the goodbye was shown: the goodbye stays and the interview ends");
  }

  // ── 12. Unanswered openings: reused only for the same mode and the same review / evidence ──
  {
    const base = {
      extractedInfo: { a: 1 },
      documents: [],
      sessions: [],
      openDiscrepancies: [],
      tasks: [],
    };
    const b0 = openingBasis(base);
    assert.equal(openingBasis({ ...base, conductedBy: "seller" }), b0, "the seller alone is the default mode");
    assert.notEqual(openingBasis({ ...base, conductedBy: "broker_with_seller" }), b0, "a broker-led session has its own opening");
    const review = { fingerprint: "f1", computedAt: "2026-09-26T10:00:00Z", status: "ready", conflicts: [{ key: "x" }] };
    assert.notEqual(openingBasis({ ...base, sourceReview: review }), b0, "a source review that landed changes it");
    assert.notEqual(openingBasis({ ...base, sourceReview: review }), openingBasis({ ...base, sourceReview: { ...review, computedAt: "2026-09-26T11:00:00Z" } }));
    assert.notEqual(openingBasis({ ...base, evidence: { version: 2, fingerprint: "e", status: "ready", computedAt: "t" } }), b0, "an evidence build that landed changes it");
    assert.equal(openingBasis({ ...base, evidence: { version: 2, fingerprint: "e", status: "failed", computedAt: "t" } }), b0, "a failed build adds nothing the opening could use");

    const earlier = {
      id: "sess-0", dealId: "deal-1", participantId: "p", status: "completed",
      messages: [ai("How many toolmakers work in the tool room?"), seller("Nine, led by Greg.")],
      extractedInfo: { _industryContext: { industry: "Manufacturing", subIndustry: "Injection molding", location: "Toledo, OH", industrySpecificAreas: [], regulatoryNotes: [] } },
      questionsAsked: 1, questionsAnswered: 1, questionsSkipped: 0,
      lastActivityAt: new Date(Date.now() - 86_400_000), completedAt: new Date(Date.now() - 86_400_000),
    };
    const h = installHarness(baseDeal({ interviewCompleted: true }));
    h.sessions.push(earlier);
    const opening = "Good to pick up where we left off on the tool room. Which programs are you quoting right now that could start in 2026?";
    h.script.push({ message: opening, ...bigTail });
    await startOrResumeSession("deal-1", { resume: true });
    const created = h.sessions.find((s) => s.id !== "sess-0")!;
    assert.equal(created.extractedInfo._conductedBy, "seller");
    await startOrResumeSession("deal-1"); // a page visit closes the unanswered opening
    // The broker starts "Interview together": the seller's unanswered opening is not theirs.
    const spoken = "Picking up from the tool room: which programs are you quoting right now that could start in 2026?";
    h.script.push({ message: spoken, ...bigTail });
    const calls = h.calls.length;
    const together = await startOrResumeSession("deal-1", { resume: true, conductedBy: "broker_with_seller" });
    assert.equal(h.calls.length, calls + 1, "a new opening, written for the broker-led session");
    assert.notEqual(together.sessionId, created.id);
    assert.match(h.systems[h.systems.length - 1], /SESSION MODE: BROKER-LED/, "the opening is written for the broker reading it aloud");
    assert.equal(has(h, /Reopened the unanswered opening/), false);

    // A source review landing after an opening was written: not reused.
    const h2 = installHarness(baseDeal({ interviewCompleted: true }));
    h2.sessions.push({ ...earlier, messages: [...earlier.messages] });
    h2.script.push({ message: opening, ...bigTail });
    await startOrResumeSession("deal-1", { resume: true });
    await startOrResumeSession("deal-1");
    h2.deal = { ...h2.deal, interviewSourceReview: { fingerprint: "f", computedAt: new Date().toISOString(), status: "ready", conflicts: [] } };
    h2.script.push({ message: opening, ...bigTail });
    const c2 = h2.calls.length;
    await startOrResumeSession("deal-1", { resume: true });
    assert.equal(h2.calls.length, c2 + 1, "the review landed since: a new opening");

    // A first session's opening the seller never answered, then "Interview
    // together": rewritten in place for the broker-led session.
    const h3 = installHarness(baseDeal());
    h3.script.push({ message: "To start, what does Great Lakes Plastics make, and for whom?", ...bigTail });
    const first = await startOrResumeSession("deal-1");
    h3.script.push({ message: "What does Great Lakes Plastics make, and who are its main customers?", ...bigTail });
    const c3 = h3.calls.length;
    const joint = await startOrResumeSession("deal-1", { resume: true, conductedBy: "broker_with_seller" });
    assert.equal(h3.calls.length, c3 + 1, "a new opening for the broker-led session");
    assert.equal(joint.sessionId, first.sessionId, "the same session row, rewritten");
    assert.equal(h3.sessions.length, 1);
    assert.equal(h3.sessions[0].extractedInfo._conductedBy, "broker_with_seller");
    assert.equal((h3.sessions[0].messages as ConversationMessage[]).length, 1);
    // …and the seller's own visit afterwards never continues it as the
    // broker-led session (review F1): the unanswered opening is rewritten
    // for the seller alone, in the same row.
    h3.script.push({ message: "What does Great Lakes Plastics make, and who buys from you?", ...bigTail });
    const c4 = h3.calls.length;
    const back = await startOrResumeSession("deal-1");
    assert.equal(h3.calls.length, c4 + 1, "a new opening, written for the seller");
    assert.equal(back.sessionId, first.sessionId);
    assert.equal(h3.sessions[0].extractedInfo._conductedBy, "seller");
    assert.doesNotMatch(h3.systems[h3.systems.length - 1], /SESSION MODE: BROKER-LED/);
    ok("unanswered openings: reused only for the same mode and the same source review / evidence");
  }

  process.stdout.write(`\n${n} groups passed\n`);
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
