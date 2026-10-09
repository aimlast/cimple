/**
 * gl spec §12.1 test 26: the general-ledger checklist row is added once,
 * never credited by keyword, credited only by a ledger the seller may see
 * once it is read, and released when that ledger goes.
 */
import assert from "node:assert/strict";
import { test, done, fixture } from "./_harness";
import { fakeWorld, fakeDeal, cleanup } from "./_fake-storage";
import {
  ensureGlRequirement, findMatchingRequirement, GL_REQUIREMENT_NAME, GL_REQUIREMENT_SOURCE, isGlRequirement,
  linkUploadToRequirement, populateDocumentRequirements, replacementDocumentFor, releaseRequirementsFor,
} from "../../server/documents/requirements";
import { ingestDocument } from "../../server/documents/ingest";
import { _setGlIngestDepsForTests, glQueueIdle, onLedgerDocumentDeleted } from "../../server/gl/ingest";
import { creditingLedger } from "../../server/gl/requirement";

const w = fakeWorld();
_setGlIngestDepsForTests({ now: () => new Date("2025-03-01T12:00:00Z") });
const deal = fakeDeal(w);
const glRow = () => w.requirements.find((r) => r.dealId === deal.id && isGlRequirement(r))!;

await test("added once with the financial documents, by every population run", async () => {
  await populateDocumentRequirements(deal.id, "Home services");
  await populateDocumentRequirements(deal.id, "Home services");
  assert.equal(await ensureGlRequirement(deal.id), false);
  const rows = w.requirements.filter((r) => r.dealId === deal.id && r.documentName === GL_REQUIREMENT_NAME);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, GL_REQUIREMENT_SOURCE);
  assert.equal(rows[0].category, "financial");
  assert.equal(rows[0].isRequired, true);
  assert.equal(rows[0].status, "missing");
});

await test("never credited by a file's name, never linked by the generic upload, never re-planned", async () => {
  const reqs = w.requirements.filter((r) => r.dealId === deal.id);
  assert.notEqual(findMatchingRequirement(reqs, "General Ledger 3 years.xlsx", "financials")?.id, glRow().id);
  assert.equal(findMatchingRequirement([glRow()], "General Ledger (3 Years, Excel or CSV).csv", "financials"), undefined);
  assert.equal(replacementDocumentFor(glRow(), [{ id: "d", name: "General Ledger 3 Years Excel CSV", category: "financials" }]), undefined);
  const linked = await linkUploadToRequirement({ dealId: deal.id, docId: "doc-x", fileName: "gl.csv", docCategory: "financials", uploadedBy: "seller", requirementId: glRow().id });
  assert.equal(linked, null);
  assert.equal(glRow().status, "missing");
});

await test("credited once a seller-visible ledger is read; a broker-only one never credits it", async () => {
  const priv = w.addDocument({ dealId: deal.id, fileUrl: w.addFile(fixture("qbo-2024-only.csv")), name: "private.csv", subcategory: "general_ledger", visibility: "broker_only" } as any);
  await ingestDocument(priv.id);
  await glQueueIdle();
  assert.equal(glRow().status, "missing", "the seller would see its name");
  const shared = w.addDocument({ dealId: deal.id, uploadedBy: "seller", fileUrl: w.addFile(fixture("qbo-classic.csv")), name: "gl.csv", subcategory: "general_ledger" } as any);
  await ingestDocument(shared.id);
  await glQueueIdle();
  assert.equal(glRow().status, "uploaded");
  assert.equal(glRow().uploadedFileId, shared.id);
  assert.equal(glRow().uploadedBy, "seller");
  // The generic "release" never touches the GL row.
  await releaseRequirementsFor(deal.id, shared.id);
  assert.equal(glRow().status, "uploaded");
  // Deleting the ledger: the row is missing again (the private one still doesn't count).
  w.documents.delete(shared.id);
  await onLedgerDocumentDeleted(shared);
  assert.equal(glRow().status, "missing");
  assert.equal(glRow().uploadedFileId, null);
});

await test("the crediting ledger: ready, seller-visible, the main ledger before an adjustments file, newest first", () => {
  const docs = new Map([["a", { id: "a", visibility: "shared" }], ["b", { id: "b", visibility: "shared" }], ["c", { id: "c", visibility: "broker_only" }]] as any);
  const l = (id: string, documentId: string, role: string, status: string, at: number) => ({ id, documentId, role, status, createdAt: new Date(at) }) as any;
  assert.equal(creditingLedger([l("1", "a", "adjustments", "ready", 3), l("2", "b", "ledger", "ready", 1), l("3", "c", "ledger", "ready", 5)], docs as any)?.ledger.id, "2");
  assert.equal(creditingLedger([l("1", "a", "ledger", "reading", 3)], docs as any), null);
});

cleanup(w);
done("requirements-gl");
