// Round-3 integrity fixes — offline checks (no database, no AI).
//  1. The interview's view of the facts never carries anything a broker-only
//     source (CRM note, private email/file) asserted — facts, other values,
//     years of a map fact, the deal-row price's stand-in — nor its figures.
//  2. The seller profile: stale profiles are stripped whatever the deal holds
//     today; negotiation text is dropped.
//  3. A turn that restates the figure on file changes nothing (no re-ask).
//  4. Delete response, reprocess corroborations, read-only broker view,
//     industry-matching text, accepted website facts.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/information/interview-private-view.test.ts
import assert from "node:assert/strict";
import { sellerInterviewView } from "../../server/interview/seller-view";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";
import {
  applyGroundingGuard, mergeExtractedFields, removeDocumentFields, getFieldSources, describeSource,
  type FieldChange,
} from "../../server/interview/info-merger";
import {
  sellerProfileNeedsRebuild, profileSafeForInterview, stripNegotiationText, PROFILE_PRIVACY_VERSION,
} from "../../server/interview/eq-profiler";
import { MIRROR_NOTES } from "../../server/information/deal-mirror";
import { brokerFactsView, acceptWebsiteFact } from "../../server/information/facts";
import { carryCorroborations } from "../../server/documents/reprocess";
import { dealBusinessText, industryMatches } from "../../server/matching/engine";
import { buildInformationView } from "../../server/information/view";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
type Info = Record<string, unknown>;

const docs: any[] = [
  { id: "crm1", name: "CRM note — call with owner", createdAt: new Date(), sourceKind: "crm", sourceMeta: null, visibility: "broker_only" },
  { id: "pem", name: "Email — private from accountant", createdAt: new Date(), sourceKind: "email", sourceMeta: null, visibility: "broker_only" },
  { id: "pl", name: "2024 P&L.pdf", createdAt: new Date(), sourceKind: "document", sourceMeta: null, visibility: "shared" },
];
const baseDeal: any = {
  id: "d1", brokerId: "b1", businessName: "Pierce Dental", industry: "Dental", subIndustry: null, location: "Maple Ridge, BC",
  description: null, questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null, scrapeSource: null,
  sellerProfile: null, sectionImportance: null, interviewOutline: null, interviewPlan: null, askingPrice: "$2,100,000",
};

