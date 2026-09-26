// Seller intent — stop / wrap-up, withdrawal, correction, privacy request —
// and the date-fidelity guard, offline (QA round V). The instant patterns are
// held to the phrase corpus (tests/interview/seller-intent-corpus.data.ts);
// what the classifier's reading does to the facts is checked on pure plans
// and on whole turns through the offline harness. The classifier itself is
// evaluated live by tests/interview/seller-intent-live.ts.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/seller-intent.test.ts
import assert from "node:assert/strict";
import {
  quickIntent,
  combineIntent,
  parseIntent,
  planIntentEdits,
  applyPartialEdits,
  sellerSpokenFacts,
  privateDetailFromMessage,
  type SellerIntent,
} from "../../server/interview/seller-intent";
import {
  detectStopSignal,
  detectFirmStop,
  governCompletion,
  endReasonSaysSellerStop,
  buildStopSignalNudge,
  buildClosingAnswerNudge,
  scrubClosingPromises,
} from "../../server/interview/turn-guard";
import {
  detectRetraction,
  detectCorrection,
  detectPrivacyRequest,
  guessRetractedFields,
  removeClaim,
  applyDateFidelityGuard,
  tenseOf,
  clauseAround,
  relativeYearPhrases,
  resolveSeasonYear,
} from "../../server/interview/fact-guards";
import type { FieldChange } from "../../server/interview/info-merger";
import { STOP_FIRM, STOP_SOFT, STOP_PATTERN_MUST, BUSINESS, NEUTRAL, CORRECTIONS, RETRACTIONS, PRIVACY, CONTEXT } from "./seller-intent-corpus.data";
import { installHarness, baseDeal, ai, seller } from "./turn-harness";
import { processTurn } from "../../server/interview/session-manager";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };
const TODAY = new Date("2026-09-25T12:00:00Z");
const change = (fieldName: string, newValue: string, newConfidence = "confirmed", previousValue: string | null = null): FieldChange => ({
  fieldName, previousValue, previousConfidence: null, newValue, newConfidence, source: "seller_statement",
});
const modelIntent = (x: Partial<SellerIntent>): SellerIntent => ({
  stop: "none", continueRequest: false, sellerQuestion: "", retractions: [], corrections: [], privacyRequests: [], via: "model", ...x,
});

// ── 1. The instant stop patterns: precise, and they catch every clear stop ──
{
  for (const s of [...BUSINESS, ...NEUTRAL, ...CORRECTIONS.map((c) => c.message), ...RETRACTIONS.map((r) => r.message), ...PRIVACY.map((p) => p.message)]) {
    assert.equal(detectStopSignal(s), false, `not a stop: ${s}`);
    assert.equal(quickIntent(s).stop, "none", `quick: not a stop: ${s}`);
  }
  const missed = STOP_PATTERN_MUST.filter((s) => !detectStopSignal(s));
  assert.deepEqual(missed, [], "every clear stop is caught instantly");
  for (const s of STOP_FIRM) assert.equal(quickIntent(s).stop, "firm", `firm: ${s}`);
  for (const s of STOP_SOFT.filter((x) => STOP_PATTERN_MUST.includes(x))) assert.notEqual(quickIntent(s).stop, "none", s);
  for (const s of ["Customers stop asking for discounts once they see the warranty.", "The bank had no more questions about the line of credit."]) {
    assert.equal(detectFirmStop(s), false, s);
  }
  for (const c of CONTEXT) assert.equal(detectStopSignal(c.message, c.prevAi), c.stop, `${c.prevAi} → ${c.message}`);
  ok(`stop patterns: 0 of ${BUSINESS.length + NEUTRAL.length} business/neutral answers fire; all ${STOP_PATTERN_MUST.length} clear stops caught; ${STOP_FIRM.length} firm`);
}

// ── 2. Withdrawal vs correction vs privacy (patterns) ──
{
  for (const c of CORRECTIONS) {
    assert.equal(detectCorrection(c.message), true, `correction: ${c.message}`);
    assert.deepEqual(quickIntent(c.message).retractions, [], `a correction is not withdrawn: ${c.message}`);
  }
  for (const p of PRIVACY) {
    assert.equal(detectPrivacyRequest(p.message), true, `privacy: ${p.message}`);
    assert.equal(detectRetraction(p.message), false, `privacy is not a retraction: ${p.message}`);
    assert.deepEqual(quickIntent(p.message).retractions, []);
    assert.equal(quickIntent(p.message).privacyRequests.length, 1);
  }
  for (const r of RETRACTIONS) {
    assert.equal(detectCorrection(r.message), false, `withdrawal, not correction: ${r.message}`);
    assert.equal(quickIntent(r.message).retractions.length, 1, `withdrawal: ${r.message}`);
  }
  for (const s of [...BUSINESS, ...NEUTRAL]) {
    assert.equal(detectPrivacyRequest(s), false, `not privacy: ${s}`);
    assert.equal(quickIntent(s).retractions.length, 0, `not a withdrawal: ${s}`);
  }
  assert.equal(privateDetailFromMessage("Honestly the real reason is my wife's cancer diagnosis, but keep that out of the book."), "Honestly the real reason is my wife's cancer diagnosis");
  ok("patterns: corrections and privacy requests are never withdrawals; business sentences are neither");
}

