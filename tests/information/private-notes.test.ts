// Broker-private notes with several sources + broker-accepted website facts —
// offline checks (no database, no AI).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/information/private-notes.test.ts
// (the imports need both variables set; nothing connects)
import assert from "node:assert/strict";
import { mergeExtractedData } from "../../server/documents/extractor";
import {
  removeDocumentFields, getFieldSources, getPrivateNotes, addPrivateNote, removePrivateNoteSource,
} from "../../server/interview/info-merger";
import { acceptWebsiteFact, editFact } from "../../server/information/facts";
import { addPrivateNotes } from "../../server/documents/ingest";
import { buildTurnSave } from "../../server/interview/session-manager";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";
import { splitFactsForCim, isLeadFact } from "../../server/information/cim-facts";
import { buildKnowledgeBase } from "../../server/cim/layout-engine";
import { buildInformationView } from "../../server/information/view";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
type Info = Record<string, unknown>;
const crmDoc = (id: string) => ({ id, name: `Pipedrive note ${id}`, sourceKind: "crm", visibility: "broker_only" } as any);
const emailDoc = (id: string) => ({ id, name: `Email ${id}`, sourceKind: "email", visibility: "shared" } as any);
const notesOf = (info: Info) => getPrivateNotes(info).map((x) => x.note);

