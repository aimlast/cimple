// Round A, stream a-money-talk, round 2: the review of round 1 found the
// earnings hand-off, the add-back-list guard and the per-turn nudge firing
// on unrelated turns ("multiple times", "cash flow statement", "Maria takes
// home $85K", "that's personal, I'd rather not say"), add-back LIST keys
// mangled into expense facts, open items lost with a goodbye recap, and a
// reconciliation's second figure cut as a "verdict". Every case is either a
// recorded turn (the scratchpad corpus) or the reviewer's constructed probe,
// replayed through the real pure functions — no model calls.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/money-talk-r2.test.ts
import assert from "node:assert/strict";
import {
  sellerEarningsTalk,
  sellerRaisesAddbacks,
  sellerSideOf,
  ensureEarningsAcknowledged,
  candidateListStatements,
  earningsNudge,
  statementEarnings,
  handsOffEarnings,
} from "../../server/interview/money-talk";
import { addbackItemKey, guardNormalisationFields, removeNormalisationAssertions, NORMALISATION_HANDOFF } from "../../server/interview/reply-guards";
import { polishMessage, normalisationCallIn, type PolishContext } from "../../server/interview/reply-polish";
import { stripFillerPreamble, stripQuestionVerdicts, normalizeInterviewResponse } from "../../server/interview/turn-guard";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };
const TODAY = new Date("2026-09-26T12:00:00Z");
const NET_INCOME = { label: "net income", amount: 563190, shown: "$563,190", period: "FY2024", basis: "after tax" };
const ctxFor = (sellerMessage: string | null, extra: Partial<PolishContext> = {}): PolishContext => ({
  sellerMessage,
  jurisdiction: "CA",
  location: "Hamilton, ON",
  sellerText: sellerMessage ?? "",
  sellerUtterances: sellerMessage ? [sellerMessage] : [],
  facts: [],
  today: TODAY,
  priorAiText: "",
  statements: NET_INCOME,
  ...extra,
});

// ── 1. The earnings hand-off fires only on earnings talk ──
{
  // The reviewer's probes: none is an earnings question or an earnings claim.
  for (const said of [
    "Why do you keep asking me this? I've told you multiple times?",
    "We have multiple locations — do you need each lease?",
    "Is the multiple-unit discount a problem for buyers?",
    "Do you need the cash flow statement too?",
    "Should I send you the EBITDA breakdown by division?",
    "What's the number you have for our active patients?",
    "What's the number of techs you have on file?",
    "What's the number I should call if I have questions?",
    "Maria takes home about $85K. She's retiring with me.",
    "My shop foreman takes home about $95K a year. Is that enough detail?",
    "We clear about $60K in scrap metal sales each year.",
    "We net about $120K a month in the busy season.",
    "Maria's take-home is about $85K.",
    "Our bottom line took a hit in 2023 because of the cool summer.",
    // Recorded (i-privacy-ux run 2 #1): the seller asked which number the AI meant.
    "Listen, which number are we talking about here - you mean the EBITDA or something specific on the P&L? Just want to make sure I'm answering the right thing, you know what I mean? Honestly, Denise has all the line items to the penny, but I can tell you what's going on in the business.",
  ]) {
    assert.equal(sellerEarningsTalk(said), null, said);
    const r = polishMessage("How many techs hold the 313A?", ctxFor(said));
    assert.equal(r.message, "How many techs hold the 313A?", said);
    assert.equal(earningsNudge(said, NET_INCOME), null, `nudge: ${said}`);
  }
  // …while real earnings talk still gets the hand-off (the Lakeshore turns, and plain forms).
  for (const [said, claim] of [
    ["The business clears about a million and a half when you add everything back. Is that the SDE number Morgan's putting in the book or not?", 1.5e6],
    ["What multiple is she using?", null],
    ["Honestly we net around $600K a year.", 600_000],
    ["I take home about 400 grand, give or take.", 400_000],
    ["Our SDE is about $1.2M.", 1.2e6],
    ["It clears about $900K after I pay myself.", 900_000],
    ["What's the number?", null],
    ["What's the number going in the book?", null],
    // An earnings question that names a document is still an earnings question (only an offer isn't).
    ["I want to know which SDE is in the summary Morgan sent buyers?", null],
  ] as const) {
    const t = sellerEarningsTalk(said);
    assert.ok(t, said);
    assert.equal(t!.claim, claim, said);
    assert.ok(ensureEarningsAcknowledged("Who handles purchasing?", { sellerMessage: said }).added, said);
  }
  ok("the earnings hand-off: 'multiple times', 'cash flow statement', 'the number of techs', someone else's pay and one line's figure are not earnings talk");
}

