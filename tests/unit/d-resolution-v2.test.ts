/**
 * QA harvest round V, round 2 — discrepancy check + resolution (d-resolution).
 * The live checker's open findings on round 1:
 *  1. The model's verdict is a field (`relation`), not a phrase list read out
 *     of its explanation — real conflicts worded "consistent with …, not …",
 *     "which is correct for 2023", "the new lease runs to 2032" are kept.
 *  2. A finding about a PART of a fact (licensed technicians inside the
 *     whole-staff description) never carries that fact's key — from the
 *     model, the candidate or the count backstop — so it is never merged
 *     with, or dropped as, another conflict on the same fact.
 *  3. "The same conflict" by figures needs the same KIND of figure (a count
 *     of the same thing, never "2 years" = "Tier 2"), no time spans, and a
 *     name word; camelCase names are words.
 *  4. A resolution a later edit or resolution replaced is not a final value
 *     (overlay, CIM RESOLVED block, interview SETTLED block); one the write
 *     rules refused is not labelled "confirmed by the broker".
 *
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/d-resolution-v2.test.ts
 */
import assert from "node:assert/strict";
import { runDiscrepancyCheck, _setCheckModelForTests, isSameDiscrepancy, findingIsWholeFact, inferFactKey, buildDiscrepancyInput } from "../../server/cim/discrepancy-engine";
import { sameConflictByFigures } from "../../server/cim/discrepancy-backstop";
import { dropReason } from "../../server/cim/discrepancy-filter";
import { resolvedNotes, settleResolvedFacts, renderResolvedBlock, currentResolvedNotes } from "../../server/cim/resolved-block";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";

type Info = Record<string, unknown>;
let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
const row = (o: Record<string, unknown>) =>
  ({ id: `r${Math.random()}`, dealId: "deal1", severity: "significant", category: "operational", source: "interview", status: "resolved", createdAt: new Date(), interviewValue: null, documentValue: null, documentId: null, factKey: null, factYear: null, sideSources: null, resolvedValue: null, resolvedAt: null, aiExplanation: null, ...o }) as any;

// ── Lakeshore fixture: the whole-staff description on file, the roster says 22 ──
const lakeInfo: Info = {
  employees: "24 licensed field technicians (17-18 HVAC, 5 plumbers) plus apprentices, plus Dave and Kevin (licensed but in management roles), office staff including Brittany (dispatch team lead)",
  _fieldSources: { employees: { source: "video_call", documentId: "vc1" } },
  _fieldAlternates: {
    employees: [{ value: "28 total (22 licensed field technicians, 2 licensed managers, 3 registered apprentices, 1 installer/helper)", source: "document", documentId: "roster" }],
  },
};
const lakeDocs = [
  { id: "vc1", name: "Video call — seller walkthrough", category: "transcripts", sourceKind: "video_call", visibility: "shared", extractedText: "we have 24 licensed field technicians", extractedData: null },
  { id: "roster", name: "Staff roster (March 2025)", category: "hr", sourceKind: "document", visibility: "shared", extractedText: "22 licensed field technicians", extractedData: null },
];
const refOf = (user: string, label: string) => user.match(new RegExp(`- (S\\d+): [^\\n]*${label}`))?.[1];

