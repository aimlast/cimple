// Round-4 interview integrity — offline checks (no database, no AI).
//  1. Learned interview patterns (industry-level, shared by every broker's
//     interviews) never carry another deal's specifics into a prompt —
//     checked when written AND when read.
//  2. A stale seller profile never puts a category the broker's private notes
//     may have produced ("Selling reason: health", "Family involvement:
//     spouse involved") into the prompt; the broker's own settings stay.
//  3. The filler guard keeps working on turns where the seller asked
//     something, without ever stripping the answer.
//  4. One asking price on every broker surface (drifted legacy copies).
//  5. Generic source titles ("Email", "CRM note") don't hide discrepancy sides.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/information/interview-r4.test.ts
import assert from "node:assert/strict";
import { sanitizeInsightItem, sanitizeInsightList, dealSpecificTerms } from "../../server/interview/insight-sanitizer";
import { insightsSafeForPrompt, renderInsightsForPrompt } from "../../server/interview/learning-loop";
import { profileSafeForInterview, PROFILE_PRIVACY_VERSION } from "../../server/interview/eq-profiler";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";
import { stripFillerPreamble, sellerAskedQuestion } from "../../server/interview/turn-guard";
import { privateSourceMatcher } from "../../server/interview/seller-view";
import { brokerFactsView } from "../../server/information/facts";
import { listedAskingPrice, MIRROR_NOTES } from "../../server/information/deal-mirror";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

const baseDeal: any = {
  id: "d1", brokerId: "b1", businessName: "Pierce Dental", industry: "Dental", subIndustry: null, location: "Maple Ridge, BC",
  description: null, questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null, scrapeSource: null,
  sellerProfile: null, sectionImportance: null, interviewOutline: null, interviewPlan: null, askingPrice: null, extractedInfo: {},
};

