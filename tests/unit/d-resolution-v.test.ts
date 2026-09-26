/**
 * QA harvest round V — discrepancy check + resolution (d-resolution).
 *
 * Check: a like-for-like count the model dismisses is still raised; a
 * finding whose own explanation says the sides agree, or that compares a
 * proposed term with the current one, is dropped; a finding with no fact
 * key gets one from its candidate / the value on file / its label; the S-refs
 * never reach broker-facing text; one conflict raised by the check and the
 * financial analysis is one row.
 * Resolution: propagation never breaks meaning; a narrative fact is never
 * overwritten with a bare value; a headline and its by-year map move
 * together; the CIM-time overlay applies the write's guards and latest wins;
 * legacy alternates keep their real source; a value taken from the broker's
 * private side is written as private provenance.
 *
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/d-resolution-v.test.ts
 */
import assert from "node:assert/strict";
import { runDiscrepancyCheck, _setCheckModelForTests, isSameDiscrepancy, buildDiscrepancyInput } from "../../server/cim/discrepancy-engine";
import { likeForLikeCountConflict, countMentions, stripSourceRefs, sameConflictByFigures } from "../../server/cim/discrepancy-backstop";
import { dropReason } from "../../server/cim/discrepancy-filter";
import { supersedeCheckDuplicates } from "../../server/cim/discrepancy-check";
import { applyResolutionToInfo, NARRATIVE_FACT } from "../../server/information/facts";
import { findStaleFacts, swapOutdatedFigures, proposeRewrites, _setRewriteModelForTests, acceptableRewrite, dropHedgesBeforeResolved } from "../../server/information/resolution-propagation";
import { staleFactsForRow, resolutionSubject } from "../../server/routes/discrepancies";
import { resolvedNotes, overlayResolvedFacts } from "../../server/cim/resolved-block";
import { getFieldSources, getFieldAlternates } from "../../server/interview/info-merger";
import { sellerInterviewView } from "../../server/interview/seller-view";
import { splitFactsForCim } from "../../server/information/cim-facts";

type Info = Record<string, unknown>;
const row = (o: Record<string, unknown>) =>
  ({ id: "d1", dealId: "deal1", severity: "significant", category: "operational", source: "interview", status: "resolved", createdAt: new Date(), interviewValue: null, documentValue: null, documentId: null, factKey: null, factYear: null, sideSources: null, ...o }) as any;

// ════════════════════════════ CHECK ════════════════════════════

// ── Like-for-like counts (Lakeshore C17) ──
{
  const claim = "24 licensed field technicians (17-18 HVAC, 5 plumbers) plus apprentices, plus Dave and Kevin (licensed but in management roles), office staff including Brittany (dispatch team lead)";
  const evidence = "28 total (22 licensed field technicians, 2 licensed managers, 3 registered apprentices, 1 installer/helper)";
  const hit = likeForLikeCountConflict(claim, evidence);
  assert.ok(hit, "24 vs 22 licensed field technicians is a like-for-like conflict");
  assert.equal(hit!.claim.value, 24);
  assert.equal(hit!.evidence.value, 22);
  assert.equal(hit!.claim.key, "licensed field technician");
  // Different things, hedges, ranges, periods: never.
  assert.equal(likeForLikeCountConflict("26 trucks", "24 service vans + 2 owner vehicles = 26 total company vehicles"), null);
  assert.equal(likeForLikeCountConflict("about 24 licensed technicians", "22 licensed technicians"), null, "a hedged count");
  assert.equal(likeForLikeCountConflict("40+ staff", "42 staff"), null, "a floor, not a count");
  assert.equal(likeForLikeCountConflict("24 technicians in 2022", "22 technicians on the 2024 roster"), null, "different years");
  assert.equal(likeForLikeCountConflict("22 licensed technicians", "22 licensed technicians, 3 apprentices"), null, "the same number");
  assert.deepEqual(countMentions("17-18 HVAC techs, Q-25-118 quote, S18 shows").map((c) => c.text), [], "ranges, codes and refs are not counts");
  // Subsets and other periods seen on the demo deals are never raised.
  assert.equal(likeForLikeCountConflict(
    "160 trailers; yard/warehouse equipment (fleet list provided); 14 reefer trailers from 2011-2014 vintage needing replacement",
    "14 drayage units tagged for Port of Vancouver, 46 reefer trailers with temperature telematics",
  ), null, "Pacific: a subset (from 2011-2014 … needing replacement) vs a subset (with telematics)");
  assert.equal(likeForLikeCountConflict(
    "Kyle Brennan: 186 clients total",
    "186 managed clients with 2,330 covered users; geographic distribution: Nova Scotia 129 clients (70.4% MRR), New Brunswick 32 clients",
  ), null, "Harborview: the document states 186 too; 129 is one province");
  assert.equal(likeForLikeCountConflict(
    "Comfort Club membership expansion (currently 3,100 members)",
    "Expansion potential in underserved areas like Oakville (only 62 members)",
  ), null, "Lakeshore: one town's members");
  assert.equal(likeForLikeCountConflict(
    "38 injection molding presses (55 to 720 tons capacity); ERP system (CoreForge, implemented October 2024)",
    "36 injection molding presses and equipment ($29,010,500 cost). Total PP&E cost $42,886,900, net book value $20,581,200 at Dec 31, 2023.",
  ), null, "Great Lakes: the 2023 asset note vs today's count");
}

