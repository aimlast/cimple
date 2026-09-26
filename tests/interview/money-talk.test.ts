// Round A, stream a-money-talk: earnings, SDE and add-backs in the seller
// conversation, the guard rewrite that showed broken text, the date guard
// that misdated a settlement, closing recaps, and correction notes in facts.
// Every case replays the recorded model output from the live acceptance test
// (SCR/harvest/acc-int/a1-a3.json, /tmp/acc1-server.log) — no model calls.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/money-talk.test.ts
import assert from "node:assert/strict";
import {
  candidateListStatements,
  sellerEarningsTalk,
  ensureEarningsAcknowledged,
  handsOffEarnings,
  statementEarnings,
  earningsNudge,
  moneyAmounts,
  formatMoney,
  GENERIC_ADDBACK_HANDOFF,
} from "../../server/interview/money-talk";
import {
  removeNormalisationAssertions,
  findNormalisationAssertions,
  assertsNormalisation,
  guardNormalisationFields,
  addbackItemKey,
  NORMALISATION_HANDOFF,
} from "../../server/interview/reply-guards";
import { polishMessage, normalisationCallIn, type PolishContext } from "../../server/interview/reply-polish";
import { stripFillerPreamble, normalizeInterviewResponse, stripQuestionVerdicts } from "../../server/interview/turn-guard";
import { applyDateFidelityGuard } from "../../server/interview/fact-guards";
import type { FieldChange } from "../../server/interview/info-merger";
import { stripCorrectionNotes } from "../../server/interview/value-hygiene";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };
const TODAY = new Date("2026-09-26T12:00:00Z");

// ── The recorded Lakeshore turns (acc-int/a2.json) ──
const S1 =
  "Yeah, listen, it's a combination. Fuel's a big part — we put serious kilometres on those trucks, you know what I mean? Twenty-four vans running all over Hamilton, Burlington, out to Oakville sometimes, that adds up fast.\n\nNow, before we keep going — I want to know what Morgan's actually using for the add-backs and what SDE number did she come up with for 2024? Because I've got my own ideas, but I want to see what you guys are working with. What's the actual number?";
const T1 =
  "The SDE calculation is something Morgan finalizes directly with the financials — I don't have her working number to share, and honestly that's the right conversation to have with her since she's the one who'll defend it to buyers. What I can help with is making sure we've captured the items that typically get considered. From what's on file: your $240K management salary, Maria's $85K, the $38K in vehicle loan interest, and the $214K in amortization. Are there other expenses in 2024 that were one-time or discretionary — things that wouldn't recur for a new owner?";
const S2 =
  "Okay, fair enough — yeah, I'll nail that down with Morgan. But listen, you're missing stuff. The twenty-eight thousand in owner vehicles — my RAM and Maria's Lexus lease, that's personal, that comes out. The health and life insurance premiums for me and Maria, that's another nine grand. Meals and entertainment, honestly half of that is me taking suppliers out or the Tiger-Cats box, call it eleven thousand discretionary. \n\nAnd here's a big one you didn't mention — we had a former employee, wrongful dismissal thing, settled it in July, cost us twenty-two thousand in legal fees that's buried in professional fees. That's one-time, that's gone, that should absolutely be an add-back.\n\nSo you've got the salaries, the vehicles, the insurance, the meals, the legal — that's way more than just amortization and interest. Denise has all this broken out, she gave it to Morgan. Are you guys not working off the same sheet here?";
// The T2 draft, reconstructed from the log ("add-back call removed ('I'll make sure the owner vehicles ($28K), …')").
const T2_DRAFT =
  "You're right — those items are in the documents Denise sent, I should have had them in front of me. I'll make sure the owner vehicles ($28K), health and life insurance ($9K), discretionary meals ($11K), and the $22K legal settlement are all flagged for Morgan's add-back review.\n\nOne quick item while we're on housekeeping: the financials show a $60,000 due to shareholder that's been sitting there with no fixed repayment terms. Is that something you'd expect to settle at closing, or would it stay on the books for the buyer to assume?";
