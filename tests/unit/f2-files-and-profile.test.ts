// F2-DI-9: every document delete removes the stored file (the broker's delete
// and the CRM's retire used to leave it on the volume forever), never while
// another row still points at the same file; a one-off sweep clears the files
// earlier deletes left behind.
// F2-DI-6: a seller-profile rebuild carries the broker's notes as they are
// when it lands — a note saved while it generated used to be overwritten.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-files-and-profile.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const uploads = fs.mkdtempSync(path.join(os.tmpdir(), "f2-files-"));
process.env.UPLOADS_DIR = uploads;
const docsDir = path.join(uploads, "docs");
fs.mkdirSync(docsDir);

const { storage } = await import("../../server/storage");
const { deleteDocumentAndProvenance, removeDocumentFile, sweepOrphanDocumentFilesOnce } = await import("../../server/documents/cleanup");
const { saveRegeneratedSellerProfile, carryBrokerProfileEdits } = await import("../../server/interview/eq-profiler");

const put = (name: string, ageMs = 0) => {
  const p = path.join(docsDir, name);
  fs.writeFileSync(p, "x");
  if (ageMs) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(p, t, t); }
  return `/uploads/docs/${name}`;
};

// ── DI-9: deletes remove the file ──
let deal: any = { id: "D", businessName: "Probe", industry: "Retail", extractedInfo: {} };
let docs: any[] = [
  { id: "tax", dealId: "D", name: "Other client's T2", fileUrl: put("doc_tax.pdf"), status: "completed", createdAt: new Date(1) },
  { id: "a", dealId: "D", name: "Shared A", fileUrl: put("src_shared.txt"), status: "completed", createdAt: new Date(1) },
  { id: "b", dealId: "D", name: "Shared B", fileUrl: "/uploads/docs/src_shared.txt", status: "completed", createdAt: new Date(1) },
];
const s = storage as any;
s.getDeal = async () => JSON.parse(JSON.stringify(deal));
s.updateDeal = async (_id: string, p: any) => { deal = { ...deal, ...p }; return deal; };
s.getDocumentsByDeal = async () => docs.map((d) => ({ ...d }));
s.getDocument = async (id: string) => docs.find((d) => d.id === id);
s.getDocumentByFileUrl = async (u: string) => docs.find((d) => d.fileUrl === u);
s.deleteDocument = async (id: string) => { docs = docs.filter((d) => d.id !== id); };
s.getDiscrepanciesByDeal = async () => [];
s.updateDiscrepancy = async () => undefined;
s.getDocumentRequirementsByDeal = async () => [];
s.updateDocumentRequirement = async () => undefined;

await deleteDocumentAndProvenance("tax");
assert.ok(!fs.existsSync(path.join(docsDir, "doc_tax.pdf")), "the deleted source's file leaves the volume");
await deleteDocumentAndProvenance("a");
assert.ok(fs.existsSync(path.join(docsDir, "src_shared.txt")), "a file another row still uses stays");
await deleteDocumentAndProvenance("b");
assert.ok(!fs.existsSync(path.join(docsDir, "src_shared.txt")), "…and goes with the last row using it");
assert.equal(await removeDocumentFile({ id: "x", fileUrl: "/uploads/../../etc/passwd" }), false, "never outside the docs folder");
console.log("✓ deleting a source removes its stored file (never one another row still uses, never outside the docs folder)");

// ── DI-9: the one-off sweep ──
const HOUR = 60 * 60 * 1000;
put("doc_kept.pdf", 2 * HOUR);
put("doc_orphan.pdf", 2 * HOUR);
put("doc_just_uploaded.pdf"); // its row is created a moment after the file
assert.equal(await sweepOrphanDocumentFilesOnce(uploads, Date.now(), async () => []), 0, "no referenced file at all → nothing is touched");
assert.ok(fs.existsSync(path.join(docsDir, "doc_orphan.pdf")));
const removed = await sweepOrphanDocumentFilesOnce(uploads, Date.now(), async () => ["/uploads/docs/doc_kept.pdf", null]);
assert.equal(removed, 1);
assert.ok(fs.existsSync(path.join(docsDir, "doc_kept.pdf")), "a referenced file stays");
assert.ok(!fs.existsSync(path.join(docsDir, "doc_orphan.pdf")), "an old file no row points at goes");
assert.ok(fs.existsSync(path.join(docsDir, "doc_just_uploaded.pdf")), "a fresh file (row not written yet) stays");
put("doc_orphan2.pdf", 2 * HOUR);
assert.equal(await sweepOrphanDocumentFilesOnce(uploads, Date.now(), async () => ["/uploads/docs/doc_kept.pdf"]), 0, "runs once per volume");
console.log("✓ the one-off sweep removes only old files no row points at, once");

// ── DI-6: seller profile rebuild keeps a note saved while it generated ──
const base = { communicationStyle: "direct", emotionalState: "calm", generatedAt: "2026-09-28T00:00:00Z" } as any;
deal = { id: "D", sellerProfile: { ...base } };
const priorAtStart = deal.sellerProfile; // what the old code carried from
// The broker saves a private note while the profile generates…
deal = { ...deal, sellerProfile: { ...base, brokerOverrides: { brokerNotes: "health issue, don't raise retirement timing", communicationStyle: { originalValue: "direct", brokerValue: "reserved" } } } };
const fresh = { communicationStyle: "analytical", emotionalState: "anxious", generatedAt: "2026-09-28T00:01:00Z" } as any;
assert.equal((carryBrokerProfileEdits(fresh, priorAtStart) as any).brokerOverrides, undefined, "(the stale copy the old code used has no note)");
const saved = await saveRegeneratedSellerProfile("D", fresh);
assert.equal((saved.brokerOverrides as any)?.brokerNotes, "health issue, don't raise retirement timing");
assert.equal(deal.sellerProfile.brokerOverrides.brokerNotes, "health issue, don't raise retirement timing", "the note is saved with the new profile");
assert.equal(deal.sellerProfile.communicationStyle, "reserved", "the broker's correction wins over the regenerated value");
assert.equal(deal.sellerProfile.emotionalState, "anxious", "fields the broker didn't touch are the new ones");
console.log("✓ a regenerated seller profile keeps the broker notes / corrections saved while it ran");

fs.rmSync(uploads, { recursive: true, force: true });
console.log("f2-files-and-profile: all passed");
process.exit(0);
