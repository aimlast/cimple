// What the seller reads (round V, i-output): the filler guard cuts only the
// verdict and keeps the fact; no add-back calls in the message or the facts;
// exactly one question; options anchored to today; the business's own
// vocabulary; "you mentioned" only for the seller's words; never a question
// the interviewer answered itself a turn earlier. Every case is a live miss
// from the round-V verification (27 + 55 real turns) or its review.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/reply-guards.test.ts
import assert from "node:assert/strict";
import { stripFillerPreamble, isFillerSentence, normalizeInterviewResponse } from "../../server/interview/turn-guard";
import {
  removeNormalisationAssertions,
  findNormalisationAssertions,
  guardNormalisationFields,
  enforceSingleQuestion,
  anchorYearOptions,
  jurisdictionOf,
  localiseTerms,
  foreignTerms,
  jurisdictionPromptLines,
  fixAttribution,
  selfStatedFindings,
  NORMALISATION_HANDOFF,
} from "../../server/interview/reply-guards";
import { polishMessage, polishChips, type PolishContext } from "../../server/interview/reply-polish";
import { ensureQuestionRationale, sectionUnsupported, fallbackRationale } from "../../server/interview/question-rationale";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

// ── 1. Filler: the residual live misses go, the fact stays ──
{
  const cases: [string, string | null, string][] = [
    ["That clarifies it — Maplecrest at 41% of LTC revenue but around 12% of total revenue makes sense. How long is the Maplecrest contract?", "Maplecrest is 41% of LTC but only about 12% of total.", "How long is the Maplecrest contract?"],
    ["That's reassuring — a dozen patients is manageable, and the utilization gap at Seton is a clearer growth story than a recovery story. What's the current utilization at Seton?", "Only about a dozen patients would be affected.", "What's the current utilization at Seton?"],
    ["I hear you — the Comfort Club is clearly a big part of what makes this business attractive. How many members renewed last year?", "The Comfort Club is the heart of this business.", "How many members renewed last year?"],
    ["That squares the numbers — $3.1M signed plus $1.1M Westlock pending PO gets to $4.2M. Switching gears: your add-back list shows owner compensation at $260K for 2024 — which figure is right?", "Yeah, the Westlock job, one-point-one million.", "Switching gears: your add-back list shows owner compensation at $260K for 2024 — which figure is right?"],
    ["That helps — so the $260K is your total compensation including the personal expenses. On the legal side: are there any pending lawsuits?", "I pull one-eighty salary and about sixty in dividends.", "On the legal side: are there any pending lawsuits?"],
    ["Got it — have Donna pull the WCB rate letters when she can, and I'll note that for follow-up. Who does your estimating?", "Donna would have those.", "Have Donna pull the WCB rate letters when she can, and I'll note that for follow-up. Who does your estimating?"],
    ["That would be useful — have Devin send the current bid log over when he has a minute. How many bids are out right now?", "Devin keeps the bid log.", "Have Devin send the current bid log over when he has a minute. How many bids are out right now?"],
    ["Forty trucks is a significant operation — is that a dedicated fleet or do you use carriers too?", "We run forty trucks.", "Is that a dedicated fleet or do you use carriers too?"],
    ["No problem — two leased box trucks for local milk runs and common carrier for the rest is a much simpler picture for buyers. Who are your main carriers?", "Just two leased box trucks, common carrier for the rest.", "Who are your main carriers?"],
    ["We'll keep it simple, which keeps everything clean for a buyer's accountant. Who prepares your year-end statements?", null, "Who prepares your year-end statements?"],
    ["No rush, but buyers in this industry will want to see it. Who does your estimating?", null, "No rush. Who does your estimating?"],
    // Live round V (Ridgeline, after "the whole two-sixty comes back to the buyer").
    ["We've noted the owner compensation — let's make sure we've got the holdbacks picture clear. Beyond the Coldbrook $38K that's in dispute, are there any other holdbacks at risk?", "Put it this way, the whole two-sixty comes back to the buyer.", "Beyond the Coldbrook $38K that's in dispute, are there any other holdbacks at risk?"],
  ];
  for (const [msg, seller, want] of cases) assert.equal(stripFillerPreamble(msg, { sellerMessage: seller }), want, msg);
  // A document request naming two people is still a document request (live, Ridgeline round V).
  const ask = "Fair enough — if you can have Donna or Tanya pull that list with ages and tenure, that would be helpful. Are your shop floor employees unionized?";
  assert.equal(stripFillerPreamble(ask, { sellerMessage: "I'd have to ask Donna." }), ask);
  ok("residual acknowledgement / grading openers are cut (clarifies, reassuring, squares, helps — so, hear you, got it, would be useful, significant operation, simpler picture, keeps it clean)");
}