// ── 2. An apology for a re-ask stays; nothing is held for a rewrite ──
{
  const cases: Array<[string, string]> = [
    ["I've told you multiple times, it's in the documents Denise sent.", "You're right — it's in the documents Denise sent, and I should have checked. How many of the techs are on salary versus hourly?"],
    ["I already gave you the cash flow statement, it's in the documents.", "You're right — the cash flow statement is in the documents Denise sent; I should have checked. What does the line of credit usually run at in winter?"],
  ];
  for (const [seller, reply] of cases) {
    assert.deepEqual(candidateListStatements(reply, seller), [], seller);
    assert.deepEqual(normalisationCallIn(reply, seller), [], "no corrective rewrite (latency, cost)");
    assert.equal(polishMessage(reply, ctxFor(seller)).message, reply, "the apology the never-re-ask rule asks for is kept");
  }
  // The recorded agreement to an add-back list is still caught (acc-int a2 T2).
  const S2 = "The twenty-eight thousand in owner vehicles — my RAM and Maria's Lexus lease, that's personal, that comes out. That's one-time, that's gone, that should absolutely be an add-back. Are you guys not working off the same sheet here?";
  const T2 = "You're right — those items are in the documents Denise sent, I should have had them in front of me. I'll make sure the owner vehicles ($28K), health and life insurance ($9K), discretionary meals ($11K), and the $22K legal settlement are all flagged for Morgan's add-back review. Who does the books?";
  assert.equal(candidateListStatements(T2, S2).length, 2);
  ok("'You're right — it's in the documents' after 'I've told you multiple times' is an apology, not an add-back agreement");
}

// ── 3. Add-back LIST keys are never turned into expense facts ──
{
  for (const key of ["addbacks2024", "addbackSummary", "additionalAddbacks", "addbacksByYear", "addbacksList", "sellerClaimedAddbacks", "oneTimeAddbacks", "addBackDetails", "addbackNotes", "addbackTotal", "addbacksSellerView", "ownerAddbacks", "sdeAddbacks"]) {
    assert.equal(addbackItemKey(key), null, key);
  }
  for (const [key, item] of [
    ["ownerVehicleAddback", "ownerVehicle"],
    ["discretionaryMealsAddback", "meals"],
    ["legalSettlementAddback", "legalSettlement"],
    ["healthLifeInsuranceAddback", "healthLifeInsurance"],
    ["addbackLegalFees", "legalFees"],
    ["personalTruckAddBack", "personalTruckExpense"],
    ["maria_salary_addback", "mariaSalary"],
  ] as const) assert.equal(addbackItemKey(key), item, key);
  // The reviewer's probe 3 (key shapes on Beacon, Harborview and the vf-facts dumps): kept under their own keys.
  const { response } = normalizeInterviewResponse({
    message: "Who keeps the books?",
    extractedFields: {
      addbacks2024: { value: "Management salary to shareholder $185,000, Amortization $72,740, Interest $11,361, Total key addbacks: $311,101", confidence: "confirmed", source: "seller_statement", basis: "verbatim" },
      additionalAddbacks: { value: "$38,000 for aborted Saint John acquisition in 2024, personal vehicle use $18,400 for 2024", confidence: "confirmed", source: "seller_statement", basis: "verbatim" },
      addbacksByYear: { value: "2024: $311K; 2023: $290K", confidence: "confirmed", source: "seller_statement", basis: "verbatim" },
    },
  });
  assert.deepEqual(Object.keys(response.extractedFields).sort(), ["addbacks2024", "addbacksByYear", "additionalAddbacks"]);
  assert.ok(!Object.keys(response.extractedFields).some((k) => /Expense$/.test(k)));
  // An item still becomes a neutral fact with the treatment in the broker's notes.
  const fields: Record<string, any> = { ownerVehicleAddback: { value: "$28,000 owner vehicles (add-back candidate)", confidence: "confirmed", basis: "verbatim" } };
  const notes: any[] = [];
  guardNormalisationFields(fields, notes);
  assert.deepEqual(Object.keys(fields), ["ownerVehicle"]);
  assert.equal(notes.length, 1);
  ok("add-back list keys (addbacks2024, additionalAddbacks, addbacksByYear…) stay the seller's list; only one named cost becomes a neutral fact");
}