await (async () => {
  // A settled "Total employee headcount" linked to employees by the broker
  // (the checker's PATCH_FK replay dropped the technicians finding as it).
  const headcount = row({ id: "hc", field: "Total employee headcount", factKey: "employees", interviewValue: "36 employees plus owner (37 total)", documentValue: "36 total employees including owner", resolvedValue: "36 employees (excluding the owner)" });

  // (a) The model dismisses C1 → the backstop raises it, with no fact key, and it survives the settled headcount row.
  _setCheckModelForTests(async () => ({ discrepancies: [], dismissedCandidates: [{ id: "C1", reason: "seller's rough count vs detailed roster" }], clearedIds: [] }));
  let res = await runDiscrepancyCheck({ id: "lake", businessName: "Lakeshore", extractedInfo: lakeInfo }, lakeDocs as any, [headcount]);
  assert.equal(res.items.length, 1, "raised, and not taken for the settled headcount conflict");
  assert.equal(res.items[0].factKey, null);
  assert.equal(res.items[0].interviewValue, "24 licensed field technicians");

  // (b) The model REPORTS it but calls it different_things → dropped by the
  // filter, and the backstop still raises the count conflict.
  _setCheckModelForTests(async (_s, user) => ({
    discrepancies: [{ relation: "different_things", candidateId: "C1", field: "Licensed technicians", claimValue: "24", claimSource: refOf(user, "Video"), evidenceValue: "22", evidenceSource: refOf(user, "roster"), severity: "minor", category: "operational", explanation: "Rough count vs roster.", suggestedResolution: "None." }],
    dismissedCandidates: [], clearedIds: [],
  }));
  res = await runDiscrepancyCheck({ id: "lake", businessName: "Lakeshore", extractedInfo: lakeInfo }, lakeDocs as any, []);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].field, "Licensed field technicians", "the backstop's row, not the model's dismissed one");

  // (c) The model reports it as a conflict but names factKey employees
  // against the prompt → the key is dropped (a part is not the fact).
  _setCheckModelForTests(async (_s, user) => ({
    discrepancies: [{ relation: "conflict", candidateId: "C1", factKey: "employees", field: "Licensed field technicians", claimValue: "24 licensed field technicians", claimSource: refOf(user, "Video"), evidenceValue: "22 licensed field technicians", evidenceSource: refOf(user, "roster"), severity: "significant", category: "operational", explanation: "24 vs 22.", suggestedResolution: "Confirm." }],
    dismissedCandidates: [], clearedIds: [],
  }));
  res = await runDiscrepancyCheck({ id: "lake", businessName: "Lakeshore", extractedInfo: lakeInfo }, lakeDocs as any, [headcount]);
  assert.equal(res.items.length, 1, "one row (the backstop doesn't duplicate a reported conflict)");
  assert.equal(res.items[0].factKey, null, "model's key for a part of the fact is dropped");

  // (d) Same finding, but the fact IS the count → the key stands.
  const countInfo: Info = { ...lakeInfo, employees: undefined, licensedTechnicians: "24 licensed field technicians", _fieldSources: { licensedTechnicians: { source: "video_call", documentId: "vc1" } }, _fieldAlternates: { licensedTechnicians: [{ value: "22 licensed field technicians", source: "document", documentId: "roster" }] } };
  delete (countInfo as any).employees;
  _setCheckModelForTests(async () => ({ discrepancies: [], dismissedCandidates: [], clearedIds: [] }));
  res = await runDiscrepancyCheck({ id: "lake", businessName: "Lakeshore", extractedInfo: countInfo }, lakeDocs as any, []);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].factKey, "licensedTechnicians", "a fact that is just the count keeps its key");
  _setCheckModelForTests(null);
  ok("count backstop: a part of a fact carries no key; the model's verdict can't hide a like-for-like count");
})();

// ── findingIsWholeFact / inferFactKey ──
{
  const f = (field: string, c: string, e: string) => ({ field, claimValue: c, evidenceValue: e });
  assert.ok(findingIsWholeFact("leaseExpiry", ["August 31, 2027, with one 5-year renewal option"], f("Lease expiry", "2029", "August 31, 2027")), "label names the fact");
  assert.ok(findingIsWholeFact("employees", ["36 employees plus owner"], f("Total employee headcount", "37", "36")), "employee ≈ employees");
  assert.ok(findingIsWholeFact("revenueByYear", [], f("FY2024 sales", "$2.3M", "$1,820,000")), "a headline figure is always the fact");
  assert.ok(findingIsWholeFact("staffCount", ["36"], f("Headcount", "36", "34")), "a fact that is one figure");
  assert.ok(!findingIsWholeFact("employees", [String(lakeInfo.employees)], f("Licensed field technicians", "24 licensed field technicians", "22 licensed field technicians")));
  assert.ok(!findingIsWholeFact("trainingSupport", ["Aisha: 12 months full-time then 6 months consulting; Kyle: 18 months firm commitment, open to extending with the right buyer"], f("Kyle Brennan transition commitment", "2 years full-time", "18 months firm commitment")));
  const input = buildDiscrepancyInput(lakeInfo, lakeDocs as any);
  const cand = input.candidates[0];
  assert.equal(inferFactKey(input, { ...f("Licensed field technicians", "24 licensed field technicians", "22 licensed field technicians"), candidate: cand }), null, "the candidate's key is not inferred for a part");
  assert.deepEqual(inferFactKey(input, { ...f("Employees", "24 licensed field technicians …", "28 total …"), candidate: cand }), { factKey: "employees", factYear: null });
  ok("a fact key is only inferred for a finding about the whole fact");
}

