// FREE round 2, stream "interview": the pure rules the round-1 check found
// open — who the broker is on a notetaker call (F7), a failed send of a
// repeated short answer (F4), thinking aloud on a call (F6), what counts as
// a term of the sale (deal-terms), the partial-year re-ask rule (1b) and the
// authority of the broker's own AI-session notes. No model calls.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f-interview-r2-pure.test.ts
import assert from "node:assert/strict";
import {
  afterFailedSend,
  liveExchangeText,
  brokerNameFromMe,
  botSpeakerFor,
  newBotSpeakerState,
  nameMatches,
  isThinkingAloud,
} from "../../client/src/lib/interview-sync";
import { isDealTermKey, isDealTermTopic, documentTermNotDealTerm } from "../../server/interview/deal-terms";
import { spokenFigureConflicts, clauseSpans } from "../../server/interview/source-context";
import { validateLiveClaims } from "../../server/interview/live-claims";
import { findReasks, factSubjectInQuestion } from "../../server/interview/reask-guard";
import {
  BROKER_SESSION_SOURCE_NOTE,
  fieldSourceRank,
  isBrokerFinalSource,
  isBrokerSessionSource,
  sourceAllowsOverwrite,
  SOURCE_RANK,
} from "../../server/interview/info-merger";
import { effectiveRank, outranksFor } from "../../server/documents/merge-policy";
import {
  sessionFinishedInterview,
  endingCompletesInterview,
  togetherSessionLive,
  sellerSideTasks,
  stalledSellerSessions,
  TOGETHER_LIVE_MS,
  BROKER_SESSION_TASK_CREATOR,
} from "../../server/interview/session-mode";
import { planTaskWrites } from "../../server/interview/task-writes";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };

// ── F7: the broker on a Zoom / Meet / Teams call ──
{
  assert.equal(brokerNameFromMe({ user: { name: "Morgan Ellis", username: "broker_demo" } }), "morgan ellis");
  assert.equal(brokerNameFromMe({ user: { name: "", username: "broker_demo" } }), "", "a username is no one's name in a meeting");
  assert.equal(brokerNameFromMe({ user: { name: "  ", username: "x" } }), "");
  assert.equal(brokerNameFromMe(null), "");
  ok("F7: the broker's display name only — never the login username");

  assert.equal(nameMatches("ian", "brian walsh"), false, "'Ian' is not inside 'Brian Walsh'");
  assert.equal(nameMatches("anne kowalski", "joanne smith"), false);
  assert.equal(nameMatches("brian walsh", "brian walsh"), true);
  assert.equal(nameMatches("brian", "brian walsh"), true, "the broker's first name alone");
  assert.equal(nameMatches("walsh", "brian walsh"), true);
  assert.equal(nameMatches("brian's iphone", "brian walsh"), true, "device words aside");
  assert.equal(nameMatches("brian walsh (brassline)", "brian walsh"), true, "every word of the broker's name");
  assert.equal(nameMatches("brian (brassline)", "brian walsh"), true, "a bracketed label aside");
  assert.equal(nameMatches("brian - brassline advisory", "brian walsh"), true, "a dashed label aside");
  assert.equal(nameMatches("ian (brassline)", "brian walsh"), false);
  assert.equal(nameMatches("brian smith", "brian walsh"), false, "another Brian");
  assert.equal(nameMatches("", "brian walsh"), false);
  assert.equal(nameMatches("iphone", "brian walsh"), false, "a device name is no one");
  ok("F7: whole-name matching — no substring matches");

  {
    // The founder's account has no display name: the host is the broker (as on base).
    const st = newBotSpeakerState();
    const name = brokerNameFromMe({ user: { name: "", username: "broker_demo" } });
    const s1 = botSpeakerFor(st, { participantId: 1, name: "Morgan Ellis", isHost: true }, name);
    botSpeakerFor(st, { participantId: 2, name: "Dana", isHost: false }, name);
    assert.equal(st.broker, s1);
    assert.equal(st.brokerBy, "host");
  }
  {
    // A seller named "Ian" speaks first; the broker is Brian Walsh (host).
    const st = newBotSpeakerState();
    const ian = botSpeakerFor(st, { participantId: 100, name: "Ian", isHost: false }, "brian walsh");
    assert.equal(st.broker, null, "'Ian' is not the broker");
    const brian = botSpeakerFor(st, { participantId: 200, name: "Brian Walsh", isHost: true }, "brian walsh");
    assert.notEqual(ian, brian);
    assert.equal(st.broker, brian);
    assert.equal(st.brokerBy, "name");
  }
  {
    // The seller hosts and speaks first: not taken for the broker (the broker's name is known).
    const st = newBotSpeakerState();
    const dana = botSpeakerFor(st, { participantId: 100, name: "Dana Whitfield", isHost: true }, "morgan ellis");
    assert.equal(st.broker, null);
    const morgan = botSpeakerFor(st, { participantId: 200, name: "Morgan (Brassline)", isHost: false }, "morgan ellis");
    assert.notEqual(dana, morgan);
    assert.equal(st.broker, morgan);
    assert.equal(st.brokerBy, "name");
    botSpeakerFor(st, { participantId: 100, name: "Dana Whitfield", isHost: true }, "morgan ellis");
    assert.equal(st.broker, morgan, "a later host line never takes it back");
  }
  {
    // A broker the user picked is never overruled.
    const st = newBotSpeakerState();
    botSpeakerFor(st, { participantId: 1, name: "Dana", isHost: true }, "morgan ellis");
    st.broker = 0;
    st.brokerBy = "picked";
    botSpeakerFor(st, { participantId: 2, name: "Morgan Ellis", isHost: false }, "morgan ellis");
    assert.equal(st.broker, 0);
  }
  ok("F7: a whole-name match settles the broker; with no display name the host is the broker (as before round 1); a pick stands");
}