// ── 4. The nudge reads 'comes out' and 'that's personal' in context ──
{
  for (const said of [
    "That's personal, I'd rather not say.",
    "It comes out to about 40 hours a week.",
    "The sign comes out of the window when we close.",
    "That's a personal decision for me and my wife.",
    "We've pegged normalized working capital at about $2.4M for the deal.",
  ]) {
    assert.equal(sellerRaisesAddbacks(said), false, said);
    assert.equal(earningsNudge(said, NET_INCOME), null, said);
  }
  for (const said of [
    "The twenty-eight thousand in owner vehicles — my RAM and Maria's Lexus lease, that's personal, that comes out.",
    "My dividends get added back too, right?",
    "The truck lease is personal, that should come out of the numbers.",
  ]) {
    assert.ok(sellerRaisesAddbacks(said), said);
    assert.ok(earningsNudge(said, NET_INCOME), said);
  }
  ok("the nudge: a privacy decline, 'comes out to 40 hours' and a sign in a window are not add-back talk");
}

// ── 5. A goodbye loses its recap, never the open item in the same sentence ──
{
  const cases: Array<[string, string]> = [
    [
      "We've covered the main areas, and the one thing still outstanding is the zoning letter from the city — Dana can send it to Morgan.",
      "The one thing still outstanding is the zoning letter from the city — Dana can send it to Morgan.",
    ],
    [
      "That covers everything I needed for now — your broker will follow up on the WSIB letters. Thanks for your time.",
      "Your broker will follow up on the WSIB letters. Thanks for your time.",
    ],
    ["You've given me what I need on the lease; the only open item is the landlord's consent letter.", "The only open item is the landlord's consent letter."],
    // Recorded (a1.json turn 24) still loses the recap.
    [
      "We've covered a lot of ground today — shift structure, equipment liens, the guarantees, non-compete terms, and how working capital moves through the year. The one area still open from earlier is the exact tooling list Rob keeps — if he can send that over to Morgan, it would fill in the last piece on mold ownership.",
      "The one area still open from earlier is the exact tooling list Rob keeps — if he can send that over to Morgan, it would fill in the last piece on mold ownership.",
    ],
  ];
  for (const [msg, want] of cases) assert.equal(stripFillerPreamble(msg, { closing: true }), want, msg);
  ok("a goodbye recap goes; 'the one thing still outstanding is the zoning letter' and 'your broker will follow up on the WSIB letters' stay");
}

// ── 6. A reconciliation keeps its second figure ──
{
  for (const m of [
    "Your P&L shows $1.2M in revenue for 2024, which is low compared to the $1.5M you mentioned — which figure is right?",
    "Wages were $1.9M in 2024, which is high relative to the 2023 figure of $1.4M — what drove the jump?",
    "The fleet list shows 24 vans, which is below the 26 you mentioned — which is current?",
  ]) assert.equal(stripQuestionVerdicts(m), m, m);
  // A year alone is not a second figure: the verdict still goes.
  assert.equal(stripQuestionVerdicts("Rent is $18,000 a month, which is high for 2024 — when does the lease renew?"), "Rent is $18,000 a month — when does the lease renew?");
  // A bare verdict still goes (the recorded Lakeshore opener).
  assert.equal(
    stripQuestionVerdicts("Your financials show $378,000 in vehicle expenses in 2024, which is on the higher side relative to revenue — is that driven by the fleet age?"),
    "Your financials show $378,000 in vehicle expenses in 2024 — is that driven by the fleet age?",
  );
  ok("'which is low compared to the $1.5M you mentioned' is the reconciliation, not a verdict");
}

