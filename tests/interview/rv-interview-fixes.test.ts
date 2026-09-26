// Review round V, interview side (offline): RV-INT-1 (a firm stop read into a
// business answer force-ended the interview), RV-INT-3 (a privacy request's
// generic terms corrupted and dropped good facts), RV-INT-5 (the "seller chose
// to continue" re-call was dead code), R2 (withdrawing one year of a by-year
// map deleted the whole map), PRIV-V-2 (a keep-out request neither lasted nor
// reached the CIM keep-out), PRIV-V-3 (privacy details in the server log).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/rv-interview-fixes.test.ts
import assert from "node:assert/strict";
import { quickIntent, combineIntent, planIntentEdits, applyPartialEdits, type SellerIntent } from "../../server/interview/seller-intent";
import { detectFirmStop, firmStopLevel, detectStopSignal } from "../../server/interview/turn-guard";
import { applySellerRetractions, termRegex, claimYearsInMap } from "../../server/interview/fact-guards";
import { addPrivateNote, getFieldSources, type FieldChange } from "../../server/interview/info-merger";
import { mergeYearMapInto } from "../../server/documents/merge-policy";
import {
  distinctivePrivateTerms,
  isDistinctiveTerm,
  applySellerKeepOutToFacts,
  addSellerKeepOut,
  carriesPrivateDetail,
  SELLER_KEEP_OUT_REASON,
  HELD_BACK_NOTE_REASON,
} from "../../server/interview/seller-keep-out";
import { keepOutFromNotes, screenFactsForCim } from "../../server/cim/sensitive-facts";
import { keepOutFor, _setKeepOutModelForTests } from "../../server/cim/keep-out";
import { installHarness, baseDeal, ai, seller } from "./turn-harness";
import { processTurn } from "../../server/interview/session-manager";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };
const modelIntent = (x: Partial<SellerIntent>): SellerIntent => ({
  stop: "none", continueRequest: false, sellerQuestion: "", retractions: [], corrections: [], privacyRequests: [], via: "model", ...x,
});
const change = (fieldName: string, newValue: string, previousValue: string | null = null): FieldChange => ({
  fieldName, previousValue, previousConfidence: null, newValue, newConfidence: "confirmed", source: "seller_statement",
});
const at = "2026-09-25T10:00:00Z";
const iv = (turn = 3) => ({ source: "interview", sessionId: "s1", turn, at });

// ── RV-INT-1: a firm stop never stands on a business sentence ──
{
  const business = [
    "Rarely now. Once they see the warranty they just stop asking.",
    "After a while the reps just stop asking, it's all online now.",
    "The bank asked a lot at first, now no more questions.",
    "Once the inspector signs off, that's it, no more questions.",
    "Broker: Any issues with the health inspector?\nSeller: Nothing major. Once he signs off, that's it, no more questions.",
    "The auditor came in, checked the books, no more questions.",
    "Honestly the landlord signed the renewal, no more questions.",
    "We sent the lender the statements and that was it: no more questions.",
    "Customers just stop asking me for discounts once they see the warranty.",
  ];
  for (const s of business) {
    assert.equal(detectFirmStop(s), false, `not firm: ${s}`);
    const q = quickIntent(s, "Do customers ever push back on price?");
    assert.equal(q.stop, "none", `patterns: no stop: ${s}`);
    assert.equal(combineIntent(q, modelIntent({ stop: "none" })).stop, "none", `combined: ${s}`);
    assert.equal(combineIntent(q, null).stop, "none", `classifier down: ${s}`);
  }
  // Bare / addressed stops stand, whatever the classifier reads.
  for (const s of ["Stop.", "Please stop asking me questions.", "No more questions.", "No more questions for today please.", "Seriously, stop asking me things.", "I'm done answering questions today.", "Seller: Stop asking me questions.", "I'm exhausted, stop asking me."]) {
    assert.equal(firmStopLevel(s), "stands", s);
    assert.equal(combineIntent(quickIntent(s), modelIntent({ stop: "none" })).stop, "firm", `stands: ${s}`);
  }
  // A bare phrase after a short clause is a firm stop by the patterns only:
  // the classifier's reading decides when there is one.
  const tired = "I'm tired, no more questions.";
  assert.equal(firmStopLevel(tired), "pattern");
  assert.equal(combineIntent(quickIntent(tired), modelIntent({ stop: "none" })).stop, "none", "the classifier can downgrade it");
  assert.equal(combineIntent(quickIntent(tired), modelIntent({ stop: "soft" })).stop, "soft");
  assert.equal(combineIntent(quickIntent(tired), modelIntent({ stop: "firm" })).stop, "firm");
  assert.equal(combineIntent(quickIntent(tired), null).stop, "firm", "classifier down: the patterns decide");
  ok("RV-INT-1 patterns: business answers never read as a firm stop; only a bare/addressed stop stands against the classifier");
}

