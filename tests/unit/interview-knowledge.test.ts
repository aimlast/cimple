// Interview knowledge & completion (QA-harvest "iknow" batch) — offline checks
// with a mocked model: no database, no AI.
//  1. Re-ask guard: a question for a fact the seller gave (any session) is
//     rewritten; earlier-session answers and source text count.
//  2. Conflicts between seller-visible sources reach the prompt (never a
//     broker-only side) and go on the ledger.
//  3. Broker-only material in a routed discrepancy never reaches the prompt.
//  4. Completion governance: critical items, seller-only topics, critical
//     conflicts and flagged risks block a self-initiated end; stops still win.
//  5. Flagged risks and source digests from seller-visible sources only.
//  6. Tasks: no duplicates, no request for a document on file, offers become requests.
//  7. Earlier sessions become a digest; the "prior session" is really prior.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/interview-knowledge.test.ts
import assert from "node:assert/strict";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";
import { findReasks, applyReaskGuard, keyTokens } from "../../server/interview/reask-guard";
import { detectAlternateConflicts, valuesMateriallyDiffer, buildFlaggedRisks, searchSourcesFor, buildPriorExchanges, splitList, crossSourceFigureConflicts } from "../../server/interview/source-context";
import { validateReviewConflicts } from "../../server/interview/source-review";
import { completionBlockers } from "../../server/interview/completion-gaps";
import { governCompletion } from "../../server/interview/turn-guard";
import { planTaskWrites, detectDocumentOffer, documentOnFileFor } from "../../server/interview/task-writes";
import { mintSourceItems, applyLedgerToKb, exchangesOf } from "../../server/interview/session-manager";
import { deferralTopicStrings, updateDeferralLedger } from "../../server/interview/deferral-ledger";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

const baseDeal: any = {
  id: "d1", brokerId: "b1", businessName: "Great Lakes Plastics", industry: "Manufacturing", subIndustry: "Injection molding", location: "Grand Rapids, MI",
  description: null, questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null, scrapeSource: null,
  sellerProfile: null, sectionImportance: null, interviewOutline: null, interviewPlan: null, askingPrice: null, extractedInfo: {},
  interviewSourceReview: null,
};
const doc = (o: Record<string, unknown>): any => ({
  name: "doc", visibility: "shared", sourceKind: "document", sourceMeta: null, createdAt: new Date("2026-03-03T12:00:00Z"),
  category: "other", subcategory: null, status: "processed", isProcessed: true, extractedText: null, extractedData: null, ...o,
});
const session = (o: Record<string, unknown>): any => ({
  dealId: "d1", participantId: "s", extractedInfo: {}, status: "completed", questionsAsked: 1, questionsAnswered: 1, questionsSkipped: 0,
  startedAt: new Date("2026-09-01T10:00:00Z"), lastActivityAt: new Date("2026-09-01T11:00:00Z"), completedAt: null, messages: [], ...o,
});
const toolResponse = (input: Record<string, unknown>) => ({ content: [{ type: "tool_use", id: "t", name: "interview_response", input }], stop_reason: "tool_use" });
const reply = (message: string, extra: Record<string, unknown> = {}) => ({
  message, suggestedAnswers: ["a"], extractedFields: {}, newTasks: [], shouldEnd: false,
  reasoning: { currentTopic: "", topicStatus: "exploring", newDeferrals: [], resolvedDeferrals: [], plannedTopics: [], priorCheck: "", nextIntent: "", industryContext: { identified: false, industry: "", subIndustry: "", location: "", activeIndustryTopics: [], coveredIndustryTopics: [], regulatoryNotes: [] } },
  ...extra,
});