// What the seller was actually shown (the broken rewrite).
const T2_SHOWN =
  "You're right — those items are in the documents Denise sent, I should have had them in front of me. I'll make sure the owner vehicles ($28K), health and life insurance ($9K), discretionary meals ($11K).\n\nOne quick item while we're on housekeeping: the financials show a $60,000 due to shareholder that's been sitting there with no fixed repayment terms. Your broker will confirm what gets added back when they normalize the numbers against your statements. Is that something you'd expect to settle at closing, or would it stay on the books for the buyer to assume?";
const S3 =
  "Whoa, hold on — that sixty thousand, that's mine, that's money I lent the company years ago. That gets paid out to me at closing, no question.\n\nHonestly, I don't want any of this nickel-and-dime stuff scaring off a buyer — the business clears about a million and a half when you add everything back, we've got twenty-six trucks on the road, twenty-nine hundred members paying every month, and I'm here for six months full-time to make sure it goes smooth. At the end of the day, that's what matters, right?";
const T3 = "One quick clarification: you mentioned twenty-six trucks on the road, but the fleet list Denise sent shows 24 service vans plus your two personal vehicles that are excluded from the sale. Which number is right — are there 24 or 26 service vans actually running routes?";
const S6 = "Nobody's said a word about leaving. Dave's the one I'd watch, honestly, he's hinted he wants a piece of it. Sal's been with me sixteen years, he's not going anywhere. But listen, at the end of the day this business clears about a million and a half a year, you know what I mean? Is that the number going in the book?";
const T6 = "Quick clarification: the staff roster shows Sal starting in 2009, which would be about sixteen years — so that tracks. On the retention question for the other licensed techs beyond Dave and Sal: is there anything you'd put in place to keep them through a transition — any retention bonuses or commitments you'd expect a buyer to offer?";
const S7 =
  "Listen, I already answered the retention thing — nobody's said they're leaving, Dave wants in, Sal's solid.\n\nNow seriously — you keep dodging my question. The business clears about a million and a half when you add everything back. Is that the SDE number Morgan's putting in the book or not? Because if we're gonna list this thing at four-eight, I need to know what multiple she's using and what she's telling buyers the cash flow is. You're the one building the book, right? So what's the number?";
const T7 = "Let me ask about something else on the licensing side: besides you and Dave as the G1 certificate holders on the TSSA registration, who are the other master licence holders across the business — anyone else whose name appears on a company registration or who holds a licence the business operates under?";
const S8 = "So bottom line: me and Dave on the TSSA, that's it.\n\nNow are you gonna tell me what SDE Morgan's using or do I need to call her after this?";

const STATEMENTS = { label: "net income", amount: 563190, shown: "$563,190", period: "FY2024", basis: "after tax" };
const ctxFor = (sellerMessage: string | null, priorAiText = ""): PolishContext => ({
  sellerMessage,
  jurisdiction: "CA",
  location: "Hamilton, ON",
  sellerText: sellerMessage ?? "",
  sellerUtterances: sellerMessage ? [sellerMessage] : [],
  facts: [],
  today: TODAY,
  priorAiText,
  statements: STATEMENTS,
});
/** Every sentence ends properly and no hand-off sits inside another paragraph's statement-and-question. */
const wellFormed = (text: string) => {
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    assert.match(p, /[.?!]["')]?$/, `paragraph ends a sentence: «${p}»`);
    // No list left hanging: "…, discretionary meals ($11K)." with no verb after the list.
    assert.doesNotMatch(p, /\([^)]*\$\d[^)]*\),\s[^.?!]*\(\$\d[^)]*\)\./, `no truncated list: «${p}»`);
  }
};