// ── R2: withdrawing one year of a by-year map ──
{
  const callYear = { source: "call", documentId: "call-1", at };
  const stmt = (y: string) => ({ source: "document", documentId: "fs-1", period: `${y}-12-31`, at });
  const mapInfo = () => ({
    revenueByYear: { "2022": "$1,900,000", "2023": "$2,050,000", "2024": "$2.1M" },
    _fieldSources: {
      revenueByYear: { ...callYear, years: { "2022": stmt("2022"), "2023": stmt("2023"), "2024": callYear } },
    },
  } as Record<string, unknown>);
  assert.deepEqual(claimYearsInMap("2024 revenue of $2.1M", mapInfo().revenueByYear as any), ["2024"]);
  assert.deepEqual(claimYearsInMap("the $2.1M", mapInfo().revenueByYear as any), ["2024"]);
  // (a) The classifier names the claim; its remainder is empty.
  {
    const info = mapInfo();
    const plan = planIntentEdits({
      intent: modelIntent({ retractions: [{ what: "2024 revenue of $2.1M", fieldHint: "revenueByYear", remainingValue: "" }] }),
      info, changes: [], modelRetracted: [], modelPrivateNotes: [], sellerMessage: "Ignore the $2.1M for 2024, I was guessing.", sessionId: "s1", turn: 5,
    });
    assert.deepEqual(plan.retractions.map((r) => [r.field, r.years]), [["revenueByYear", ["2024"]]]);
    const r = applySellerRetractions(info, plan.retractions, { turn: 5 });
    assert.deepEqual(info.revenueByYear, { "2022": "$1,900,000", "2023": "$2,050,000" }, "the statement years stay");
    assert.deepEqual(Object.keys((getFieldSources(info).revenueByYear as any).years).sort(), ["2022", "2023"]);
    assert.equal(getFieldSources(info).revenueByYear.source, "document", "the map's source is its statements now");
    assert.deepEqual(r.removed, ["revenueByYear.2024"]);
    const suppressed = info._brokerSuppressed as string[];
    assert.ok(!suppressed.includes("revenueByYear"), "the map key is never suppressed wholesale");
    assert.deepEqual(suppressed, ["revenueByYear.2024@call-1"]);
    assert.match((info._brokerDeleted as any).revenueByYear.note, /2024 only/);
    // Re-reading the transcript can't bring the guess back; a statement can fill the year.
    mergeYearMapInto(info, "revenueByYear", { "2024": "$2.1M" }, { source: "call", documentId: "call-1" } as any);
    assert.equal((info.revenueByYear as any)["2024"], undefined);
    mergeYearMapInto(info, "revenueByYear", { "2024": "$2,240,000" }, { source: "document", documentId: "fs-2", period: "2024-12-31" } as any);
    assert.equal((info.revenueByYear as any)["2024"], "$2,240,000");
  }
  // (b) Classifier down: the interview model's retractedFields names the whole key.
  {
    const info = mapInfo();
    const plan = planIntentEdits({
      intent: quickIntent("Scratch that, I was guessing on the 2024 number."),
      info, changes: [], modelRetracted: [{ field: "revenueByYear", reason: "guess" }], modelPrivateNotes: [], sellerMessage: "Scratch that, I was guessing on the 2024 number.", sessionId: "s1", turn: 5,
    });
    applySellerRetractions(info, plan.retractions, { turn: 5 });
    assert.deepEqual(info.revenueByYear, { "2022": "$1,900,000", "2023": "$2,050,000" }, "only the seller's year goes");
  }
  // (c) A map that is all the seller's goes whole — but never a document-only map.
  {
    const docOnly: Record<string, unknown> = { revenueByYear: { "2023": "$2M" }, _fieldSources: { revenueByYear: { source: "document", documentId: "fs-1", years: { "2023": { source: "document", documentId: "fs-1" } } } } };
    const r = applySellerRetractions(docOnly, [{ field: "revenueByYear", reason: "x" }], { turn: 2 });
    assert.deepEqual(r.skipped, ["revenueByYear"]);
    assert.deepEqual(docOnly.revenueByYear, { "2023": "$2M" });
    const mine: Record<string, unknown> = { revenueByYear: { "2023": "$2M" }, _fieldSources: { revenueByYear: { ...iv(), years: { "2023": iv() } } } };
    applySellerRetractions(mine, [{ field: "revenueByYear", reason: "x" }], { turn: 2 });
    assert.equal(mine.revenueByYear, undefined);
  }
  ok("R2: a withdrawn year goes alone, only when the seller stated it; statement years stay; the transcript's guess can't come back, a statement still can");
}