// ── F4: a failed send of the same short answer twice ──
{
  const hist = [
    { role: "ai", content: "Do you own the building?", timestamp: "2026-09-26T10:00:00.000Z" },
    { role: "user", content: "Yes", timestamp: "2026-09-26T10:00:10.000Z" },
    { role: "ai", content: "Is the equipment owned outright too?", timestamp: "2026-09-26T10:00:30.000Z" },
  ];
  // The seller answers the NEW question "Yes"; the send fails before saving.
  assert.equal(afterFailedSend(hist, "Yes", "2026-09-26T10:00:30.000Z"), "restore", "the earlier 'Yes' answered another question");
  // The same answer, saved this time.
  const saved = [...hist, { role: "user", content: "Yes", timestamp: "2026-09-26T10:00:40.000Z" }, { role: "ai", content: "Any liens?", timestamp: "2026-09-26T10:00:50.000Z" }];
  assert.equal(afterFailedSend(saved, "Yes", "2026-09-26T10:00:30.000Z"), "adopt");
  assert.equal(afterFailedSend(hist, "Yes, all of it", "2026-09-26T10:00:30.000Z"), "restore");
  // No question known (legacy): the text alone decides, as before.
  assert.equal(afterFailedSend(saved, "Yes"), "adopt");
  ok("F4: a saved answer is adopted only when it answered the question the send was for");
}

