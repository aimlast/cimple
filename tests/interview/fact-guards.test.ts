// Fact guards and output guards — offline. Each case is a failure the QA
// harvest (docs/qa/2026-09-26-demo-seeding-qa-harvest.md) saw in a real run.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/fact-guards.test.ts
import assert from "node:assert/strict";
import {
  detectRetraction,
  applySellerRetractions,
  restatesWithdrawnValue,
  guessRetractedFields,
  whoHoldsTheAnswer,
  applyDateFidelityGuard,
  resolveMonthYear,
  applyLegalGroundingGuard,
  findLegalAssertions,
  recordFactSpeakers,
  tenseOf,
  clauseAround,
} from "../../server/interview/fact-guards";
import {
  leaksInternalMachinery,
  scrubInternalMachinery,
  whyItMattersFits,
  finalizeOpeningMessage,
  fallbackQuestion,
  normalizeInterviewResponse,
} from "../../server/interview/turn-guard";
import { buildFactSourceLabels } from "../../server/interview/knowledge-base";
import { buildInformationView } from "../../server/information/view";
import type { FieldChange } from "../../server/interview/info-merger";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
const TODAY = new Date("2026-09-25T12:00:00Z");
const change = (fieldName: string, newValue: string, newConfidence = "confirmed", previousValue: string | null = null): FieldChange => ({
  fieldName,
  previousValue,
  previousConfidence: null,
  newValue,
  newConfidence,
  source: "seller_statement",
});

// ── 1. Retractions ──
{
  const gl = "Let me take those mold numbers back — I was guessing, and I don't want a guess ending up in the book. Rob keeps the tooling list with owner and customer for every mold; he can send it over. What I do know is nearly all of it is customer-owned, which is normal for us.";
  assert.equal(detectRetraction(gl), true);
  for (const s of ["Scratch that, it's closer to 40.", "Actually ignore what I said about the margins.", "Don't put that number in the book.", "Those were just guesses."]) {
    assert.equal(detectRetraction(s), true, s);
  }
  for (const s of ["We take back returned pallets at no charge.", "I was guessing the weather would hold, but it didn't.".replace("I was guessing", "we were hoping")]) {
    assert.equal(detectRetraction(s), false, s);
  }
  assert.equal(whoHoldsTheAnswer(gl), "Rob");

  const guess = "15–18 molds owned outright; 240–250 customer-owned molds stored; racking for ~300";
  const info: Record<string, unknown> = {
    toolingOwnership: guess,
    annualRevenue: "$62,400,000",
    _fieldSources: {
      toolingOwnership: { source: "interview", sessionId: "s1", turn: 2, at: "2026-09-25T10:00:00Z" },
      annualRevenue: { source: "document", documentId: "doc-fs" },
    },
  };
  // Fallback when the model names nothing: the previous turn's matching fact.
  assert.deepEqual(guessRetractedFields(info, gl, { sessionId: "s1", turn: 3 }), ["toolingOwnership"]);

  const r = applySellerRetractions(info, [{ field: "toolingOwnership", reason: "seller was guessing" }, { field: "annualRevenue", reason: "" }], { turn: 3 });
  assert.deepEqual(r.removed, ["toolingOwnership"]);
  assert.deepEqual(r.skipped, ["annualRevenue"], "a document's figure is never deleted");
  assert.equal(info.toolingOwnership, undefined);
  assert.equal(info.annualRevenue, "$62,400,000");
  const deleted = (info._brokerDeleted as Record<string, any>).toolingOwnership;
  assert.equal(deleted.value, guess);
  assert.match(deleted.note, /Withdrawn by the seller in the interview \(turn 3\)/);
  assert.equal((info._brokerSuppressed as string[] | undefined)?.includes("toolingOwnership") ?? false, false, "an interview answer isn't suppressed — a real document may still fill it");
  // …and the Information tab lists it in the deleted history with the note.
  const view = buildInformationView({ deal: { id: "d", extractedInfo: info, questionnaireData: null, scrapedData: null, industry: null, businessName: "GLP", askingPrice: null } as any, documents: [], sessions: [] } as any);
  const row = view.deleted.find((d: any) => d.key === "toolingOwnership");
  assert.ok(row, "listed under deleted facts");
  assert.match(row!.note!, /Withdrawn by the seller/);
  assert.match(row!.displayValue, /15–18 molds/);

  // A document's value the guess had displaced comes back.
  const info2: Record<string, unknown> = {
    moldCount: "about 300",
    _fieldSources: { moldCount: { source: "interview", sessionId: "s1", turn: 2 } },
    _fieldAlternates: { moldCount: [{ source: "document", documentId: "doc-list", value: "287 molds (tooling list)" }] },
  };
  const r2 = applySellerRetractions(info2, [{ field: "moldCount", reason: "" }], { turn: 3 });
  assert.deepEqual(r2.restoredFromDocument, ["moldCount"]);
  assert.equal(info2.moldCount, "287 molds (tooling list)");
  assert.equal((info2._fieldSources as any).moldCount.documentId, "doc-list");

  // A later turn can't record the guess again — but a real new figure passes.
  assert.equal(restatesWithdrawnValue("15-18 molds owned, 240-250 customer molds", guess, "Rob hasn't sent the list yet."), true);
  assert.equal(restatesWithdrawnValue("22 molds owned per Rob's list", guess, "Rob says 22 are ours."), false);
  assert.equal(restatesWithdrawnValue("15–18 molds owned", guess, "I checked — it really is 15 to 18 owned."), false, "the seller saying it again is new information");

  // The model's retractedFields survive normalisation (strings or objects).
  const norm = normalizeInterviewResponse({ message: "Who at the plant keeps the tooling list?", retractedFields: [{ field: "toolingOwnership", reason: "guess" }, "moldCount", { nope: 1 }] }).response;
  assert.deepEqual(norm.retractedFields, [{ field: "toolingOwnership", reason: "guess" }, { field: "moldCount", reason: "" }]);
  ok("retractions: detected, the seller's own guess removed (history kept, note shown), document values restored, guess can't return");
}

