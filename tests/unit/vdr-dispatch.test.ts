/**
 * INTEGRATION §2.17: the document events reach the data room.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-dispatch.test.ts
 *
 *  - ingestDocument: a picture, or a file the broker chose to "just store",
 *    is never read (no text, no AI), and its `finally` files the document into
 *    the room (unshared)
 *  - deleteDocumentAndProvenance → the room keeps a tombstone
 *  - restampSourceVisibility(broker-only) → out of the room at once
 * The app's storage and the room's DB store are swapped for in-memory ones.
 */
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { dbVdrStore } from "../../server/vdr/store";
import { _setExtractionClientForTests } from "../../server/documents/extractor";
import { fakeVdrStore } from "./vdr-fake-store";

const D = "deal-x";
const t0 = new Date("2026-10-01T00:00:00Z");
const docs: any[] = [
  { id: "photo", dealId: D, name: "Yard photo", originalName: "yard.jpg", category: "operations", subcategory: null, fileUrl: "/uploads/docs/doc_nope.jpg", mimeType: "image/jpeg", sourceKind: "document", visibility: "shared", sourceMeta: null, uploadedBy: "broker", status: "pending", extractedText: null, extractedData: null, createdAt: new Date("2026-10-05T00:00:00Z") },
  { id: "stored", dealId: D, name: "Bank statements 2024", originalName: "bank.pdf", category: "financials", subcategory: null, fileUrl: "/uploads/docs/doc_bank.pdf", mimeType: "application/pdf", sourceKind: "document", visibility: "shared", sourceMeta: { readSkipped: true }, uploadedBy: "broker", status: "pending", extractedText: null, extractedData: null, createdAt: new Date("2026-10-05T00:00:00Z") },
  { id: "t2", dealId: D, name: "T2 corporate tax return 2023", originalName: "t2.pdf", category: "financials", subcategory: null, fileUrl: "/uploads/docs/doc_t2.pdf", mimeType: "application/pdf", sourceKind: "document", visibility: "shared", sourceMeta: null, uploadedBy: "broker", status: "extracted", extractedText: "x", extractedData: {}, createdAt: t0 },
];
let deal: any = { id: D, brokerId: "b1", businessName: "Probe Co", extractedInfo: {} };
const s = storage as any;
s.getDocument = async (id: string) => docs.find((d) => d.id === id);
s.updateDocument = async (id: string, patch: any) => Object.assign(docs.find((d) => d.id === id), patch);
s.deleteDocument = async (id: string) => { docs.splice(docs.findIndex((d) => d.id === id), 1); };
s.getDocumentsByDeal = async () => docs.map((d) => ({ ...d }));
s.getDocumentsByFileUrl = async (u: string) => docs.filter((d) => d.fileUrl === u);
s.getDeal = async () => JSON.parse(JSON.stringify(deal));
s.updateDeal = async (_id: string, patch: any) => { deal = { ...deal, ...patch }; return deal; };
s.getDiscrepanciesByDeal = async () => [];
s.getDocumentRequirementsByDeal = async () => [];
s.updateDocumentRequirement = async () => undefined;
_setExtractionClientForTests({ messages: { create: async () => { throw new Error("NO AI in this test"); } } } as any);

// The room's store → in memory (shared with the app's document rows).
const fake = fakeVdrStore();
fake.documents.push(...docs);
Object.assign(dbVdrStore, fake.store, { getDocument: s.getDocument, listDocuments: async () => docs });
await fake.store.ensureRoom({ dealId: D, setUpBy: "b1", status: "open", autoAddNew: true });
(fake.rooms.get(D) as any).setUpAt = t0;
const { setUpRoom } = await import("../../server/vdr/setup");
await setUpRoom(D, "b1", "auto", { store: dbVdrStore, enqueue: () => {}, now: () => new Date() });
const until = async (cond: () => boolean) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); };

const { ingestDocument } = await import("../../server/documents/ingest");
// A picture: never read, and filed into the room by ingest's finally.
fake.items.splice(0, fake.items.length, ...fake.items.filter((i) => i.documentId === "t2"));
const r1 = await ingestDocument("photo");
assert.equal(r1.status, "extracted");
const photo = docs.find((d) => d.id === "photo");
assert.equal(photo.status, "extracted");
assert.equal(photo.sourceMeta.readFailed.reason, "a picture has no text to read");
assert.equal(photo.sourceMeta.readFailed.retryable, false);
assert.equal(photo.extractedData, null, "nothing was read");
await until(() => fake.items.some((i) => i.documentId === "photo"));
const photoItem = fake.items.find((i) => i.documentId === "photo");
assert.ok(photoItem, "the photo is in the room");
assert.equal(fake.folders.find((f) => f.id === photoItem.folderId).presetKey, "operations.reports");
assert.equal(fake.shares.length, 0, "and shared with nobody");
// "Just store it": not read until the broker asks.
const r2 = await ingestDocument("stored");
assert.equal(r2.status, "extracted");
const stored = docs.find((d) => d.id === "stored");
assert.equal(stored.sourceMeta.readSkipped, true);
assert.equal(stored.sourceMeta.readFailed, undefined, "not a failure — the broker's choice");
await until(() => fake.items.some((i) => i.documentId === "stored"));
assert.equal(fake.folders.find((f) => f.id === fake.items.find((i) => i.documentId === "stored").folderId).presetKey, "financial.bank");

// Deleting a document → a tombstone in the room.
const { deleteDocumentAndProvenance } = await import("../../server/documents/cleanup");
await deleteDocumentAndProvenance("t2");
const t2Item = fake.items.find((i) => i.title === "T2 corporate tax return 2023");
assert.ok(t2Item.removedAt, "tombstoned");
assert.equal(t2Item.removedReason, "source_deleted");
assert.equal(t2Item.documentId, null);

// Made broker-only on the Information tab → out of the room at once.
const { restampSourceVisibility } = await import("../../server/documents/source-visibility");
docs.find((d) => d.id === "stored").visibility = "broker_only";
await restampSourceVisibility(D, "stored", true);
const storedItem = fake.items.find((i) => i.documentId === "stored");
assert.equal(storedItem.removedReason, "made_private");

console.log("vdr dispatch: ok");
process.exit(0);
