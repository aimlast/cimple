// Filler guard — the reply IS the next question. Every opener below is a
// sentence the QA harvest (docs/qa/2026-09-26-demo-seeding-qa-harvest.md)
// saw reach a seller, followed by the real question it sat in front of.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/filler-guard.test.ts
import assert from "node:assert/strict";
import { stripFillerPreamble, isFillerSentence } from "../../server/interview/turn-guard";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
const Q = "On the lease: is there a personal guarantee from you on it?";

// ── 1. Every harvested praise / grading / recap opener is stripped ──
{
  const openers = [
    // Clearwater
    "That's a realistic read — and the fact that Leah and Priya already receive direct referrals helps.",
    "That's exactly right — your broker will want Dana to pull those insurer agreements and check for any change-of-control language before marketing.",
    "That's helpful — having Dana confirm the ClinicNest ownership-transfer process before marketing would give buyers confidence there's no gap in booking or billing.",
    // Ridgeline
    "That's something a buyer's lawyer will definitely want nailed down early — knowing whether it's consent-before-close or notify-after changes how the deal timeline is structured.",
    "Good to get that clarified on the MSA — no consent clause simplifies things.",
    "That $400K over three years for the brake, old plasma, and forklift lines up with what I'd expect — and having the beam line, new plasma, and cranes all in good shape gives a buyer confidence there's no deferred maintenance hole to fill.",
    "A 3-6 month scramble on estimating directly impacts the bid pipeline, which is why a retention plan for Devin will likely be part of any serious offer.",
    "A stable EMR near 1.0 with no lost-time since 2021 is exactly what they want to see in a fab shop.",
    "That's smart planning — electrical upgrades mid-operation are expensive and disruptive, so having that headroom already built in is a real asset.",
    "That's the right approach — proactive relationship management matters more than what the contract technically requires, especially with an 18% customer.",
    "That makes sense — for sub work and most private O&G and ag contracts, bonding isn't typically required.",
    "Good — a clean Phase I and no legacy contamination issues removes a major due diligence risk for buyers.",
    "That's a realistic read — retention through ownership transitions is always a people question, and keeping Luis visible and engaged is probably the single best insurance policy.",
    "A smart buyer will prioritize that conversation with Devin early in diligence and come prepared with a retention structure.",
    "Good — CWB transfer with a 60-90 day audit timeline while operating under your cert is standard, and the rest is straightforward.",
    // Lakeshore
    "That's a clear picture — Comfort Club as the base, heat pumps as a growth engine, and stronger close rates pulling it together.",
    "That's important context — Dave staying provides continuity on the TSSA registration.",
    "That's cleaner than the TSSA side — no company registration dependency, just the individual 306A tickets.",
    "Good to know the landlord is receptive.",
    "That's worth flagging — a formalized safety program is something a buyer or their insurer may want to see, but the track record speaks for itself.",
    "That's a clean acquisition — customer base with a warm handoff and most of the retention upside.",
    "That's a familiar bottleneck in the trades right now — strong demand capped by tech availability.",
    // Pacific
    "Good to have that documented — the clean June 2023 review and 9.4% OOS rate will land well with buyers and their insurers.",
    "That's a clean structure — no owner-operator classification exposure is increasingly rare and will matter to buyers.",
    "That's a clean pass-through structure — the index-linked mechanism removes most of the fuel volatility risk that buyers worry about in trucking deals.",
    "Good detail on the rate structure — that $8,350 per unit per week with the blended pricing model gives buyers a clear picture of asset utilization.",
    "That's a well-spec'd facility — 32-foot clear with 42 dock doors gives buyers real throughput capacity, and the pre-approved cooler expansion is a straightforward growth lever they can execute on day one.",
    "Turnover well below industry average with that tenure profile will matter to buyers — driver retention is one of the hardest things to replicate.",
    "That covers the key safety and compliance areas.",
    "That confirms the rate discipline is working.",
    "That's a clean regulatory picture — no California exposure means no CARB compliance costs, and the Washington cross-border volume is modest enough that the existing USDOT authority handles it without complexity.",
    // Beacon
    "That's a clear picture — the OCP accreditation stays with the corporation, the DM change is the main timeline driver, and the rest are administrative updates rather than re-applications.",
    "That's a straightforward outcome — a routine audit with minor documentation findings and a modest recovery.",
    "The fact that there's been no follow-up and Carol tightened the protocols is exactly what buyers want to hear.",
    "That's a helpful picture — Dr. Patel at Rideau Dermatology driving roughly a quarter of dermatology compounding volume is the main concentration point.",
    "The vet clinics sound sticky given the specialty nature of the work.",
    "That's reassuring — the clinical relationships that drive referrals sit with Mei-Lin and Daniel, not you personally.",
    // Great Lakes
    "That's a candid assessment — and buyers will want to understand the succession plan for the tool room, so flagging it proactively is the right move.",
    "That $1.8 million Veridian catheter hub program is meaningful — close to 3% of current revenue once it's at full rate.",
    "That powertrain-agnostic mix is actually a strength — reduces the risk of a rapid ICE decline hitting you hard.",
    "That's a helpful reality check on automotive program lifecycle — and the fact that you're still in the running for replacement programs shows the relationship is intact.",
    "That's the kind of detail the attorney can confirm — in most cases stock deals avoid triggering assignment clauses, but it depends on the exact contract language.",
    "That clarifies the regulatory picture — component suppliers typically stay off FDA's direct radar while still meeting the quality system requirements through customer audits.",
    // Harborview
    "That's a clear-eyed read on the relationship risk.",
    "Good — that's a clean vendor picture.",
    "That record is a genuine differentiator in this market.",
    "That $47K premium with a clean claims history is actually favorable given the coverage level and market conditions.",
    "That clarifies the mix — 72% of revenue but closer to 80% of gross profit from recurring, which is the distinction that matters for valuation.",
    // Session recaps in front of a question
    "We've covered the critical ground for buyers: clean operating authority in the company name, satisfactory NSC rating with no open audits, strong insurance position (April renewal with manageable 8-9% increase), well-maintained fleet with a clear capital plan, and healthy warehouse occupancy at 88%.",
    "Amrit, we've covered a lot of ground — your market position, referral channels, team stability, and customer acquisition.",
    // Seen live in the iguards Beacon run
    "We've made good progress — I have a solid picture of the pharmacy's operations, staffing, and key relationships.",
  ];
  for (const o of openers) {
    assert.equal(stripFillerPreamble(`${o} ${Q}`), Q, `stripped: ${o}`);
    assert.equal(stripFillerPreamble(`${o}\n\n${Q}`), Q, `stripped (paragraph): ${o}`);
  }
  // Seen live (iguards Clearwater replay): "I'll note that <recap>" is a recap, not a follow-up.
  assert.equal(
    stripFillerPreamble(`I appreciate that context on the referral relationships — and I'll note that the physician referrals are personal to you rather than contractual. ${Q}`),
    Q,
  );
  // …while a real follow-up note stays.
  for (const keepNote of ["I'll note that for Carol to provide.", "I'll flag that as something Tom can quantify for the financial package.", "I'll note it for follow-up."]) {
    assert.equal(stripFillerPreamble(`${keepNote} ${Q}`), `${keepNote} ${Q}`, keepNote);
  }
  // Two filler sentences in a row (Beacon T3, Ridgeline T17).
  assert.equal(
    stripFillerPreamble(`That's a clear picture — the OCP accreditation stays with the corporation. Good to know Carol's handled the ODB side before.\n\n${Q}`),
    Q,
  );
  // A grade AFTER a sentence that does work goes; the work stays.
  assert.equal(
    stripFillerPreamble(`No problem — if Donna can send over the last two or three years' WCB rate letters, that'll help. A stable EMR near 1.0 with no lost-time since 2021 is exactly what they want to see in a fab shop.\n\n${Q}`),
    `No problem — if Donna can send over the last two or three years' WCB rate letters, that'll help.\n\n${Q}`,
  );
  // Buyer-rationale tacked on after the question goes too (Ridgeline T4).
  assert.equal(
    stripFillerPreamble("Good to get that clarified on the MSA — no consent clause simplifies things. On the backlog, can you have Tanya pull the comparison to same point last year? Buyers will want to see whether the growth is a one-year spike or part of a trend."),
    "On the backlog, can you have Tanya pull the comparison to same point last year?",
  );
  // An acknowledgement prefix on the question sentence itself.
  assert.equal(stripFillerPreamble("Good — what's the remaining term on the lease?"), "What's the remaining term on the lease?");
  // Seen live (iguards Clearwater replay): an appreciation lead-in on the question itself.
  assert.equal(
    stripFillerPreamble("I appreciate the context on differentiation — but I want to make sure I get a clear answer on the regulatory history: have there been any College complaints against the clinic?"),
    "I want to make sure I get a clear answer on the regulatory history: have there been any College complaints against the clinic?",
  );
  ok(`${openers.length} harvested openers are all stripped to start at the question`);
}