// ── The check raises a dismissed like-for-like candidate ──
await (async () => {
  const info: Info = {
    employees: "24 licensed field technicians (17-18 HVAC, 5 plumbers) plus apprentices",
    _fieldSources: { employees: { source: "video_call", documentId: "vc1" } },
    _fieldAlternates: {
      employees: [{ value: "28 total (22 licensed field technicians, 2 licensed managers, 3 registered apprentices, 1 installer/helper)", source: "document", documentId: "roster" }],
    },
  };
  const docs = [
    { id: "vc1", name: "Video call — seller walkthrough", category: "transcripts", sourceKind: "video_call", visibility: "shared", extractedText: "we have 24 licensed field technicians", extractedData: null },
    { id: "roster", name: "Staff roster (March 2025)", category: "hr", sourceKind: "document", visibility: "shared", extractedText: "22 licensed field technicians", extractedData: null },
  ];
  _setCheckModelForTests(async () => ({ discrepancies: [], dismissedCandidates: [{ id: "C1", reason: "Different counts but not a conflict: seller's rough count vs detailed roster" }], clearedIds: [] }));
  const res = await runDiscrepancyCheck({ id: "lake", businessName: "Lakeshore", extractedInfo: info }, docs as any, []);
  assert.equal(res.items.length, 1, "raised despite the dismissal");
  const it = res.items[0];
  assert.equal(it.field, "licensed field technicians".replace(/^l/, "L"));
  assert.equal(it.interviewValue, "24 licensed field technicians");
  assert.equal(it.documentValue, "22 licensed field technicians");
  // A part of the staff description, not the employees fact: no key (the
  // broker picks where it goes) — and never merged with another employees row.
  assert.equal(it.factKey, null, "licensed technicians are a part of employees, not the fact");
  assert.equal(it.severity, "significant");
  assert.equal(it.documentId, "roster");
  assert.equal(it.sideSources.interview?.kind, "video_call");
  // Reported by the model → not raised twice.
  _setCheckModelForTests(async (_s, user) => {
    const ref = (label: string) => user.match(new RegExp(`- (S\\d+): [^\\n]*${label}`))?.[1];
    return {
      discrepancies: [{ field: "Licensed technicians", candidateId: "C1", claimValue: "24 licensed field technicians", claimSource: ref("Video"), evidenceValue: "22 licensed field technicians", evidenceSource: ref("roster"), severity: "significant", category: "operational", explanation: "The seller said 24; the roster lists 22.", suggestedResolution: "Confirm." }],
      dismissedCandidates: [], clearedIds: [],
    };
  });
  const res2 = await runDiscrepancyCheck({ id: "lake", businessName: "Lakeshore", extractedInfo: info }, docs as any, []);
  assert.equal(res2.items.length, 1);
  assert.equal(res2.items[0].field, "Licensed technicians");
})();

