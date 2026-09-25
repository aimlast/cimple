// QA-harvest "facts2" fixes — offline checks (no database, no AI):
// questionnaire privacy split, private-note dedup, add-fact on an existing
// field, deal-name/industry mirror, Information-tab sections, source dates,
// checklist auto-matching.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/information/facts2-harvest.test.ts
process.env.TZ = "America/Toronto";
import assert from "node:assert/strict";
import { seedExtractedInfoFromQuestionnaire } from "../../server/interview/session-manager";
import {
  answerHash, needsScreen, keywordSplit, checkedSplit, mentionsPrivateMatter, unscreenedAnswers, QUESTIONNAIRE_SCREEN_KEY,
} from "../../server/interview/questionnaire-privacy";
import { getPrivateNotes, addPrivateNote, compactPrivateNotes, getFieldSources, getFieldAlternates } from "../../server/interview/info-merger";
import { sameNoteContent, groupSameNotes } from "../../shared/private-notes";
import { addFact, FactError, setBrokerFact } from "../../server/information/facts";
import { reconcileMirroredFacts, columnPatchAfterChange, interviewFactView } from "../../server/information/deal-mirror";
import { sectionForKey, patternSectionFor } from "../../server/information/view";
import { formatShortDate, parseSourceDate } from "../../client/src/components/information/source-dates";
import { findMatchingRequirement, autoLinkableKind } from "../../server/documents/requirements";
import { buildKnowledgeBase } from "../../server/cim/layout-engine";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
type Info = Record<string, unknown>;

