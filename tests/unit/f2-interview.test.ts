/**
 * Second free round, interview stream (F2-INT-2 … F2-INT-10) — the pure
 * pieces. Whole turns with a scripted model are in
 * tests/interview/f2-interview-turns.test.ts.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f2-interview.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  detectPause,
  sellerResumed,
  interviewerOfferedBreak,
  detectStopSignal,
  PAUSE_REPLY,
  PAUSE_REPLY_AFTER_OFFER,
  pauseReplyFor,
  DEGRADED_TURN_MESSAGE,
  fallbackQuestion,
  leaksInternalMachinery,
  sanctionedFigureText,
  valuationDeflection,
  containsValuationFigures,
  asksQuestion,
} from "../../server/interview/turn-guard";
import { quickIntent, combineIntent, parseIntent, intentPrompt, type SellerIntent } from "../../server/interview/seller-intent";
import { resolveStopState } from "../../server/interview/turn-release";
import { togetherSessionLive, togetherEndedAt, writeIfTranscriptUnchanged, withSessionTurnLock, TOGETHER_LIVE_MS } from "../../server/interview/session-mode";
import { countedSellerTurns, isContinueAfterFault, CONTINUE_AFTER_FAULT } from "../../shared/interview-fault";
import { exchangesOf, degradedOpeningMessage } from "../../server/interview/session-manager";
import { normalisationCallIn } from "../../server/interview/reply-polish";
import { typedNumericValues } from "../../server/interview/info-merger";
import {
  PAUSES, PAUSE_ACCEPTS, PAUSE_OFFER, RETURNS, CLOSING_ANSWERS, CLOSING_PREV,
  BUSINESS, NEUTRAL, STOP_PATTERN_MUST, DEFERRALS, DEFERRAL_PREV,
  RETURNS_AFTER_PAUSE, NOT_PAUSES, BUSINESS_BREAK_Q,
} from "../interview/seller-intent-corpus.data";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };

/** The turn's stop state from the patterns alone, exactly as processTurn starts it. */
function patternsTurn(message: string, prevAi: string | undefined, priorStopCount: number, afterPause = false) {
  const q = quickIntent(message, prevAi, { afterPause });
  const start = {
    stopNow: q.stop !== "none",
    stopSignalCount: q.stop !== "none" ? priorStopCount + 1 : q.pause ? priorStopCount : 0,
    stopLevel: q.stop,
    closingAnswerTurn: q.stop === "none" && priorStopCount > 0 && !q.continueRequest && !q.pause,
  };
  return { q, st: resolveStopState(start, priorStopCount, q) };
}