// ── Findings that say they aren't conflicts (Beacon), proposed vs current (Ridgeline) ──
{
  const beacon = {
    field: "Lease renewal option notice period",
    interviewValue: "Option window opens in 2028, not yet exercised",
    documentValue: "Written notice required not less than 9 months and not more than 12 months prior to expiry (June 30, 2029), meaning notice window is July 1, 2028 to September 30, 2028",
    severity: "minor",
    aiExplanation: "The seller stated the option window opens in 2028, which is correct. The lease requires notice between 9 and 12 months before the June 30, 2029 expiry, meaning the window runs from July 1, 2028 to September 30, 2028. This is consistent - the seller's statement that the window 'opens in 2028' aligns with the lease terms.",
    suggestedResolution: "No conflict - both sources agree the notice window opens in 2028 (specifically July-September 2028).",
  };
  assert.equal(dropReason(beacon), "not_a_conflict");
  const ridgeline = {
    field: "Lease rent rate (years 3-5)",
    interviewValue: "$12.50/sq ft proposed new lease",
    documentValue: "$12.00/sq ft for years 3-5 (2024-2026) per current lease",
    severity: "significant",
    aiExplanation: "The seller stated the proposed new lease would be at $12.50/sq ft. The actual lease document shows the current lease runs at $12.00/sq ft for years 3-5 (2024-2026). The $12.50 rate is for a proposed future lease, not the current rate. Buyer needs to confirm whether the $12.50 rate has been agreed for the new 10-year term.",
  };
  // The verdict is the model's own field — the words "proposed", "new" or
  // "renewal" in a value decide nothing (see the real conflicts below).
  assert.equal(dropReason({ ...ridgeline, relation: "proposed_vs_current" }), "proposed_vs_current");
  assert.equal(dropReason({ ...ridgeline, relation: "different_things" }), "not_a_conflict");
  assert.equal(dropReason({ ...ridgeline, relation: "same_value" }), "not_a_conflict");
  assert.equal(dropReason({ ...ridgeline, relation: "conflict", aiExplanation: "Different rates." }), null);
  assert.equal(dropReason({ ...beacon, relation: "same_value", aiExplanation: "Opens in 2028 on both.", suggestedResolution: "Confirm." }), "not_a_conflict");
  // Real conflicts stay.
  assert.equal(dropReason({ field: "Lease expiry", interviewValue: "Expires: 2034", documentValue: "Lease expires June 30, 2029 with one five-year renewal option (to June 30, 2034)", severity: "critical", aiExplanation: "The seller says 2034; the lease expires in 2029 unless the option is exercised." }), null);
  assert.equal(dropReason({ field: "Lease expiry", interviewValue: "2034", documentValue: "June 30, 2029", severity: "significant", aiExplanation: "The document shows 2029, which is correct; the seller said 2034." }), null, "one side correct, the other wrong");
  assert.equal(dropReason({ field: "Maplecrest share", interviewValue: "No single operator represents more than approximately 25% of LTC revenue", documentValue: "Maplecrest Senior Living: 41.0% of LTC revenue", severity: "significant", aiExplanation: "The seller's statement is consistent with the contracts summary for most operators, but Maplecrest is 41%." }), null, "walked back");
  // Real conflicts whose wording a phrase list would misread (round-2 checker's cases): all kept.
  const keep: Array<[string, Record<string, unknown>]> = [
    ["renewed lease vs the lease on file", { field: "Lease expiry", severity: "critical", interviewValue: "The new lease runs to 2032", documentValue: "Lease term ends August 31, 2027", aiExplanation: "The seller says the premises lease was renewed to 2032; the only lease on file ends August 31, 2027." }],
    ["a new contract's value", { field: "Acme contract value", severity: "significant", interviewValue: "Won a new contract with Acme worth $1.2M a year", documentValue: "Acme master services agreement: $900,000 annual value", aiExplanation: "The seller says $1.2M a year; the MSA shows $900,000." }],
    ["renewal rate vs retention", { field: "Customer retention", severity: "significant", interviewValue: "Contract renewal rate is 95%", documentValue: "Customer retention 88% (2024 KPI report)", aiExplanation: "95% vs 88%." }],
    ["a renewal price", { field: "Service contract price", severity: "significant", interviewValue: "Renewal price $4,000/month", documentValue: "Monthly fee $3,200", aiExplanation: "The seller quotes $4,000 a month; the contract shows $3,200." }],
    ["consistent with 2029, not 2034", { field: "Lease expiry", severity: "significant", interviewValue: "2034", documentValue: "5-year term commencing July 1, 2024", aiExplanation: "The lease shows a 5-year term from July 2024, which is consistent with a 2029 expiry, not the 2034 the seller stated." }],
    ["agree on the total, split differs", { field: "Owner compensation", severity: "significant", interviewValue: "$240,000 salary", documentValue: "$180,000 salary + $60,000 dividend", aiExplanation: "Both sources agree on $240,000 in total; the seller calls all of it salary, the statements show $180,000 salary and a $60,000 dividend." }],
    ["correct for 2023, 2024 differs", { field: "Licensed technicians", severity: "significant", interviewValue: "24 licensed technicians", documentValue: "22 licensed technicians (2024 roster)", aiExplanation: "The seller stated 24 technicians, which is correct for the 2023 roster; the current 2024 roster shows 22." }],
    ["matches 2023 while 2024 differs", { field: "Revenue", severity: "significant", interviewValue: "$2.3M revenue last year", documentValue: "FY2024 revenue $1,820,000", aiExplanation: "The seller's figure matches the statements for 2023, while FY2024 revenue is $1,820,000 — last year means 2024." }],
    ["aligns only if the option is exercised", { field: "Lease expiry", severity: "significant", interviewValue: "Lease goes to 2034", documentValue: "Term to June 30, 2029; one 5-year option to 2034 (not exercised)", aiExplanation: "The seller's statement aligns with the lease only if the option is exercised; the lease itself expires in 2029." }],
    ["'This is consistent' walked back by 'not'", { field: "Lease expiry", severity: "minor", interviewValue: "2034", documentValue: "2029", aiExplanation: "This is consistent with the option, not with the base term the lease is on." }],
  ];
  for (const [name, item] of keep) assert.equal(dropReason(item as any), null, `kept: ${name}`);
}