// ── 2. …without cutting the fact the question stands on ──
{
  const cases: [string, string][] = [
    ["Your 2024 T2 shows $180K in shareholder loans outstanding, which is significant. How much of that do you plan to repay before closing?", "Your 2024 T2 shows $180K in shareholder loans outstanding. How much of that do you plan to repay before closing?"],
    ["The lease you uploaded runs to March 2027 with one five-year renewal option, which is standard. Has the landlord said anything about the renewal rent?", "The lease you uploaded runs to March 2027 with one five-year renewal option. Has the landlord said anything about the renewal rent?"],
    ["Your contract with Metro ends in June 2026, which directly affects next year's revenue. Have you started renewal talks with them?", "Your contract with Metro ends in June 2026. Have you started renewal talks with them?"],
    ["Stepping back to quality: your 18 PPM and Gold supplier status with Maumee Valley are strong, but IATF 16949 recertification is coming up fall 2026. Have you started the pre-audit prep?", "Stepping back to quality: IATF 16949 recertification is coming up fall 2026. Have you started the pre-audit prep?"],
    ["Your largest customer is 34% of revenue, which is significant for buyers. How long is their contract?", "Your largest customer is 34% of revenue. How long is their contract?"],
    ["Shifting gears — your documents show the backlog at $4.2M, which includes the Westlock terminal that's still awaiting PO. How does that compare to last year?", "Shifting gears — your documents show the backlog at $4.2M, which includes the Westlock terminal that's still awaiting PO. How does that compare to last year?"],
    ["On Tidewater's June 2026 renewal — have they given any indication of the terms they're looking for?", "On Tidewater's June 2026 renewal — have they given any indication of the terms they're looking for?"],
  ];
  for (const [msg, want] of cases) {
    assert.equal(stripFillerPreamble(msg, { sellerMessage: "Tidewater's renewal is in June 2026, we're talking to them." }), want, msg);
  }
  // In question mode the answer stays ("Is a 42% margin good?").
  assert.equal(
    stripFillerPreamble("It's healthy relative to your own 2023 figure of 38%. What drove the improvement?", { sellerMessage: "Is a 42% gross margin good for a shop like mine?" }),
    "It's healthy relative to your own 2023 figure of 38%. What drove the improvement?",
  );
  // An opinion with no fact in it goes with its grade.
  assert.equal(isFillerSentence("Keeping them engaged is the real retention play, which you've already flagged."), true);
  assert.equal(isFillerSentence("Your 2024 T2 shows $180K in shareholder loans outstanding, which is significant."), false);
  ok("document figures, dates and topic turns survive; only the verdict clause goes");
}