// ── F6: thinking aloud is not an answer ──
{
  const label = (s: number) => (s === 0 ? "Broker" : "Seller");
  const isEcho = (t: string) => /how many staff/i.test(t);
  for (const t of ["Hmm, let me think.", "Uh… good question.", "Let me see.", "Um, one sec.", "Well, hold on.", "That's a tough one.", "Hmm."]) {
    assert.equal(isThinkingAloud(t), true, t);
    assert.equal(liveExchangeText([{ speaker: 0, text: "How many staff do you have?" }, { speaker: 1, text: t }], 0, { label, isEcho }), null, t);
  }
  for (const t of ["Yeah.", "No.", "About forty.", "Okay, forty-two.", "Let me think — about forty.", "We lease it."]) {
    assert.equal(isThinkingAloud(t), false, t);
  }
  assert.equal(
    liveExchangeText([{ speaker: 1, text: "Hmm, let me think." }, { speaker: 1, text: "About forty." }], 0, { label, isEcho }),
    "Seller: Hmm, let me think.\nSeller: About forty.",
    "the real answer goes, with the thinking before it",
  );
  assert.equal(
    liveExchangeText([{ speaker: 1, text: "Hmm, let me think." }], 0, { label, isEcho, force: true }),
    "Seller: Hmm, let me think.",
    "Send now always sends",
  );
  ok("F6: the pause timer never sends the seller thinking aloud as the answer");
}

// ── deal terms: narrow keys and topics ──
{
  for (const k of ["nonCompete", "nonCompeteYears", "transitionPeriod", "sellerTrainingPeriod", "trainingPeriod", "closingDate", "sellerFinancing", "earnOut", "vendorTakeBack", "purchasePriceHoldback", "holdbackPeriod", "escrowPeriod", "ownerStayOn"]) {
    assert.equal(isDealTermKey(k), true, k);
  }
  for (const k of ["trainingPrograms", "trainingCosts", "training", "holdbacks", "holdbacksReceivable", "holdbackReceivable", "holdbacksPayable", "escrowBalances", "transitionToCloud", "revenue"]) {
    assert.equal(isDealTermKey(k), false, k);
  }
  assert.equal(documentTermNotDealTerm({ key: "holdbacksReceivable", docName: "FY2024 Financial Statements" }), false);
  assert.equal(documentTermNotDealTerm({ key: "nonCompete", docName: "Shareholders' Agreement" }), true);
  assert.equal(documentTermNotDealTerm({ key: "nonCompete", docName: "Letter of Intent — Acme" }), false);
  assert.equal(isDealTermTopic("We have about $400K in holdbacks outstanding"), false);
  assert.equal(isDealTermTopic("Most of our staff stay on through the winter"), false);
  assert.equal(isDealTermTopic("key staff stay on under retention bonuses"), false);
  assert.equal(isDealTermTopic("they stay on year round"), false);
  assert.equal(isDealTermTopic("I'd stay on for a six-month transition period"), true);
  assert.equal(isDealTermTopic("I’d be happy to stay on for a year"), true);
  assert.equal(isDealTermTopic("the owner will stay on part-time"), true);
  assert.equal(isDealTermTopic("a 10% holdback on the purchase price"), true);
  assert.equal(isDealTermTopic("about five years post-sale"), true);
  ok("deal terms: a construction holdback, escrow balance or training budget is a business fact; 'stay on' only for the owner");
}

// ── spoken figures vs documents: decided per clause ──
{
  const roster = {
    id: "doc-roster",
    name: "Staff roster 2024",
    visibility: "shared",
    sourceKind: "document",
    extractedText: "Staff roster 2024. The company employs 38 technicians across two branches. Technicians hold 313A licences.",
    updatedAt: "2026-09-01",
  } as any;
  const plain = spokenFigureConflicts("We have 52 technicians across the two branches.", [roster]);
  assert.equal(plain.length, 1);
  assert.equal(spokenFigureConflicts("We have 52 technicians across the two branches, and I'd stay on for a six-month transition period.", [roster]).length, 1);
  assert.equal(spokenFigureConflicts("We have 52 technicians across the two branches and they stay on year round.", [roster]).length, 1);
  assert.equal(spokenFigureConflicts("I'd stay on for 6 months. We have 52 technicians across the two branches.", [roster]).length, 1);
  // A figure inside a deal-term clause is still compared only with a deal document.
  const sha = {
    id: "doc-sha",
    name: "Shareholders' Agreement",
    visibility: "shared",
    sourceKind: "document",
    extractedText: "Departing shareholders are bound by a non-compete covering 150 kilometres of the head office.",
    updatedAt: "2026-09-01",
  } as any;
  assert.equal(spokenFigureConflicts("I'd sign a non-compete covering 200 kilometres of the shop.", [sha]).length, 0);
  const spans = clauseSpans("We have 52 technicians, and I'd stay on. Revenue was $1,200,000; margins held");
  assert.deepEqual(spans.map((s) => s.text.trim()), ["We have 52 technicians", "and I'd stay on", "Revenue was $1,200,000", "margins held"]);
  ok("spoken figures: a deal-term phrase switches off only its own clause");
}

