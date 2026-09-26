// Interview knowledge, round V (QA harvest "i-knowledge") — offline checks,
// no database, no AI (model calls are replaced).
//  1. On-file evidence: quotes are checked against the source (PDF glue,
//     table rows, spoken numbers), figures must be in the file, seller-only
//     items need the seller's words, a document's flag doesn't explain itself.
//  2. The knowledge base the agent is steered by agrees with the file: an
//     answered checklist item is ON FILE (never NOT YET CAPTURED), an
//     explained risk leaves the agenda, STILL NEEDED drops them.
//  3. Re-ask guard: fact/prior/own-statement candidates go to the answer
//     check; the exchange being answered right now never stands without it
//     (a follow-up on the unanswered half of a compound question goes out);
//     a strong earlier match stands when the check can't decide.
//  4. Live claim check: validated, raised unless the draft already does.
//  5. Tasks: an undelivered document request isn't closed by a similar topic.
//  6. Checklist rebuilds keep the broker's items and labels.
//  7. A returning seller's opening shows continuity.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/interview-knowledge-v.test.ts
import assert from "node:assert/strict";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt, buildEvidenceTargets, buildSectionCoverage } from "../../server/interview/knowledge-base";
import { quoteInText, spokenNumbers, figuresSupported, validateEvidence, onFileItems, evidenceSources, evidenceFingerprint, evidenceCurrent, EVIDENCE_VERSION, type EvidenceTarget } from "../../server/interview/on-file-evidence";
import { findReasks, confirmFindings, sureFindings, rankedFactCandidates, ownStatementCandidates, liveConflictAddressed, reaskCorrection } from "../../server/interview/reask-guard";
import { claimSentences, validateLiveClaims, checkLiveClaims } from "../../server/interview/live-claims";
import { planTaskWrites, sameRequest } from "../../server/interview/task-writes";
import { stabilisePlanItems } from "../../server/interview/interview-plan";
import { finalizeOpeningMessage } from "../../server/interview/turn-guard";
import { completionBlockers, openSellerOnlyTopics } from "../../server/interview/completion-gaps";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

const doc = (o: Record<string, unknown>): any => ({
  name: "doc", visibility: "shared", sourceKind: "document", sourceMeta: null, createdAt: new Date("2026-03-03T12:00:00Z"),
  category: "other", subcategory: null, status: "processed", isProcessed: true, extractedText: null, extractedData: null, ...o,
});
const baseDeal: any = {
  id: "d1", brokerId: "b1", businessName: "Great Lakes Plastics", industry: "Manufacturing", subIndustry: "Injection molding", location: "Toledo, OH",
  description: null, questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null, scrapeSource: null,
  sellerProfile: null, sectionImportance: null, interviewOutline: null, askingPrice: null, extractedInfo: {}, interviewSourceReview: null,
  interviewPlan: {
    industry: "Manufacturing", subIndustry: "Injection molding", rulesVersion: 2, computedAt: "2026-09-01T00:00:00Z", status: "ready",
    items: [
      { key: "robotAutomationLevel", label: "Robot count and automation level by process", sectionKey: "operations", critical: true, answeredByKey: null },
      { key: "scrapAndRegrindRate", label: "Scrap and regrind rate", sectionKey: "operations", critical: false, answeredByKey: null },
      { key: "shiftStructure", label: "Shift structure and headcount by shift", sectionKey: "employees", critical: true, answeredByKey: null },
    ],
  },
};