// ── 3. Combining the classifier with the patterns ──
{
  const q = quickIntent("Please stop asking me questions.");
  assert.equal(combineIntent(q, modelIntent({ stop: "soft" })).stop, "firm", "the higher level wins");
  assert.equal(combineIntent(quickIntent("We stop at the bank on Fridays."), modelIntent({ stop: "none" })).stop, "none");
  assert.equal(combineIntent(quickIntent("My head's spinning. I need a coffee and a lie-down."), modelIntent({ stop: "soft" })).stop, "soft", "a stop the patterns missed");
  assert.equal(combineIntent(q, null).via, "patterns", "classifier down → the patterns decide");
  const parsed = parseIntent({ stop: "soft", continueRequest: false, sellerQuestion: "  is there one thing you need? ", retractions: [{ what: "40 trucks", fieldHint: "outboundLogistics", remainingValue: "x" }, { what: "" }], corrections: [{ old: "10", new: "12", fieldHint: "", correctedValue: "" }], privacyRequests: [{ what: "health", detail: "wife's diagnosis", sensitiveTerms: ["cancer", "x"], fieldHint: "", remainingValue: "" }] });
  assert.equal(parsed!.sellerQuestion, "is there one thing you need?");
  assert.equal(parsed!.retractions.length, 1);
  assert.equal(parsed!.corrections[0].fieldHint, undefined);
  assert.deepEqual(parsed!.privacyRequests[0].sensitiveTerms, ["cancer"]);
  assert.equal(parseIntent({ stop: "maybe" }), null);
  const view = {
    a: "old", b: "newer", c: "doc",
    _fieldSources: { a: { source: "interview", at: "2026-09-25T10:00:00Z" }, b: { source: "call", at: "2026-09-25T11:00:00Z" }, c: { source: "document" } },
  };
  assert.deepEqual(sellerSpokenFacts(view).map((f) => f.key), ["b", "a"], "only the seller's own words, newest first");
  ok("combine: the classifier reads the turn, a pattern stop stands, the higher stop level wins; parse is defensive");
}