// ── RV-INT-3: a privacy request is scoped to the disclosure ──
{
  for (const t of ["health", "doctor", "diagnosis", "diagnosed", "patient", "customer", "contract", "RFP", "competitor", "Health"]) assert.equal(isDistinctiveTerm(t), false, t);
  for (const t of ["cancer", "heart attack", "Kestrel", "multiple sclerosis", "MS", "wrongful dismissal"]) assert.equal(isDistinctiveTerm(t), true, t);
  const msg = "About 55% is extended health insurance, 30% WSIB, 15% private pay. Referrals mostly from family doctors. Honestly the real reason I'm selling is my health — I had a heart attack in March. Keep that out of the book.";
  const detail = "The real reason for sale is the owner's heart attack in March";
  assert.deepEqual(distinctivePrivateTerms(["heart attack", "health", "doctor"], msg, detail), ["heart attack"]);
  assert.deepEqual(distinctivePrivateTerms(["cancer"], "Please keep that out of the book.", "wife's cancer diagnosis"), [], "a term the seller didn't say");
  assert.deepEqual(distinctivePrivateTerms(["cancer"], "Please keep that out of the book.\nMy wife has cancer.", "wife's cancer diagnosis"), ["cancer"], "…said in the message 'that' points back to");
  const payer = "About 55% extended health insurance, 30% WSIB, 15% private pay";
  const plan = planIntentEdits({
    intent: modelIntent({ privacyRequests: [{ what: "owner's health", detail, sensitiveTerms: ["heart attack", "health", "doctor"], fieldHint: "", remainingValue: "" }] }),
    info: {},
    changes: [change("payerMix", payer), change("referralSources", "Mostly family doctors"), change("reasonForSale", "Retiring after a heart attack in March")],
    modelRetracted: [], modelPrivateNotes: [], sellerMessage: msg, sessionId: "s1", turn: 4,
  });
  assert.deepEqual(plan.changes.map((c) => [c.fieldName, c.newValue]), [["payerMix", payer], ["referralSources", "Mostly family doctors"]], "the payer mix is whole; the referral source lands");
  assert.deepEqual(plan.keptPrivateTerms, ["heart attack"]);
  // A list carrying the detail is held back whole, never cut in the middle — and not silently.
  const plan2 = planIntentEdits({
    intent: modelIntent({ privacyRequests: [{ what: "RFP", detail: "Shortlisted for the Kestrel Systems RFP", sensitiveTerms: ["Kestrel"], fieldHint: "", remainingValue: "" }] }),
    info: {},
    changes: [change("pipeline", "Three open bids: Kestrel Systems ($1.2M), city of Red Deer maintenance, two school boards in the region")],
    modelRetracted: [], modelPrivateNotes: [], sellerMessage: "The Kestrel one isn't announced, keep that out of the book.", sessionId: "s1", turn: 4,
  });
  assert.deepEqual(plan2.changes, []);
  assert.ok(plan2.privateNotes.some((p) => /^pipeline: Three open bids/.test(p.note) && p.reason === HELD_BACK_NOTE_REASON), "the held-back value is in the broker's notes");
  assert.ok(plan2.privateNotes.some((p) => p.reason === SELLER_KEEP_OUT_REASON && /Kestrel/.test(p.note)), "…beside the request itself");
  // An acronym is its case, and never a product name.
  assert.equal(termRegex("MS")!.test("Books kept in MS Dynamics"), false);
  assert.equal(termRegex("MS")!.test("Harjit was diagnosed with MS in 2025"), true);
  ok("RV-INT-3: only specific terms the seller said and the detail holds; a payer mix with 'health' is untouched; a list is held back whole, into the broker's notes");
}