// ── 2. Dates ──
{
  assert.equal(resolveMonthYear(9, "past", TODAY), 2025, "October, past, said in Sep 2026 → Oct 2025");
  assert.equal(resolveMonthYear(4, "future", TODAY), 2027, "May, future → May 2027");
  assert.equal(resolveMonthYear(7, "past", TODAY), 2026, "August, past → Aug 2026");

  const leah =
    "No, knock on wood. The PT and RMT group is pretty stable right now. Leah just got the raise in October after Bowmont tried to poach her, so she's locked in. Priya's been with me since 2016.";
  const c1 = change("practitionerForwardIntentions", "Leah retained after October 2024 Bowmont offer; Priya with the clinic since 2016");
  const conf: Record<string, string> = { practitionerForwardIntentions: "confirmed" };
  const flags = applyDateFidelityGuard([c1], conf, { sellerMessage: leah, today: TODAY });
  assert.equal(flags.length, 1);
  assert.match(c1.newValue, /October 2025/);
  assert.doesNotMatch(c1.newValue, /2024/);
  assert.notEqual(c1.newConfidence, "confirmed");
  assert.equal(conf.practitionerForwardIntentions, "inferred");

  // Live Clearwater replay: a mis-extracted document line elsewhere on file
  // ("salary $124k as of Oct 2024") doesn't ground the model's "October 2024"
  // — the seller's month + tense decide, and the conflict gets verified.
  const cLive = change("practitionerForwardIntentions", "Leah received raise in October 2024 after competing offer from Bowmont");
  const fLive = applyDateFidelityGuard([cLive], {}, { sellerMessage: leah, onFileText: "Leah Kowalczyk (salary $124k as of Oct 2024)", today: TODAY });
  assert.match(cLive.newValue, /October 2025/);
  assert.equal(cLive.newConfidence, "approximate");
  assert.equal(fLive[0].needsVerification, true);

  const dale = "Dale is retiring in 2027. We're promoting him to Assistant Shop Foreman in May to shadow Dale through the transition.";
  const c2 = change("successionPlan", "Kevin Tran promoted to Assistant Shop Foreman May 2025; Dale retiring 2027");
  applyDateFidelityGuard([c2], {}, { sellerMessage: dale, today: TODAY });
  assert.match(c2.newValue, /May 2027/);
  assert.doesNotMatch(c2.newValue, /May 2025/);
  // Seen live (iguards Pacific run): the next turn rewrote the field back to "May 2026".
  const rewrite: FieldChange = {
    ...change("shopSuccessionPlan", "Kevin Tran being promoted to Assistant Shop Foreman in May 2026 to shadow Dale before Dale retires in 2027"),
    previousValue: "Kevin Tran being promoted to Assistant Shop Foreman in May 2027 to shadow Dale before Dale retires in 2027",
    previousConfidence: "inferred",
  };
  applyDateFidelityGuard([rewrite], {}, { sellerMessage: "We also have two battery-electric day cabs on order for mid-2026.", sessionSellerText: dale, today: TODAY });
  assert.match(rewrite.newValue, /May 2027/);
  assert.notEqual(rewrite.newConfidence, "confirmed");
  // "planned for May" (no year) is left alone.
  const c3 = change("successionPlan", "Kevin Tran promotion planned for May; Dale retiring 2027");
  assert.equal(applyDateFidelityGuard([c3], {}, { sellerMessage: dale, today: TODAY }).length, 0);
  assert.equal(c3.newConfidence, "confirmed");

  // A later rewrite can't turn the resolved (inferred) date into a confirmed one.
  const later: FieldChange = { ...change("pharmacistRetentionIntentions", "Mei-Lin received raise March 2026; keen to expand compounding"), previousValue: "Mei-Lin received raise March 2026", previousConfidence: "inferred" };
  const lc: Record<string, string> = {};
  applyDateFidelityGuard([later], lc, { sellerMessage: "She's keen on the Level C room.", onFileText: "Mei-Lin received raise March 2026", today: TODAY });
  assert.equal(later.newConfidence, "inferred");
  assert.equal(lc.pharmacistRetentionIntentions, "inferred");
  // A year nobody said → approximate + verify.
  const c4 = change("keyEmployees", "Dana (office manager) since 2011");
  const f4 = applyDateFidelityGuard([c4], {}, { sellerMessage: "Dana runs the front desk and billing.", today: TODAY });
  assert.equal(f4[0]?.needsVerification, true);
  assert.equal(c4.newConfidence, "approximate");
  // …but a year the seller said, one on file, or a relative one is fine.
  for (const [value, said, onFile] of [
    ["Dana (office manager) since 2011", "Dana's been here since 2011.", ""],
    ["Dana (office manager) since 2011", "Dana runs billing.", "Employee roster: Dana Ruiz, hired 2011"],
    ["Opened second location in 2023", "We opened Seton three years ago.", ""],
    ["Renovated in 2025", "We renovated last year.", ""],
  ] as const) {
    const c = change("x", value);
    assert.equal(applyDateFidelityGuard([c], {}, { sellerMessage: said, onFileText: onFile, today: TODAY }).length, 0, value);
  }
  ok("dates: 'got the raise in October' → October 2025 inferred; 'promoting him in May' → May 2027; invented years downgraded");
}