// ── Fact key from the value on file / the label (Harborview "Lease expiry") ──
await (async () => {
  const info: Info = {
    leaseExpiry: "August 31, 2027, with one 5-year renewal option",
    leaseTerms: "Premises lease",
    _fieldSources: { leaseExpiry: { source: "broker" }, leaseTerms: { source: "call", documentId: "c1" } },
    _fieldAlternates: { leaseExpiry: [{ value: "August 31, 2027", source: "document", documentId: "lease" }] },
  };
  const docs = [
    { id: "c1", name: "Discovery call", category: "transcripts", sourceKind: "call", visibility: "shared", extractedText: "lease runs to 2029", extractedData: null },
    { id: "lease", name: "Office lease", category: "legal", sourceKind: "document", visibility: "shared", extractedText: "term ends August 31, 2027", extractedData: null },
  ];
  _setCheckModelForTests(async (_s, user) => {
    const ref = (label: string) => user.match(new RegExp(`- (S\\d+): [^\\n]*${label}`))?.[1];
    return {
      discrepancies: [{
        field: "Lease expiry", factKey: "", claimValue: "2029 (per S1)", claimSource: ref("Discovery call"), evidenceValue: "August 31, 2027 (per multiple sources including S2, S1)", evidenceSource: ref("Office lease"),
        severity: "significant", category: "legal", explanation: `In the discovery call (${ref("Discovery call")}) the seller said 2029; ${ref("Office lease")} shows August 31, 2027.`, suggestedResolution: `Check ${ref("Office lease")}.`,
      }],
      dismissedCandidates: [], clearedIds: [],
    };
  });
  const res = await runDiscrepancyCheck({ id: "harbor", businessName: "Harborview", extractedInfo: info }, docs as any, []);
  assert.equal(res.items.length, 1);
  const it = res.items[0];
  assert.equal(it.factKey, "leaseExpiry", "label spells the fact key");
  assert.equal(it.interviewValue, "2029");
  assert.equal(it.documentValue, "August 31, 2027");
  assert.ok(!/\bS\d+\b/.test(`${it.aiExplanation} ${it.suggestedResolution} ${it.interviewValue} ${it.documentValue}`), `no S-refs: ${it.aiExplanation} | ${it.suggestedResolution}`);
  assert.match(it.aiExplanation, /In the discovery call the seller said 2029; “Office lease” shows August 31, 2027\./);
  assert.match(it.suggestedResolution, /Check “Office lease”\./);
})();

// ── S-refs: private ones are never named ──
{
  const labels: Record<string, string | null> = { S1: "the call with the seller", S2: null, S3: "“Roster”" };
  const labelFor = (r: string) => (r in labels ? labels[r] : undefined);
  assert.equal(stripSourceRefs("18 months firm commitment (per multiple sources including S1, S3)", labelFor, "value"), "18 months firm commitment");
  assert.equal(stripSourceRefs("S2 says 30 staff, S3 shows 28", labelFor, "prose"), "another source says 30 staff, “Roster” shows 28");
  assert.equal(stripSourceRefs("Class S9 shares", labelFor, "prose"), "Class S9 shares", "not one of our refs");
  assert.equal(stripSourceRefs("as confirmed in S1, S3", labelFor, "prose"), "as confirmed according to several sources");
}