// ── 4. What each intent does to the facts ──
{
  const src = (turn: number) => ({ source: "interview", sessionId: "s1", turn, at: `2026-09-25T10:0${turn}:00Z` });
  // (a) Correction — the model withdrew the key AND gave its new value: the new value stands.
  {
    const info = { leaseTerm: "10-year lease from 2021", _fieldSources: { leaseTerm: src(3) } };
    const plan = planIntentEdits({
      intent: modelIntent({ corrections: [{ old: "10", new: "12 years", fieldHint: "leaseTerm", correctedValue: "12-year lease from 2021" }] }),
      info, changes: [change("leaseTerm", "12-year lease from 2021", "confirmed", "10-year lease from 2021")],
      modelRetracted: [{ field: "leaseTerm", reason: "scratch that" }], modelPrivateNotes: [], sellerMessage: CORRECTIONS[0].message, sessionId: "s1", turn: 4,
    });
    assert.deepEqual(plan.retractions, []);
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0].newValue, "12-year lease from 2021");
    assert.deepEqual(plan.correctedKeys, ["leaseTerm"]);
  }
  // (b) Correction the interview model didn't record: the classifier's corrected value is written.
  {
    const info = { employeeCount: "12 full-time employees", _fieldSources: { employeeCount: src(2) } };
    const plan = planIntentEdits({
      intent: modelIntent({ corrections: [{ old: "12", new: "14 employees", fieldHint: "employeeCount", correctedValue: "14 full-time employees" }] }),
      info, changes: [], modelRetracted: [{ field: "employeeCount", reason: "misspoke" }], modelPrivateNotes: [], sellerMessage: CORRECTIONS[1].message, sessionId: "s1", turn: 3,
    });
    assert.deepEqual(plan.retractions, [], "the old value isn't withdrawn — it is replaced");
    assert.equal(plan.changes[0].fieldName, "employeeCount");
    assert.equal(plan.changes[0].newValue, "14 full-time employees");
    // …but never a "correction" that doesn't carry the new value.
    const bad = planIntentEdits({
      intent: modelIntent({ corrections: [{ old: "12", new: "14", fieldHint: "employeeCount", correctedValue: "about a dozen staff" }] }),
      info, changes: [], modelRetracted: [], modelPrivateNotes: [], sellerMessage: "", sessionId: "s1", turn: 3,
    });
    assert.equal(bad.changes.length, 0);
  }
  // (c) Withdrawal inside a mixed fact (Great Lakes): only the guessed part goes.
  {
    const value = RETRACTIONS[1].facts[0].value;
    const info = { outboundLogistics: value, shippingMethod: "LTL for small orders", _fieldSources: { outboundLogistics: src(5), shippingMethod: src(5) } };
    const intent = modelIntent({ retractions: [{ what: "~40 trucks", fieldHint: "outboundLogistics", remainingValue: "Contract hauler Buckeye Freight handles dedicated outbound lanes." }] });
    const plan = planIntentEdits({ intent, info, changes: [], modelRetracted: [{ field: "outboundLogistics", reason: "guess" }], modelPrivateNotes: [], sellerMessage: RETRACTIONS[1].message, sessionId: "s1", turn: 6 });
    assert.deepEqual(plan.retractions, [], "not the whole fact");
    assert.equal(plan.partialEdits.length, 1);
    assert.equal(plan.partialEdits[0].to, "Contract hauler Buckeye Freight handles dedicated outbound lanes.");
    const saved: Record<string, unknown> = { ...info };
    assert.deepEqual(applyPartialEdits(saved, plan.partialEdits), ["outboundLogistics"]);
    assert.doesNotMatch(String(saved.outboundLogistics), /40/);
    assert.equal(saved.shippingMethod, "LTL for small orders", "nothing unrelated touched");
    // A proposed rewrite that invents text or keeps the guess is not trusted —
    // the sentences carrying the claim are dropped instead.
    const mech = removeClaim(value, "~40 trucks", "Buckeye Freight runs all our trucks (about 40)");
    assert.match(mech!, /Buckeye Freight/);
    assert.doesNotMatch(mech!, /40/);
    // A fact changed meanwhile (a broker edit) is left alone.
    assert.deepEqual(applyPartialEdits({ outboundLogistics: "edited by the broker" }, plan.partialEdits), []);
    // No field hint: the seller's own facts holding the claim (latest turn).
    const plan2 = planIntentEdits({ intent: modelIntent({ retractions: [{ what: "40 trucks" }] }), info, changes: [], modelRetracted: [], modelPrivateNotes: [], sellerMessage: RETRACTIONS[1].message, sessionId: "s1", turn: 6 });
    assert.equal(plan2.partialEdits[0]?.key, "outboundLogistics");
    // The interview model rewrote the fact this turn without the guess: that stands.
    const clean = "Contract hauler Buckeye Freight handles dedicated outbound lanes; customer trucks pick up at the dock for JIT pulls.";
    const planClean = planIntentEdits({ intent, info, changes: [change("outboundLogistics", clean, "confirmed", value)], modelRetracted: [], modelPrivateNotes: [], sellerMessage: RETRACTIONS[1].message, sessionId: "s1", turn: 6 });
    assert.deepEqual(planClean.partialEdits, []);
    assert.deepEqual(planClean.retractions, []);
    assert.equal(planClean.changes[0].newValue, clean);
    // …or kept the guess in part: that part is cut from this turn's value.
    const planMixed = planIntentEdits({ intent, info, changes: [change("outboundLogistics", "Buckeye Freight handles outbound lanes. About 40 trucks a week pick up at the dock.", "confirmed", value)], modelRetracted: [], modelPrivateNotes: [], sellerMessage: RETRACTIONS[1].message, sessionId: "s1", turn: 6 });
    assert.equal(planMixed.changes[0].newValue, "Buckeye Freight handles outbound lanes.");
    // A withdrawn claim nothing on file holds is remembered, not guessed at.
    const plan3 = planIntentEdits({ intent: modelIntent({ retractions: [{ what: "the 12 forklifts" }] }), info, changes: [], modelRetracted: [], modelPrivateNotes: [], sellerMessage: "ignore what I said about 12 forklifts", sessionId: "s1", turn: 6 });
    assert.deepEqual(plan3.retractions, []);
    assert.deepEqual(plan3.partialEdits, []);
    assert.deepEqual(plan3.unrecordedWithdrawals, ["the 12 forklifts"]);
  }
  // (d) Whole withdrawal with a field hint; a document's fact is never withdrawn.
  {
    const info = {
      toolingOwnership: RETRACTIONS[0].facts[0].value, annualRevenue: "$62.4M",
      _fieldSources: { toolingOwnership: src(2), annualRevenue: { source: "document", documentId: "d1" } },
    };
    const plan = planIntentEdits({
      intent: modelIntent({ retractions: [{ what: "mold counts", fieldHint: "toolingOwnership", remainingValue: "" }, { what: "revenue", fieldHint: "annualRevenue", remainingValue: "" }] }),
      info, changes: [change("toolingOwnership", "15-18 molds owned")], modelRetracted: [], modelPrivateNotes: [], sellerMessage: RETRACTIONS[0].message, sessionId: "s1", turn: 3,
    });
    assert.deepEqual(plan.retractions.map((r) => r.field), ["toolingOwnership"]);
    assert.equal(plan.changes.length, 0, "the guess isn't re-recorded this turn");
  }
  // (e) Northbeam: "I misspoke — it's 9 trucks" never withdraws the unrelated headcount.
  {
    const info = { partTimeCount: "13 seasonal (Apr-Nov) plus 6 on-call", _fieldSources: { partTimeCount: src(1) } };
    const msg = CORRECTIONS[4].message;
    const byModel = planIntentEdits({ intent: modelIntent({ corrections: [{ old: "40 trucks", new: "9 trucks" }] }), info, changes: [], modelRetracted: [], modelPrivateNotes: [], sellerMessage: msg, sessionId: "s1", turn: 2 });
    assert.deepEqual(byModel.retractions, []);
    const byPatterns = planIntentEdits({ intent: quickIntent(msg), info, changes: [], modelRetracted: [], modelPrivateNotes: [], sellerMessage: msg, sessionId: "s1", turn: 2 });
    assert.deepEqual(byPatterns.retractions, [], "classifier down: still no withdrawal");
    assert.deepEqual(guessRetractedFields(info, msg, { sessionId: "s1", turn: 2 }), []);
  }
  // (f) Privacy: the health detail goes to the broker's notes; the reason for sale on file stays.
  {
    const info = { reasonForSale: "Retirement after 30 years", _fieldSources: { reasonForSale: src(4) } };
    const plan = planIntentEdits({
      intent: modelIntent({ privacyRequests: [{ what: "wife's health", detail: "The real reason for sale is his wife's cancer diagnosis", sensitiveTerms: ["cancer", "diagnosis"] }] }),
      info,
      changes: [change("reasonForSale", "Wife's cancer diagnosis; retiring", "confirmed", "Retirement after 30 years"), change("yearsOwned", "30 years")],
      modelRetracted: [{ field: "reasonForSale", reason: "keep it out of the book" }], modelPrivateNotes: [],
      sellerMessage: PRIVACY[0].message, sessionId: "s1", turn: 5,
    });
    assert.deepEqual(plan.retractions, [], "nothing withdrawn");
    assert.deepEqual(plan.changes.map((c) => c.fieldName), ["yearsOwned"], "the value carrying the detail never lands; others do");
    assert.equal(plan.privateNotes.length, 1);
    assert.match(plan.privateNotes[0].note, /cancer/);
    // A new fact keeps its public part; only the sentence with the detail goes.
    const planNew = planIntentEdits({
      intent: modelIntent({ privacyRequests: [{ what: "wife's health", detail: "wife's cancer diagnosis", sensitiveTerms: ["cancer"] }] }),
      info, changes: [change("ownerTransition", "Owner will stay 6 months for training. Wife's cancer diagnosis means he wants out by spring.")],
      modelRetracted: [], modelPrivateNotes: [], sellerMessage: PRIVACY[0].message, sessionId: "s1", turn: 5,
    });
    assert.equal(planNew.changes[0].newValue, "Owner will stay 6 months for training.");
    // A note the interview model already wrote isn't doubled.
    const plan2 = planIntentEdits({
      intent: modelIntent({ privacyRequests: [{ what: "health", detail: "wife's cancer diagnosis", sensitiveTerms: ["cancer"] }] }),
      info, changes: [], modelRetracted: [], modelPrivateNotes: [{ note: "Seller's wife has cancer — real reason for sale", reason: "private" }],
      sellerMessage: PRIVACY[0].message, sessionId: "s1", turn: 5,
    });
    assert.equal(plan2.privateNotes.length, 0);
    // A detail already on file moves out of the fact (the rest stays).
    const info3 = { reasonForSale: "Retiring; wife's cancer diagnosis", _fieldSources: { reasonForSale: src(4) } };
    const plan3 = planIntentEdits({
      intent: modelIntent({ privacyRequests: [{ what: "health", detail: "wife's cancer diagnosis", sensitiveTerms: ["cancer", "diagnosis"], fieldHint: "reasonForSale", remainingValue: "Retiring" }] }),
      info: info3, changes: [], modelRetracted: [], modelPrivateNotes: [], sellerMessage: "Keep the cancer part out of the book.", sessionId: "s1", turn: 6,
    });
    assert.equal(plan3.partialEdits[0].kind, "private");
    assert.equal(plan3.partialEdits[0].to, "Retiring");
    // Clearwater live: the classifier pointed at reasonForSale (the topic)
    // though the detail wasn't in it, and its rewrite dropped an unrelated
    // sentence — nothing on file may change.
    const rfs = "Owner retiring from management role after 17 years, age 51. Spouse Harjit also wants to retire. Owner wants to sell while business is growing rather than after decline.";
    const plan5 = planIntentEdits({
      intent: modelIntent({ privacyRequests: [{ what: "wife's health", detail: "Amrit's wife Harjit was diagnosed with MS last year; the real reason he wants to sell", sensitiveTerms: ["MS", "multiple sclerosis", "diagnosed"], fieldHint: "reasonForSale", remainingValue: "Owner retiring from management role after 17 years, age 51. Spouse Harjit also wants to retire." }] }),
      info: { reasonForSale: rfs, _fieldSources: { reasonForSale: { source: "document", documentId: "d" } } },
      changes: [], modelRetracted: [], modelPrivateNotes: [], sellerMessage: "…she was diagnosed with MS last year… Please keep that out of the book.", sessionId: "s1", turn: 5,
    });
    assert.deepEqual(plan5.partialEdits, [], "the reason for sale on file is untouched");
    assert.equal(plan5.privateNotes.length, 1);
    // …and a rewrite that loses a true sentence is never used, even where the detail is.
    assert.equal(
      removeClaim(`${rfs} Wife diagnosed with MS in 2025.`, "wife diagnosed with MS", "Owner retiring from management role after 17 years, age 51.", ["MS"], { termsOnly: true }),
      rfs,
    );
    assert.equal(removeClaim("Terms are net 30 for most accounts.", "MS diagnosis", null, ["MS"], { termsOnly: true }), null, "'MS' never matches 'terms'");
    // Classifier down: a note from the seller's own words; nothing withdrawn.
    const plan4 = planIntentEdits({ intent: quickIntent(PRIVACY[0].message), info, changes: [], modelRetracted: [{ field: "reasonForSale", reason: "keep out" }], modelPrivateNotes: [], sellerMessage: PRIVACY[0].message, sessionId: "s1", turn: 5 });
    assert.deepEqual(plan4.retractions, []);
    assert.match(plan4.privateNotes[0].note, /cancer diagnosis/);
  }
  ok("facts: a correction keeps the new value; a withdrawal takes out exactly the claim (also inside a mixed fact); a privacy request moves the detail to the broker and deletes nothing");
}

