// Data-integrity fixes — offline checks (no database, no AI).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/information/integrity.test.ts
// (the imports need both variables set; storage calls are stubbed below — nothing connects)
import assert from "node:assert/strict";
import { mergeExtractedData } from "../../server/documents/extractor";
import {
  removeDocumentFields, getFieldSources, getFieldAlternates, getFieldCorroborations, yearEntryDocId, yearSource,
} from "../../server/interview/info-merger";
import {
  editFact, deleteFact, useAlternate, applyResolutionToInfo, revenueYearOfField, mutateDealInfo, acceptWebsiteFact,
} from "../../server/information/facts";
import { overlayExistingFacts } from "../../server/documents/reprocess";
import { mergeableExtraction, addPrivateNotes } from "../../server/documents/ingest";
import { buildTurnSave, seedExtractedInfoFromQuestionnaire, seedQuestionnaireFacts } from "../../server/interview/session-manager";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";
import { sellerProfileNeedsRebuild, profileSafeForInterview, carryBrokerProfileEdits, PROFILE_PRIVACY_VERSION } from "../../server/interview/eq-profiler";
import { splitFactsForCim } from "../../server/information/cim-facts";
import { buildKnowledgeBase } from "../../server/cim/layout-engine";
import { buildInformationView } from "../../server/information/view";
import { storage } from "../../server/storage";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
type Info = Record<string, unknown>;
const crm = (id: string) => ({ source: "crm" as const, documentId: id });