// ── PRIV-V-2: the request lasts, and every CIM path holds it ──
{
  const request = modelIntent({ privacyRequests: [{ what: "Kestrel RFP", detail: "Shortlisted for the Kestrel Systems RFP (about $1.2M a year)", sensitiveTerms: ["Kestrel", "RFP"], fieldHint: "growthOpportunities", remainingValue: "Expansion into Red Deer." }] });
  const say = "The Kestrel bid isn't announced yet, keep that out of the book please.";
  // (B) the detail in two of the seller's facts: both are cut.
  {
    const info: Record<string, unknown> = {
      growthOpportunities: "Shortlisted for the Kestrel Systems RFP, a 3-year maintenance contract worth about $1.2M a year. Expansion into Red Deer.",
      salesPipeline: "Main pending bid is the Kestrel Systems RFP (~$1.2M/yr); decision expected in Q1.",
      _fieldSources: { growthOpportunities: iv(), salesPipeline: iv() },
    };
    const plan = planIntentEdits({ intent: request, info, changes: [], modelRetracted: [], modelPrivateNotes: [], sellerMessage: say, sessionId: "s1", turn: 6 });
    applyPartialEdits(info, plan.partialEdits, { turn: 6 });
    assert.equal(info.growthOpportunities, "Expansion into Red Deer.");
    assert.equal(info.salesPipeline, "decision expected in Q1.");
    // Nothing vanishes without a trace: the full answers are in the deleted-facts history.
    const deleted = info._brokerDeleted as Record<string, { value: string; note: string }>;
    assert.match(deleted.salesPipeline.value, /^Main pending bid is the Kestrel/);
    assert.match(deleted.salesPipeline.note, /taken out; this is the full answer as it was \(interview turn 6\)/);
    assert.match(deleted.growthOpportunities.value, /^Shortlisted for the Kestrel/);
    assert.deepEqual(plan.keepOut.map((e) => e.terms), [["Kestrel"]], "'RFP' is no term of its own");
  }
  // (C) the detail in a document's fact: the fact stays as the document says
  // it, and every CIM input holds it.
  {
    const info: Record<string, unknown> = {
      growthOpportunities: "Expansion into Red Deer.",
      salesPipeline: "Shortlisted for the Kestrel Systems RFP, worth about $1.2M a year; decision Q1.",
      customers: "Kestrel Systems is not a customer yet; top customer is Alberta Health Services (18%).",
      _fieldSources: { growthOpportunities: iv(), salesPipeline: { source: "document", documentId: "d1" }, customers: { source: "document", documentId: "d1" } },
    };
    const plan = planIntentEdits({ intent: request, info, changes: [], modelRetracted: [], modelPrivateNotes: [], sellerMessage: say, sessionId: "s1", turn: 6 });
    assert.deepEqual(plan.partialEdits, [], "a document's fact isn't edited");
    for (const p of plan.privateNotes) addPrivateNote(info, p.note, { reason: p.reason, turn: 6 });
    addSellerKeepOut(info, plan.keepOut);
    const ko = keepOutFromNotes(info);
    assert.ok(ko.names.includes("Kestrel Systems"));
    const pairs = Object.entries(info).filter(([k]) => !k.startsWith("_"));
    const s = screenFactsForCim(pairs, ko);
    assert.doesNotMatch(JSON.stringify(s.safe), /Kestrel|1\.2M/, "nothing about the RFP reaches the CIM writer");
    assert.match(JSON.stringify(s.safe), /Alberta Health Services/, "the rest of the file is untouched");
  }
  // A note written by an earlier build (only the reason says what it is) holds too.
  {
    const info: Record<string, unknown> = {
      growthOpportunities: "Shortlisted for the Kestrel Systems RFP, worth about $1.2M a year; expansion into Red Deer.",
      _fieldSources: { growthOpportunities: { source: "document", documentId: "d1" } },
      _brokerPrivateNotes: [{ note: "Shortlisted for the Kestrel Systems RFP (about $1.2M a year)", reason: "the seller asked that this stay out of the sale document", turn: 4 }],
    };
    const s = screenFactsForCim([["growthOpportunities", info.growthOpportunities]], keepOutFromNotes(info));
    assert.deepEqual(s.safe, [["growthOpportunities", "expansion into Red Deer."]]);
  }
  // Reprocess: a call transcript's re-read brings the detail back; the request cuts it again.
  {
    const info: Record<string, unknown> = {
      salesPipeline: "Main pending bid is the Kestrel Systems RFP (~$1.2M/yr). Decision expected in Q1.",
      ownerNotes: "Owner plans to stay two years.",
      _fieldSources: { salesPipeline: { source: "call", documentId: "call-1" }, ownerNotes: { source: "call", documentId: "call-1" } },
      _sellerKeepOut: [{ detail: "Shortlisted for the Kestrel Systems RFP (about $1.2M a year)", terms: ["Kestrel"] }],
    };
    assert.deepEqual(applySellerKeepOutToFacts(info), ["salesPipeline"]);
    assert.equal(info.salesPipeline, "Decision expected in Q1.");
    assert.equal(info.ownerNotes, "Owner plans to stay two years.");
  }
  ok("PRIV-V-2: every seller fact carrying the detail is cut; the request is kept on the deal; a document's statement of it is held out of the CIM; a reprocess can't bring it back");
}

// ── Round 2 (the checker's probes) ──
// RV-INT-1: nothing that can describe the business stands against the classifier.
{
  const business = [
    "The auditor finished Tuesday, no more questions for now.",
    "We filed everything with the city, no more questions for now.",
    "We passed the inspection in May, no more questions today.",
    "I'm done with the questions from the lender, they approved the refinancing in May.",
    "I'm done answering the CRA's questions, they closed the audit last month.",
    "No more questions, they signed the renewal the same week.",
    "No more questions. They signed off on the loan in a week.",
    "The inspector left happy. No more questions after that.",
  ];
  for (const s of business) {
    assert.notEqual(firmStopLevel(s), "stands", s);
    assert.equal(combineIntent(quickIntent(s), modelIntent({ stop: "none" })).stop, "none", `the classifier decides: ${s}`);
  }
  // One topic declined is not the end of the interview.
  assert.equal(firmStopLevel("I don't want to answer any more questions about the lawsuit."), null);
  // Still standing: said to the interviewer, and nothing about the business after it.
  for (const s of ["No more questions for today, please.", "No more questions. I'm tired.", "I'm done with your questions.", "I don't want to answer any more questions today.", "Enough with the questions, seriously.", "The same thing three times — no more questions please."]) {
    assert.equal(firmStopLevel(s), "stands", s);
  }
  // A longer clause about the seller's patience or time is still a stop by
  // the patterns — honoured when the classifier is down.
  for (const s of ["I've had enough of this, no more questions.", "Look, I've got a customer waiting, no more questions.", "Sorry but I need to go, no more questions.", "Honestly I'm exhausted and this is taking forever, no more questions."]) {
    assert.equal(firmStopLevel(s), "pattern", s);
    assert.equal(combineIntent(quickIntent(s), null).stop, "firm", `classifier down: ${s}`);
  }
  ok("RV-INT-1 round 2: 'for now'/'today' after a clause, 'No more questions, <business>', 'I'm done with the questions from …' and one declined topic don't stand; real stops still do");
}

