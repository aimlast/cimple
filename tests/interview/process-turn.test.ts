// Whole interview turns with a mocked model (tests/interview/turn-harness.ts):
// the guards, governance, merge and save run exactly as in production, with
// scripted model replies taken from the QA harvest's real transcripts.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/process-turn.test.ts
import assert from "node:assert/strict";
import { installHarness, baseDeal, ai, seller, type Harness } from "./turn-harness";
import { processTurn, startOrResumeSession } from "../../server/interview/session-manager";
import { resolveMonthYear } from "../../server/interview/fact-guards";
import { storage } from "../../server/storage";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };
const has = (h: Harness, re: RegExp) => h.logs.some((l) => re.test(l));

// The first four Clearwater exchanges (seller turns 1–4), verbatim openings.
const clearwaterHistory = [
  ai("One area I'd like to fill in: how would you describe Clearwater's reputation in the Calgary physio market, and what do you think sets it apart from competitors like Bowmont?"),
  seller("You know, I think our reputation is built on one-on-one care. We've been in Hillhurst 16 years and people know us."),
  ai("What's the typical path a new patient takes to find Clearwater — is it mainly word of mouth and physician referrals, or does online search play a meaningful role?"),
  seller("Mostly word of mouth and the two family-practice groups nearby. Google brings in maybe a third."),
  ai("Are those physician referral relationships with the clinic formally, or are they personal relationships you've built?"),
  seller("Mostly personal, but Leah and Priya get direct referrals now too."),
  ai("Have any of your physiotherapists or RMTs indicated they're thinking about leaving, retiring, or cutting back?"),
  seller("No, knock on wood. Leah just got the raise in October after Bowmont tried to poach her, so she's locked in. Dana is thinking about retiring in maybe three years."),
  ai("On the patient acquisition side — roughly what does it cost you to acquire a new patient through paid channels like Google Ads, and do you track that?"),
];
const TURN5 =
  "Honestly, I don't track it as closely as I probably should. Dana pulls some reports from Google Ads every quarter, but we've never really nailed down a true cost-per-acquisition number. It's one of those things where I know we spend about $4,000 a month on marketing — call it $50k a year — and we brought in roughly 2,150 new patients in FY2024.\n\nWhat I *do* know is that the lifetime value is strong. A new patient who comes in for physio usually stays for 6-8 visits on average, sometimes way more if it's a chronic issue, and a lot of them come back later or refer someone. So even at $75 to acquire them, it pencils out pretty well.";
const WRAP_OFFER =
  "Amrit, we've covered a lot of ground — your market position, referral channels, team stability, and customer acquisition. We have strong documentation on the financials, leases, and operations already. Is there anything you feel buyers should know that we haven't touched on, or shall we wrap up for today?";
const TURN6 =
  "You know, I think we've covered the mechanics pretty well. If I had to add one thing buyers should understand... it's that this business runs on trust and continuity, not flash. We're not the biggest, we're not the cheapest, we don't have the fanciest equipment. What we have is a team that shows up, patients who feel cared for, and a reputation we've earned one appointment at a time over 16 years. I want to sell to someone who's going to keep building what we've started.";

