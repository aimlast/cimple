// Second free round, interview stream — whole turns with a scripted model
// (tests/interview/turn-harness.ts): short breaks, returns after a stop,
// the fault notice + Continue, the outage opening, and the seller's link
// after an "Interview together" call. No network, no paid model.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/f2-interview-turns.test.ts
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import type { ConversationMessage } from "@shared/schema";
import { installHarness, baseDeal, ai, seller, type Harness } from "./turn-harness";
import { processTurn, startOrResumeSession } from "../../server/interview/session-manager";
import { PAUSE_REPLY, DEGRADED_TURN_MESSAGE, TRANSIENT_RETRY } from "../../server/interview/turn-guard";
import { CONTINUE_AFTER_FAULT } from "../../shared/interview-fault";

TRANSIENT_RETRY.delaysMs = [0, 0];
let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };
const has = (h: Harness, re: RegExp) => h.logs.some((l) => re.test(l));

const history = [
  ai("How many people work at the clinic, full- and part-time?"),
  seller("Eleven full-time, four part-time."),
  ai("Who holds the Hillhurst lease — you personally or the corporation?", { suggestedAnswers: ["The corporation", "Me personally", "Not sure"] }),
];
const OFFER = "Want to take a few minutes? Everything so far is saved, and we'll carry on from here when you're back.";
const CLOSING = "Before you go, the one thing I'd most like to pin down is your asking-price expectation — a rough number now, or shall we start there next time?";