(async () => {
  // ── 1. Questionnaire: the health detail never becomes the reason-for-sale fact ──
  {
    const answer = "Retiring after my 2024 heart procedure";
    assert.ok(needsScreen("reasonForSale", answer));
    assert.ok(mentionsPrivateMatter(answer));
    // Keyword backstop (no model split on file): the whole answer goes private.
    const deal = { questionnaireData: { reasonForSelling: answer }, extractedInfo: {} as Info };
    const seeded = seedExtractedInfoFromQuestionnaire(deal)!;
    assert.ok(seeded, "seeding changed something");
    assert.equal(seeded.reasonForSale, undefined, "no reason-for-sale fact carrying the health detail");
    const notes = getPrivateNotes(seeded);
    assert.equal(notes.length, 1);
    assert.match(notes[0].note, /heart/);
    assert.equal(notes[0].questionnaire, true);
    // With the model's split cached: the neutral part is the fact, the detail a note.
    const split = { hash: answerHash(answer), publicValue: "Owner retiring", privateNotes: ["Owner had a heart procedure in 2024"], method: "model" as const, at: "2026-09-25T00:00:00Z" };
    const seeded2 = seedExtractedInfoFromQuestionnaire(deal, { reasonForSale: split })!;
    assert.equal(seeded2.reasonForSale, "Owner retiring");
    assert.ok(!/heart|procedure/i.test(String(seeded2.reasonForSale)));
    assert.equal(getFieldSources(seeded2).reasonForSale.source, "questionnaire");
    assert.ok(getPrivateNotes(seeded2).some((x) => /heart procedure/.test(x.note)));
    assert.ok((seeded2[QUESTIONNAIRE_SCREEN_KEY] as Info).reasonForSale, "split cached on the deal");
    assert.ok(!JSON.stringify(seeded2[QUESTIONNAIRE_SCREEN_KEY]).includes("heart procedure after"), "the cache holds a hash, not the answer");
    // Nothing left to split → the interview start doesn't call the model again.
    assert.equal(unscreenedAnswers({ ...deal, extractedInfo: seeded2 }).length, 0);
    assert.equal(seedExtractedInfoFromQuestionnaire({ ...deal, extractedInfo: seeded2 }), null, "idempotent");
    // The CIM knowledge base built from those facts has no health detail
    // (questionnaire content reaches it only through the screened facts).
    const kb = buildKnowledgeBase({ businessName: "Pacific Coast Logistics", industry: "Logistics", extractedInfo: seeded2, questionnaireData: null } as any);
    assert.ok(!/heart|procedure/i.test(kb), "buildKnowledgeBase output has no 'heart'");
  }
  ok("questionnaire: 'Retiring after my 2024 heart procedure' → neutral reasonForSale + private note");

  // ── 2. An answer seeded raw before the split existed is replaced, never kept as another value ──
  {
    const answer = "Founder (67) retiring after 34 years following a 2024 heart procedure; son prefers to partner with a larger platform.";
    const info: Info = {
      reasonForSale: answer,
      _fieldSources: { reasonForSale: { source: "questionnaire", at: "2026-01-01T00:00:00Z" } },
      _fieldAlternates: { reasonForSale: [{ value: answer, source: "questionnaire" }] },
    };
    const split = { hash: answerHash(answer), publicValue: "Founder (67) retiring after 34 years; his son prefers to partner with a larger platform.", privateNotes: ["Founder had a heart procedure in 2024"], method: "model" as const, at: "x" };
    const out = seedExtractedInfoFromQuestionnaire({ questionnaireData: { reasonForSelling: answer }, extractedInfo: info }, { reasonForSale: split })!;
    assert.equal(out.reasonForSale, split.publicValue);
    assert.ok(!JSON.stringify(getFieldAlternates(out)).includes("heart"), "the raw answer is not kept as another value");
    // A stronger source (the call) holds the fact: the screened answer is the alternate, the raw one is gone.
    const info2: Info = {
      reasonForSale: "Owner retiring (age 67)",
      _fieldSources: { reasonForSale: { source: "call", documentId: "call1" } },
      _fieldAlternates: { reasonForSale: [{ value: answer, source: "questionnaire" }] },
    };
    const out2 = seedExtractedInfoFromQuestionnaire({ questionnaireData: { reasonForSelling: answer }, extractedInfo: info2 }, { reasonForSale: split })!;
    assert.equal(out2.reasonForSale, "Owner retiring (age 67)");
    const alts = JSON.stringify(getFieldAlternates(out2));
    assert.ok(!alts.includes("heart") && alts.includes("larger platform"));
  }
  ok("questionnaire: an unscreened answer on file is scrubbed (fact and other values)");

  // ── 3. The split is checked: a public value still naming a health matter isn't used ──
  {
    const v = "Selling for health reasons after my cancer diagnosis";
    assert.deepEqual(checkedSplit(v, { publicValue: "Selling after a cancer diagnosis", privateNotes: [] }), { publicValue: null, privateNotes: [v], method: "keyword" });
    assert.equal(checkedSplit(v, { publicValue: "Owner retiring", privateNotes: ["Owner diagnosed with cancer"] }).publicValue, "Owner retiring");
    assert.deepEqual(keywordSplit("Retiring after 30 years"), { publicValue: "Retiring after 30 years", privateNotes: [], method: "keyword" });
    // Business vocabulary is not a private matter.
    assert.ok(!mentionsPrivateMatter("We serve healthcare clinics and passed every health inspection"));
    assert.ok(!mentionsPrivateMatter("Personal guarantees on the bank line; shareholder loans of $410K"));
    assert.ok(mentionsPrivateMatter("going through a divorce"));
    assert.ok(!needsScreen("yearsOperating", "34"));
  }
  ok("privacy split: backstop on both sides; business words are not private");

  // ── 4. Private notes: a restatement joins the note on file ──
  {
    const info: Info = {};
    addPrivateNote(info, "Owner had a cardiac event in 2024", { documentId: "call1", reason: "From Intro call" });
    addPrivateNote(info, "Seller disclosed a 2024 heart event", { documentId: "email1", reason: "From Email" });
    const notes = getPrivateNotes(info);
    assert.equal(notes.length, 1, "one note");
    assert.equal(notes[0].alsoFrom?.length, 1, "with two sources");
    // Different figures, different people, different matters stay apart.
    addPrivateNote(info, "Mom's salary $62K", { documentId: "e" });
    addPrivateNote(info, "Dad's salary $285K", { documentId: "e" });
    addPrivateNote(info, "Luis confirmed 15% ownership stake", { documentId: "c" });
    addPrivateNote(info, "Luis would need to consult with his wife before retaining an equity stake", { documentId: "d" });
    assert.equal(getPrivateNotes(info).length, 5);
    assert.ok(!sameNoteContent("Class D dividend of $60,000 declared 2024", "Class D dividend of $80,000 declared 2023"));
    // A broker-only CRM note's wording never absorbs a seller-side restatement.
    const info2: Info = {};
    addPrivateNote(info2, "Owner had a health scare with his heart in 2024 per banker", { documentId: "crm", brokerOnly: true });
    addPrivateNote(info2, "Owner had a heart scare in 2024", { documentId: "call" });
    assert.equal(getPrivateNotes(info2).length, 2);
    // Older duplicates on file are folded (reprocess) and grouped (display).
    const legacy: Info = { _brokerPrivateNotes: [
      { note: "Gord had cardiac episode last October - marked PRIVATE, do not put in CIM", documentId: "crm2", brokerOnly: true },
      { note: "Seller had heart episode October 2024, stent placed, back to work in 2 weeks", documentId: "call2" },
      { note: "Seller had a cardiac event in October 2024 (stent placed), doctor advised him to slow down", turn: 4 },
      { note: "Grandkids in Kelowna", documentId: "call2" },
    ] };
    assert.ok(compactPrivateNotes(legacy));
    assert.equal(getPrivateNotes(legacy).length, 3, "the two seller-side heart notes fold; the CRM wording stays its own");
    assert.equal(groupSameNotes(getPrivateNotes({ _brokerPrivateNotes: (legacy as any)._brokerPrivateNotes })).length, 2);
    // Document housekeeping is never a note.
    const junk: Info = {};
    assert.equal(addPrivateNote(junk, "Sample document labeled as fictional business for demonstration purposes", { documentId: "fs" }), false);
    assert.equal(addPrivateNote(junk, "Extract marked confidential and prepared for corporation's advisers only", { documentId: "mb" }), false);
    assert.equal(getPrivateNotes(junk).length, 0);
    // Grandchildren in Kelowna, said twice on the seller side → one note.
    const kids: Info = {};
    addPrivateNote(kids, "Seller's daughter and two grandchildren live in Kelowna BC, seller's wife Donna wants to relocate there", { documentId: "call" });
    addPrivateNote(kids, "Owner wants to spend time with grandkids in Kelowna", { questionnaire: true, reason: "From the intake questionnaire" });
    assert.equal(getPrivateNotes(kids).length, 1);
  }
  ok("private notes: same content in other words → one note, two sources; different figures/people stay apart");

  // ── 5. Add fact: a label naming a field already on file → 409, no annualRevenue2 ──
  {
    const info: Info = { annualRevenue: "$31,020,000" };
    let err: FactError | null = null;
    try { addFact(info, "Revenue", "$31.0M", "financials"); } catch (e) { err = e as FactError; }
    assert.ok(err && err.status === 409);
    assert.equal((err!.details as any).existingKey, "annualRevenue");
    assert.equal((err!.details as any).currentValue, "$31,020,000");
    assert.equal((err!.details as any).existingLabel, "Annual revenue");
    assert.ok(!Object.keys(info).some((k) => /^annualRevenue\d/.test(k)), "no annualRevenue2");
    assert.equal(info.annualRevenue, "$31,020,000", "unchanged");
    // Same for the field's own label.
    assert.throws(() => addFact(info, "Annual revenue", "$31.0M", null), (e: any) => e.status === 409);
    // An empty known field is simply filled.
    const empty: Info = {};
    assert.equal(addFact(empty, "Revenue", "$31.0M", null), "annualRevenue");
    // An ad-hoc label that collides still gets its own numbered key.
    const adhoc: Info = { fleetNotes: "22 vans" };
    assert.equal(addFact(adhoc, "Fleet notes", "3 trailers leased", null), "fleetNotes2");
  }
  ok("add fact: 'Revenue' with annualRevenue on file → 409 with the existing fact; ad-hoc collisions still numbered");

  // ── 6. Deal name / industry are the broker's facts; NAICS text becomes another value ──
  {
    const deal = { businessName: "Harborview MSP", industry: "IT / Managed Services", subIndustry: null, askingPrice: null };
    const info: Info = {
      industry: "541513 - Computer facilities management services",
      businessName: "Harborview Managed Services Inc.",
      _fieldSources: { industry: { source: "document", documentId: "t2" }, businessName: { source: "crm", documentId: "crm1" } },
    };
    const { columnPatch, infoChanged } = reconcileMirroredFacts(deal, info, setBrokerFact);
    assert.ok(infoChanged);
    assert.deepEqual(columnPatch, {});
    assert.equal(info.industry, "IT / Managed Services");
    assert.equal(getFieldSources(info).industry.source, "broker");
    assert.equal(getFieldSources(info).industry.note, "Industry on the deal");
    assert.ok(getFieldAlternates(info).industry?.some((a) => a.value.startsWith("541513")), "NAICS text kept as another value");
    assert.equal(info.businessName, "Harborview MSP");
    // The broker edits the industry fact → the column follows; deleting it never empties the column.
    const before = structuredClone(info);
    setBrokerFact(info, "industry", "Managed IT services");
    assert.deepEqual(columnPatchAfterChange(deal, before, info), { industry: "Managed IT services" });
    const before2 = structuredClone(info);
    delete info.industry;
    assert.deepEqual(columnPatchAfterChange({ ...deal, industry: "Managed IT services" }, before2, info), {}, "a required column is never cleared");
    // The interview still sees the industry and name (only the broker's price is hidden).
    const view = interviewFactView({ ...before, _fieldSources: getFieldSources(before) });
    assert.equal(view.industry, "IT / Managed Services");
  }
  ok("mirror: industry/businessName = broker's deal entry; NAICS/CRM values kept as other values");

  // ── 7. Information tab sections: whole words, not substrings ──
  {
    assert.equal(sectionForKey("currentHiring"), "employees");
    assert.equal(sectionForKey("otherCurrentAssets"), "financials");
    assert.equal(sectionForKey("buildingsAndDepreciableAssets"), "financials");
    assert.equal(sectionForKey("monthlyRent"), "real_estate");
    assert.equal(sectionForKey("leaseExpiry"), "real_estate");
    assert.equal(sectionForKey("roofCondition"), "real_estate");
    assert.equal(patternSectionFor("rentalIncome"), "financials");
    assert.equal(patternSectionFor("hvacTechnicians"), "employees");
    assert.equal(patternSectionFor("leaseholdImprovements"), "real_estate");
    assert.equal(sectionForKey("cerecMill"), "operations");
    assert.equal(sectionForKey("fleetNotes", { brokerSectionOf: { fleetNotes: "operations" } }), "operations");
  }
  ok("sections: currentHiring → employees, current assets → financials, roofCondition → real estate");

  // ── 8. Source dates: a date-only value is that calendar day in the broker's zone ──
  {
    const now = new Date(2026, 8, 25, 12, 0, 0);
    assert.equal(formatShortDate("2026-09-09", true, now), "Sep 9, 2026");
    assert.equal(formatShortDate("2017-04-20", false, now), "Apr 20, 2017");
    assert.equal(formatShortDate("2026-09-24", false, now), "yesterday");
    // A full timestamp still converts: 02:00 UTC on the 10th is the 9th in Toronto.
    assert.equal(formatShortDate("2026-09-10T02:00:00Z", true, now), "Sep 9, 2026");
    assert.equal(parseSourceDate("2026-09-09")!.getDate(), 9);
    assert.equal(formatShortDate("not a date"), null);
  }
  ok("dates: '2026-09-09' shows Sep 9 in Toronto; timestamps still convert");

  // ── 9. Checklist auto-matching: category must match, one generic word isn't enough, emails never link ──
  {
    const bank = [{ id: "b", documentName: "Bank Statements (3 Months)", category: "financial", status: "missing" }];
    assert.equal(findMatchingRequirement(bank, "Financial statements FY2023 (compilation engagement)", "financials"), undefined);
    assert.equal(findMatchingRequirement(bank, "TD Bank statements Jan–Mar 2025.pdf", "financials")?.id, "b");
    const lease = [
      { id: "l", documentName: "Commercial Lease Agreement", category: "legal", status: "missing" },
      { id: "i", documentName: "Insurance Policies", category: "legal", status: "missing" },
    ];
    assert.equal(findMatchingRequirement(lease, "Commercial Lease Agreement.pdf", "legal")?.id, "l");
    assert.equal(findMatchingRequirement(lease, "Commercial Lease Agreement.pdf", "other"), undefined, "'other' is no wildcard");
    assert.equal(findMatchingRequirement(lease, "Email thread - yard lease renewal", "legal"), undefined, "one generic word isn't a match");
    assert.equal(autoLinkableKind("email"), false);
    assert.equal(autoLinkableKind("call"), false);
    assert.equal(autoLinkableKind("document"), true);
    assert.equal(autoLinkableKind(undefined), true);
    const equip = [{ id: "e", documentName: "Equipment List", category: "operational", status: "missing" }];
    assert.equal(findMatchingRequirement(equip, "Equipment list 2024.xlsx", "operations")?.id, "e");
  }
  ok("checklist: no credit for a compilation against bank statements, or for an email about the lease");

  console.log(`\n${n} facts2 harvest checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