// ── 3. No add-back / SDE calls in the message ──
{
  const r1 = removeNormalisationAssertions("We'll show the $240,000 as documented comp and the personal expenses as a separate add-back. Who handles your purchasing today?");
  assert.equal(r1.message, "Who handles your purchasing today?");
  const r2 = removeNormalisationAssertions(
    "All of it would be an add-back for a new owner. On the legal side: are there any pending lawsuits?",
    "I pull one-eighty salary and about sixty in dividends. That's the add-back.",
  );
  assert.equal(r2.message, `${NORMALISATION_HANDOFF} On the legal side: are there any pending lawsuits?`, "the seller raised it: the hand-off replaces the call");
  assert.deepEqual(findNormalisationAssertions("Yes — your salary gets added back, and your dividends too. What's your role day to day?").length, 1);
  assert.equal(removeNormalisationAssertions("Since the truck is an add-back, how much of it is personal use?").message, "How much of it is personal use?");
  // The call the other way round, or without the vocabulary (live, round V).
  for (const call of [
    "Dividends work differently — they're distributions from retained earnings, not an expense on the income statement, so there's nothing to \"add back\" for those.",
    "Your broker will confirm the full normalization against your actual statements, but the short answer is the $180K salary and the personal expenses flow through.",
    "A new owner wouldn't need to pay you that $260K.",
    "Dividends aren't an add-back.",
  ]) assert.equal(findNormalisationAssertions(`${call} Who does the books?`).length, 1, call);
  // Not calls: citing the seller's own schedule, a hand-off, a question about treatment.
  for (const fine of [
    "Switching gears: your add-back list shows owner compensation at $260K for 2024 — which figure is right?",
    "Your broker will confirm what gets added back when they normalize the numbers. What's your role?",
    "Is the $28K truck used for the business at all?",
    "What personal expenses run through the company, roughly?",
    "About $20K of personal expenses flow through the company.",
    "Buyers don't pay for goodwill they can't verify.",
  ]) assert.deepEqual(findNormalisationAssertions(fine), [], fine);
  ok("treatment calls are removed from the message; the seller who raised it gets the hand-off");
}

// ── 4. …and never recorded as the seller's fact ──
{
  const fields: Record<string, any> = {
    ownerCompensationReconciled: { value: "Total owner compensation $260K: $180K salary + ~$60K dividends + ~$20K personal expenses through company. All $260K is add-back for new owner.", confidence: "confirmed", basis: "verbatim" },
    sde: { value: "$1.1M", confidence: "inferred", basis: "computed" },
    addbacks: { value: "Owner salary $180K; dividends $60K; truck $28K", confidence: "confirmed", basis: "verbatim" },
    employees: { value: "42 staff", confidence: "confirmed", basis: "verbatim" },
  };
  const notes: any[] = [];
  guardNormalisationFields(fields, notes);
  assert.equal(fields.ownerCompensationReconciled.value, "Total owner compensation $260K: $180K salary + ~$60K dividends + ~$20K personal expenses through company.");
  assert.equal(fields.sde, undefined, "the interviewer's own SDE computation is not recorded");
  assert.equal(fields.addbacks.value, "Owner salary $180K; truck $28K");
  assert.equal(fields.employees.value, "42 staff");
  assert.ok(notes.some((x) => /All \$260K is add-back/.test(x.note) && /distributions, not expenses/.test(x.note)), "the seller's view goes to the broker, with why");
  assert.ok(notes.some((x) => /dividends \$60K/.test(x.note)));
  // Live round V: once "add-back" was barred the model re-recorded the call in other words.
  const again: Record<string, any> = {
    ownerCompensationReconciled: { value: "$260K total: $180K salary, ~$60K dividends, ~$20K personal expenses (truck, etc.) run through company. Seller confirms all flows through and a new owner wouldn't need to replicate it.", confidence: "confirmed", basis: "verbatim" },
  };
  guardNormalisationFields(again, notes);
  assert.equal(again.ownerCompensationReconciled.value, "$260K total: $180K salary, ~$60K dividends, ~$20K personal expenses (truck, etc.) run through company.");
  // Through the response normaliser (every model call passes it).
  const { response } = normalizeInterviewResponse({
    message: "What's your role day to day?",
    extractedFields: { ownerComp: { value: "Salary $180K. It would be added back in full.", confidence: "confirmed", source: "seller_statement", basis: "verbatim" } },
    privateNotes: [],
  });
  assert.equal(response.extractedFields.ownerComp.value, "Salary $180K.");
  assert.ok(response.privateNotes.some((x) => /added back in full/.test(x.note)));
  ok("treatment calls leave the facts for the broker's private notes; computed SDE isn't recorded; dividends come out of add-backs");
}

