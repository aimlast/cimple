// FREE round 2, stream "interview": whole turns and starts through the
// offline harness (scripted model, in-memory sessions) — the broker's own
// AI-session notes against the seller's answers, the seller opening their
// page while "Interview together" is live, the broker's own session ending,
// and its to-dos. No model calls.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/f-interview-r2-sessions.test.ts
import assert from "node:assert/strict";
import { installHarness, baseDeal, ai, seller } from "./turn-harness";
import { processTurn, startOrResumeSession, endSessionManually } from "../../server/interview/session-manager";
import { TurnConflictError, sessionFinishedInterview, BROKER_SESSION_TASK_CREATOR } from "../../server/interview/session-mode";
import { BROKER_SESSION_SOURCE_NOTE } from "../../server/interview/info-merger";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

function sellerSession(extra: Record<string, unknown> = {}) {
  return {
    id: "sess-seller",
    dealId: "deal-1",
    participantId: null,
    status: "active",
    messages: [ai("What was total revenue last fiscal year?", { timestamp: minutesAgo(30).toISOString() })],
    extractedInfo: { _conductedBy: "seller", _deferralLedger: [], _confidenceLevels: {} },
    questionsAsked: 1,
    questionsAnswered: 0,
    questionsSkipped: 0,
    startedAt: minutesAgo(31),
    lastActivityAt: minutesAgo(30),
    completedAt: null,
    ...extra,
  };
}

function roomSession(minutesQuiet: number, extra: Record<string, unknown> = {}) {
  return {
    id: "sess-room",
    dealId: "deal-1",
    participantId: null,
    status: "active",
    messages: [
      ai("How many techs?", { timestamp: minutesAgo(minutesQuiet + 2).toISOString() }),
      { role: "user", content: "Broker: techs?\nSeller: Six.", timestamp: minutesAgo(minutesQuiet + 1).toISOString() },
      ai("Who holds the gas licence?", { timestamp: minutesAgo(minutesQuiet).toISOString() }),
    ],
    extractedInfo: { _conductedBy: "broker_with_seller", _conductedVia: "cimple" },
    startedAt: minutesAgo(minutesQuiet + 10),
    lastActivityAt: minutesAgo(minutesQuiet),
    completedAt: null,
    ...extra,
  };
}