// ── 1. Evidence validation ──
{
  assert.deepEqual(spokenNumbers("It's about three hundred eighty thousand to replace"), [380000]);
  assert.deepEqual(spokenNumbers("The vote failed, sixty-one to thirty-nine."), [61, 39]);
  assert.ok(spokenNumbers("Eleven point two acres").includes(11.2));
  assert.ok(spokenNumbers("a replacement CEO at three eighty-five all-in").includes(385000), "money shorthand");
  assert.ok(spokenNumbers("Operators start at seventeen fifty").includes(17.5));
  assert.deepEqual(spokenNumbers("clears about a million and a half for me"), [1500000]);

  // A PDF table row glued together, quoted across cells with the year header far above.
  const quality = "Metric 2022 2023 2024\n" + "filler ".repeat(80) + "\nOn-time delivery94.8%96.9%97.6%\nInternal scrap rate (% of material)3.9%3.4%2.9%\nCustomer scorecard";
  assert.ok(quoteInText("Internal scrap rate (% of material) 3.9% 2022, 3.4% 2023, 2.9% 2024", quality));
  assert.ok(quoteInText("Automotive (Tier-2 to Tier-1 suppliers) 36,058,217 61.9%", "Net sales by end market:\nAutomotive (Tier-2 to Tier-1 suppliers)36,058,21761.9%35,528,93464.9%"));
  assert.ok(!quoteInText("Internal scrap rate 1.8% in 2024", quality), "a figure the source doesn't have");
  assert.ok(quoteInText("about ten of the hydraulics are more than twenty years old ... replace two or three a year", "we've got about ten of the hydraulics are more than twenty years old. They run fine. A buyer should plan to replace two or three a year."));
  assert.ok(figuresSupported("21 presses have robots; target 30", "Twenty-one presses have robots, we'd like to get to thirty."));
  assert.ok(figuresSupported("Paid $1,120,000 in 2024", "The three of them were paid $1,120,000 last year."), "a year is exempt");
  assert.ok(!figuresSupported("About 450 customer-owned molds", "maybe 240 to 250 active tools"));

  const targets = new Map<string, EvidenceTarget>([
    ["T1", { id: "field:robotAutomationLevel", kind: "field", key: "robotAutomationLevel", label: "Robot count", sellerAccount: false }],
    ["T2", { id: "topic:owner pay and perks", kind: "topic", key: "owner pay and perks", label: "owner pay and perks", sellerAccount: true }],
    ["T3", { id: "risk:West roof", kind: "risk", key: "West roof", label: "West roof original from 1994", sellerAccount: false, excludeSources: ["Building condition report"] }],
    ["T4", { id: "field:shiftStructure", kind: "field", key: "shiftStructure", label: "Shift structure", sellerAccount: false }],
  ]);
  const sources = new Map<string, any>([
    ["S1", { id: "S1", label: "Press list", kind: "document", docId: "p", text: "38 presses. 21 presses with robots for part removal." }],
    ["S2", { id: "S2", label: "Zoom call", kind: "video_call", docId: "z", text: "Rob: Twenty-one have robots. Diane: I take four eighty-five, Rob four forty-five. The west roof is original, about three hundred eighty thousand to replace, we'll do it next year." }],
    ["S3", { id: "S3", label: "Building condition report", kind: "document", docId: "b", text: "West roof section original from 1994, at end of useful life." }],
    ["P1", { id: "P1", label: "interview session 1", kind: "session", sessionId: "s1", text: "Owner: Three shifts, 24/5, first shift is the heaviest." }],
  ]);
  const rejects: string[] = [];
  const entries = validateEvidence([
    { id: "T1", status: "yes", answer: "21 of 38 presses have robots", sourceId: "S1", quote: "21 presses with robots for part removal" },
    // Seller-only topic from a document → dropped; from the call → kept (credited to the call).
    { id: "T2", status: "yes", answer: "Diane takes $485K, Rob $445K", sourceId: "S1", quote: "I take four eighty-five, Rob four forty-five" },
    // A risk's own flagging document doesn't explain it.
    { id: "T3", status: "yes", answer: "West roof original from 1994", sourceId: "S3", quote: "West roof section original from 1994" },
    // Partial needs what's missing.
    { id: "T4", status: "partly", answer: "Three shifts, 24/5", sourceId: "P1", quote: "Three shifts, 24/5, first shift is the heaviest", missing: "headcount by shift" },
    // Invented figure → dropped.
    { id: "T1", status: "yes", answer: "25 robots", sourceId: "S2", quote: "Twenty-one have robots" },
  ], targets, sources, {}, rejects);
  assert.equal(entries["field:robotAutomationLevel"].source, "Press list");
  assert.equal(entries["topic:owner pay and perks"].source, "Zoom call", "the quote is credited to the call that has it");
  assert.equal(entries["risk:West roof"], undefined, "the flagging document is not an explanation");
  assert.equal(entries["field:shiftStructure"].partial, true);
  assert.equal(entries["field:shiftStructure"].missing, "headcount by shift");
  assert.ok(rejects.some((r) => /figure not in the file/.test(r)));
}
ok("evidence: quotes checked against the source (tables, glue, spoken numbers); figures must be in the file; seller-only items need the seller's words; a flag doesn't explain itself");