// ── Same conflict by figures / by name ──
{
  const tier1 = {
    field: "tier1Turnover",
    interviewValue: "Four Tier 1 departures in 2024 (stated as '4/8 in 2024' meaning 4 out of 8 seats)",
    documentValue: "Staff list shows 8 Tier 1 positions with 4 departures noted in April 16 email, but org chart shows current headcount",
    resolvedValue: "4 of 8 Tier 1 service desk seats turned over in 2024; since addressed with a Tier 1 to Tier 2 career path and a $2,000 retention bonus at 18 months.",
    aiExplanation: "The seller disclosed 4 Tier 1 departures in 2024 (50% turnover at that level) in the April 16 email.",
  };
  const kyle = { field: "Kyle Brennan transition commitment", factKey: null, factYear: null, interviewValue: "2 years full-time", documentValue: "18 months firm commitment" };
  assert.ok(!sameConflictByFigures(kyle, tier1), "'2 years' is not 'Tier 2', '18 months' is a time span");
  assert.ok(!isSameDiscrepancy(kyle, { id: "t", status: "resolved", severity: "minor", ...tier1 }));
  const kyleRow = {
    id: "k", status: "resolved", severity: "significant", field: "kyleTransitionCommitment",
    interviewValue: "Kyle committed to staying 2 years post-sale (per Aisha in multiple interviews and April 2 email)",
    documentValue: "Kyle states 18 months firm commitment in May 13 email and May 6 call",
    resolvedValue: "Kyle Brennan (CTO, 45%) is committed to 18 months post-closing (firm), open to extending with the right buyer.",
  };
  assert.ok(isSameDiscrepancy(kyle, kyleRow), "camelCase names are words: the settled Kyle row is this conflict");
  // Counts must count the same thing.
  assert.ok(!sameConflictByFigures(
    { field: "Service vans", interviewValue: "24 service vans", documentValue: "26 vehicles" },
    { field: "Technicians", interviewValue: "24 technicians", documentValue: "26 staff", aiExplanation: "vans" },
  ));
  // Two different conflicts linked to one fact.
  const techs = { field: "Licensed field technicians", factKey: "employees", factYear: null, interviewValue: "24 licensed field technicians", documentValue: "22 licensed field technicians" };
  const hc = { id: "hc", status: "resolved", severity: "minor", field: "Total employee headcount", factKey: "employees", interviewValue: "36 employees plus owner (37 total)", documentValue: "36 total employees including owner", resolvedValue: "36 employees" };
  assert.ok(!isSameDiscrepancy(techs, hc), "one fact, two different conflicts");
  assert.ok(isSameDiscrepancy({ ...techs, field: "Employee headcount", interviewValue: "37", documentValue: "36" }, hc), "same fact, same subject");
  ok("the same conflict: same kind of figure, no time spans, a name word; one fact can hold two conflicts");
}

// ── The verdict is the model's, not a phrase list ──
{
  const base = { field: "Lease rent rate (years 3-5)", interviewValue: "$12.50/sq ft proposed new lease", documentValue: "$12.00/sq ft for years 3-5 (2024-2026) per current lease", severity: "significant", aiExplanation: "The $12.50 rate is for a proposed future lease, not the current rate." };
  assert.equal(dropReason(base), null, "no verdict field → the words alone never drop a row");
  assert.equal(dropReason({ ...base, relation: "proposed_vs_current" }), "proposed_vs_current");
  assert.equal(dropReason({ field: "Lease expiry", severity: "critical", interviewValue: "The new lease runs to 2032", documentValue: "Lease term ends August 31, 2027", aiExplanation: "Renewed to 2032 per the seller; the lease on file ends 2027." }), null);
  ok("proposed-vs-current and agreement come from the model's relation field");
}