// ── 2. Pacific T17: the orphan "It shows…" never survives ──
{
  const raw =
    "That's a strong margin trajectory. It shows operational leverage as the 3PL side scales.\n\nWhat's a typical accounts receivable cycle for you — are most customers paying in 30 days, 45, longer?";
  assert.equal(stripFillerPreamble(raw), "What's a typical accounts receivable cycle for you — are most customers paying in 30 days, 45, longer?");
  const asShipped =
    "It shows operational leverage as the 3PL side scales.\n\nWhat's a typical accounts receivable cycle for you — are most customers paying in 30 days, 45, longer?";
  assert.doesNotMatch(stripFillerPreamble(asShipped), /It shows/);
  ok("Pacific T17 never leaves 'It shows…'");
}

// ── 3. Sentences that do work are kept ──
{
  const keep = [
    "Your P&L shows $1.82M but you said $2.3M — which is right?",
    "That stays with your broker only. What's the lease term?",
    "Understood — that stays with your broker only, it won't appear in any marketing materials or the CIM. What's the lease term?",
    "I'm sorry to hear about your health. Who runs the shop day to day when you're out?",
    "That's a bit above the $1.82M net on your P&L. Is the $2.3M gross sales before refunds and fees?",
    "You're right — that's in your document, I should have caught it. What changed in 2024?",
    "Just to confirm, the $8,417 includes TMI. Does it?",
    "I'll note that as a follow-up for Tanya. Who handles purchasing today?",
    "If you can send over the MSA language on that clause when you find it, that'll be helpful. How does the backlog compare to last year?",
    "On patient records: in a share sale, the records stay with the corporation. Does ClinicNest have a standard process for ownership transfers?",
    "On the equipment side, you mentioned the 110-ton brake is leaking and needs replacement at around $180K. Beyond that, is there any other major equipment near end of life?",
    "Your MRR schedule shows 186 clients and $392,640 monthly. How many of the top ten renew in the next twelve months?",
    "The lease is a standard 10-year term with two renewal options. Does it need landlord consent to assign?",
  ];
  for (const k of keep) assert.equal(stripFillerPreamble(k), k, `kept: ${k}`);
  // Phrase-anchored keeps: "confirm"/"your broker" inside a grade no longer keep it.
  assert.equal(isFillerSentence("That's helpful — having Dana confirm the ClinicNest ownership-transfer process would give buyers confidence."), true);
  assert.equal(isFillerSentence("That's exactly right — your broker will want Dana to pull those insurer agreements."), true);
  assert.equal(isFillerSentence("That record is a genuine differentiator in this market."), true);
  assert.equal(isFillerSentence("That stays with your broker only."), false);
  assert.equal(isFillerSentence("I want to confirm whether the lease has an assignment clause."), false);
  ok("clarifications, conflicts, privacy promises, empathy, document requests and context are kept");
}

