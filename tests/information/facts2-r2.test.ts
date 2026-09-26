// QA-harvest "facts2" round 2 — offline checks (no database, no AI):
// private notes never lose a source's words, different people's matters stay
// apart, a reprocess keeps notes a fresh run didn't repeat, process/contact
// items are no notes; stated "included in the price" facts survive the
// extraction guard; lease and licence uploads link to their checklist rows;
// the intake privacy backstop leaves clinical business vocabulary alone and
// a split may not invent figures.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/information/facts2-r2.test.ts
import assert from "node:assert/strict";
import { getPrivateNotes, addPrivateNote, compactPrivateNotes, removePrivateNoteSource, privateNoteSources } from "../../server/interview/info-merger";
import { sameNoteContent, isHousekeepingNote, noteRecordedAsFact, withoutHousekeeping } from "../../shared/private-notes";
import { refreshSourceNotes } from "../../server/documents/ingest";
import { guardExtraction, figureNotStatedOnItsOwn } from "../../server/documents/extraction-guard";
import { findMatchingRequirement } from "../../server/documents/requirements";
import {
  answerHash, checkedSplit, figuresFaithful, keywordSplit, mentionsPrivateMatter, splitStillValid, unscreenedAnswers,
} from "../../server/interview/questionnaire-privacy";
import { seedExtractedInfoFromQuestionnaire } from "../../server/interview/session-manager";
import { getFieldSources, getFieldAlternates } from "../../server/interview/info-merger";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
type Info = Record<string, unknown>;
const allText = (info: Info) => JSON.stringify(getPrivateNotes(info));

// ── 1. Different people's matters are different notes ──
{
  const pairs: Array<[string, string]> = [
    ["Owner had a heart attack in 2024", "Owner's wife had heart surgery in 2024"],
    ["Owner is going through a divorce", "Owner's son is going through a divorce and may need to sell his shares"],
    ["Owner had a stroke in 2023", "Owner's business partner had a stroke in 2023 and has stepped back"],
    ["Seller's daughter and two grandchildren live in Kelowna BC", "Seller's grandson played on Leduc junior hockey team"],
  ];
  for (const [a, b] of pairs) {
    assert.equal(sameNoteContent(a, b), false, `${a} / ${b}`);
    const info: Info = {};
    addPrivateNote(info, a, { documentId: "d1" });
    addPrivateNote(info, b, { documentId: "d2" });
    assert.equal(getPrivateNotes(info).length, 2, b);
    assert.ok(allText(info).includes(b), "the second note's text is on file");
  }
  // The same matter in other words is still one note.
  assert.ok(sameNoteContent("Owner had a cardiac event in 2024", "Seller disclosed a 2024 heart event"));
  assert.ok(sameNoteContent("Owner's wife had heart surgery in 2024", "Seller's wife underwent cardiac surgery in 2024"));
}
ok("dedup: the owner vs his wife / son / business partner are different notes; the same matter still merges");

// ── 2. A merge keeps every source's words; removing the first source promotes the next wording ──
{
  const info: Info = {};
  addPrivateNote(info, "Owner had a cardiac event in 2024", { documentId: "call1", reason: "From Intro call" });
  addPrivateNote(info, "Seller disclosed a 2024 heart event; stent placed, doctor advised him to slow down", { documentId: "email1", reason: "From Email" });
  let notes = getPrivateNotes(info);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].note, "Owner had a cardiac event in 2024");
  assert.match(notes[0].alsoFrom![0].wording!, /stent placed/, "the restatement's own words are kept");
  // Re-adding the same wording from the same source changes nothing.
  assert.equal(addPrivateNote(info, "Seller disclosed a 2024 heart event; stent placed, doctor advised him to slow down", { documentId: "email1" }), false);
  // Compaction is lossless and idempotent.
  const snapshot = JSON.stringify(info);
  compactPrivateNotes(info);
  assert.equal(JSON.stringify(info), snapshot);
  // The first source goes: the note now reads in the remaining source's words.
  removePrivateNoteSource(info, "call1");
  notes = getPrivateNotes(info);
  assert.equal(notes.length, 1);
  assert.match(notes[0].note, /stent placed/);
  assert.equal(notes[0].documentId, "email1");
  assert.equal(notes[0].alsoFrom, undefined);
  // Three sources: dropping the first writes the old text out on the third (implicit wording).
  const three: Info = {};
  addPrivateNote(three, "Owner had a cardiac event in 2024", { documentId: "a" });
  addPrivateNote(three, "Owner had a cardiac event in 2024", { documentId: "b" });
  addPrivateNote(three, "Seller disclosed a 2024 heart event", { documentId: "c" });
  removePrivateNoteSource(three, "a");
  const t = getPrivateNotes(three)[0];
  assert.equal(t.note, "Owner had a cardiac event in 2024");
  assert.equal(privateNoteSources(t).find((s) => s.documentId === "c")!.wording, "Seller disclosed a 2024 heart event");
  // Legacy duplicates compacted: every text survives as a note or a wording.
  const legacy: Info = { _brokerPrivateNotes: [
    { note: "Seller had heart episode October 2024, stent placed, back to work in 2 weeks", documentId: "call2" },
    { note: "Seller had a cardiac event in October 2024 (stent placed), doctor advised him to slow down", turn: 4 },
    { note: "Owner's wife had heart surgery in 2024", documentId: "call2" },
  ] };
  compactPrivateNotes(legacy);
  assert.equal(getPrivateNotes(legacy).length, 2);
  for (const text of ["back to work in 2 weeks", "doctor advised him to slow down", "wife had heart surgery"]) assert.ok(allText(legacy).includes(text), text);
}
ok("merge keeps each source's wording; removal promotes it; compaction loses nothing");