// ── An open row the model now judges not a conflict is cleared, even without its id ──
await (async () => {
  const info: Info = {
    leaseDetails: "$12.50/sq ft proposed new lease",
    _fieldSources: { leaseDetails: { source: "call", documentId: "call1" } },
    _fieldAlternates: { leaseDetails: [{ value: "$12.00/sq ft for years 3-5 (2024-2026) per current lease", source: "document", documentId: "lease" }] },
  };
  const docs = [
    { id: "call1", name: "Call", category: "transcripts", sourceKind: "call", visibility: "shared", extractedText: "proposed $12.50", extractedData: null },
    { id: "lease", name: "Premises lease", category: "legal", sourceKind: "document", visibility: "shared", extractedText: "$12.00/sq ft years 3-5", extractedData: null },
  ];
  const open = { id: "11111111-1111-4111-8111-111111111111", status: "open", severity: "significant", source: "interview", field: "Lease rent rate (years 3-5)", factKey: "leaseDetails", interviewValue: "$12.50/sq ft proposed new lease", documentValue: "$12.00/sq ft for years 3-5 (2024-2026) per current lease" };
  _setCheckModelForTests(async (_s, user) => ({
    discrepancies: [{ relation: "proposed_vs_current", field: "Lease rent rate (years 3-5)", factKey: "leaseDetails", claimValue: "$12.50/sq ft proposed new lease", claimSource: refOf(user, "Call"), evidenceValue: "$12.00/sq ft for years 3-5 per current lease", evidenceSource: refOf(user, "Premises lease"), severity: "significant", category: "legal", explanation: "A proposed rate, not the current one.", suggestedResolution: "None." }],
    dismissedCandidates: [], clearedIds: [],
  }));
  const res = await runDiscrepancyCheck({ id: "ridge", businessName: "Ridgeline", extractedInfo: info }, docs as any, [open]);
  _setCheckModelForTests(null);
  assert.equal(res.items.length, 0);
  assert.deepEqual(res.clearedIds, [open.id]);
  ok("a row the model now calls proposed-vs-current is cleared");
})();

// ── Latest wins everywhere: overlay, RESOLVED block, SETTLED block ──
{
  const info: Info = {
    annualRevenue: "$31,250,000",
    revenueByYear: { "2023": "$29,180,000", "2024": "$31,250,000" },
    _fieldSources: {
      annualRevenue: { source: "broker", at: "2026-09-26T09:30:00Z" },
      revenueByYear: { source: "broker", at: "2026-09-26T09:30:00Z" },
    },
  };
  const rev = row({ id: "rev", field: "Revenue (2024)", factKey: "revenueByYear", factYear: "2024", source: "merge", interviewValue: "$31,500,000", documentValue: "$31,020,000", resolvedValue: "$31,500,000", resolvedAt: new Date("2026-09-26T09:27:30Z") });
  const settled = settleResolvedFacts(info, resolvedNotes([rev]));
  assert.equal(settled.notes[0].status, "superseded", "the broker's later edit replaced it");
  assert.equal((settled.facts.revenueByYear as any)["2024"], "$31,250,000");
  assert.equal(settled.facts.annualRevenue, "$31,250,000");
  assert.equal(renderResolvedBlock(settled.notes), "", "not listed as a final value");
  assert.equal(currentResolvedNotes(settled.notes).length, 0);

  // Before the edit: the resolution stands and is listed.
  const before: Info = { ...info, annualRevenue: "$31,020,000", revenueByYear: { "2023": "$29,180,000", "2024": "$31,020,000" }, _fieldSources: { annualRevenue: { source: "document", at: "2025-12-11T17:24:00Z" }, revenueByYear: { source: "document", at: "2025-12-11T17:24:00Z" } } };
  const s2 = settleResolvedFacts(before, resolvedNotes([rev]));
  assert.equal(s2.notes[0].status, "applied");
  assert.equal((s2.facts.revenueByYear as any)["2024"], "$31,500,000");
  assert.equal(s2.facts.annualRevenue, "$31,500,000", "headline moves with the map year");
  assert.match(renderResolvedBlock(s2.notes), /Revenue \(2024\): \$31,500,000/);

  // A reprocessed document re-stating the value the broker ruled out is not newer information.
  const reproc: Info = { ...before, _fieldSources: { annualRevenue: { source: "document", at: "2026-09-27T00:00:00Z" }, revenueByYear: { source: "document", at: "2026-09-27T00:00:00Z" } } };
  assert.equal(settleResolvedFacts(reproc, resolvedNotes([rev])).notes[0].status, "applied");
  // …but a new third figure from a newer statement is.
  const restated: Info = { ...reproc, annualRevenue: "$31,100,000", revenueByYear: { "2024": "$31,100,000" } };
  assert.equal(settleResolvedFacts(restated, resolvedNotes([rev])).notes[0].status, "superseded");

  // A newer resolution of the pair supersedes an older one on the map year.
  const head = row({ id: "head", field: "Annual revenue", factKey: "annualRevenue", factYear: "2024", source: "financial_analysis", interviewValue: "$31,500,000", documentValue: "$31,020,000", resolvedValue: "$31,300,000", resolvedAt: new Date("2026-09-26T10:00:00Z") });
  const s3 = settleResolvedFacts(before, resolvedNotes([rev, head]));
  assert.equal(s3.notes.length, 1, "one final value for one headline figure");
  assert.equal(s3.facts.annualRevenue, "$31,300,000");
  ok("a resolution a later edit or resolution replaced is not final anywhere");
}