(async () => {
  // ── F2-INT-2: a short break is not a stop; a return is carrying on ──
  {
    // The finding's own probe: each of these, sent after a stop's closing
    // turn, used to give continueRequest=false and forcedEnd=true.
    for (const m of RETURNS) {
      const { q, st } = patternsTurn(m, CLOSING_PREV, 1);
      assert.equal(q.continueRequest, true, m);
      assert.equal(st.forcedEnd, false, m);
      assert.equal(sellerResumed(m), true, m);
    }
    // Right after a "take your time", an apology for the wait opens a return too.
    for (const m of RETURNS_AFTER_PAUSE) {
      assert.equal(patternsTurn(m, CLOSING_PREV, 1, true).st.forcedEnd, false, m);
      assert.equal(patternsTurn(m, CLOSING_PREV, 1, false).st.forcedEnd, true, `${m} (no break before it: the closing turn's answer)`);
    }
    // A real answer to the closing turn still ends the interview (the stop
    // wins) — "Revenue is back now…", "I'm back full-time…", "Sorry about
    // that. It dipped in 2020…" included (round 2).
    for (const m of CLOSING_ANSWERS) {
      const { q, st } = patternsTurn(m, CLOSING_PREV, 1);
      assert.equal(q.continueRequest, false, m);
      assert.equal(q.pause, false, m);
      assert.equal(st.forcedEnd, true, m);
    }
    // Stepping away: a pause, no stop, no closing turn, nothing ends.
    for (const m of PAUSES) {
      const { q, st } = patternsTurn(m, "Who holds the lease — you personally or the corporation?", 0);
      assert.equal(q.pause, true, m);
      assert.equal(q.stop, "none", m);
      assert.equal(st.forcedEnd, false, m);
      assert.equal(st.paused, true, m);
      assert.equal(st.stopSignalCount, 0, m);
    }
    // Accepting the interviewer's offer of a break (it used to be a soft stop).
    for (const m of PAUSE_ACCEPTS) assert.equal(detectPause(m, PAUSE_OFFER), true, m);
    assert.equal(detectPause("No, I'm fine, let's keep going", PAUSE_OFFER), false);
    // A pause during a stop's closing turn: nothing ends, and the stop count
    // it was waiting on carries over — the answer after the break is still
    // the closing turn's answer.
    {
      const { st } = patternsTurn("Hang on, let me grab the lease.", CLOSING_PREV, 1);
      assert.equal(st.forcedEnd, false);
      assert.equal(st.stopSignalCount, 1);
      const after = patternsTurn("Around $2.5M.", CLOSING_PREV, st.stopSignalCount);
      assert.equal(after.st.forcedEnd, true);
    }
    // Precision: answers, business sentences and leaving-for-the-day are not pauses.
    for (const m of [
      "One sec. The lease runs to 2031.",
      "Hold on, let me think — about 40.",
      "We take a break every afternoon at 3 for the crew.",
      "We went back in 2019 to renegotiate.",
      "Let me check with my accountant and get back to you on that.",
      "Let me get back to you on that.",
      "I need a break, let's do the rest tomorrow.",
      "I need to jump on another call.",
      "Please stop asking me questions.",
      ...BUSINESS,
      ...NEUTRAL,
    ]) assert.equal(detectPause(m), false, m);
    for (const m of DEFERRALS) assert.equal(detectPause(m, DEFERRAL_PREV), false, m);
    // Every stop the patterns must catch is still a stop (none turned into a pause).
    for (const m of STOP_PATTERN_MUST) assert.notEqual(quickIntent(m).stop, "none", m);
    // A pause wins over the soft stop its words also read as ("I have to run" is a stop; "…back in ten" makes it a break).
    assert.equal(detectStopSignal("Sorry, I have to run — back in ten minutes."), true);
    assert.deepEqual([quickIntent("Sorry, I have to run — back in ten minutes.").stop, quickIntent("Sorry, I have to run — back in ten minutes.").pause], ["none", true]);
    // The classifier's reading: its pause wins over its own (or the patterns') soft stop, never a firm one.
    const quick = quickIntent("yes, a short break would help", PAUSE_OFFER);
    const oldReading = parseIntent({ stop: "soft", continueRequest: false, sellerQuestion: "", retractions: [], corrections: [], privacyRequests: [] })!;
    assert.equal(oldReading.pause, false);
    const combined = combineIntent(quick, oldReading);
    assert.deepEqual([combined.stop, combined.pause], ["none", true], "the patterns' pause stands against the classifier's soft stop");
    const modelPause = parseIntent({ stop: "none", pause: true, continueRequest: false, sellerQuestion: "", retractions: [], corrections: [], privacyRequests: [] })!;
    assert.equal(combineIntent(quickIntent("ok, a few minutes"), modelPause).pause, true, "the classifier's pause is used");
    const firm = combineIntent(quickIntent("Please stop asking me questions."), modelPause);
    assert.deepEqual([firm.stop, firm.pause], ["firm", false], "a firm stop is never a pause");
    assert.equal(parseIntent({ stop: "firm", pause: true, continueRequest: false, sellerQuestion: "", retractions: [], corrections: [], privacyRequests: [] })!.pause, false);
    // The pause reply asks nothing (the question on screen is still the one), and the nudge says so.
    assert.equal(asksQuestion(PAUSE_REPLY), false);
    assert.match(PAUSE_REPLY, /saved/);
    // The classifier is told what a pause is, and that a return is carrying on.
    const src = fs.readFileSync(path.join(REPO, "server/interview/seller-intent.ts"), "utf8");
    assert.match(src, /pause: true when the seller is stepping away for a SHORT while/);
    assert.match(src, /says they are back from a break and carrying on/);
    assert.match(intentPrompt({ sellerMessage: "brb", prevAiMessage: PAUSE_OFFER, recentFacts: [] }), /brb/);
    ok("F2-INT-2: a short break is a pause (no stop, no closing turn); a return from one carries on; a real closing answer still ends");
  }
  // ── F2-INT-2, round 2: the patterns never overrule the classifier on a break or a return ──
  {
    const PREV = "Who holds the lease — you personally or the corporation?";
    // Pattern precision: questions, objections and deferrals opening with a pause word, business sentences.
    for (const m of NOT_PAUSES) {
      assert.equal(detectPause(m, PREV), false, m);
      assert.equal(quickIntent(m, PREV).pause, false, m);
    }
    // A question about the business's own breaks is not the interviewer's offer of one.
    assert.equal(interviewerOfferedBreak(BUSINESS_BREAK_Q), false);
    assert.equal(interviewerOfferedBreak(PAUSE_OFFER), true);
    assert.equal(interviewerOfferedBreak("Want to take a few minutes, or stop here for today? Everything so far is saved."), true);
    assert.equal(detectPause("Yes, every 4 hours", BUSINESS_BREAK_Q), false);
    assert.equal(detectPause("Yes", BUSINESS_BREAK_Q), false);
    assert.equal(detectPause("Yes please", PAUSE_OFFER), true);
    // Still pauses: the corpus, and the checker's own positives.
    for (const m of ["brb", "Hang on, let me grab the lease.", "Give me two minutes.", "One sec, someone's at the door.", "Back in 5", "Hold on, let me think.", "Let me grab my accountant's file, one moment.", "I've got to take this call.", "Sorry, let me answer the phone — back in five."]) {
      assert.equal(detectPause(m, PREV), true, m);
    }
    // Returns open the message; an answer that mentions being back is not one.
    for (const m of ["Since my knee surgery I'm back full-time in the shop.", "Revenue is back now to where it was pre-covid, about $2M.", "Ready to sell as soon as possible, honestly.", "Sorry for the delay, I'm really out of time. Around $2.5M.", "Sorry about that, the asking price is around $2.5M."]) {
      assert.equal(sellerResumed(m), false, m);
      assert.equal(quickIntent(m, CLOSING_PREV).continueRequest, false, m);
    }
    assert.equal(sellerResumed("Sorry about that, the asking price is around $2.5M.", { afterPause: true }), true);
    const reading = (o: Record<string, unknown>) => parseIntent({ stop: "none", pause: false, continueRequest: false, sellerQuestion: "", retractions: [], corrections: [], privacyRequests: [], ...o })!;
    // The classifier's "no break" wins over a pattern pause (a question it
    // may have missed, business wording): no "take your time".
    const q1 = { ...quickIntent("brb", PREV) };
    assert.equal(q1.pause, true);
    assert.equal(combineIntent(q1, reading({})).pause, false, "the classifier reads carrying on: no pause");
    assert.equal(combineIntent(q1, reading({ pause: true })).pause, true);
    assert.equal(combineIntent(q1, null).pause, true, "without the classifier the patterns decide");
    // …but its soft stop and the patterns' break agree the seller is stepping away: the break wins (nothing ends).
    assert.deepEqual([combineIntent(q1, reading({ stop: "soft" })).stop, combineIntent(q1, reading({ stop: "soft" })).pause], ["none", true]);
    // A return only the patterns saw is the classifier's call once it is in.
    const back = quickIntent("OK I'm back. The lease runs to 2031.", CLOSING_PREV);
    assert.deepEqual([back.continueRequest, back.resumeOnly], [true, true]);
    assert.equal(combineIntent(back, reading({})).continueRequest, false, "classifier continueRequest:false wins over a pattern return");
    assert.equal(combineIntent(back, reading({ continueRequest: true })).continueRequest, true);
    assert.equal(combineIntent(back, null).continueRequest, true);
    // An explicit "let's keep going" still stands with the patterns (as before this round).
    const keep = quickIntent("Let's keep going.", CLOSING_PREV);
    assert.equal(keep.resumeOnly, undefined);
    assert.equal(combineIntent(keep, reading({})).continueRequest, true);
    // The final stop state follows the final reading: a pattern return or
    // break after a closing turn the classifier doesn't confirm is the
    // closing turn's answer (forced end); a pattern break the classifier
    // reads as an ordinary turn resets the count.
    const start = (q: SellerIntent, prior: number) => ({
      stopNow: q.stop !== "none",
      stopSignalCount: q.stop !== "none" ? prior + 1 : q.pause ? prior : 0,
      stopLevel: q.stop,
      closingAnswerTurn: q.stop === "none" && prior > 0 && !q.continueRequest && !q.pause,
    });
    const retFinal = resolveStopState(start(back, 1), 1, combineIntent(back, reading({})));
    assert.deepEqual([retFinal.closingAnswerTurn, retFinal.forcedEnd, retFinal.paused], [true, true, false]);
    const brbFinal = resolveStopState(start(q1, 1), 1, combineIntent(q1, reading({})));
    assert.deepEqual([brbFinal.forcedEnd, brbFinal.stopSignalCount, brbFinal.paused], [true, 0, false], "a break the classifier doesn't read, after a closing turn, answers it");
    const brbFresh = resolveStopState(start(q1, 0), 0, combineIntent(q1, reading({})));
    assert.deepEqual([brbFresh.forcedEnd, brbFresh.stopSignalCount, brbFresh.paused], [false, 0, false]);
    // The classifier is told these are not breaks / not returns.
    const src = fs.readFileSync(path.join(REPO, "server/interview/seller-intent.ts"), "utf8");
    assert.match(src, /Also pause false: a question or objection that opens with a pause word/);
    assert.match(src, /An answer that only mentions being back/);
    ok("F2-INT-2 r2: questions, objections and deferrals that open with a pause word are not breaks; returns open the message; the classifier's reading decides both once it is in");
  }
  {
    // The transcript: "be right back" and the answer after it both answer the question before the pause reply.
    const t0 = "2026-09-28T10:00:00.000Z";
    const msgs = [
      { role: "ai", content: "Who holds the lease?", timestamp: t0 },
      { role: "user", content: "Hang on, let me grab it.", timestamp: t0 },
      { role: "ai", content: PAUSE_REPLY, timestamp: t0, pause: true },
      { role: "user", content: "The corporation holds it, to 2031.", timestamp: t0 },
    ] as any[];
    assert.deepEqual(exchangesOf(msgs), [{ question: "Who holds the lease?", answer: "Hang on, let me grab it.\nThe corporation holds it, to 2031." }]);
    ok("F2-INT-2: the pause reply is not a question in the exchange record — the answer after the break pairs with the question before it");
  }

  // ── F2-INT-3: the resume write never overwrites a turn's save ──
  {
    const store = { messages: [{ timestamp: "a" }, { timestamp: "b" }] as Array<{ timestamp?: string; content?: string }> };
    const expected = [...store.messages];
    let writes = 0;
    const args = {
      sessionId: "sess-race",
      expected,
      read: async () => store.messages,
      write: async () => { writes++; store.messages = [{ timestamp: "a" }, { timestamp: "b", content: "polished" }]; },
    };
    // A turn is running: skipped without waiting for it.
    let release!: () => void;
    const turn = withSessionTurnLock("sess-race", () => new Promise<void>((r) => { release = r; }));
    assert.equal(await writeIfTranscriptUnchanged(args), "turn_in_flight");
    // The turn saves its exchange, then the resume's stale write comes in: refused.
    store.messages = [...store.messages, { timestamp: "c" }, { timestamp: "d" }];
    await new Promise((r) => setImmediate(r));
    release();
    await turn;
    await new Promise((r) => setImmediate(r)); // (the lock is released a tick after the turn)
    assert.equal(await writeIfTranscriptUnchanged(args), "changed");
    assert.equal(writes, 0);
    assert.equal(store.messages.length, 4, "the turn's answer and reply are still there");
    // Nothing moved: the re-polish lands.
    const fresh = [...store.messages];
    assert.equal(await writeIfTranscriptUnchanged({ ...args, expected: fresh }), "written");
    assert.equal(writes, 1);
    // A turn that starts while the check runs waits for it (the lock), then sees its own read.
    const src = fs.readFileSync(path.join(REPO, "server/interview/session-manager.ts"), "utf8");
    assert.match(src, /pendingQuestion && !pendingQuestion\.pause && !pendingQuestion\.degraded && !turnInFlight\(session\.id\)/);
    assert.match(src, /await writeIfTranscriptUnchanged\(\{/);
    assert.doesNotMatch(src, /await db\.update\(interviewSessions\)\.set\(\{ messages \}\)\.where\(eq\(interviewSessions\.id, session\.id\)\)/, "no unguarded whole-transcript write on resume");
    ok("F2-INT-3: the resume re-polish is skipped while a turn runs and never lands over a turn that saved meanwhile");
  }

  // ── F2-INT-4: a degraded turn is honest and never asks for a retype ──
  {
    assert.doesNotMatch(DEGRADED_TURN_MESSAGE, /may not have been recorded|send it again|\?/);
    assert.match(DEGRADED_TURN_MESSAGE, /saved/);
    assert.match(DEGRADED_TURN_MESSAGE, /Continue/);
    const t = "2026-09-28T10:00:00.000Z";
    const msgs = [
      { role: "ai", content: "Who are your top customers?", timestamp: t },
      { role: "user", content: "A 150-word answer about the customers…", timestamp: t },
      { role: "ai", content: DEGRADED_TURN_MESSAGE, timestamp: t, degraded: true },
      { role: "user", content: CONTINUE_AFTER_FAULT, timestamp: t },
      { role: "ai", content: DEGRADED_TURN_MESSAGE, timestamp: t, degraded: true },
      { role: "user", content: "A retyped version of the same answer", timestamp: t },
      { role: "ai", content: DEGRADED_TURN_MESSAGE, timestamp: t, degraded: true },
      { role: "user", content: CONTINUE_AFTER_FAULT, timestamp: t },
    ];
    // Only the first answer counts: two Continue presses and a retry during the fault don't.
    assert.equal(countedSellerTurns(msgs), 1);
    assert.equal(isContinueAfterFault(msgs, 3), true);
    assert.equal(isContinueAfterFault(msgs, 1), false);
    // A short break answered with "take your time" is not a turn either (F2-INT-2).
    assert.equal(countedSellerTurns([
      { role: "ai", content: "Who holds the lease?" },
      { role: "user", content: "brb" },
      { role: "ai", content: PAUSE_REPLY, pause: true },
      { role: "user", content: "The corporation." },
    ]), 1);
    // "Continue" as an ordinary answer (no fault before it) is a turn.
    assert.equal(countedSellerTurns([{ role: "ai", content: "Shall we carry on?" }, { role: "user", content: "Continue" }]), 1);
    // The client offers Continue on a fault notice.
    const client = fs.readFileSync(path.join(REPO, "client/src/components/AIConversationInterface.tsx"), "utf8");
    assert.match(client, /last\?\.role === "ai" && last\.degraded === true/);
    assert.match(client, /handleSend\(CONTINUE_AFTER_FAULT\)/);
    ok("F2-INT-4: the fault notice says the answer is saved and offers Continue; presses and retries during a fault don't count as turns");
  }

  // ── F2-INT-5: an ended call frees the seller's own link ──
  {
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    const lastAt = new Date(now - 5 * 60_000);
    const session = { id: "t1", status: "active", lastActivityAt: lastAt, extractedInfo: { _conductedBy: "broker_with_seller" } };
    // No deal info (old callers): live by activity, as before.
    assert.equal(togetherSessionLive(session, now), true);
    // The Cimple call ended after the last exchange: not live.
    const ended = { interviewCall: { endedAt: new Date(now - 2 * 60_000).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() } };
    assert.equal(togetherSessionLive(session, now, ended), false);
    // …the notetaker left the Zoom call: not live.
    assert.equal(togetherSessionLive(session, now, { interviewBot: { endedAt: new Date(now - 60_000).toISOString() } }), false);
    // A call still running: live.
    assert.equal(togetherSessionLive(session, now, { interviewCall: { expiresAt: new Date(now + 3600_000).toISOString() } }), true);
    // A call from an earlier sitting (ended before this sitting's last exchange): live by activity.
    assert.equal(togetherSessionLive(session, now, { interviewCall: { endedAt: new Date(now - 3 * 3600_000).toISOString() } }), true);
    // In person: the broker left the page after the last exchange.
    assert.equal(togetherSessionLive({ ...session, extractedInfo: { _conductedBy: "broker_with_seller", _leftAt: new Date(now - 60_000).toISOString() } }, now, null), false);
    // …and carried on after coming back: live again.
    assert.equal(togetherSessionLive({ ...session, lastActivityAt: new Date(now - 30_000), extractedInfo: { _conductedBy: "broker_with_seller", _leftAt: new Date(now - 60_000).toISOString() } }, now, null), true);
    // Past the window: not live whatever the call says.
    assert.equal(togetherSessionLive({ ...session, lastActivityAt: new Date(now - TOGETHER_LIVE_MS - 1) }, now, null), false);
    assert.equal(togetherEndedAt(session, { interviewCall: { expiresAt: new Date(now - 60_000).toISOString() } }, now), now - 60_000, "a room that expired ended at its expiry");
    const src = fs.readFileSync(path.join(REPO, "server/interview/session-manager.ts"), "utf8");
    assert.match(src, /togetherSessionLive\(s, Date\.now\(\), deal as TogetherCallState\)/);
    const routes = fs.readFileSync(path.join(REPO, "server/routes.ts"), "utf8");
    assert.match(routes, /app\.post\("\/api\/interview\/:dealId\/together\/leave", requireBroker, requireOwnedDeal/);
    const client = fs.readFileSync(path.join(REPO, "client/src/components/AIConversationInterface.tsx"), "utf8");
    assert.match(client, /\/together\/leave`, \{ method: "POST", credentials: "include", keepalive: true \}/);
    ok("F2-INT-5: once the call or notetaker ended (or the broker left the page) after the last exchange, the seller's link is no longer locked");
  }

  // ── F2-INT-6: the prompt files agree with the tone rules ──
  {
    const read = (f: string) => fs.readFileSync(path.join(REPO, "server/interview/prompts", f), "utf8");
    const all = ["conversation-rules.md", "handling-difficulty.md", "emotional-intelligence.md", "boundaries.md", "response-format.md"].map(read).join("\n");
    for (const bad of [
      /So if I'm capturing that correctly/,
      /That's helpful (?:context|background)\. One thing I want/,
      /40% GC is very manageable/,
      /We've made solid progress/,
      /Lead with the reason behind the question before asking it/,
      /Good to know about that customer relationship/,
      /Got it — I had that wrong\. So the actual structure is/,
      /Buyers always want to see the lease terms because/,
      /I can tell the transition plan is something you've thought a lot about/,
      /pick this up later\? Everything is saved/,
      /pick up where we left off\? Everything we've captured/,
    ]) assert.doesNotMatch(all, bad, String(bad));
    // The style rules are keyed to what the profiler emits.
    const ei = read("emotional-intelligence.md");
    const profiler = fs.readFileSync(path.join(REPO, "server/interview/eq-profiler.ts"), "utf8");
    const styles = profiler.match(/communicationStyle: ("[a-z]+"(?: \| "[a-z]+")*);/)![1].match(/[a-z]+/g)!;
    assert.deepEqual(styles, ["direct", "conversational", "formal", "guarded", "enthusiastic"]);
    for (const s of styles) assert.match(ei, new RegExp(`### communicationStyle: ${s}\\n`), s);
    for (const gone of ["storyteller", "analytical", "reserved"]) assert.doesNotMatch(ei, new RegExp(`### communicationStyle: ${gone}`), gone);
    // Rationale lives in whyItMatters.
    assert.match(read("conversation-rules.md"), /The "why" lives in whyItMatters/);
    ok("F2-INT-6: no prompt tells the model to recap, grade, or put buyer rationale in the message; style rules match the profiler's styles");
  }

  // ── F2-INT-7: no "classic add-back" carve-out ──
  {
    const carveOut = "A market-rate owner salary on the P&L is the classic add-back — anything beyond that, your broker will confirm against your statements. How many staff report to you directly?";
    assert.equal(normalisationCallIn(carveOut, "My salary gets added back, right?").length, 1, "the carve-out is a treatment call");
    const boundaries = fs.readFileSync(path.join(REPO, "server/interview/prompts/boundaries.md"), "utf8");
    assert.doesNotMatch(boundaries, /classic addback|classic add-back/i);
    assert.match(boundaries, /your salary included/);
    // The hand-off itself is fine.
    assert.deepEqual(normalisationCallIn("Your broker will walk you through the earnings figure and what gets added back — your salary included — against your actual statements. How many staff report to you directly?", "My salary gets added back, right?"), []);
    ok("F2-INT-7: 'a market-rate owner salary is the classic add-back' is a call the guard rewrites; salary is handed off like every item");
  }

  // ── F2-INT-8: the outage opening ──
  {
    for (const returning of [false, true]) {
      const m = degradedOpeningMessage(returning);
      assert.doesNotMatch(m, /!|\bCIM\b|\?/);
      assert.match(m, returning ? /^Welcome back\./ : /^Welcome, and thanks/);
    }
    const src = fs.readFileSync(path.join(REPO, "server/interview/session-manager.ts"), "utf8");
    assert.doesNotMatch(src, /Hi! I'm here to learn about/);
    assert.match(src, /openingResult\.degraded\s*\?\s*\{ _openingDegraded: true \}/);
    assert.match(src, /const degradedOpening = userMessageCount === 0 && \(session\.extractedInfo as Record<string, unknown> \| null\)\?\._openingDegraded === true;/);
    ok("F2-INT-8: an outage opening is an honest notice (no '!', no 'CIM', welcome-back for a returning seller), stored without a reuse basis and rewritten next start");
  }

  // ── F2-INT-9: by-year figures are the seller's own ──
  {
    const view = { businessName: "Lakeshore", revenueByYear: { "2023": 3180000, "2024": 3420000 }, ebitdaByYear: { "2024": "$612,000" }, _fieldSources: { revenue: { note: "$9,999,999" } } };
    const text = sanctionedFigureText("What's it worth?", view);
    const nums = typedNumericValues(text).map((t) => t.value);
    assert.ok(nums.some((v) => Math.abs(v - 3420000) / 3420000 <= 0.01), "revenueByYear is sanctioned");
    assert.ok(nums.some((v) => Math.abs(v - 612000) / 612000 <= 0.01), "ebitdaByYear is sanctioned");
    assert.ok(!nums.some((v) => v === 9999999), "_ keys never count");
    const reply = "What a buyer pays turns on the numbers — the $3.42M you did in 2024 is the base. What share of that is recurring maintenance?";
    const unsanctioned = typedNumericValues(reply).filter((t) => t.kind === "currency" && t.value >= 10_000).some((t) => !nums.some((s) => Math.abs(t.value - s) / Math.max(t.value, Math.abs(s)) <= 0.01));
    assert.equal(unsanctioned, false, "quoting the seller's own revenue is not a leak");
    // The last-resort deflection ends with a real question and grades nothing.
    const d = valuationDeflection(["It could fetch $2M to $3M. What share of revenue is recurring maintenance?"], "What would you like a buyer to understand next about the business?");
    assert.match(d, /What share of revenue is recurring maintenance\?$/);
    assert.doesNotMatch(d, /exactly the right question|works in your favour/);
    assert.equal(containsValuationFigures(d), false);
    const d2 = valuationDeflection(["You'd likely get 3x SDE. Would $2.5M feel right?"], "Who runs the service side day to day?");
    assert.match(d2, /Who runs the service side day to day\?$/, "a question with a figure is not reused");
    ok("F2-INT-9: facts in by-year maps are sanctioned on 'what's it worth' turns; the last-resort deflection ends with a clean question");
  }

  // ── F2-INT-10: the fallback question never names the agent's plan ──
  {
    const cases: Array<[string, string, RegExp]> = [
      ["Probe the mandatory probes item on CARB compliance for California lanes", "", /^Could you walk me through CARB compliance for California lanes\?$/],
      ["Cover the deferred lease topic from the ledger before wrap-up", "", /^Could you walk me through the lease\?$/],
      ["Ask about the coverage gap in the employees section", "", /employees\?$/],
      ["Ask about key customer concentration", "", /^Could you walk me through key customer concentration\?$/],
      ["Confirm the checklist items before wrap-up", "industry_specific:carb_compliance", /carb compliance\?$/],
      ["What's the next deferred topic on the agenda?", "", /^What would you like a buyer to understand next about the business\?$/],
    ];
    for (const [intent, topic, want] of cases) {
      const q = fallbackQuestion(intent, topic);
      assert.match(q, want, `${intent} → ${q}`);
      assert.equal(leaksInternalMachinery(q), false, q);
      assert.doesNotMatch(q, /\b(?:probe|ledger|wrap-?up|deferr|coverage|checklist|section|topic)\b/i, q);
    }
    const src = fs.readFileSync(path.join(REPO, "server/interview/session-manager.ts"), "utf8");
    assert.match(src, /appended the planned question[\s\S]{0,400}if \(leaksInternalMachinery\(aiResponse\.message\)\) aiResponse\.message = scrubInternalMachinery\(aiResponse\.message\);/);
    ok("F2-INT-10: the mechanical fallback question drops the agent's planning words (probes, ledger, wrap-up, sections) and is checked again after it is appended");
  }

  // ── F2-FINAL-1 / F2-FINAL-2: pattern precision on breaks; the reply to taking an offered break ──
  {
    const Q = "What share of revenue does your largest customer account for?";
    const noPrior = { stopNow: false, stopSignalCount: 0, stopLevel: "none" as const, closingAnswerTurn: false };
    // The finding's probe: quickIntent + combineIntent(q, null) + resolveStopState — none is a break.
    for (const m of [
      "Hold on, I'm not comfortable sharing that.",
      "One moment — that's confidential, I'd rather not say.",
      "Wait a second, you asked me that already",
      "Just a moment, my wife handles that side.",
      "Let me check.",
      "Let me get that for you.",
    ]) {
      const q = combineIntent(quickIntent(m, Q), null);
      assert.equal(q.pause, false, m);
      assert.equal(resolveStopState(noPrior, 0, q).paused, false, m);
    }
    // A privacy request, correction or withdrawal behind a pause word is never a break.
    for (const m of ["Hold on, keep that out of the book.", "Wait a sec — scratch that, it's 12 years not 10.", "Hang on, scratch that."]) {
      assert.equal(quickIntent(m, Q).pause, false, m);
    }
    // Still breaks: a pause word with a fetch after it, and fetching a named thing.
    for (const m of ["Hold on, let me check.", "Hold on, let me look that up.", "Let me get the lease.", "Let me grab that file.", "Hang on, let me grab the lease. It's in the office.", "One sec, a customer just walked in."]) {
      assert.equal(quickIntent(m, Q).pause, true, m);
    }
    // After the interviewer's own offer: no "question above", no chips.
    assert.deepEqual(pauseReplyFor(PAUSE_OFFER), { message: PAUSE_REPLY_AFTER_OFFER, keepChips: false });
    assert.deepEqual(pauseReplyFor(Q), { message: PAUSE_REPLY, keepChips: true });
    assert.doesNotMatch(PAUSE_REPLY_AFTER_OFFER, /question above/);
    assert.equal(asksQuestion(PAUSE_REPLY_AFTER_OFFER), false);
    // Right after "take your time", an "ok" / "sure" is the seller back — never a second acceptance.
    for (const m of ["ok", "Sure", "Yes please"]) {
      assert.equal(quickIntent(m, PAUSE_OFFER).pause, true, m);
      assert.equal(quickIntent(m, PAUSE_OFFER, { afterPause: true }).pause, false, m);
    }
    // The first prompt never carries a break instruction (a misread costs no second call).
    const src = fs.readFileSync(path.join(REPO, "server/interview/session-manager.ts"), "utf8");
    assert.doesNotMatch(src, /SHORT BREAK\\n|buildPauseNudge/);
    ok("F2-FINAL-1/2: refusals, re-ask complaints, hand-offs, privacy requests and bare 'let me check' are not breaks; taking an offered break gets a reply with no 'question above' and no chips");
  }

  console.log(`\n${n} groups passed`);
})().catch((e) => { console.error(e); process.exit(1); });