// ── 2. The knowledge base agrees with the file ──
{
  const docs = [
    doc({ id: "p", name: "Press list", extractedText: "38 presses. 21 presses with robots for part removal." }),
    doc({ id: "q", name: "Quality summary", extractedText: "Internal scrap rate 3.9% 3.4% 2.9%", extractedData: { summary: "Quality metrics", redFlags: "2019 union organizing attempt" } }),
    doc({ id: "z", name: "Zoom call", sourceKind: "video_call", extractedText: "Rob: the 2019 union vote failed sixty-one to thirty-nine; nothing since.", extractedData: { summary: "Operations call", redFlags: "2019 union organizing attempt" } }),
    doc({ id: "crm", name: "CRM note", sourceKind: "crm", visibility: "broker_only", extractedText: "private" }),
  ];
  const info: any = { robotCount: "21 robots", annualRevenue: "$58M", _fieldSources: { robotCount: { source: "document", documentId: "p" }, annualRevenue: { source: "document", documentId: "q" } } };
  const deal = { ...baseDeal, extractedInfo: info };
  const bare = assembleKnowledgeBase(deal, docs, [], null, [], { sessions: [], currentSessionId: "cur" });
  const targets = bare.evidenceTargets!;
  assert.ok(targets.some((t) => t.id === "field:robotAutomationLevel"), "an open checklist item is a target");
  assert.ok(targets.some((t) => t.kind === "risk" && t.key === "2019 union organizing attempt"));
  assert.ok(renderKnowledgeBaseForPrompt(bare).includes("robotAutomationLevel (Robot count and automation level by process — CRITICAL for this industry): NOT YET CAPTURED"), "before: the contradiction");

  const evidence = {
    version: EVIDENCE_VERSION, fingerprint: "x", computedAt: new Date().toISOString(), status: "ready", checked: targets.map((t) => t.id),
    entries: {
      "field:robotAutomationLevel": { answer: "21 of 38 presses have robots", source: "Press list", sourceKind: "document", sourceId: "p", quote: "21 presses with robots" },
      "field:scrapAndRegrindRate": { answer: "Internal scrap 3.9% / 3.4% / 2.9%", source: "Quality summary", sourceKind: "document", sourceId: "q" },
      "field:shiftStructure": { answer: "Three shifts, 24/5", source: "Zoom call", sourceKind: "video_call", sourceId: "z", partial: true, missing: "headcount by shift" },
      "risk:2019 union organizing attempt": { answer: "Vote failed 61–39 in 2019; nothing since", source: "Zoom call", sourceKind: "video_call", sourceId: "z" },
      // Its source became broker-only → dropped when read.
      "field:inHouseToolingCapability": { answer: "x", source: "CRM note", sourceKind: "crm", sourceId: "crm" },
    },
  };
  const kb = assembleKnowledgeBase({ ...deal, interviewEvidence: evidence }, docs, [], null, [], { sessions: [], currentSessionId: "cur" });
  const prompt = renderKnowledgeBaseForPrompt(kb);
  assert.ok(!/robotAutomationLevel[^\n]*NOT YET CAPTURED/.test(prompt), "never NOT YET CAPTURED when the file answers it");
  assert.match(prompt, /robotAutomationLevel \(Robot count[^\n]*: 21 of 38 presses have robots \(ON FILE — Press list; don't ask it\)/);
  assert.match(prompt, /## ⛔ ALSO ALREADY ON FILE[\s\S]*scrapAndRegrindRate \(Scrap and regrind rate[^\n]*Internal scrap 3\.9%/);
  assert.match(prompt, /shiftStructure[^\n]*PARTLY ON FILE \(Zoom call\) — ask ONLY for: headcount by shift/);
  assert.ok(!(kb.flaggedRisks ?? []).some((r) => r.label === "2019 union organizing attempt"), "an explained risk leaves the agenda");
  assert.ok(!/## 🚩 RISKS FLAGGED[\s\S]*2019 union organizing attempt[\s\S]*## ⛔ ALREADY/.test(prompt));
  assert.ok(!(kb.onFile ?? []).some((i) => i.source === "CRM note"), "broker-only evidence never reaches the interview");
  const operations = kb.sectionCoverage.find((s) => s.key === "operations")!;
  assert.equal(operations.fields.find((f) => f.fieldName === "robotAutomationLevel")!.onFile, "Press list");
  // STILL NEEDED: the answered critical item is gone; the partial one asks only for the missing part.
  const blockers = completionBlockers({
    sectionCoverage: kb.sectionCoverage, criticalSections: new Set(["operations", "employees"]), info: kb.extractedInfo as any,
    ledger: [], exchanges: [], conflicts: kb.sourceConflicts, risks: kb.flaggedRisks, onFileTopics: kb.onFileTopics,
  });
  assert.ok(!blockers.some((b) => /robotAutomationLevel|union/.test(b)));
  const shifts = blockers.find((b) => /shiftStructure/.test(b));
  assert.ok(!shifts || /ask ONLY for what is missing: headcount by shift/.test(shifts));
  // A seller-only topic the seller spoke to on file stops blocking.
  const topics = openSellerOnlyTopics({}, []);
  assert.ok(topics.includes("owner pay and perks"));
  const b2 = completionBlockers({ sectionCoverage: [], criticalSections: new Set(), info: {}, ledger: [], exchanges: [], onFileTopics: ["owner pay and perks"] });
  assert.ok(!b2.includes("seller-only topic: owner pay and perks"));
  // Reading stored entries: a fact entry whose fact left the view is dropped.
  const t = [{ id: "field:a", kind: "field", key: "a", label: "A", sellerAccount: false } as EvidenceTarget];
  const stored = { interviewEvidence: { ...evidence, entries: { "field:a": { answer: "x", source: "on file as robotCount", sourceKind: "fact", factKey: "robotCount" } } } };
  assert.equal(onFileItems(stored, t, { view: { robotCount: "21" } }).length, 1);
  assert.equal(onFileItems(stored, t, { view: {} }).length, 0);
}
ok("knowledge base: an item the file answers is ON FILE (never NOT YET CAPTURED), explained risks leave the agenda, STILL NEEDED drops them, broker-only evidence never reaches the prompt");

// ── Evidence build inputs: seller-visible only; fingerprint ignores the session in progress ──
{
  const docs = [doc({ id: "a", name: "Press list", extractedText: "21 presses with robots" }), doc({ id: "b", name: "CRM", sourceKind: "crm", visibility: "broker_only", extractedText: "secret" }), doc({ id: "c", name: "Website", sourceKind: "website", extractedText: "web" })];
  const sessions: any[] = [
    { id: "s1", startedAt: "2026-09-01", messages: [{ role: "ai", content: "How many shifts?" }, { role: "user", content: "Three shifts." }] },
    { id: "cur", startedAt: "2026-09-20", messages: [{ role: "ai", content: "Q?" }, { role: "user", content: "A" }] },
  ];
  const blocks = evidenceSources(docs, sessions, "cur");
  assert.deepEqual(blocks.map((b) => b.label), ["Press list", "interview session 1"]);
  assert.ok(!blocks.some((b) => /secret/.test(b.text)));
  const fp = evidenceFingerprint(docs, sessions, "cur");
  const more = [...sessions.slice(0, 1), { ...sessions[1], messages: [...sessions[1].messages, { role: "ai", content: "Q2?" }, { role: "user", content: "B" }] }];
  assert.equal(evidenceFingerprint(docs, more, "cur"), fp, "a turn in the live session doesn't force a rebuild");
  assert.notEqual(evidenceFingerprint(docs, more, null), fp, "a finished session does");
  const tgt = [{ id: "field:x", kind: "field", key: "x", label: "X", sellerAccount: false } as EvidenceTarget];
  const ready = { interviewEvidence: { version: EVIDENCE_VERSION, fingerprint: fp, computedAt: new Date().toISOString(), status: "ready", checked: ["field:x"], entries: {} } };
  assert.ok(evidenceCurrent(ready, fp, tgt));
  assert.ok(!evidenceCurrent(ready, fp, [...tgt, { ...tgt[0], id: "field:y" }]), "a new open item is checked too");
}
ok("evidence inputs: seller-visible sources only; the fingerprint changes with sources and finished sessions, not with each turn");

// ── 3. Re-ask guard ──
{
  // The exchange being answered right now: half a compound question answered → the follow-up is only a candidate.
  const priorQA = [{ question: "What does your lease look like — how many years are left, and do you have renewal options?", answer: "About 4 years left on it, and the rent is fine.", where: "earlier in this session", current: true }];
  const draft = "Does the lease have any renewal options after those 4 years?";
  const found = findReasks(draft, { sellerMessage: "About 4 years left on it, and the rent is fine.", info: {}, documents: [], priorQA });
  const prior = found.filter((f) => f.kind === "prior_question");
  assert.ok(prior.length === 0 || prior.every((f) => f.verify && !f.fallback), "never a sure re-ask");
  assert.equal((await confirmFindings(found, draft, async () => null)).filter((f) => f.kind === "prior_question").length, 0, "no verdict → the follow-up goes out");
  assert.equal((await confirmFindings(found, draft, async () => new Set())).length, 0, "the check says it's not answered → it goes out");
  assert.equal(sureFindings(found).filter((f) => f.kind === "prior_question").length, 0);

  // The same question from an EARLIER session, clearly answered → stands even without a verdict.
  const earlier = [{ question: "Which resin suppliers do you buy from, and how concentrated is that?", answer: "Mostly Midland Polymers and Keystone Resins, about 60/40", where: "in session 1" }];
  const f2 = findReasks("Which resin suppliers do you buy from today?", { sellerMessage: "Fine.", info: {}, documents: [], priorQA: earlier });
  assert.ok(f2.some((f) => f.kind === "prior_question" && f.fallback));
  assert.equal((await confirmFindings(f2, "Which resin suppliers do you buy from today?", async () => null)).length, 1);

  // A fact under another key: "how many presses have robots" vs robotCount "21 robots" (the strict rule misses it).
  const info: any = { robotCount: "21 robots", qualityMetrics: "2024: 18 PPM to automotive customers", unrelated: "Lease runs to 2031", _fieldSources: { robotCount: { source: "document" }, qualityMetrics: { source: "document" } } };
  const robots = rankedFactCandidates("How many of your 38 presses currently have robots or automation cells attached?", info, [], new Set());
  assert.ok(robots.some((f) => /robotCount: 21 robots/.test(f.detail) && f.verify && !f.fallback));
  const ppm = rankedFactCandidates("What's your current PPM performance with your automotive customers?", info, [], new Set());
  assert.ok(ppm.some((f) => /qualityMetrics/.test(f.detail)), "an acronym in the value");
  // …and an on-file item (a document table never extracted into facts).
  const onFile = [{ key: "scrapAndRegrindRate", label: "Scrap and regrind rate", answer: "Internal scrap 3.9% / 3.4% / 2.9%", source: "Quality summary" }];
  const scrap = findReasks("What's your overall scrap rate across the plant?", { sellerMessage: "ok", info: {}, documents: [], priorQA: [], onFile });
  assert.ok(scrap.some((f) => f.kind === "fact" && /scrapAndRegrindRate/.test(f.detail)));
  // A delta question is never a SURE re-ask (round V r2: its candidates go to the check, which knows
  // "what has changed since" isn't answered by the older item; no verdict → it goes out).
  const deltaFound = findReasks("Has the scrap rate changed since last year?", { sellerMessage: "ok", info: {}, documents: [], priorQA: [], onFile });
  assert.equal(sureFindings(deltaFound).filter((f) => f.kind === "fact").length, 0);
  assert.equal((await confirmFindings(deltaFound, "Has the scrap rate changed since last year?", async () => null)).filter((f) => f.kind === "fact").length, 0);

  // What the interviewer itself told the seller.
  const own = ownStatementCandidates(
    "What about the physios on the 2024 agreement — what's the non-compete radius and duration, and is there a non-solicitation clause?",
    ["The call notes mention your associates are independent contractors with 12-month non-solicitation and 12-month/5 km non-compete clauses in the 2024 agreement. Hannah is on the older form — does hers match?"],
  );
  assert.ok(own.length === 1 && own[0].kind === "own_statement" && own[0].verify);
  assert.match(reaskCorrection(own), /You already told the seller this yourself/);
  assert.match(reaskCorrection(own), /answered only part of an earlier question, ask only for the part they left out/);

  // A long hedged answer is still an answer (the check decides); a short deferral may be followed up.
  const hedged = [{ question: "In a share sale, do the direct billing credentials transfer automatically, or would the buyer need to re-enroll?", answer: "Honestly, I'd have to check with Dana on the exact mechanics, but my understanding is that the billing agreements are with the corporation, not with me, so in a share sale they should stay in place.", where: "in session 1" }];
  const f3 = findReasks("For a share sale, do you know whether the direct billing credentials with the insurers transfer automatically, or would the buyer need to re-enroll?", { sellerMessage: "ok", info: {}, documents: [], priorQA: hedged });
  assert.ok(f3.some((f) => f.kind === "prior_question" && f.verify && !f.fallback));
}
ok("re-ask guard: the current exchange never stands without the check (partial answers get their follow-up); earlier strong matches stand; facts under other keys, on-file items and the agent's own statements are candidates");

// ── 4. Live claim check ──
{
  const message = "Plant-wide we run about 1.8% scrap. Medical is tighter. The vast majority — probably 450 molds on the racks — are customer-owned.";
  assert.equal(claimSentences(message).length, 2);
  const material = [
    { id: "M1", label: 'passage from "Quality summary"', text: "Internal scrap rate (% of material) 3.9% 3.4% 2.9%" },
    { id: "M2", label: 'passage from "Customer list"', text: "About 1,150 customer-owned molds are stored on site." },
  ];
  const found = validateLiveClaims([
    { said: "about 1.8% scrap", onFile: "2.9% in 2024", materialId: "M1", topic: "scrap rate", key: "scrapRate" },
    { said: "450 customer-owned molds", onFile: "about 1,150 customer-owned molds", materialId: "M2", topic: "molds" },
    { said: "1.8% scrap", onFile: "2.5% scrap", materialId: "M1", topic: "invented" }, // not in the material
    { said: "7% scrap", onFile: "2.9%", materialId: "M1", topic: "not said" }, // the seller never said it
  ], message, material);
  assert.equal(found.length, 2);
  assert.equal(found[0].key, "scrapRate");
  // Not conflicts (both reported by the model in the live run): the same figure, and a figure against a sentence.
  const quiet = validateLiveClaims([
    { said: "$5 million revolver with First Maumee", onFile: "$5,000,000 revolving line of credit with First Maumee Bank; no amount outstanding at December 31, 2024", materialId: "M3", topic: "revolver" },
    { said: "$30,000, $40,000 total across all of them", onFile: "Nearly all molds are customer-owned", materialId: "M4", topic: "molds" },
  ], "The $5 million revolver with First Maumee is undrawn. A couple still get small orders, maybe $30,000, $40,000 total across all of them.", [
    { id: "M3", label: "fact lineOfCredit", text: "$5,000,000 revolving line of credit with First Maumee Bank; no amount outstanding at December 31, 2024" },
    { id: "M4", label: "fact toolingOwnership", text: "Nearly all molds are customer-owned (normal for the business)" },
  ]);
  assert.equal(quiet.length, 0);
  assert.ok(liveConflictAddressed(found[0], "The quality summary shows 2.9% for 2024 — which is right?"));
  assert.ok(!liveConflictAddressed(found[0], "How do you handle regrind?"));
  const f = findReasks("How do you handle regrind?", { sellerMessage: message, info: {}, documents: [], priorQA: [], liveConflicts: found });
  assert.equal(f.filter((x) => x.kind === "conflict").length, 2);
  assert.match(reaskCorrection(f), /^\[SYSTEM CORRECTION:\nFIRST — the seller's figure conflicts/);
  // The model call is skipped when nothing is claimed, and its failure checks nothing.
  assert.deepEqual(await checkLiveClaims({ sellerMessage: "Sure, go ahead.", info: {}, documents: [] }, { model: async () => { throw new Error("must not be called"); } }), []);
  assert.deepEqual(await checkLiveClaims({ sellerMessage: message, info: {}, documents: [doc({ id: "q", name: "Quality summary", extractedText: "Internal scrap rate 2.9% in 2024 of material" })] }, { model: async () => null }), []);
}
ok("live claims: a figure the seller volunteers that the file states differently is validated and raised unless the draft already does");

// ── 5. Tasks ──
{
  const existing: any[] = [
    { id: "t1", type: "document_request", title: "Upload the equipment list", description: "", relatedField: null, status: "pending", createdBy: "ai_interview" },
    { id: "t2", type: "document_request", title: "Upload the lease agreement", description: "", relatedField: null, status: "pending", createdBy: "ai_interview" },
  ];
  const p = planTaskWrites({ newTasks: [], existing, documents: [], answeredKeys: new Set(), resolvedTopics: ["equipment list", "lease"], sellerMessage: "x" });
  assert.deepEqual(p.close, [], "similarly named topics never close an undelivered document request");
  const named = planTaskWrites({ newTasks: [], existing, documents: [], answeredKeys: new Set(), resolvedTopics: ["Upload the lease agreement"], sellerMessage: "x" });
  assert.deepEqual(named.close, ["t2"]);
  const arrived = planTaskWrites({ newTasks: [], existing, documents: [doc({ id: "l", name: "Lease agreement — 1200 Industrial Pkwy" })], answeredKeys: new Set(), resolvedTopics: [], sellerMessage: "x" });
  assert.deepEqual(arrived.close, ["t2"], "it closes when the document arrives");
  assert.ok(sameRequest("[document_request] Upload the lease agreement", "Upload the lease agreement"));
}
ok("tasks: a document request stays open until the document arrives (or the agent names that very request)");

// ── 6. Checklist rebuilds are stable ──
{
  const prev = Array.from({ length: 12 }, (_, i) => ({ key: `item${i}`, label: `Item ${i}`, sectionKey: "operations", critical: i < 2, answeredByKey: null }));
  const rebuilt = [
    ...prev.slice(0, 10).map((p) => ({ ...p, label: `${p.label} (reworded)` })),
    { key: "newCritical", label: "New critical probe", sectionKey: "operations", critical: true, answeredByKey: null },
    { key: "newOptional", label: "New optional", sectionKey: "operations", critical: false, answeredByKey: null },
  ];
  const s = stabilisePlanItems(prev, rebuilt);
  assert.equal(s.items.length, 11);
  assert.equal(s.items[0].label, "Item 0", "the broker's labels stay");
  assert.deepEqual(s.removed, ["Item 10", "Item 11"]);
  assert.deepEqual(s.added, ["New critical probe"], "only a critical item may join");
  const wild = stabilisePlanItems(prev, [{ key: "other", label: "Other", sectionKey: "operations", critical: false, answeredByKey: null }]);
  assert.equal(wild.items.length, 12, "a very different build keeps the existing checklist");
  assert.deepEqual(wild.removed, []);
}
ok("checklist: a rules rebuild keeps the broker's items and labels; only a few inapplicable ones go, and the change is recorded");

// ── 7. A returning seller's opening ──
{
  assert.equal(finalizeOpeningMessage("What's driving the Seton numbers?", { returning: true }), "Welcome back. What's driving the Seton numbers?");
  const cont = "Picking up where we left off on the lease, Sarah. Has Greg come back to you on renewal terms?";
  assert.equal(finalizeOpeningMessage(cont, { returning: true }), cont);
  assert.match(finalizeOpeningMessage("What's driving the Seton numbers?"), /^Welcome, and thanks for making time for this\./, "a first contact is unchanged");
}
ok("opening: a returning seller is welcomed back (never greeted as a first meeting); a continuity sentence is kept");

// Sanity: coverage with evidence doesn't treat a partial as covered.
{
  const cov = buildSectionCoverage({}, undefined, undefined, [], { onFile: { shiftStructure: { answer: "3 shifts", source: "Zoom", partial: true, missing: "headcount" } }, add: { employees: [{ key: "shiftStructure", label: "Shifts", critical: true }] } });
  const f = cov.find((s) => s.key === "employees")!.fields.find((x) => x.fieldName === "shiftStructure")!;
  assert.equal(f.value, null);
  assert.equal(f.partlyOnFile?.missing, "headcount");
  const t = buildEvidenceTargets(cov, [], [], [], new Set());
  assert.ok(t.some((x) => x.id === "field:shiftStructure"));
}
ok("coverage: a partial answer stays open (only the missing part is asked)");

console.log(`\n${n} groups passed`);