// ── One conflict, one row (Ridgeline Westlock / backlog) ──
await (async () => {
  const westlock = {
    id: "own1", dealId: "ridge", source: "interview", status: "open", severity: "critical", field: "westlockProjectStatus", factKey: null, factYear: null,
    interviewValue: "Westlock terminal expansion: verbal confirmation but awaiting board approval end of June 2025 and PO before steel can be ordered (counted in $4.2M backlog per Gord)",
    documentValue: "Q-25-118: $1,100,000 Prairie Crest Grain Co-operative - verbal award pending PO (listed in Open Quotes, NOT in signed backlog)",
    aiExplanation: "Seller describes the Westlock terminal expansion as verbally confirmed and counts it in the $4.2M backlog.",
  };
  const backlog = {
    id: "fa1", dealId: "ridge", source: "financial_analysis", status: "open", severity: "critical", field: "Signed backlog (May 2025)", factKey: "signedBacklog", factYear: "2025",
    interviewValue: "$4.2M as of end of May 2025 (stated by Gord McAllister on June 5, 2025 call and in email thread)",
    documentValue: "$3.1M signed backlog (remaining contract value on signed work with POs) as of May 31, 2025",
    aiExplanation: "Seller claims $4.2M backlog as of end of May 2025, but the WIP report shows only $3.1M in signed backlog with POs. The $1.1M difference appears to be the Westlock terminal expansion project which Gord counts in backlog but is still awaiting board approval and PO.",
  };
  assert.ok(isSameDiscrepancy(westlock, backlog), "the same conflict across sources and names");
  assert.ok(sameConflictByFigures(westlock, backlog));
  // Unrelated rows sharing one figure are not merged.
  assert.ok(!sameConflictByFigures({ field: "Coldbrook receivable", interviewValue: "$38,700 over 90 days", documentValue: "$38,700 in collections" }, backlog));
  const rows: any[] = [{ ...westlock }, { ...backlog }, { ...westlock, id: "own2", status: "ask_seller" }];
  const store = {
    getDiscrepanciesByDeal: async () => rows.map((r) => ({ ...r })),
    updateDiscrepancy: async (id: string, u: any) => Object.assign(rows.find((r) => r.id === id), u),
  };
  assert.equal(await supersedeCheckDuplicates("ridge", store as any), 1);
  assert.equal(rows[0].status, "superseded", "the check's open duplicate gives way");
  assert.equal(rows[1].status, "open", "the analysis row stays");
  assert.equal(rows[2].status, "ask_seller", "a row routed to the seller is left alone");
})();

// ════════════════════════════ RESOLUTION ════════════════════════════

// ── Propagation never breaks meaning (Pacific) ──
await (async () => {
  const info: Info = {
    customerConcentration: "Largest customer Alderbrook is about 18% of revenue (under 20%); no other customer over 10%",
    strengths: "Diversified customer base (300+ customers, no customer over 18%), strong contract with largest customer to 2027, experienced key personnel with long tenure, good safety record, no union; warehousing approximately 20% of revenue",
    customerBase: "Over 300 customers; largest is Alderbrook (grocery distributor, about 18% of revenue, customer since 2009); second largest building supply at ~8%",
    _fieldSources: { customerConcentration: { source: "call", at: "2025-11-20T15:00:00Z" }, strengths: { source: "call" }, customerBase: { source: "call" } },
  };
  const subject = { field: "Alderbrook revenue percentage", factKey: "customerConcentration", resolvedValue: "22.0%", supersededValues: ["~18% (approximately, under 20%)"] };
  const stale = findStaleFacts(info, subject);
  const strengths = stale.find((f) => f.key === "strengths")!;
  const customerBase = stale.find((f) => f.key === "customerBase")!;
  assert.ok(strengths && customerBase);
  assert.equal(swapOutdatedFigures(strengths, "22.0%"), null, "'no customer over 18%' is a bound — never 'no customer 22.0%'");
  assert.equal(swapOutdatedFigures(customerBase, "22.0%"), "Over 300 customers; largest is Alderbrook (grocery distributor, 22.0% of revenue, customer since 2009); second largest building supply at ~8%", "the hedge goes with the old figure");
  assert.equal(dropHedgesBeforeResolved("roughly 22.0% of revenue", "22.0%"), "22.0% of revenue");
  // The AI rewrite of strengths is accepted although "20%" (warehousing) stays.
  const good = "Diversified customer base (300+ customers, largest customer 22.0%), strong contract with largest customer to 2027, experienced key personnel with long tenure, good safety record, no union; warehousing approximately 20% of revenue";
  assert.ok(acceptableRewrite(strengths, good, "22.0%"));
  assert.ok(!acceptableRewrite(strengths, good.replace("; warehousing approximately 20% of revenue", ""), "22.0%"), "dropping another figure is no fix");
  assert.ok(!acceptableRewrite(strengths, strengths.value.replace("over 18%", "over 18% (22.0% per file)"), "22.0%"), "still says 18%");
  _setRewriteModelForTests(async () => [
    { key: "strengths", text: good },
    { key: "customerBase", text: "Over 300 customers; largest is Alderbrook (grocery distributor, about 22.0% of revenue, customer since 2009); second largest building supply at ~8%" },
  ]);
  const proposals = await proposeRewrites(stale, subject);
  assert.equal(proposals.find((p) => p.key === "strengths")?.method, "ai");
  assert.equal(proposals.find((p) => p.key === "strengths")?.proposed, good);
  assert.ok(!/about 22\.0%/.test(proposals.find((p) => p.key === "customerBase")!.proposed), "no hedge on the settled figure");
  // With the AI unavailable, the bound is left for a hand edit, never swapped.
  _setRewriteModelForTests(async () => { throw new Error("down"); });
  const fallback = await proposeRewrites(stale, subject);
  assert.equal(fallback.find((p) => p.key === "strengths")?.method, "manual");
  assert.ok(!fallback.some((p) => /no customer 22\.0%/.test(p.proposed)));
  _setRewriteModelForTests(null);

  // ── Linking the resolution to the narrative customerConcentration never overwrites it ──
  const d = row({ source: "financial_analysis", field: "Alderbrook revenue percentage", factKey: "customerConcentration", resolvedValue: "22.0%", interviewValue: "~18% (approximately, under 20%)", documentValue: "22.0% in FY2024" });
  const copy = structuredClone(info);
  assert.equal(applyResolutionToInfo(copy, d, { brokerChoseFact: true }), NARRATIVE_FACT);
  assert.equal(copy.customerConcentration, info.customerConcentration, "the narrative is kept");
  const { stale: offered } = staleFactsForRow(copy, d, { brokerChoseFact: true });
  assert.ok(offered.some((f) => f.key === "customerConcentration"), "offered for a rewrite instead");
  // A short figure fact is still written.
  const short: Info = { customerConcentration: "~18% (approximately, under 20%)", _fieldSources: { customerConcentration: { source: "call", documentId: "intro" } } };
  assert.equal(applyResolutionToInfo(short, d), "customerConcentration");
  assert.equal(short.customerConcentration, "22.0%");
})();