// ── 7. The agreement-tail cut never leaves a question without its subject ──
{
  assert.equal(
    stripFillerPreamble("Your T4 summary shows 42 employees, which lines up with the roster. How many are seasonal?"),
    "Your T4 summary shows 42 employees. How many are seasonal?",
  );
  assert.match(stripFillerPreamble("The P&L shows $1.2M in wages, which matches the T4 summary. Is that all hourly staff?"), /^The P&L shows \$1\.2M in wages\b/);
  // The recorded Lakeshore T6 confirmation still goes whole: its question has its own subject.
  const T6 = "Quick clarification: the staff roster shows Sal starting in 2009, which would be about sixteen years — so that tracks. On the retention question for the other licensed techs beyond Dave and Sal: is there anything you'd put in place to keep them through a transition?";
  assert.ok(stripFillerPreamble(T6).startsWith("On the retention question"));
  ok("'…42 employees, which lines up with the roster. How many are seasonal?' keeps the 42 employees");
}

// ── 8. A continuation never stands alone; one hand-off per reply, beside the right sentence ──
{
  // Recorded (iknow pc-session #2): the cut clause came first — "Another mentions…" can't be kept.
  const pc =
    "On the addbacks side, I have two slightly different pictures: one shows Harjit's salary above a $120K replacement cost plus Surinder's full salary, and another mentions Harjit's full $285K with no replacement. Which framing is accurate for how the normalization should work?";
  const r = removeNormalisationAssertions(pc, "That's Harjit rounding down. Use 22% — that's what's in the financials.");
  assert.doesNotMatch(r.message, /^Another mentions/);
  assert.ok(r.removed.length > 0);
  // Recorded (i-privacy-ux run 3 #8): the reply already hands the figure to the broker — no second hand-off.
  const S = "What did Morgan's recast come out to for my SDE? I forget the exact number he told me.";
  const run3 =
    "I don't have the final recast figure in front of me — Morgan's still working through the normalization against your actual statements, so he'll walk you through that number directly. For a buyer, though, getting your key people onto simple agreements with non-solicits before close is usually a condition of any offer. Is that something you'd be open to doing during the sale process?";
  const p = polishMessage(run3, ctxFor(S)).message;
  const handoffs = p.split(/(?<=[.?!])\s+/).filter((x) => handsOffEarnings(x) || x.includes(NORMALISATION_HANDOFF));
  assert.ok(handoffs.length <= 1, p);
  // A cut question lead-in: the hand-off leads the paragraph, never between a statement and its question.
  const d = "The financials show a $60,000 due to shareholder. Since the truck is an add-back, is the loan something you'd settle at closing?";
  const out = removeNormalisationAssertions(d, "My salary gets added back, right? And the truck?").message;
  assert.equal(out, `${NORMALISATION_HANDOFF} The financials show a $60,000 due to shareholder. Is the loan something you'd settle at closing?`);
  // A named broker's own hand-off counts ("Morgan will confirm the final list").
  const m = removeNormalisationAssertions(
    "That's right, the $240K comes out as an add-back and so does the truck — Morgan will confirm the final list. How long has Maria been on payroll?",
    "My salary gets added back, right? And the truck?",
  ).message;
  assert.equal(m, "Morgan will confirm the final list. How long has Maria been on payroll?");
  ok("no 'Another mentions…' left alone; one hand-off per reply, at the head of the question's paragraph");
}