// ── Two different things on one fact are both final; the same thing twice is one ──
{
  const t = row({ id: "t", field: "Licensed field technicians", factKey: "employees", interviewValue: "24 licensed field technicians", documentValue: "22 licensed field technicians", resolvedValue: "22 licensed field technicians", resolvedAt: new Date("2026-09-01") });
  const h = row({ id: "h", field: "Total employee headcount", factKey: "employees", interviewValue: "37", documentValue: "36", resolvedValue: "36 employees", resolvedAt: new Date("2026-09-02") });
  assert.equal(resolvedNotes([t, h]).length, 2);
  const h2 = row({ id: "h2", field: "Employee headcount", factKey: "employees", interviewValue: "36 employees", documentValue: "35", resolvedValue: "35 employees", resolvedAt: new Date("2026-09-03") });
  const notes = resolvedNotes([t, h, h2]);
  assert.deepEqual(notes.map((x) => x.id).sort(), ["h2", "t"], "the later headcount resolution replaces the earlier one");
  ok("one final value per settled thing, not per fact key");
}

// ── Interview: only a fact holding the broker's value is "confirmed by the broker" ──
{
  const deal: any = {
    id: "d1", brokerId: "b1", businessName: "Pacific Coast Logistics", industry: "Transportation", subIndustry: null, location: "BC",
    description: null, questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null, scrapeSource: null,
    sellerProfile: null, sectionImportance: null, interviewOutline: null, interviewPlan: null, askingPrice: null, interviewSourceReview: null,
    extractedInfo: {
      customerConcentration: "Largest customer Alderbrook is about 18% of revenue (under 20%); no other customer over 10%",
      driverCount: "Over 110 professional drivers",
      _fieldSources: { customerConcentration: { source: "call", at: "2025-11-20T15:00:00Z" }, driverCount: { source: "call", at: "2025-11-20T15:00:00Z" } },
    },
  };
  const rows = [
    row({ field: "Alderbrook revenue percentage", factKey: "customerConcentration", source: "financial_analysis", interviewValue: "~18% (approximately, under 20%)", documentValue: "22.0% in FY2024", resolvedValue: "22.0%", resolvedAt: new Date("2026-09-26T09:27:15Z") }),
    row({ field: "driverCount", source: "interview", interviewValue: "Over 110 professional drivers", documentValue: "96 drivers at December 31, 2024", resolvedValue: "96 company drivers at Dec 31, 2024", resolvedAt: new Date("2026-01-31") }),
  ];
  const kb = assembleKnowledgeBase(deal, [], [], null, rows);
  const prompt = renderKnowledgeBaseForPrompt(kb);
  const line = prompt.split("\n").find((l) => l.startsWith("- customerConcentration:"))!;
  assert.ok(line, "the fact is listed");
  assert.ok(!/confirmed by the broker/.test(line), `a refused (narrative) write is not "confirmed by the broker": ${line}`);
  assert.match(line, /partly outdated: the broker settled "Alderbrook revenue percentage"/);
  assert.match(prompt, /- driverCount: 96 company drivers at Dec 31, 2024\s+\[confirmed by the broker\]/, "an applied resolution is");
  assert.match(prompt, /customerConcentration — Alderbrook revenue percentage: 22\.0% — replaces "~18% \(approximately, under 20%\)" \(outdated\)/);
  // A later broker edit replaces the settled value: not listed as final, not overlaid.
  const edited = { ...deal, extractedInfo: { ...deal.extractedInfo, driverCount: "98 drivers (Sept 2026 roster)", _fieldSources: { ...deal.extractedInfo._fieldSources, driverCount: { source: "broker", at: "2026-09-20T00:00:00Z" } } } };
  const p2 = renderKnowledgeBaseForPrompt(assembleKnowledgeBase(edited, [], [], null, rows));
  assert.ok(!/96 company drivers/.test(p2), "the replaced resolution is gone from the prompt");
  assert.match(p2, /- driverCount: 98 drivers \(Sept 2026 roster\)/);
  ok("interview labels and SETTLED block follow what actually happened to each resolution");
}

console.log(`d-resolution-v2: ok (${n})`);
process.exit(0);