(async () => {
  // ── 1. Two sources agree; deleting one keeps the fact (CRM re-import) ──
  {
    let info: Info = {};
    info = mergeExtractedData(info, { practiceSoftware: "Dentrix", desiredClosingTimeline: "Q2 2027" } as any, crm("A"));
    info = mergeExtractedData(info, { practiceSoftware: "Dentrix", desiredClosingTimeline: "Q2 2027", numberOfOperatories: "8" } as any, crm("B"));
    assert.equal(getFieldCorroborations(info).practiceSoftware[0].documentId, "B", "B recorded as a co-source");
    const r = removeDocumentFields(info, "A");
    assert.deepEqual(r.removed, [], "nothing B still states is removed");
    assert.equal(r.info.practiceSoftware, "Dentrix");
    assert.equal(r.info.desiredClosingTimeline, "Q2 2027");
    assert.equal(getFieldSources(r.info).practiceSoftware.documentId, "B", "B took over as the source");
    assert.equal(getFieldCorroborations(r.info).practiceSoftware, undefined);
    assert.ok(r.changed);
    // …and deleting B afterwards removes them (nothing else states them)
    const r2 = removeDocumentFields(r.info, "B");
    assert.equal(r2.info.practiceSoftware, undefined);
    assert.equal(r2.info.numberOfOperatories, undefined);
  }
  {
    // Re-import of an edited note: changed value steps in, unchanged ones stay.
    let info: Info = {};
    info = mergeExtractedData(info, { leaseExpiry: "Aug 2029", askingPrice: "$2.1M" } as any, crm("v1"));
    info = mergeExtractedData(info, { leaseExpiry: "Aug 2029", askingPrice: "$2.0M" } as any, crm("v2"));
    const r = removeDocumentFields(info, "v1");
    assert.equal(r.info.leaseExpiry, "Aug 2029");
    assert.equal(r.info.askingPrice, "$2.0M");
    assert.equal(getFieldSources(r.info).askingPrice.documentId, "v2");
    assert.equal(getFieldSources(r.info).leaseExpiry.documentId, "v2");
  }
  {
    // A higher-ranked source stating the same value becomes the source.
    let info: Info = {};
    info = mergeExtractedData(info, { annualRevenue: "$1.8M" } as any, crm("c1"));
    info = mergeExtractedData(info, { annualRevenue: "$1.8M" } as any, { documentId: "e1", source: "email" });
    assert.equal(getFieldSources(info).annualRevenue.source, "email");
    assert.equal(getFieldCorroborations(info).annualRevenue[0].documentId, "c1");
    assert.equal(removeDocumentFields(info, "e1").info.annualRevenue, "$1.8M", "the CRM note still states it");
    // A stronger different value displaces both agreeing sources into alternates.
    info = mergeExtractedData(info, { annualRevenue: "$1.9M" } as any, { documentId: "t1", source: "call" });
    assert.equal(getFieldCorroborations(info).annualRevenue, undefined);
    const alts = getFieldAlternates(info).annualRevenue.map((a) => a.documentId).sort();
    assert.deepEqual(alts, ["c1", "e1"], "both old sources kept as alternates");
  }
  {
    // Same figure for one year from two P&Ls: deleting the first keeps the year.
    let info: Info = {};
    info = mergeExtractedData(info, { revenueByYear: { "2023": "$1.7M", "2024": "$1.8M" } } as any, "pA");
    info = mergeExtractedData(info, { revenueByYear: { "2024": "$1.8M", "2025": "$2.0M" } } as any, "pB");
    const r = removeDocumentFields(info, "pA");
    assert.deepEqual(r.info.revenueByYear, { "2024": "$1.8M", "2025": "$2.0M" });
    assert.equal(yearEntryDocId(getFieldSources(r.info).revenueByYear.years?.["2024"]), "pB");
  }
  {
    // Two sources giving the same losing value are both kept as alternates.
    let info: Info = { annualRevenue: "$2.3M", _fieldSources: { annualRevenue: { source: "interview" } } };
    info = mergeExtractedData(info, { annualRevenue: "$1.8M" } as any, "d1");
    info = mergeExtractedData(info, { annualRevenue: "$1.8M" } as any, "d2");
    assert.equal(getFieldAlternates(info).annualRevenue.length, 2);
    const r = removeDocumentFields(info, "d1");
    assert.equal(getFieldAlternates(r.info).annualRevenue[0].documentId, "d2");
  }
  ok("agreeing sources: deleting / re-importing one never removes what another still states");

  // ── 9. Deleting a source that only supplied alternates is saved ──
  {
    const info: Info = {
      annualRevenue: "$2.3M",
      _fieldSources: { annualRevenue: { source: "interview" } },
      _fieldAlternates: { annualRevenue: [{ source: "document", documentId: "X", value: "$1.82M" }] },
    };
    const r = removeDocumentFields(info, "X");
    assert.deepEqual(r.removed, []);
    assert.equal(r.changed, true, "callers must save — the alternate went");
    assert.deepEqual(getFieldAlternates(r.info), {});
    assert.equal(removeDocumentFields(r.info, "X").changed, false, "nothing left to clean");
  }
  ok("source that only lost the contest: alternates dropped and flagged for saving");

  // ── 1b. Broker revenue-by-year edits survive documents, deletes and reprocess ──
  {
    let info: Info = { revenueByYear: { "2023": "$1.7M" }, _fieldSources: { revenueByYear: { source: "interview" } } };
    editFact(info, "revenueByYear", "2023: $1.8M\n2024: $1.9M\n2025: $2.013M"); // the Information tab's PUT on a map fact
    info = mergeExtractedData(info, { revenueByYear: { "2022": "$1.7M", "2024": "$1.95M" } } as any, { documentId: "EM", source: "email" });
    const src = getFieldSources(info).revenueByYear;
    assert.equal(src.source, "broker");
    assert.equal(src.documentId, undefined, "no documentId stamped on the broker's source");
    // Per-year sources: the email's 2022, the broker's other years.
    assert.equal(yearEntryDocId(src.years?.["2022"]), "EM");
    for (const y of ["2023", "2024", "2025"]) assert.equal(yearSource(src, y)?.source, "broker");
    assert.equal(getFieldAlternates(info)["revenueByYear.2024"][0].value, "$1.95M");
    // reprocess: the email re-extracts the same
    const docsMerged = mergeExtractedData({}, { revenueByYear: { "2022": "$1.7M", "2024": "$1.95M" } } as any, { documentId: "EM", source: "email" });
    const rebuilt = overlayExistingFacts(docsMerged, info);
    assert.deepEqual(rebuilt.revenueByYear, { "2022": "$1.7M", "2023": "$1.8M", "2024": "$1.9M", "2025": "$2.013M" });
    assert.equal(getFieldSources(rebuilt).revenueByYear.source, "broker");
    assert.equal(yearEntryDocId(getFieldSources(rebuilt).revenueByYear.years?.["2022"]), "EM");
    for (const y of ["2023", "2024", "2025"]) assert.equal(yearSource(getFieldSources(rebuilt).revenueByYear, y)?.source, "broker");
    assert.ok(getFieldAlternates(rebuilt)["revenueByYear.2024"].some((a) => a.value === "$1.95M"), "email's 2024 kept as an alternate");
    // deleting the email removes only its 2022
    const r = removeDocumentFields(rebuilt, "EM");
    assert.deepEqual(r.info.revenueByYear, { "2023": "$1.8M", "2024": "$1.9M", "2025": "$2.013M" });
    assert.equal(getFieldSources(r.info).revenueByYear.source, "broker");
  }
  {
    // A broker source that an older bug stamped with a documentId is never wiped by that delete.
    const info: Info = {
      revenueByYear: { "2024": "$1.9M" },
      _fieldSources: { revenueByYear: { source: "broker", documentId: "EMAIL1" } },
      employees: "12",
    };
    (info._fieldSources as any).employees = { source: "interview", documentId: "EMAIL1" };
    const r = removeDocumentFields(info, "EMAIL1");
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.info.revenueByYear, { "2024": "$1.9M" });
    assert.equal(r.info.employees, "12");
    assert.equal(getFieldSources(r.info).revenueByYear.documentId, undefined);
    // …and reprocess keeps it too (kind, not documentId, decides)
    const rebuilt = overlayExistingFacts(mergeExtractedData({}, { employees: "30" } as any, "EMAIL1"), info);
    assert.equal(rebuilt.employees, "12");
    assert.ok(getFieldAlternates(rebuilt).employees.some((a) => a.value === "30"), "fresh value kept as an alternate");
  }
  {
    // "Use this" on one year: the choice survives deleting either document.
    let info: Info = {};
    info = mergeExtractedData(info, { revenueByYear: { "2023": "$1.5M", "2024": "$2.0M" } } as any, "A");
    info = mergeExtractedData(info, { revenueByYear: { "2024": "$2.2M" } } as any, "B");
    useAlternate(info, "revenueByYear.2024", 0);
    assert.equal((info.revenueByYear as any)["2024"], "$2.2M");
    const src = getFieldSources(info).revenueByYear;
    assert.equal(src.source, "broker");
    assert.equal(yearSource(src, "2024")?.source, "broker", "the chosen year belongs to the broker");
    assert.equal(yearEntryDocId(src.years?.["2023"]), "A");
    assert.equal(yearSource(src, "2023")?.source, "document", "the other year keeps its own source");
    const delA = removeDocumentFields(info, "A");
    assert.deepEqual(delA.info.revenueByYear, { "2024": "$2.2M" });
    const delB = removeDocumentFields(info, "B");
    assert.deepEqual(delB.info.revenueByYear, { "2023": "$1.5M", "2024": "$2.2M" });
  }
  {
    // Reprocess refreshes a document's own value; keeps legacy + interview values.
    const info: Info = {
      annualRevenue: "$1.8M", sde: "$400K", reasonForSale: "Retiring",
      _fieldSources: { annualRevenue: { source: "document", documentId: "P" }, sde: { source: "interview" } },
      summary: "A P&L", redFlags: "Personal guarantee",
    };
    const fresh = mergeExtractedData({}, { annualRevenue: "$1.85M", sde: "$390K" } as any, "P");
    const rebuilt = overlayExistingFacts(fresh, info);
    assert.equal(rebuilt.annualRevenue, "$1.85M");
    assert.equal(rebuilt.sde, "$400K");
    assert.equal(rebuilt.reasonForSale, "Retiring");
    assert.equal(getFieldSources(rebuilt).reasonForSale, undefined, "legacy value stays untracked");
    assert.equal(rebuilt.summary, undefined, "per-source notes are dropped from the deal facts");
    assert.equal(rebuilt.redFlags, undefined);
  }
  ok("broker revenue-by-year edits and choices survive document merges, deletes and reprocess");

  // ── 4. Discrepancy resolutions update the real fact, never mint junk keys ──
  {
    assert.equal(revenueYearOfField("2024 Revenue"), "2024");
    assert.equal(revenueYearOfField("FY2023 revenue"), "2023");
    assert.equal(revenueYearOfField("Total sales (2025)"), "2025");
    assert.equal(revenueYearOfField("2024 SDE"), null);
    const info: Info = {
      revenueByYear: { "2023": "$1.7M", "2024": "$1.95M" },
      annualRevenue: "$1.95M",
      _fieldSources: { revenueByYear: { source: "document", documentId: "PL", years: { "2023": "PL", "2024": "PL" } } },
    };
    const k = applyResolutionToInfo(info, {
      field: "2024 Revenue", resolvedValue: "$1,894,000", source: "financial_analysis",
      interviewValue: "$1,950,000 — Seller interview", documentValue: "$1,894,000 — 2024 P&L", documentId: "PL",
    } as any);
    assert.equal(k, "revenueByYear.2024");
    assert.equal((info.revenueByYear as any)["2024"], "$1,894,000");
    assert.equal((info.revenueByYear as any)["2023"], "$1.7M");
    assert.equal(info.fact2024Revenue, undefined, "no junk fact");
    assert.ok(!Object.keys(info).some((key) => key.startsWith("fact")));
    const alts = getFieldAlternates(info)["revenueByYear.2024"];
    assert.ok(alts.some((a) => a.value === "$1.95M" && a.documentId === "PL"), "the displaced figure is kept");
    assert.ok(alts.some((a) => a.value === "$1,950,000" && a.source === "interview"), "bare value, real kind");
    assert.ok(!alts.some((a) => a.value.includes(" — ")), "no ' — source' suffix stored");
    // deleting the P&L keeps the broker's 2024 decision
    const r = removeDocumentFields(info, "PL");
    assert.deepEqual(r.info.revenueByYear, { "2024": "$1,894,000" });
    // no target → nothing written
    const before = JSON.stringify(info);
    assert.equal(applyResolutionToInfo(info, { field: "What were the owner's wages in 2024 and were they paid as salary?", resolvedValue: "$90K salary", source: "financial_analysis" } as any), null);
    assert.equal(applyResolutionToInfo(info, { field: "2023 SDE", resolvedValue: "$410K", source: "financial_analysis" } as any), null);
    assert.equal(JSON.stringify(info), before);
    // a known label still works
    const k2 = applyResolutionToInfo(info, { field: "Annual Revenue", resolvedValue: "$1.9M", interviewValue: "$2.3M", documentValue: null, source: "interview" } as any);
    assert.equal(k2, "annualRevenue");
    assert.equal(info.annualRevenue, "$1.9M");
  }
  ok("discrepancy resolution: '2024 Revenue' updates revenue by year; unknown fields write nothing");

  // ── 5 + 6. CIM writers: no per-source notes; CRM / website facts are leads ──
  {
    const shared = mergeableExtraction({ visibility: "shared" } as any, { annualRevenue: "$1M", summary: "An email", redFlags: "PG", actionItems: "Broker to follow up", sellerConcerns: "Staff" } as any);
    assert.deepEqual(Object.keys(shared), ["annualRevenue"]);
    const info: Info = {
      annualRevenue: "$1.8M", askingPrice: "around $2.1M", businessDescription: "Family-owned since 1998",
      summary: "legacy summary", redFlags: "Personal guarantee by Dr. A. Patel", actionItems: "Broker to follow up",
      revenueByYear: { "2024": "$1.8M" },
      _brokerPrivateNotes: [{ note: "floor $1.6M" }],
      _fieldSources: { annualRevenue: { source: "document", documentId: "d" }, askingPrice: { source: "crm", documentId: "c" }, businessDescription: { source: "website" } },
    };
    const split = splitFactsForCim(info);
    assert.deepEqual(split.confirmed.map(([k]) => k).sort(), ["annualRevenue", "revenueByYear"]);
    // The broker's CRM note is never CIM input, not even as a lead (facts1); the website is a lead.
    assert.deepEqual(split.leads.map(([k]) => k).sort(), ["businessDescription"]);
    const kbText = buildKnowledgeBase({ dealId: "d", businessName: "Biz", industry: "Dental", extractedInfo: info } as any);
    assert.doesNotMatch(kbText, /Personal guarantee|Broker to follow up|legacy summary|floor \$1\.6M|around \$2\.1M/);
    assert.match(kbText, /UNCONFIRMED LEADS[\s\S]*Business Description: Family-owned since 1998/);
    assert.match(kbText, /Revenue By Year: 2024: \$1\.8M/, "maps rendered, never [object Object]");
    const canonical = kbText.split("CANONICAL FIGURES")[1]?.split("\n\n")[0] ?? "";
    assert.match(canonical, /Revenue: \$1\.8M/);
    // CRM-only revenue never becomes a canonical figure
    const crmOnly = buildKnowledgeBase({ dealId: "d", businessName: "Biz", industry: "Dental", extractedInfo: { annualRevenue: "about $2M", _fieldSources: { annualRevenue: { source: "crm", documentId: "c" } } } } as any);
    assert.doesNotMatch(crmOnly, /CANONICAL FIGURES/);
  }
  ok("CIM writers get no per-source notes, no CRM facts, and website facts only as unconfirmed leads");

  // ── 2. Broker-only content never reaches the interview agent ──
  {
    const docs: any[] = [
      { id: "crmN", name: "CRM note — owner call", createdAt: new Date(), sourceKind: "crm", sourceMeta: null, visibility: "broker_only" },
      { id: "em1", name: "Email from seller", createdAt: new Date(), sourceKind: "email", sourceMeta: null, visibility: "shared" },
    ];
    const info: Info = { annualRevenue: "$1.8M", summary: "CRM summary", _fieldSources: { annualRevenue: { source: "crm", documentId: "crmN" } } };
    addPrivateNotes(info, "Owner would accept a floor of $1.6M\nWife Karen handles the books", docs[0]);
    addPrivateNotes(info, "Seller mentioned a recent surgery", docs[1]);
    (info._brokerPrivateNotes as any[]).push({ note: "Seller asked us not to mention his divorce", reason: "interview", turn: 3 });
    (info._brokerPrivateNotes as any[]).push({ note: "From a deleted source", documentId: "gone" });
    assert.equal((info._brokerPrivateNotes as any[])[0].brokerOnly, true);
    const legacyProfile: any = {
      communicationStyle: "direct", emotionalState: "neutral", sellingReason: "retirement", sophistication: "first_time_seller",
      businessAttachment: "high", timeOrientation: "moderate", familyInvolvement: "spouse_involved",
      sensitiveTopics: ["Willing to accept $500K less ($1.6M floor)"], personalInsights: ["Wife Karen handles the books"],
      sellerStory: "Karen handles the books; staff don't know", industryContext: "Dental", confidenceScore: 0.5, dataSources: ["broker_notes"], generatedAt: "x",
    };
    const deal: any = {
      id: "d1", brokerId: "b1", businessName: "Biz", industry: "Dental", subIndustry: null, location: null, description: null,
      extractedInfo: info, questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null, scrapeSource: null,
      sellerProfile: legacyProfile, sectionImportance: null, interviewOutline: null, interviewPlan: null,
    };
    const prompt = renderKnowledgeBaseForPrompt(assembleKnowledgeBase(deal, docs, [], null, []));
    assert.doesNotMatch(prompt, /1\.6M|Karen|floor|staff don't know|From a deleted source|CRM summary/);
    assert.doesNotMatch(prompt, /1\.8M/, "a fact only a broker-only CRM note states is not on the interview's file");
    assert.match(prompt, /annualRevenue: NOT YET CAPTURED/, "…so the agent asks the seller openly");
    assert.match(prompt, /recent surgery/, "a note from a shared source stays (seller-disclosed)");
    assert.match(prompt, /divorce/, "an interview-captured note stays");
    // (round 4) a stale profile's AI-derived categories may come from the
    // private notes too ("Family involvement: spouse_involved" from "Wife
    // Karen handles the books") — none of them reach the interview until
    // the rebuild lands.
    assert.doesNotMatch(prompt, /Communication style:|Family involvement:|Selling reason:/, "no AI-derived category of a stale profile");
    assert.equal(sellerProfileNeedsRebuild(legacyProfile, docs), true);
    assert.equal(sellerProfileNeedsRebuild({ ...legacyProfile, privacyVersion: PROFILE_PRIVACY_VERSION }, docs), false);
    assert.equal(sellerProfileNeedsRebuild(legacyProfile, [docs[1]]), true, "an old profile is rebuilt even after its broker-only source was deleted");
    assert.equal(sellerProfileNeedsRebuild(legacyProfile, []), true);
    const current = { ...legacyProfile, privacyVersion: PROFILE_PRIVACY_VERSION, sourceDocumentIds: ["em1"] };
    assert.equal(sellerProfileNeedsRebuild(current, docs), false);
    assert.equal(sellerProfileNeedsRebuild(current, [{ ...docs[1], visibility: "broker_only" }]), true, "a row it read was made private since");
    assert.equal(profileSafeForInterview(legacyProfile, docs)!.sellerStory, "");
    // a rebuilt profile keeps the broker's own notes and corrections
    const rebuilt = carryBrokerProfileEdits({ ...legacyProfile, communicationStyle: "formal", brokerOverrides: undefined }, { brokerOverrides: { brokerNotes: "Call after 4pm", communicationStyle: { originalValue: "formal", brokerValue: "guarded" } } });
    assert.equal(rebuilt.communicationStyle, "guarded");
    assert.equal(rebuilt.brokerOverrides?.brokerNotes, "Call after 4pm");
    // deleting the CRM source removes its private notes too
    const r = removeDocumentFields(info, "crmN");
    assert.equal((r.info._brokerPrivateNotes as any[]).some((x) => /Karen|1\.6M/.test(x.note)), false);
    assert.equal((r.info._brokerPrivateNotes as any[]).length, 3);
  }
  ok("broker-only CRM notes and stale profiles never reach the interview prompt; deleting the source removes its notes");

  // ── 3 + 8. The interview turn's save respects the fresh copy ──
  {
    const turnSrc = { source: "interview" as const, sessionId: "s1", turn: 5, at: "t" };
    const snapshot: Info = {
      employeeStructure: "6 staff", ownerRole: "Clinician",
      _fieldSources: { employeeStructure: { source: "interview", turn: 2 }, ownerRole: { source: "document", documentId: "D" } },
    };
    // the turn changed both
    const merged: Info = {
      ...snapshot,
      employeeStructure: "7 staff incl. 2 hygienists", ownerRole: "Clinician and manager", yearsOperating: "22",
      _fieldSources: { ...(snapshot._fieldSources as object), employeeStructure: turnSrc, ownerRole: turnSrc, yearsOperating: turnSrc },
      _brokerPrivateNotes: [{ note: "Health issue", turn: 5 }],
    };
    // during the model call: the broker edited employeeStructure, deleted ownerRole, and a doc added a private note
    const fresh: Info = { ...snapshot, _brokerPrivateNotes: [{ note: "From an email", documentId: "E" }] };
    editFact(fresh, "employeeStructure", "BROKER VERIFIED: 7 staff");
    deleteFact(fresh, "ownerRole");
    const saved = buildTurnSave({ snapshot, merged, fresh, changedFacts: ["employeeStructure", "ownerRole", "yearsOperating"], turnSrc });
    assert.equal(saved.employeeStructure, "BROKER VERIFIED: 7 staff", "the broker's edit is final");
    assert.equal(getFieldSources(saved).employeeStructure.source, "broker");
    assert.ok(getFieldAlternates(saved).employeeStructure.some((a) => a.value === "7 staff incl. 2 hygienists" && a.turn === 5), "seller's statement kept as an alternate");
    assert.equal(saved.ownerRole, undefined, "the broker's delete stands");
    assert.ok((saved._brokerSuppressed as string[]).includes("ownerRole"));
    assert.ok(getFieldAlternates(saved).ownerRole.some((a) => a.value === "Clinician and manager"));
    assert.equal(saved.yearsOperating, "22", "an untouched fact is saved normally");
    assert.equal((saved._brokerPrivateNotes as any[]).length, 2, "private notes merged, none lost");

    // a lower source wrote the fact meanwhile → the seller wins, doc kept as alternate
    const fresh2: Info = mergeExtractedData({ ...snapshot }, { yearsOperating: "20" } as any, "DOC2");
    const saved2 = buildTurnSave({ snapshot, merged, fresh: fresh2, changedFacts: ["yearsOperating"], turnSrc });
    assert.equal(saved2.yearsOperating, "22");
    assert.ok(getFieldAlternates(saved2).yearsOperating.some((a) => a.value === "20" && a.documentId === "DOC2"));

    // 8: fact deleted BEFORE the turn, re-stated by the seller → back, and no longer listed as deleted
    const pre: Info = { reasonForSale: "Retiring", _fieldSources: { reasonForSale: { source: "document", documentId: "Q" } } };
    deleteFact(pre, "reasonForSale");
    const m3: Info = { ...pre, reasonForSale: "Health", _fieldSources: { ...(pre._fieldSources as object), reasonForSale: turnSrc } };
    const saved3 = buildTurnSave({ snapshot: pre, merged: m3, fresh: { ...pre }, changedFacts: ["reasonForSale"], turnSrc });
    assert.equal(saved3.reasonForSale, "Health");
    assert.equal(saved3._brokerSuppressed, undefined);
    assert.equal(saved3._brokerDeleted, undefined, "not shown as both live and deleted");
    assert.ok(getFieldAlternates(saved3).reasonForSale.some((a) => a.value === "Retiring"), "deleted value still adoptable");
    const view = buildInformationView({ deal: { id: "d", extractedInfo: saved3, questionnaireData: null, scrapedData: null, industry: "Dental" } as any, documents: [], sessions: [] });
    assert.equal(view.deleted.length, 0);
    // website accept of a deleted fact: same tidy-up
    const w: Info = { accolades: "Best clinic 2022" };
    deleteFact(w, "accolades");
    acceptWebsiteFact(w, "awards", "Best clinic 2023");
    assert.equal(w._brokerDeleted, undefined);
    assert.ok(getFieldAlternates(w).accolades.some((a) => a.value === "Best clinic 2022"));
  }
  ok("interview turn save: broker edits/deletes made mid-turn stand; re-stated deleted facts are tidied");

  // ── 7. Legacy character-soup values never become alternates or come back ──
  {
    const soup = Object.fromEntries([...JSON.stringify({ "2023": "$1.75M" })].map((ch, i) => [String(i), ch]));
    const info: Info = { revenueByYear: { ...soup, FY2022: "$1.6M" }, _fieldSources: { revenueByYear: { source: "document", documentId: "Z" } } };
    editFact(info, "revenueByYear", "2023: $1.8M\n2024: $1.9M");
    const alt = getFieldAlternates(info).revenueByYear[0];
    assert.deepEqual(JSON.parse(alt.value), { "2023": "$1.75M", FY2022: "$1.6M" }, "stored repaired");
    const view = buildInformationView({ deal: { id: "d", extractedInfo: info, questionnaireData: null, scrapedData: null, industry: "Dental" } as any, documents: [], sessions: [] });
    const fact = [...view.sections.flatMap((s) => s.facts), ...view.other].find((x) => x.key === "revenueByYear")!;
    assert.doesNotMatch(fact.alternates.map((a) => a.displayValue).join(" "), /0: \{/);
    useAlternate(info, "revenueByYear", 0);
    assert.deepEqual(info.revenueByYear, { "2023": "$1.75M", FY2022: "$1.6M" }, "adopting it writes the clean map");
    // older rows already holding soup as an alternate are repaired on read
    const legacyAlt: Info = { revenueByYear: { "2024": "$1.9M" }, _fieldAlternates: { revenueByYear: [{ source: "document", value: JSON.stringify(soup) }] } };
    const v2 = buildInformationView({ deal: { id: "d", extractedInfo: legacyAlt, questionnaireData: null, scrapedData: null, industry: "Dental" } as any, documents: [], sessions: [] });
    const f2 = [...v2.sections.flatMap((s) => s.facts), ...v2.other].find((x) => x.key === "revenueByYear")!;
    assert.equal(f2.alternates[0].displayValue, "2023: $1.75M");
  }
  ok("legacy character-soup values are repaired as alternates, on display and on adopt");

  // ── 10 + locks: intake alternates are saved at once; writers queue per deal ──
  {
    let row: Info = { reasonForSale: "Burnout", _fieldSources: { reasonForSale: { source: "interview" } } };
    const writes: Info[] = [];
    const s = storage as any;
    const orig = { getDeal: s.getDeal, updateDeal: s.updateDeal };
    s.getDeal = async () => ({ id: "d1", questionnaireData: { reasonForSelling: "Retiring" }, extractedInfo: row });
    s.updateDeal = async (_id: string, u: any) => { row = u.extractedInfo; writes.push(row); return {}; };
    try {
      assert.ok(seedExtractedInfoFromQuestionnaire({ questionnaireData: { reasonForSelling: "Retiring" }, extractedInfo: row }));
      const changed = await seedQuestionnaireFacts("d1");
      assert.deepEqual(changed, [], "no fact changed…");
      assert.equal(writes.length, 1, "…but the intake answer was saved as another value");
      assert.ok(getFieldAlternates(row).reasonForSale.some((a) => a.source === "questionnaire" && a.value === "Retiring"));
      await seedQuestionnaireFacts("d1");
      assert.equal(writes.length, 1, "idempotent — no second write");
      // two broker edits at once never overwrite each other
      await Promise.all([
        mutateDealInfo("d1", (i) => editFact(i, "employees", "12")),
        mutateDealInfo("d1", (i) => editFact(i, "yearsOperating", "22")),
      ]);
      assert.equal(row.employees, "12");
      assert.equal(row.yearsOperating, "22");
    } finally {
      s.getDeal = orig.getDeal;
      s.updateDeal = orig.updateDeal;
    }
  }
  ok("intake answers kept only as another value are saved at once; concurrent broker edits both land");

  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
