// QA harvest round V — "i-privacy-ux": what the seller interview may read.
//  1. The broker's own normalisation work typed or confirmed as a fact (SDE,
//     adjusted EBITDA, add-backs, "per the broker recast", "4x EBITDA") never
//     reaches the interview prompt — unless the seller said it.
//  2. Stored source-review conflicts and deferral-ledger items are re-checked
//     against the CURRENT sources on every read: a source made broker-only
//     (or deleted) vanishes at once.
//  3. A discrepancy resolved to a broker-only side's value (or a CRM value
//     chosen as the fact) is written with private provenance — the CIM keeps
//     it, the seller interview doesn't see it.
// Offline: no database, no AI.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/interview-privacy-ux.test.ts
import assert from "node:assert/strict";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";
import { sellerInterviewView, heldByBroker, withHeldFacts, HELD_BY_BROKER_VALUE } from "../../server/interview/seller-view";
import {
  screenBrokerWork,
  redactBrokerWork,
  screenLedgerForSeller,
  visibleReviewConflicts,
  resolvedFromPrivateSide,
  isBrokerWorkText,
} from "../../server/interview/source-privacy";
import { reviewConflictsForDeal, ensureSourceReview } from "../../server/interview/source-review";
import { mintSourceItems, applyLedgerToKb, heldForLaterGuards } from "../../server/interview/session-manager";
import { assertsNormalisation, stripNormalisationAssertions, NORMALISATION_HANDOFF } from "../../server/interview/normalisation-guard";
import { applyResolutionToInfo, useAlternate, resolvedToPrivateSide } from "../../server/information/facts";
import { getFieldSources } from "../../server/interview/info-merger";
import { isPrivateToBroker } from "../../server/information/cim-facts";
import { storage } from "../../server/storage";

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

// The Lakeshore facts as the live run found them (broker-typed recast work).
const lakeshoreInfo = () => ({
  sde: "$1,312,000 (FY2024: adjusted EBITDA $917,000 + owner add-backs $395,000)",
  ebitda: "$917,000 reported EBITDA (FY2024); FY2023 $793,000; FY2022 $644,000",
  keyFinancialNotes:
    "FY2024 SDE $1,312,000 per the broker recast (add-backs: owner salary, spouse salary, owner vehicles, owner meals and insurance, one-time legal); Owner emphasizes everything is on books, no cash jobs, all work permitted; Comfort Club generates $801,000 in FY2024 from 2,900 active members at $22.95/mo; Previous private equity buyer offered \"around 4x EBITDA\" in 2023 with earn-out structure (rejected); Owner prefers cash at closing",
  incomeStatementSummaryFy2022Fy2024:
    "Compiled statements (Bellamy & Rao LLP), years ended Dec 31. Revenue: FY2022 $6,180,000; FY2023 $6,840,000; FY2024 $7,412,000. Net income: $386,174; $482,930; $563,190. Owner add-backs: $342,000; $370,000; $395,000. SDE: $986,000; $1,163,000; $1,312,000. Adjusted EBITDA (SDE less a $140,000 replacement general manager salary): $846,000; $1,023,000; $1,172,000.",
  workingCapital: "Normalized net working capital $301,000 at Dec 31, 2024 (FY2023 $277,000; FY2022 $257,000); suggested peg ~$300,000 including inventory",
  fleetSize: "24 service vans (plus 2 owner vehicles excluded from the sale)",
  operationalSystems: "Accounting: Cloud accounting software; CRM: Cloud field-service management software",
  addbacks: "FY24 total $395K: Tony salary $240K, Maria salary $85K, owner vehicles $28K, owner meals $11K, owner insurance $9K, one-time legal $22K",
  employees: "36 employees plus Tony",
  _fieldSources: {
    sde: { source: "broker", at: "2026-09-04T10:09:24.095Z" },
    ebitda: { source: "broker", at: "2026-09-09T10:20:39.144Z" },
    keyFinancialNotes: { source: "broker" },
    incomeStatementSummaryFy2022Fy2024: { source: "broker" },
    workingCapital: { source: "broker" },
    fleetSize: { source: "broker" },
    operationalSystems: { source: "broker" },
    addbacks: { source: "crm", documentId: "crm1" },
    employees: { source: "call", documentId: "call1" },
  },
  _fieldAlternates: {
    sde: [{ value: "Approximately $1,500,000 owner benefit estimated by seller", source: "call", documentId: "call1" }],
    workingCapital: [{ value: "$946,274 (current assets less current liabilities)", source: "document", documentId: "fs24" }],
  },
});
const lakeshoreDocs = () => [
  doc({ id: "crm1", name: "CRM note - valuation meeting, list price agreed", sourceKind: "crm", visibility: "broker_only" }),
  doc({ id: "call1", name: "Discovery call with Tony Moretti", sourceKind: "call" }),
  doc({ id: "fs24", name: "Compiled financial statements FY2024" }),
];

