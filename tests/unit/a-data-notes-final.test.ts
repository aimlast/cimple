// ACC2-02: after a reprocess, Ridgeline kept 35 private notes (target ~15) —
// the model's per-wording review never looks across its passes once more, so
// twins stayed apart, business facts stayed in the notes and process chatter
// stayed. finalizeNotes is that last, deterministic look.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/a-data-notes-final.test.ts
import assert from "node:assert/strict";
import { finalizeNotes, applyNotesReview, emptyReview } from "../../server/documents/private-notes-review";
import { getPrivateNotes, privateNoteSources, getFieldSources } from "../../server/interview/info-merger";
import { isSensitiveNote } from "../../server/documents/private-notes-classify";
import { RIDGE_DOCS, RIDGE_NOTES, ridgeInfo } from "./fixtures/ridgeline-notes";

const textsOf = (n: any): string[] => [n.note, ...privateNoteSources(n).map((s: any) => s.wording).filter(Boolean)];
const allTexts = (notes: any[]) => notes.flatMap(textsOf);
const has = (notes: any[], re: RegExp) => notes.some((n) => textsOf(n).some((t) => re.test(t)));

const input = ridgeInfo();
const { info, report } = finalizeNotes(input, RIDGE_DOCS);
const notes = getPrivateNotes(info);
if (process.env.SHOW) {
  notes.forEach((n, i) => console.log(`#${i + 1}`, n.note));
  console.log(JSON.stringify(report, null, 1));
}

// 1. The count comes down to about the number of matters.
{
  assert.equal(RIDGE_NOTES.length, 35);
  assert.ok(notes.length <= 18 && notes.length >= 12, `about 15 notes, got ${notes.length}`);
  console.log(`✓ 35 → ${notes.length} notes`);
}

// 2. Cross-pass twins fold into one note, keeping every source's words.
{
  const kelowna = notes.filter((n) => textsOf(n).some((t) => /Kelowna/.test(t)));
  assert.equal(kelowna.length, 1, "grandkids in Kelowna: one note");
  assert.ok(textsOf(kelowna[0]).some((t) => /spend time with grandkids/.test(t)), "the questionnaire's words stay on the note");
  assert.match(kelowna[0].note, /Donna/);
  const jackpine = notes.filter((n) => textsOf(n).some((t) => /Jackpine/.test(t)));
  assert.equal(jackpine.length, 1, "the Jackpine approach: one note");
  assert.match(jackpine[0].note, /6\.5M/);
  assert.match(jackpine[0].note, /shop closure/);
  const luis = notes.filter((n) => textsOf(n).some((t) => /15% (?:ownership|voting)/.test(t)));
  assert.equal(luis.length, 0, "Luis's 15% is a fact on file, not a note");
  console.log("✓ twins folded (Kelowna, Jackpine); Luis's 15% is on file");
}

// 3. Business facts leave the notes: either already on file, or moved in.
{
  const covered = new Map(report.covered.map((c) => [c.note, c.key]));
  const promoted = new Map(report.promoted.map((p) => [p.note, p.key]));
  const where = (re: RegExp) => {
    const n = RIDGE_NOTES.find((x) => re.test(x.note))!.note;
    return covered.get(n) ?? promoted.get(n);
  };
  assert.equal(where(/^Gord McAllister owns 85%/), "entityType");
  assert.equal(where(/^Luis Ortega owns 15%/), "entityType");
  assert.equal(where(/^Seller is 64/), "ownerAge");
  assert.equal(where(/unaudited compilation/), "auditStatus");
  assert.equal(promoted.get(RIDGE_NOTES.find((x) => /Class D dividend of \$60,000/.test(x.note))!.note), "dividendsDeclared");
  assert.match(String(info.dividendsDeclared), /\$60,000 declared December 16, 2024/);
  assert.equal(getFieldSources(info).dividendsDeclared?.documentId, "minute", "credited to the minute book");
  assert.equal(where(/^Shareholder agreement amended/), "shareholdersAgreement");
  assert.doesNotMatch(String(info.shareholdersAgreement), /recorded in business fields|company transaction matter/, "the model's commentary is not part of the fact");
  assert.equal(where(/^Market rent opinion/), "marketRentOpinion");
  assert.equal(where(/^Associated with McAllister/), "associatedCorporations");
  assert.equal(where(/buy-sell life insurance/), "insuranceCoverage");
  assert.match(String(info.insuranceCoverage), /\$15,000/);
  for (const re of [/Class D dividend/, /unaudited compilation/, /^Seller is 64/, /Market rent opinion/, /Associated with McAllister/, /buy-sell life insurance/, /owns 85%/]) {
    assert.ok(!notes.some((n) => re.test(n.note)), `${re} left the notes`);
  }
  console.log("✓ ownership, dividend, compilation, age, USA, market rent, associated corp, buy-sell insurance → facts");
}