// ── 3. Reprocess: notes a fresh run didn't repeat are kept; business facts and non-notes go ──
{
  const doc = { id: "beaconCall", name: "Intro call", sourceKind: "call", visibility: "shared" } as any;
  const info: Info = {};
  addPrivateNote(info, "Seller's bottom-line expectation based on conference talk of '4-5x multiples' but defers to broker - negotiation position", { documentId: "beaconCall", reason: "From Intro call" });
  addPrivateNote(info, "Gord references 'my truck + personal stuff through the company'", { documentId: "beaconCall", reason: "From Intro call" });
  addPrivateNote(info, "Class D dividend of $60,000 declared December 16, 2024 payable only to Gord", { documentId: "beaconCall" });
  addPrivateNote(info, "Owner had a cardiac event in October 2024", { documentId: "beaconCall" });
  addPrivateNote(info, "Owner had a cardiac event in October 2024", { turn: 3 });
  // The fresh run: repeats the health note in other words, records the dividend as a fact, says nothing else.
  refreshSourceNotes(info, doc, {
    _privateNotes: "Seller had a heart episode in October 2024 with a stent",
    dividendsDeclared: "December 16, 2024: dividend of $60,000.00 declared on Class D shares",
  });
  const text = allText(info);
  assert.ok(text.includes("4-5x multiples"), "the negotiation note stays");
  assert.ok(text.includes("my truck + personal stuff"), "the personal-use note stays");
  assert.ok(!text.includes("dividend"), "the dividend is a fact now, not a note");
  const heart = getPrivateNotes(info).filter((x) => /cardiac|heart/.test(JSON.stringify(x)));
  assert.equal(heart.length, 1, "the health note once, with the call and the interview as sources");
  assert.ok(JSON.stringify(heart[0]).includes("with a stent"));
  // A dividend note naming a figure the fact lacks is not the fact.
  assert.equal(noteRecordedAsFact("Family member of majority shareholder employed as bookkeeper at $58,000", { relatedPartyTransactions: "Premises leased from McAllister Properties Ltd. (owned by the majority shareholder)" }), false);
  assert.equal(noteRecordedAsFact("Majority shareholder provided personal guarantee on bank loan", { personalGuarantees: "Majority shareholder personally guarantees the BDC term loan" }), true);
  assert.equal(noteRecordedAsFact("Owner had a heart attack", { personalGuarantees: "Owner guarantees the loan" }), false);
}
ok("reprocess keeps notes a fresh run didn't repeat; drops only notes now recorded as facts");