(async () => {
  // ── 1. The broker's normalisation work ──
  {
    assert.equal(screenBrokerWork("sde", "$1,312,000", { source: "broker" }).kind, "private");
    assert.equal(screenBrokerWork("adjustedEbitda", "$917,000", { source: "system" }).kind, "private");
    assert.equal(screenBrokerWork("ownerAddbacks", "$395K", { source: "broker" }).kind, "private");
    // The seller's own words are never screened, nor a document the seller shared.
    assert.equal(screenBrokerWork("sde", "about $1.5M", { source: "interview" }).kind, "keep");
    assert.equal(screenBrokerWork("sde", "about $1.5M", { source: "call", documentId: "c" }).kind, "keep");
    assert.equal(screenBrokerWork("sde2022", "$815,174", { source: "document", documentId: "d" }).kind, "keep");
    // Plain broker facts are kept; "CRM" as the seller's software is not the broker's material.
    assert.equal(screenBrokerWork("fleetSize", "24 service vans", { source: "broker" }).kind, "keep");
    assert.equal(screenBrokerWork("operationalSystems", "CRM: ServiceTitan; Accounting: QuickBooks", { source: "broker" }).kind, "keep");
    assert.equal(screenBrokerWork("ebitda", "$917,000 reported EBITDA (FY2024)", { source: "broker" }).kind, "keep");
    // A narrative keeps its other clauses.
    const notes = screenBrokerWork("keyFinancialNotes", lakeshoreInfo().keyFinancialNotes, { source: "broker" });
    assert.equal(notes.kind, "redacted");
    const kept = (notes as { value: string }).value;
    assert.ok(!/recast|1,312|add-backs|4x/i.test(kept), kept);
    assert.ok(/everything is on books/.test(kept) && /Comfort Club generates \$801,000/.test(kept) && /cash at closing/.test(kept), kept);
    // A figure list inside a clause stays whole with its clause ("$342,000; $370,000; $395,000").
    const summary = redactBrokerWork(lakeshoreInfo().incomeStatementSummaryFy2022Fy2024)!;
    assert.ok(/Revenue: FY2022 \$6,180,000; FY2023 \$6,840,000; FY2024 \$7,412,000/.test(summary), summary);
    assert.ok(/Net income: \$386,174; \$482,930; \$563,190/.test(summary), summary);
    assert.ok(!/add-backs|SDE|1,312|395,000|370,000|1,172,000|Adjusted EBITDA/i.test(summary), summary);
    // A value that is only broker work leaves nothing.
    assert.equal(redactBrokerWork("FY2024 SDE $1,312,000 per the broker recast"), null);
    assert.ok(isBrokerWorkText("around 4x EBITDA") && isBrokerWorkText("working capital peg ~$300K") && !isBrokerWorkText("Rent ~$14,600/mo plus TMI"));
    ok("broker-typed SDE / add-backs / recast / multiple talk are private; narratives keep their other clauses");
  }

  // ── 1b. The seller view and the full prompt (Lakeshore) ──
  {
    const deal = { ...baseDeal, extractedInfo: lakeshoreInfo() };
    const view = sellerInterviewView(deal.extractedInfo as Record<string, unknown>, lakeshoreDocs()) as Record<string, any>;
    // SDE / normalised working capital: the broker settled them — held, never
    // replaced by a value the broker superseded (the call estimate, the raw
    // statement figure).
    assert.equal(view.sde, undefined);
    assert.equal(view.workingCapital, undefined);
    assert.deepEqual(heldByBroker(view).sort(), ["sde", "workingCapital"]);
    assert.equal(view.addbacks, undefined); // CRM (broker-only) — gone
    assert.ok(!/1,312|recast|4x/.test(view.keyFinancialNotes));
    assert.equal(view.fleetSize, "24 service vans (plus 2 owner vehicles excluded from the sale)");
    // "Is it on file?" (coverage, the re-ask guard) still says yes.
    assert.equal(withHeldFacts(view).sde, HELD_BY_BROKER_VALUE);
    const text = JSON.stringify(view);
    assert.ok(!/1,312|395,000|\$395K|recast|Tony salary \$240K|suggested peg/i.test(text), text.slice(0, 400));

    const kb = assembleKnowledgeBase(deal, lakeshoreDocs(), [], null, []);
    const prompt = renderKnowledgeBaseForPrompt(kb);
    assert.ok(!/1,312|395,000|\$395K|recast|Maria salary \$85K|around 4x/i.test(prompt), "prompt carries the broker's recast");
    assert.ok(!/Approximately \$1,500,000 owner benefit|946,274/.test(prompt), "a value the broker superseded is shown as the fact");
    assert.ok(/- sde: settled by the broker/.test(prompt) && /- workingCapital: settled by the broker/.test(prompt));
    ok("Lakeshore: the interview prompt has no recast, no $1,312,000, no add-back list — SDE shows as settled by the broker");
  }

  // ── 1c. Digests, risks and private notes framed as the broker's work ──
  {
    const email = doc({
      id: "em1", name: "Email - RE: Document request", sourceKind: "email",
      extractedData: {
        summary: "Tony sends statements, T2s and the lease. Morgan plans to prepare a recast of financials.",
        keyFacts: "Accountant is Jennifer at Bellamy & Rao; Morgan Ellis plans to prepare a recast of financials; lease runs to 2028",
        redFlags: "Owner vehicles financed through company with significant add-backs ($28,000 in 2024); Lease expires in 2028 with one renewal option",
      },
    });
    const info = {
      _brokerPrivateNotes: [
        { note: "Maria is involved in the business with a compensation add-back mentioned", sources: [{ documentId: "em1", reason: "email" }] },
        { note: "Tony's wife Maria had surgery in 2024", sources: [{ documentId: "em1", reason: "email" }] },
      ],
    };
    const kb = assembleKnowledgeBase({ ...baseDeal, extractedInfo: info }, [email], [], null, []);
    const prompt = renderKnowledgeBaseForPrompt(kb);
    assert.ok(!/recast|add-back/i.test(prompt), prompt.match(/.{0,80}(recast|add-back).{0,80}/i)?.[0]);
    assert.ok(/Jennifer at Bellamy & Rao/.test(prompt) && /Lease expires in 2028/.test(prompt));
    assert.ok(/had surgery/.test(prompt)); // the seller's sensitive fact is still held (privately)
    ok("digests, flagged risks and private notes lose only the items framed as add-backs / a recast");
  }

  // ── 1d. Round 2 (live checker): screening never swaps a settled fact for a
  //        stale one, never hides more than the part that says it, and
  //        leaves facts recorded before sources were tracked alone ──
  {
    // Beacon: the broker's deal structure carries a normalised peg in its
    // last sub-clause. At round 1 the whole value was hidden and a video
    // call's "Asset sale implied" was promoted in its place.
    const saleType =
      "Share sale — 100% of the shares of Beacon Specialty Pharmacy Inc., cash-free / debt-free, with a normalized net working capital peg of about $550,000";
    const s = screenBrokerWork("saleType", saleType, { source: "broker" });
    assert.deepEqual(s, { kind: "redacted", value: "Share sale — 100% of the shares of Beacon Specialty Pharmacy Inc., cash-free / debt-free" });
    const beacon: Record<string, unknown> = {
      saleType,
      _fieldSources: { saleType: { source: "broker", at: "2026-09-10T10:00:00Z" } },
      _fieldAlternates: {
        saleType: [{ value: "Asset sale implied (cash-free/debt-free structure mentioned)", source: "video_call", documentId: "vc1" }],
      },
    };
    const vcDoc = doc({ id: "vc1", name: "Video call with the owner", sourceKind: "video_call" });
    const bview = sellerInterviewView(beacon, [vcDoc]) as Record<string, unknown>;
    assert.equal(bview.saleType, "Share sale — 100% of the shares of Beacon Specialty Pharmacy Inc., cash-free / debt-free");
    assert.equal(getFieldSources(bview).saleType.source, "broker");
    const bprompt = renderKnowledgeBaseForPrompt(assembleKnowledgeBase({ ...baseDeal, extractedInfo: beacon }, [vcDoc], [], null, []));
    assert.ok(/- saleType: Share sale — 100% of the shares/.test(bprompt), bprompt.match(/- saleType:.{0,160}/)?.[0]);
    assert.ok(!/- saleType: Asset sale/.test(bprompt) && !/550,000|normali[sz]ed net working capital peg/i.test(bprompt));

    // A broker value that is wholly the broker's work → held, never the
    // superseded alternate.
    const wholly: Record<string, unknown> = {
      saleType: "Normalized working-capital peg of $550,000 per the broker recast",
      _fieldSources: { saleType: { source: "broker" } },
      _fieldAlternates: { saleType: [{ value: "Asset sale implied", source: "video_call", documentId: "vc1" }] },
    };
    const wview = sellerInterviewView(wholly, [vcDoc]) as Record<string, unknown>;
    assert.equal(wview.saleType, undefined);
    assert.deepEqual(heldByBroker(wview), ["saleType"]);
    assert.ok(!JSON.stringify(wview).includes("Asset sale implied"));

    // Only the sub-clause that says it: a multiple aside, a trailing comma part.
    assert.deepEqual(screenBrokerWork("askingPrice", "$1.35 million (~3.4x SDE), open to 10-15% vendor take-back", { source: "broker" }), {
      kind: "redacted",
      value: "$1.35 million, open to 10-15% vendor take-back",
    });
    // …never a fragment: a comma list that lost its head goes whole.
    assert.equal(screenBrokerWork("workingCapitalNotes", "Normalized NWC $301,000 at Dec 31, 2024, up from $277,000", { source: "broker" }).kind, "private");
    // An aside CITING the broker's material makes the figure it annotates the broker's.
    assert.equal(redactBrokerWork("2024 adjusted EBITDA: $3.9M (normalized by broker)"), null);

    // Facts recorded before sources were tracked (no source, or the legacy
    // marker): mostly the seller's own interview answers. Not screened for
    // normalisation keys or wording — hiding them made the interview re-ask.
    const legacy = { source: "system", note: "Recorded before sources were tracked" } as never;
    assert.equal(screenBrokerWork("askingPrice", "$1.35 million (~3.4x SDE), open to 10-15% vendor take-back", undefined).kind, "keep");
    assert.equal(screenBrokerWork("sde", "$412,000 (FY2024)", undefined).kind, "keep");
    assert.equal(screenBrokerWork("addbacksByYear", { "2023": "$88,000", "2024": "$95,000" }, legacy).kind, "keep");
    assert.equal(screenBrokerWork("keyFinancialNotes", "Owner pays himself $120K plus add-backs for his truck", undefined).kind, "keep");
    // …except the parts that cite the broker's own material.
    assert.deepEqual(screenBrokerWork("keyFinancialNotes", "SDE $1.31M per the broker recast; Owner prefers cash at closing", undefined), {
      kind: "redacted",
      value: "Owner prefers cash at closing",
    });
    const pawfect: Record<string, unknown> = {
      askingPrice: "$1.35 million (~3.4x SDE), open to 10-15% vendor take-back",
      sde: "$397,000 (2024)",
      addbacksByYear: { "2023": "$88,000", "2024": "$95,000" },
    };
    const pview = sellerInterviewView(pawfect, []) as Record<string, unknown>;
    assert.equal(pview.askingPrice, pawfect.askingPrice);
    assert.equal(pview.sde, pawfect.sde);
    assert.deepEqual(pview.addbacksByYear, pawfect.addbacksByYear);
    assert.deepEqual(heldByBroker(pview), []);

    // Ordinary keys that merely contain a normalisation word are not the broker's work.
    assert.equal(screenBrokerWork("multipleLocations", "Yes — 3 clinics", { source: "broker" }).kind, "keep");
    assert.equal(screenBrokerWork("adjustedHours", "Summer hours 7-3", { source: "broker" }).kind, "keep");
    assert.equal(screenBrokerWork("adjustedEbitda2024", "$917,000", { source: "broker" }).kind, "private");
    assert.equal(screenBrokerWork("ebitdaMultiple", "4.2", { source: "broker" }).kind, "private");

    // A held fact is on file for coverage: the section doesn't turn into a gap.
    const heldKb = assembleKnowledgeBase({ ...baseDeal, extractedInfo: lakeshoreInfo() }, lakeshoreDocs(), [], null, []);
    const sdeField = heldKb.sectionCoverage.flatMap((c) => c.fields).find((f) => f.fieldName === "sde");
    if (sdeField) assert.equal(sdeField.value, HELD_BY_BROKER_VALUE);
    assert.deepEqual([...(heldKb.heldByBroker ?? [])].sort(), ["sde", "workingCapital"]);
    ok("round 2: a settled broker value is trimmed to what may be shown or held — never swapped for a superseded one; legacy facts are left alone");
  }

  // ── 2. Stored source review vs the CURRENT sources ──
  {
    const conflict = (source: string, documentId?: string) => ({
      key: "annualRevenue", topic: "2024 revenue", critical: true, origin: "review" as const,
      values: [
        { value: "$2.3M", source: "the seller in the interview" },
        { value: "$1,940,000", source, ...(documentId ? { documentId } : {}) },
      ],
    });
    const review = (conflicts: unknown[]) => ({ fingerprint: "old", computedAt: new Date().toISOString(), status: "ready", conflicts });
    const memo = doc({ id: "memo", name: "Broker valuation memo.pdf", extractedData: { summary: "x" } });
    const pl = doc({ id: "pl", name: "2024 P&L.pdf", extractedData: { summary: "y" } });

    // Shared → kept.
    assert.equal(reviewConflictsForDeal({ id: "d1", interviewSourceReview: review([conflict("document: Broker valuation memo.pdf")]) }, [memo, pl]).length, 1);
    // Made broker-only → gone at once (label and id both).
    const priv = { ...memo, visibility: "broker_only" };
    assert.equal(reviewConflictsForDeal({ id: "d1", interviewSourceReview: review([conflict("document: Broker valuation memo.pdf")]) }, [priv, pl]).length, 0);
    assert.equal(reviewConflictsForDeal({ id: "d1", interviewSourceReview: review([conflict("document: renamed later", "memo")]) }, [priv, pl]).length, 0);
    // Deleted → gone (the label names nothing that exists).
    assert.equal(reviewConflictsForDeal({ id: "d1", interviewSourceReview: review([conflict("document: Broker valuation memo.pdf")]) }, [pl]).length, 0);
    // A call quoted by its dated label stays while the call is shared.
    const call = doc({ id: "c1", name: "Discovery call", sourceKind: "call", sourceMeta: { date: "2026-03-03" } });
    const callConflict = { ...conflict("document: 2024 P&L.pdf"), values: [{ value: "$2.3M", source: "said on a call (Mar 3, 2026)" }, { value: "$1,940,000", source: "document: 2024 P&L.pdf" }] };
    assert.equal(visibleReviewConflicts([callConflict], [call, pl]).length, 1);
    assert.equal(visibleReviewConflicts([callConflict], [{ ...call, visibility: "broker_only" }, pl]).length, 0);

    // The full prompt: the private document's name and figure never appear.
    const deal = { ...baseDeal, interviewSourceReview: review([conflict("document: Broker valuation memo.pdf")]) };
    const kb = assembleKnowledgeBase(deal, [priv, pl], [], null, []);
    const prompt = renderKnowledgeBaseForPrompt(kb);
    assert.ok(!/Broker valuation memo|1,940,000/.test(prompt));

    // Nothing reviewable left: no rebuild, and the old review is cleared.
    let cleared: any = null;
    const orig = storage.updateDeal.bind(storage);
    (storage as any).updateDeal = async (_id: string, patch: any) => { cleared = patch; return null; };
    assert.equal(ensureSourceReview(deal as any, [priv]), null);
    (storage as any).updateDeal = orig;
    assert.deepEqual(cleared?.interviewSourceReview?.conflicts, []);
    ok("stored review conflicts are re-checked against the current sources: broker-only or deleted sources drop out at once");
  }

  // ── 2b. The durable ledger vs the CURRENT sources ──
  {
    const memoPriv = doc({ id: "memo", name: "Broker valuation memo.pdf", visibility: "broker_only" });
    const pl = doc({ id: "pl", name: "2024 P&L.pdf" });
    const e = (o: Record<string, unknown>): any => ({ id: `e${Math.random()}`, whereInfoLives: "", status: "open", createdAtTurn: 2, ...o });
    const ledger = [
      e({ topic: "reconcile annualRevenue", reason: 'sources disagree: "$2.3M" (said on a call (Mar 3, 2026)) vs "$1.94M recast" (document: Broker valuation memo.pdf)', origin: "source" }),
      e({ topic: "reconcile ebitda", reason: 'sources disagree: "$917K" (the seller in the interview) vs "$880K" (document: 2024 P&L.pdf)', origin: "source" }),
      e({ topic: "reconcile employees", reason: 'sources disagree: "36" (the seller in the interview) vs "30" (document: Old roster.xlsx)', status: "resolved" }),
      e({ topic: "risk: Customer concentration", reason: "flagged in Broker valuation memo.pdf", origin: "source" }),
      e({ topic: "risk: Lease renewal", reason: "flagged in 2024 P&L.pdf", origin: "source" }),
      e({ topic: "leaseTerms", reason: "seller will check the lease — document: Broker valuation memo.pdf says 2028", whereInfoLives: "Denise" }),
      e({ topic: "emrRating", reason: "Owner does not know; Denise tracks it", whereInfoLives: "Denise / the CRM software" }),
    ];
    const screened = screenLedgerForSeller(ledger, [memoPriv, pl]);
    const topics = screened.map((x) => x.topic);
    assert.ok(!topics.includes("reconcile annualRevenue")); // open, private side → dropped
    assert.ok(topics.includes("reconcile ebitda")); // both sides visible → kept as is
    assert.equal(screened.find((x) => x.topic === "reconcile ebitda"), ledger[1]);
    const emp = screened.find((x) => x.topic === "reconcile employees")!; // resolved, deleted source → kept without its quotes
    assert.equal(emp.reason, "");
    assert.ok(!topics.includes("risk: Customer concentration"));
    assert.ok(topics.includes("risk: Lease renewal"));
    const lease = screened.find((x) => x.topic === "leaseTerms")!;
    assert.equal(lease.reason, "");
    assert.equal(lease.whereInfoLives, "Denise");
    assert.equal(screened.find((x) => x.topic === "emrRating"), ledger[6]); // "the CRM software" is the seller's own system
    assert.ok(!JSON.stringify(screened).includes("valuation memo"));
    // A screened item is never re-minted while its source stays private.
    const kb: any = { sourceConflicts: [], flaggedRisks: [] };
    const minted = mintSourceItems(screened, kb, 3);
    applyLedgerToKb(kb, minted);
    assert.ok(!JSON.stringify(minted).includes("valuation memo"));
    ok("ledger items minted while a source was shared are dropped or stripped once it is broker-only or deleted");
  }

  // ── 3. Resolution to a private side's value ──
  {
    const crmSide = { interview: { kind: "crm", brokerOnly: true }, document: { kind: "document", documentId: "pl" } };
    const info: Record<string, unknown> = {
      annualRevenue: "$2,300,000",
      _fieldSources: { annualRevenue: { source: "interview", sessionId: "s1" } },
    };
    const k = applyResolutionToInfo(info, disc({
      field: "2024 revenue", factKey: "annualRevenue", source: "merge", sideSources: crmSide,
      interviewValue: "$1.94M", documentValue: "$2,300,000", resolvedValue: "$1,940,000",
    }), { brokerChoseFact: true });
    assert.equal(k, "annualRevenue");
    const src = getFieldSources(info).annualRevenue;
    assert.equal(src.source, "broker");
    assert.equal(src.hiddenFromSeller, true);
    // The CIM still uses it (it is the broker's call), the seller interview doesn't see it.
    assert.equal(isPrivateToBroker(src), false);
    const view = sellerInterviewView(info, [doc({ id: "pl", name: "2024 P&L.pdf" })]) as Record<string, unknown>;
    // Settled by the broker: neither the private figure nor the value it replaced.
    assert.equal(view.annualRevenue, undefined);
    assert.deepEqual(heldByBroker(view), ["annualRevenue"]);
    assert.ok(!JSON.stringify(view).includes("1,940,000") && !JSON.stringify(view).includes("2,300,000"));

    // Resolved to the seller-visible side: an ordinary broker-confirmed fact.
    const info2: Record<string, unknown> = { annualRevenue: "$1.94M", _fieldSources: { annualRevenue: { source: "crm", documentId: "crm1" } } };
    applyResolutionToInfo(info2, disc({
      field: "2024 revenue", factKey: "annualRevenue", source: "merge", sideSources: crmSide,
      interviewValue: "$1.94M", documentValue: "$2,300,000", resolvedValue: "$2,300,000",
    }), { brokerChoseFact: true });
    assert.equal(getFieldSources(info2).annualRevenue.hiddenFromSeller, undefined);

    // A legacy row whose private side is only known by its broker-only document.
    assert.equal(resolvedToPrivateSide(disc({ interviewValue: "$2.3M — call", documentValue: "$1,940,000 — Valuation file", documentId: "memo" }), "$1.94M", new Set(["memo"])), true);
    assert.equal(resolvedToPrivateSide(disc({ interviewValue: "$2.3M — call", documentValue: "$1,940,000 — Valuation file", documentId: "memo" }), "$1.94M", new Set()), false);
    // Both sides say the same figure → not private.
    assert.equal(resolvedFromPrivateSide("$1.94M", ["$1,940,000"], ["1.94 million"]), false);

    // One year of a map resolved to the private value.
    const info3: Record<string, unknown> = {
      revenueByYear: { "2023": "$6,840,000", "2024": "$7,412,000" },
      _fieldSources: { revenueByYear: { source: "document", documentId: "pl", years: { "2023": { source: "document", documentId: "pl" }, "2024": { source: "document", documentId: "pl" } } } },
    };
    applyResolutionToInfo(info3, disc({
      field: "2024 revenue", factKey: "revenueByYear", factYear: "2024", source: "merge", sideSources: crmSide,
      interviewValue: "$7.9M", documentValue: "$7,412,000", resolvedValue: "$7.9M",
    }), { brokerChoseFact: true });
    const view3 = sellerInterviewView(info3, [doc({ id: "pl", name: "2024 P&L.pdf" })]) as Record<string, any>;
    assert.equal(view3.revenueByYear["2024"], undefined);
    assert.equal(view3.revenueByYear["2023"], "$6,840,000");
    assert.deepEqual(heldByBroker(view3), ["revenueByYear (2024)"]);

    // "Use this value" on a CRM alternate.
    const info4: Record<string, unknown> = {
      employees: "36",
      _fieldSources: { employees: { source: "call", documentId: "c1" } },
      _fieldAlternates: { employees: [{ value: "40 incl. seasonal", source: "crm", documentId: "crm1", brokerOnly: true }] },
    };
    // Live (clone): a small count resolved to the CRM side — the fact and the
    // "settled discrepancies" block both keep it from the seller interview.
    const callDoc = doc({ id: "c1", name: "Discovery call", sourceKind: "call" });
    const info5: Record<string, unknown> = { employees: "36 employees plus owner (37 total)", _fieldSources: { employees: { source: "call", documentId: "c1" } } };
    const headcount = disc({
      field: "Total headcount", factKey: "employees", source: "merge",
      sideSources: { interview: { kind: "crm", brokerOnly: true }, document: { kind: "call", documentId: "c1" } },
      interviewValue: "41 incl. 5 seasonal", documentValue: "36 employees plus owner (37 total)", resolvedValue: "41 incl. 5 seasonal",
    });
    applyResolutionToInfo(info5, headcount, { brokerChoseFact: true });
    assert.equal(getFieldSources(info5).employees.hiddenFromSeller, true);
    const kb5 = assembleKnowledgeBase({ ...baseDeal, extractedInfo: info5 }, [callDoc], [], null, [headcount]);
    const prompt5 = renderKnowledgeBaseForPrompt(kb5);
    assert.ok(!/41 incl/.test(prompt5), prompt5.match(/.{0,120}41 incl.{0,60}/)?.[0]);
    // The value the broker replaced isn't shown as the fact either; the item
    // is settled (once — the discrepancy note covers it).
    assert.ok(!/36 employees plus owner/.test(prompt5));
    assert.equal((prompt5.match(/- employees: settled by the broker/g) ?? []).length, 1);

    useAlternate(info4, "employees", 0);
    assert.equal(getFieldSources(info4).employees.hiddenFromSeller, true);
    const view4 = sellerInterviewView(info4, [doc({ id: "c1", name: "call", sourceKind: "call" })]) as Record<string, unknown>;
    assert.equal(view4.employees, undefined);
    assert.deepEqual(heldByBroker(view4), ["employees"]);
    ok("a resolution (or a chosen value) from the broker's private material stays private to the seller interview, not to the CIM");
  }

  // ── 4. The normalisation guard (the agent never asserts add-backs / SDE) ──
  {
    const asserting = [
      // Live, before the fix (Lakeshore clone):
      "Yes, Maria's salary is included in the broker's add-backs — that's already factored into the SDE figure Morgan put together.",
      "Morgan's recast landed at $1,312,000 SDE for FY2024 — that's the $917,000 reported EBITDA plus roughly $395,000 in owner add-backs.",
      "That's right — the $1,312,000 SDE includes Maria's $85,000 as one of the add-backs, along with your salary.",
      "Yes — your RAM 1500, meals, and your personal insurance are all in the add-backs.",
      "Maria's salary is on our list as an add-back item your broker will confirm in the final recast — I don't have the exact SDE figure in front of me.",
      "Switching gears to add-backs — the broker's working from items like your salary, Maria's salary, and vehicle expenses.",
      "Your truck gets added back too.",
      "What I can tell you is that owner comp, Maria's salary, and personal use of company vehicles are typical addback items, but your broker will confirm the exact treatment against your actual statements.",
    ];
    for (const s of asserting) assert.ok(assertsNormalisation(`${s} What's your current general liability coverage?`), s);
    const fine = [
      "Anything beyond that — dividends, one-time items — your broker will confirm in the normalization against your actual statements. What's your current general liability coverage?",
      "Your broker will go through what's added back with you against your statements. Are there any personal expenses run through the company?",
      "Are there any one-time costs in 2024 — legal, a big repair — that a buyer wouldn't carry going forward?",
      "Is Maria's salary something you'd expect a buyer to replace, or would the role go away?",
      "A market-rate owner salary on the P&L is the classic add-back; anything beyond that your broker confirms. What does Maria do day to day?",
      "What does your fleet cost you in a typical year, roughly — fuel, insurance and payments?",
    ];
    for (const s of fine) assert.ok(!assertsNormalisation(s), s);
    const stripped = stripNormalisationAssertions(
      "Yes, Maria's salary is included in the broker's add-backs. It comes to about $395,000 in add-backs overall. What's your current general liability coverage?",
    );
    assert.equal(stripped, `${NORMALISATION_HANDOFF} What's your current general liability coverage?`);
    assert.ok(heldForLaterGuards("Morgan's recast landed at $1,312,000 SDE. What's next?", { retractionInMessage: false, valuationLeak: false }));
    assert.ok(!heldForLaterGuards("What's your current general liability coverage?", { retractionInMessage: false, valuationLeak: false }));
    ok("normalisation guard: add-back / SDE / recast assertions are caught (and held on the stream); questions and the hand-off pass");
  }

  console.log(`\n${n} interview-privacy-ux checks passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
