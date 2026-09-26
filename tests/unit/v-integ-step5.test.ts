// QA harvest round V — integration step 5 (i-intent + i-knowledge onto the
// merged f-/d-/c-/misc/i-privacy-ux/i-output streams). Where the mechanisms meet:
//  1. "What the interviewer told the seller itself": i-output (reply-guards
//     selfStatedFindings, reading the draft from its first question on) and
//     i-knowledge (reask-guard ownStatementCandidates, its own finding kind
//     and correction wording) each added a detector. One context field
//     (ownStatements), one finding per statement, the i-knowledge kind.
//  2. The live claim check (i-knowledge) never asks the seller to reconcile a
//     figure they corrected or withdrew this turn (i-intent's reading).
//  3. The on-file evidence (i-knowledge) and the seller view's held facts
//     (i-privacy-ux): a fact the broker settled is on file for coverage and
//     is never an evidence target; an SDE / add-back item a seller-side
//     source answers carries the same "don't tell the seller" note as such a
//     fact; risks framed as the broker's work stay off the agenda.
// Offline: no database, no AI.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/v-integ-step5.test.ts
import assert from "node:assert/strict";
import { findReasks, ownStatementFindings, reaskCorrection, type ReaskFinding } from "../../server/interview/reask-guard";
import { intentSettlesConflict } from "../../server/interview/session-manager";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";
import { EVIDENCE_VERSION } from "../../server/interview/on-file-evidence";
import type { SellerIntent } from "../../server/interview/seller-intent";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

// ── 1. One own-statement detector ──
{
  const told = "The call notes mention your associates are independent contractors with 12-month non-solicitation and 12-month/5 km non-compete clauses in the 2024 agreement. How many have been with you more than three years?";
  // i-output's case: the topic words come after the question mark.
  const draftA = "What about the physios on the 2024 agreement — could you walk me through the key terms? I'm thinking notice period, the non-compete radius and duration, and whether there's a non-solicitation clause.";
  // i-knowledge's case: the question itself names it.
  const draftB = "What about the physios on the 2024 agreement — what's the non-compete radius and duration, and is there a non-solicitation clause?";
  for (const draft of [draftA, draftB]) {
    const found = findReasks(draft, { sellerMessage: "About six of them.", info: {}, documents: [], priorQA: [], ownStatements: [told] });
    const own = found.filter((f) => f.kind === "own_statement");
    assert.equal(own.length, 1, `${draft}\n${JSON.stringify(found, null, 1)}`);
    assert.equal(own[0].verify, true, "the answer check decides");
    assert.ok(!found.some((f) => f.kind === "fact" && /yourself/.test(f.detail)), "never the same statement twice under another kind");
    assert.match(reaskCorrection(own), /You already told the seller this yourself/);
  }
  // Nothing in common → nothing.
  assert.deepEqual(ownStatementFindings("How many trucks are in the fleet today?", "How many trucks are in the fleet today?", ["The landlord has consented to an assignment of the lease in the past, according to the file."]), []);
  ok("one own-statement detector: both streams' cases caught, once, as own_statement");
}

// ── 2. The live claim check vs the seller's own correction / withdrawal ──
{
  const intent = (o: Partial<SellerIntent>): SellerIntent =>
    ({ stop: "none", continueRequest: false, sellerQuestion: "", retractions: [], corrections: [], privacyRequests: [], via: "model", ...o }) as SellerIntent;
  const conflict = (key: string, said: string, onFile: string): ReaskFinding => ({
    kind: "conflict", key, onFileValue: onFile, detail: `${key}: the seller just said "${said}", but the interview (earlier) states "${onFile}"`,
  });
  const msg = "Sorry, I misspoke — it's 14 welders on days, not 12.";
  const c = conflict("dayShiftWelders", "14 welders on days", "12 welders on day shift");
  assert.equal(intentSettlesConflict(c, intent({ corrections: [{ old: "12", new: "14", fieldHint: "dayShiftWelders" }] }), msg), true, "the corrected fact itself");
  assert.equal(intentSettlesConflict(c, intent({ corrections: [{ old: "12 welders", new: "14 welders" }] }), msg), true, "the file's figure is the one corrected");
  assert.equal(intentSettlesConflict(c, intent({ via: "patterns", corrections: [{ old: "", new: "" }] }), msg), true, "patterns only: the seller named the file's figure");
  // A document that disagrees with the NEW figure is still a real conflict.
  const doc16 = conflict("weldersTotal", "14 welders on days", "16 welders (payroll register)");
  assert.equal(intentSettlesConflict(doc16, intent({ corrections: [{ old: "12", new: "14", fieldHint: "dayShiftWelders" }] }), msg), false);
  // A withdrawn figure is never probed.
  const trucks = conflict("fleetSize", "about 40 trucks", "24 service vans + 2 owner vehicles");
  assert.equal(intentSettlesConflict(trucks, intent({ retractions: [{ what: "about 40 trucks" }] }), "Ignore what I said about the 40 trucks, I was guessing."), true);
  assert.equal(intentSettlesConflict(trucks, intent({}), "We run about 40 trucks."), false, "no correction, no withdrawal: the conflict stands");
  ok("a live-claim conflict the seller corrected or withdrew this turn is never probed");
}