// ── 3b. Business transactions filed as notes become the facts they are ──
{
  // The Ridgeline minute book's stored extraction (older prompt): the dividend was a note, no fact.
  const minuteBook = guardExtraction({
    summary: "Minute book extract",
    _privateNotes: [
      "Extract marked confidential and prepared for corporation's advisers only",
      "Class D dividend of $60,000 declared December 16, 2024 payable only to Gord McAllister (100 Class D shares), no dividend to Class A shareholders",
      "Shareholder agreement acknowledges Luis Ortega's annual bonus arrangement as consideration for Class D structure",
    ].join("\n"),
  }, "…", { document: true }).data;
  assert.match(String(minuteBook.dividendsDeclared), /\$60,000 declared December 16, 2024/);
  assert.ok(!String(minuteBook._privateNotes).includes("dividend"));
  assert.ok(String(minuteBook._privateNotes).includes("bonus arrangement"), "a non-transaction note stays a note");
  // FY2023 statements: audit status and guarantee become facts; a related-party note the fact already covers goes.
  const fs2023 = guardExtraction({
    relatedPartyTransactions: "Rent of $322,000 paid to McAllister Properties Ltd. (owned by majority shareholder)",
    _privateNotes: [
      "Financial statements are unaudited compilation only, not audited or reviewed",
      "Majority shareholder provides limited personal guarantee on main term loan",
      "Premises owned by entity controlled by majority shareholder (related party)",
      "Related party lease arrangement - property owned by shareholder's company not included in sale assets",
    ].join("\n"),
  }, "…", { document: true }).data;
  assert.match(String(fs2023.auditStatus), /unaudited compilation/);
  assert.match(String(fs2023.personalGuarantees), /personal guarantee on main term loan/);
  assert.match(String(fs2023.relatedPartyTransactions), /not included in sale assets/, "a note adding to the fact is appended to it");
  assert.equal(fs2023._privateNotes, undefined);
  // A document: a relative keeping the books, a partner's stake, the holdco's building.
  const notes = "Gord's wife Donna does books part-time\nLuis confirmed 15% ownership stake\nGrandkids in Kelowna\nBuilding owned by Gord's holdco McAllister Properties";
  const doc = guardExtraction({ _privateNotes: notes }, "…", { document: true }).data;
  assert.match(String(doc.relatedPartyTransactions), /Donna does books part-time; Building owned by Gord's holdco/);
  assert.equal(doc.ownershipStructure, "Luis confirmed 15% ownership stake");
  assert.equal(doc._privateNotes, "Grandkids in Kelowna");
  // An e-mail, call or CRM note is second-hand: its notes are never promoted
  // ("personal indemnity on lease that needs to be replaced by Northgate" names the buyer).
  const email = guardExtraction({ _privateNotes: notes + "\nHelen Park has personal indemnity on lease that needs to be replaced by Northgate" }, "…").data;
  assert.equal(email.relatedPartyTransactions, undefined);
  assert.equal(email.personalGuarantees, undefined);
  assert.equal(String(email._privateNotes).split("\n").length, 5);
  // A negotiation position or a personal matter naming a guarantee stays private.
  const neg = guardExtraction({ _privateNotes: "Seller's floor is $3M because he must clear his personal guarantee\nOwner guarantees the loan and was diagnosed with cancer in 2024" }, "…", { document: true }).data;
  assert.equal(neg.personalGuarantees, undefined);
  assert.equal(String(neg._privateNotes).split("\n").length, 2);
}
ok("business transactions filed as notes (dividend, guarantee, audit status, related party) become facts; negotiation/personal stay notes");

// ── 4. Process status, participants, to-dos and contact details are not notes ──
{
  for (const t of [
    "Email participants: Morgan Ellis (broker), Heather Kwan (accountant)",
    "NDA in place",
    "Engagement letter signed",
    "Mutual NDA signed and returned",
    "Ask for WIP report",
    "Follow up with the accountant on the 2024 T2",
    "Request copies of the equipment leases",
    "Business address and Gord's personal cell 780-555-0163 disclosed",
    "Kwan & Associates CPA, 4410 Gateway Blvd, Edmonton AB T6H 2H7",
    "Sample document labeled as fictional business for demonstration purposes",
  ]) assert.equal(isHousekeepingNote(t), true, t);
  for (const t of [
    "Engagement letter signed at a 6% success fee with 12-month exclusivity",
    "Seller asked to keep the heart episode out of the CIM",
    "Donna lives at 12 Oak Street and wants to move to Kelowna to be near the grandchildren",
    "Owner had Heart Surgery at 12 Main Street clinic",
    "Seller is 64 years old",
    "Only Luis, Donna and Heather know about the sale; key staff not yet informed",
    "Gord willing to carry 15-20% seller financing but wants most cash at closing",
  ]) assert.equal(isHousekeepingNote(t), false, t);
  const info: Info = {};
  assert.equal(addPrivateNote(info, "NDA in place", { documentId: "crm", brokerOnly: true }), false);
  assert.equal(getPrivateNotes(info).length, 0);
  // A stamp is cut from a note that says more; the rest stays.
  assert.equal(withoutHousekeeping("Document marked CONFIDENTIAL - staff are not aware of the sale process"), "staff are not aware of the sale process");
  assert.equal(withoutHousekeeping("Extract marked confidential and prepared for corporation's advisers only"), null);
  addPrivateNote(info, "Document marked CONFIDENTIAL - staff are not aware of the sale process", { documentId: "lease" });
  assert.equal(getPrivateNotes(info)[0].note, "staff are not aware of the sale process");
}
ok("participants, NDA/engagement status, to-dos and contact details are not private notes");

// ── 5. Extraction guard: stated deal terms about what a price includes survive ──
{
  const src = [
    "Building not included in the $6.5M price; buyers can lease it or buy it separately.",
    "Inventory (~$180,000 at cost) included in the $3.2M asking price.",
    "Still waiting on paper for Westlock — unclear if included in $4.2M backlog.",
    "Owner salary: included in $1,442,300 salaries and wages.",
  ].join("\n");
  const out = guardExtraction({
    realEstateTreatment: "Building not included in the $6.5M price; buyers can lease it or buy it separately",
    inventoryIncluded: "Inventory (~$180,000 at cost) included in the $3.2M asking price",
    westlockPurchaseOrderStatus: "Waiting on paper for Westlock; unclear if included in $4.2M backlog",
    ownerSalary2023: "Included in $1,442,300 salaries and wages",
    managerSalary: "Manager salary included in $1,442,300 wages",
    rentNote: "Not separately disclosed",
  }, src);
  assert.ok(out.data.realEstateTreatment && out.data.inventoryIncluded && out.data.westlockPurchaseOrderStatus, JSON.stringify(out.dropped));
  assert.equal(out.data.ownerSalary2023, undefined);
  assert.equal(out.data.managerSalary, undefined);
  assert.equal(out.data.rentNote, undefined);
  assert.equal(figureNotStatedOnItsOwn("Equipment included in the purchase price"), false);
  assert.equal(figureNotStatedOnItsOwn("Included in $1.4M wages"), true);
}
ok("guard: 'not included in the $6.5M price', 'inventory included in the $3.2M asking price', 'unclear if included in backlog' kept; 'Included in $X wages' dropped");

// ── 6. Checklist: lease and licence uploads link again; the wrong credits stay fixed ──
{
  const rows = [
    ["Financial Statements (3 Years)", "financial"], ["Bank Statements (3 Months)", "financial"], ["Tax Returns (3 Years)", "tax"],
    ["Commercial Lease Agreement", "legal"], ["Business Licenses and Permits", "compliance"], ["Employment Agreements", "legal"],
  ].map(([documentName, category], i) => ({ id: documentName, documentName, category, status: "missing", sortOrder: i }));
  const m = (name: string, cat: string) => findMatchingRequirement(rows, name, cat)?.documentName;
  for (const f of ["Industrial lease - 41 Hartwell Industrial Way (2021-2026)", "Lease.pdf", "Store lease 2019 (signed).pdf", "Office lease - 240 Bayfront Commerce Dr.pdf"]) {
    assert.equal(m(f, "legal"), "Commercial Lease Agreement", f);
  }
  assert.equal(m("Lease.pdf", "other"), "Commercial Lease Agreement", "an uncategorised lease still links");
  assert.equal(m("Business licence 2025.pdf", "legal"), "Business Licenses and Permits");
  assert.equal(m("Financial statements FY2023 (compilation engagement)", "financials"), "Financial Statements (3 Years)");
  assert.equal(findMatchingRequirement([rows[1]], "Financial statements FY2023 (compilation engagement)", "financials"), undefined);
  assert.equal(findMatchingRequirement([rows[1]], "Financial statements FY2023 (compilation engagement)", "other"), undefined);
  assert.equal(m("Bank statements Jan-Mar 2025.pdf", "financials"), "Bank Statements (3 Months)");
}
ok("checklist: every lease file and a licence link; statements don't credit bank statements");

// ── 7. Intake privacy backstop: clinical business words are not private; figures can't be invented ──
{
  const vetStaff = "Sam Ortiz — Surgery technician; Pat Kim — Rehab and hydrotherapy lead; Dr. Anna Wu — Associate vet";
  for (const t of [
    vetStaff,
    "We need a buyer who can fund a second surgery room",
    "Our two-stroke engine technician has been with us 11 years",
    "Home care for seniors, including dementia care and post-surgery rehab visits",
    "Diagnosis and treatment of sports injuries; custody of patient records follows PHIPA",
    "Clinic performed 1,200 surgeries in 2024",
    "Pets diagnosed with arthritis get a rehab plan",
  ]) assert.equal(mentionsPrivateMatter(t), false, t);
  for (const t of [
    "Retiring after my 2024 heart procedure",
    "My wife was diagnosed with cancer last spring",
    "I had a stroke in 2023",
    "Going through a divorce",
    "Had back surgery in March and can't lift anymore",
    "Recovering from surgery",
    "His surgery is scheduled for June",
    "Selling for health reasons",
  ]) assert.equal(mentionsPrivateMatter(t), true, t);
  // The model returns the vet staff list unchanged with no notes: it stays a fact.
  assert.deepEqual(checkedSplit(vetStaff, { publicValue: vetStaff, privateNotes: [] }), { publicValue: vetStaff, privateNotes: [], method: "model" });
  // A clinic's service line the model judged public is not overruled by "likely" wording.
  const tplo = "We specialise in knee surgery (TPLO) and hip surgery referrals from 40 clinics";
  assert.equal(checkedSplit(tplo, { publicValue: tplo, privateNotes: [] }).method, "model");
  // Northbeam's real intake answer, with no model available: the health clause (a named
  // person's health, parentheses kept whole) is private; the rest stays the fact.
  const northbeam = "Dave's health (two-disc back surgery spring 2023; can no longer run the loader overnight) and retirement; Karen wants more time at the family cottage; no family successor (Tyler does not want ownership).";
  assert.ok(mentionsPrivateMatter(northbeam));
  const nb = keywordSplit(northbeam);
  assert.deepEqual(nb.privateNotes, ["Dave's health (two-disc back surgery spring 2023; can no longer run the loader overnight) and retirement"]);
  assert.ok(!/surgery|loader|health/.test(String(nb.publicValue)), String(nb.publicValue));
  assert.match(String(nb.publicValue), /Karen wants more time at the family cottage/);
  assert.ok(!mentionsPrivateMatter("The company's health and safety record is spotless"));
  // Clause-level backstop: only the personal clause goes private.
  const k = keywordSplit("Retiring after 30 years, and my wife was diagnosed with cancer; Luis will stay on as GM");
  assert.equal(k.publicValue, "Retiring after 30 years. Luis will stay on as GM");
  assert.deepEqual(k.privateNotes, ["my wife was diagnosed with cancer"]);
  // A publicValue with a figure the answer never states is not used.
  const answer = "I'm retiring. Been doing this for 19 years and it's time.";
  assert.equal(figuresFaithful("Owner retiring after running the business since 2009", answer), false);
  assert.equal(figuresFaithful("Owner retiring after 19 years", answer), true);
  const bad = checkedSplit(answer, { publicValue: "Owner retiring after running the business since 2009", privateNotes: [] });
  assert.equal(bad.method, "keyword");
  assert.equal(bad.publicValue, answer);
}
ok("privacy backstop: vet/physio/clinic vocabulary stays public; personal matters still caught; no invented figures");

// ── 8. Seeding: a cached split that invented a year is replaced and its value scrubbed ──
{
  const answer = "I'm retiring. Been doing this for 19 years and it's time.";
  const badEntry = { hash: answerHash(answer), publicValue: "Owner retiring after running the business since 2009", privateNotes: [], method: "model" as const, at: "x" };
  assert.equal(splitStillValid(answer, badEntry), false);
  const info: Info = {
    reasonForSale: "Owner retiring (founder, since 2006)",
    _fieldSources: { reasonForSale: { source: "call", documentId: "c1" } },
    _fieldAlternates: { reasonForSale: [{ value: badEntry.publicValue, source: "questionnaire" }] },
    _questionnaireScreen: { reasonForSale: badEntry },
  };
  const deal = { questionnaireData: { reasonForSelling: answer }, extractedInfo: info };
  assert.equal(unscreenedAnswers(deal).length, 1, "the invalid split is re-screened by the model");
  const out = seedExtractedInfoFromQuestionnaire(deal)!;
  const alts = JSON.stringify(getFieldAlternates(out));
  assert.ok(!alts.includes("2009"), "the invented year is gone");
  assert.ok(alts.includes("19 years"), "the seller's own answer is the other value");
  assert.equal(getFieldSources(out).reasonForSale.source, "call");
  // A fresh valid split replaces it and still scrubs the stale value.
  const fresh = { reasonForSale: { hash: answerHash(answer), publicValue: "Owner retiring after 19 years", privateNotes: [], method: "model" as const, at: "y" } };
  const out2 = seedExtractedInfoFromQuestionnaire(deal, fresh)!;
  const alts2 = JSON.stringify(getFieldAlternates(out2));
  assert.ok(!alts2.includes("2009") && alts2.includes("Owner retiring after 19 years"));
}
ok("seeding: a cached split with an invented year is not used and its value is scrubbed");

console.log(`\n${n} facts2 round-2 checks passed`);