(async () => {
  // ── The broker's own session's approximate figure vs the seller's own answer ──
  {
    const h = installHarness(baseDeal());
    h.sessions.push(sellerSession());
    h.script.push({ message: "Roughly what does the business bring in a year, from your notes?" });
    const b = await startOrResumeSession("deal-1", { conductedBy: "broker" });
    h.script.push({
      message: "Do you know how many trucks they run?",
      extractedFields: { annualRevenue: { value: "$2,000,000", confidence: "approximate", basis: "verbatim" } },
    });
    await processTurn("deal-1", b.sessionId, "From memory, around $2,000,000 a year.", undefined, { conductedBy: "broker" });
    assert.equal(h.deal.extractedInfo.annualRevenue, "$2,000,000");
    assert.equal(h.deal.extractedInfo._fieldSources.annualRevenue.source, "broker");
    assert.equal(h.deal.extractedInfo._fieldSources.annualRevenue.note, BROKER_SESSION_SOURCE_NOTE);

    h.script.push({
      message: "How many trucks are on the road?",
      extractedFields: { annualRevenue: { value: "$2,340,000", confidence: "confirmed", basis: "verbatim" } },
    });
    await processTurn("deal-1", "sess-seller", "Revenue last fiscal year was $2,340,000 — it's in the year-end statements.", undefined, { conductedBy: "seller" });
    assert.equal(h.deal.extractedInfo.annualRevenue, "$2,340,000", "the seller's own answer replaces the broker's notes");
    assert.equal(h.deal.extractedInfo._fieldSources.annualRevenue.source, "interview");
    const alts = h.deal.extractedInfo._fieldAlternates?.annualRevenue ?? [];
    assert.ok(alts.some((a: any) => a.value === "$2,000,000" && a.note === BROKER_SESSION_SOURCE_NOTE), "the broker's figure is kept as another value");

    // The broker's session, again: it never writes over the seller's own answer.
    h.script.push({
      message: "And the truck count?",
      extractedFields: { annualRevenue: { value: "$2,100,000", confidence: "approximate", basis: "verbatim" } },
    });
    await processTurn("deal-1", b.sessionId, "I had it closer to $2.1M.", undefined, { conductedBy: "broker" });
    assert.equal(h.deal.extractedInfo.annualRevenue, "$2,340,000");
    assert.equal(h.deal.extractedInfo._fieldSources.annualRevenue.source, "interview");
    assert.ok((h.deal.extractedInfo._fieldAlternates?.annualRevenue ?? []).some((a: any) => a.value === "$2,100,000"));
    ok("broker AI-session notes: the seller's answer wins (the broker's kept as another value); the broker's session never overwrites the seller");
  }

  // ── A broker edit is still final; the broker's session updates its own notes ──
  {
    const h = installHarness(
      baseDeal({
        extractedInfo: {
          reasonForSale: "Retirement",
          employees: "22",
          _fieldSources: {
            reasonForSale: { source: "broker", at: "2026-09-20T10:00:00Z" },
            employees: { source: "broker", at: "2026-09-20T10:00:00Z", sessionId: "old-b", turn: 1, note: BROKER_SESSION_SOURCE_NOTE },
          },
        },
      }),
    );
    h.sessions.push(sellerSession({ messages: [ai("Why are you selling?", { timestamp: minutesAgo(5).toISOString() })] }));
    h.script.push({
      message: "Who are your three largest suppliers?",
      extractedFields: { reasonForSale: { value: "Health reasons", confidence: "confirmed", basis: "verbatim" } },
    });
    await processTurn("deal-1", "sess-seller", "Honestly, health reasons.", undefined, { conductedBy: "seller" });
    assert.equal(h.deal.extractedInfo.reasonForSale, "Retirement", "a broker edit is final");
    assert.ok((h.deal.extractedInfo._fieldAlternates?.reasonForSale ?? []).some((a: any) => a.value === "Health reasons"));

    h.script.push({ message: "Who are the key customers, from your notes?" }, { message: "Picking up from the seller's answers — who are the key customers, from your notes?" });
    const b = await startOrResumeSession("deal-1", { conductedBy: "broker" });
    h.script.push({
      message: "Do you know when the lease renews?",
      extractedFields: { employeeCount: { value: "24", confidence: "confirmed", basis: "verbatim" } },
    });
    await processTurn("deal-1", b.sessionId, "They're at 24 people now.", undefined, { conductedBy: "broker" });
    assert.equal(h.deal.extractedInfo.employees, "24", "the broker's session updates its own earlier notes");
    ok("broker edits stay final against the seller; the broker's session updates its own earlier notes");
  }

  // ── A closed session is not a finished interview ──
  {
    const h = installHarness(baseDeal());
    h.sessions.push(
      sellerSession({
        messages: [
          ai("How long have you owned the business?", { timestamp: minutesAgo(60).toISOString() }),
          seller("Since 2009."),
          ai("How many trucks are on the road?", { timestamp: minutesAgo(58).toISOString() }),
        ],
        lastActivityAt: minutesAgo(58),
      }),
    );
    h.script.push({ message: "Let's pick up with the fleet: how many trucks are on the road?" });
    await startOrResumeSession("deal-1", { conductedBy: "broker_with_seller", conductedVia: "person", resume: true });
    const closed = h.sessions.find((s) => s.id === "sess-seller");
    assert.equal(closed.status, "completed");
    assert.equal(closed.extractedInfo._closedFor, "broker_with_seller");
    assert.equal(sessionFinishedInterview(closed), false, "the seller's progress doesn't show the interview complete");
    assert.equal(h.deal.interviewCompleted, false);
    ok("the seller's session closed by 'Interview together' is not a finished interview");
  }

  // ── The seller opening their page while "Interview together" is live ──
  {
    const h = installHarness(baseDeal({ interviewCompleted: true }));
    h.sessions.push({
      id: "sess-first", dealId: "deal-1", participantId: null, status: "completed",
      messages: [ai("Q?", { timestamp: minutesAgo(3000).toISOString() }), seller("A."), ai("Thanks — that's all.", { timestamp: minutesAgo(2999).toISOString() })],
      extractedInfo: { _conductedBy: "seller" }, startedAt: minutesAgo(3001), lastActivityAt: minutesAgo(2999), completedAt: minutesAgo(2999),
    });
    h.sessions.push(roomSession(1));
    const callsBefore = h.calls.length;
    const r = await startOrResumeSession("deal-1", { conductedBy: "seller" });
    assert.equal(r.status, "together_live");
    assert.equal(r.sessionId, "", "no session handed to the seller");
    assert.equal(h.calls.length, callsBefore, "no model call for the seller's page load");
    const room = h.sessions.find((s) => s.id === "sess-room");
    assert.equal(room.status, "active", "the live sitting is left running");
    assert.equal(room.extractedInfo._closedFor, undefined);
    // …with "Continue" (resume) too.
    const r2 = await startOrResumeSession("deal-1", { conductedBy: "seller", resume: true });
    assert.equal(r2.status, "together_live");
    assert.equal(h.sessions.length, 2, "nothing was created");
    // The broker's next exchange is admitted.
    h.script.push({ message: "Is the licence in your name or the company's?" });
    await processTurn("deal-1", "sess-room", "Broker: who holds it?\nSeller: I do.", undefined, {
      conductedBy: "broker_with_seller",
      answeringAt: room.messages[2].timestamp,
    });
    assert.equal(room.status, "active");
    ok("the seller opening their page while the broker is live with them closes nothing and starts nothing");
  }
  {
    // Not live any more (quiet for over half an hour): closed as before, and the seller gets their own session.
    const h = installHarness(baseDeal());
    h.sessions.push(roomSession(45));
    h.script.push({ message: "Picking up where we left off — who holds the gas licence?" });
    const r = await startOrResumeSession("deal-1", { conductedBy: "seller" });
    assert.notEqual(r.status, "together_live");
    const room = h.sessions.find((s) => s.id === "sess-room");
    assert.equal(room.status, "completed");
    assert.equal(room.extractedInfo._closedFor, "seller");
    assert.ok(r.sessionId && r.sessionId !== "sess-room");
    ok("a sitting gone quiet for over 30 minutes is closed and the seller starts their own session");
  }
  {
    // A broker who is live must still be able to take over from a seller mid-interview.
    const h = installHarness(baseDeal());
    h.sessions.push(sellerSession({
      messages: [ai("Q1?", { timestamp: minutesAgo(3).toISOString() }), seller("A1."), ai("Q2?", { timestamp: minutesAgo(1).toISOString() })],
      lastActivityAt: minutesAgo(1),
    }));
    h.script.push({ message: "Let's go through it together — Q2?" });
    const t = await startOrResumeSession("deal-1", { conductedBy: "broker_with_seller", conductedVia: "cimple", resume: true });
    assert.ok(t.sessionId && t.sessionId !== "sess-seller");
    // The seller's tab then refuses its next send, and the reload shows the live-call card.
    let refused = "";
    try {
      await processTurn("deal-1", "sess-seller", "A2.", undefined, { conductedBy: "seller" });
    } catch (e) {
      refused = e instanceof TurnConflictError ? e.code : String(e);
    }
    assert.equal(refused, "session_closed");
    const again = await startOrResumeSession("deal-1", { conductedBy: "seller" });
    assert.equal(again.status, "together_live");
    ok("'Interview together' still takes over from a seller mid-interview; the seller's page then says the broker is live");
  }

  // ── The broker's own session ending is not the interview ending ──
  {
    const h = installHarness(baseDeal({ phase: "phase1_info_collection" }));
    h.script.push({ message: "What's the reason for sale, as you understand it?" });
    const b = await startOrResumeSession("deal-1", { conductedBy: "broker" });
    h.intents.push({ stop: "firm" });
    h.script.push({ message: "Understood — that's everything for now.", shouldEnd: true, endReason: "broker done" });
    const r = await processTurn("deal-1", b.sessionId, "That's all I know for now, I have to go.", undefined, { conductedBy: "broker" });
    assert.equal(r.shouldEnd, true);
    assert.equal(h.deal.interviewCompleted, false);
    assert.equal(h.deal.phase, "phase1_info_collection");
    assert.equal(h.sessions.find((s) => s.id === b.sessionId).status, "completed", "the broker's session itself ends");
    assert.ok(!h.logs.some((l) => /Learning loop/.test(l)));
  }
  {
    const h = installHarness(baseDeal({ phase: "phase1_info_collection" }));
    h.script.push({ message: "What's the reason for sale, as you understand it?" });
    const b = await startOrResumeSession("deal-1", { conductedBy: "broker" });
    await endSessionManually("deal-1", b.sessionId, { mode: "broker" });
    assert.equal(h.deal.interviewCompleted, false);
    assert.equal(h.deal.phase, "phase1_info_collection");
    assert.equal(h.sessions.find((s) => s.id === b.sessionId).status, "completed");
  }
  {
    // "Interview together" ending still completes the interview.
    const h = installHarness(baseDeal({ phase: "phase1_info_collection" }));
    h.sessions.push(roomSession(1));
    await endSessionManually("deal-1", "sess-room", { mode: "broker_with_seller" });
    assert.equal(h.deal.interviewCompleted, true);
    assert.equal(h.deal.phase, "phase2_platform_intake");
  }
  ok("the broker's own session ending leaves the deal, its phase and the CIM gate alone; a together sitting still completes it");

  // ── The broker's own session's to-dos ──
  {
    const h = installHarness(baseDeal({ sellerId: "seller-9" }));
    h.script.push({ message: "What's the reason for sale?" });
    const b = await startOrResumeSession("deal-1", { conductedBy: "broker" });
    h.script.push({
      message: "Anything else on the lawsuit?",
      newTasks: [{ type: "follow_up", title: "Confirm the Hargreave dispute settled", description: "Broker mentioned the 2019 Hargreave dispute with a former partner.", relatedField: "litigation", sellerExplanation: "" }],
    });
    await processTurn("deal-1", b.sessionId, "There was the Hargreave dispute with his old partner in 2019 — keep that quiet for now.", undefined, { conductedBy: "broker" });
    const task = h.tasks.find((t) => /Hargreave/.test(t.title));
    assert.ok(task, "the task is created");
    assert.equal(task.createdBy, BROKER_SESSION_TASK_CREATOR);
    assert.equal(task.assignedTo, "b1", "assigned to the broker, not the seller");

    // The seller's interview never reads it.
    h.tasks.push({ id: "task-ctl", dealId: "deal-1", createdBy: "ai_interview", assignedTo: "seller-9", type: "follow_up", title: "Find the Quillfeather supply contract", description: "Seller to look up the Quillfeather supply contract term.", relatedField: "supplierContracts", status: "pending", priority: "medium", createdAt: new Date() });
    h.sessions.push(sellerSession({ id: "sess-s2", messages: [ai("How many trucks?", { timestamp: minutesAgo(1).toISOString() })] }));
    h.script.push({ message: "And how many drivers?" });
    await processTurn("deal-1", "sess-s2", "Twelve trucks.", undefined, { conductedBy: "seller" });
    const system = h.systems[h.systems.length - 1];
    assert.ok(!/Hargreave/.test(system), "the broker's to-do is not in the seller's prompt");
    assert.ok(/Quillfeather/.test(system), "control: the seller's own interview to-do is");
    assert.ok(h.tasks.some((t) => t.id === task.id), "and the seller's turn never closes or removes it");
    ok("the broker's own session's to-dos are the broker's: never assigned to the seller or read by their interview");
  }

  process.stdout.write(`\n${n} checks passed\n`);
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