// ── live claims: holdbacks and 'stay on' in a statements passage ──
{
  const message = "Right now we're carrying about $400,000 in holdbacks on the two school jobs.";
  const mk = (docName: string, key?: string) => [{
    id: "M1",
    label: key ? `fact ${key} [${docName}]` : `passage from "${docName}"`,
    text: "Holdbacks receivable (10% statutory holdback, Construction Act): $250,000 as at December 31, 2024.",
    ...(key ? { key } : {}),
    docKind: "document",
    docName,
  }] as any;
  const raw = [{ materialId: "M1", said: "about $400,000 in holdbacks", onFile: "Holdbacks receivable: $250,000", topic: "holdbacks receivable", key: "holdbacksReceivable" }];
  assert.equal(validateLiveClaims(raw, message, mk("FY2024 Financial Statements")).length, 1);
  assert.equal(validateLiveClaims(raw, message, mk("FY2024 Financial Statements", "holdbacksReceivable")).length, 1);
  assert.equal(
    validateLiveClaims(
      [{ materialId: "M1", said: "revenue of $2,300,000", onFile: "Revenue $1,820,000; key staff stay on under retention bonuses", topic: "annual revenue", key: "annualRevenue" }],
      "Revenue last year was $2,300,000.",
      [{ id: "M1", label: 'passage from "FY2024 Financial Statements"', text: "Revenue $1,820,000 for fiscal 2024; key staff stay on under retention bonuses.", docKind: "document", docName: "FY2024 Financial Statements" }] as any,
    ).length,
    1,
  );
  // The Great Lakes case stays filtered: the covenant in the shareholders' agreement vs the sale's non-compete.
  assert.equal(
    validateLiveClaims(
      [{ materialId: "M1", said: "about five years post-sale", onFile: "two-year non-compete for departing shareholders", topic: "non-compete", key: "nonCompete" }],
      "I'd expect to sign a non-compete of about five years post-sale.",
      [{ id: "M1", label: 'passage from "Shareholders Agreement"', text: "Departing shareholders are bound by a two-year non-compete (2 years).", docKind: "document", docName: "Shareholders Agreement" }] as any,
    ).length,
    0,
  );
  ok("live claims: construction holdbacks and a statements passage mentioning staff who stay on are still conflicts");
}