(async () => {
  // ── 1. The finding's scenario: the AI offers a break, the seller takes it, comes back and answers ──
  {
    const h = installHarness(baseDeal(), { messages: [...history.slice(0, 2), ai(OFFER)] });
    // The classifier as it read this before the fix: a soft stop.
    h.intents.push({ stop: "soft" });
    h.script.push({ message: "Sure — take your time.", shouldEnd: false });
    const t1 = await processTurn("deal-1", "sess-1", "yes, a short break would help");
    assert.equal(t1.message, PAUSE_REPLY);
    assert.equal(t1.shouldEnd, false);
    assert.equal(has(h, /Seller stop signal/), false, "not a stop");
    assert.equal(has(h, /short break/), true);
    const s = h.sessions[0];
    assert.equal(s.messages[s.messages.length - 1].pause, true, "the reply is stored as a pause");
    assert.equal(s.extractedInfo._stopSignalCount, 0);
    // Ten minutes later the seller answers — an ordinary turn.
    h.intents.push({ stop: "none" });
    h.script.push({ message: "When does the current term end?", targetSection: "location_site" });
    const t2 = await processTurn("deal-1", "sess-1", "OK I'm back. The corporation holds it, runs to 2031 with two five-year renewals.");
    assert.equal(t2.shouldEnd, false);
    assert.equal(h.deal.interviewCompleted, false, "no forced goodbye, no 'interview complete'");
    assert.match(t2.message, /\?$/);
    ok("F2-INT-2: 'yes, a short break would help' gets 'take your time' (no stop even when the classifier says soft); the answer after it carries on");
  }

  // ── 2. A stop, its closing turn, then the seller returns from a meeting ──
  {
    const h = installHarness(baseDeal(), { messages: [...history, seller("Sorry, I have to go to a meeting."), ai(CLOSING)], sessionMeta: { _stopSignalCount: 1 } });
    h.script.push({ message: "Understood — when does the lease's current term end?", targetSection: "location_site" });
    const t = await processTurn("deal-1", "sess-1", "OK I'm back. The lease runs to 2031 with two five-year renewals.");
    assert.equal(t.shouldEnd, false, "a return is carrying on, not the closing turn's answer");
    assert.equal(has(h, /Forcing shouldEnd=true/), false);
    assert.equal(h.deal.interviewCompleted, false);
    ok("F2-INT-2: after a stop's closing turn, 'OK I'm back. The lease runs to 2031…' carries on (it used to force the goodbye)");

    // …whereas answering the closing turn still ends it (the seller's stop wins).
    const h2 = installHarness(baseDeal(), { messages: [...history, seller("Sorry, I have to go to a meeting."), ai(CLOSING)], sessionMeta: { _stopSignalCount: 1 } });
    h2.script.push({ message: "Thanks — that's saved, and you can pick this up anytime.", shouldEnd: false });
    const end = await processTurn("deal-1", "sess-1", "Around $2.5M.");
    assert.equal(end.shouldEnd, true);
    assert.equal(h2.deal.interviewCompleted, true);
    ok("F2-INT-2: the answer to the closing turn still ends the interview");

    // A pause during the closing turn: nothing ends; the answer after it still closes.
    const h3 = installHarness(baseDeal(), { messages: [...history, seller("Sorry, I have to go to a meeting."), ai(CLOSING)], sessionMeta: { _stopSignalCount: 1 } });
    h3.script.push({ message: "No problem.", shouldEnd: true, endReason: "seller asked to stop" });
    const p = await processTurn("deal-1", "sess-1", "Hang on, let me grab the number.");
    assert.equal(p.shouldEnd, false, "a break is never the end");
    assert.equal(p.message, PAUSE_REPLY);
    assert.equal(h3.sessions[0].extractedInfo._stopSignalCount, 1, "the stop the closing turn waits on carries over");
    h3.script.push({ message: "Thanks — everything is saved.", shouldEnd: true, endReason: "seller asked to stop" });
    const after = await processTurn("deal-1", "sess-1", "Around $2.5M.");
    assert.equal(after.shouldEnd, true);
    ok("F2-INT-2: 'hang on, let me grab the number' during the closing turn pauses; the number after it ends as the closing answer");
  }

  // ── 3. The fault notice and Continue ──
  {
    const h = installHarness(baseDeal(), { messages: [...history] });
    // No scripted reply: the model call fails → the degraded turn.
    const t = await processTurn("deal-1", "sess-1", "The corporation holds it. It's a ten-year lease from 2021 with two five-year renewals, and the landlord has been easy to work with.");
    assert.equal(t.degraded, true);
    assert.equal(t.message, DEGRADED_TURN_MESSAGE);
    const stored = h.sessions[0].messages;
    assert.equal(stored[stored.length - 2].role, "user", "the answer is saved");
    assert.equal(stored[stored.length - 1].degraded, true);
    // The seller presses Continue: the model is told to answer the saved answer.
    h.script.push({ message: "When does the current term end — 2031?", targetSection: "location_site" });
    const t2 = await processTurn("deal-1", "sess-1", CONTINUE_AFTER_FAULT);
    assert.equal(t2.degraded, undefined);
    assert.match(h.systems[h.systems.length - 1], /# RECOVERY NOTE[\s\S]*Continue button they pressed after the fault notice/);
    ok("F2-INT-4: a failed turn saves the answer, says so, and is flagged; Continue tells the model to answer the saved message");
  }

  // ── 4. The outage opening is never reused, and is rewritten on the next start ──
  {
    const h = installHarness(baseDeal(), {});
    const first = await startOrResumeSession("deal-1", { conductedBy: "seller" } as any);
    assert.doesNotMatch(first.message, /!|\bCIM\b|\?/);
    const s = h.sessions[0];
    assert.equal(s.extractedInfo._openingDegraded, true);
    assert.equal(s.extractedInfo._openingBasis, undefined, "no reuse basis");
    // The model is back: the next start rewrites the opening in place.
    h.script.push({ message: "Welcome, and thanks for making time for this. How did you come to own the clinic?", targetSection: "company_overview" });
    const second = await startOrResumeSession("deal-1", { conductedBy: "seller" } as any);
    assert.match(second.message, /How did you come to own the clinic\?/);
    assert.equal(h.sessions.length, 1, "the same session, rewritten");
    assert.equal(h.sessions[0].extractedInfo._openingDegraded, undefined);
    ok("F2-INT-8: an opening written during an outage is a plain notice, never reused, and replaced by a real opening on the next start");
  }

  // ── 5. After an "Interview together" call ends, the seller's link opens ──
  {
    const now = Date.now();
    const together = {
      id: "sess-t",
      dealId: "deal-1",
      participantId: null,
      messages: [ai("Who holds the lease?"), seller("Broker: Who holds the lease?\nSeller: The corporation.")],
      extractedInfo: { _conductedBy: "broker_with_seller", _conductedVia: "cimple" },
      status: "active",
      questionsAsked: 1, questionsAnswered: 1, questionsSkipped: 0,
      lastActivityAt: new Date(now - 5 * 60_000),
      completedAt: null,
    };
    // The call is still running: the seller is told the broker is going through it with them.
    const live = installHarness(baseDeal({ interviewCall: { roomName: "r", roomUrl: "u", startedAt: new Date(now - 20 * 60_000).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() } }), {});
    live.sessions.push({ ...together });
    const r1 = await startOrResumeSession("deal-1", { conductedBy: "seller" } as any);
    assert.equal(r1.status, "together_live");
    // The broker ended the call two minutes ago: the seller's own interview starts.
    const h = installHarness(baseDeal({ interviewCall: { roomName: "r", roomUrl: "u", startedAt: new Date(now - 20 * 60_000).toISOString(), expiresAt: new Date(now + 3600_000).toISOString(), endedAt: new Date(now - 2 * 60_000).toISOString() } }), {});
    h.sessions.push({ ...together, extractedInfo: { ...together.extractedInfo } });
    h.script.push({ message: "Welcome back. When does the lease's current term end?", targetSection: "location_site" });
    const r2 = await startOrResumeSession("deal-1", { conductedBy: "seller" } as any);
    assert.notEqual(r2.status, "together_live");
    assert.match(r2.message, /\?$/);
    assert.equal(h.sessions.find((s) => s.id === "sess-t")!.status, "completed", "the broker-led sitting is closed; the seller starts their own");
    ok("F2-INT-5: once the Cimple call has ended, the seller's link starts their own session instead of 'your broker is going through this with you now'");
  }

  // ── 6. The broker's own finished session isn't restarted by a page visit ──
  {
    const h = installHarness(baseDeal(), {});
    h.sessions.push({
      id: "sess-b",
      dealId: "deal-1",
      participantId: null,
      messages: [ai("What's the asking price you have in mind?"), seller("$2.4M, firm.")],
      extractedInfo: { _conductedBy: "broker" },
      status: "completed",
      questionsAsked: 1, questionsAnswered: 1, questionsSkipped: 0,
      lastActivityAt: new Date(),
      completedAt: new Date(),
    });
    const r = await startOrResumeSession("deal-1", { conductedBy: "broker" } as any);
    assert.equal(r.status, "completed");
    assert.equal(r.sessionId, "sess-b");
    assert.equal(h.calls.length, 0, "no opening was written");
    assert.equal(h.sessions.length, 1);
    // "Continue interview" (resume) starts a new broker session.
    h.script.push({ message: "What's left to cover on the lease — when does the current term end?", targetSection: "location_site" });
    const again = await startOrResumeSession("deal-1", { conductedBy: "broker", resume: true } as any);
    assert.notEqual(again.status, "completed");
    assert.equal(h.sessions.length, 2);
    ok("known leftover: loading 'Start AI Interview' after the broker's own session ended shows it finished (no paid opening); Continue starts a new one");
  }

  // ── Round 2 (F2-INT-2): the classifier's reading decides a break and a return ──
  {
    // The seller's question / objection / deferral opening with a pause word
    // reaches the model; its reply is shown (the checker's p2 probes).
    const cases: Array<[string, Record<string, unknown>, string, ConversationMessage[]?]> = [
      ["Hang on, why do you need that?", { stop: "none", pause: false, sellerQuestion: "why do you need that?" }, "Buyers and lenders look at who holds the lease because an assignment needs the landlord's consent. Is the lease in the corporation's name?"],
      ["Let me check and get back to you.", { stop: "none", pause: false }, "How many treatment rooms does the Hillhurst clinic have?"],
      ["Hold on, that's not what I said.", { stop: "none", pause: false }, "Which part should I correct — the staff numbers?"],
      ["Yes, every 4 hours", { stop: "none", pause: false }, "Who covers the front desk during those breaks?", [...history.slice(0, 2), ai("Do your therapists take a break between patient blocks?", { suggestedAnswers: ["Yes", "No"] })]],
    ];
    for (const [msg, intent, reply, hist] of cases) {
      const h = installHarness(baseDeal(), { messages: [...(hist ?? history)] });
      h.intents.push(intent);
      h.script.push({ message: reply, targetSection: "location_site" });
      const t = await processTurn("deal-1", "sess-1", msg);
      assert.notEqual(t.message, PAUSE_REPLY, msg);
      assert.equal(t.message, reply, msg);
      assert.equal(h.sessions[0].messages[h.sessions[0].messages.length - 1].pause, undefined, msg);
      assert.equal(has(h, /short break/), false, msg);
    }
    // A pattern break the classifier reads as carrying on: the draft written
    // for a break is redone once for an ordinary turn — never "take your time".
    {
      const h = installHarness(baseDeal(), { messages: [...history] });
      h.intents.push({ stop: "none", pause: false });
      h.script.push({ message: "Sure.", shouldEnd: false });
      h.script.push({ message: "Is the lease in the corporation's name or yours?", targetSection: "location_site" });
      const t = await processTurn("deal-1", "sess-1", "brb");
      assert.equal(t.message, "Is the lease in the corporation's name or yours?");
      assert.equal(has(h, /Intent re-call on session sess-1: not a short break/), true);
      assert.match(h.systems[0], /# SHORT BREAK/);
      assert.doesNotMatch(h.systems[1], /# SHORT BREAK/);
    }
    ok("F2-INT-2 r2: a question, objection or deferral opening with a pause word gets the model's answer; a pattern break the classifier doesn't confirm is redone as an ordinary turn");
  }
  {
    // After a stop's closing turn, answers that mention being back end the
    // interview (the checker's p3 probes) — and a pattern return the
    // classifier doesn't confirm is the closing turn's answer too.
    for (const msg of [
      "Revenue is back now to where it was pre-covid, about $2M.",
      "Since my knee surgery I'm back full-time, and revenue has been flat at about $1.9M.",
      "Sorry about that. It dipped in 2020 and has grown about 8% a year since.",
      "OK I'm back. It dipped in 2020 and has grown about 8% a year since.",
      "Grew about 8% a year since 2021.",
    ]) {
      const h = installHarness(baseDeal(), { messages: [...history, seller("Sorry, I have to go to a meeting."), ai(CLOSING)], sessionMeta: { _stopSignalCount: 1 } });
      h.intents.push({ stop: "none", continueRequest: false });
      h.script.push({ message: "What share of that revenue comes from WSIB and MVA claims?", targetSection: "financial_overview" });
      h.script.push({ message: "Thanks — that's saved, and we can start with the payer mix next time.", shouldEnd: true, endReason: "seller asked to stop" });
      const t = await processTurn("deal-1", "sess-1", msg);
      assert.equal(t.shouldEnd, true, msg);
      assert.equal(h.deal.interviewCompleted, true, msg);
      assert.doesNotMatch(t.message, /\?/, msg);
    }
    // A return right after a "take your time" carries on, apology included.
    {
      const h = installHarness(baseDeal(), {
        messages: [...history, seller("Sorry, I have to go to a meeting."), ai(CLOSING), seller("Hang on, let me grab the number."), ai(PAUSE_REPLY, { pause: true })],
        sessionMeta: { _stopSignalCount: 1 },
      });
      h.script.push({ message: "Is that $2.5M for the shares or the assets?", targetSection: "transaction_overview" });
      const t = await processTurn("deal-1", "sess-1", "Sorry about that. Asking price — around $2.5M.");
      assert.equal(t.shouldEnd, false, "after the break, 'Sorry about that' is a return (patterns only)");
    }
    ok("F2-INT-2 r2: after a stop's closing turn, 'revenue is back now…', 'I'm back full-time…', 'Sorry about that. It dipped…' end the interview; the classifier's 'not carrying on' wins over a pattern return");
  }
  {
    // A break only the classifier sees, arriving after the stream gate
    // showed the model's question: the shown question stays, is saved as an
    // ordinary turn (no pause flag), and nothing ends.
    const h = installHarness(baseDeal(), { messages: [...history] });
    const proto = (Anthropic as any).Messages.prototype;
    const create = proto.create;
    proto.create = async function (params: any) {
      if (params?.tools?.[0]?.name === "seller_intent") await new Promise((r) => setTimeout(r, 5_600));
      return create.call(this, params);
    };
    h.intents.push({ stop: "none", pause: true });
    h.script.push({ message: "Is the Hillhurst lease in the corporation's name?", targetSection: "location_site" });
    let shown = "";
    const t = await processTurn("deal-1", "sess-1", "Sorry, delivery guy at the door", (c) => { shown += c; });
    proto.create = create;
    assert.equal(shown, "Is the Hillhurst lease in the corporation's name?");
    assert.equal(t.message, shown, "the reply shown is never swapped for 'take your time'");
    const last = h.sessions[0].messages[h.sessions[0].messages.length - 1];
    assert.equal(last.pause, undefined);
    assert.equal(last.content, shown);
    assert.equal(t.shouldEnd, false);
    assert.equal(has(h, /Seller break read after the reply was shown/), true);
    ok("F2-INT-2 r2: a break the classifier reads only after the reply was shown keeps the shown reply (never swapped)");
  }

  console.log(`\n${n} groups passed`);
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e?.stack ?? e) + "\n"); process.exit(1); });