// ── 5. Exactly one question ──
{
  const a = enforceSingleQuestion("The 2008 press needs replacement at around $380K — where does that stand? Is it on the schedule for 2025 or 2026?", ["Scheduled for 2026", "Not yet budgeted"]);
  assert.equal(a.message, "The 2008 press needs replacement at around $380K — where does that stand?");
  assert.equal(enforceSingleQuestion("Your Phase I from 2019 came back clean — have there been any changes since then? Any underground storage tanks on the property, current or historical?").message, "Your Phase I from 2019 came back clean — have there been any changes since then?");
  assert.equal(enforceSingleQuestion("Have you started the pre-audit prep, and are there any findings from the last surveillance audit?").message, "Have you started the pre-audit prep?");
  assert.equal(enforceSingleQuestion("Is the difference the Westlock job? Or are there other jobs in the $4.2M?").message, "Is the difference the Westlock job, or are there other jobs in the $4.2M?");
  assert.equal(
    enforceSingleQuestion("On the automotive side, what does your current platform exposure look like? Specifically, how much of your automotive revenue is tied to EV programs versus traditional ICE vehicles?").message,
    "On the automotive side, how much of your automotive revenue is tied to EV programs versus traditional ICE vehicles?",
  );
  assert.equal(
    enforceSingleQuestion("What about your skilled trades — setup technicians and toolmakers? What does turnover look like there, and how deep is your bench if Greg decides to retire?").message,
    "On your skilled trades — setup technicians and toolmakers: what does turnover look like there?",
  );
  // Live round V (Clearwater): "— and roughly what…?"
  assert.equal(
    enforceSingleQuestion("Are the non-compete and non-solicit clauses in your 2024 associate agreements enforceable — and roughly what are the terms?").message,
    "Are the non-compete and non-solicit clauses in your 2024 associate agreements enforceable?",
  );
  const one = "Is there anything you feel buyers should know that we haven't touched on, or shall we wrap up for today?";
  assert.equal(enforceSingleQuestion(one).message, one, "an either/or is one question");
  ok("one question per turn: extra sentences, joined second questions and 'Specifically…' restatements go; either/or stays");
}

// ── 6. Options anchored to today ──
{
  const today = new Date("2026-09-25T12:00:00Z");
  const y = anchorYearOptions("Where does that stand — is it on the schedule for 2025 or 2026?", [], today);
  assert.equal(y.message, "Where does that stand — is it on the schedule for 2026 or 2027?");
  assert.equal(anchorYearOptions("Was the roof replaced in 2019 or 2020?", [], today).message, "Was the roof replaced in 2019 or 2020?", "past questions keep past years");
  const ctx: PolishContext = { sellerMessage: null, jurisdiction: "US", location: "Toledo, Ohio", sellerText: "", facts: [], today };
  const p = polishMessage("Is the press replacement planned for 2025 or 2026?", ctx);
  assert.equal(p.message, "Is the press replacement planned for 2026 or 2027?");
  assert.deepEqual(polishChips(["2025", "2026", "Not scheduled yet"], p.message, p.report, ctx), ["2026", "2027", "Not scheduled yet"]);
  assert.deepEqual(polishChips(["Planned for 2025", "Not scheduled"], "When is the next audit planned?", { ...p.report, yearShift: 0 }, ctx), ["Not scheduled"], "a past year offered for a future event goes");
  ok("a future question never offers a year that has passed; chips move with it");
}

