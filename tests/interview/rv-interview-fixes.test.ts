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
  SELLER_KEEP_OUT_REASON,
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
  assert.ok(plan2.privateNotes.some((p) => /^pipeline: Three open bids/.test(p.note) && p.reason === SELLER_KEEP_OUT_REASON), "the held-back value is in the broker's notes");
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
    applyPartialEdits(info, plan.partialEdits);
    assert.equal(info.growthOpportunities, "Expansion into Red Deer.");
    assert.equal(info.salesPipeline, "decision expected in Q1.");
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