// ── 3. Legal assertions ──
{
  const draft = "Ontario requires that pharmacy owners be licensed pharmacists. Is that something to flag?";
  assert.deepEqual(findLegalAssertions(draft), ["Ontario requires that pharmacy owners be licensed pharmacists."]);
  const beaconT8 =
    "On the ownership side: Ontario requires that pharmacy owners be licensed pharmacists. Is that a restriction you'd want me to flag prominently for buyers, or is it well understood by anyone who'd be looking at a pharmacy purchase?";
  assert.equal(findLegalAssertions(beaconT8).length, 1);
  assert.equal(findLegalAssertions("Since the Act requires a designated manager, who would that be after closing?").length, 1, "a legal premise inside a question");
  // Seen live in the iguards Beacon run, despite the prompt rule: "only X can…".
  const beaconLive =
    "Understood — I'll note that for Carol to provide. Switching to the buyer side: in Ontario, only a licensed pharmacist can hold majority ownership of a pharmacy. Have you and your broker discussed how that restriction might shape who can realistically buy Beacon?";
  assert.equal(findLegalAssertions(beaconLive).length, 1);
  assert.equal(findLegalAssertions("Ontario restricts pharmacy ownership to licensed pharmacists, which narrows the buyer pool.").length, 1);
  for (const clean of [
    "Are there rules about who can own or hold shares in the pharmacy that a buyer should know about?",
    "Does your licence require renewal each year?",
    "You mentioned the lease requires landlord consent to assign — has the landlord said anything about a sale?",
    "In most provinces the designated manager needs College approval — your broker will confirm the timing. Who would that be?",
  ]) assert.equal(findLegalAssertions(clean).length, 0, clean);

  // The seller agrees with the agent's own legal claim → not confirmed.
  const c = change("ownershipRestriction", "All shareholders must be pharmacists; buyer pool limited to licensed Ontario pharmacists");
  const conf: Record<string, string> = { ownershipRestriction: "confirmed" };
  const flags = applyLegalGroundingGuard([c], conf, beaconT8);
  assert.equal(flags.length, 1);
  assert.equal(c.newConfidence, "inferred");
  assert.equal(conf.ownershipRestriction, "inferred");
  assert.match(flags[0].introducedBy, /Ontario requires/);
  // The same fact with no legal claim from the agent stays confirmed.
  const c2 = change("ownershipRestriction", "All shareholders must be pharmacists");
  assert.equal(applyLegalGroundingGuard([c2], {}, "Who owns the shares today?").length, 0);
  assert.equal(c2.newConfidence, "confirmed");
  ok("legal: the pharmacist-ownership claim is caught, hedged/asked forms pass, the seller's 'yes' to it is not confirmed");
}

