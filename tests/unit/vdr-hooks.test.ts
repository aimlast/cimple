/**
 * vdr spec §9.4, V2, V8, V9: the room follows the deal's documents.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-hooks.test.ts
 * In-memory store (tests/unit/vdr-fake-store.ts); a temp UPLOADS_DIR.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-hooks-"));
process.env.UPLOADS_DIR = tmp;

const { fakeVdrStore } = await import("./vdr-fake-store");
const setup = await import("../../server/vdr/setup");
const { onRequirementFulfilled } = await import("../../server/vdr/requests");
const { vdrCacheDir, cleanCopyRelPath, cleanCopyPath, newPrivateName } = await import("../../server/vdr/files");

const D = "deal-1";
const t0 = new Date("2026-10-01T10:00:00Z");
const docs = [
  { id: "t2-23", dealId: D, name: "T2 corporate income tax return 2023", originalName: "T2 2023.pdf", category: "financials", fileUrl: "/uploads/docs/doc_t2.pdf", mimeType: "application/pdf", createdAt: t0 },
  { id: "fs-23", dealId: D, name: "Financial statements FY2023", originalName: "FS 2023.pdf", category: "financials", fileUrl: "/uploads/docs/doc_fs.pdf", mimeType: "application/pdf", createdAt: t0 },
  { id: "lease", dealId: D, name: "Warehouse lease", originalName: "Lease.pdf", category: "legal", fileUrl: "/uploads/docs/doc_lease.pdf", mimeType: "application/pdf", createdAt: t0, uploadedBy: "seller" },
  { id: "email", dealId: D, name: "Email — follow-up", originalName: "email.txt", category: "other", fileUrl: "/uploads/docs/src_e.txt", sourceKind: "email", createdAt: t0 },
  { id: "crm", dealId: D, name: "CRM note", originalName: "crm.txt", category: "other", fileUrl: "/uploads/docs/crm_c.txt", sourceKind: "crm", visibility: "broker_only", createdAt: t0 },
  { id: "call", dealId: D, name: "Intro call", originalName: "call.txt", category: "transcripts", fileUrl: "/uploads/docs/src_c.txt", sourceKind: null, createdAt: t0 },
  { id: "other-deal", dealId: "deal-2", name: "T2 2023 of another deal", originalName: "x.pdf", category: "financials", fileUrl: "/uploads/docs/doc_x.pdf", createdAt: t0 },
];
const f = fakeVdrStore({ documents: docs });
const queued: string[] = [];
let clock = new Date("2026-10-02T09:00:00Z");
const deps = { store: f.store, enqueue: (id: string) => { queued.push(id); }, now: () => clock };

// ── Set-up: preset index, eligible documents filed, nothing shared ──
const r = await setup.setUpRoom(D, "broker-1", "auto", deps);
assert.equal(r.room.dealId, D);
assert.equal(r.folders.filter((x) => x.presetKey).length, 21, "every preset folder");
assert.deepEqual(r.placed.map((i) => i.documentId).sort(), ["fs-23", "lease", "t2-23"], "emails, calls (legacy too), CRM and other deals' files stay out");
const folderOf = (docId: string) => f.folders.find((x) => x.id === f.items.find((i) => i.documentId === docId)!.folderId)!.presetKey;
assert.equal(folderOf("t2-23"), "financial.tax");
assert.equal(folderOf("fs-23"), "financial.statements");
assert.equal(folderOf("lease"), "legal.property");
assert.equal(f.shares.length, 0, "V2: nothing is shared by setting up");
assert.equal(queued.length, 3, "each placed document is prepared");
assert.ok(f.activity.some((a) => a.action === "room_set_up"));
// Idempotent.
const again = await setup.setUpRoom(D, "broker-1", "auto", deps);
assert.equal(again.placed.length, 0);
assert.equal(f.folders.length, 21);
assert.equal(f.activity.filter((a) => a.action === "room_set_up").length, 1);

// ── Auto-filing a new upload (ingest's finally) ──
f.rooms.get(D).setUpAt = new Date("2026-10-02T08:00:00Z");
f.documents.push({ id: "t2-24", dealId: D, name: "T2 corporate income tax return 2024", originalName: "T2 2024.pdf", category: "financials", fileUrl: "/uploads/docs/doc_t224.pdf", mimeType: "application/pdf", createdAt: new Date("2026-10-02T09:30:00Z"), uploadedBy: "seller", sourceKind: "document", visibility: "shared", subcategory: null });
const auto = await setup.autoFileIfRoom("t2-24", deps);
assert.ok(auto);
assert.equal(auto!.addedBy, "seller");
assert.equal(folderOf("t2-24"), "financial.tax");
assert.equal(auto!.position, 2, "after the other tax return");
assert.equal(await setup.autoFileIfRoom("t2-24", deps).then((x) => x?.id), undefined, "never twice (it already has an item)");
// An old document (before set-up) isn't auto-added; nor is working material.
f.documents.push({ id: "old", dealId: D, name: "Old statements", originalName: "o.pdf", category: "financials", fileUrl: "/uploads/docs/doc_o.pdf", createdAt: new Date("2026-09-01"), sourceKind: "document", visibility: "shared", subcategory: null });
assert.equal(await setup.autoFileIfRoom("old", deps), null);
assert.equal(await setup.autoFileIfRoom("email", deps), null);
// The room's "Add new documents automatically" off → nothing.
f.rooms.get(D).autoAddNew = false;
f.documents.push({ id: "new2", dealId: D, name: "Bank statements 2024", originalName: "b.pdf", category: "financials", fileUrl: "/uploads/docs/doc_b.pdf", createdAt: new Date("2026-10-02T10:00:00Z"), sourceKind: "document", visibility: "shared", subcategory: null });
assert.equal(await setup.autoFileIfRoom("new2", deps), null);
f.rooms.get(D).autoAddNew = true;
// No room → nothing.
assert.equal(await setup.autoFileIfRoom("other-deal", deps), null);

// ── Share the 2023 T2 (as the broker would), then the seller replaces it ──
const t23 = f.items.find((i) => i.documentId === "t2-23")!;
await f.store.insertShares([
  { dealId: D, itemId: t23.id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "broker-1" },
  { dealId: D, itemId: t23.id, audience: "buyer", accessLevel: null, buyerEmail: "jane@northgate.invalid", effect: "deny", createdBy: "broker-1" },
]);
// The broker renamed it in the room; a cleaned copy and a prepared cache exist.
t23.title = "1.2.1 T2 2023 (as filed)";
const ccName = newPrivateName(".pdf");
t23.cleanCopyPath = cleanCopyRelPath(D, ccName);
fs.mkdirSync(path.dirname(cleanCopyPath(D, ccName)!), { recursive: true });
fs.writeFileSync(cleanCopyPath(D, ccName)!, "clean");
const cache = vdrCacheDir(D, t23.id, "0123456789abcdef")!;
fs.mkdirSync(cache, { recursive: true });
fs.writeFileSync(path.join(cache, "p1.webp"), "x");
await f.store.replacePageText({ dealId: D, itemId: t23.id, forFile: "0123456789abcdef", rows: [{ page: 1, label: "Page 1", text: "Sales" }] });

f.documents.push({ id: "t2-23b", dealId: D, name: "T2 2023 corrected", originalName: "T2 2023 v2.pdf", category: "financials", fileUrl: "/uploads/docs/doc_t2b.pdf", createdAt: clock, uploadedBy: "seller", sourceKind: "document", visibility: "shared", subcategory: null });
const replacement = await setup.markReplacement("t2-23", "t2-23b", deps);
assert.ok(replacement);
assert.equal(replacement!.folderId, t23.folderId, "same place");
assert.equal(replacement!.position, t23.position);
assert.equal(replacement!.replacesItemId, t23.id);
assert.equal(replacement!.title, "1.2.1 T2 2023 (as filed)", "the broker's own title stays");
assert.equal(f.shares.filter((s) => s.itemId === replacement!.id).length, 0, "V8: the new version is NOT shared");
assert.equal(t23.replacedByItemId, replacement!.id);
// The old row is then deleted (cleanup's vdr step): a tombstone, files gone, shares kept inert.
clock = new Date("2026-10-03T12:00:00Z");
assert.equal(await setup.onSourceDeleted({ id: "t2-23", dealId: D }, {}, deps), 1);
assert.ok(t23.removedAt);
assert.equal(t23.removedReason, "source_deleted");
assert.equal(t23.documentId, null, "a tombstone points at no document");
assert.equal(fs.existsSync(cleanCopyPath(D, ccName)!), false, "the cleaned copy is removed");
assert.equal(fs.existsSync(cache), false, "the prepared pages are removed");
assert.equal(f.pageText.filter((p) => p.itemId === t23.id).length, 0, "page text removed (no search hits on a deleted file)");
assert.equal(f.shares.filter((s) => s.itemId === t23.id).length, 2, "share rows kept for 'Share with the same people'");
assert.ok(!f.activity.some((a) => a.action === "seller_removed_shared"), "a replacement isn't a removal");
// "Share with the same people" copies the grants, including the exclusion.
const copied = await setup.shareLikeReplaced(replacement!.id, "broker-1", deps);
assert.equal(copied.copied, 2);
assert.deepEqual(f.shares.filter((s) => s.itemId === replacement!.id).map((s) => `${s.audience}:${s.accessLevel ?? s.buyerEmail}:${s.effect}`).sort(), ["buyer:jane@northgate.invalid:deny", "level:due_diligence:allow"]);
assert.equal((await setup.shareLikeReplaced(replacement!.id, "broker-1", deps)).copied, 2, "safe to click twice (rows de-duplicated)");
assert.equal(f.shares.filter((s) => s.itemId === replacement!.id).length, 2);

// ── The seller removes a shared file: tombstone + logged for the broker's To do ──
const leaseItem = f.items.find((i) => i.documentId === "lease")!;
await f.store.insertShares([{ dealId: D, itemId: leaseItem.id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow" }]);
assert.equal(await setup.onSourceDeleted({ id: "lease", dealId: D }, { bySeller: true }, deps), 1);
assert.equal(leaseItem.removedReason, "seller_removed");
const removedLog = f.activity.find((a) => a.action === "seller_removed_shared");
assert.ok(removedLog, "the broker is told");
assert.equal(removedLog.detail.title, "Warehouse lease");
assert.deepEqual(removedLog.detail.levels, ["due_diligence"]);
// cleanup then calls it again: nothing live left, nothing logged twice.
assert.equal(await setup.onSourceDeleted({ id: "lease", dealId: D }, {}, deps), 0);
assert.equal(f.activity.filter((a) => a.action === "seller_removed_shared").length, 1);

// ── Made broker-only: out of the room at once, shares dropped; restorable once shared again ──
const fsItem = f.items.find((i) => i.documentId === "fs-23")!;
await f.store.insertShares([{ dealId: D, itemId: fsItem.id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow" }]);
const fsDoc = f.documents.find((d) => d.id === "fs-23");
fsDoc.visibility = "broker_only";
await setup.onSourceVisibilityChanged("fs-23", true, deps);
assert.equal(fsItem.removedReason, "made_private");
assert.equal(fsItem.prepared, null, "its prepared pages and text are dropped; restoring prepares it again");
assert.equal(fsItem.documentId, "fs-23", "the document still exists; the tombstone keeps it for Put back");
assert.equal(f.shares.filter((s) => s.itemId === fsItem.id).length, 0, "its grants are gone");
// Re-reading the document must never put it back on its own.
assert.equal(await setup.autoFileIfRoom("fs-23", deps), null);
// Still private → can't be restored.
const notYet = await setup.restoreItem(fsItem.id, "broker-1", deps);
assert.equal(notYet.ok, false);
// Shared again → nothing automatic …
fsDoc.visibility = "shared";
await setup.onSourceVisibilityChanged("fs-23", false, deps);
assert.ok(fsItem.removedAt, "shared again: offered back, never re-added on its own");
// … and Put back restores it unshared.
const back = await setup.restoreItem(fsItem.id, "broker-1", deps);
assert.equal(back.ok, true);
assert.equal(fsItem.removedAt, null);
assert.equal(f.shares.filter((s) => s.itemId === fsItem.id).length, 0, "restored unshared");

// ── The broker's explicit "Put in the room" for a document taken out earlier ──
const t24 = f.items.find((i) => i.documentId === "t2-24")!;
await f.store.updateItem(t24.id, { removedAt: clock, removedReason: "broker" });
assert.equal(await setup.autoFileIfRoom("t2-24", deps), null, "taken out by the broker → never re-added automatically");
const put = await setup.fileDocumentIntoRoom(D, "t2-24", "broker", { explicit: true }, deps);
assert.ok(put && !put.removedAt && put.id !== t24.id);
assert.equal(await setup.fileDocumentIntoRoom(D, "crm", "broker", { explicit: true }, deps), null, "broker-only can never go in");
assert.equal(await setup.fileDocumentIntoRoom(D, "other-deal", "broker", { explicit: true }, deps), null, "another deal's document");

// ── The broker's own index is respected: a deleted preset folder isn't re-created ──
{
  const bankFolder = f.folders.find((x) => x.presetKey === "financial.bank");
  f.folders.splice(f.folders.indexOf(bankFolder), 1); // the broker deleted the (empty) folder
  f.documents.push({ id: "bank-25", dealId: D, name: "Bank statements 2025", originalName: "bank25.pdf", category: "financials", fileUrl: "/uploads/docs/doc_b25.pdf", createdAt: clock, uploadedBy: "broker", sourceKind: "document", visibility: "shared", subcategory: null });
  const placedBank = await setup.autoFileIfRoom("bank-25", deps);
  assert.ok(placedBank);
  assert.equal(f.folders.find((x) => x.id === placedBank!.folderId).presetKey, "financial", "goes to the preset's parent");
  assert.equal(f.folders.some((x) => x.presetKey === "financial.bank"), false, "not re-created");
}

// ── gl: a ledger status change re-queues the item ──
queued.length = 0;
await setup.onLedgerStatusChanged("t2-24", deps);
assert.deepEqual(queued, [put!.id]);

// ── A seller upload answering a buyer's request ──
f.requests.push({ id: "rq1", dealId: D, buyerEmail: "jane@northgate.invalid", requirementId: "req-9", status: "asked_seller" }, { id: "rq2", dealId: D, buyerEmail: "bob@x.invalid", requirementId: "req-9", status: "declined" });
assert.equal(await onRequirementFulfilled("req-9", "t2-24", f.store), 1);
assert.equal(f.requests[0].status, "ready_to_share");
assert.equal(f.requests[0].readyDocumentId, "t2-24");
assert.equal(f.requests[1].status, "declined", "a declined request stays declined");
assert.ok(f.activity.some((a) => a.action === "request_ready"));

fs.rmSync(tmp, { recursive: true, force: true });
console.log("vdr hooks: ok");