// R2: two withdrawn years of one map add up; the patterns path withdraws only the year named.
{
  const call = { source: "call", documentId: "call-1", at };
  const info: Record<string, unknown> = {
    revenueByYear: { "2022": "$1,900,000", "2023": "$2.0M", "2024": "$2.1M" },
    _fieldSources: { revenueByYear: { ...call, years: { "2022": { source: "document", documentId: "fs-1" }, "2023": call, "2024": call } } },
  };
  const plan = planIntentEdits({
    intent: modelIntent({ retractions: [{ what: "2023 revenue of $2.0M", fieldHint: "revenueByYear", remainingValue: "" }, { what: "2024 revenue of $2.1M", fieldHint: "revenueByYear", remainingValue: "" }] }),
    info, changes: [], modelRetracted: [], modelPrivateNotes: [], sellerMessage: "Both the 2023 and 2024 numbers I gave on the call were guesses.", sessionId: "s1", turn: 5,
  });
  assert.deepEqual(plan.retractions.map((r) => r.years), [["2023", "2024"]]);
  applySellerRetractions(info, plan.retractions, { turn: 5 });
  assert.deepEqual(info.revenueByYear, { "2022": "$1,900,000" });
  const info2: Record<string, unknown> = {
    revenueByYear: { "2023": "$2.0M", "2024": "$2.1M" },
    _fieldSources: { revenueByYear: { ...call, years: { "2023": call, "2024": call } } },
  };
  const msg = "Scratch that, I was guessing on the 2024 number.";
  const plan2 = planIntentEdits({ intent: quickIntent(msg), info: info2, changes: [], modelRetracted: [{ field: "revenueByYear", reason: "guess" }], modelPrivateNotes: [], sellerMessage: msg, sessionId: "s1", turn: 5 });
  assert.deepEqual(plan2.retractions.map((r) => r.years), [["2024"]]);
  applySellerRetractions(info2, plan2.retractions, { turn: 5 });
  assert.deepEqual(info2.revenueByYear, { "2023": "$2.0M" }, "the 2023 figure the seller didn't withdraw stays");
  // A map not keyed by year, from a call transcript, is suppressed whole (re-read whole on reprocess).
  const roles: Record<string, unknown> = {
    employeesByRole: { Technicians: "6", Office: "2" },
    _fieldSources: { employeesByRole: { ...call, years: { Technicians: call, Office: call } } },
  };
  applySellerRetractions(roles, [{ field: "employeesByRole", reason: "guess" }], { turn: 5 });
  assert.equal(roles.employeesByRole, undefined);
  assert.deepEqual(roles._brokerSuppressed, ["employeesByRole"]);
  ok("R2 round 2: two withdrawn years of one map both go; classifier down, only the year the seller names goes");
}