// ── 5. Stop nudges, closing promises, governance ──
{
  const soft = buildStopSignalNudge(1, ["reason_for_sale", "the seller's asking-price expectation"], ["asking price"], "soft");
  assert.match(soft, /ONE closing turn/);
  assert.match(soft, /reason_for_sale; the seller's asking-price expectation/);
  assert.match(soft, /GENUINELY open/);
  assert.match(soft, /answer it first/);
  assert.match(soft, /next time/);
  assert.match(soft, /Never name a topic the seller already declined \(asking price\)/);
  assert.match(soft, /never promise anything you can't do yourself/i);
  const firm = buildStopSignalNudge(1, ["reason for sale"], [], "firm");
  assert.match(firm, /Ask NOTHING/);
  assert.match(firm, /stop asking questions/);
  assert.match(buildStopSignalNudge(2, [], [], "soft"), /more than once/);
  assert.match(buildClosingAnswerNudge(), /ask NOTHING/);
  assert.equal(
    scrubClosingPromises("Thanks, Harjit. I'll follow up with Donna on the WIP report and I'll reach out to Devin about the bonding letter. Everything's saved."),
    "Thanks, Harjit. Your broker will follow up with Donna on the WIP report and your broker will reach out to Devin about the bonding letter. Everything's saved.",
  );
  assert.equal(scrubClosingPromises("We can pick up the lease next time."), "We can pick up the lease next time.");

  assert.equal(endReasonSaysSellerStop("Seller requested to stop"), true);
  assert.equal(endReasonSaysSellerStop("The seller wants to wrap up for today"), true);
  assert.equal(endReasonSaysSellerStop("All critical CIM sections are covered"), false);
  const base = { shouldEnd: true, endReason: "Seller asked to stop", sellerMessage: "My head's spinning, honestly.", userTurnCount: 4, sectionCoverage: [{ key: "overview", status: "missing" as const }], deferredTopics: [], minTurnsBeforeEnd: 10 };
  assert.equal(governCompletion({ ...base, intentStop: "unavailable" }).allowEnd, true, "classifier down: the model's endReason counts");
  assert.equal(governCompletion({ ...base, intentStop: "none" }).allowEnd, false, "the classifier said none: endReason alone doesn't end it");
  assert.equal(governCompletion({ ...base, intentStop: "stop", sellerStopDetected: true }).allowEnd, true);
  ok("stop: soft = one closing turn naming the open item; firm = goodbye now; goodbyes promise only the broker's follow-up; endReason corroborates only without a classifier verdict");
}

// ── 6. Dates: the month's own clause, later turns, relative years ──
{
  // Ridgeline: "sent it to collections in March, … we'll get most of it back" is a past March.
  const coldbrook = "The Coldbrook thirty-nine grand, that's a customer claiming late delivery. We sent it to collections in March, honestly I think we'll get most of it back, they're just being dinks about it.";
  const idx = coldbrook.indexOf("March");
  assert.equal(clauseAround(coldbrook, idx).trim(), "We sent it to collections in March");
  assert.equal(tenseOf(clauseAround(coldbrook, idx), "in", coldbrook), "past");
  const c1 = change("disputedHoldbacks", "Coldbrook $39K — customer claiming late delivery, sent to collections March 2025");
  applyDateFidelityGuard([c1], {}, { sellerMessage: coldbrook, today: TODAY });
  assert.match(c1.newValue, /March 2026/, c1.newValue);
  // A clause with its own verb that doesn't say — unknown, verified, never guessed from another clause.
  assert.equal(tenseOf("the move happens in March", "in", "The move happens in March, we'll see."), "unknown");
  assert.equal(tenseOf("In March", "in", "In March, we're moving the shop."), "future", "a bare time phrase takes the sentence's tense");
  // A value written a turn later from earlier context.
  const c2 = change("coldbrookDisputeStatus", "Sent to collections March 2025; expects to recover most of it");
  applyDateFidelityGuard([c2], {}, { sellerMessage: "Yeah, the agency is on it now.", sessionSellerMessages: ["Revenue is steady.", coldbrook], today: TODAY });
  assert.match(c2.newValue, /March 2026/, c2.newValue);
  assert.notEqual(c2.newConfidence, "confirmed");
  // …but a month the documents give with that year is grounded.
  const c3 = change("leaseSigned", "New lease signed March 2025");
  assert.equal(applyDateFidelityGuard([c3], {}, { sellerMessage: "Yes.", sessionSellerMessages: [coldbrook], onFileText: "Lease agreement dated March 2025", today: TODAY }).length, 0);
  // Two earlier Marches pointing at different years: verified, not corrected.
  const c4 = change("expansionPlan", "Expansion planned March 2027");
  const f4 = applyDateFidelityGuard([c4], {}, { sellerMessage: "Right.", sessionSellerMessages: [coldbrook, "We plan to open the second bay in March."], today: TODAY });
  assert.match(c4.newValue, /March 2027/);
  assert.equal(f4[0]?.needsVerification, true);
  // "This year" on 25 Sep 2026 is 2026 (Clearwater: "(current year, 2025)").
  assert.deepEqual(relativeYearPhrases("this year it's back over eight hundred thousand", TODAY).map((p) => p.year), [2026]);
  const c5 = change("setonRevenue2025", "Back over $800,000 (current year, 2025)");
  const conf5: Record<string, string> = { setonRevenue2025: "confirmed" };
  applyDateFidelityGuard([c5], conf5, { sellerMessage: "Seton had a rough 2024 but this year it's back over eight hundred thousand.", existingKeys: ["annualRevenue"], today: TODAY });
  assert.equal(c5.newValue, "Back over $800,000 (current year, 2026)");
  assert.equal(c5.fieldName, "setonRevenue2026", "the key follows the year");
  assert.equal(conf5.setonRevenue2026, "inferred");
  // An unlabelled year one off from "this year" is verified.
  const c6 = change("setonRevenue", "Seton back over $800,000 in 2025");
  const f6 = applyDateFidelityGuard([c6], {}, { sellerMessage: "this year it's back over eight hundred thousand", onFileText: "FY2025 revenue $2.1M", today: TODAY });
  assert.equal(f6[0]?.needsVerification, true);
  // Clearwater live: "(2025 year-to-date or projected)" for "this year", and
  // the year only in the key.
  const c6c = change("setonRevenue2025", "Over $800,000 (2025 year-to-date or projected)");
  applyDateFidelityGuard([c6c], {}, { sellerMessage: "Seton had a rough 2024, but this year it's back over eight hundred thousand.", prevAiMessage: "Speaking of Ethan: he left in October 2024. How many patients followed him?", today: TODAY });
  assert.equal(c6c.newValue, "Over $800,000 (2026 year-to-date or projected)");
  assert.equal(c6c.fieldName, "setonRevenue2026");
  const c6d = change("setonRevenue2025", "Back over $800,000");
  applyDateFidelityGuard([c6d], {}, { sellerMessage: "Seton had a rough 2024, but this year it's back over eight hundred thousand.", today: TODAY });
  assert.equal(c6d.fieldName, "setonRevenue2026");
  assert.equal(c6d.newConfidence, "inferred");
  // …unless the question named that year (Ridgeline live: "your 2024 owner
  // compensation?" → "…the Class D dividends that hit last year's return").
  const c6b = change("ownerCompensation", "$260,000 total (2024): $180,000 salary + $80,000 dividends");
  assert.equal(applyDateFidelityGuard([c6b], {}, { sellerMessage: "The T2 probably only counted $60K of the dividends that hit last year's return.", prevAiMessage: "I have two figures for your 2024 owner compensation — which is right?", today: TODAY }).length, 0);
  // "Last fall" in September 2026 is fall 2025; "last spring" is spring 2026.
  assert.equal(resolveSeasonYear("fall", "last", TODAY), 2025);
  assert.equal(resolveSeasonYear("spring", "last", TODAY), 2026);
  assert.equal(resolveSeasonYear("spring", "next", TODAY), 2027);
  const c7 = change("priceIncrease", "Raised prices in fall 2024, effective October 2024");
  applyDateFidelityGuard([c7], {}, { sellerMessage: "We raised prices last fall, effective October.", today: TODAY });
  assert.equal(c7.newValue, "Raised prices in fall 2025, effective October 2025");
  // Never invents a year: a clause that doesn't say → approximate + verify.
  const c8 = change("event", "Inspection March 2026");
  const f8 = applyDateFidelityGuard([c8], {}, { sellerMessage: "The inspection happens in March, and the inspector is fine with us.", today: TODAY });
  assert.equal(f8[0]?.needsVerification, true);
  assert.equal(c8.newConfidence, "approximate");
  ok("dates: the month's own clause sets the tense; later-turn values are checked against earlier messages; this/last year and seasons resolve from today; nothing is invented");
}

// ── 7. Whole turns (offline harness) ──
(async () => {
  const history = [
    ai("What's the lease term on the Hillhurst location?"),
    seller("It's a 10-year lease from 2021."),
    ai("Who holds the lease — you personally or the corporation?"),
  ];
  const leaseDeal = () => baseDeal({
    extractedInfo: {
      leaseTerm: "10-year lease from 2021",
      reasonForSale: "Retirement after 30 years",
      partTimeCount: "13 seasonal (Apr-Nov) plus 6 on-call",
      _fieldSources: {
        leaseTerm: { source: "interview", sessionId: "sess-1", turn: 1, at: "2026-09-25T10:00:00Z" },
        reasonForSale: { source: "interview", sessionId: "sess-1", turn: 1, at: "2026-09-25T10:00:00Z" },
        partTimeCount: { source: "interview", sessionId: "sess-1", turn: 1, at: "2026-09-25T10:00:00Z" },
      },
    },
  });

  // (a) "Please stop asking me questions." — firm: goodbye now, nothing asked.
  {
    const h = installHarness(leaseDeal(), { messages: [...history] });
    h.intents.push({ stop: "firm" });
    h.script.push({ message: "Of course. The one thing still open is your asking price — we can start there next time. What's your number?", shouldEnd: false });
    const r = await processTurn("deal-1", "sess-1", "Please stop asking me questions.");
    assert.equal(r.shouldEnd, true);
    assert.doesNotMatch(r.message, /\?/);
    assert.match(h.systems[0], /SELLER STOP — END NOW/);
    assert.equal(h.deal.interviewCompleted, true);
  }
  // (b) A stop only the classifier sees → the draft is redone with the stop instruction.
  {
    const h = installHarness(leaseDeal(), { messages: [...history] });
    const msg = "My head's spinning. I need a coffee and a lie-down.";
    assert.equal(detectStopSignal(msg), false);
    h.intents.push({ stop: "soft", sellerQuestion: "" });
    h.script.push({ message: "Who holds the lease day to day?" });
    h.script.push({ message: "Of course — before you go, the one thing I'd most like to pin down is your asking-price expectation. A rough number now, or shall we start there next time?" });
    const r = await processTurn("deal-1", "sess-1", msg);
    assert.equal(h.systems.length, 2, "one re-call");
    assert.doesNotMatch(h.systems[0], /THE SELLER WANTS TO STOP/);
    assert.match(h.systems[1], /THE SELLER WANTS TO STOP/);
    assert.match(r.message, /next time/);
    assert.equal((h.sessions[0].extractedInfo as any)._stopSignalCount, 1);
    // The answer to the closing turn ends it, whatever the model does.
    h.intents.push({ stop: "none" });
    h.script.push({ message: "Thanks! And what's the rent?", shouldEnd: false });
    const end = await processTurn("deal-1", "sess-1", "Next time is fine.");
    assert.equal(end.shouldEnd, true);
    assert.doesNotMatch(end.message, /\?/);
    assert.match(h.systems[2], /# CLOSING/);
  }
  // (c) "we can finish the install next week" is an answer — the model can't end on it.
  {
    const h = installHarness(leaseDeal(), { messages: [...history] });
    h.intents.push({ stop: "none" });
    h.script.push({ message: "Thanks for your time today.", shouldEnd: true, endReason: "Seller wants to stop" });
    h.script.push({ message: "How many crews do you run in peak season?" });
    const r = await processTurn("deal-1", "sess-1", BUSINESS[0]);
    assert.equal(r.shouldEnd, false);
    assert.equal(h.logs.some((l) => /Seller stop signal/.test(l)), false);
  }
  // (d) A correction: the new value stands; nothing is withdrawn.
  {
    const h = installHarness(leaseDeal(), { messages: [...history] });
    h.intents.push({ corrections: [{ old: "10", new: "12 years", fieldHint: "leaseTerm", correctedValue: "12-year lease from 2021" }] });
    h.script.push({ message: "What is the monthly rent under the new term?", extractedFields: { leaseTerm: { value: "12-year lease from 2021", confidence: "confirmed" } }, retractedFields: [{ field: "leaseTerm", reason: "scratch that" }] });
    await processTurn("deal-1", "sess-1", "Scratch that — the lease is 12 years, not 10.");
    const info = h.deal.extractedInfo as Record<string, any>;
    assert.equal(info.leaseTerm, "12-year lease from 2021");
    assert.equal(info._brokerDeleted?.leaseTerm, undefined);
    assert.equal(h.calls.some((c) => /The seller just withdrew something/.test(c)), false, "no retraction re-call");
    const ledger = (h.sessions[0].extractedInfo as any)._deferralLedger as any[];
    assert.equal(ledger.some((e) => /withdrew an estimate/.test(e.topic)), false);
  }
  // (e) A privacy request: private note, nothing deleted, nothing leaked.
  {
    const h = installHarness(leaseDeal(), { messages: [...history] });
    h.intents.push({ privacyRequests: [{ what: "wife's health", detail: "The real reason for sale is his wife's cancer diagnosis", sensitiveTerms: ["cancer", "diagnosis"], fieldHint: "", remainingValue: "" }] });
    h.script.push({
      message: "That stays with your broker only, never the sale document. What is the monthly rent on the unit?",
      extractedFields: { reasonForSale: { value: "Wife's cancer diagnosis", confidence: "confirmed" } },
      retractedFields: [{ field: "reasonForSale", reason: "keep it out" }],
    });
    await processTurn("deal-1", "sess-1", PRIVACY[0].message);
    const info = h.deal.extractedInfo as Record<string, any>;
    assert.equal(info.reasonForSale, "Retirement after 30 years", "the reason on file stays");
    assert.equal(info._brokerDeleted?.reasonForSale, undefined);
    assert.ok((info._brokerPrivateNotes as any[]).some((n) => /cancer/.test(n.note)), "the detail is with the broker");
    assert.deepEqual((h.sessions[0].extractedInfo as any)._keptPrivateTerms, ["cancer", "diagnosis"]);
    // A later turn can't write it into a fact.
    h.intents.push({});
    h.script.push({ message: "What's the rent?", extractedFields: { ownerCircumstances: { value: "Owner's wife is undergoing cancer treatment", confidence: "confirmed" } } });
    await processTurn("deal-1", "sess-1", "Yes, the corporation holds it.");
    assert.equal((h.deal.extractedInfo as any).ownerCircumstances, undefined);
  }
  // (f) Classifier down + a correction ("I misspoke — it's 9 trucks"): the unrelated headcount stays.
  {
    const h = installHarness(leaseDeal(), { messages: [...history] });
    h.script.push({ message: "How many of the 9 are pickups?", extractedFields: { fleetSize: { value: "9 trucks", confidence: "confirmed" } } });
    await processTurn("deal-1", "sess-1", CORRECTIONS[4].message);
    const info = h.deal.extractedInfo as Record<string, any>;
    assert.equal(info.partTimeCount, "13 seasonal (Apr-Nov) plus 6 on-call");
    assert.equal(info.fleetSize, "9 trucks");
    assert.equal(h.calls.some((c) => /The seller just withdrew something/.test(c)), false);
  }
  // (g) A goodbye's promises become the broker's.
  {
    const h = installHarness(leaseDeal(), { messages: [...history] });
    h.intents.push({ stop: "soft" });
    h.script.push({ message: "Of course, Harjit. I'll follow up with Donna on the WIP report. Everything's saved — pick this up anytime.", shouldEnd: true, endReason: "Seller asked to stop" });
    const r = await processTurn("deal-1", "sess-1", "Can we wrap up? I've got a crew waiting.");
    assert.match(r.message, /Your broker will follow up with Donna/);
  }
  ok("turns: firm stop ends with no question; a classifier-only stop re-calls with the stop instruction and the next answer ends; a business 'we can finish next week' can't end; corrections stand; privacy goes to the broker and stays out");
  process.stdout.write(`\n${n} groups passed\n`);
})().catch((err) => { process.stderr.write(`${err?.stack ?? err}\n`); process.exit(1); });