(async () => {
  // ── 1. Clearwater replay: a false stop can't end the interview early ──
  {
    const h = installHarness(baseDeal(), { messages: [...clearwaterHistory] });
    h.script.push({ message: WRAP_OFFER });
    // The seller-intent classifier reads both turns as ordinary answers.
    h.intents.push({ stop: "none" }, { stop: "none" });
    const t5 = await processTurn("deal-1", "sess-1", TURN5);
    assert.equal(has(h, /Seller stop signal/), false, "turn 5 is not a stop");
    assert.equal(t5.shouldEnd, false);
    // Turn 6: the seller keeps talking about the business; the model tries to end.
    h.script.push({
      message: "That makes complete sense, and it's exactly the kind of insight that helps the right buyer. Thanks for your time, Amrit.",
      shouldEnd: true,
      endReason: "Seller wants to stop",
    });
    h.script.push({ message: "Who at the clinic handles the relationship with the two family-practice groups day to day?", targetSection: "revenue_sources", importance: "critical" });
    const t6 = await processTurn("deal-1", "sess-1", TURN6);
    assert.equal(has(h, /Blocked premature interview end: only 6 of a minimum 10 turns/), true, "governance blocked the end");
    assert.equal(t6.shouldEnd, false);
    assert.equal(h.deal.interviewCompleted, false, "interviewCompleted stays false");
    assert.match(h.calls[h.calls.length - 1], /no acknowledgement, no recap/);
    assert.match(t6.message, /\?$/);
    ok("Clearwater turns 1–6 replayed: no stop signal, the turn-6 end is blocked, interviewCompleted stays false");
  }

  // ── 2. A real stop still wins; a declined wrap-up doesn't carry it over ──
  {
    const h = installHarness(baseDeal(), { messages: [...clearwaterHistory] });
    h.script.push({ message: "Understood. One last one: who holds the Hillhurst lease — you or the corporation? Or shall we wrap up for today?", shouldEnd: false });
    await processTurn("deal-1", "sess-1", "I have to run, let's continue later");
    assert.equal(has(h, /Seller stop signal #1/), true);
    // The seller answers the closing question briefly → the end is allowed.
    h.script.push({ message: "Thanks, Amrit — everything is saved and you can pick this up anytime.", shouldEnd: true, endReason: "seller asked to stop" });
    const end = await processTurn("deal-1", "sess-1", "The corporation holds it. Bye for now.");
    assert.equal(end.shouldEnd, true);
    assert.equal(h.deal.interviewCompleted, true);
    ok("a real stop ends the interview after the one closing question");

    // The seller answers the closing question in full — a long answer is
    // still an answer, not a change of mind: the stop stands.
    const closing = "Understood. One last one: who holds the Hillhurst lease — you or the corporation? Or shall we wrap up for today?";
    const fullAnswer =
      "The corporation holds it, Clearwater Physiotherapy and Wellness Inc. is the tenant, and I signed a personal guarantee back in 2017 when we renewed. The landlord is Hillhurst Commons and the renewal window opens August 31.";
    const h3 = installHarness(baseDeal(), { messages: [...clearwaterHistory, seller("I have to run, let's continue later"), ai(closing)], sessionMeta: { _stopSignalCount: 1 } });
    h3.script.push({ message: "Thanks, Amrit — the lease details are saved, and you can pick this up anytime.", shouldEnd: true, endReason: "seller asked to stop" });
    const long = await processTurn("deal-1", "sess-1", fullAnswer);
    assert.equal(long.shouldEnd, true, "the stop stands after a full answer to the closing question");
    assert.equal(has(h3, /Blocked premature interview end/), false);
    assert.equal(h3.deal.interviewCompleted, true);
    ok("seller stop always wins: a full answer to the one closing question still ends");

    // Two stops in a row (check run cw-B): the second forces the goodbye.
    const h4 = installHarness(baseDeal(), { messages: [...clearwaterHistory] });
    h4.script.push({ message: "Before you go — one quick one: who holds the Hillhurst lease, you or the corporation?", shouldEnd: false });
    await processTurn("deal-1", "sess-1", "Sorry, I have to go to a meeting.");
    assert.equal(has(h4, /Seller stop signal #1/), true);
    // (the exact reply seen live: a goodbye with a question tacked on)
    h4.script.push({ message: "Talk soon.\n\nWhat else should I understand about session end?", shouldEnd: false });
    const forced = await processTurn("deal-1", "sess-1", "Sorry — I have to leave for an appointment, my next patient is waiting.");
    assert.equal(has(h4, /Seller stop signal #2/), true);
    assert.equal(forced.shouldEnd, true, "the second stop forces the end");
    assert.doesNotMatch(forced.message, /\?/, "no question is appended to a goodbye");
    assert.equal(has(h4, /Blocked premature interview end/), false);
    ok("'Sorry, I have to go to a meeting.' then 'I have to leave for an appointment' ends the interview");

    // Only a seller who SAYS they want to go on withdraws the stop.
    const h2 = installHarness(baseDeal(), { messages: [...clearwaterHistory, seller("I have to run, let's continue later"), ai(WRAP_OFFER)], sessionMeta: { _stopSignalCount: 1 } });
    h2.script.push({ message: "Thanks for your time.", shouldEnd: true, endReason: "seller asked to stop" });
    h2.script.push({ message: "What share of new patients come from the two family-practice groups?" });
    const t = await processTurn("deal-1", "sess-1", `Actually I've got a few more minutes — let's keep going. ${TURN6}`);
    assert.equal(t.shouldEnd, false, "the seller chose to continue — the earlier stop doesn't count");
    assert.equal(has(h2, /Blocked premature interview end/), true);
    ok("a seller who says 'let's keep going' after a stop is not ended");

    // "Can we continue with the lease next?" is a seller who wants to go on (check run cw-A, turn 7).
    const h5 = installHarness(baseDeal(), { messages: [...clearwaterHistory, seller(TURN5), ai("Who holds the relationship with the two family-practice groups day to day?")] });
    h5.script.push({ message: "Thanks for your time today — everything is saved.", shouldEnd: true, endReason: "seller wants to stop" });
    h5.script.push({ message: "On the Hillhurst lease: is there a personal guarantee on it?" });
    const lease = await processTurn("deal-1", "sess-1", "Can we continue with the lease next? I have the Hillhurst lease paperwork in front of me right now.");
    assert.equal(has(h5, /Seller stop signal/), false, "not a stop");
    assert.equal(lease.shouldEnd, false);
    assert.equal(h5.deal.interviewCompleted, false);
    ok("'Can we continue with the lease next?' is not a stop, and the model can't end on it");
  }

  // ── 2b. An ordinary answer with "take … back" never withdraws the previous answer ──
  {
    const deal = baseDeal({
      businessName: "Lakeshore Home Comfort",
      extractedInfo: {
        warrantyTerms: "10-year parts, 2-year labour on every install",
        _fieldSources: { warrantyTerms: { source: "interview", sessionId: "sess-1", turn: 1, at: "2026-09-25T10:00:00Z" } },
      },
    });
    const h = installHarness(deal, {
      messages: [ai("What warranty do you give on installs?"), seller("10-year parts and 2-year labour on every install."), ai("What happens to the old equipment when you replace a system?")],
    });
    h.script.push({ message: "Who handles the recycling paperwork?", extractedFields: { equipmentDisposal: { value: "Old units taken back and recycled through Enviro-Cycle", confidence: "confirmed" } } });
    await processTurn("deal-1", "sess-1", "When we replace a furnace we take the old units back and recycle them through Enviro-Cycle.");
    const info = h.deal.extractedInfo as Record<string, any>;
    assert.equal(h.calls.some((c) => /The seller just withdrew something/.test(c)), false, "no retraction re-call");
    assert.equal(info.warrantyTerms, "10-year parts, 2-year labour on every install", "the previous answer is untouched");
    assert.equal(info._brokerDeleted?.warrantyTerms, undefined);
    assert.match(info.equipmentDisposal, /Enviro-Cycle/);
    ok("'we take the old units back and recycle them' is an answer, not a retraction");
  }

  // ── 3. Retraction (Great Lakes session 1, turns 1–3) ──
  {
    const guess = "15–18 molds owned outright; 240–250 customer-owned molds stored; racking for ~300";
    const deal = baseDeal({
      businessName: "Great Lakes Precision Plastics",
      extractedInfo: {
        toolingOwnership: guess,
        _fieldSources: { toolingOwnership: { source: "interview", sessionId: "sess-1", turn: 2, at: "2026-09-25T10:00:00Z" } },
      },
    });
    const history = [
      ai("What would you say is the single biggest reason customers choose Great Lakes over other injection molders?"),
      seller("The tool room. Greg's team can repair and modify molds in-house."),
      ai("How much of your current tooling do you own outright versus customer-owned molds that you store and maintain?"),
      seller("We own maybe 15 to 18 molds, and we store 240 to 250 for customers, with racking for about 300."),
      ai("How concentrated is the customer-owned tooling — do any of the top five customers own 40% or more of those 240–250 molds?"),
    ];
    const retract =
      "Let me take those mold numbers back — I was guessing, and I don't want a guess ending up in the book. Rob keeps the tooling list with owner and customer for every mold; he can send it over. What I do know is nearly all of it is customer-owned, which is normal for us.";

    // (a) The model names nothing → a corrective re-call → the field comes out.
    const h = installHarness(deal, { messages: history });
    h.script.push({ message: "Understood. When a customer's program ends, do the supply agreements require you to return the mold within a set timeframe?" });
    h.script.push({
      message: "When a customer's program ends, do the supply agreements require you to return the mold within a set timeframe?",
      retractedFields: [{ field: "toolingOwnership", reason: "seller said the mold counts were a guess" }],
      newDeferrals: [{ topic: "tooling ownership list", reason: "seller withdrew their estimate", whereInfoLives: "Rob — tooling list" }],
    });
    await processTurn("deal-1", "sess-1", retract);
    assert.equal(h.calls.some((c) => /The seller just withdrew something/.test(c)), true, "the re-call fired");
    const info = h.deal.extractedInfo as Record<string, any>;
    assert.equal(info.toolingOwnership, undefined, "the guess is gone from the facts");
    assert.doesNotMatch(JSON.stringify(Object.fromEntries(Object.entries(info).filter(([k]) => !k.startsWith("_")))), /15–18|240–250/);
    assert.match(info._brokerDeleted.toolingOwnership.note, /Withdrawn by the seller/);
    const meta = h.sessions[0].extractedInfo;
    assert.ok(meta._deferralLedger.some((d: any) => /Rob/.test(d.whereInfoLives) && d.status !== "resolved"), "a deferral names Rob");
    assert.equal(meta._retracted[0].key, "toolingOwnership");

    // (b) A later turn re-records the guess → dropped.
    h.script.push({
      message: "How many setup technicians do you have per shift?",
      extractedFields: { toolingOwnership: { value: "15-18 molds owned; 240-250 customer-owned", confidence: "confirmed" } },
    });
    await processTurn("deal-1", "sess-1", "Most programs return the mold within 30 days of the last PO.");
    assert.equal((h.deal.extractedInfo as any).toolingOwnership, undefined, "the guess can't come back");
    assert.equal(has(h, /dropped a re-recorded withdrawn value: toolingOwnership/), true);
    ok("retraction: the re-call fires, the guess leaves the facts (history + note kept), Rob is on the ledger, and it can't return");

    // (c) The model names the field itself → no re-call needed.
    const h2 = installHarness(baseDeal({ extractedInfo: { ...deal.extractedInfo } }), { messages: history });
    // An open merge discrepancy whose seller side is the withdrawn guess is
    // settled (superseded); one about another fact is left alone.
    const s = storage as any;
    const updates: Array<{ id: string; patch: any }> = [];
    s.getDiscrepanciesByDeal = async () => [
      { id: "disc-guess", status: "open", source: "merge", factKey: "toolingOwnership", interviewValue: "15–18 molds owned outright", documentValue: "22 molds (tooling list)", sideSources: { interview: { kind: "interview" }, document: { kind: "document", documentId: "d1" } }, brokerNotes: null },
      { id: "disc-other", status: "open", source: "merge", factKey: "annualRevenue", interviewValue: "$62M", documentValue: "$60M", sideSources: { interview: { kind: "interview" } }, brokerNotes: null },
    ];
    s.updateDiscrepancy = async (id: string, patch: any) => { updates.push({ id, patch }); return undefined; };
    h2.script.push({ message: "Who keeps the tooling list day to day?", retractedFields: [{ field: "toolingOwnership", reason: "a guess" }] });
    await processTurn("deal-1", "sess-1", retract);
    assert.equal(h2.calls.length, 1);
    assert.equal((h2.deal.extractedInfo as any).toolingOwnership, undefined);
    assert.deepEqual(updates.map((u) => [u.id, u.patch.status]), [["disc-guess", "superseded"]]);
    assert.match(updates[0].patch.brokerNotes, /seller withdrew this value/);
    ok("retraction named by the model removes the interview-sourced value and settles the conflict it was one side of");
  }

  // ── 4. Internal machinery never reaches the seller ──
  {
    const h = installHarness(baseDeal(), { messages: [ai("Is the $38.4K the full claim amount?")] });
    h.script.push({ message: "On the mandatory probes I need to check off: has your insurer or any consumer protection authority flagged any cargo damage complaint patterns?" });
    h.script.push({ message: "Has your insurer or any consumer protection authority flagged any cargo damage complaint patterns beyond that reefer claim?" });
    const t = await processTurn("deal-1", "sess-1", "Yes, the insurer handles everything above the $10K deductible.");
    assert.equal(h.calls.some((c) => /names your internal tools/.test(c)), true, "the rewrite fired");
    assert.doesNotMatch(t.message, /mandatory probe|check off|coverage map/i);
    // …and when the rewrite still leaks, the mechanical scrub removes it.
    const h2 = installHarness(baseDeal(), { messages: [ai("What drove the margin trend?")] });
    const leak = "One item I want to confirm before we wrap up the financial picture: the coverage map shows revenue and EBITDA detail, but I don't have a clear read on working capital needs. What's a typical accounts receivable cycle for you?";
    h2.script.push({ message: leak });
    h2.script.push({ message: leak });
    const t2 = await processTurn("deal-1", "sess-1", "Mostly the 3PL side scaling up.");
    assert.doesNotMatch(t2.message, /coverage map|mandatory probe|knowledge base/i);
    assert.match(t2.message, /accounts receivable cycle/);
    ok("machinery: 'mandatory probes' triggers the rewrite; a second leak is scrubbed");
  }

  // ── 5. A non-final turn always asks something ──
  {
    const h = installHarness(baseDeal(), { messages: [ai("Roughly what share of total dispensing do you personally handle?")] });
    h.script.push({ message: "That's helpful — a more realistic split with Daniel at 40–45%, Mei-Lin and Farah at around 40% combined, and you closer to 15–20% of actual verification volume. A RxNova report would be useful for the CIM if Carol can pull it, but this gives buyers a clear picture." });
    h.script.push({ message: "Has the pharmacy ever been through an ODB billing audit, and if so, what was the outcome?" });
    const t = await processTurn("deal-1", "sess-1", "Honestly Daniel is more like 40-45%, Mei-Lin and Farah 40% together, me 15-20%.");
    assert.equal(h.calls.some((c) => /It asks nothing/.test(c)), true);
    assert.match(t.message, /\?/);
    // Rewrite also fails → the planned question is appended.
    const h2 = installHarness(baseDeal(), { messages: [ai("Roughly what share of total dispensing do you personally handle?")] });
    h2.script.push({ message: "That gives buyers a clear picture of the dispensing split.", nextIntent: "Ask whether any ODB billing audit has happened" });
    h2.script.push({ message: "Noted on the split.", nextIntent: "Ask whether any ODB billing audit has happened" });
    const t2 = await processTurn("deal-1", "sess-1", "Daniel 40-45%, me 15-20%.");
    assert.match(t2.message, /\?\s*$/);
    // A reply that answers the seller's question and then asks one: untouched, no re-call.
    const h3 = installHarness(baseDeal(), { messages: [ai("What share of new patients come through physician referrals?")] });
    const answerThenAsk = "Yes — it goes to your broker only, never into the document. What share of new patients come through physician referrals?";
    h3.script.push({ message: answerThenAsk });
    const t3 = await processTurn("deal-1", "sess-1", "Before I answer — does this go into the document the buyers see?");
    assert.equal(h3.calls.length, 1);
    assert.equal(t3.message, answerThenAsk);
    ok("no-question: re-call adds the question, the fallback appends one, an answer-then-question passes untouched");
  }

  // ── 6. Legal assertions: rewritten, and never confirmed by the seller's "yes" ──
  {
    const h = installHarness(baseDeal({ businessName: "Beacon Pharmacy" }), { messages: [ai("Has the pharmacy ever been through an ODB billing audit?")] });
    h.script.push({ message: "Ontario requires that pharmacy owners be licensed pharmacists. Is that something to flag?" });
    h.script.push({ message: "Are there rules about who can own or hold shares in the pharmacy that a buyer should know about?" });
    const t = await processTurn("deal-1", "sess-1", "One routine audit in 2023, minor documentation findings, all closed.");
    assert.equal(h.calls.some((c) => /states a legal or regulatory requirement as fact/.test(c)), true);
    assert.doesNotMatch(t.message, /\brequires\b/);

    const claim = "On the ownership side: Ontario requires that pharmacy owners be licensed pharmacists. Is that a restriction you'd want me to flag prominently for buyers?";
    const h2 = installHarness(baseDeal({ businessName: "Beacon Pharmacy" }), { messages: [ai(claim)] });
    h2.script.push({
      message: "Who would be the designated manager for a new owner at closing?",
      extractedFields: { ownershipRestriction: { value: "All shareholders must be pharmacists", confidence: "confirmed" } },
    });
    await processTurn("deal-1", "sess-1", "Yes, all shareholders must be pharmacists — put it in the CIM.");
    const conf = h2.sessions[0].extractedInfo._confidenceLevels;
    assert.notEqual(conf.ownershipRestriction, "confirmed");
    assert.ok(h2.tasks.some((t: any) => t.title === "Verify with counsel: ownershipRestriction"), "a counsel task exists");
    ok("legal: the pharmacist-ownership premise is rewritten; the agreed claim is stored unconfirmed with a counsel task");
  }

  // ── 7. Dates, filler and whyItMatters inside a real turn ──
  {
    const h = installHarness(baseDeal(), { messages: [ai("Have any of your physiotherapists indicated they're thinking about leaving?")] });
    h.script.push({
      message: "That's a realistic read — and the fact that Leah and Priya already receive direct referrals helps. On the topic of your team's forward plans: is Dana's retirement likely within three years?",
      extractedFields: { practitionerForwardIntentions: { value: "Leah retained after October 2024 Bowmont offer", confidence: "confirmed" } },
      whyItMatters: "Environmental liabilities can kill deals or require costly remediation escrows.",
    });
    const t = await processTurn("deal-1", "sess-1", "No, knock on wood. Leah just got the raise in October after Bowmont tried to poach her, so she's locked in.");
    assert.match(t.message, /^On the topic of your team's forward plans/);
    const expectedYear = resolveMonthYear(9, "past", new Date());
    assert.match(String((h.deal.extractedInfo as any).practitionerForwardIntentions), new RegExp(`October ${expectedYear}`));
    assert.notEqual(h.sessions[0].extractedInfo._confidenceLevels.practitionerForwardIntentions, "confirmed");
    // A rationale for another topic is replaced — never left empty (round V).
    assert.ok(t.whyItMatters && !/Environmental/.test(t.whyItMatters), "a rationale for another topic is replaced, not shown");

    const h2 = installHarness(baseDeal(), { messages: [ai("Are there any environmental permits for the facility?")] });
    h2.script.push({
      message: "We've covered a lot of ground today. Before we wrap, is there anything about the business that you think a buyer needs to understand that we haven't touched on?",
      whyItMatters: "Environmental liabilities can kill deals or require costly remediation escrows — a clean Phase I removes a common due diligence obstacle.",
    });
    const w = await processTurn("deal-1", "sess-1", "Just the air permit, which transfers with the property.");
    assert.ok(w.whyItMatters && !/Environmental|Phase I/.test(w.whyItMatters), "the wrap-up question gets its own rationale");
    assert.match(w.message, /^Before we wrap/);
    ok("in a turn: 'October 2024' → the most recent October, the grade is stripped, a stale whyItMatters replaced");
  }

  // ── 8. The opening keeps its welcome ──
  {
    const doc = { id: "doc-1", dealId: "deal-1", name: "FY2024 P&L.pdf", category: "financial", status: "extracted", isProcessed: true, visibility: "seller_visible", sourceKind: "document", extractedData: { summary: "P&L" }, createdAt: new Date() };
    const h = installHarness(baseDeal({ questionnaireData: { yearsInBusiness: "16" } }), { documents: [doc] });
    h.script.push({
      message: "Thanks for sharing your documents — I've read through them. What's behind the Seton location's loss last year?",
      importance: "critical",
      targetSection: "financials",
      whyItMatters: "Buyers price a money-losing location as a cost unless the loss is explained.",
    });
    const open = await startOrResumeSession("deal-1");
    assert.equal(open.message, "Thanks for sharing your documents — I've read through them. What's behind the Seton location's loss last year?");
    assert.match(h.calls[0], /warm welcome sentence/);
    ok("opening: the welcome sentence survives the filler guard");
  }

  process.stdout.write(`\n${n} groups passed\n`);
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