// ── 9. The statements' figure: the nearest reported line, named as reported ──
{
  // The Lakeshore facts (acc-int lk-base-info.txt).
  const info = {
    ebitda: "$917,000 reported EBITDA (FY2024); FY2023 $793,000; FY2022 $644,000",
    netIncome: "$563,190 after tax (FY2024); FY2023 $482,930; FY2022 $386,174",
    sde: "$1,312,000 (FY2024: adjusted EBITDA $917,000 + owner add-backs $395,000)",
    adjustedEbitda: "$1,100,000 adjusted",
  };
  const s = statementEarnings(info, (k) => (k === "sde" ? "broker" : "document"));
  assert.deepEqual(s, { label: "EBITDA", amount: 917_000, shown: "$917,000", period: "FY2024", basis: null });
  // Never a normalised value, even filed from a document.
  assert.equal(statementEarnings({ ebitda: "$1.1M adjusted EBITDA (FY2024)" }, () => "document"), null);
  const S3 = "Honestly, the business clears about a million and a half when you add everything back.";
  const first = ensureEarningsAcknowledged("Which number is right — 24 or 26 vans?", { sellerMessage: S3, statements: s });
  assert.match(first.message, /^On the \$1\.5M: .* For reference, the FY2024 statements on file report EBITDA of \$917,000, before any adjustments\.\n\n/);
  // Asked again (and again): answered each time, in other words.
  const ask = "Is that the number going in the book?";
  const a2 = ensureEarningsAcknowledged("Who runs dispatch?", { sellerMessage: ask, priorAiText: first.message, statements: s }).message;
  const a3 = ensureEarningsAcknowledged("Who runs dispatch?", { sellerMessage: ask, priorAiText: `${first.message}\n${a2}`, statements: s }).message;
  const lead = (x: string) => x.split("\n\n")[0];
  assert.notEqual(lead(a2), lead(first.message).split(" For reference")[0]);
  assert.notEqual(lead(a3), lead(a2));
  for (const x of [a2, a3]) assert.ok(handsOffEarnings(lead(x)), x);
  ok("the statements note uses reported EBITDA before net income, says 'before any adjustments', and a repeat question gets new words");
}

// ── 10. Broker-led ('together') sessions: the broker's own lines raise nothing ──
{
  const exchange = "Broker: So your SDE is about $1.2M after the add-backs.\nSeller: Yeah, sounds right. The trucks are all leased through Ford Credit.";
  assert.equal(sellerSideOf(exchange), "Yeah, sounds right. The trucks are all leased through Ford Credit.");
  assert.equal(sellerEarningsTalk(exchange), null);
  assert.equal(sellerRaisesAddbacks(exchange), false);
  assert.equal(earningsNudge(exchange, NET_INCOME), null);
  const card = "When do the Ford leases end?";
  assert.equal(polishMessage(card, ctxFor(exchange)).message, card);
  // The seller's own line raising it: in together mode the broker answers it — no hand-off line on the card.
  const sellerAsks = "Broker: What do the leases run?\nSeller: About $4K a month each. What's the SDE going in the book?";
  assert.ok(sellerEarningsTalk(sellerAsks)?.asked);
  assert.equal(polishMessage(card, ctxFor(sellerAsks, { together: true })).message, card);
  assert.doesNotMatch(
    polishMessage("Your salary of $240K is an add-back. When do the Ford leases end?", ctxFor("Seller: My salary gets added back, right?", { together: true })).message,
    /add-back|Your broker will/,
  );
  const nudge = earningsNudge(sellerAsks, NET_INCOME, { together: true })!;
  assert.match(nudge, /The broker is in the room/);
  assert.doesNotMatch(nudge, /walk them through/);
  // Unlabelled speakers (nobody identified yet): every line counts.
  assert.ok(sellerEarningsTalk("Speaker 1: What leases?\nSpeaker 2: What's the SDE going in the book?")?.asked);
  ok("together mode: the broker's 'your SDE is about $1.2M' raises nothing; the seller's own question gets no hand-off on the broker's card");
}

process.stdout.write(`\n${n} groups passed\n`);