// RV-INT-3 round 2: a term is not the detail on its own; nothing is cut without a trace.
{
  const detail = "The owner is selling because his wife was diagnosed with MS";
  const msg = "Honestly my wife was diagnosed with MS last spring, that's really why I'm selling. Please keep that out of the book.";
  const request = modelIntent({ privacyRequests: [{ what: "wife's illness", detail, sensitiveTerms: ["MS", "multiple sclerosis", "diagnosed"], fieldHint: "", remainingValue: "" }] });
  const services = "Orthopedic, sports and neuro rehab, including stroke, MS and Parkinson's programs";
  const info: Record<string, unknown> = {
    servicesOffered: services,
    neuroProgram: "Neuro program for MS and stroke patients runs Tuesdays and Thursdays",
    reasonForSale: "Retirement",
    _fieldSources: { servicesOffered: iv(2), neuroProgram: { source: "document", documentId: "d1" }, reasonForSale: iv(1) },
  };
  const plan = planIntentEdits({ intent: request, info, changes: [change("ownerCircumstances", "Owner's wife diagnosed with MS last spring")], modelRetracted: [], modelPrivateNotes: [], sellerMessage: msg, sessionId: "s1", turn: 6 });
  assert.deepEqual(plan.partialEdits, [], "the clinic's services list is not the owner's wife");
  assert.deepEqual(plan.changes, [], "…while the wife's diagnosis itself never lands");
  addSellerKeepOut(info, plan.keepOut);
  const entry = plan.keepOut[0];
  assert.equal(carriesPrivateDetail("We run a neuro program for MS, stroke and Parkinson's patients", entry), false, "a later answer about the services is recorded");
  assert.equal(carriesPrivateDetail("Owner's wife has MS", entry), true);
  assert.equal(carriesPrivateDetail("MS is why he is selling", entry), true);
  const s = screenFactsForCim(Object.entries(info).filter(([k]) => !k.startsWith("_")), keepOutFromNotes(info));
  assert.match(JSON.stringify(s.safe), /stroke, MS and Parkinson/);
  assert.match(JSON.stringify(s.safe), /Neuro program for MS and stroke patients/, "the document's program reaches the CIM writer");
  // Everyday words are never terms.
  for (const t of ["closing", "second location", "location", "spring"]) assert.equal(isDistinctiveTerm(t), false, t);
  const plan2 = planIntentEdits({
    intent: modelIntent({ privacyRequests: [{ what: "closure", detail: "The owner is thinking of closing the second location next spring", sensitiveTerms: ["closing", "second location"], fieldHint: "", remainingValue: "" }] }),
    info: { locations: "Two clinics: Main St (flagship) and the second location on 5th Ave, opened 2019", staffing: "Six physios; two work at the second location", _fieldSources: { locations: iv(2), staffing: iv(2) } },
    changes: [change("plans", "Considering closing the 5th Ave location next spring")],
    modelRetracted: [], modelPrivateNotes: [], sellerMessage: "I'm thinking of closing the second location next spring, keep that out of the book.", sessionId: "s1", turn: 6,
  });
  assert.deepEqual(plan2.partialEdits, [], "the locations and staffing facts stay whole");
  assert.deepEqual(plan2.changes, [], "the closure itself, said in other words this turn, doesn't land");
  // Only generic terms: the detail is still noted even though the model wrote some other note,
  // and this turn's answer saying it in everyday words is held back (a stranded "…care for her" too).
  const lawsuit = planIntentEdits({
    intent: modelIntent({ privacyRequests: [{ what: "the lawsuit", detail: "A former manager has filed a wrongful dismissal lawsuit", sensitiveTerms: ["lawsuit"], fieldHint: "", remainingValue: "" }] }),
    info: {}, changes: [change("pendingLitigation", "Lawsuit filed by an ex-manager over his dismissal")], modelRetracted: [],
    modelPrivateNotes: [{ note: "Seller was referred by his BDC advisor" }],
    sellerMessage: "There's a lawsuit from a former manager, wrongful dismissal. Keep that out of the book.", sessionId: "s1", turn: 4,
  });
  assert.deepEqual(lawsuit.privateNotes.map((p) => p.note), ["A former manager has filed a wrongful dismissal lawsuit"]);
  assert.deepEqual(lawsuit.changes, []);
  const sick = planIntentEdits({
    intent: modelIntent({ privacyRequests: [{ what: "wife's illness", detail: "The real reason for sale is that his wife is sick", sensitiveTerms: ["sick", "wife"], fieldHint: "", remainingValue: "" }] }),
    info: {}, changes: [change("ownerCircumstances", "Wife is sick; owner wants to care for her")], modelRetracted: [], modelPrivateNotes: [],
    sellerMessage: "The real reason is my wife is sick. Keep that between us.", sessionId: "s1", turn: 4,
  });
  assert.deepEqual(sick.changes, []);
  // A held-back value is the broker's record, not a request: the document's
  // public bids and "Three service vans" still reach the CIM writer.
  const kestrel = planIntentEdits({
    intent: modelIntent({ privacyRequests: [{ what: "RFP", detail: "Shortlisted for the Kestrel Systems RFP", sensitiveTerms: ["Kestrel"], fieldHint: "", remainingValue: "" }] }),
    info: {}, changes: [change("pipeline", "Three open bids: Kestrel Systems ($1.2M), city of Red Deer maintenance, two school boards in the region")],
    modelRetracted: [], modelPrivateNotes: [], sellerMessage: "The Kestrel one isn't announced, keep that out of the book.", sessionId: "s1", turn: 4,
  });
  const docInfo: Record<string, unknown> = {
    publicBids: "Bidding on the city of Red Deer maintenance contract and two school boards in the region",
    fleet: "Three service vans and a crane truck",
    _fieldSources: { publicBids: { source: "document", documentId: "d1" }, fleet: { source: "document", documentId: "d1" } },
  };
  for (const p of kestrel.privateNotes) addPrivateNote(docInfo, p.note, { reason: p.reason, turn: 4 });
  addSellerKeepOut(docInfo, kestrel.keepOut);
  const ko = keepOutFromNotes(docInfo);
  assert.ok(!ko.names.includes("Three"));
  const safe = screenFactsForCim(Object.entries(docInfo).filter(([k]) => !k.startsWith("_")), ko).safe;
  assert.deepEqual(safe.map(([k]) => k), ["publicBids", "fleet"]);
  // Reprocess: a re-applied cut is recorded too.
  const re: Record<string, unknown> = {
    salesPipeline: "Main pending bid is the Kestrel Systems RFP (~$1.2M/yr).",
    _fieldSources: { salesPipeline: { source: "call", documentId: "call-1" } },
    _sellerKeepOut: [{ detail: "Shortlisted for the Kestrel Systems RFP (about $1.2M a year)", terms: ["Kestrel"] }],
  };
  assert.deepEqual(applySellerKeepOutToFacts(re), ["salesPipeline"]);
  assert.equal(re.salesPipeline, undefined);
  assert.match((re._brokerDeleted as any).salesPipeline.value, /Kestrel/);
  ok("RV-INT-3 round 2: 'MS' / 'second location' don't cut the clinic's facts; the detail itself never lands; generic-only requests are noted and held; a held-back value holds nothing else out of the CIM; every cut is in the deleted-facts history");
}