(async () => {
  // ── 1. Broker-only facts never reach the interview ──
  {
    const info: Info = {
      keyEmployees: "Karen Pierce (owner's wife, handles books)",
      annualRevenue: "$1.9M",
      yearsOperating: "14",
      revenueByYear: { "2023": "$1.7M", "2024": "$1.9M" },
      // The broker's Valuation price; the CRM floor was recorded as another value.
      askingPrice: "$2,100,000",
      _fieldSources: {
        keyEmployees: { source: "crm", documentId: "crm1" },
        annualRevenue: { source: "email", documentId: "pem" },
        yearsOperating: { source: "document", documentId: "pl" },
        revenueByYear: { source: "document", documentId: "pl", years: { "2023": "pl", "2024": "pem" } },
        askingPrice: { source: "broker", note: MIRROR_NOTES.valuation },
      },
      _fieldAlternates: {
        askingPrice: [{ source: "crm", documentId: "crm1", value: "$1.6M floor — will fold on price" }],
        annualRevenue: [{ source: "document", documentId: "pl", value: "$1.85M" }],
        "revenueByYear.2024": [{ source: "crm", documentId: "crm1", value: "$2M" }],
      },
      _fieldCorroborations: { yearsOperating: [{ source: "crm", documentId: "crm1", value: "14" }] },
    };
    const view = sellerInterviewView(info, docs);
    assert.equal(view.keyEmployees, undefined, "a CRM-only fact is not on the interview's file");
    assert.equal(view.annualRevenue, "$1.85M", "a private email's figure gives way to the shared P&L's");
    assert.equal(getFieldSources(view).annualRevenue.documentId, "pl");
    assert.deepEqual(view.revenueByYear, { "2023": "$1.7M" }, "a year only a private source gave is dropped (never the CRM alternate)");
    assert.equal(view.askingPrice, undefined, "the deal-row price is hidden and the CRM floor never stands in for it");
    assert.equal(view.yearsOperating, "14");
    assert.equal(JSON.stringify(view).includes("crm1"), false, "no trace of the CRM row anywhere in the view");
    assert.equal(info.keyEmployees, "Karen Pierce (owner's wife, handles books)", "the deal's own facts are untouched");

    const kb = assembleKnowledgeBase({ ...baseDeal, extractedInfo: info }, docs, [], null, []);
    const prompt = renderKnowledgeBaseForPrompt(kb);
    assert.doesNotMatch(prompt, /Karen|1\.6M|fold|floor|2,100,000|\$1\.9M|\$2M|CRM note — call|private from accountant/);
    assert.match(prompt, /keyEmployees: NOT YET CAPTURED/, "the agent asks the seller openly");
    assert.match(prompt, /askingPrice: NOT YET CAPTURED/);
    assert.match(prompt, /annualRevenue: \$1\.85M  \[from document: 2024 P&L\.pdf\]/);

    // A turn merges against the same view: the seller naming his wife is a
    // new answer (not a no-op against the hidden CRM value)…
    const turn = mergeExtractedFields(view as any, { keyEmployees: { value: "My wife Karen does the books", confidence: "confirmed", source: "seller_statement" } } as any, {});
    assert.equal(turn.changes[0].previousValue, null);
    // …and repeating the P&L figure the agent was shown is a no-op at the same confidence.
    const again = mergeExtractedFields(view as any, { annualRevenue: { value: "$1.85M", confidence: "inferred", source: "seller_statement" } } as any, { annualRevenue: "inferred" });
    assert.equal(again.changes.length, 0);
  }
  ok("broker-only facts, alternates, years and corroborations never reach the interview; turns merge against the same view");

  // ── 2. Seller profile ──
  {
    const legacy: any = {
      communicationStyle: "direct", emotionalState: "neutral", sellingReason: "retirement", sophistication: "first_time_seller",
      businessAttachment: "high", timeOrientation: "moderate", familyInvolvement: "spouse_involved",
      sensitiveTopics: ["$1.6M floor"], personalInsights: ["Karen does the books"], sellerStory: "Will fold on price at $1.6M.",
      industryContext: "Karen", confidenceScore: 0.5, dataSources: [], generatedAt: "x", privacyVersion: 2,
    };
    // the finding's scenario: the CRM source was deleted, the old profile remains
    assert.equal(sellerProfileNeedsRebuild(legacy, []), true);
    const safe = profileSafeForInterview(legacy, [])!;
    assert.equal(safe.sellerStory + safe.industryContext + safe.sensitiveTopics.join() + safe.personalInsights.join(), "");
    const prompt = renderKnowledgeBaseForPrompt(assembleKnowledgeBase({ ...baseDeal, extractedInfo: {}, sellerProfile: legacy }, [], [], null, []));
    assert.doesNotMatch(prompt, /Karen|1\.6M|fold/);
    assert.doesNotMatch(prompt, /Communication style:|Family involvement:/, "(round 4) no AI-derived category of a stale profile");

    const current: any = {
      ...legacy, privacyVersion: PROFILE_PRIVACY_VERSION, sourceDocumentIds: ["pl"],
      sellerStory: "Built the clinic over 14 years. He would accept an offer around $1.8M. Proud of his hygienists.",
      sensitiveTopics: ["Health scare last year", "Lowest price he'd take is $1.6M"], personalInsights: ["Grew revenue to $1.9M"], industryContext: "Dental owners worry about patient continuity.",
    };
    assert.equal(sellerProfileNeedsRebuild(current, docs), false);
    assert.equal(sellerProfileNeedsRebuild(current, [{ id: "pl", visibility: "broker_only" }]), true, "a row it was built from became private");
    const stripped = stripNegotiationText(current);
    assert.doesNotMatch(stripped.sellerStory, /1\.8M|offer/);
    assert.match(stripped.sellerStory, /Built the clinic over 14 years\. Proud of his hygienists\./);
    assert.deepEqual(stripped.sensitiveTopics, ["Health scare last year"]);
    assert.deepEqual(stripped.personalInsights, ["Grew revenue to $1.9M"], "a figure without price talk stays");
    assert.doesNotMatch(JSON.stringify(profileSafeForInterview(current, docs)), /1\.6M|1\.8M/);
  }
  ok("stale profiles are stripped whatever the deal holds today; pricing/negotiation text never reaches the interview");

  // ── 3. Grounding guard: restating the figure on file is not a change ──
  {
    const conf: Record<string, string> = { askingPrice: "approximate" };
    const restate: FieldChange = { fieldName: "askingPrice", previousValue: "$1,200,000", previousConfidence: "approximate", newValue: "$1.2M", newConfidence: "confirmed", source: "seller_statement" };
    const flags = applyGroundingGuard([restate], conf, "Is my price realistic?");
    assert.equal(flags.length, 1);
    assert.equal(flags[0].restatement, true);
    assert.equal(flags[0].change, restate);
    assert.equal(conf.askingPrice, "approximate", "confidence untouched (the caller drops the change)");
    // a NEW figure with no number in the message is still downgraded + flagged
    const invented: FieldChange = { ...restate, newValue: "$1.5M" };
    const f2 = applyGroundingGuard([invented], conf, "Is my price realistic?");
    assert.equal(f2[0].restatement, undefined);
    assert.equal(invented.newConfidence, "approximate");
    // nothing on file → the old behaviour
    const fresh: FieldChange = { ...restate, previousValue: null, previousConfidence: null };
    assert.equal(applyGroundingGuard([fresh], {}, "no idea")[0].restatement, undefined);
  }
  ok("grounding guard: a restated figure is dropped, not turned into a verify re-ask; invented figures still are");

  // ── 4a. Delete response names only what was really removed ──
  {
    const info: Info = {
      revenueByYear: { "2023": "$1.7M", "2024": "$1.9M" },
      _fieldSources: { revenueByYear: { source: "document", documentId: "A", years: { "2023": "A", "2024": "A" } } },
      _fieldCorroborations: { "revenueByYear.2023": [{ source: "document", documentId: "B", value: "$1.7M" }], "revenueByYear.2024": [{ source: "document", documentId: "B", value: "$1.9M" }] },
    };
    const r = removeDocumentFields(info, "A");
    assert.deepEqual(r.removed, [], "every year stayed (another source states it) — nothing reported removed");
    assert.equal(r.changed, true);
    assert.deepEqual(r.info.revenueByYear, { "2023": "$1.7M", "2024": "$1.9M" });
    const partial = removeDocumentFields({ ...info, _fieldCorroborations: { "revenueByYear.2023": [{ source: "document", documentId: "B", value: "$1.7M" }] } }, "A");
    assert.deepEqual(partial.removed, ["revenueByYear:A"]);
  }
  ok("delete: a year taken over by a corroborating source isn't reported as removed");

  // ── 4b. Reprocess carries corroborations recorded meanwhile ──
  {
    const rebuilt = { annualRevenue: [{ source: "document", documentId: "X", value: "$1M" }], employees: [{ source: "email", documentId: "E", value: "9" }] };
    const existing = { annualRevenue: [{ source: "document", documentId: "X", value: "$1M" }] };
    const latest = {
      annualRevenue: [{ source: "document", documentId: "X", value: "$1M" }, { source: "email", documentId: "NEW", value: "$1M" }],
      leaseExpiry: [{ source: "call", documentId: "T", value: "2029" }],
      yearsOperating: [{ source: "document", documentId: "Q", value: "12" }],
    };
    const out = carryCorroborations(rebuilt, existing, latest, ["yearsOperating", "employees"]);
    assert.equal(out.annualRevenue.length, 2, "a corroboration added during the run is kept, not replaced wholesale");
    assert.deepEqual(out.leaseExpiry, latest.leaseExpiry);
    assert.deepEqual(out.yearsOperating, latest.yearsOperating, "a fact changed meanwhile takes its corroborations from the latest copy");
    assert.equal(out.employees, undefined, "…and drops the re-derived ones that described the replaced value");
  }
  ok("reprocess: corroborations recorded during the run are carried over like facts and alternates");

  // ── 4c. Reading the broker view never writes; it still lines the price up ──
  {
    const deal: any = { askingPrice: "$900,000", extractedInfo: { askingPrice: "$1.2M", _fieldSources: { askingPrice: { source: "interview", turn: 2 } } } };
    const before = JSON.stringify(deal);
    const v = brokerFactsView(deal);
    assert.equal(JSON.stringify(deal), before, "the deal object is not mutated");
    assert.equal((v.extractedInfo as Info).askingPrice, "$900,000");
    assert.equal(getFieldSources(v.extractedInfo as Info).askingPrice.source, "broker");
    const same: any = { askingPrice: "$1,200,000", extractedInfo: { askingPrice: "$1.2M", _fieldSources: { askingPrice: { source: "broker" } } } };
    assert.equal(brokerFactsView(same), same, "nothing to line up → the deal itself");
  }
  ok("broker view lines up drifted asking-price copies in memory only");

  // ── 4d. Industry matching text ──
  {
    const text = dealBusinessText({ industry: "Healthcare", description: "Three-chair family dental practice" }, { companyOverview: "Orthodontics and hygiene" });
    assert.match(text, /dental practice/);
    assert.match(text, /Orthodontics/);
    assert.equal(industryMatches(text, ["Dental"]), true);
  }
  ok("industry matching reads the broker's description and the business facts");

  // ── 4e. Accepted website facts read as accepted ──
  {
    const info: Info = {};
    acceptWebsiteFact(info, "awards", "Best clinic in Halifax 2024");
    const src = getFieldSources(info).accolades;
    assert.match(describeSource(src), /Website · accepted by you/);
    const view = buildInformationView({
      deal: { id: "d", extractedInfo: info, questionnaireData: null, scrapedData: { awards: "Best clinic in Halifax 2024" }, industry: "Dental" } as any,
      documents: [], sessions: [],
    });
    const fact = [...view.sections.flatMap((s) => s.facts), ...view.other].find((f) => f.key === "accolades")!;
    assert.equal(fact.confidence, "confirmed", "not 'Unverified'");
    assert.match(fact.source.label, /accepted by you/);
    const lead = buildInformationView({
      deal: { id: "d", extractedInfo: { accolades: "x", _fieldSources: { accolades: { source: "website" } } }, questionnaireData: null, scrapedData: null, industry: "Dental" } as any,
      documents: [], sessions: [],
    });
    assert.equal([...lead.sections.flatMap((s) => s.facts), ...lead.other].find((f) => f.key === "accolades")!.confidence, "unverified");
  }
  ok("a website fact the broker accepted shows as accepted, not unverified");

  console.log(`\n${n} groups passed`);
})().catch((e) => { console.error(e); process.exit(1); });
