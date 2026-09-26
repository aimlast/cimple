// QA harvest round V — integration step 4 (i-privacy-ux + i-output onto the
// merged f-/d-/c-/misc streams). Where two streams' mechanisms meet:
//  1. A discrepancy resolution to a private side: d-resolution writes
//     brokerOnly + acceptedByBroker (the CIM may use it, the analysis keeps it
//     private); i-privacy-ux writes hiddenFromSeller and also recognises small
//     counts and sides backed by a row that is broker-only now. One write
//     carries all three, whichever check fires.
//  2. The interview's resolved-facts overlay (d-resolution settleResolvedFacts)
//     runs on the seller view (i-privacy-ux): a settled value is screened like
//     a fact the broker typed, and a fact the view holds stays held — the
//     overlay never puts back an SDE / add-back figure or a recast clause.
//  3. Private notes consolidated from several sources (f-conflicts-notes) are
//     judged for broker-work wording on the words the interview reads (the
//     seller-side source's own), not the merged text.
// Offline: no database, no AI.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/v-integ-step4.test.ts
import assert from "node:assert/strict";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";
import { sellerInterviewView, heldByBroker } from "../../server/interview/seller-view";
import { applyResolutionToInfo, markHiddenFromSeller } from "../../server/information/facts";
import { getFieldSources } from "../../server/interview/info-merger";
import { isPrivateToBroker } from "../../server/information/cim-facts";

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
  severity: "significant", category: "financial", source: "merge", sideSources: null, aiExplanation: null, suggestedResolution: null,
  status: "resolved", sellerResponse: null, brokerNotes: null, resolvedValue: null, resolvedAt: new Date("2026-09-20T10:00:00Z"), resolvedBy: null, createdAt: new Date(), ...o,
});

// ── 1. One private-provenance write, whichever check fires ──
{
  // Recorded private side, figure ≥ 100 (both checks agree).
  const info: Record<string, unknown> = { annualRevenue: "$2,300,000", _fieldSources: { annualRevenue: { source: "interview", sessionId: "s1" } } };
  applyResolutionToInfo(info, disc({
    field: "2024 revenue", factKey: "annualRevenue", sideSources: { interview: { kind: "crm", brokerOnly: true }, document: { kind: "document", documentId: "pl" } },
    interviewValue: "$1.94M", documentValue: "$2,300,000", resolvedValue: "$1,940,000",
  }), { brokerChoseFact: true });
  const src = getFieldSources(info).annualRevenue;
  assert.equal(src.brokerOnly, true);
  assert.equal(src.acceptedByBroker, true);
  assert.equal(src.hiddenFromSeller, true);
  assert.equal(isPrivateToBroker(src), false, "the broker vouched for it — the CIM may use it");

  // A small count only the text comparison sees ("41 incl. 5 seasonal"): same full provenance.
  const info2: Record<string, unknown> = { employees: "36 employees plus owner", _fieldSources: { employees: { source: "call", documentId: "c1" } } };
  applyResolutionToInfo(info2, disc({
    field: "Total headcount", factKey: "employees",
    sideSources: { interview: { kind: "crm", brokerOnly: true }, document: { kind: "call", documentId: "c1" } },
    interviewValue: "41 incl. 5 seasonal", documentValue: "36 employees plus owner", resolvedValue: "41 incl. 5 seasonal",
  }), { brokerChoseFact: true });
  const src2 = getFieldSources(info2).employees;
  assert.deepEqual([src2.brokerOnly, src2.acceptedByBroker, src2.hiddenFromSeller], [true, true, true]);

  // A side backed by a row that is broker-only NOW (no recorded flag on the row).
  const info3: Record<string, unknown> = { leaseExpiry: "August 15, 2028", _fieldSources: { leaseExpiry: { source: "document", documentId: "lease" } } };
  applyResolutionToInfo(info3, disc({
    field: "Lease expiry", factKey: "leaseExpiry", documentId: "memo",
    interviewValue: "August 15, 2028", documentValue: "March 31, 2027", resolvedValue: "March 31, 2027",
  }), { brokerChoseFact: true, brokerOnlyDocIds: new Set(["memo"]) });
  const src3 = getFieldSources(info3).leaseExpiry;
  assert.equal(src3.hiddenFromSeller, true);
  assert.equal(src3.brokerOnly, true);

  // Resolved to the public side: nothing private written.
  const info4: Record<string, unknown> = { leaseExpiry: "March 31, 2027", _fieldSources: { leaseExpiry: { source: "document", documentId: "memo" } } };
  applyResolutionToInfo(info4, disc({
    field: "Lease expiry", factKey: "leaseExpiry", documentId: "memo",
    interviewValue: "August 15, 2028", documentValue: "March 31, 2027", resolvedValue: "August 15, 2028",
  }), { brokerChoseFact: true, brokerOnlyDocIds: new Set(["memo"]) });
  const src4 = getFieldSources(info4).leaseExpiry;
  assert.equal(src4.hiddenFromSeller, undefined);
  assert.equal(src4.brokerOnly, undefined);

  // "Save as a new fact" from a private side: the same provenance.
  const info5: Record<string, unknown> = { renewalRate: "88%", _fieldSources: { renewalRate: { source: "broker" } } };
  markHiddenFromSeller(info5, "renewalRate");
  const src5 = getFieldSources(info5).renewalRate;
  assert.deepEqual([src5.brokerOnly, src5.acceptedByBroker, src5.hiddenFromSeller], [true, true, true]);
  const view5 = sellerInterviewView(info5, []) as Record<string, unknown>;
  assert.equal(view5.renewalRate, undefined);
  assert.deepEqual(heldByBroker(view5), ["renewalRate"]);
  ok("a resolution to a private side writes brokerOnly + acceptedByBroker + hiddenFromSeller, whichever check fires");
}