// ── ACC-INT-2: the add-back list the interviewer built, and its agreement to the seller's ──
{
  const t1 = candidateListStatements(T1, S1);
  assert.deepEqual(t1, [
    "What I can help with is making sure we've captured the items that typically get considered.",
    "From what's on file: your $240K management salary, Maria's $85K, the $38K in vehicle loan interest, and the $214K in amortization.",
  ]);
  assert.equal(findNormalisationAssertions(T1, S1).length, 2, "the stream gate / output guard sees the list");
  assert.equal(normalisationCallIn(T1, S1).length, 2, "…so the draft gets the corrective rewrite");
  const r1 = removeNormalisationAssertions(T1, S1);
  assert.doesNotMatch(r1.message, /\$240K|\$85K|\$38K|\$214K|typically get considered/);
  assert.match(r1.message, /Are there any expenses in 2024 that were one-time or discretionary/, "'other' no longer points at a removed list");
  assert.match(r1.message, new RegExp(`${NORMALISATION_HANDOFF.replace(/[.]/g, "\\.")} Are there any expenses`));
  wellFormed(r1.message);

  const t2 = candidateListStatements(T2_DRAFT, S2);
  assert.equal(t2.length, 2, "agreement ('You're right — those items are in the documents') and the promise ('I'll make sure … ($28K) …') both count");
  const r2 = removeNormalisationAssertions(T2_DRAFT, S2);
  assert.equal(
    r2.message,
    `${NORMALISATION_HANDOFF}\n\nOne quick item while we're on housekeeping: the financials show a $60,000 due to shareholder that's been sitting there with no fixed repayment terms. Is that something you'd expect to settle at closing, or would it stay on the books for the buyer to assume?`,
  );
  // Without the seller's message (the add-back vocabulary alone): the promise still goes WHOLE, never cut mid-list.
  const r2b = removeNormalisationAssertions("I'll make sure the owner vehicles ($28K), health and life insurance ($9K), discretionary meals ($11K), and the $22K legal settlement are all flagged for Morgan's add-back review. Who does the books?");
  assert.equal(r2b.message, "Who does the books?");
  // …while a clause that is a sentence on its own is still kept.
  assert.equal(removeNormalisationAssertions("Your T2 shows $180K in salary; we'll show it as an add-back. Who does the books?").message, "Your T2 shows $180K in salary. Who does the books?");
  assert.equal(removeNormalisationAssertions("Your P&L shows $180K in salary, which is an add-back. Who does the books?").message, "Your P&L shows $180K in salary. Who does the books?");
  // A clause left without a verb is not a sentence (round V corpus: "…the recast includes roughly $70,000 in
  // other owner-related items — your personal vehicles, meals, insurance, and the one-time legal settlement.").
  const lk16 = removeNormalisationAssertions(
    "One quick follow-up on the add-backs: beyond those two salaries, the recast includes roughly $70,000 in other owner-related items — your personal vehicles, meals, insurance, and the one-time legal settlement. Does Maria plan to stay on?",
    "Whoever buys this, that eighty-five comes right off the top as an add-back. That's already in your numbers, right?",
  );
  assert.equal(lk16.message, `${NORMALISATION_HANDOFF} Does Maria plan to stay on?`);
  // …while a reported figure beside the call stays (seeding corpus, Harborview).
  assert.equal(
    removeNormalisationAssertions("Stepping back: your 2024 EBITDA was around $1.2 million, and with the owner comp add-backs you're showing adjusted EBITDA closer to $1.35 million. Anything one-time in 2024?").message,
    "Stepping back: your 2024 EBITDA was around $1.2 million. Anything one-time in 2024?",
  );
  // Not lists: a question about one-time costs, figures with no add-back context, a note for the broker.
  for (const [msg, s] of [
    ["Are there any one-time costs in 2024 — legal, a big repair — that a buyer wouldn't carry going forward?", S1],
    ["Your P&L shows $240K in management salary and $85K for Maria. What does Maria do day to day?", "Maria runs dispatch."],
    ["I'll pass those to your broker. Who handles purchasing?", S2],
    ["The lease is $12,000 a month plus $3,000 CAM. When does it renew?", S1],
  ] as const) assert.deepEqual(candidateListStatements(msg, s), [], msg);
  ok("ACC-INT-2: the interviewer's own add-back list and its agreement to the seller's are caught and removed");
}