(async () => {
  // ── 1. Learned patterns: generic only ──
  {
    // The finding's own examples, and the shapes the stored rows really have.
    const leaky = [
      "Team longevity and stability (Maria 9 years, Priya 7 years) — asking how Maria runs the day-to-day built trust",
      "Clarifying the 65%/35% ownership split early avoided confusion",
      "Opening with specific appreciation ('22 years building Northshore Auto Repair across two locations') made the seller forthcoming",
      "The seller proactively praised Maria's scope and Kevin's compensation profile",
      "Location advantages — questions about Harbourfront traffic produced enthusiastic responses",
      "When asked about transition support, seller abruptly shut down with 'I don't know anything else on the business'",
      "The origin story — seller opened up with colourful details about his brother-in-law's divorce",
      "Lease stability — seller volunteered that the landlord already agreed to assignment",
      "Recognising twenty-two years of ownership set a warm tone",
      "Acknowledging and validating strong points encouraged the seller to volunteer more",
      "Providing substantive answers to tax structure questions increased trust",
      "Asking about the ISO audit and TSSA inspections",
      "Kitchener owners respond well to lease questions first",
    ];
    for (const item of leaky) assert.equal(sanitizeInsightItem(item), null, `dropped: ${item}`);

    const generic = [
      "Asking about employees before financials helps owners open up",
      "Framing lease questions around buyer confidence reduces defensiveness",
      "Customer concentration questions often draw deflection; explaining why buyers ask helps",
      "Letting owners tell their origin story before structured questions builds rapport",
      "Owners who run the business passively often defer operational detail to their manager",
      "Explaining the CIM's purpose in plain words reduces anxiety for first-time sellers",
    ];
    for (const item of generic) assert.equal(sanitizeInsightItem(item), item, `kept: ${item}`);

    // Write time: the source deal's own names and terms are refused even in lower case.
    const terms = dealSpecificTerms({
      businessName: "Harbourline Dental Group",
      location: "Kitchener, ON",
      extractedInfo: { keyEmployees: "Maria Lopez (office manager)", suppliers: "Henry Schein" },
      transcript: "We moved to the Harbourfront plaza in 2015. Our hygienists love it here.",
    });
    for (const t of ["maria", "harbourfront", "kitchener", "harbourline dental group", "schein"]) assert.ok(terms.includes(t), `term ${t}`);
    assert.ok(!terms.includes("our") && !terms.includes("we"), "sentence-start function words are not terms");
    assert.equal(sanitizeInsightItem("Asking about the harbourline brand first builds pride", { forbiddenTerms: terms }), null);
    assert.equal(sanitizeInsightItem("Asking about the brand first builds pride", { forbiddenTerms: terms }), "Asking about the brand first builds pride");

    // Read time: a legacy row renders only its generic items; nothing specific survives.
    const legacyRow = {
      effectiveApproaches: [...leaky.slice(0, 4), generic[0]],
      commonStickingPoints: [leaky[5], generic[2]],
      topicsThatBuildTrust: [leaky[4], leaky[6]],
      recommendedQuestionOrder: ["company_story", "team_and_tenure", "technical_constraints_PAL_licenses", "Maria's schedule"],
      sampleCount: 3,
    };
    const block = renderInsightsForPrompt(insightsSafeForPrompt(legacyRow));
    assert.doesNotMatch(block, /Maria|Priya|Kevin|Northshore|Harbourfront|65%|35%|9 years|22 years|twenty|I don't know|divorce|landlord|PAL/);
    assert.match(block, /Asking about employees before financials helps owners open up/);
    assert.match(block, /Customer concentration questions often draw deflection/);
    assert.match(block, /1\. company_story\n2\. team_and_tenure\n?$/, "only generic topic keys, renumbered");
    assert.match(block, /nothing here is about THIS seller or business/);
    // A row with nothing generic left renders no block at all.
    assert.equal(renderInsightsForPrompt(insightsSafeForPrompt({ effectiveApproaches: leaky, sampleCount: 2 })), "");
    // The list helper dedups and caps.
    assert.deepEqual(sanitizeInsightList([generic[0], generic[0], leaky[0], generic[1]]), [generic[0], generic[1]]);
  }
  ok("learned patterns: another deal's names, numbers, places, quotes and story never reach a prompt (write + read)");

  // ── 2. Stale seller profile: no AI-derived category from private notes ──
  {
    const stale: any = {
      communicationStyle: "guarded", emotionalState: "anxious", sellingReason: "health", sophistication: "first_time_seller",
      businessAttachment: "high", timeOrientation: "urgent", familyInvolvement: "spouse_involved",
      sensitiveTopics: ["Heart episode in March"], personalInsights: ["Wife Karen does the books"],
      sellerStory: "Selling after a heart episode.", industryContext: "Dental", confidenceScore: 0.5,
      dataSources: ["broker_notes", "CRM note — call with owner"], generatedAt: "x", privacyVersion: 2,
    };
    const safe = profileSafeForInterview(stale, [])!;
    assert.equal(safe.pendingRebuild, true);
    assert.equal(safe.sellingReason, undefined);
    assert.equal(safe.familyInvolvement, undefined);
    assert.equal(safe.emotionalState, undefined);
    assert.deepEqual(safe.dataSources, []);
    const prompt = renderKnowledgeBaseForPrompt(assembleKnowledgeBase({ ...baseDeal, sellerProfile: stale }, [], [], null, []));
    assert.doesNotMatch(prompt, /Selling reason|health|Family involvement|spouse|heart|Karen|anxious|urgent|CRM note/i);
    assert.match(prompt, /Profile being refreshed/);

    // What the broker set by hand stays (their own instruction to the interview).
    const withOverride: any = {
      ...stale,
      communicationStyle: "direct",
      brokerOverrides: { communicationStyle: { originalValue: "guarded", brokerValue: "direct" }, brokerNotes: "Call after 4pm" },
    };
    const p2 = renderKnowledgeBaseForPrompt(assembleKnowledgeBase({ ...baseDeal, sellerProfile: withOverride }, [], [], null, []));
    assert.match(p2, /- Communication style: direct/);
    assert.doesNotMatch(p2, /Selling reason|Family involvement/);

    // A current profile (built from seller-side sources only) renders in full.
    const current: any = { ...stale, sellingReason: "retirement", familyInvolvement: "solo_operator", privacyVersion: PROFILE_PRIVACY_VERSION, sourceDocumentIds: [], sensitiveTopics: [], personalInsights: [], sellerStory: "Built the clinic over years." };
    const p3 = renderKnowledgeBaseForPrompt(assembleKnowledgeBase({ ...baseDeal, sellerProfile: current }, [], [], null, []));
    assert.match(p3, /- Selling reason: retirement/);
    assert.match(p3, /- Family involvement: solo_operator/);
    assert.doesNotMatch(p3, /Profile being refreshed/);
    // A current profile read from a row the broker has since made private is stale again.
    const p4 = renderKnowledgeBaseForPrompt(assembleKnowledgeBase(
      { ...baseDeal, sellerProfile: { ...current, sourceDocumentIds: ["e1"] } },
      [{ id: "e1", name: "Email", visibility: "broker_only", sourceKind: "email", sourceMeta: null, createdAt: new Date() } as any], [], null, [],
    ));
    assert.doesNotMatch(p4, /Selling reason|Family involvement/);
  }
  ok("stale profiles: every AI-derived category is dropped until rebuilt; the broker's own settings stay");

  // ── 3. Filler guard on question turns ──
  {
    assert.equal(sellerAskedQuestion("you do have my asking price down correctly, right?"), true);
    assert.equal(sellerAskedQuestion("Is my price realistic? What do you think it's worth?"), true);
    assert.equal(sellerAskedQuestion("Why do you need that?"), true);
    assert.equal(sellerAskedQuestion("We did about $1.2M last year, maybe $1.3M? I'd have to check."), false, "a hedged figure isn't a question");
    assert.equal(sellerAskedQuestion("No questions from me."), false);

    const ask = "you do have my asking price down correctly, right?";
    // The answer is never stripped (the round-3 regression).
    assert.equal(
      stripFillerPreamble("Yes — $2.3 million, noted as firm. What's the lease situation?", { sellerMessage: ask }),
      "Yes — $2.3 million, noted as firm. What's the lease situation?",
    );
    // Praise of the question goes; the answer stays.
    assert.equal(
      stripFillerPreamble("Good questions. Yes — $2.3 million, noted as firm. What's the lease situation?", { sellerMessage: ask }),
      "Yes — $2.3 million, noted as firm. What's the lease situation?",
    );
    assert.equal(
      stripFillerPreamble("Great question — yes, $2.3 million is what I have. How many chairs do you run?", { sellerMessage: ask }),
      "Yes, $2.3 million is what I have. How many chairs do you run?",
    );
    // A grade after the answer goes (the backstop now works on question turns).
    assert.equal(
      stripFillerPreamble("Yes — $2.3 million, noted as firm. That's a strong number for a practice like yours. What's the lease situation?", { sellerMessage: ask }),
      "Yes — $2.3 million, noted as firm. What's the lease situation?",
    );
    // A recap opener that answers nothing goes.
    assert.equal(
      stripFillerPreamble("That's a healthy margin. How long is left on the lease?", { sellerMessage: "What's next?" }),
      "How long is left on the lease?",
    );
    // A praise-shaped sentence that IS the answer stays (it shares the seller's words).
    assert.equal(
      stripFillerPreamble("Buyers love a strong recall program, so it's worth documenting. What share of patients are on recall?", { sellerMessage: "Do buyers care about recall programs?" }),
      "Buyers love a strong recall program, so it's worth documenting. What share of patients are on recall?",
    );
    // An answer that starts like one stays even with praise words in it.
    assert.equal(
      stripFillerPreamble("No — that's a solid position either way, and your broker will advise on price. What's the lease term?", { sellerMessage: "Is my price too high?" }),
      "No — that's a solid position either way, and your broker will advise on price. What's the lease term?",
    );
    // "Why?" — the explanation is the answer even when it sounds like filler…
    assert.equal(
      stripFillerPreamble("Buyers want to see who runs the day-to-day without you. Who handles scheduling today?", { sellerMessage: "Why do you need that?" }),
      "Buyers want to see who runs the day-to-day without you. Who handles scheduling today?",
    );
    // …but a grade after it still goes.
    assert.equal(
      stripFillerPreamble("Great question. Buyers want to see who runs the day-to-day without you. That's a strong setup. Who handles scheduling today?", { sellerMessage: "Why do you need that?" }),
      "Buyers want to see who runs the day-to-day without you. Who handles scheduling today?",
    );
    // A two-sentence answer then a paragraph break: kept exactly once, as written
    // (a live turn once duplicated the second sentence).
    const twoSentence =
      "Your broker shared only business context. Nothing about your health or family was passed along.\n\nOn Dr. Rao's agreement — is there a non-compete?";
    assert.equal(stripFillerPreamble(twoSentence, { sellerMessage: "What did my broker tell you about my health?" }), twoSentence);
    // A grade between the answer and the question goes; the paragraph break stays.
    assert.equal(
      stripFillerPreamble("Yes — 60 days either way.\n\nThat's a solid arrangement. Is there a non-compete?", { sellerMessage: "You have Dr. Rao's notice period, right?" }),
      "Yes — 60 days either way.\n\nIs there a non-compete?",
    );
    // "Got it — X is confirmed." reports the recording, it doesn't clarify (seen live).
    assert.equal(
      stripFillerPreamble("Got it — $8,417 is confirmed. Which figure is right for 2024?", { sellerMessage: "Yes, 8,417 is right. What else do you need from me?" }),
      "Which figure is right for 2024?",
    );
    assert.equal(stripFillerPreamble("Noted, the lease renewal is recorded. Who owns the equipment?"), "Who owns the equipment?");
    // …unless the seller asked whether it's on file: then that sentence is the answer.
    assert.equal(
      stripFillerPreamble("Noted — $2.3 million is on file. What's the lease term?", { sellerMessage: "Do you have my price?" }),
      "Noted — $2.3 million is on file. What's the lease term?",
    );
    // …while a real confirmation question-lead stays.
    assert.equal(
      stripFillerPreamble("Just to confirm, the $8,417 includes TMI. Does it?", { sellerMessage: "Yes. What else?" }),
      "Just to confirm, the $8,417 includes TMI. Does it?",
    );
    // A hedged figure is not a question → the full opener guard applies.
    assert.equal(
      stripFillerPreamble("Got it. That's a solid number. How many staff do you have?", { sellerMessage: "About $1.2M, maybe $1.3M? I'd have to check." }),
      "How many staff do you have?",
    );
    // Unchanged behaviour without a seller message (opening turn).
    assert.equal(stripFillerPreamble("Great. What does the practice do?"), "What does the practice do?");
    assert.equal(stripFillerPreamble("That sounds like a tough year. How did revenue hold up?"), "That sounds like a tough year. How did revenue hold up?");
  }
  ok("filler guard: question turns keep the answer, lose praise-of-question and recap/grade sentences");

  // ── 4. One asking price on every broker surface ──
  {
    // A legacy deal: the column drifted from the broker's fact on file.
    const drifted: any = {
      ...baseDeal,
      askingPrice: "$950,000",
      extractedInfo: { askingPrice: "$900,000", _fieldSources: { askingPrice: { source: "broker", note: MIRROR_NOTES.valuation } } },
    };
    const view = brokerFactsView(drifted);
    assert.equal(view.askingPrice, "$900,000", "GET /api/deals/:id serves the lined-up column");
    assert.equal(listedAskingPrice(drifted), "$900,000", "CIM / matching / buyer dashboard");
    assert.equal(listedAskingPrice(view), "$900,000");
    assert.equal(drifted.askingPrice, "$950,000", "reading never writes");
    // Column only, seller's figure on file → the column is the broker's price everywhere.
    const colOnly: any = { ...baseDeal, askingPrice: "$950,000", extractedInfo: { askingPrice: "$1.2M", _fieldSources: { askingPrice: { source: "interview" } } } };
    assert.equal(brokerFactsView(colOnly).askingPrice, "$950,000");
    assert.equal((brokerFactsView(colOnly).extractedInfo as any).askingPrice, "$950,000");
    assert.equal(listedAskingPrice(colOnly), "$950,000");
    // The broker deleted the fact; a leftover column copy is gone on every surface.
    const deleted: any = { ...baseDeal, askingPrice: "$950,000", extractedInfo: { _brokerSuppressed: ["askingPrice"] } };
    assert.equal(brokerFactsView(deleted).askingPrice, null);
    assert.equal(listedAskingPrice(deleted), null);
  }
  ok("asking price: GET deal, Valuation input, Information tab, list, readiness and CIM agree (no write on read)");

  // ── 5. Generic source titles don't hide discrepancy sides ──
  {
    const docs: any[] = [
      { id: "e1", name: "Email", visibility: "broker_only", sourceKind: "email", sourceMeta: null, createdAt: new Date() },
      { id: "c1", name: "CRM note", visibility: "broker_only", sourceKind: "crm", sourceMeta: null, createdAt: new Date() },
      { id: "c2", name: "CRM note — call with owner", visibility: "broker_only", sourceKind: "crm", sourceMeta: null, createdAt: new Date() },
      { id: "pl", name: "2024 P&L.pdf", visibility: "shared", sourceKind: "document", sourceMeta: null, createdAt: new Date() },
    ];
    const names = privateSourceMatcher(docs);
    assert.equal(names("Revenue from email campaigns $120K — 2024 P&L.pdf"), false, "the word 'email' in a value is not the source");
    assert.equal(names("Owner said in a CRM note style memo… — Questionnaire"), false);
    assert.equal(names("$1.6M — Email"), true, "a side whose label IS the generic private title");
    assert.equal(names("$1.6M — CRM note"), true);
    assert.equal(names("$1.6M floor — CRM note — call with owner"), true, "a distinctive private title anywhere");
    assert.equal(names("$1.82M — 2024 P&L.pdf"), false);

    const discrepancies: any[] = [
      { id: "x1", field: "marketingSpend", status: "ask_seller", interviewValue: "Email marketing $40K — Questionnaire", documentValue: "$55K — 2024 P&L.pdf", documentId: "pl", severity: "minor", aiExplanation: "Email marketing spend differs", suggestedResolution: "Ask which is right" },
      { id: "x2", field: "askingPrice", status: "ask_seller", interviewValue: "$2.1M — Questionnaire", documentValue: "$1.6M — CRM note", documentId: null, severity: "significant", aiExplanation: "CRM floor $1.6M", suggestedResolution: "Ask" },
    ];
    const kb = assembleKnowledgeBase({ ...baseDeal }, docs, [], null, discrepancies);
    const [a, b] = kb.askSellerDiscrepancies;
    assert.equal(a.valueA, "Email marketing $40K — Questionnaire", "an unrelated side stays");
    assert.equal(a.valueB, "$55K — 2024 P&L.pdf");
    assert.equal(a.explanation, "Email marketing spend differs");
    assert.equal(b.valueB, null, "the private side is still withheld");
    assert.equal(b.explanation, null);
    const prompt = renderKnowledgeBaseForPrompt(kb);
    assert.doesNotMatch(prompt, /1\.6M|CRM floor/);
  }
  ok("discrepancy sides: generic titles only count as the side's own source label");

  console.log(`\n${n} groups passed`);
})().catch((e) => { console.error(e); process.exit(1); });