// ── 2. The interview's resolved overlay never re-adds what the seller view holds or trims ──
{
  const callDoc = doc({ id: "call1", name: "Discovery call", sourceKind: "call" });
  // The broker settled the SDE row to the seller's own call figure: the fact
  // on file is the broker's (seller view holds it), and the overlay must not
  // put the figure back.
  const info: Record<string, unknown> = {
    sde: "$1,312,000 (FY2024: adjusted EBITDA $917,000 + owner add-backs $395,000)",
    saleType: "Share sale — 100% of shares, cash-free / debt-free, with a normalized working-capital peg of $550,000",
    _fieldSources: {
      sde: { source: "broker", at: "2026-09-21T10:00:00Z", note: "Resolved discrepancy" },
      saleType: { source: "broker", at: "2026-09-21T10:00:00Z", note: "Resolved discrepancy" },
    },
  };
  const sdeRow = disc({
    field: "SDE", factKey: "sde",
    sideSources: { interview: { kind: "call", documentId: "call1" }, document: { kind: "document", documentId: "fs" } },
    interviewValue: "$1,312,000", documentValue: "$1,163,000", resolvedValue: "$1,312,000 (FY2024: adjusted EBITDA $917,000 + owner add-backs $395,000)",
  });
  const saleRow = disc({
    field: "Deal structure", factKey: "saleType", category: "legal",
    sideSources: { interview: { kind: "call", documentId: "call1" }, document: { kind: "document", documentId: "fs" } },
    interviewValue: "Asset sale", documentValue: "Share sale", resolvedValue: "Share sale — 100% of shares, cash-free / debt-free, with a normalized working-capital peg of $550,000",
  });
  const kb = assembleKnowledgeBase({ ...baseDeal, extractedInfo: info }, [callDoc, doc({ id: "fs", name: "FY2024 statements" })], [], null, [sdeRow, saleRow]);
  const prompt = renderKnowledgeBaseForPrompt(kb);
  assert.ok(!/1,312,000|395,000|917,000/.test(prompt), prompt.match(/.{0,120}(1,312,000|395,000|917,000).{0,60}/)?.[0]);
  assert.ok(!/550,000|peg/i.test(prompt), prompt.match(/.{0,120}(550,000|peg).{0,60}/i)?.[0]);
  // The sale structure itself still reads (trimmed, not hidden) and the SDE is settled, once.
  assert.ok(/Share sale — 100% of shares, cash-free \/ debt-free/.test(prompt));
  assert.equal((prompt.match(/- sde(?: — [^:\n]+)?: settled by the broker/g) ?? []).length, 1, prompt.split("\n").filter((l) => /\bsde\b/.test(l)).join("\n"));
  assert.equal(kb.extractedInfo.sde, undefined);
  ok("the resolved-facts overlay is screened like a broker-typed fact; held facts stay held");
}

// ── 3. Consolidated private notes: judged on the seller-side source's own words ──
{
  const info: Record<string, unknown> = {
    _brokerPrivateNotes: [
      {
        note: "Owner's health: back surgery planned for spring; the broker's recast adds back the replacement manager",
        source: "crm", documentId: "crm1",
        alsoFrom: [{ source: "call", documentId: "call1", wording: "Owner mentioned back surgery planned for spring" }],
      },
      {
        note: "Owner's spouse on payroll",
        source: "call", documentId: "call1", wording: "Maria's salary is an add-back per Morgan's recast",
      },
    ],
  };
  const view = sellerInterviewView(info, [doc({ id: "call1", name: "Discovery call", sourceKind: "call" }), doc({ id: "crm1", name: "CRM", sourceKind: "crm", visibility: "broker_only" })]) as Record<string, any>;
  const notes = (view._brokerPrivateNotes ?? []) as Array<{ note: string }>;
  // The seller-side wording is clean → kept, in its own words.
  assert.ok(notes.some((x) => x.note === "Owner mentioned back surgery planned for spring"), JSON.stringify(notes));
  // The seller-side wording carries the broker's work → dropped.
  assert.ok(!notes.some((x) => /add-back|recast/i.test(x.note)), JSON.stringify(notes));
  ok("private notes are screened on the words the interview reads");
}

console.log(`\n${n} integration-step-4 checks passed`);