// ── Legacy alternates keep the source they came from ──
{
  // The fact on file says it with other words: its source is still found by the figure.
  const info: Info = {
    customerConcentration: "about 18%",
    _fieldSources: { customerConcentration: { source: "call", documentId: "intro", at: "2025-11-20T15:00:00Z" } },
  };
  const d = row({ source: "financial_analysis", field: "Alderbrook revenue percentage", factKey: "customerConcentration", resolvedValue: "22.0%", interviewValue: "~18% (approximately, under 20%)", documentValue: "22.0% in FY2024", documentId: "custrev" });
  applyResolutionToInfo(info, d);
  const alts = getFieldAlternates(info).customerConcentration;
  const ruled = alts.find((a) => a.value === "~18% (approximately, under 20%)");
  assert.equal(ruled?.source, "call", `the call's value is not recorded as a document: ${JSON.stringify(alts)}`);
  assert.equal(ruled?.documentId, "intro");
  assert.equal(alts.find((a) => a.value === "22.0% in FY2024")?.source, "document");
  // Nothing on file states it and no label: the seller side is the seller's, never "document".
  const bare: Info = { customerConcentration: "" };
  applyResolutionToInfo(bare, d);
  assert.equal(getFieldAlternates(bare).customerConcentration.find((a) => a.value.startsWith("~18%"))?.source, "interview");
  // A label names the kind ("— Intro call").
  const labelled: Info = {};
  applyResolutionToInfo(labelled, { ...d, interviewValue: "~18% — Intro call with Harjit" });
  assert.equal(getFieldAlternates(labelled).customerConcentration.find((a) => a.value === "~18%")?.source, "call");
}