// ── re-ask rule 1b: the fact must be about what the question asks ──
{
  const documents = [{ id: "fs", name: "Reviewed financial statements FY2022-2024", visibility: "shared" }] as any;
  const info = {
    revenueByYear: { "2023": "$3,420,000", "2024": "$2,960,000" },
    capexRequirements: "$410,000 in 2024; $380,000 in 2023",
    _fieldSources: {
      revenueByYear: { source: "document", documentId: "fs" },
      capexRequirements: { source: "document", documentId: "fs" },
    },
  };
  const ctx = { sellerMessage: "We run three shifts.", info, documents, priorQA: [] } as any;
  const only = (d: string) => findReasks(d, ctx).filter((f) => /ask ONLY/.test(f.detail)).map((f) => f.detail.split(":")[0]);
  for (const d of [
    "What was your EBITDA in 2022, 2023 and 2024?",
    "How many employees did you have at year end in 2022, 2023 and 2024?",
    "What were your gross margins for 2022, 2023, and 2024?",
    "How much did you spend on marketing in 2022, 2023 and 2024?",
    "What was your year-over-year customer retention in 2022, 2023 and 2024?",
    "How many trucks did you add each year in 2022, 2023 and 2024?",
  ]) {
    assert.deepEqual(only(d), [], d);
  }
  assert.deepEqual(only("What did capital expenditure look like in 2022, 2023 and 2024?"), ["capexRequirements"]);
  assert.equal(factSubjectInQuestion("revenueByYear", "What was total revenue in 2022, 2023 and 2024?"), true);
  assert.equal(factSubjectInQuestion("revenueByYear", "What were your sales in 2022, 2023 and 2024?"), true, "sales is revenue");
  assert.equal(factSubjectInQuestion("capexRequirements", "What did capital expenditure look like?"), true, "capital expenditure is capex");
  assert.equal(factSubjectInQuestion("revenueByYear", "How many employees at year end?"), false);
  assert.equal(factSubjectInQuestion("employeeCountByYear", "How many employees at year end?"), true);
  ok("re-ask 1b: 'year' is a layout word — a headcount or fleet question is never rewritten as a revenue one");
}

// ── the broker's own AI-session notes: not a broker edit ──
{
  const session = { source: "broker", sessionId: "s-b", turn: 1, at: "2026-09-26T10:00:00Z", note: BROKER_SESSION_SOURCE_NOTE } as any;
  const edit = { source: "broker", at: "2026-09-26T10:00:00Z" } as any;
  assert.equal(isBrokerSessionSource(session), true);
  assert.equal(isBrokerFinalSource(session), false);
  assert.equal(isBrokerFinalSource(edit), true);
  assert.equal(fieldSourceRank(edit), SOURCE_RANK.broker);
  assert.equal(fieldSourceRank(session), SOURCE_RANK.questionnaire);
  assert.ok(fieldSourceRank(session) < SOURCE_RANK.interview && fieldSourceRank(session) < SOURCE_RANK.call);
  const info = { annualRevenue: "$2,000,000", _fieldSources: { annualRevenue: session } };
  assert.equal(sourceAllowsOverwrite(info, "annualRevenue", "interview"), true, "the seller's own answer replaces the broker's notes");
  assert.equal(sourceAllowsOverwrite(info, "annualRevenue", "call"), true);
  assert.equal(sourceAllowsOverwrite({ annualRevenue: "$2,000,000", _fieldSources: { annualRevenue: edit } }, "annualRevenue", "interview"), false, "a broker edit is still final");
  // A document is the authority for statement lines (founder decision A) — over the broker's notes too.
  const doc = { source: "document", documentId: "fs", period: "2024-12-31" } as any;
  assert.ok(effectiveRank("annualRevenue", doc) > effectiveRank("annualRevenue", session));
  assert.equal(outranksFor("annualRevenue", doc, session), true);
  assert.equal(outranksFor("annualRevenue", doc, edit), false);
  // …but not for the seller's narrative (a document ranks below the broker's notes there).
  assert.equal(outranksFor("reasonForSale", { source: "document", documentId: "x" } as any, session), false);
  ok("broker session notes rank with the questionnaire: the seller replaces them; documents win where they are the authority; broker edits stay final");
}