(async () => {
  // ── 1. CRM re-import: the new version repeats a private note word for word ──
  {
    const info: Info = {};
    addPrivateNotes(info, "Dana mentioned a health scare last year\nOwner would take $1.6M", crmDoc("v1"));
    addPrivateNotes(info, "Dana mentioned a health scare last year", crmDoc("v2"));
    assert.equal(getPrivateNotes(info).length, 2, "no duplicate note");
    assert.equal(getPrivateNotes(info)[0].alsoFrom?.[0].documentId, "v2", "v2 recorded as another source");
    // seller-import retires v1 after ingesting v2
    const r = removeDocumentFields(info, "v1");
    assert.ok(r.changed);
    assert.deepEqual(notesOf(r.info), ["Dana mentioned a health scare last year"], "the note v2 still states stays; v1's other note goes");
    const kept = getPrivateNotes(r.info)[0];
    assert.equal(kept.documentId, "v2", "now credited to v2");
    assert.equal(kept.brokerOnly, true);
    assert.equal(kept.reason, "From Pipedrive note v2");
    assert.equal(kept.alsoFrom, undefined);
    // …and retiring v2 later (nothing else states it) removes it
    const r2 = removeDocumentFields(r.info, "v2");
    assert.equal(r2.info._brokerPrivateNotes, undefined);
  }
  {
    // Same note, different punctuation / case — still one note, two sources.
    const info: Info = {};
    addPrivateNotes(info, "Owner going through a divorce.", emailDoc("e1"));
    addPrivateNotes(info, "owner going through a divorce", emailDoc("e2"));
    assert.equal(getPrivateNotes(info).length, 1);
    // the broker deletes e2 (the second source) — e1 still states it
    const r = removeDocumentFields(info, "e2");
    assert.deepEqual(notesOf(r.info), ["Owner going through a divorce."]);
    assert.equal(getPrivateNotes(r.info)[0].documentId, "e1");
    // re-adding the same source is a no-op
    assert.equal(addPrivateNote(r.info, "Owner going through a divorce", { documentId: "e1" }), false);
  }
  {
    // Legacy rows (single source, no alsoFrom) still read and remove as before.
    const info: Info = { _brokerPrivateNotes: [{ note: "Old note", reason: "From X", documentId: "x" }, { note: "Interview note", turn: 2 }, null] };
    assert.equal(removePrivateNoteSource(info, "x"), true);
    assert.deepEqual(notesOf(info), ["Interview note"], "interview notes never depend on a document");
    assert.equal(removePrivateNoteSource(info, "nope"), false);
  }
  ok("a private note two sources state survives deleting or re-importing one of them");

  // ── 2. Interview prompt: agent holds a note only via a seller-side source ──
  {
    const docs: any[] = [
      { id: "crm1", name: "Pipedrive note crm1", createdAt: new Date(), sourceKind: "crm", sourceMeta: null, visibility: "broker_only" },
      { id: "em1", name: "Email em1", createdAt: new Date(), sourceKind: "email", sourceMeta: null, visibility: "shared" },
    ];
    const info: Info = {};
    addPrivateNotes(info, "Owner had a heart attack in 2025\nOwner would accept a floor of $1.6M", docs[0]);
    // the seller says the health matter in the interview; the floor stays broker-only
    addPrivateNote(info, "Owner had a heart attack in 2025", { reason: "Seller asked to keep health private", turn: 4 });
    // the seller also mentions a divorce in a shared email that the CRM also noted
    addPrivateNotes(info, "Going through a divorce", docs[0]);
    addPrivateNotes(info, "Going through a divorce", docs[1]);
    const deal: any = {
      id: "d1", brokerId: "b1", businessName: "Biz", industry: "Dental", subIndustry: null, location: null, description: null,
      extractedInfo: info, questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null, scrapeSource: null,
      sellerProfile: null, sectionImportance: null, interviewOutline: null, interviewPlan: null,
    };
    const prompt = renderKnowledgeBaseForPrompt(assembleKnowledgeBase(deal, docs, [], null, []));
    assert.doesNotMatch(prompt, /1\.6M|floor|Pipedrive note/, "a broker-only note, and the broker's source, never reach the agent");
    assert.match(prompt, /heart attack in 2025 \(Seller asked to keep health private\)/, "credited to the interview, not the CRM");
    assert.match(prompt, /Going through a divorce \(From Email em1\)/);
    // the shared email is deleted → the divorce note stays for the broker but leaves the agent's prompt
    const r = removeDocumentFields(info, "em1");
    assert.ok(notesOf(r.info).includes("Going through a divorce"), "the CRM note still states it — broker keeps it");
    const prompt2 = renderKnowledgeBaseForPrompt(assembleKnowledgeBase({ ...deal, extractedInfo: r.info }, docs, [], null, []));
    assert.doesNotMatch(prompt2, /divorce/);
    // the CRM note is deleted → the interview-stated note stays, the broker-only ones go
    const r2 = removeDocumentFields(r.info, "crm1");
    assert.deepEqual(notesOf(r2.info), ["Owner had a heart attack in 2025"]);
    assert.equal(getPrivateNotes(r2.info)[0].documentId, undefined);
  }
  ok("the agent holds a private note only through a seller-side source, credited to it");

  // ── 3. Interview turn save: notes the turn added, nothing resurrected ──
  {
    const turnSrc = { source: "interview" as const, sessionId: "s1", turn: 6, at: "t" };
    const snapshot: Info = {
      _brokerPrivateNotes: [
        { note: "Spouse unaware of sale", reason: "From Email A", documentId: "A" },
        { note: "Health scare", reason: "From Pipedrive note C", documentId: "C", brokerOnly: true },
      ],
    };
    // the turn: the seller states the CRM's health note, and a new one
    const merged: Info = JSON.parse(JSON.stringify(snapshot));
    addPrivateNote(merged, "Health scare", { reason: "Seller shared", turn: 6 });
    addPrivateNote(merged, "Considering moving abroad", { reason: "Seller shared", turn: 6 });
    // meanwhile the broker deleted email A
    const fresh = removeDocumentFields(snapshot, "A").info;
    const saved = buildTurnSave({ snapshot, merged, fresh, changedFacts: [], turnSrc });
    assert.deepEqual(notesOf(saved).sort(), ["Considering moving abroad", "Health scare"], "A's note not resurrected from the stale snapshot");
    const health = getPrivateNotes(saved).find((x) => x.note === "Health scare")!;
    assert.equal(health.alsoFrom?.[0].turn, 6, "the seller's statement is recorded as another source");
    // deleting the CRM note later keeps it (the seller said it)
    const r = removeDocumentFields(saved, "C");
    assert.ok(notesOf(r.info).includes("Health scare"));
    assert.equal(getPrivateNotes(r.info).find((x) => x.note === "Health scare")!.brokerOnly, undefined);
  }
  ok("interview turn save adds the turn's notes source by source and never resurrects a deleted source's note");

  // ── 4. Website facts the broker accepted are facts for the CIM writers ──
  {
    const info: Info = { businessDescription: "Family dental clinic", _fieldSources: { businessDescription: { source: "website" } } };
    assert.equal(isLeadFact(info, "businessDescription"), true, "an unaccepted website value is a lead");
    acceptWebsiteFact(info, "awards", "Best clinic in Halifax 2024");
    assert.equal(getFieldSources(info).accolades.acceptedByBroker, true);
    assert.equal(getFieldSources(info).accolades.source, "website", "still ranked as the website");
    const split = splitFactsForCim(info);
    assert.deepEqual(split.confirmed.map(([k]) => k), ["accolades"]);
    assert.deepEqual(split.leads.map(([k]) => k), ["businessDescription"]);
    const kbText = buildKnowledgeBase({ dealId: "d", businessName: "Biz", industry: "Dental", extractedInfo: info } as any);
    const leadsBlock = kbText.split("UNCONFIRMED LEADS")[1] ?? "";
    assert.doesNotMatch(leadsBlock, /Best clinic/, "the accepted claim is not in the leads block");
    assert.match(kbText, /Best clinic in Halifax 2024/);
    // a row accepted before the flag existed (only the note) is a fact too
    const legacy: Info = { accolades: "Award", _fieldSources: { accolades: { source: "website", note: "Accepted by you from the website" } } };
    assert.equal(isLeadFact(legacy, "accolades"), false);
    // a document later replaces it → document kind, no stale flag
    const withDoc = mergeExtractedData(info, { accolades: "Best clinic in Halifax 2023, 2024" } as any, "DOC1");
    assert.equal(getFieldSources(withDoc).accolades.source, "document");
    assert.equal(getFieldSources(withDoc).accolades.acceptedByBroker, undefined);
    // …and deleting the document brings the accepted website value back, still accepted
    const back = removeDocumentFields(withDoc, "DOC1").info;
    assert.equal(back.accolades, "Best clinic in Halifax 2024");
    assert.equal(isLeadFact(back, "accolades"), false);
  }
  {
    // Accepting the website's value when a CRM note already holds the same value:
    // the broker vouched for it — no longer a lead, source stays CRM.
    const info: Info = { numberOfLocations: "2", _fieldSources: { numberOfLocations: { source: "crm", documentId: "c1" } } };
    assert.equal(isLeadFact(info, "numberOfLocations"), true);
    acceptWebsiteFact(info, "numberOfLocations", "2");
    assert.equal(getFieldSources(info).numberOfLocations.source, "crm");
    assert.equal(isLeadFact(info, "numberOfLocations"), false);
    const view = buildInformationView({
      deal: { id: "d", extractedInfo: info, questionnaireData: null, scrapedData: { numberOfLocations: "2" }, industry: "Dental" } as any,
      documents: [], sessions: [],
    });
    assert.equal(view.website?.items.find((i) => i.field === "numberOfLocations")?.status, "accepted");
    // a broker edit makes it plainly "broker"
    editFact(info, "numberOfLocations", "3");
    assert.equal(getFieldSources(info).numberOfLocations.source, "broker");
    assert.equal(isLeadFact(info, "numberOfLocations"), false);
  }
  ok("website facts the broker accepted are used as facts by the CIM writers; unaccepted ones stay leads");

  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