// ── Headline and by-year map move together (both directions) ──
{
  // A per-year row → the headline follows (it is that year's figure).
  const info: Info = {
    annualRevenue: "$1,820,000",
    revenueByYear: { "2023": "$1,700,000", "2024": "$1,820,000" },
    revenueTrend: "Revenue reached $1,820,000 in 2024, up 7% on 2023",
    _fieldSources: {
      annualRevenue: { source: "document", documentId: "pl", period: "2024-12-31" },
      revenueByYear: { source: "document", documentId: "pl", years: { "2023": { source: "document", documentId: "pl" }, "2024": { source: "document", documentId: "pl" } } },
    },
  };
  const d = row({ source: "merge", field: "Revenue (2024)", factKey: "revenueByYear", factYear: "2024", resolvedValue: "$2,300,000", interviewValue: "$2,300,000", documentValue: "$1,820,000" });
  assert.equal(applyResolutionToInfo(info, d), "revenueByYear.2024");
  assert.equal((info.revenueByYear as any)["2024"], "$2,300,000");
  assert.equal(info.annualRevenue, "$2,300,000", "the headline is 2024's figure — it follows");
  assert.equal(getFieldSources(info).annualRevenue.source, "broker");
  assert.equal((info.revenueByYear as any)["2023"], "$1,700,000", "other years untouched");
  // Propagation sees revenue narratives now (revenue is the subject of a revenue resolution).
  const stale = findStaleFacts(info, { ...resolutionSubject(d)!, factKey: "revenueByYear", factYear: "2024" });
  assert.deepEqual(stale.map((f) => f.key), ["revenueTrend"]);
  // A hedged figure that still fits the settled one is not outdated (Pacific: "~$31M" beside $31,240,000).
  const pac: Info = { keyFinancialNotes: "Revenue: 2024 ~$31M, 2025 ~$31.8M", revenue2024: "$31,020,000" };
  const pacStale = findStaleFacts(pac, { field: "Revenue (2024)", factKey: "revenueByYear", factYear: "2024", resolvedValue: "$31,240,000", supersededValues: ["$31,500,000", "$31,020,000"] });
  assert.deepEqual(pacStale.map((f) => f.key), ["revenue2024"]);

  // A headline row with a year → that year of the map follows.
  const info2: Info = {
    ebitda: "$640,000",
    ebitdaByYear: { "2023": "$580,000", "2024": "$640,000" },
    _fieldSources: { ebitda: { source: "call", documentId: "c1" }, ebitdaByYear: { source: "document", documentId: "fs", years: { "2023": { source: "document", documentId: "fs" }, "2024": { source: "document", documentId: "fs" } } } },
  };
  const d2 = row({ source: "interview", field: "EBITDA 2024", factKey: "ebitda", factYear: "2024", resolvedValue: "$612,400", interviewValue: "$640,000", documentValue: "$612,400" });
  applyResolutionToInfo(info2, d2);
  assert.equal(info2.ebitda, "$612,400");
  assert.equal((info2.ebitdaByYear as any)["2024"], "$612,400", "the map year follows");
  assert.equal((info2.ebitdaByYear as any)["2023"], "$580,000");
  // An older year never moves the headline.
  const info3: Info = structuredClone(info2);
  applyResolutionToInfo(info3, row({ source: "merge", field: "EBITDA (2023)", factKey: "ebitdaByYear", factYear: "2023", resolvedValue: "$575,000", interviewValue: "$580,000", documentValue: "$575,000" }));
  assert.equal(info3.ebitda, "$612,400");
  assert.equal((info3.ebitdaByYear as any)["2023"], "$575,000");
}

// ── The CIM-time overlay applies the same guards (and latest wins) ──
{
  const narrative = "24 licensed technicians, 5 plumbers, 3 office staff led by Denise Tran; two service managers; seasonal installers every spring";
  const info: Info = {
    employeeStructure: narrative,
    employees: "36 employees plus owner",
    _fieldSources: { employeeStructure: { source: "call", at: "2025-01-01T00:00:00Z" }, employees: { source: "document", at: "2025-01-01T00:00:00Z" } },
  };
  const resolved = (o: Record<string, unknown>) => row({ interviewValue: "24 licensed field technicians", documentValue: "22 licensed field technicians", resolvedValue: "22 licensed technicians", resolvedAt: new Date("2025-06-01T00:00:00Z"), ...o });
  const out = overlayResolvedFacts(info, resolvedNotes([
    resolved({ id: "a", field: "Licensed technicians", factKey: "employeeStructure" }),
    resolved({ id: "b", field: "Licensed technicians", factKey: "employees" }),
  ]));
  assert.equal(out.employeeStructure, narrative, "a description is never overwritten with the bare value");
  assert.equal(out.employees, "36 employees plus owner", "a fact that isn't the figure is never overwritten");

  // Latest wins: a later broker edit stands; the newest resolution stands, whatever the row order.
  const facts: Info = {
    revenueByYear: { "2024": "$2,250,000" },
    sde: "$690,000",
    _fieldSources: {
      revenueByYear: { source: "broker", years: { "2024": { source: "broker", at: "2025-08-01T00:00:00Z" } } },
      sde: { source: "call", at: "2025-01-01T00:00:00Z" },
    },
  };
  const r2024 = row({ id: "r1", source: "merge", field: "Revenue (2024)", factKey: "revenueByYear", factYear: "2024", interviewValue: "$2,300,000", documentValue: "$1,820,000", resolvedValue: "$2,300,000", resolvedAt: new Date("2025-06-01T00:00:00Z") });
  const olderSde = row({ id: "s1", source: "financial_analysis", field: "SDE", factKey: "sde", interviewValue: "$690,000", documentValue: "$640,000", resolvedValue: "$640,000", resolvedAt: new Date("2025-03-01T00:00:00Z") });
  const newerSde = row({ id: "s2", source: "financial_analysis", field: "SDE", factKey: "sde", interviewValue: "$640,000", documentValue: "$655,000", resolvedValue: "$655,000", resolvedAt: new Date("2025-04-01T00:00:00Z") });
  for (const order of [[r2024, olderSde, newerSde], [newerSde, r2024, olderSde]]) {
    const o = overlayResolvedFacts(facts, resolvedNotes(order));
    assert.equal((o.revenueByYear as any)["2024"], "$2,250,000", "the broker's later edit is not overridden");
    assert.equal(o.sde, "$655,000", "the newest resolution wins, in any order");
    const sdeNotes = resolvedNotes(order).filter((n) => n.factKey === "sde");
    assert.deepEqual(sdeNotes.map((n) => n.resolvedValue), ["$655,000"], "one final value per fact in the RESOLVED block");
    assert.equal(getFieldSources(o).sde.source, "broker");
  }
  // A headline row with a year overlays the map year too (older rows written before the pair write).
  const legacy: Info = { annualRevenue: "$1,820,000", revenueByYear: { "2024": "$1,820,000" }, _fieldSources: { annualRevenue: { source: "document", period: "2024-12-31" } } };
  const o2 = overlayResolvedFacts(legacy, resolvedNotes([row({ source: "financial_analysis", field: "2024 Revenue", factKey: "annualRevenue", factYear: "2024", interviewValue: "$2,300,000", documentValue: "$1,820,000", resolvedValue: "$2,300,000", resolvedAt: new Date("2025-06-01T00:00:00Z") })]));
  assert.equal(o2.annualRevenue, "$2,300,000");
  assert.equal((o2.revenueByYear as any)["2024"], "$2,300,000");
  assert.equal(legacy.annualRevenue, "$1,820,000", "the overlay never mutates its input");
}