// ── ACC-INT-2: what the turn RECORDS — one item filed as an add-back ──
{
  const fields: Record<string, any> = {
    ownerVehicleAddback: { value: "$28,000 — owner's RAM 1500 and Maria's Lexus lease, personal use (add-back candidate)", confidence: "confirmed", basis: "verbatim" },
    healthLifeInsuranceAddback: { value: "$9,000 health and life insurance premiums for Tony and Maria (add-back candidate)", confidence: "confirmed", basis: "verbatim" },
    discretionaryMealsAddback: { value: "$11,000 discretionary meals and entertainment (Tiger-Cats box, supplier meals) — add-back candidate", confidence: "confirmed", basis: "verbatim" },
    legalSettlementAddback: { value: "$22,000 one-time legal fees for wrongful dismissal settlement (July 2024); seller says it should be an add-back", confidence: "confirmed", basis: "verbatim" },
    addbacks: { value: "Owner salary $240K; truck $28K", confidence: "confirmed", basis: "verbatim" },
  };
  const notes: any[] = [];
  guardNormalisationFields(fields, notes);
  assert.deepEqual(Object.keys(fields).sort(), ["addbacks", "healthLifeInsurance", "legalSettlement", "meals", "ownerVehicle"]);
  assert.equal(fields.ownerVehicle.value, "$28,000 — owner's RAM 1500 and Maria's Lexus lease, personal use");
  assert.equal(fields.legalSettlement.value, "$22,000 one-time legal fees for wrongful dismissal settlement (July 2024)");
  assert.doesNotMatch(JSON.stringify(Object.values(fields).slice(0, 4)), /add-?back/i);
  assert.equal(notes.length, 4);
  assert.ok(notes.every((x) => /counts this as an add-back/.test(x.note)));
  assert.equal(fields.addbacks.value, "Owner salary $240K; truck $28K", "a whole add-back list stays the seller's list, as before");
  assert.equal(addbackItemKey("ownerAddbacks"), null);
  assert.equal(addbackItemKey("sdeAddbacks"), null);
  assert.equal(addbackItemKey("addbackLegalFees"), "legalFees");
  assert.equal(addbackItemKey("personalTruckAddBack"), "personalTruckExpense");
  ok("ACC-INT-2: an item filed as an add-back is kept as the seller's fact under its own name; the treatment goes to the broker");
}

