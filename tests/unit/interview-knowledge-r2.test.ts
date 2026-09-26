// Interview knowledge & completion — round 2 (QA-harvest "iknow"): the
// checker's open findings, offline with mocked models (no database, no AI).
//  1. Privacy: a settled discrepancy never carries the broker's private
//     material (CRM notes, the broker's recast) into the interview prompt.
//  2. Governance: source-minted agenda items are not deferrals; a deferral or
//     "resolved" parked in the goodbye message doesn't count; a flagged risk
//     is covered only when its material point was asked.
//  3. Tasks: years and qualifiers matter; the broker's own tasks are never
//     closed or rewritten by the interview.
//  4. Re-ask guard: reworded earlier questions, long rewordings of a fact on
//     file, broad keys, a subject already answered in an earlier answer;
//     source-text candidates only stop a question once confirmed.
//  5. Conflicts: no false conflicts (roster rows, reported vs adjusted, an
//     older period vs now, inferred values); said-vs-written claims found
//     mechanically (backlog, owner pay, concentration, tenure); a conflict
//     the broker settled isn't re-opened.
//  6. Streaming: a re-asked question is stopped before the seller sees it.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/interview-knowledge-r2.test.ts
import assert from "node:assert/strict";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt, settledByBroker } from "../../server/interview/knowledge-base";
import { findReasks, confirmFindings, priorQAFromSessions } from "../../server/interview/reask-guard";
import { valuesMateriallyDiffer, searchSourcesFor, spokenFigureConflicts, dealAsOfYear, differentMeasure } from "../../server/interview/source-context";
import { validateReviewConflicts } from "../../server/interview/source-review";
import { claimConflicts } from "../../server/interview/claim-conflicts";
import { completionBlockers, riskDiscussed, itemDiscussed } from "../../server/interview/completion-gaps";
import { governCompletion, callInterviewWithRecovery } from "../../server/interview/turn-guard";
import { planTaskWrites, documentOnFileFor } from "../../server/interview/task-writes";
import { mintSourceItems, financialCoreGaps, sectionDeferred, createMessageRelease } from "../../server/interview/session-manager";
import { updateDeferralLedger, agentDeferrals } from "../../server/interview/deferral-ledger";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

const baseDeal: any = {
  id: "d1", brokerId: "b1", businessName: "Lakeshore Home Comfort", industry: "Home Services", subIndustry: "HVAC", location: "Hamilton, ON",
  description: null, questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null, scrapeSource: null,
  sellerProfile: null, sectionImportance: null, interviewOutline: null, interviewPlan: null, askingPrice: null, extractedInfo: {},
  interviewSourceReview: null,
};
const doc = (o: Record<string, unknown>): any => ({
  name: "doc", visibility: "shared", sourceKind: "document", sourceMeta: null, createdAt: new Date("2026-03-03T12:00:00Z"),
  category: "other", subcategory: null, status: "processed", isProcessed: true, extractedText: null, extractedData: null, ...o,
});
const disc = (o: Record<string, unknown>): any => ({
  id: `x${Math.random()}`, dealId: "d1", field: "f", factKey: null, factYear: null, interviewValue: null, documentValue: null, documentId: null, documentName: null,
  severity: "significant", category: "financial", source: "financial_analysis", sideSources: null, aiExplanation: null, suggestedResolution: null,
  status: "resolved", sellerResponse: null, brokerNotes: null, resolvedValue: null, resolvedAt: null, resolvedBy: null, createdAt: new Date(), ...o,
});