// ── A value settled from the broker's private side is private provenance ──
{
  const info: Info = {
    ebitda: "$1,398,000",
    _fieldSources: { ebitda: { source: "call", documentId: "call1", at: "2025-01-01T00:00:00Z" } },
    _fieldAlternates: { ebitda: [{ value: "$1,500,000", source: "crm", documentId: "crm1", brokerOnly: true }] },
  };
  const d = row({
    source: "merge", field: "EBITDA", factKey: "ebitda", interviewValue: "$1,398,000", documentValue: "$1,500,000",
    sideSources: { interview: { kind: "call", documentId: "call1" }, document: { kind: "crm", documentId: "crm1", brokerOnly: true } },
    resolvedValue: "$1,500,000",
  });
  applyResolutionToInfo(info, d);
  const src = getFieldSources(info).ebitda;
  assert.equal(src.source, "broker");
  assert.equal(src.brokerOnly, true, "private from the seller");
  assert.equal(src.acceptedByBroker, true, "vouched for by the broker");
  const docs = [{ id: "call1", visibility: "shared" }, { id: "crm1", visibility: "broker_only" }] as any;
  const view = sellerInterviewView(info, docs);
  assert.equal(view.ebitda, undefined, "the seller interview neither sees the private figure nor the ruled-out one in its place");
  assert.ok(!JSON.stringify(view).includes("1,500,000"));
  const cim = splitFactsForCim(info);
  assert.ok(cim.confirmed.some(([k, v]) => k === "ebitda" && v === "$1,500,000"), "the CIM uses the broker's settled figure");
  // Settled on the shared side: an ordinary broker fact.
  const info2: Info = structuredClone({ ...info, ebitda: "$1,398,000", _fieldSources: { ebitda: { source: "call", documentId: "call1" } } });
  applyResolutionToInfo(info2, { ...d, resolvedValue: "$1,398,000" });
  assert.ok(!getFieldSources(info2).ebitda.brokerOnly);
  // The overlay marks it the same way.
  const notes = resolvedNotes([{ ...d, resolvedAt: new Date() }]);
  assert.equal(notes[0].fromPrivateSide, true);
  assert.ok(!JSON.stringify(notes[0].guardSides).includes("1,500,000"), "a private side is never carried in a note");
}

// ── Candidates the input exposes for fact-key inference ──
{
  const input = buildDiscrepancyInput({ employees: "24 techs", _fieldSources: { employees: { source: "call" } } }, []);
  assert.ok((input.entries ?? []).some((e) => e.key === "employees"));
}

_setCheckModelForTests(null);
console.log("d-resolution-v: ok");