// ── 4. Closings keep the recap, lose the praise ──
{
  const lakeshore =
    "That comes through clearly — you've built a business that runs on strong management, recurring revenue, and a reputation earned over 27 years. That's exactly what buyers want to see.\n\nWe've covered the critical areas well. I'll flag a few items for your broker to follow up on with Denise — the EMR rating and the Comfort Club retention report.\n\nThanks for your time today, Tony.";
  const out = stripFillerPreamble(lakeshore, { closing: true });
  assert.doesNotMatch(out, /you've built|exactly what buyers want/);
  assert.match(out, /We've covered the critical areas well/);
  assert.match(out, /Thanks for your time today, Tony\./);
  const ridgeline = "We've covered a lot of ground today. Everything is saved. It's clear you've built something solid. Thanks, Gord.";
  assert.equal(stripFillerPreamble(ridgeline, { closing: true }), "We've covered a lot of ground today. Everything is saved. Thanks, Gord.");
  const harborview = "One of the cleaner operational pictures I've seen. Thanks for your time, Kyle — everything is saved.";
  assert.equal(stripFillerPreamble(harborview, { closing: true }), "Thanks for your time, Kyle — everything is saved.");
  ok("goodbyes keep a factual recap and the thanks, and lose praise of the seller");
}

// ── 5. Question mode still keeps the answer ──
{
  // "Why do you ask — are you thinking about how the workflow changes?"
  const beaconT4 =
    "Exactly — buyers want to understand how the dispensing workload redistributes once you reduce your hours. With Daniel at roughly half the volume and you at a quarter, that's a manageable transition if you're staying on part-time through the handover.\n\nOn a different front: does the pharmacy have any pre-paid services outstanding?";
  const out = stripFillerPreamble(beaconT4, { sellerMessage: "Why do you ask — are you thinking about how the workflow changes once I step back?" });
  assert.match(out, /^Exactly — buyers want to understand how the dispensing workload redistributes/);
  assert.doesNotMatch(out, /manageable transition/);
  // A tag question the answer doesn't address: the acknowledgement still goes.
  assert.equal(
    stripFillerPreamble("Good to know the landlord is receptive. One detail on the lease: is there a personal guarantee from you on it?", {
      sellerMessage: "Yeah, the landlord has to consent if we assign it — that's standard, right? He's on board.",
    }),
    "One detail on the lease: is there a personal guarantee from you on it?",
  );
  // Seen live (iguards Ridgeline run): the grade after the answer starts like an answer.
  assert.equal(
    stripFillerPreamble(
      "For the CIM, we'll show the $3.1M signed backlog as the firm number and note the Westlock job separately. It's the honest read, and sophisticated buyers will appreciate the distinction.\n\nOn the Larkspur side — have you had any signal yet on the shortlist?",
      { sellerMessage: "The PO is still sitting with their procurement people. Should I be counting it or not for the marketing stuff?" },
    ),
    "For the CIM, we'll show the $3.1M signed backlog as the firm number and note the Westlock job separately.\n\nOn the Larkspur side — have you had any signal yet on the shortlist?",
  );
  ok("question mode keeps the answer and drops the grade");
}

console.log(`\n${n} groups passed`);