(async () => {
  // ── 1. Re-ask guard (mocked model) ──
  {
    assert.deepEqual(keyTokens("evVsIceSplit"), ["ev", "ice"]);
    const info: any = {
      evVsIceSplit: "70% EV platforms / 30% ICE",
      _fieldSources: { evVsIceSplit: { source: "interview", sessionId: "s1", turn: 14 } },
    };
    const priorQA = [{ question: "How is the business split between EV and ICE programs?", answer: "About 70% EV platforms and 30% ICE now", where: "in session 1" }];
    const findings = findReasks("What's your EV vs ICE split?", { sellerMessage: "We run two shifts.", info, documents: [], priorQA });
    assert.ok(findings.some((f) => f.kind === "fact" && /evVsIceSplit/.test(f.detail)), "the on-file fact is named");
    // A delta question is not a re-ask.
    assert.equal(findReasks("Has the EV vs ICE split shifted this year?", { sellerMessage: "ok", info, documents: [], priorQA }).filter((f) => f.kind === "fact").length, 0);

    const calls: any[] = [];
    const fake: any = { messages: { create: async (p: any) => { calls.push(p); return toolResponse(reply("Which resin grades are hardest to source right now?")); } } };
    const draft: any = reply("What's your EV vs ICE split?", { extractedFields: { shifts: { value: "two shifts", confidence: "confirmed", source: "seller_statement", basis: "verbatim" } } });
    const out = await applyReaskGuard(fake, { model: "m", maxTokens: 10, temperature: 1, system: [], messages: [{ role: "user", content: "We run two shifts." }] }, draft, { sellerMessage: "We run two shifts.", info, documents: [], priorQA });
    assert.equal(out.recalled, true, "the corrective re-call fires");
    assert.equal(calls.length, 1);
    const correction = calls[0].messages[calls[0].messages.length - 1].content;
    assert.match(correction, /evVsIceSplit: 70% EV/);
    assert.doesNotMatch(out.response.message, /EV vs ICE/i, "the final message doesn't ask it");
    assert.ok(out.response.extractedFields.shifts, "the draft's extraction is kept");
    // Nothing to fix → no call.
    const none = await applyReaskGuard(fake, { model: "m", maxTokens: 10, temperature: 1, system: [], messages: [] }, reply("Which resin grades are hardest to source?") as any, { sellerMessage: "x", info, documents: [], priorQA });
    assert.equal(none.recalled, false);
    assert.equal(calls.length, 1);
  }
  ok("re-ask guard: a question for a fact the seller gave in session 1 is rewritten (mocked model)");

  {
    // An earlier session's question, reworded.
    const priorQA = [{ question: "Which resin suppliers do you buy from, and how concentrated is that?", answer: "Mostly Midland Polymers and Keystone Resins, about 60/40", where: "in session 1" }];
    const f = findReasks("Which resin suppliers do you buy from today?", { sellerMessage: "Fine.", info: {}, documents: [], priorQA });
    assert.ok(f.some((x) => x.kind === "prior_question"), "a question answered in an earlier session is caught");
    // A deferral-like answer can be followed up.
    const deferred = findReasks("Which resin suppliers do you buy from today?", { sellerMessage: "Fine.", info: {}, documents: [], priorQA: [{ ...priorQA[0], answer: "Not sure, I'd have to check with purchasing" }] });
    assert.equal(deferred.filter((x) => x.kind === "prior_question").length, 0);
  }
  ok("re-ask guard: earlier-session questions the seller answered are not asked again (deferrals may be followed up)");

  {
    const docs = [
      doc({ id: "z1", name: "Zoom working session", sourceKind: "video_call", extractedText: "Owner: We had one College complaint in 2023, it was dismissed. New patients mostly come from physician referrals." }),
      doc({ id: "p1", name: "CRM note — private", sourceKind: "crm", visibility: "broker_only", extractedText: "Owner said there were two College complaints about billing." }),
    ];
    const hit = searchSourcesFor("Any College complaints?", docs);
    assert.ok(hit && hit.docName === "Zoom working session", "the seller-visible transcript answers it");
    assert.match(hit!.snippet, /College complaint in 2023/);
    const f = findReasks("Have there been any College complaints?", { sellerMessage: "Staff are licensed.", info: {}, documents: docs, priorQA: [] });
    assert.ok(f.some((x) => x.kind === "source_text" && /Zoom working session already says/.test(x.detail)));
    // Only the broker-only note has it → never searched.
    const onlyPrivate = searchSourcesFor("Any College complaints?", [docs[1]]);
    assert.equal(onlyPrivate, null, "a broker-only row is never searched");
    // A compound question: one clause is answered by the org chart.
    const org = [doc({ id: "o", name: "Organizational chart", extractedText: "Headcount by function\nPlant manager and shift supervisors6\nPress operators and packers112\nSetup and process technicians22\nMaterial handling, shipping and receiving18" })];
    const compound = searchSourcesFor("Shifting to workforce structure: how is your headcount split across the three shifts, and roughly how many of those 212 are operators versus setup techs versus other roles?", org);
    assert.ok(compound && /Setup and process technicians22/.test(compound.snippet), "the org chart answers the role split");
    // A weaker match (a rare word next to a figure) is only a candidate: the answer check decides.
    assert.ok(findReasks("How many operators do you have on third shift?", { sellerMessage: "x", info: {}, documents: org, priorQA: [] }).every((f) => f.verify), "only a candidate for the answer check");
    assert.equal(searchSourcesFor("What would a market-rate CEO cost a buyer?", org), null);
    // A reply that already cites the source is fine.
    assert.equal(findReasks("The Zoom call mentions one College complaint in 2023 — has anything come up since?", { sellerMessage: "x", info: {}, documents: docs, priorQA: [] }).filter((x) => x.kind === "source_text").length, 0);

    const calls: any[] = [];
    const fake: any = { messages: { create: async (p: any) => { calls.push(p); return toolResponse(reply("The Zoom call mentions one College complaint in 2023 that was dismissed — anything since?")); } } };
    const out = await applyReaskGuard(fake, { model: "m", maxTokens: 10, temperature: 1, system: [], messages: [{ role: "user", content: "Staff are licensed." }] }, reply("Any College complaints?") as any, { sellerMessage: "Staff are licensed.", info: {}, documents: docs, priorQA: [] }, async () => new Set(["1"]));
    assert.equal(out.recalled, true);
    assert.match(calls[0].messages.at(-1).content, /already says .*College complaint in 2023/);
    assert.match(out.response.message, /Zoom call mentions/);
  }
  ok("re-ask guard: a question a seller-visible source already answers triggers a citing re-call; broker-only text is never searched");

  {
    // A figure the seller just gave that a document contradicts.
    const info: any = { fleetSize: "24 service vans", _fieldSources: { fleetSize: { source: "document", documentId: "f1" } } };
    const docs = [doc({ id: "f1", name: "Fleet list (24 service vans + 2 owner vehicles)" })];
    const f = findReasks("How old is the fleet on average?", {
      sellerMessage: "We've got 26 trucks.", info, documents: docs, priorQA: [],
      extractedFields: { fleetSize: { value: "26 trucks", confidence: "confirmed", source: "seller_statement" } as any },
    });
    assert.ok(f.some((x) => x.kind === "conflict" && /26 trucks/.test(x.detail) && /Fleet list/.test(x.detail)));
  }
  {
    // Across facts: the seller's figure vs a document's passage on the same thing.
    const docs = [
      doc({ id: "cc", name: "Comfort Club membership report", extractedText: "Comfort Club membership report as of March 31, 2025. 2,900 active members across 8 cities in the Greater Hamilton area. 214 suspended members (payment declined) are not counted." }),
      doc({ id: "fl", name: "Fleet list", extractedText: "Fleet list as of March 31, 2025: 24 service vans assigned to technicians, plus 2 owner vehicles excluded from the sale." }),
      doc({ id: "tc", name: "Discovery call", sourceKind: "call", extractedText: "Tony: we've got 3,100 members in the Comfort Club." }),
    ];
    const members = findReasks("How do members renew?", { sellerMessage: "We've got about 3,100 members in the Comfort Club right now.", info: {}, documents: docs, priorQA: [] });
    assert.ok(members.some((f) => f.kind === "conflict" && /3,100 member/.test(f.detail) && /2,900 active members/.test(f.detail)), "members");
    const trucks = findReasks("How old is the fleet?", { sellerMessage: "We run 26 trucks, all branded, most of them Ford Transits.", info: {}, documents: docs, priorQA: [] });
    assert.ok(trucks.some((f) => f.kind === "conflict" && /Fleet list/.test(f.detail)), "trucks vs service vans");
    // Agreement, or a draft that already reconciles, is fine.
    assert.equal(findReasks("How do members renew?", { sellerMessage: "About 2,900 active members.", info: {}, documents: docs, priorQA: [] }).filter((f) => f.kind === "conflict").length, 0);
    assert.equal(findReasks("The membership report shows 2,900 active — which is right?", { sellerMessage: "We've got about 3,100 members in the Comfort Club.", info: {}, documents: docs, priorQA: [] }).filter((f) => f.kind === "conflict").length, 0);
  }
  {
    // Not conflicts: a bare percentage, and a sub-count of a roster.
    const roster = [doc({ id: "dr", name: "Driver roster summary 2024", extractedText: "96 active company drivers (82 full-time, 14 part-time). Linehaul: 38 drivers. City: 26 drivers. 18.0% annual turnover rate in 2024, down from 21%. 24 drivers with 10+ years of service." })];
    const quiet = (msg: string) => findReasks("What's next?", { sellerMessage: msg, info: {}, documents: roster, priorQA: [] }).filter((f) => f.kind === "conflict").length;
    assert.equal(quiet("Our CVSA out-of-service rate in 2024 was 9.4%, which is below average."), 0);
    assert.equal(quiet("Average tenure is 6.7 years, 24 drivers over 10 years."), 0);
  }
  ok("re-ask guard: a figure the seller says that a document gives differently (another fact) is reconciled now");

  // ── 2. Conflicts between sources ──
  {
    assert.ok(valuesMateriallyDiffer("comfortClubMembers", "3,100", "2,900 active + 214 suspended"));
    assert.ok(valuesMateriallyDiffer("customerConcentration", "about 18%", "22%"));
    assert.ok(valuesMateriallyDiffer("maplecrestShare", "a quarter", "41%"));
    assert.ok(valuesMateriallyDiffer("leaseExpiry", "lease runs to 2034", "Lease expires August 31, 2029"));
    assert.ok(!valuesMateriallyDiffer("annualRevenue", "$31M", "$31,020,000"), "rounding is not a conflict");
    assert.ok(!valuesMateriallyDiffer("leaseExpiry", "Hillhurst: May 31, 2027; Seton: August 31, 2031", "May 31, 2027"), "one side listing more dates");
    assert.ok(!valuesMateriallyDiffer("fullTimeCount", "3 employee clinicians plus 5 admin", "8 employees on payroll (owner + 2 lead PTs + 5 admin)"), "the same count told two ways");
    assert.ok(!valuesMateriallyDiffer("employees", "212 employees plus 12-15 temporary workers depending on week", "16 employees in quality department"), "a subset is not a conflict");
    assert.ok(!valuesMateriallyDiffer("totalDebt", "$7,960,000 at December 31, 2024", "$9,340,000", { b: "Form 1120-S — tax year 2023" }), "different periods");
    assert.ok(valuesMateriallyDiffer("fleetSize", "26 trucks", "24 service vans"));

    const docs = [
      doc({ id: "call1", name: "Discovery call with Tony", sourceKind: "call" }),
      doc({ id: "rep1", name: "Comfort Club membership report" }),
      doc({ id: "crm1", name: "CRM note — valuation meeting", sourceKind: "crm", visibility: "broker_only" }),
    ];
    const info: any = {
      comfortClubMembers: "3,100",
      revenue2024: "$4.1M",
      _fieldSources: { comfortClubMembers: { source: "call", documentId: "call1" }, revenue2024: { source: "document", documentId: "rep1" } },
      _fieldAlternates: {
        comfortClubMembers: [{ value: "2,900 active + 214 suspended", source: "document", documentId: "rep1" }],
        revenue2024: [{ value: "about $2.4M", source: "crm", documentId: "crm1" }],
      },
    };
    const deal = { ...baseDeal, industry: "Home Services", businessName: "Lakeshore Home Comfort", extractedInfo: info };
    const kb = assembleKnowledgeBase(deal, docs, [], null, []);
    assert.equal(kb.sourceConflicts!.length, 1);
    const prompt = renderKnowledgeBaseForPrompt(kb);
    assert.match(prompt, /CONFLICTS TO RECONCILE/);
    assert.match(prompt, /reconcile comfortClubMembers: "3,100" \(said on a call \(Mar 3, 2026\)\) vs "2,900 active \+ 214 suspended" \(document: Comfort Club membership report\)/);
    assert.doesNotMatch(prompt, /2\.4M/, "a broker-only alternate never appears");
    assert.match(prompt, /comfortClubMembers: 3,100 .*BUT document: Comfort Club membership report says "2,900 active \+ 214 suspended": in conflict, not settled/);
    const ledger = mintSourceItems([], kb, 0);
    assert.ok(ledger.some((e) => e.topic === "reconcile comfortClubMembers" && e.origin === "source" && e.status === "open"));
    assert.deepEqual(deferralTopicStrings(ledger), [], "source items are not shown as deferrals");
    // Once the agent resolves it, it leaves the block.
    const resolved = updateDeferralLedger(ledger, [], ["reconcile comfortClubMembers"], 3);
    applyLedgerToKb(kb, resolved);
    assert.equal(kb.sourceConflicts!.length, 0);
    assert.equal(mintSourceItems(resolved, { sourceConflicts: [{ key: "comfortClubMembers", topic: "", values: [], critical: false, origin: "alternates" }], flaggedRisks: [] }, 4).length, resolved.length, "never re-minted");

    // Document vs document (another fiscal year) is not a seller conflict.
    const yearly: any = { rental: "$154,000", _fieldSources: { rental: { source: "document", documentId: "rep1" } }, _fieldAlternates: { rental: [{ value: "$161,000", source: "document", documentId: "rep1" }] } };
    assert.equal(detectAlternateConflicts(yearly, docs).length, 0);
  }
  ok("conflicts: seller-visible said-vs-written values render as CONFLICTS TO RECONCILE with both sources and go on the ledger; broker-only sides never do");

  {
    const input = "FACTS:\n- backlog: $4.2M [said on a call]\nSOURCES:\n### document: WIP report (WIP report)\nsummary: signed backlog $3.1M";
    const good = validateReviewConflicts([{ key: "backlog", topic: "backlog", critical: true, a: { value: "$4.2M", source: "said on a call" }, b: { value: "$3.1M signed", source: "document: WIP report" } }], input);
    assert.equal(good.length, 1);
    const invented = validateReviewConflicts([{ key: "backlog", topic: "backlog", critical: true, a: { value: "$4.2M", source: "call" }, b: { value: "$2.9M", source: "WIP" } }], input);
    assert.equal(invented.length, 0, "a figure not in the sources is dropped");
    const input2 = [
      "FACTS ON FILE (key: value [source]):",
      "- employees: 212 employees plus temps [said on a call (Jan 21, 2025)]",
      "- totalDebt: $7,960,000 at December 31, 2024 [an email (Mar 18, 2025)]",
      "- customerConcentration: around 18% [said on a call (Nov 12, 2025)]",
      "SOURCES:",
      "### document: FY2024 statements (FY2024 statements)\nsummary: 401(k) match $286,400; top customer 22% of FY2024 revenue; 112 press operators",
      "### document: Form 1120-S — tax year 2023 (Form 1120-S — tax year 2023)\nsummary: total debt $9,340,000",
    ].join("\n");
    const v = (a: any, b: any, key = "k") => validateReviewConflicts([{ key, topic: key, critical: true, a, b }], input2).length;
    assert.equal(v({ value: "212 employees", source: "said on a call (Jan 21, 2025)" }, { value: "401(k) match suggests about 112 employees", source: "document: FY2024 statements" }), 0, "an inferred value is dropped");
    assert.equal(v({ value: "$7,960,000 at December 31, 2024", source: "an email (Mar 18, 2025)" }, { value: "$9,340,000", source: "document: Form 1120-S — tax year 2023" }), 0, "different periods are two facts");
    assert.equal(v({ value: "around 18%", source: "said on a call (Nov 12, 2025)" }, { value: "22% of FY2024 revenue", source: "document: FY2024 statements" }), 1, "a call's date is not a period");
    assert.equal(v({ value: "around 18%", source: "said on a call (Nov 12, 2025)" }, { value: "212 employees", source: "document: FY2024 statements" }), 0, "a figure its own source doesn't state is dropped");
    const input3 = [
      "- ebitda: $1,398,000 (2024) [said on a call (Jun 5, 2025)]",
      "- setonProfit: Seton breaks even, pays its own way [said on a video call (Feb 10, 2026)]",
      "- sde: $690,000 [the broker]",
      "### document: Location P&L (Location P&L)\nsummary: Seton FY2024 location EBITDA -$23,751; $1,398,000 group EBITDA; SDE $606,100",
    ].join("\n");
    const v3 = (a: any, b: any) => validateReviewConflicts([{ key: "k", topic: "k", critical: true, a, b }], input3).length;
    assert.equal(v3({ value: "$1,398,000", source: "said on a call (Jun 5, 2025)" }, { value: "$1,398,000 (2024)", source: "document: Location P&L" }), 0, "the same figure is agreement");
    assert.equal(v3({ value: "$690,000", source: "the broker" }, { value: "$606,100", source: "document: Location P&L" }), 0, "the broker's value is settled");
    assert.equal(v3({ value: "Seton breaks even", source: "said on a video call (Feb 10, 2026)" }, { value: "Seton location EBITDA -$23,751", source: "document: Location P&L" }), 1, "a claim a document's figure contradicts");
  }
  ok("source review: conflicts whose figures aren't in the seller-visible input are dropped");

  {
    const docs = [
      doc({ id: "e", name: "Email — follow-up", sourceKind: "email", extractedData: { summary: "Recap of the intro call", keyFacts: "Seller (Harjit): Alderbrook estimated at under 20% of revenue, 150 employees" } }),
      doc({ id: "r", name: "Customer revenue by year", extractedData: { summary: "Top customer Alderbrook Grocery representing 22% of revenue in FY2024", keyFacts: "Alderbrook 22.0% of FY2024 revenue" } }),
      doc({ id: "x", name: "CRM note", sourceKind: "crm", visibility: "broker_only", extractedData: { keyFacts: "Alderbrook maybe 15% of revenue" } }),
      doc({ id: "m", name: "Minute book", extractedData: { keyFacts: "Gord McAllister 85% voting shares" } }),
      doc({ id: "e2", name: "Email — ROFR", sourceKind: "email", extractedData: { keyFacts: "Luis will not exercise the ROFR if Gord sells 100% of the shares" } }),
    ];
    const found = crossSourceFigureConflicts(docs);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0].key, "alderbrookShare");
    assert.match(found[0].values[0].value, /under 20%/);
    assert.match(found[0].values[1].source, /Customer revenue by year/);
    assert.ok(!JSON.stringify(found).includes("15%"), "a broker-only CRM note never counts");
  }
  ok("cross-source: a figure said on a call or in an email that a document gives differently for the same named thing is a conflict");

  // ── 3. Broker-only material in a routed discrepancy ──
  {
    const docs = [
      doc({ id: "roster", name: "Staff roster with technician licences" }),
      doc({ id: "crmx", name: "CRM note — site visit", sourceKind: "crm", visibility: "broker_only" }),
    ];
    const discrepancies: any[] = [
      { id: "a", field: "employeeCount", status: "ask_seller", interviewValue: "28 total — Staff roster with technician licences", documentValue: "36 total employees (per broker note)", documentId: null, severity: "significant", aiExplanation: "The broker recast shows 36", suggestedResolution: "Ask which is right", sideSources: null },
      { id: "b", field: "sde", status: "ask_seller", interviewValue: "$1.5M", documentValue: "$1.31M", documentId: null, severity: "critical", aiExplanation: "Different SDE", suggestedResolution: "Ask", sideSources: { interview: { kind: "call" }, document: { kind: "crm", brokerOnly: true } } },
      { id: "c", field: "leaseExpiry", status: "ask_seller", interviewValue: "2034 — said on a call", documentValue: "2029 — Staff roster with technician licences", documentId: "roster", severity: "minor", aiExplanation: "Lease end differs", suggestedResolution: "Ask", sideSources: null },
    ];
    const kb = assembleKnowledgeBase({ ...baseDeal }, docs, [], null, discrepancies);
    const [a, b, c] = kb.askSellerDiscrepancies!;
    assert.equal(a.valueB, null);
    assert.equal(a.explanation, null);
    assert.equal(b.valueB, null, "sideSources.brokerOnly hides the side");
    assert.equal(c.valueB, "2029 — Staff roster with technician licences", "a seller-visible document still renders");
    const prompt = renderKnowledgeBaseForPrompt(kb);
    assert.match(prompt, /held privately by the broker/);
    assert.doesNotMatch(prompt, /broker note|recast|site visit|1\.31M/i);
  }
  ok("routed discrepancies: a broker-only side (sideSources or 'per broker note' text) and its explanation never reach the prompt");

  // ── 4. Completion governance ──
  {
    const cov = (key: string, status: any, importance: any, fields: any[] = []) => ({ key, title: key, order: 1, status, importance, importanceReason: "", fields });
    const sections: any[] = [
      cov("overview", "well_covered", "critical"),
      cov("real_estate", "partial", "critical", [
        { fieldName: "leaseDetails", value: "Leased plant, 52,000 sq ft", confidence: "inferred" },
        { fieldName: "roofCondition", label: "Roof age and condition", value: null, confidence: "unknown", industrySpecific: true, critical: true },
      ]),
    ];
    const info: any = {
      reasonForSale: "Retiring", transitionPlan: "Stay 12 months", ownerCompensation: "$240K salary", addbacks: "Truck, one-time legal", saleType: "Share sale",
      ownerInvolvement: "Runs sales only",
      _fieldSources: Object.fromEntries(["reasonForSale", "transitionPlan", "ownerCompensation", "addbacks", "saleType", "ownerInvolvement"].map((k) => [k, { source: "interview" }])),
    };
    const blockers = completionBlockers({ sectionCoverage: sections, criticalSections: new Set(["overview"]), info, ledger: [], exchanges: [] });
    assert.deepEqual(blockers, ["real_estate: Roof age and condition (record under roofCondition)"]);
    const v = governCompletion({ shouldEnd: true, sellerMessage: "That covers the plant.", userTurnCount: 21, sectionCoverage: sections, deferredTopics: [], minTurnsBeforeEnd: 10, blockingItems: blockers });
    assert.equal(v.allowEnd, false);
    assert.match(v.blockReason!, /Roof age and condition/);
    assert.match(v.continuationInstruction!, /start with: real_estate: Roof age/);
    // Deferred → no longer blocking.
    const deferred = completionBlockers({ sectionCoverage: sections, criticalSections: new Set(["overview"]), info, ledger: updateDeferralLedger([], [{ topic: "roofCondition", reason: "needs the inspection report", whereInfoLives: "facilities manager" }], [], 20), exchanges: [] });
    assert.deepEqual(deferred, []);
    assert.equal(governCompletion({ shouldEnd: true, sellerMessage: "ok", userTurnCount: 21, sectionCoverage: sections, deferredTopics: [], minTurnsBeforeEnd: 10, blockingItems: deferred }).allowEnd, true);

    // Seller-only topics: a document's figure doesn't count, a conversation does.
    const docOnly: any = { ownerCompensation: "$180K T4", _fieldSources: { ownerCompensation: { source: "document" } } };
    const b2 = completionBlockers({ sectionCoverage: [], criticalSections: new Set(), info: docOnly, ledger: [], exchanges: [{ question: "Why are you selling now?", answer: "I'm 67 and want to retire while it's strong" }] });
    assert.ok(b2.includes("seller-only topic: owner pay and perks"));
    assert.ok(!b2.includes("seller-only topic: reason for sale"), "discussed in an exchange");

    // An open critical conflict blocks at turn 20; a stop still wins; a second stop is a forced end (governance skipped).
    const conflicts: any[] = [{ key: "annualRevenue", topic: "annual revenue", values: [{ value: "$2.3M", source: "said on a call" }, { value: "$1.82M", source: "document: P&L" }], critical: true, origin: "alternates" }];
    const ledger = mintSourceItems([], { sourceConflicts: conflicts, flaggedRisks: [] }, 0);
    const b3 = completionBlockers({ sectionCoverage: [], criticalSections: new Set(), info, ledger, exchanges: [], conflicts });
    assert.ok(b3[0].startsWith("reconcile annualRevenue"));
    assert.equal(governCompletion({ shouldEnd: true, sellerMessage: "Anything else?", userTurnCount: 20, sectionCoverage: [], deferredTopics: [], minTurnsBeforeEnd: 10, blockingItems: b3 }).allowEnd, false);
    assert.equal(governCompletion({ shouldEnd: true, sellerMessage: "I have to run, let's continue later", userTurnCount: 20, sectionCoverage: [], deferredTopics: [], minTurnsBeforeEnd: 10, blockingItems: b3, sellerStopDetected: true }).allowEnd, true, "the seller's stop wins");
  }
  ok("governance: an uncaptured critical item, a seller-only topic without the seller, or an open critical conflict blocks a self-initiated end; deferrals clear it; a stop still wins");

  // ── 5. Flagged risks + digests ──
  {
    assert.deepEqual(splitList("Customer concentration (22% from one customer), Related party rent ($410,000 due), wrongful dismissal claim"), [
      "Customer concentration (22% from one customer)", "Related party rent ($410,000 due)", "wrongful dismissal claim",
    ]);
    const docs = [
      doc({ id: "v", name: "Zoom working session", sourceKind: "video_call", extractedData: { summary: "Working session on fleet and customers", keyFacts: "71 power units", redFlags: "Alderbrook MSA allows 90-day termination for convenience; shop foreman retiring 2027", sellerConcerns: "Worried a buyer closes the warehouse" } }),
      doc({ id: "c", name: "CRM note — process", sourceKind: "crm", visibility: "broker_only", extractedData: { summary: "private", redFlags: "Harvest Lane matter must stay out of materials" } }),
      doc({ id: "l", name: "Warehouse lease", extractedData: { summary: "15-year lease", redFlags: "None identified - this is a sample/fictional demonstration document" } }),
    ];
    const risks = buildFlaggedRisks(docs);
    assert.ok(risks.some((r) => /Alderbrook MSA allows 90-day termination/.test(r.text)));
    assert.ok(!risks.some((r) => /Harvest Lane/.test(r.text)), "broker-only red flags never render");
    assert.ok(!risks.some((r) => /fictional/.test(r.text)));
    const kb = assembleKnowledgeBase({ ...baseDeal, industry: "Transportation" }, docs, [], null, []);
    const prompt = renderKnowledgeBaseForPrompt(kb);
    assert.match(prompt, /RISKS FLAGGED IN THE SOURCES[\s\S]*Alderbrook MSA allows 90-day termination/);
    assert.match(prompt, /Zoom working session \(video-call transcript, Mar 3, 2026\)[\s\S]*Says: Working session on fleet/);
    assert.doesNotMatch(prompt, /Harvest Lane|CRM note — process/);
  }
  ok("risks + digests: seller-visible red flags and summaries render; broker-only rows never do");

  // ── 6. Tasks ──
  {
    const t = (o: any) => ({ type: "document_request", title: "", description: "", relatedField: "", sellerExplanation: "", ...o });
    const first = planTaskWrites({ newTasks: [t({ title: "Get Larkspur MSA change-of-control clause language" })], existing: [], documents: [], answeredKeys: new Set(), resolvedTopics: [], sellerMessage: "x" });
    assert.equal(first.create.length, 1);
    const existing: any[] = [{ id: "t1", type: "document_request", title: "Get Larkspur MSA change-of-control clause language", description: "", relatedField: null, status: "pending" }];
    const second = planTaskWrites({ newTasks: [t({ title: "Obtain Larkspur MSA change of control clause" })], existing, documents: [], answeredKeys: new Set(), resolvedTopics: [], sellerMessage: "x" });
    assert.equal(second.create.length, 0, "the same request on the next turn creates nothing");
    const docs: any[] = [doc({ id: "cc", name: "Comfort Club membership report" })];
    const onFile = planTaskWrites({ newTasks: [t({ title: "Get Comfort Club membership report" })], existing: [], documents: docs, answeredKeys: new Set(), resolvedTopics: [], sellerMessage: "x" });
    assert.equal(onFile.create.length, 0);
    assert.equal(onFile.dropped[0].documentName, "Comfort Club membership report");
    assert.ok(documentOnFileFor("Upload the fleet list", docs) === null);
    assert.equal(detectDocumentOffer("Want me to have Morgan send over the template agreement?"), "the template agreement");
    assert.equal(detectDocumentOffer("I can get you the exact audit date from Mark if you need it."), null, "information, not a document");
    assert.equal(detectDocumentOffer("I'll have Kyle email the tooling spreadsheet."), "the tooling spreadsheet");
    const offer = planTaskWrites({ newTasks: [], existing: [], documents: [], answeredKeys: new Set(), resolvedTopics: [], sellerMessage: "Want me to have Morgan send over the template agreement?" });
    assert.equal(offer.create.length, 1);
    assert.equal(offer.create[0].type, "document_request");
    assert.match(offer.create[0].title, /template agreement/);
    // Closing: answered field, or the agent resolved it.
    const closing = planTaskWrites({
      newTasks: [], documents: [], sellerMessage: "x", answeredKeys: new Set(["leaseExpiry"]),
      existing: [{ id: "a", type: "follow_up", title: "Confirm lease expiry", relatedField: "leaseExpiry", description: "", status: "pending", createdBy: "ai_interview" }, ...existing.map((e) => ({ ...e, createdBy: "ai_interview" }))],
      resolvedTopics: ["Larkspur MSA change-of-control clause"],
    });
    assert.deepEqual(closing.close.sort(), ["a", "t1"]);
    // Duplicates earlier turns created are removed (the oldest stays); a
    // request closes when its document arrives, not when the field has a value.
    const dupes: any[] = [0, 1, 2].map((i) => ({ id: `d${i}`, type: "document_request", title: "Get complete tooling list from Rob Kline", description: "", relatedField: "toolingOwnership", status: "pending", createdBy: "ai_interview", createdAt: new Date(2026, 8, 1 + i) }));
    const dd = planTaskWrites({ newTasks: [], existing: dupes, documents: [], answeredKeys: new Set(["toolingOwnership"]), resolvedTopics: [], sellerMessage: "x" });
    assert.deepEqual(dd.remove.sort(), ["d1", "d2"]);
    assert.deepEqual(dd.close, [], "a field value doesn't close a document request");
    const arrived = planTaskWrites({ newTasks: [], existing: [dupes[0]], documents: [doc({ id: "tl", name: "Complete tooling list (Rob Kline)" })], answeredKeys: new Set(), resolvedTopics: [], sellerMessage: "x" });
    assert.deepEqual(arrived.close, ["d0"], "the document arrived");
  }
  ok("tasks: duplicates merge, requests for documents on file are dropped, offered documents become requests, answered/resolved follow-ups close");

  // ── 7. Earlier sessions ──
  {
    const s1 = session({ id: "s1", messages: [
      { role: "ai", content: "Welcome. How is revenue split between EV and ICE programs?", timestamp: "t" },
      { role: "user", content: "About 70% EV, 30% ICE", timestamp: "t" },
      { role: "ai", content: "Who are your main resin suppliers?", timestamp: "t" },
      { role: "user", content: "Midland Polymers and Keystone Resins", timestamp: "t" },
    ] });
    const s2 = session({ id: "s2", status: "active", startedAt: new Date("2026-09-10T10:00:00Z"), lastActivityAt: new Date("2026-09-10T10:05:00Z"), messages: [{ role: "ai", content: "Welcome back — what's the roof's age?", timestamp: "t" }] });
    const ex = buildPriorExchanges([s2, s1], "s2");
    assert.equal(ex.length, 2);
    assert.equal(ex[0].question, "How is revenue split between EV and ICE programs?");
    const kb = assembleKnowledgeBase({ ...baseDeal }, [], [], s2, [], { sessions: [s1, s2], currentSessionId: "s2" });
    assert.equal(kb.priorSessionSummary?.sessionId, "s1", "the prior session is really the prior one");
    const prompt = renderKnowledgeBaseForPrompt(kb);
    assert.match(prompt, /PREVIOUS SESSIONS — ALREADY DISCUSSED[\s\S]*\[session 1\] Q: Who are your main resin suppliers\? → A: Midland Polymers/);
    // Legacy call (no extras): the current session is not called "prior".
    assert.equal(assembleKnowledgeBase({ ...baseDeal }, [], [], s2, []).priorSessionSummary, null);
    assert.equal(exchangesOf(s1.messages).length, 2);
  }
  ok("earlier sessions: a digest of questions and answers; the prior-session block describes the real prior session");

  console.log(`\n${n} groups passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