// ── Whole turns (offline harness) ──
(async () => {
  const history = [
    ai("What's the lease term on the Hillhurst location?"),
    seller("It's a 10-year lease from 2021."),
    ai("Any issues with the health inspector?"),
  ];
  const deal = () => baseDeal({
    extractedInfo: {
      leaseTerm: "10-year lease from 2021",
      _fieldSources: { leaseTerm: { source: "interview", sessionId: "sess-1", turn: 1, at } },
    },
  });

  // RV-INT-1: a business answer with "no more questions" never ends the interview.
  {
    const h = installHarness(deal(), { messages: [...history] });
    h.intents.push({ stop: "none" });
    h.script.push({ message: "How often does the inspector come by?" });
    const r = await processTurn("deal-1", "sess-1", "Nothing major. Once he signs off, that's it, no more questions.");
    assert.equal(r.shouldEnd, false);
    assert.equal(h.deal.interviewCompleted, false);
    assert.doesNotMatch(h.systems[0], /SELLER STOP|THE SELLER WANTS TO STOP/);
    assert.equal(h.systems.length, 1, "no re-call");
  }
  // A firm stop only the patterns saw, which the classifier reads as soft:
  // the goodbye draft is redone as the one closing question; nothing is forced.
  {
    const h = installHarness(deal(), { messages: [...history] });
    h.intents.push({ stop: "soft" });
    h.script.push({ message: "Understood — thanks for your time today.", shouldEnd: true });
    h.script.push({ message: "Of course — before you go, a rough asking price now, or shall we start there next time?" });
    const r = await processTurn("deal-1", "sess-1", "I'm tired, no more questions.");
    assert.equal(h.systems.length, 2, "one re-call");
    assert.match(h.systems[0], /SELLER STOP — END NOW/);
    assert.match(h.systems[1], /THE SELLER WANTS TO STOP/);
    assert.equal(r.shouldEnd, false);
    assert.equal(h.deal.interviewCompleted, false);
  }

  // RV-INT-5: the answer to a closing turn asks to keep going — on the
  // non-streamed path the draft written for # CLOSING is redone.
  {
    const h = installHarness(deal(), {
      messages: [...history, seller("Can we wrap this up?"), ai("Of course — a rough asking price now, or shall we start there next time?")],
      sessionMeta: { _stopSignalCount: 1 },
    });
    const msg = "Actually I got a second wind — ask away, what else do you need?";
    assert.equal(quickIntent(msg).continueRequest, false, "the patterns miss it");
    h.intents.push({ stop: "none", continueRequest: true });
    h.script.push({ message: "Thanks for your time today — everything is saved.", shouldEnd: true });
    h.script.push({ message: "What's the monthly rent under the lease?" });
    const r = await processTurn("deal-1", "sess-1", msg);
    assert.equal(h.systems.length, 2, "the intent re-call ran");
    assert.match(h.systems[0], /# CLOSING/);
    assert.doesNotMatch(h.systems[1], /# CLOSING/);
    assert.ok(h.logs.some((l) => /Intent re-call .*seller chose to continue/.test(l)));
    assert.equal(r.shouldEnd, false);
    assert.equal(r.message, "What's the monthly rent under the lease?");
  }

  // RV-INT-3 + PRIV-V-3 on a whole turn: a health business's everyday words
  // aren't banned later, and the seller's detail never reaches the log.
  {
    const h = installHarness(deal(), { messages: [...history] });
    const msg = "Honestly the real reason I'm selling is my health — I had a heart attack in March. Keep that out of the book.";
    h.intents.push({ privacyRequests: [{ what: "owner's health", detail: "The real reason for sale is the owner's heart attack in March", sensitiveTerms: ["heart attack", "health", "doctor"], fieldHint: "", remainingValue: "" }] });
    h.script.push({ message: "That stays with your broker. How is the clinic staffed?" });
    await processTurn("deal-1", "sess-1", msg);
    assert.deepEqual((h.sessions[0].extractedInfo as any)._keptPrivateTerms, ["heart attack"]);
    assert.deepEqual((h.deal.extractedInfo as any)._sellerKeepOut.map((e: any) => e.terms), [["heart attack"]]);
    h.intents.push({});
    h.script.push({
      message: "Who covers your caseload when a physio is away?",
      extractedFields: {
        staffingNotes: { value: "Healthcare staffing is tight; we employ 6 physios", confidence: "confirmed" },
        businessType: { value: "Allied health provider (physiotherapy)", confidence: "confirmed" },
      },
    });
    await processTurn("deal-1", "sess-1", "Healthcare staffing is tight; we employ 6 physios. We're an allied health provider.");
    const info = h.deal.extractedInfo as Record<string, any>;
    assert.equal(info.staffingNotes, "Healthcare staffing is tight; we employ 6 physios");
    assert.equal(info.businessType, "Allied health provider (physiotherapy)");
    // …while the detail itself stays out, on a later turn too.
    h.intents.push({});
    h.script.push({ message: "Noted. What's the rent?", extractedFields: { ownerHealth: { value: "Owner had a heart attack in March 2026", confidence: "confirmed" } } });
    await processTurn("deal-1", "sess-1", "Like I said, the heart attack is why.");
    assert.equal((h.deal.extractedInfo as any).ownerHealth, undefined);
    assert.equal(h.logs.some((l) => /heart attack/i.test(l)), false, `no detail in the log:\n${h.logs.filter((l) => /heart/i.test(l)).join("\n")}`);
  }
  // RV-INT-3 round 2 on whole turns: the live Clearwater terms ('MS') on a
  // physio deal whose services name MS — nothing is cut, the re-answer lands.
  {
    const h = installHarness(
      baseDeal({
        extractedInfo: {
          servicesOffered: "Orthopedic, sports and neuro rehab, including stroke, MS and Parkinson's programs",
          _fieldSources: { servicesOffered: { source: "interview", sessionId: "sess-0", turn: 2, at } },
        },
      }),
      { messages: [ai("What's behind the decision to sell now?")] },
    );
    h.intents.push({ privacyRequests: [{ what: "wife's illness", detail: "The owner is selling because his wife was diagnosed with MS", sensitiveTerms: ["MS", "multiple sclerosis", "diagnosed"], fieldHint: "", remainingValue: "" }] });
    h.script.push({ message: "That stays with your broker. How many physios work at each clinic?" });
    await processTurn("deal-1", "sess-1", "Honestly my wife was diagnosed with MS last spring, that's really why I'm selling. Please keep that out of the book.");
    const info = h.deal.extractedInfo as Record<string, any>;
    assert.match(info.servicesOffered, /stroke, MS and Parkinson/);
    assert.equal(info._brokerDeleted, undefined, "nothing was cut");
    h.intents.push({});
    h.script.push({ message: "What share of visits are neuro?", extractedFields: { neuroServices: { value: "Neuro programs for stroke, MS and Parkinson's patients", confidence: "confirmed" } } });
    await processTurn("deal-1", "sess-1", "We run neuro programs — stroke, MS and Parkinson's.");
    assert.equal((h.deal.extractedInfo as any).neuroServices, "Neuro programs for stroke, MS and Parkinson's patients");
    assert.equal(h.logs.some((l) => /Privacy guard/.test(l)), false);
  }
  ok("turns: a business 'no more questions' carries on; a pattern-only firm stop read as soft gets its closing question; 'ask away' after a closing turn is redone as a question; everyday words stay recordable; nothing private is logged");

  // keep-out.ts: a cached review never hides a request made since.
  {
    let calls = 0;
    _setKeepOutModelForTests({ messages: { create: async () => { calls++; return { content: [{ type: "tool_use", id: "x", name: "keep_out_review", input: { holds: [] } }] } as any; } } } as any);
    const info: Record<string, unknown> = {
      salesPipeline: "Shortlisted for the Kestrel Systems RFP, worth about $1.2M a year; decision Q1.",
      _fieldSources: { salesPipeline: { source: "document", documentId: "d1" } },
    };
    const before = await keepOutFor("deal-x", info);
    assert.deepEqual(before.names, []);
    info._sellerKeepOut = [{ detail: "Shortlisted for the Kestrel Systems RFP", terms: ["Kestrel"] }];
    const after = await keepOutFor("deal-x", info);
    assert.equal(calls, 1, "served from the cache");
    assert.ok(after.names.includes("Kestrel Systems"), "…with the new request held");
    _setKeepOutModelForTests(null);
  }
  ok("keep-out: the rules are re-read on a cache hit");

  process.stdout.write(`\n${n} groups passed\n`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