(async () => {
  // ── 1. Privacy of settled discrepancies ──
  {
    const docs = [
      doc({ id: "crm1", name: "CRM note - valuation meeting, list price agreed", sourceKind: "crm", visibility: "broker_only" }),
      doc({ id: "crm2", name: "CRM note — Working session takeaways", sourceKind: "crm", visibility: "broker_only" }),
      doc({ id: "lease", name: "Shop lease - 240 Bayfront Commerce Drive" }),
    ];
    const rows = [
      // Legacy row (no side_sources): the private side is found by its document.
      disc({ field: "Owner's claimed SDE vs calculated SDE", interviewValue: "Approximately $1,500,000 owner benefit", documentValue: "FY24 SDE $1,312K per broker recast", documentId: "crm1", documentName: "CRM note - valuation meeting, list price agreed", resolvedValue: "$1,312,000 FY2024 SDE (adjusted EBITDA $917,000 + owner add-backs $395,000)" }),
      disc({ field: "2024 Adjusted EBITDA", interviewValue: "$4.1M (Manpreet's initial calculation)", documentValue: "$3.9M (broker normalized)", documentId: "crm2", resolvedValue: "$3,900,000" }),
      // Public final value, one private losing value ("per broker note").
      disc({ field: "Lease expiry and renewal options", interviewValue: "Owner thinks lease is '2030 + 5' (incorrect per broker note)", documentValue: "10-year term to Aug 31, 2028, one 5-year renewal", documentId: "lease", resolvedValue: "Lease expires August 31, 2028, with one 5-year renewal option" }),
      // New-style row: side_sources says the document side is broker-only.
      disc({ field: "Backlog", factKey: "backlog", interviewValue: "$4.2M", documentValue: "$3.1M", sideSources: { document: { kind: "document", brokerOnly: true } }, resolvedValue: "$3.1M signed" }),
      // Entirely public: shown in full.
      disc({ field: "Comfort Club active member count", interviewValue: "3,100 members", documentValue: "2,900 active members as of March 31, 2025", resolvedValue: "2,900 active members at March 31, 2025" }),
    ];
    const kb = assembleKnowledgeBase(baseDeal, docs, [], null, rows);
    const prompt = renderKnowledgeBaseForPrompt(kb);
    const settled = prompt.slice(prompt.indexOf("## SETTLED BY THE BROKER"));
    for (const bad of [/recast/i, /broker note/i, /per broker/i, /broker normali/i, /1,312/, /\$3\.9M|3,900,000/, /395,000/, /2030 \+ 5/, /\$3\.1M/]) {
      assert.ok(!bad.test(prompt), `prompt must not contain ${bad}`);
    }
    assert.match(settled, /Owner's claimed SDE vs calculated SDE: settled by the broker \(the final figure is with the broker/);
    assert.match(settled, /2024 Adjusted EBITDA: settled by the broker/);
    assert.match(settled, /Lease expiry and renewal options: Lease expires August 31, 2028[^\n]*replaces "10-year term/);
    assert.match(settled, /Comfort Club active member count: 2,900 active members at March 31, 2025 — replaces "3,100 members"/);
    assert.ok(!("backlog" in (kb.extractedInfo as any)), "a private final value is never overlaid onto the facts");
  }
  ok("privacy: settled discrepancies never carry CRM/recast material or a private final figure into the prompt; public ones still render");

  // ── 2. Governance ──
  {
    // Source-minted risks are not deferrals: a missing revenue figure still counts.
    const risks: any[] = [{ label: "Some market revenue is cash", text: "Some market revenue is cash", sources: ["Intro call"] }, { label: "COVID 2020 sales dropped", text: "COVID 2020 sales dropped 40%", sources: ["Intro call"] }];
    const ledger = mintSourceItems([], { sourceConflicts: [], flaggedRisks: risks }, 0);
    assert.equal(ledger.length, 2);
    assert.equal(agentDeferrals(ledger).length, 0);
    assert.equal(sectionDeferred("financials", ledger), false, "a risk mentioning revenue is not a deferred Financial Summary");
    assert.deepEqual(financialCoreGaps({}, ledger).length, 3, "the checkpoint still fires");
    const deferred = updateDeferralLedger(ledger, [{ topic: "annual revenue", reason: "accountant has the P&L", whereInfoLives: "accountant" }], [], 5);
    assert.equal(sectionDeferred("financials", deferred), true);
    assert.equal(financialCoreGaps({}, deferred).length, 2, "a real deferral satisfies revenue");
    // Minting never overwrites an agent deferral whose label contains the same words.
    const agent = updateDeferralLedger([], [{ topic: "revenue", reason: "seller will check", whereInfoLives: "bookkeeper" }], [], 3);
    const minted = mintSourceItems(agent, { sourceConflicts: [], flaggedRisks: [{ label: "Some market revenue is cash", text: "x", sources: ["a"] }] }, 4);
    assert.equal(minted.find((e) => e.topic === "revenue")!.reason, "seller will check");
    assert.ok(minted.some((e) => e.topic === "risk: Some market revenue is cash" && e.origin === "source"));
  }
  {
    // A risk parked in the goodbye message is not covered; a risk the last question asked about is.
    const risks: any[] = [{ label: "Seton location operating at a loss", text: "Seton location operating at negative EBITDA (-$23,751) after overhead allocation", sources: ["Location P&L"] }];
    const ledger0 = mintSourceItems([], { sourceConflicts: [], flaggedRisks: risks }, 0);
    const info: any = { reasonForSale: "Retiring", transitionPlan: "Stay a year", ownerCompensation: "$180K salary", addbacks: "Truck, legal", saleType: "Share sale", ownerInvolvement: "Runs sales", _fieldSources: Object.fromEntries(["reasonForSale", "transitionPlan", "ownerCompensation", "addbacks", "saleType", "ownerInvolvement"].map((k) => [k, { source: "interview" }])) };
    const goodbye = updateDeferralLedger(ledger0, [{ topic: "risk: Seton location operating at a loss", reason: "broker to follow up", whereInfoLives: "Dana" }], [], 12);
    const base = { sectionCoverage: [], criticalSections: new Set<string>(), info, exchanges: [], risks };
    const parked = completionBlockers({ ...base, ledger: goodbye, now: { turn: 12, lastQuestion: "How many new patients did Hillhurst see last month?", sellerMessage: "About 90." } });
    assert.deepEqual(parked, ["risk: Seton location operating at a loss"], "parked in the goodbye → still blocking");
    const v = governCompletion({ shouldEnd: true, sellerMessage: "About 90.", userTurnCount: 12, sectionCoverage: [], deferredTopics: [], minTurnsBeforeEnd: 10, blockingItems: parked });
    assert.equal(v.allowEnd, false);
    assert.match(v.continuationInstruction!, /Seton location operating at a loss/);
    const asked = completionBlockers({ ...base, ledger: goodbye, now: { turn: 12, lastQuestion: "Is the Seton location operating at a loss once overhead is allocated?", sellerMessage: "I'd rather Dana walk you through it." } });
    assert.deepEqual(asked, [], "deferred on the turn it was asked → covered");
    const earlier = completionBlockers({ ...base, ledger: goodbye, now: { turn: 13, lastQuestion: "x", sellerMessage: "y" } });
    assert.deepEqual(earlier, [], "a deferral from an earlier turn counts");
    // The same for a "resolved" claimed in the goodbye.
    const resolvedNow = updateDeferralLedger(ledger0, [], ["risk: Seton location operating at a loss"], 12);
    assert.equal(completionBlockers({ ...base, ledger: resolvedNow, now: { turn: 12, lastQuestion: "Anything else?", sellerMessage: "No" } }).length, 1);
  }
  {
    const risk: any = { label: "Alderbrook 22% of revenue with 90-day termination clause", text: "Alderbrook MSA (22% of revenue) allows 90-day termination for convenience", sources: ["Zoom"] };
    assert.equal(riskDiscussed([{ question: "Alderbrook is at 22% of revenue in the statements but under 20% on the call — which is right?", answer: "22% is right, I was going from memory" }], risk), false, "the share is not the termination right");
    assert.equal(riskDiscussed([{ question: "Alderbrook's MSA lets them terminate on 90 days' notice — has that ever come up, and how do you protect against it?", answer: "They've never used it; we renewed to 2030" }], risk), true);
    assert.equal(itemDiscussed([{ question: "Are any of your lanes touching California, and is the fleet CARB-compliant?", answer: "We don't run California at all" }], "Any emissions deadlines (CARB, etc.)", "emissionsDeadlines"), true);
    assert.equal(itemDiscussed([{ question: "How old is the fleet?", answer: "Average about six years" }], "Any emissions deadlines (CARB, etc.)", "emissionsDeadlines"), false);
    const cov: any[] = [{ key: "permits_licenses", title: "Permits & Licenses", order: 1, status: "partial", importance: "critical", importanceReason: "", fields: [{ fieldName: "emissionsDeadlines", label: "Any emissions deadlines (CARB, etc.)", value: null, confidence: "unknown", industrySpecific: true, critical: true }] }];
    const b = completionBlockers({ sectionCoverage: cov, criticalSections: new Set(), info: {}, ledger: [], exchanges: [{ question: "Are any of your lanes touching California, and is the fleet CARB-compliant?", answer: "We don't run California at all" }] });
    assert.ok(!b.some((x) => /emissions/.test(x)), "a checklist item the seller already spoke to is not re-demanded");
  }
  ok("governance: agenda items aren't deferrals; goodbye-parked items still block; risks need their material point; discussed checklist items count");

  // ── 3. Tasks ──
  {
    const docs: any[] = [
      doc({ id: "f23", name: "Compiled financial statements FY2023" }),
      doc({ id: "t23", name: "T2 corporate tax return 2023 (client copy)" }),
      doc({ id: "cc", name: "Comfort Club membership report" }),
    ];
    assert.equal(documentOnFileFor("Upload the 2024 financial statements", docs), null, "2023 statements are not the 2024 ones");
    assert.equal(documentOnFileFor("Get 2024 T2 corporate tax return", docs), null);
    assert.equal(documentOnFileFor("Comfort Club cancellation report", docs), null, "a qualifier the file lacks");
    assert.equal(documentOnFileFor("Get Comfort Club membership report", docs)?.id, "cc");
    assert.equal(documentOnFileFor("Upload the FY2023 financial statements", docs)?.id, "f23");
    const t = (o: any) => ({ type: "document_request", title: "", description: "", relatedField: "", sellerExplanation: "", ...o });
    const planned = planTaskWrites({ newTasks: [t({ title: "Upload the 2024 financial statements" })], existing: [], documents: docs, answeredKeys: new Set(), resolvedTopics: [], sellerMessage: "x" });
    assert.equal(planned.create.length, 1);
    assert.equal(planned.dropped.length, 0);
    // The broker's own tasks: never closed, never rewritten.
    const brokerTasks: any[] = [
      { id: "b1", type: "follow_up", title: "Confirm lease expiry", relatedField: "leaseExpiry", description: "broker's note", status: "pending", createdBy: "broker" },
      { id: "b2", type: "document_request", title: "Get Comfort Club membership report", relatedField: null, description: "", status: "pending", createdBy: "broker" },
      { id: "a1", type: "follow_up", title: "Confirm lease renewal option", relatedField: "leaseExpiry", description: "", status: "pending", createdBy: "ai_interview" },
    ];
    const p = planTaskWrites({ newTasks: [t({ type: "follow_up", title: "Confirm lease expiry", description: "new AI text", relatedField: "leaseExpiry" })], existing: brokerTasks, documents: docs, answeredKeys: new Set(["leaseExpiry"]), resolvedTopics: ["Confirm lease expiry"], sellerMessage: "x" });
    assert.deepEqual(p.close, ["a1"], "only the interview's own task closes");
    assert.deepEqual(p.update, [], "a broker task's description is never rewritten");
  }
  ok("tasks: years and qualifiers must match a document on file; the broker's own tasks are never closed or rewritten");

  // ── 4. Re-ask guard ──
  {
    const priorQA = [
      { question: "Last area I want to cover: are any of your lanes or equipment touching California, and if so, is the fleet CARB-compliant for the current emissions deadlines?", answer: "We don't run California — our lanes are BC, occasionally into Washington State.", where: "in session 1" },
      { question: "On the mandatory probes I need to check off: has your insurer or any consumer protection authority (BBB, BC Consumer Protection, Transport Canada complaint line) flagged any cargo damage complaint patterns or shipper complaints?", answer: "No patterns, no flags from the insurer or anyone else.", where: "in session 1" },
      { question: "On the automotive side, what does your current platform exposure look like? Specifically, how much of your automotive revenue is tied to EV programs versus traditional ICE vehicles?", answer: "EV is still small for us — maybe 10–12% of automotive revenue, mostly connector housings.", where: "in session 1" },
      { question: "Has any other deferred maintenance surfaced on the building?", answer: "The roof is the big one. The chillers were replaced in 2021, the cleanroom HVAC was all new in 2023 when we did the expansion, and the electrical service was upgraded in 2019.", where: "in session 3" },
    ];
    const kinds = (draft: string, extra: any = {}) => findReasks(draft, { sellerMessage: "Sure.", info: {}, documents: [], priorQA, ...extra }).map((f) => f.kind);
    assert.ok(kinds("Are any of your lanes touching California, and is the fleet CARB-compliant?").includes("prior_question"), "CARB reworded");
    assert.ok(kinds("Has your insurer or the BBB flagged any complaint patterns?").includes("prior_question"), "BBB, shorter");
    assert.ok(kinds("Roughly what percentage of your automotive revenue is tied to EV platforms versus traditional ICE drivetrains versus parts that are platform-agnostic?").includes("prior_question"), "EV/ICE, longer");
    const hvac = findReasks("How old is the HVAC system in the cleanroom, and when was it last replaced?", { sellerMessage: "ok", info: {}, documents: [], priorQA });
    assert.ok(hvac.some((f) => f.kind === "prior_question" && /cleanroom HVAC was all new in 2023/.test(f.detail) && f.verify), "a subject answered inside an earlier answer (verified)");
    assert.deepEqual(kinds("How many press operators work the third shift?"), [], "a new question");
    assert.deepEqual(kinds("Has the EV share changed since last year?"), [], "a delta question");

    // Facts: a long rewording of a fact on file; broad and year-specific keys don't fire.
    const info: any = {
      evVsIceSplit: "EV approximately 10–12% of automotive revenue (mostly Northgate connector housings); the rest ICE platforms",
      revenue2024: "$31,020,000", insurance: "$1,140,000 total premiums (fleet & cargo)",
      _fieldSources: { evVsIceSplit: { source: "interview" }, revenue2024: { source: "document" }, insurance: { source: "document" } },
    };
    // (Strong matches — the ones that stand without the answer check; since
    // round V weaker fact matches are candidates the check decides.)
    const facts = (draft: string) => findReasks(draft, { sellerMessage: "ok", info, documents: [], priorQA: [] }).filter((f) => f.kind === "fact" && (!f.verify || f.fallback)).length;
    assert.equal(facts("Roughly what percentage of your automotive revenue is tied to EV platforms versus traditional ICE drivetrains?"), 1);
    assert.equal(facts("What was your revenue in 2025 so far?"), 0, "another year");
    assert.equal(facts("What's the deductible on your cargo insurance?"), 0, "a facet of a one-word key");
  }
  {
    // Source text: question lines in a transcript answer nothing; a word shared with a clinic's files isn't enough.
    const transcript = doc({ id: "z", name: "Zoom working session", sourceKind: "video_call", extractedText: "[00:02:08] Morgan Ellis: Are the warehouse workers employees on your payroll, or temps?\n[00:02:15] Morgan Ellis: The warehouse is maybe twenty percent of revenue, but it's growing fastest." });
    assert.equal(searchSourcesFor("On the warehouse side: are the warehouse workers employees on your payroll, or do you use temp agency staff for the floor?", [transcript]), null);
    const clinic = [doc({ id: "c", name: "Zoom", sourceKind: "video_call", extractedText: 'Interested buyers sign an NDA before they see the full version. "Calgary physio clinic, two locations" narrows it down pretty quickly.' })];
    assert.equal(searchSourcesFor("How many clinicians do you have at each location?", clinic), null, "clinic is not clinician");
    const minute = [doc({ id: "m", name: "Minute book", extractedText: "The foregoing resolutions were consented to in writing by all of the directors and remain in full force and effect, unamended." })];
    assert.equal(searchSourcesFor("On the wrongful dismissal lawsuit: is that fully resolved now — no appeal, no tail — or is there anything still open?", minute), null);
    const lease = [doc({ id: "e", name: "Email thread", sourceKind: "email", extractedText: "1. Hillhurst lease. The term ends May 31, 2027. Your one five-year renewal has to be exercised in writing between Aug 31 and Nov 30, 2026." })];
    assert.match(searchSourcesFor("When does the Hillhurst lease come up for renewal?", lease)!.snippet, /Hillhurst lease\. The term ends May 31, 2027/);
    const patients = [doc({ id: "p", name: "Zoom", sourceKind: "video_call", extractedText: "There's a spine surgeon's office that sends post-op patients. But most new patients now come from online search and reviews." })];
    assert.ok(searchSourcesFor("Where do most of your new patients come from?", patients));
    // Candidates only stop a question once confirmed.
    const found = findReasks("Where do most of your new patients come from?", { sellerMessage: "ok", info: {}, documents: patients, priorQA: [] });
    assert.ok(found.length === 1 && found[0].kind === "source_text" && found[0].verify);
    assert.equal((await confirmFindings(found, "Where do most of your new patients come from?", async () => new Set())).length, 0, "not confirmed → the question goes out");
    assert.equal((await confirmFindings(found, "Where do most of your new patients come from?", async () => null)).length, 0, "verifier failed → nothing confirmed");
    const seen: any[] = [];
    const kept = await confirmFindings(found, "Where do most of your new patients come from?", async (q, c) => { seen.push({ q, c }); return new Set(["1"]); });
    assert.equal(kept.length, 1);
    assert.match(seen[0].c[0].text, /online search and reviews/);
    // Sure findings need no verification.
    const sure = [{ kind: "fact" as const, detail: "x" }];
    assert.equal((await confirmFindings(sure, "q?", async () => { throw new Error("must not be called"); })).length, 1);
  }
  {
    // priorQAFromSessions: every earlier session, full answers, not the current one.
    const s = (id: string, startedAt: string, messages: any[]) => ({ id, startedAt, messages });
    const qa = priorQAFromSessions([
      s("b", "2026-02-01", [{ role: "ai", content: "What drove 2024?" }, { role: "user", content: "x ".repeat(300) }]),
      s("a", "2026-01-01", [{ role: "ai", content: "Hi. Who runs the plant?" }, { role: "user", content: "Rob does." }]),
      s("cur", "2026-03-01", [{ role: "ai", content: "Now?" }, { role: "user", content: "yes" }]),
    ], "cur");
    assert.deepEqual(qa.map((x) => x.where), ["in session 1", "in session 2"]);
    assert.equal(qa[0].question, "Who runs the plant?");
    assert.equal(qa[1].answer.length, 599, "answers are kept whole");
  }
  ok("re-ask guard: reworded and longer re-asks, subjects answered in earlier answers; broad/year keys and transcript questions don't fire; candidates need confirmation");

  // ── 5. Conflicts ──
  {
    const roster = [doc({ id: "r", name: "Driver roster summary 2024", extractedText: "Service line,Drivers\nLinehaul,38\nPort drayage,14\nCity,26\n96 active company drivers at year end." })];
    assert.equal(spokenFigureConflicts("Average tenure is six-point-something and we have 24 drivers over 10 years.", roster).length, 0, "a subset vs a roster row");
    assert.equal(spokenFigureConflicts("We have 24 drivers.", roster).length, 0, "table rows are never a document's headline");
    const quality = [doc({ id: "q", name: "Quality summary", extractedText: "The quality team has 16 people: 3 quality engineers and 9 inspectors across three shifts." })];
    assert.equal(spokenFigureConflicts("Sandra has 16 people total: probably 10 or 11 inspectors on the floor.", quality).length, 0, "a hedged estimate a couple off");
    assert.ok(!valuesMateriallyDiffer("ebitda", "Adjusted EBITDA approximately $6M for 2024", "$5,274,900 (2024)"), "adjusted vs reported");
    assert.ok(valuesMateriallyDiffer("ebitda", "EBITDA about $6M for 2024", "$5,274,900 (2024)"));
    assert.ok(differentMeasure("YTD revenue $4.18M", "$9,815,000"));
    assert.ok(!differentMeasure("about a quarter", "41%"), "a fraction is not a quarterly figure");
    assert.ok(!valuesMateriallyDiffer("pressCount", "38 presses", "34 presses", { b: "Financial statements FY2022", asOf: 2024 }), "an older period vs now");
    assert.ok(valuesMateriallyDiffer("pressCount", "38 presses", "34 presses", { b: "Financial statements FY2024", asOf: 2024 }));
    assert.equal(dealAsOfYear([doc({ name: "Reviewed financial statements FY2024" }), doc({ name: "WIP report as of May 31, 2025" }), doc({ name: "Intro call", sourceKind: "call", sourceMeta: { date: "2026-01-14" } })]), 2024);

    const input = [
      "WHAT THE SELLER SAID:",
      "- ebitda: Adjusted EBITDA approximately $6M for 2024 [said on a call (Jan 21, 2025)]",
      "- totalDebt: $7.96M [an email (Mar 12, 2025)]",
      "- pressCount: 38 presses [said on a call (Jan 21, 2025)]",
      "- employees: 212 employees [said on a call (Jan 21, 2025)]",
      "- alderbrook: under 20% of revenue [an email (Nov 18, 2025)]",
      "SOURCES:",
      "### document: Reviewed financial statements FY2024 (Reviewed financial statements FY2024)\nsummary: EBITDA $5,274,900; 401(k) match $286,000; Alderbrook 22% of revenue",
      "### document: Form 1120-S — tax year 2023 (Form 1120-S — tax year 2023)\nsummary: total debt $9.34M",
      "### document: Financial statements FY2022 (Financial statements FY2022)\nsummary: 34 presses",
    ].join("\n");
    const v = (a: any, b: any, key = "k") => validateReviewConflicts([{ key, topic: key, critical: true, a, b }], input, 2024).length;
    assert.equal(v({ value: "Adjusted EBITDA approximately $6M for 2024", source: "said on a call (Jan 21, 2025)" }, { value: "EBITDA $5,274,900", source: "document: Reviewed financial statements FY2024" }, "ebitda"), 0, "adjusted vs reported");
    assert.equal(v({ value: "$7.96M", source: "an email (Mar 12, 2025)" }, { value: "total debt $9.34M", source: "document: Form 1120-S — tax year 2023" }, "totalDebt"), 0, "an older return vs now");
    assert.equal(v({ value: "38 presses", source: "said on a call (Jan 21, 2025)" }, { value: "34 presses", source: "document: Financial statements FY2022" }, "pressCount"), 0);
    assert.equal(v({ value: "212 employees", source: "said on a call (Jan 21, 2025)" }, { value: "headcount implied by the $286,000 401(k) match", source: "document: Reviewed financial statements FY2024" }, "employees"), 0, "inferred");
    assert.equal(v({ value: "212 employees", source: "said on a call" }, { value: "34 presses", source: "document: Some other file" }, "employees"), 0, "a source not in the input fails closed");
    assert.equal(v({ value: "under 20% of revenue", source: "an email (Nov 18, 2025)" }, { value: "Alderbrook 22% of revenue", source: "document: Reviewed financial statements FY2024" }, "alderbrookShare"), 1, "a real conflict survives");

    // The real input format: a title with its own parentheses; figures written differently ($3.1M = $3,100,000).
    const input2 = [
      "- backlog: $4.2M as of end of May 2025 [said on a call (Jun 5, 2025)]",
      "### said on a call (Jun 5, 2025)\nsource title: Phone call\nkeyFacts: backlog $4.2M, 140+ customers invoiced in 2024",
      "### document: WIP & backlog report as of May 31, 2025 (+ open quotes)\nsource title: WIP & backlog report as of May 31, 2025 (+ open quotes)\nkeyFacts: Remaining backlog $3,100,000",
      "### said on a video call (Jun 11, 2025)\nsource title: Teams call\nkeyFacts: 42 total employees",
    ].join("\n");
    const v2 = (a: any, b: any, key: string) => validateReviewConflicts([{ key, topic: key, critical: true, a, b }], input2, 2024).length;
    assert.equal(v2({ value: "$4.2M as of end of May 2025", source: "said on a call (Jun 5, 2025)" }, { value: "$3.1M signed backlog at May 31, 2025", source: "document: WIP & backlog report as of May 31, 2025 (+ open quotes)" }, "signedBacklog"), 1);
    assert.equal(v2({ value: "42 total", source: "said on a video call (Jun 11, 2025)" }, { value: "140+ customers invoiced in 2024", source: "said on a call (Jun 5, 2025)" }, "employees"), 0, "two things said, and two different counts");
  }
  {
    const said = (o: any) => doc({ sourceKind: "call", sourceMeta: { date: "2025-06-05" }, ...o });
    const docs = [
      said({ id: "c1", name: "Phone call", extractedData: { keyFacts: "revenue $9.8M (2024), backlog $4.2M, 42 employees" } }),
      doc({ id: "w", name: "WIP & backlog report as of May 31, 2025", extractedData: { keyFacts: "Total signed contracts $5,243,000, Remaining backlog $3,100,000, Backlog by segment: Oil & gas $1,183,400" } }),
      doc({ id: "e", name: "Email thread", sourceKind: "email", sourceMeta: { date: "2025-06-03" }, extractedData: { keyFacts: "Gord McAllister (seller): Owner salary $260,000 in 2024" } }),
      doc({ id: "t2", name: "T2 corporate tax return 2024 (client copy)", extractedText: "$180,000 paid to the majority shareholder (T4).\nGord McAllister — totalSalary + dividends240,000\nLuis OrtegaT4 (box 14)Employment income — salary & wages 120,000" }),
      said({ id: "c2", name: "Intro call", sourceMeta: { date: "2025-01-29" }, extractedData: { keyFacts: "Diversified LTC client base with master agreement with Maplecrest but no single operator over 25% of LTC revenue; PackRight strip-packager lease at $3,900/month through 2027" } }),
      doc({ id: "l", name: "LTC contracts summary", extractedData: { keyFacts: "Maplecrest MSA covers 5 homes (41% of LTC revenue), Top 20 homes 88% of LTC revenue" } }),
      said({ id: "v", name: "Zoom deep-dive", sourceKind: "video_call", sourceMeta: { date: "2025-02-26" }, extractedData: { keyFacts: "key staff: Daniel (15 years, pharmacist), Derek and Mark (10+ years tenure), Dana plans to retire in ~3 years" } }),
      doc({ id: "s", name: "Staff list (Feb 2025)", extractedText: "Daniel Okafor,Staff Pharmacist,2014-03-10,11\nMark Petrovic,Senior Technician,2012-03-19,13\nDana Whitfield,Office Manager,2012-02-06,14" }),
      doc({ id: "fs", name: "Financial statements FY2024", extractedData: { keyFacts: "Lease expires June 30 2029" } }),
    ];
    const found = claimConflicts(docs, {}, { ownerNames: ["Gord", "McAllister"], asOf: 2024 });
    const keys = found.map((c) => c.key).sort();
    assert.deepEqual(keys, ["backlog", "customerConcentration", "danielTenure", "ownerCompensation"], JSON.stringify(found, null, 1));
    const pay = found.find((c) => c.key === "ownerCompensation")!;
    assert.match(pay.values[1].value, /total Salary \+ dividends 240,000/);
    assert.match(found.find((c) => c.key === "backlog")!.values[1].value, /Remaining backlog \$3,100,000/);
    assert.ok(found.every((c) => c.critical));
    // Negatives.
    assert.equal(claimConflicts([said({ id: "h", name: "Call", extractedData: { keyFacts: "Very diversified book with no client over 4%" } }), doc({ id: "f", name: "FS", extractedData: { keyFacts: "Credit risk (no single customer over 10% of revenue), Managed services $4,472,900 (72% of revenue)" } })], {}).length, 0);
    assert.equal(claimConflicts([said({ id: "h", name: "Call", extractedData: { keyFacts: "No customer exceeds 10% of revenue" } }), doc({ id: "f", name: "Top 20", extractedData: { keyFacts: "Top 20 commercial contracts $872,100 (41.4% of revenue)" } })], {}).length, 0);
  }
  {
    // A conflict the broker settled is not re-opened.
    const c: any = { key: "alderbrookShare", topic: "Alderbrook share", values: [{ value: "Seller (Harjit): Alderbrook estimated at under 20% of revenue", source: "an email" }, { value: "top customer Alderbrook Grocery representing 22% of revenue", source: "document: Customer revenue" }], critical: true, origin: "alternates" };
    assert.ok(settledByBroker(c, [disc({ field: "Alderbrook revenue percentage", interviewValue: "~18% (approximately, under 20%)", documentValue: "22.0% in FY2024", resolvedValue: "22.0% of FY2024 revenue ($6,824,400)" })]));
    assert.ok(!settledByBroker(c, [disc({ field: "Driver count", interviewValue: "110", documentValue: "96", resolvedValue: "96" })]));
    assert.ok(settledByBroker({ ...c, key: "backlog" }, [disc({ field: "x", factKey: "backlog", resolvedValue: "$3.1M" })]));
  }
  ok("conflicts: no false conflicts (rows, adjusted vs reported, older periods, inference, unknown sources); backlog/owner pay/concentration/tenure found mechanically; settled ones stay closed");

  // ── 6. Streaming ──
  {
    const out: string[] = [];
    const rel = createMessageRelease((c) => out.push(c));
    rel.release("What share of revenue does Alderbrook represent today, and when does its MSA renew?");
    rel.release("ignored");
    await rel.finish("final");
    assert.equal(out.join(""), "What share of revenue does Alderbrook represent today, and when does its MSA renew?");
    const held: string[] = [];
    const rel2 = createMessageRelease((c) => held.push(c));
    await rel2.finish("Thanks — that covers everything for today.");
    assert.equal(held.join(""), "Thanks — that covers everything for today.", "a held message is shown when the turn is final");
    const none = createMessageRelease(undefined);
    assert.equal(none.streaming, undefined);
    await none.finish("x");

    // A stream stopped at message-complete: nothing more is read, the result is "rejected".
    let aborted = false;
    let extraRead = false;
    const json = JSON.stringify({ message: "What's your EV vs ICE split?", suggestedAnswers: [], extractedFields: {}, reasoning: {}, newTasks: [], shouldEnd: false });
    const parts = [json.slice(0, 12), json.slice(12, 45), json.slice(45)];
    const fake: any = {
      messages: {
        stream: () => {
          const ev = parts.map((p) => ({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: p } }));
          return {
            on: () => {},
            abort: () => { aborted = true; },
            finalMessage: async () => { throw new Error("must not be awaited"); },
            async *[Symbol.asyncIterator]() {
              for (let i = 0; i < ev.length; i++) { if (i === 2) extraRead = true; yield ev[i]; }
            },
          };
        },
        create: async () => { throw new Error("no retry expected"); },
      },
    };
    const deltas: string[] = [];
    const r = await callInterviewWithRecovery(fake, { model: "m", maxTokens: 10, temperature: 1, system: [], messages: [] }, (c) => deltas.push(c), async (msg) => !/EV vs ICE/.test(msg));
    assert.equal(r.rejected, true);
    assert.equal(r.response.message, "What's your EV vs ICE split?");
    assert.ok(aborted, "the stream is aborted");
    assert.ok(!extraRead, "the rest of the response is never read");
  }
  ok("streaming: the message is shown once approved (or when final); a rejected draft stops the stream at message-complete");

  console.log(`\n${n} groups passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