// 4. Process chatter goes; deal terms and the broker's strategy stay.
{
  for (const re of [/process notes, recorded/, /Minute book extract prepared/, /Brassline engaged/, /Email dated May 20/, /Heather to send/, /four million in the backlog/]) {
    assert.ok(!has(notes, re), `${re} is gone`);
  }
  assert.ok(report.chatter.length >= 6);
  for (const re of [/done by end of Q1 2026/, /15-20% seller financing/, /capital gains exemption/, /Larkspur vendor consolidation/, /1\.8 adjusted EBITDA/, /my truck/]) {
    assert.ok(has(notes, re), `${re} stays a note`);
  }
  console.log("✓ chatter out; timeline, VTB, share-sale preference and strategy stay private");
}

// 5. Nothing sensitive is ever lost: every sensitive wording is still on a note.
{
  const before = allTexts(RIDGE_NOTES).filter(isSensitiveNote);
  const after = new Set(allTexts(notes).map((t) => t.trim().toLowerCase()));
  const joined = allTexts(notes).join(" \n ").toLowerCase();
  for (const t of before) assert.ok(after.has(t.trim().toLowerCase()) || joined.includes(t.trim().toLowerCase().replace(/[.\s]+$/, "")), `kept: ${t}`);
  const health = notes.filter((n) => textsOf(n).some((t) => /cardiac|heart/.test(t)));
  assert.equal(health.length, 1);
  assert.ok(textsOf(health[0]).some((t) => /don't want it in any brochure/.test(t)));
  console.log(`✓ all ${before.length} sensitive wordings kept (health note intact)`);
}

// 6. A fact moved out of the notes never carries broker-only words.
{
  for (const p of report.promoted) {
    const v = String(info[p.key]);
    assert.doesNotMatch(v, /CRM|site visit|sniffed|insulting|floor/i, p.key);
    const src = getFieldSources(info)[p.key];
    assert.ok(src && !src.brokerOnly && RIDGE_DOCS.get(src.documentId!)?.visibility === "shared", `${p.key} credited to a shared source`);
  }
  console.log("✓ promoted facts are credited to shared sources and hold their words only");
}

// 7. Idempotent: running again changes nothing (and asks nothing new of the facts).
{
  const again = finalizeNotes(info, RIDGE_DOCS);
  assert.deepEqual(again.info, info);
  assert.equal(again.report.promoted.length, 0);
  assert.equal(again.report.merged, 0);
  console.log("✓ a second pass is a no-op");
}

// 8. Through applyNotesReview (every reprocess path), with no model decisions at all.
{
  const applied = applyNotesReview(ridgeInfo(), emptyReview(), RIDGE_DOCS);
  assert.equal(getPrivateNotes(applied.info).length, notes.length);
  assert.ok(applied.changed);
  const twice = applyNotesReview(applied.info, emptyReview(), RIDGE_DOCS);
  assert.equal(twice.changed, false, "re-applying the review to its own output changes nothing");
  console.log("✓ applied by applyNotesReview even with the model unavailable; stable on re-apply");
}

// 9. A note the broker deleted as a fact stays a note (never written over the broker's delete).
{
  const withSuppressed = { ...ridgeInfo(), _brokerSuppressed: ["dividendsDeclared", "dividendHistory"] } as any;
  const out = finalizeNotes(withSuppressed, RIDGE_DOCS);
  assert.ok(getPrivateNotes(out.info).some((n) => /Class D dividend of \$60,000/.test(n.note)), "the dividend note stays");
  assert.equal(out.info.dividendsDeclared, undefined);
  console.log("✓ a key the broker deleted is never written; the note stays");
}

// 10. What must stay a note.
{
  const extra = [
    { note: "Employee list sent by Donna shows 3 employees on WCB claims", documentId: "emailDocs" },
    { note: "Luis confirmed 15% ownership stake but wants to sell it to the buyer", documentId: "emailUsa" },
    { note: "Customer HV-1057 gave 90-day non-renewal notice", documentId: "crmSite", brokerOnly: true },
    { note: "Seller is 64 years old and his heart doctor told him to retire", documentId: "call" },
    { note: "Engagement fee is 4% of the price, exclusive for 12 months", documentId: "emailDocs" },
  ];
  const info = { ...ridgeInfo(), _brokerPrivateNotes: [...(ridgeInfo()._brokerPrivateNotes as any[]), ...extra] } as any;
  const out = getPrivateNotes(finalizeNotes(info, RIDGE_DOCS).info);
  for (const e of extra) assert.ok(has(out, new RegExp(e.note.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))), `stays: ${e.note}`);
  console.log("✓ substance, a stance, a broker-only disclosure, a health detail and engagement terms stay notes");
}

console.log("a-data-notes-final: all passed");