// ── 4. Internal machinery ──
{
  const t15 = "On the mandatory probes I need to check off: has your insurer or any consumer protection authority flagged any cargo damage complaint patterns beyond the one reefer excursion claim you mentioned?";
  const t17 = "One item I want to confirm before we wrap up the financial picture: the coverage map shows revenue and EBITDA detail, but I don't have a clear read on working capital needs. What's a typical accounts receivable cycle for you?";
  assert.equal(leaksInternalMachinery(t15), true);
  assert.equal(leaksInternalMachinery(t17), true);
  const s15 = scrubInternalMachinery(t15);
  assert.equal(leaksInternalMachinery(s15), false);
  assert.match(s15, /^Has your insurer/);
  const s17 = scrubInternalMachinery(t17);
  assert.equal(leaksInternalMachinery(s17), false);
  assert.match(s17, /What's a typical accounts receivable cycle/);
  for (const clean of ["Does your safety program have a daily checklist?", "What's your insurance coverage limit?", "Who manages the knowledge in the tool room?"]) {
    assert.equal(leaksInternalMachinery(clean), false, clean);
  }
  ok("machinery: 'mandatory probes' and 'coverage map' are caught and scrubbed; ordinary words aren't");
}

// ── 5. "Why we ask this" must match the question ──
{
  const permitsWhy = "Environmental liabilities can kill deals or require costly remediation escrows — a clean Phase I and straightforward permit profile removes a common due diligence obstacle.";
  assert.equal(whyItMattersFits("We've covered a lot of ground today. Before we wrap, is there anything about the business that you think a buyer needs to understand that we haven't touched on?", permitsWhy, false), false);
  assert.equal(whyItMattersFits("Anything else before we wrap up?", permitsWhy, false), false);
  assert.equal(whyItMattersFits("Is there anything else?", permitsWhy, true), false, "never on a goodbye");
  const recordsQ = "On patient records: in a share sale, the records stay with the corporation. But does ClinicNest have a standard process for ownership transfers, or would there be any data migration involved?";
  const billingWhy = "Direct billing is 62% of revenue — any gap in billing capability during ownership transfer would immediately impact cash flow and patient experience.";
  const prevBillingQ = "On the direct billing side — you're enrolled with five major insurers. In a share sale, do those direct billing credentials transfer automatically to the new owner, or is there a re-enrollment process?";
  assert.equal(whyItMattersFits(recordsQ, billingWhy, false, prevBillingQ), false, "records question, billing rationale (left from the billing question) → dropped");
  // Harvest cases that must be kept: the lead-in sentence names the topic.
  assert.equal(whyItMattersFits("Shifting gears — your documents show the backlog at $4.2M. How does that compare to where you were at the same point last year?", "Backlog trend is the earliest indicator of whether the business is growing — backlog tells buyers what the next 6–12 months look like.", false, "If you can send the MSA language, that'll help?"), true);
  assert.equal(whyItMattersFits("Last question on the security and compliance side: are there any outstanding cyber claims or client disputes?", "Pending cyber claims or client disputes surface in diligence and affect reps and warranties insurance.", false), true, "'Last question on X' is a topic question, not a wrap-up");
  const chartsQ = "Who actually owns the patient records — the clinic corporation, or do individual practitioners retain any ownership of charts for patients they treat?";
  const chartsWhy = "In some practices, associate practitioners claim ownership of charts for patients they personally treat — which could complicate a sale or lead to patient defection.";
  assert.equal(whyItMattersFits(chartsQ, chartsWhy, false), true, "a matching rationale is kept");
  ok("whyItMatters: dropped on wrap-ups, goodbyes and mismatched topics; kept when it fits");
}

// ── 6. Opening: the welcome survives ──
{
  const m = "Thanks for sharing your documents — I've read through them. What's behind the drop in Seton's margin last year?";
  assert.equal(finalizeOpeningMessage(m), m);
  const withPraise = "Welcome, Diane — I've read everything you and Morgan sent. That's an impressive operation. What would you say is the single biggest reason customers choose Great Lakes?";
  assert.equal(finalizeOpeningMessage(withPraise), "Welcome, Diane — I've read everything you and Morgan sent. What would you say is the single biggest reason customers choose Great Lakes?");
  // Seen live (iguards final Clearwater run): "Dr." is not a sentence end, and the purpose line stays.
  const drOpening = "Thanks for taking the time to do this, Dr. Sandhu — I'm here to help build the document buyers will use to evaluate Clearwater, and I've already gone through your questionnaire and financials. One thing that will come up in diligence: has there ever been a complaint filed with the College?";
  assert.equal(finalizeOpeningMessage(drOpening), drOpening);
  // Seen live (iguards Ridgeline run): the model's own greeting must not get a second one.
  const greeted = "Good to meet you, Gord — I've gone through the financials and the call notes. The WIP report shows $3.1M signed but you mentioned $4.2M — is the difference the Westlock job?";
  assert.equal(finalizeOpeningMessage(greeted), greeted);
  const bare = "One area I'd like to fill in: beyond the CWB Division 2 and COR certifications, are there any other permits a buyer would need transferred?";
  assert.match(finalizeOpeningMessage(bare), /^Welcome, and thanks for making time for this\. One area/);
  ok("opening: a greeting is kept (never stripped as filler) and added when missing");
}

// ── 7. Speakers on calls ──
{
  const info: Record<string, unknown> = {
    brakeCondition: "110-ton brake leaking; replacement ~$180K within 2 years",
    backlog: "$4.2M",
    _fieldSources: {
      brakeCondition: { source: "video_call", documentId: "teams-1" },
      backlog: { source: "video_call", documentId: "teams-1" },
    },
  };
  assert.equal(recordFactSpeakers(info, { brakeCondition: "Luis Ortega (operations manager)", backlog: "Gord Halvorsen (seller)", other: "x" }, "teams-1"), 2);
  const docs = [{ id: "teams-1", name: "Teams call.txt", createdAt: new Date("2026-09-10T15:00:00Z"), sourceKind: "video_call", sourceMeta: { platform: "teams", date: "2026-09-10" }, visibility: "seller_visible" }] as any;
  const labels = buildFactSourceLabels(info, docs);
  assert.match(labels.brakeCondition, /said by Luis Ortega \(operations manager\), not the seller/);
  assert.match(labels.brakeCondition, /Luis mentioned/);
  assert.match(labels.brakeCondition, /Teams/);
  assert.doesNotMatch(labels.brakeCondition, /with the seller/);
  assert.match(labels.backlog, /said by the seller/);
  // A minority partner is not the seller; a joint statement names both.
  const info2: Record<string, unknown> = {
    a: "x", b: "y",
    _fieldSources: { a: { source: "video_call", documentId: "teams-1", speaker: "Luis Ortega (operations manager, 15% owner)" }, b: { source: "video_call", documentId: "teams-1", speaker: "Luis Ortega (operations manager) and Gord McAllister (seller)" } },
  };
  const l2 = buildFactSourceLabels(info2, docs);
  assert.match(l2.a, /not the seller \(say "Luis mentioned"/);
  assert.match(l2.b, /said by Luis Ortega \(operations manager\) and Gord McAllister \(seller\)/);
  // No speaker recorded (older extractions): never "with the seller".
  const legacy = { x: "y", _fieldSources: { x: { source: "call", documentId: "teams-1" } } };
  assert.match(buildFactSourceLabels(legacy, docs).x, /speaker not recorded/);
  ok("speakers: a manager's statement on the Teams call is labelled as theirs ('Luis mentioned'), not the seller's");
}

// ── 8. A question to append when a turn still asks nothing ──
{
  assert.equal(fallbackQuestion("Ask whether any ODB billing audit has happened? It matters for buyers.", "compliance"), "Can you tell me whether any ODB billing audit has happened?");
  assert.equal(fallbackQuestion("Has the pharmacy ever had an ODB billing audit? (compliance)", "compliance"), "Has the pharmacy ever had an ODB billing audit?");
  assert.equal(fallbackQuestion("Ask about the pharmacy's prepaid services because buyers inherit them", "operations"), "Could you walk me through the pharmacy's prepaid services?");
  assert.match(fallbackQuestion("", "real_estate"), /\?$/);
  ok("fallback question always ends with a question mark");
}

// ── 9. Round-2 review: ordinary answers aren't retractions; a month's own clause sets its tense ──
{
  for (const s of [
    "When we replace a furnace we take the old units back and recycle them through Enviro-Cycle.",
    "If a customer isn't happy we take it back, no questions asked.",
    "We don't use it in the winter, the patio closes in October.",
    "We don't use them in production anymore since the new press came in.",
    "A lot of customers forget that we do repairs too, not just installs.",
    "We leave them out in the yard over the winter.",
    "I was guessing the weather would hold, but it didn't.",
    "Customers ignore that rule all the time.",
  ]) assert.equal(detectRetraction(s), false, `not a retraction: ${s}`);
  for (const s of [
    "Let me take those mold numbers back — I was guessing.",
    "Scratch that, it's 14 not 12.",
    "I take that back — it's closer to 40.",
    "Actually, don't put that in the book.",
    "Please leave that out of the CIM.",
    "Honestly that was just a guess.",
    "Oh, ignore what I said about the margins.",
  ]) assert.equal(detectRetraction(s), true, `retraction: ${s}`);
  // With no shared words, a long answer never gives up the previous turn's fact.
  const info: Record<string, unknown> = {
    warrantyTerms: "10-year parts, 2-year labour on every install",
    _fieldSources: { warrantyTerms: { source: "interview", sessionId: "s1", turn: 6 } },
  };
  assert.deepEqual(
    guessRetractedFields(info, "Scratch that — I was guessing on the numbers there, honestly, and I'd rather Denise pulls the real warranty sheet before anything goes in the book for buyers.", { sessionId: "s1", turn: 7 }),
    ["warrantyTerms"],
    "shared word (warranty) → it's the one",
  );
  assert.deepEqual(
    guessRetractedFields(info, "Scratch that, I was guessing — Denise pulls those reports every month from the system and she would know exactly, so ask her.", { sessionId: "s1", turn: 7 }),
    [],
    "no shared word in a long message → the model's silence is trusted",
  );
  assert.deepEqual(guessRetractedFields(info, "Scratch that, I was guessing.", { sessionId: "s1", turn: 7 }), ["warrantyTerms"], "a bare withdrawal takes the only fact");

  // Dates: the clause that names the month decides the tense.
  assert.equal(clauseAround("Leah just got the raise in October, so she's staying.", 26).trim(), "Leah just got the raise in October");
  assert.equal(tenseOf("Leah just got the raise in October"), "past");
  const cases: Array<[string, string, RegExp]> = [
    ["Leah just got the raise in October, so she's staying.", "Leah got a raise in October 2025 and is staying", /October 2025/],
    ["We signed the new lease in March and we're expanding the gym side now.", "New lease signed March 2026", /March 2026/],
    ["Sales dipped in January because we're doing fewer installs in winter.", "Sales dipped in January 2026", /January 2026/],
    ["We're promoting him in May, and he's been great.", "Promotion planned May 2025", /May 2027/],
    ["He's getting promoted in May.", "Promotion May 2026", /May 2027/],
    ["We were expecting to open Seton in March, but it slipped.", "Seton opening expected March 2027", /March 2026/],
  ];
  for (const [said, value, want] of cases) {
    const c = change("f", value);
    applyDateFidelityGuard([c], {}, { sellerMessage: said, today: TODAY });
    assert.match(c.newValue, want, `${said} → ${c.newValue}`);
  }
  ok("round 2: 'we take the old units back' / 'we don't use it in the winter' aren't retractions; past clauses stay past next to a present one");
}

console.log(`\n${n} groups passed`);