// ── ACC-INT-3: never broken text — the recorded fallback, replayed ──
{
  // The polish pass on the recorded draft (what the fallback shows when the rewrite still makes the call).
  const out = polishMessage(T2_DRAFT, ctxFor(S2)).message;
  wellFormed(out);
  assert.doesNotMatch(out, /discretionary meals \(\$11K\)\./, "the truncated list is gone");
  assert.doesNotMatch(out, /statements\. Is that something/, "the hand-off isn't spliced in front of another paragraph's question");
  assert.match(out, /^Your broker will confirm what gets added back/);
  assert.equal(polishMessage(T2_DRAFT, ctxFor(S2)).message, out, "deterministic: the stream gate and the final pass agree");
  // A reply already broken that way (stored before this fix) is not made worse on resume: the fragment goes.
  const again = polishMessage(T2_SHOWN, ctxFor(S2)).message;
  assert.doesNotMatch(again, /I'll make sure the owner vehicles/);
  ok("ACC-INT-3: a removed call takes its whole sentence; the hand-off stands alone where the call was");
}

// ── ACC-INT-4: the earnings question is answered, every time it is asked ──
{
  assert.deepEqual(sellerEarningsTalk(S3), { asked: false, aboutFigure: true, claim: 1.5e6, term: null });
  assert.deepEqual(sellerEarningsTalk(S6), { asked: true, aboutFigure: true, claim: 1.5e6, term: null });
  assert.equal(sellerEarningsTalk(S7)?.asked, true);
  assert.deepEqual(sellerEarningsTalk(S8), { asked: true, aboutFigure: true, claim: null, term: "SDE" });
  assert.equal(sellerEarningsTalk("We did $7.4 million in revenue last year and my salary is $240K."), null);
  assert.equal(sellerEarningsTalk("Is my $240K salary an add-back?")?.aboutFigure, false, "an item's treatment is not the earnings figure");
  assert.equal(sellerEarningsTalk("Denise adds all that back when she shows the real cash flow, you know what I mean?"), null, "a tag is not a question");
  // What counts as the owner stating earnings: the cue leads straight into the figure.
  for (const [said, figure] of [
    ["Our SDE is about $1.2M.", 1.2e6],
    ["Honestly we net around $600K a year.", 600_000],
    ["EBITDA was $917,000 last year.", 917_000],
    ["I take home about 400 grand, give or take.", 400_000],
  ] as const) assert.equal(sellerEarningsTalk(said)?.claim, figure, said);
  // Seeding corpus: none of these is an earnings claim.
  for (const said of [
    "They need replacing over the next 12–18 months, call it ~$1.4M net of trade-ins.",
    "The payoff's about $5.1 million as of the end of March, and yeah, that all gets cleared at closing.",
    "Recurring is 72% of the $6.2 million in revenue, but it's more like 79 or 80% of gross profit because projects run at maybe 35% margin.",
    "That's the $96,800 add-back in the 2023 financials, net of insurance.",
  ]) assert.equal(sellerEarningsTalk(said), null, said);
  assert.deepEqual(moneyAmounts("about a million and a half"), [1.5e6]);
  assert.ok(moneyAmounts("six hundred grand").includes(600_000));
  assert.equal(formatMoney(1.5e6), "$1.5M");
  assert.equal(formatMoney(1_000_001), "$1M");
  assert.equal(formatMoney(1.25e6), "$1.25M");
  assert.equal(formatMoney(640_000), "$640K");

  // T3 (the first time the seller states it): the fleet probe stays, the claim is acknowledged, the statements noted.
  const t3 = polishMessage(T3, ctxFor(S3, T1)).message;
  assert.match(t3, /^On the \$1\.5M: the earnings figure that goes in the book is your broker's to walk you through, against your statements\. For reference, the FY2024 financials on file show net income of \$563,190 \(after tax\)\.\n\nOne quick clarification: [^\n]*twenty-six trucks on the road, but the fleet list Denise sent shows 24 service vans/);
  // T6: asked — the "so that tracks" confirmation goes, the hand-off is first; the statements aren't repeated once shown.
  const shownBefore = `${T1}\n${t3}`;
  const t6 = polishMessage(T6, ctxFor(S6, shownBefore)).message;
  assert.doesNotMatch(t6, /so that tracks|Quick clarification/);
  assert.match(t6, /^On the \$1\.5M: the earnings figure that goes in the book is your broker's to walk you through, against your statements\.\n\nOn the retention question/);
  assert.doesNotMatch(t6, /For reference/, "the statements' figure is noted once");
  // T7 and T8: asked again → answered again.
  const t7 = polishMessage(T7, ctxFor(S7, shownBefore)).message;
  assert.match(t7, /^On the \$1\.5M: the earnings figure that goes in the book is your broker's to walk you through/);
  const t8 = polishMessage("Could Denise send over a breakdown showing each tech's name alongside their certifications?", ctxFor(S8, shownBefore)).message;
  assert.match(t8, /^On the SDE question: the earnings figure that goes in the book is your broker's to walk you through/);
  // Never an add-back call: the inserted lines pass the add-back guard, and it is idempotent.
  for (const [t, s] of [[t3, S3], [t6, S6], [t7, S7], [t8, S8]]) {
    assert.deepEqual(findNormalisationAssertions(t, s), [], t);
    assert.equal(polishMessage(t, ctxFor(s, shownBefore)).message, t, "a reply that already hands it off is left alone");
  }
  // A reply that answers it in its own words is left alone.
  const own = "That's a question for Morgan — she'll walk you through the SDE figure and what's added back against your statements. Who else holds a licence the business operates under?";
  assert.ok(handsOffEarnings(own));
  assert.equal(ensureEarningsAcknowledged(own, { sellerMessage: S7, statements: STATEMENTS }).added, false);
  // The generic add-back line answers "what's added back", not "is that the number": replaced for a figure question…
  const generic = `${NORMALISATION_HANDOFF} Who does the books?`;
  assert.match(ensureEarningsAcknowledged(generic, { sellerMessage: S8 }).message, /^On the SDE question: .*\n\nWho does the books\?$/);
  // …and kept for a question about an item's treatment.
  assert.equal(ensureEarningsAcknowledged(generic, { sellerMessage: "My dividends get added back too, right?" }).added, false);
  assert.equal(GENERIC_ADDBACK_HANDOFF, NORMALISATION_HANDOFF);
  // A claim already acknowledged isn't acknowledged again when merely restated; a new question always is.
  assert.equal(ensureEarningsAcknowledged(T3, { sellerMessage: S3, priorAiText: t3, statements: STATEMENTS }).added, false);
  // No note when the statements agree with the seller's figure, or when there are none.
  assert.doesNotMatch(ensureEarningsAcknowledged(T3, { sellerMessage: S3, statements: { ...STATEMENTS, amount: 1_480_000, shown: "$1,480,000" } }).message, /For reference/);
  assert.doesNotMatch(ensureEarningsAcknowledged(T3, { sellerMessage: S3, statements: null }).message, /For reference/);
  // Nothing to do on other turns, and never on the opening.
  assert.doesNotMatch(polishMessage(T3, ctxFor("Twenty-four vans, you're right.")).message, /earnings figure|For reference/);
  assert.doesNotMatch(polishMessage(T7, ctxFor(S7), { opening: true }).message, /earnings figure|For reference/);

  // The nudge the model gets before drafting.
  const nudge = earningsNudge(S7, STATEMENTS)!;
  assert.match(nudge, /# THE SELLER RAISED EARNINGS/);
  assert.match(nudge, /broker's to walk them through/);
  assert.match(nudge, /net income of \$563,190 for FY2024 \(after tax\)/);
  assert.match(nudge, /Do NOT list, name or total items/);
  assert.ok(earningsNudge(S2, null), "the seller's own add-back list gets the instruction too");
  assert.equal(earningsNudge("Twenty-four vans, you're right.", STATEMENTS), null);

  // The statements' earnings: a document's reported figure only — never the seller's words or the broker's.
  const info = {
    netIncome: "$563,190 after tax (FY2024); FY2023 $482,930; FY2022 $386,174",
    sde: "$1,312,000 (FY2024)",
  };
  assert.deepEqual(statementEarnings(info, (k) => (k === "netIncome" ? "document" : "broker")), STATEMENTS);
  assert.equal(statementEarnings(info, () => "interview"), null);
  assert.equal(statementEarnings({ sde: "$1,312,000" }, () => "document"), null, "an SDE is never 'what the statements show'");
  ok("ACC-INT-4: the seller's earnings question gets the hand-off every time, with the statements' own figure noted once");
}

// ── ACC-INT-5: the date guard and a year the question gave ──
{
  const change = (fieldName: string, newValue: string, extra: Partial<FieldChange> = {}): FieldChange => ({
    fieldName, previousValue: null, previousConfidence: null, newValue, newConfidence: "confirmed", source: "seller_statement", ...extra,
  });
  const onFileText = "risk: one settled employment claim costing $22K all-in (wrongful dismissal, settled July 2024)";
  // Live: "the model wrote 2024, resolved to 2026 from today's date; another fact on file says July 2024".
  const c = change("legalSettlement", "$22,000 one-time legal fees for wrongful dismissal settlement (July 2024)");
  const conf: Record<string, string> = { legalSettlement: "confirmed" };
  const flags = applyDateFidelityGuard([c], conf, { sellerMessage: S2, prevAiMessage: T1, onFileText, today: TODAY });
  assert.match(c.newValue, /July 2024/);
  assert.ok(!flags[0].needsVerification, "no verify: the question gave the year");
  assert.equal(conf.legalSettlement, "inferred", "the year is the question's, not the seller's own word");
  assert.match(flags[0].reason, /taken from the question, which asked about 2024 \(another fact on file agrees: July 2024\)/);
  // Without the question naming the year, the old rule stands: most recent July, verified.
  const c2 = change("legalSettlement", "$22,000 legal fees, settled July 2024");
  const f2 = applyDateFidelityGuard([c2], {}, { sellerMessage: S2, prevAiMessage: "What else ran through professional fees?", onFileText, today: TODAY });
  assert.match(c2.newValue, /July 2026/);
  assert.equal(f2[0].needsVerification, true);
  // A question naming several years settles nothing.
  const c3 = change("legalSettlement", "$22,000 legal fees, settled July 2024");
  applyDateFidelityGuard([c3], {}, { sellerMessage: S2, prevAiMessage: "Anything one-time in 2023 or 2024?", today: TODAY });
  assert.match(c3.newValue, /July 2026/);
  // Later turns: the date on file re-emitted unchanged is no change at all (it was re-saved as "updated" 6 turns running).
  const kept = change("legalSettlement", "$22,000 legal fees (July 2024)", { previousValue: "$22,000 legal fees (July 2026)", previousConfidence: "inferred" });
  const list = [kept];
  const kc: Record<string, string> = { legalSettlement: "confirmed" };
  applyDateFidelityGuard(list, kc, { sellerMessage: "Six guys with the 313A.", onFileText, today: TODAY });
  assert.equal(list.length, 0);
  assert.equal(kc.legalSettlement, "inferred");
  ok("ACC-INT-5: a month dated by the question the seller answered keeps that year; the kept date isn't re-saved every turn");
}

// ── ACC-INT-8: no recap, no verdict — goodbyes, question-mode answers, openers ──
{
  // Great Lakes close (a1.json turn 24).
  const gl = "We've covered a lot of ground today — shift structure, equipment liens, the guarantees, non-compete terms, and how working capital moves through the year. The one area still open from earlier is the exact tooling list Rob keeps — if he can send that over to Morgan, it would fill in the last piece on mold ownership.";
  assert.equal(
    stripFillerPreamble(gl, { closing: true }),
    "The one area still open from earlier is the exact tooling list Rob keeps — if he can send that over to Morgan, it would fill in the last piece on mold ownership.",
  );
  // Clearwater soft-stop close (a3.json turn 8): the seller asked "Can we pick this up tomorrow?".
  const cw = "Of course — we've covered a lot of ground. Before you go, the one thing I'd most like to confirm is whether both clinic premises are zoned for healthcare or therapy use. A quick yes now, or shall we start there next time?";
  const said = "Just Ethan, really, plus one RMT who moved to Edmonton in 2023 for family reasons. Sorry, I have to run, I've got a patient in five minutes. Can we pick this up tomorrow?";
  assert.equal(stripFillerPreamble(cw, { sellerMessage: said }), "Of course. Before you go, the one thing I'd most like to confirm is whether both clinic premises are zoned for healthcare or therapy use. A quick yes now, or shall we start there next time?");
  // A recap listing "capex versus growth" is not a reconciliation; a document request after a recap stays.
  assert.equal(
    stripFillerPreamble("Understood — we've covered a lot of ground today. You've given me a clear picture of the quality organization, maintenance capex versus growth investments, and the key people. Thank you, Diane.", { closing: true }),
    "Understood. Thank you, Diane.",
  );
  assert.equal(
    stripFillerPreamble("We've covered a lot of ground — if Rob can send the tooling list, we'll have the full picture. Thanks, Diane.", { closing: true }),
    "If Rob can send the tooling list, we'll have the full picture. Thanks, Diane.",
  );
  // A goodbye that was nothing but recap still says goodbye.
  assert.match(stripFillerPreamble("We've covered a lot of ground today — the fleet, the team and the lease.", { closing: true }), /^Thanks for your time — everything you've shared is saved/);
  // "…— so that tracks." is a confirmation, not a clarification (Lakeshore T6), in either mode.
  assert.equal(stripFillerPreamble(T6, { sellerMessage: S6 }).startsWith("On the retention question"), true);
  assert.equal(stripFillerPreamble(T6).startsWith("On the retention question"), true);
  // …but a real reconciliation stays.
  const rec = "The roster shows Sal starting in 2009, which doesn't match the sixteen years you mentioned. Which is right?";
  assert.equal(stripFillerPreamble(rec), rec);
  // Lakeshore resume opener: the verdict inside the question goes, the figure stays.
  const opener = "One thing I wanted to ask about: your financials show $378,000 in vehicle expenses in 2024, which is on the higher side relative to revenue — is that driven by the fleet age, fuel costs, or something else a buyer should understand?";
  const expected = "One thing I wanted to ask about: your financials show $378,000 in vehicle expenses in 2024 — is that driven by the fleet age, fuel costs, or something else a buyer should understand?";
  assert.equal(stripQuestionVerdicts(opener), expected);
  assert.equal(polishMessage(opener, ctxFor(null), { opening: true }).message, expected);
  // A clause that states a fact stays.
  const fact = "Your lease runs to 2028, which is when the renewal option opens — have you talked to the landlord?";
  assert.equal(stripQuestionVerdicts(fact), fact);
  ok("ACC-INT-8: goodbyes, question-mode answers and openers lose recaps and verdicts; what is open and real reconciliations stay");
}

// ── ACC-INT-9: a correction's history stays out of the value ──
{
  assert.equal(stripCorrectionNotes("Approximately 4,300 active patient charts (corrected from earlier 3,900 figure)"), "Approximately 4,300 active patient charts");
  assert.equal(stripCorrectionNotes("4,300 active charts — not 3,900 as first stated"), "4,300 active charts");
  assert.equal(stripCorrectionNotes("4,300 active charts; revised from the earlier estimate of 3,900"), "4,300 active charts");
  assert.equal(stripCorrectionNotes("22 setup technicians (previously reported as 112)"), "22 setup technicians");
  // A fact's own history is not a correction note.
  for (const v of [
    "Rent revised from $4,000 to $4,500 in 2024",
    "$2.1M revenue, corrected for the one-time grant",
    "Six RMTs (not including the Seton location)",
    "$1.2M (updated 2024 figure)",
  ]) assert.equal(stripCorrectionNotes(v), v, v);
  const { response } = normalizeInterviewResponse({
    message: "Who keeps the charts?",
    extractedFields: { activePatientCharts: { value: "Approximately 4,300 active patient charts (corrected from earlier 3,900 figure)", confidence: "confirmed", source: "seller_statement", basis: "verbatim" } },
  });
  assert.equal(response.extractedFields.activePatientCharts.value, "Approximately 4,300 active patient charts");
  ok("ACC-INT-9: '(corrected from earlier 3,900 figure)' never reaches the fact");
}

// The add-back guard's existing hand-off lines still pass it.
assert.ok(!assertsNormalisation(NORMALISATION_HANDOFF));

process.stdout.write(`\n${n} groups passed\n`);