// ── 7. The business's own vocabulary ──
{
  assert.equal(jurisdictionOf("Calgary, AB"), "CA");
  assert.equal(jurisdictionOf("Nisku (Edmonton region), Alberta"), "CA");
  assert.equal(jurisdictionOf("Toledo, Ohio"), "US");
  assert.equal(jurisdictionOf("Vancouver, WA"), "US");
  assert.equal(jurisdictionOf("Mississauga, ON"), "CA");
  assert.equal(jurisdictionOf(""), null);
  assert.equal(
    localiseTerms("How many are W-2 employees versus 1099 contractors, and do you offer a 401(k)?", "CA", "Calgary, AB"),
    "How many are T4 employees versus independent contractors, and do you offer a group RRSP?",
  );
  assert.equal(localiseTerms("Any open workers' comp claims with the IRS?", "CA", "Toronto, Ontario"), "Any open WSIB claims with the CRA?");
  assert.equal(localiseTerms("Is your HST filing current with CRA?", "US", "Toledo, OH"), "Is your sales tax filing current with IRS?");
  assert.equal(localiseTerms("How many of your W-2 staff…", "CA", "Calgary, AB", "we put the US crew on W-2"), "How many of your W-2 staff…", "the seller's own word stays");
  assert.deepEqual(foreignTerms("Is it an S-corp?", "US"), [], "S-corp is right for a US business");
  assert.match(jurisdictionPromptLines("CA", "Calgary, AB").join(" "), /T4 employees.*WCB.*Never US terms/);
  ok("Canadian deals get Canadian terms and US deals US ones; the seller's own words are kept");
}

// ── 8. Who said it ──
{
  const facts = [{ value: "Union organizing drive in 2019 failed 61-39", source: "video_call", speaker: "Rob Kline (plant manager)" }];
  const a = fixAttribution("On the labor side, you mentioned a union organizing attempt in 2019 that didn't succeed — has there been any activity since?", { sellerText: "We run two shifts.", facts });
  assert.equal(a.message, "On the labor side, Rob mentioned a union organizing attempt in 2019 that didn't succeed — has there been any activity since?");
  const b = fixAttribution("You mentioned a union organizing attempt in 2019 — any activity since?", { sellerText: "", facts: [{ value: "union organizing attempt 2019 failed", source: "crm" }] });
  assert.equal(b.message, "I have a note about a union organizing attempt in 2019 — any activity since?", "a broker's note is never named — nor put in the seller's mouth");
  const c = fixAttribution("You mentioned the 110-ton brake is leaking — when is it due for replacement?", { sellerText: "The 110-ton brake is leaking hydraulic fluid.", facts: [] });
  assert.equal(c.message, "You mentioned the 110-ton brake is leaking — when is it due for replacement?", "the seller's own words keep 'you mentioned'");
  assert.equal(fixAttribution("As you mentioned, the lease runs to 2027. Is there a renewal option?", { sellerText: "", facts: [] }).message, "As noted, the lease runs to 2027. Is there a renewal option?");
  const d = fixAttribution("You said the backlog is $4.2M — how much of that is signed?", { sellerText: "", facts: [{ value: "Backlog $4.2M including Westlock", source: "call" }] });
  assert.equal(d.message, "The call notes say that the backlog is $4.2M — how much of that is signed?");
  ok("'you mentioned' is kept only for the seller's words; a manager is named, a call or a note is attributed as such");
}

// ── 9. Asking what it told the seller itself ──
{
  const f = selfStatedFindings(
    "What about the physios on the 2024 agreement — could you walk me through the key terms? I'm thinking notice period, the non-compete radius and duration, and whether there's a non-solicitation clause.",
    ["The call notes mention your associates are independent contractors with 12-month non-solicitation and 12-month/5 km non-compete clauses in the 2024 agreement. How many have been with you more than three years?"],
  );
  assert.equal(f.length, 1);
  assert.equal(f[0].verify, true, "confirmed by the supporting model before a rewrite");
  assert.deepEqual(selfStatedFindings("How many trucks are in the fleet today?", ["The landlord has consented to an assignment of the lease in the past, according to the file."]), []);
  ok("a question about what the interviewer said a turn earlier is a re-ask candidate");
}