// ── sessions: finished, ending, live, dashboard, tasks ──
{
  assert.equal(sessionFinishedInterview({ status: "completed", extractedInfo: {} }), true);
  assert.equal(sessionFinishedInterview({ status: "completed", extractedInfo: { _closedFor: "broker_with_seller" } }), false, "closed for 'Interview together'");
  assert.equal(sessionFinishedInterview({ status: "completed", extractedInfo: { _closedFor: "seller" } }), false);
  assert.equal(sessionFinishedInterview({ status: "completed", extractedInfo: { _reopenedAt: "x" } }), false);
  assert.equal(sessionFinishedInterview({ status: "completed", extractedInfo: { _conductedBy: "broker" } }), false, "the broker's own session");
  assert.equal(sessionFinishedInterview({ status: "completed", extractedInfo: { _conductedBy: "broker_with_seller" } }), true);
  assert.equal(sessionFinishedInterview({ status: "active", extractedInfo: {} }), false);
  assert.equal(endingCompletesInterview("broker"), false);
  assert.equal(endingCompletesInterview("seller"), true);
  assert.equal(endingCompletesInterview("broker_with_seller"), true);
  ok("a closed, reopened or broker-alone session never counts as the interview finished");

  const now = Date.now();
  const room = (minutes: number, extra: Record<string, unknown> = {}) => ({
    id: `r${minutes}`,
    status: "active",
    extractedInfo: { _conductedBy: "broker_with_seller" },
    lastActivityAt: new Date(now - minutes * 60_000),
    ...extra,
  });
  assert.equal(togetherSessionLive(room(1), now), true);
  assert.equal(togetherSessionLive(room(29), now), true);
  assert.equal(togetherSessionLive(room(TOGETHER_LIVE_MS / 60_000 + 1), now), false, "gone quiet");
  assert.equal(togetherSessionLive(room(1, { status: "completed" }), now), false);
  assert.equal(togetherSessionLive(room(1, { extractedInfo: { _conductedBy: "seller" } }), now), false);
  assert.equal(togetherSessionLive({ ...room(1), lastActivityAt: new Date(now - 60_000).toISOString() }, now), true);
  ok("an 'Interview together' sitting counts as live for 30 minutes after its last exchange");

  const at = (d: number) => new Date(now - d * 86_400_000);
  const rows = [
    { id: "a", dealId: "d1", extractedInfo: { _conductedBy: "broker" }, lastActivityAt: at(5) },
    { id: "b", dealId: "d1", extractedInfo: {}, lastActivityAt: at(6) },
    { id: "c", dealId: "d1", extractedInfo: { _conductedBy: "seller" }, lastActivityAt: at(4) },
    { id: "d", dealId: "d2", extractedInfo: { _conductedBy: "broker" }, lastActivityAt: at(9) },
    { id: "e", dealId: "d3", extractedInfo: { _conductedBy: "broker_with_seller" }, lastActivityAt: at(9) },
  ];
  assert.deepEqual(stalledSellerSessions(rows).map((r) => r.id), ["c"], "the broker's own session never reads 'waiting on the seller'; one row per deal");
  ok("dashboard: only the seller's own quiet interview, once per deal");

  const tasks = [
    { id: "1", createdBy: "ai_interview", title: "Upload the lease" },
    { id: "2", createdBy: BROKER_SESSION_TASK_CREATOR, title: "Ask about the 2019 lawsuit" },
    { id: "3", createdBy: "system", title: "Missing: Lease" },
  ];
  assert.deepEqual(sellerSideTasks(tasks).map((t) => t.id), ["1", "3"]);
  // The dedupe sweep never removes one creator's task for another's.
  const plan = planTaskWrites({
    newTasks: [],
    existing: [
      { id: "t1", type: "follow_up", title: "Lease terms", description: "", relatedField: null, status: "pending", createdBy: "ai_interview", createdAt: new Date(now - 2000) },
      { id: "t2", type: "follow_up", title: "Lease terms", description: "", relatedField: null, status: "pending", createdBy: BROKER_SESSION_TASK_CREATOR, createdAt: new Date(now - 1000) },
      { id: "t3", type: "follow_up", title: "Lease terms", description: "", relatedField: null, status: "pending", createdBy: BROKER_SESSION_TASK_CREATOR, createdAt: new Date(now) },
    ] as any,
    documents: [],
    answeredKeys: new Set(),
    resolvedTopics: [],
    sellerMessage: "",
  } as any);
  assert.deepEqual(plan.remove, ["t3"], "only the broker session's own duplicate");
  ok("tasks: the broker's own session's to-dos never reach a seller-facing context");
}

process.stdout.write(`\n${n} checks passed\n`);
