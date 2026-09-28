// FREE round, stream "interview" (review F1, F2, F3, F8, F10, F11): who a
// session belongs to, and when a turn may be written into it. Whole turns
// and starts run through the offline harness (scripted model, in-memory
// sessions) — no model calls.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/f-session-mode.test.ts
import assert from "node:assert/strict";
import { installHarness, baseDeal, ai, seller, type Harness } from "./turn-harness";
import {
  processTurn,
  startOrResumeSession,
  getSessionHistory,
  endSessionManually,
  turnPrecheck,
  routedDiscrepancyDiscussed,
  routedDiscrepancyNote,
  sessionSourceKind,
} from "../../server/interview/session-manager";
import {
  callerMode,
  contextSessions,
  sessionModeOf,
  turnAdmission,
  withSessionTurnLock,
  TurnConflictError,
  parseAnsweringAt,
} from "../../server/interview/session-mode";
import { intentPrompt, LABELLED_EXCHANGE_NOTE } from "../../server/interview/seller-intent";
import { evidenceSources } from "../../server/interview/on-file-evidence";
import { storage } from "../../server/storage";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };
const has = (h: Harness, re: RegExp) => h.logs.some((l) => re.test(l));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** A broker-led session left open by a together page that was closed without "End". */
function togetherSession(extra: Record<string, unknown> = {}) {
  return {
    id: "sess-room",
    dealId: "deal-1",
    participantId: null,
    status: "active",
    messages: [
      ai("How many licensed technicians are on the team?", { timestamp: minutesAgo(90).toISOString() }),
      { role: "user", content: "Broker: So how many of the guys hold the 313A?\nSeller: Six of the 22 are licensed.", timestamp: minutesAgo(89).toISOString() },
      ai("Who holds the gas licence for the company itself?", { timestamp: minutesAgo(88).toISOString() }),
    ],
    extractedInfo: { _conductedBy: "broker_with_seller", _conductedVia: "person", _deferralLedger: [], _confidenceLevels: {} },
    questionsAsked: 2,
    questionsAnswered: 1,
    questionsSkipped: 0,
    startedAt: minutesAgo(91),
    lastActivityAt: minutesAgo(88),
    completedAt: null,
    ...extra,
  };
}