// ── 10. Every question gets a rationale that belongs to it, and a section its words support ──
(async () => {
  const sections = { financials: "Financial Summary", revenue_sources: "Sources of Revenue", real_estate: "Real Estate", employees: "Employees", asking_price: "Asking Price & Terms", operations: "Operations" };
  const base = { sections, businessLine: "Physiotherapy clinic — Calgary, AB" };
  let calls = 0;
  const failing = async () => { calls++; return null; };
  const kept = await ensureQuestionRationale({ ...base, message: "How many physiotherapists are on staff today?", whyItMatters: "Buyers look at how many physiotherapists carry the caseload and whether it depends on the owner.", targetSection: "employees" }, failing);
  assert.equal(kept.how, "kept");
  assert.equal(calls, 0, "no supporting-model call when both fit");
  const missing = await ensureQuestionRationale({ ...base, message: "How many physiotherapists are on staff today?", targetSection: "employees" }, async () => ({ whyItMatters: "Buyers want to know the clinic's caseload doesn't rest on the owner's own hours." }));
  assert.equal(missing.whyItMatters, "Buyers want to know the clinic's caseload doesn't rest on the owner's own hours.");
  const fallback = await ensureQuestionRationale({ ...base, message: "How many physiotherapists are on staff today?", targetSection: "employees" }, failing);
  assert.ok(fallback.whyItMatters && fallback.whyItMatters.length > 20, "never empty");
  const relabelled = await ensureQuestionRationale(
    { ...base, message: "Do you direct-bill the insurers for every patient, or do patients pay and claim?", whyItMatters: "Direct billing affects how quickly the clinic is paid by insurers.", targetSection: "asking_price" },
    async () => ({ targetSection: "revenue_sources" }),
  );
  assert.equal(relabelled.targetSection, "revenue_sources");
  const keywordOnly = await ensureQuestionRationale({ ...base, message: "Is the lease on the Seton premises assignable to a buyer?", whyItMatters: "Buyers need the premises to transfer with the business.", targetSection: "asking_price" }, failing);
  assert.equal(keywordOnly.targetSection, "real_estate", "when the model can't be asked, the question's own words decide");
  assert.equal(sectionUnsupported("Do you direct-bill the insurers?", "asking_price", Object.keys(sections)), true);
  assert.equal((await ensureQuestionRationale({ ...base, message: "Thanks for your time today — everything is saved." }, failing)).how, "none");
  assert.match(fallbackRationale(undefined, "Before we wrap, is there anything a buyer should know that we haven't touched on?"), /on your terms/);
  // The model's rationale is refused when it makes an add-back call.
  const badWhy = await ensureQuestionRationale({ ...base, message: "What do you pay yourself?", whyItMatters: "Your salary is an add-back, so buyers will add it back to earnings.", targetSection: "financials" }, failing);
  assert.doesNotMatch(badWhy.whyItMatters ?? "", /add-back|added back|add it back/i);
  // …or talks normalization at all (live, Clearwater round V).
  const liveWhy = await ensureQuestionRationale(
    { ...base, message: "Can you walk me through your salary, any dividends you took, and perks the company covers?", whyItMatters: "Buyers and lenders normalize earnings by adding back owner compensation and perks that won't continue — the breakdown determines whether the $690K SDE holds up in due diligence.", targetSection: "financials" },
    async () => ({ whyItMatters: "Buyers want to see exactly what the owner takes out, so they can compare it with what running the clinic will cost them." }),
  );
  assert.equal(liveWhy.whyItMatters, "Buyers want to see exactly what the owner takes out, so they can compare it with what running the clinic will cost them.");
  ok("rationale: kept when it fits, written by the supporting model when missing, never empty; the section follows the question");

  console.log(`\n${n} groups passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