// ── 3. On-file evidence meets the seller view ──
{
  const baseDeal: any = {
    id: "d5", brokerId: "b1", businessName: "Lakeshore Home Comfort", industry: "Home Services", subIndustry: "HVAC", location: "Hamilton, ON",
    description: null, questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null, scrapeSource: null,
    sellerProfile: null, sectionImportance: null, interviewOutline: null, interviewPlan: null, askingPrice: null, interviewSourceReview: null,
  };
  const doc = (o: Record<string, unknown>): any => ({
    name: "doc", visibility: "shared", sourceKind: "document", sourceMeta: null, createdAt: new Date("2026-03-03T12:00:00Z"),
    category: "other", subcategory: null, status: "processed", isProcessed: true, extractedText: null, extractedData: null, ...o,
  });
  const fin = (kb: any) => kb.sectionCoverage.find((s: any) => s.key === "financials");

  // (a) The broker typed the SDE: the view holds it; it is on file for
  //     coverage (agent and recorded) and never an evidence target.
  const held = assembleKnowledgeBase(
    { ...baseDeal, extractedInfo: { sde: "$1,312,000", _fieldSources: { sde: { source: "broker", at: "2026-09-21T10:00:00Z" } } } },
    [], [], null, [], { sessions: [], currentSessionId: "cur" },
  );
  assert.equal(held.extractedInfo.sde, undefined, "the figure stays with the broker");
  assert.ok(fin(held).fields.some((f: any) => f.fieldName === "sde" && f.value), "sde counts as on file");
  assert.ok((held.recordedCoverage ?? []).find((s: any) => s.key === "financials")!.fields.some((f: any) => f.fieldName === "sde" && f.value), "recorded coverage too");
  assert.ok(!(held.evidenceTargets ?? []).some((t) => t.id === "field:sde"), "a held fact is not an evidence target");
  assert.ok(!/1,312,000/.test(renderKnowledgeBaseForPrompt(held)));

  // (b) Not held and answered by a seller-visible document: on file, with the add-back note.
  const docs = [
    doc({ id: "fsum", name: "Seller's financial summary", extractedText: "SDE (FY2024): $1,163,000 per the owner's summary.", extractedData: { summary: "Owner's summary", redFlags: "Owner add-backs $395K need support" } }),
  ];
  const deal = { ...baseDeal, extractedInfo: {} };
  const bare = assembleKnowledgeBase(deal, docs, [], null, [], { sessions: [], currentSessionId: "cur" });
  assert.ok((bare.evidenceTargets ?? []).some((t) => t.id === "field:sde"), "an open SDE item is a target");
  assert.ok(!(bare.evidenceTargets ?? []).some((t) => t.kind === "risk" && /add-backs/i.test(t.key)), "a risk framed as the broker's work is not on the agenda");
  const evidence = {
    version: EVIDENCE_VERSION, fingerprint: "x", computedAt: new Date().toISOString(), status: "ready", checked: (bare.evidenceTargets ?? []).map((t) => t.id),
    entries: { "field:sde": { answer: "SDE $1,163,000 (FY2024)", source: "Seller's financial summary", sourceKind: "document", sourceId: "fsum" } },
  };
  const kb = assembleKnowledgeBase({ ...deal, interviewEvidence: evidence }, docs, [], null, [], { sessions: [], currentSessionId: "cur" });
  const prompt = renderKnowledgeBaseForPrompt(kb);
  const line = prompt.split("\n").find((l) => l.startsWith("- sde"));
  assert.ok(line, prompt);
  assert.match(line!, /never tell the seller what is added back/);
  assert.ok(!/RISKS FLAGGED[\s\S]{0,400}add-backs \$395K/.test(prompt));
  ok("on-file evidence and the seller view: held facts are on file and never targets; SDE items carry the add-back note; broker-work risks stay off");
}

console.log(`\n${n} integration-step-5 checks passed`);