(async () => {
  // ── 0. Pure rules ──
  {
    assert.equal(callerMode(true, "broker_with_seller"), "seller", "a seller token is always the seller");
    assert.equal(callerMode(true, undefined), "seller");
    assert.equal(callerMode(false, "broker_with_seller"), "broker_with_seller");
    assert.equal(callerMode(false, undefined), "broker", "the broker's own 'Start AI Interview' is the broker alone");
    assert.equal(callerMode(false, "seller"), "broker", "a broker can't claim to be the seller");
    assert.equal(sessionModeOf({ extractedInfo: {} }), "seller", "legacy sessions were the seller's");
    assert.equal(sessionModeOf({ extractedInfo: { _conductedBy: "broker" } }), "broker");
    assert.equal(sessionSourceKind("broker", undefined), "broker");
    assert.equal(sessionSourceKind("seller", undefined), "interview");
    assert.equal(sessionSourceKind("broker_with_seller", "zoom"), "video_call");
    const mixed = [
      { id: "a", extractedInfo: { _conductedBy: "seller" } },
      { id: "b", extractedInfo: { _conductedBy: "broker" } },
      { id: "c", extractedInfo: { _conductedBy: "broker_with_seller" } },
    ];
    assert.deepEqual(contextSessions(mixed).map((s) => s.id), ["a", "c"]);
    assert.deepEqual(contextSessions(mixed, "b").map((s) => s.id), ["a", "b", "c"], "a broker session's own transcript stays in play");
    const base = { dealId: "d", status: "active", messages: [ai("Q1?", { timestamp: "2026-09-26T10:00:00.000Z" })], extractedInfo: {} };
    assert.equal(turnAdmission({ session: base, dealId: "d", mode: "seller" }), null);
    assert.equal(turnAdmission({ session: base, dealId: "other", mode: "seller" }), "wrong_session");
    assert.equal(turnAdmission({ session: { ...base, status: "completed" }, dealId: "d", mode: "seller" }), "session_closed");
    assert.equal(turnAdmission({ session: base, dealId: "d", mode: "broker_with_seller" }), "mode_mismatch");
    assert.equal(turnAdmission({ session: base, dealId: "d", mode: "seller", answeringAt: "2026-09-26T10:00:00.000Z" }), null);
    assert.equal(turnAdmission({ session: base, dealId: "d", mode: "seller", answeringAt: "2026-09-26T09:00:00.000Z" }), "out_of_sync");
    assert.equal(parseAnsweringAt("2026-09-26T10:00:00.000Z"), "2026-09-26T10:00:00.000Z");
    assert.equal(parseAnsweringAt("yesterday-ish"), undefined);
    assert.equal(parseAnsweringAt(42), undefined);
    ok("caller mode, session mode, context sessions and turn admission rules");
  }

  // ── 1. F1: the seller comes back after an unfinished "Interview together" ──
  {
    const h = installHarness(baseDeal());
    h.sessions.push(togetherSession());
    const opening = "Picking up from where you and your broker left off: who holds the gas licence for the company itself?";
    h.script.push({ message: opening });
    const start = await startOrResumeSession("deal-1", { conductedBy: "seller" });
    assert.notEqual(start.sessionId, "sess-room", "a fresh seller session, not the broker-led one");
    const room = h.sessions.find((s) => s.id === "sess-room")!;
    assert.equal(room.status, "completed", "the broker-led session is closed");
    assert.equal(room.extractedInfo._closedFor, "seller");
    const mine = h.sessions.find((s) => s.id === start.sessionId)!;
    assert.equal(mine.extractedInfo._conductedBy, "seller");
    assert.doesNotMatch(h.systems[h.systems.length - 1], /SESSION MODE: BROKER-LED/, "the opening is written for the seller, not read aloud");
    assert.ok(has(h, /Closed broker_with_seller session sess-room/));

    // The seller's earnings question in their own session: no "the broker is in the room".
    h.script.push({ message: "Who holds the company's gas contractor licence?" });
    await processTurn("deal-1", start.sessionId, "So what will my SDE be?", undefined, { conductedBy: "seller" });
    const sys = h.systems[h.systems.length - 1];
    assert.doesNotMatch(sys, /SESSION MODE: BROKER-LED/);
    assert.doesNotMatch(sys, /The broker is in the room/);
    assert.match(sys, /THE SELLER RAISED EARNINGS/);
    assert.match(sys, /is their broker's to walk them through/);

    // A stale seller tab posting into the old room session is refused, not appended.
    const before = (room.messages as unknown[]).length;
    await assert.rejects(
      () => processTurn("deal-1", "sess-room", "Eight of us hold it", undefined, { conductedBy: "seller" }),
      (e: unknown) => e instanceof TurnConflictError && e.code === "session_closed",
    );
    assert.equal((room.messages as unknown[]).length, before);

    // The seller never reads the room transcript.
    assert.equal(await getSessionHistory("sess-room", { forSeller: true }), null);
    assert.ok(await getSessionHistory("sess-room", { forSeller: false }), "the broker still can");
    ok("F1: a seller returning after 'Interview together' gets a fresh seller session; the room session is closed and unreadable to them");
  }

  // ── 1b. A seller posting into an OPEN broker-led session is refused (mode mismatch) ──
  {
    const h = installHarness(baseDeal());
    h.sessions.push(togetherSession());
    await assert.rejects(
      () => processTurn("deal-1", "sess-room", "Six of us", undefined, { conductedBy: "seller" }),
      (e: unknown) => e instanceof TurnConflictError && e.code === "mode_mismatch",
    );
    const pre = await turnPrecheck("sess-room", { dealId: "deal-1", mode: "seller" });
    assert.equal(pre?.code, "mode_mismatch");
    await assert.rejects(
      () => endSessionManually("deal-1", "sess-room", { mode: "seller" }),
      (e: unknown) => e instanceof TurnConflictError && e.code === "mode_mismatch",
    );
    assert.equal(h.sessions[0].status, "active", "a seller can't end the broker-led session");
    ok("F1: a seller token can't write into, or end, a broker-led session");
  }

  // ── 2. F2: the broker's own "Start AI Interview" is a separate broker session ──
  {
    const sellerSession = {
      id: "sess-seller",
      dealId: "deal-1",
      participantId: null,
      status: "active",
      messages: [
        ai("How long have you owned the business?", { timestamp: minutesAgo(60).toISOString() }),
        seller("Since 2009."),
        ai("How many trucks are on the road?", { timestamp: minutesAgo(58).toISOString() }),
      ],
      extractedInfo: { _conductedBy: "seller", _deferralLedger: [], _confidenceLevels: {} },
      questionsAsked: 2, questionsAnswered: 1, questionsSkipped: 0,
      startedAt: minutesAgo(61), lastActivityAt: minutesAgo(58), completedAt: null,
    };
    const h = installHarness(baseDeal());
    h.sessions.push(sellerSession);

    // The broker opens their own session: the seller's stays untouched.
    h.script.push({ message: "What's the seller's reason for selling, as you understand it?" });
    const b = await startOrResumeSession("deal-1", { conductedBy: "broker" });
    assert.notEqual(b.sessionId, "sess-seller");
    assert.equal(h.sessions.find((s) => s.id === "sess-seller")!.status, "active", "the seller's session is not closed");
    const brokerRow = h.sessions.find((s) => s.id === b.sessionId)!;
    assert.equal(brokerRow.extractedInfo._conductedBy, "broker");
    assert.match(h.systems[h.systems.length - 1], /SESSION MODE: THE BROKER ALONE/);

    // The broker answers from their notes: recorded as the broker's word.
    h.script.push({
      message: "Does the seller have a price in mind?",
      extractedFields: { reasonForSale: { value: "Retiring after 30 years", confidence: "confirmed" } },
    });
    await processTurn("deal-1", b.sessionId, "He's retiring after 30 years in the business.", undefined, { conductedBy: "broker" });
    const src = h.deal.extractedInfo._fieldSources?.reasonForSale;
    assert.equal(src?.source, "broker", "a broker-typed answer is the broker's, never the seller's (interview)");
    assert.equal(src?.sessionId, b.sessionId);
    assert.match(String(src?.note ?? ""), /your AI interview session/);
    // Something private the broker types stays in their session and notes.
    h.script.push({ message: "Is there a price he'd be happy with?" });
    await processTurn("deal-1", b.sessionId, "His wife is ill, keep that quiet. He'd take $1.5M.", undefined, { conductedBy: "broker" });

    // The seller's next visit resumes THEIR session — never the broker's.
    const back = await startOrResumeSession("deal-1", { conductedBy: "seller" });
    assert.equal(back.sessionId, "sess-seller");
    assert.equal(await getSessionHistory(b.sessionId, { forSeller: true }), null, "the seller can't read the broker's session");

    // …and the seller's turn never sees the broker's typed words.
    h.script.push({ message: "Are all of them owned outright?" });
    await processTurn("deal-1", "sess-seller", "Nine trucks.", undefined, { conductedBy: "seller" });
    const sellerPrompt = h.systems[h.systems.length - 1];
    assert.doesNotMatch(sellerPrompt, /wife is ill/, "broker-typed words never reach the seller's prompt");
    assert.doesNotMatch(sellerPrompt, /SESSION MODE: THE BROKER ALONE/);

    // A broker (no seller token) posting into the seller's session is refused.
    await assert.rejects(
      () => processTurn("deal-1", "sess-seller", "He has nine", undefined, { conductedBy: "broker" }),
      (e: unknown) => e instanceof TurnConflictError && e.code === "mode_mismatch",
    );

    // The evidence build (read by the seller's interview) never reads a broker session.
    const blocks = evidenceSources([], h.sessions as any, null);
    assert.equal(blocks.some((b2) => b2.sessionId === b.sessionId), false);
    assert.equal(blocks.some((b2) => b2.sessionId === "sess-seller"), true);
    ok("F2: broker mode is its own session; its facts are the broker's; the seller never resumes, reads or is prompted with it");
  }

  // ── 3. F3 / F11: one turn per session; a turn must answer the latest question ──
  {
    const q1 = ai("How many staff do you have?", { timestamp: "2026-09-26T10:00:00.000Z" });
    const h = installHarness(baseDeal(), { messages: [q1], sessionMeta: { _conductedBy: "seller" } });
    h.script.push({ message: "How many of them are full time?" });
    h.script.push({ message: "(never used)" });
    // The seller answers, taps Cancel, and sends it again while the first is still running.
    const first = processTurn("deal-1", "sess-1", "We have 14 staff", undefined, { conductedBy: "seller", answeringAt: q1.timestamp });
    const again = processTurn("deal-1", "sess-1", "We have 14 staff", undefined, { conductedBy: "seller", answeringAt: q1.timestamp });
    const r1 = await first;
    await assert.rejects(() => again, (e: unknown) => e instanceof TurnConflictError && e.code === "out_of_sync");
    const msgs = h.sessions[0].messages as { role: string; content: string }[];
    assert.equal(msgs.length, 3, "one exchange saved, never overwritten or doubled");
    assert.deepEqual(msgs.map((m) => m.role), ["ai", "user", "ai"]);
    assert.equal(msgs[2].content, r1.message);
    assert.equal(h.script.length, 1, "the refused resend made no model call");

    // Answering the latest question is admitted.
    h.script.length = 0;
    h.script.push({ message: "Do any of them hold a trade licence?" });
    const r2 = await processTurn("deal-1", "sess-1", "Ten full time", undefined, { conductedBy: "seller", answeringAt: (msgs[2] as any).timestamp });
    assert.equal(r2.shouldEnd, false);
    assert.equal((h.sessions[0].messages as unknown[]).length, 5);

    // A completed session (e.g. ended from another tab) takes no more turns.
    h.sessions[0].status = "completed";
    await assert.rejects(
      () => processTurn("deal-1", "sess-1", "Two of them", undefined, { conductedBy: "seller" }),
      (e: unknown) => e instanceof TurnConflictError && e.code === "session_closed",
    );
    // …and a session of another deal is refused.
    h.sessions[0].status = "active";
    await assert.rejects(
      () => processTurn("deal-2", "sess-1", "Two of them", undefined, { conductedBy: "seller" }),
      (e: unknown) => e instanceof TurnConflictError && e.code === "wrong_session",
    );
    assert.equal((h.sessions[0].messages as unknown[]).length, 5);

    // The lock itself: turns on one session never overlap; other sessions don't wait.
    const order: string[] = [];
    const slow = (tag: string, ms: number) => () => new Promise<void>((r) => { order.push(`${tag}+`); setTimeout(() => { order.push(`${tag}-`); r(); }, ms); });
    await Promise.all([withSessionTurnLock("x", slow("a", 30)), withSessionTurnLock("x", slow("b", 1)), withSessionTurnLock("y", slow("c", 1))]);
    assert.deepEqual(order.filter((o) => o.startsWith("a") || o.startsWith("b")), ["a+", "a-", "b+", "b-"]);
    assert.ok(order.indexOf("c-") < order.indexOf("a-"), "another session runs alongside");
    ok("F3/F11: turns on a session are serialised; a resend of an answered question, a closed session or another deal's session is refused");
  }

  // ── 4. F8: "End Overview" hands routed discrepancies back to the broker ──
  {
    const q = ai("What was revenue in FY2024 — the P&L shows $1.82M but you mentioned $2.3M?", { timestamp: minutesAgo(5).toISOString() });
    const h = installHarness(baseDeal(), { messages: [ai("How many staff?", { timestamp: minutesAgo(9).toISOString() }), seller("14"), q], sessionMeta: { _conductedBy: "seller" } });
    const routed = [
      { id: "d1", dealId: "deal-1", field: "Revenue FY2024", factKey: "revenueByYear", interviewValue: "$2.3M", documentValue: "$1,820,000", status: "ask_seller", severity: "critical" },
      { id: "d2", dealId: "deal-1", field: "Lease renewal option", factKey: "leaseRenewal", interviewValue: "two 5-year options", documentValue: "one 5-year option", status: "ask_seller", severity: "significant" },
      { id: "d3", dealId: "deal-1", field: "Owner salary", factKey: "ownerSalary", interviewValue: "$180K", documentValue: "$260K", status: "open", severity: "significant" },
    ];
    const updates: Record<string, any> = {};
    (storage as any).getDiscrepanciesByDeal = async () => routed;
    (storage as any).updateDiscrepancy = async (id: string, patch: any) => { updates[id] = patch; return undefined; };
    await endSessionManually("deal-1", "sess-1", { mode: "seller" });
    assert.equal(h.deal.interviewCompleted, true);
    assert.equal(updates.d1?.status, "seller_responded", "a routed critical conflict now blocks generation until the broker reviews it");
    assert.match(updates.d1.sellerResponse, /^Raised with the seller in the AI interview on /);
    assert.equal(updates.d2?.status, "seller_responded");
    assert.match(updates.d2.sellerResponse, /before this was raised with the seller/, "an item never raised says so");
    assert.equal(updates.d3, undefined, "an open (not routed) discrepancy is left alone");

    // The broker ending their own session: the seller wasn't asked.
    const h2 = installHarness(baseDeal(), { messages: [ai("Anything else?", { timestamp: minutesAgo(1).toISOString() })], sessionMeta: { _conductedBy: "broker" } });
    const updates2: Record<string, any> = {};
    (storage as any).getDiscrepanciesByDeal = async () => routed;
    (storage as any).updateDiscrepancy = async (id: string, patch: any) => { updates2[id] = patch; return undefined; };
    await endSessionManually("deal-1", "sess-1", { mode: "broker" });
    assert.deepEqual(updates2, {}, "nothing handed back from the broker's own session");
    void h2;

    assert.equal(routedDiscrepancyDiscussed({ field: "Revenue FY2024", factKey: "revenueByYear", interviewValue: "$2,300,000", documentValue: "$1.82M" }, [ai("Revenue was $2300000?")]), true);
    assert.equal(routedDiscrepancyDiscussed({ field: "Customer concentration", factKey: "customerConcentration", interviewValue: "18%", documentValue: "35%" }, [ai("How concentrated are your customers?")]), true);
    assert.equal(routedDiscrepancyDiscussed({ field: "Warranty reserve", factKey: null, interviewValue: "none", documentValue: "$12,000" }, [ai("How many trucks in 2024?")]), false);
    assert.match(routedDiscrepancyNote(false, "Sept 26, 2026"), /ended on Sept 26, 2026 before this was raised/);
    ok("F8: ending with 'End Overview' hands routed discrepancies back (worded by whether they were raised); not from the broker's own session");
  }

  // ── 5. F10: broker-led — the broker's own words are never the seller's intent ──
  {
    const room = togetherSession();
    const h = installHarness(baseDeal());
    h.sessions.push(room);
    h.intents.push({ stop: "none" });
    h.script.push({ message: "How many of the 22 are field technicians?" });
    const exchange = "Broker: I've got to run to another meeting at four, so let's keep this tight.\nSeller: Sure. We have 22 staff, 6 licensed techs.";
    const r = await processTurn("deal-1", "sess-room", exchange, undefined, { conductedBy: "broker_with_seller", conductedVia: "person" });
    assert.equal(has(h, /Seller stop signal/), false, "the broker's meeting is not the seller's stop");
    assert.equal(r.shouldEnd, false);
    assert.equal(room.extractedInfo._stopSignalCount, 0);

    h.intents.push({ stop: "none" });
    h.script.push({ message: "What year did your father start it?" });
    await processTurn(
      "deal-1",
      "sess-room",
      "Broker: Let's take a break from numbers for a sec. How did you get into the business?\nSeller: My dad started it in 1988.",
      undefined,
      { conductedBy: "broker_with_seller" },
    );
    assert.doesNotMatch(h.systems[h.systems.length - 1], /The seller asked you/, "a question the broker asked is not the seller's");

    // The classifier is told which lines are the broker's.
    const prompt = intentPrompt({ sellerMessage: exchange, recentFacts: [], labelledExchange: true });
    assert.ok(prompt.startsWith(LABELLED_EXCHANGE_NOTE));
    assert.match(LABELLED_EXCHANGE_NOTE, /NOT the seller asking to stop/);
    assert.doesNotMatch(intentPrompt({ sellerMessage: "Sure.", recentFacts: [] }), /BROKER-LED SESSION/);
    ok("F10: in broker-led sessions stop patterns, the seller's question and the classifier read the seller's lines");
  }

  process.stdout.write(`\n${n} groups passed\n`);
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
