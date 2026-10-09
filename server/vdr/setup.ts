/**
 * Setting up a deal's data room and keeping it in step with the deal's
 * documents (vdr spec §9.1 setup.ts, §9.4 hooks). Idempotent throughout.
 *
 *  - setUpRoom: the room row, the preset index (§4.6) and — in "auto" mode —
 *    every eligible document filed into its folder. NOTHING is shared (V2).
 *  - autoFileIfRoom (ingest's finally): a NEW room-material document is filed
 *    unshared when the room's "Add new documents automatically" is on. A
 *    document the broker took out of the room, or one that was made private,
 *    is never put back on its own.
 *  - markReplacement (a seller replacing their checklist upload): the new
 *    version takes the old one's place, NOT shared ("New version from the
 *    seller. Not shared yet." → Share with the same people).
 *  - onSourceDeleted: a tombstone ("This file was deleted on Oct 3"); its
 *    share rows stay (inert) for "Share with the same people"; the cleaned
 *    copy, cache and page text go. A seller removing a file buyers could open
 *    is logged for the broker's To do.
 *  - onSourceMadePrivate: out of the room at once (tombstone `made_private`,
 *    shares dropped) — the serve check also refuses broker_only on every
 *    request, so there is no window.
 */
import { DD_ACCESS_LEVEL } from "@shared/access-levels";
import { isLedgerDoc, isRoomMaterial, type VdrAction } from "@shared/vdr";
import type { Document, InsertVdrActivity, VdrItem } from "@shared/schema";
import { dbVdrStore, logVdrQuietly, type VdrStore } from "./store";
import { planAutoFile, presetFolderRows, presetFor } from "./auto-file";
import { enqueuePrepare } from "./prepare";
import { removeCleanCopy, removeItemCache } from "./files";
import { isGlDocument } from "./gl-adapter";

export type SetupDeps = { store: VdrStore; enqueue: (itemId: string) => void; now: () => Date };
export function defaultSetupDeps(): SetupDeps {
  return { store: dbVdrStore, enqueue: enqueuePrepare, now: () => new Date() };
}

function logRow(dealId: string, action: VdrAction, extra: Partial<InsertVdrActivity> = {}): InsertVdrActivity {
  return { dealId, action, actorKind: "system", ...extra };
}

/** Creates the preset folders that don't exist yet: one statement per level (parents first). */
async function ensurePresetFolders(dealId: string, deps: SetupDeps) {
  const existing = await deps.store.listFolders(dealId);
  const byPreset = new Map(existing.filter((f) => f.presetKey).map((f) => [f.presetKey!, f]));
  const rows = presetFolderRows().filter((r) => !byPreset.has(r.presetKey));
  if (rows.length === 0) return existing;
  // Top level first, then the sub-folders (their parents' ids are known by then).
  for (const level of [rows.filter((r) => !r.parentKey), rows.filter((r) => !!r.parentKey)]) {
    const values = level
      .filter((r) => !r.parentKey || byPreset.has(r.parentKey))
      .map((r) => ({ dealId, parentId: r.parentKey ? byPreset.get(r.parentKey)!.id : null, name: r.name, position: r.position, presetKey: r.presetKey }));
    for (const f of await deps.store.insertFolders(values)) if (f.presetKey) byPreset.set(f.presetKey, f);
    // Another request may have created some meanwhile (ON CONFLICT DO NOTHING): read them back.
    if (values.some((v) => !byPreset.has(v.presetKey))) {
      for (const f of await deps.store.listFolders(dealId)) if (f.presetKey) byPreset.set(f.presetKey, f);
    }
  }
  return deps.store.listFolders(dealId);
}

function nextPosition(items: ReadonlyArray<Pick<VdrItem, "folderId" | "position" | "removedAt">>, folderId: string): number {
  let max = 0;
  for (const i of items) if (i.folderId === folderId && !i.removedAt) max = Math.max(max, i.position);
  return max + 1;
}

/**
 * Sets up the room. `mode: "auto"` files every eligible document (unshared);
 * `"empty"` creates the folders only. Safe to call again: existing folders
 * and placed documents are kept.
 */
export async function setUpRoom(dealId: string, by: string, mode: "auto" | "empty", deps: SetupDeps = defaultSetupDeps()) {
  const before = await deps.store.getRoom(dealId);
  const room = before ?? (await deps.store.ensureRoom({ dealId, setUpBy: by, status: "open", autoAddNew: true }));
  const folders = await ensurePresetFolders(dealId, deps);
  const placed: VdrItem[] = [];
  if (mode === "auto") {
    const docs = (await deps.store.listDocuments(dealId)).filter((d) => isRoomMaterial(d));
    const items = await deps.store.listItems(dealId);
    const known = new Set(items.map((i) => i.documentId).filter(Boolean));
    const fresh = docs.filter((d) => !known.has(d.id));
    // Oldest first, so the index reads in the order the files arrived.
    fresh.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const plan = planAutoFile(fresh, folders);
    const all: Array<Pick<VdrItem, "folderId" | "position" | "removedAt">> = items.slice();
    const rows = [];
    for (const p of plan) {
      if (!p.folderId) continue;
      const doc = fresh.find((d) => d.id === p.documentId)!;
      const row = {
        dealId,
        folderId: p.folderId,
        documentId: doc.id,
        title: (doc.name || doc.originalName || "Document").slice(0, 200),
        position: nextPosition(all, p.folderId),
        addedBy: by === "demo-seed" ? "demo-seed" : "auto",
      };
      rows.push(row);
      all.push({ folderId: row.folderId, position: row.position, removedAt: null });
    }
    placed.push(...(await deps.store.insertItems(rows)));
  }
  const logs: InsertVdrActivity[] = [];
  if (!before) logs.push(logRow(dealId, "room_set_up", { actorKind: by === "demo-seed" ? "system" : "broker", actorId: by, detail: { mode, placed: placed.length } }));
  for (const it of placed) logs.push(logRow(dealId, "item_added", { itemId: it.id, folderId: it.folderId, detail: { addedBy: it.addedBy } }));
  await logVdrQuietly(deps.store, logs);
  for (const it of placed) deps.enqueue(it.id);
  return { room, folders, placed };
}

/**
 * Files one document into the room. `explicit` (the broker's "Put in the
 * room") places it even if it was taken out before; otherwise a document that
 * ever had an item (taken out, made private, replaced) is left alone.
 * Returns the live item, or null when it can't or shouldn't be placed.
 */
export async function fileDocumentIntoRoom(
  dealId: string,
  documentId: string,
  addedBy: "auto" | "broker" | "seller" | "demo-seed",
  opts: { explicit?: boolean; folderId?: string | null } = {},
  deps: SetupDeps = defaultSetupDeps(),
): Promise<VdrItem | null> {
  const room = await deps.store.getRoom(dealId);
  if (!room) return null;
  const doc = await deps.store.getDocument(documentId);
  if (!doc || doc.dealId !== dealId || !isRoomMaterial(doc)) return null;
  const rows = await deps.store.itemsForDocument(documentId);
  const live = rows.find((r) => !r.removedAt);
  if (live) return live;
  if (rows.length > 0 && !opts.explicit) return null;
  const folders = await ensurePresetFolders(dealId, deps);
  let folderId = opts.folderId && folders.some((f) => f.id === opts.folderId) ? opts.folderId : null;
  if (!folderId) {
    const key = presetFor(doc).key;
    folderId = folders.find((f) => f.presetKey === key)?.id ?? folders.find((f) => f.presetKey === "other")?.id ?? null;
  }
  if (!folderId) return null;
  const items = await deps.store.listItems(dealId);
  const inserted = await deps.store.insertItem({
    dealId,
    folderId,
    documentId,
    title: (doc.name || doc.originalName || "Document").slice(0, 200),
    position: nextPosition(items, folderId),
    addedBy,
  });
  const item = inserted ?? (await deps.store.itemsForDocument(documentId)).find((r) => !r.removedAt) ?? null;
  if (inserted) {
    await logVdrQuietly(deps.store, logRow(dealId, "item_added", { itemId: inserted.id, folderId, detail: { addedBy } }));
    deps.enqueue(inserted.id);
  }
  return item;
}

/**
 * ingestDocument's finally (INTEGRATION §2.17): a new room-material document
 * lands in its folder, unshared, when the room auto-adds. Never throws.
 */
export async function autoFileIfRoom(documentId: string, deps: SetupDeps = defaultSetupDeps()): Promise<VdrItem | null> {
  try {
    const doc = await deps.store.getDocument(documentId);
    if (!doc || !isRoomMaterial(doc)) return null;
    const room = await deps.store.getRoom(doc.dealId);
    if (!room || !room.autoAddNew) return null;
    // Only documents that arrived after the room was set up ("Start with empty folders" stays empty).
    if (new Date(doc.createdAt).getTime() < new Date(room.setUpAt).getTime() - 60_000) return null;
    if ((await deps.store.itemsForDocument(documentId)).length > 0) return null;
    return await fileDocumentIntoRoom(doc.dealId, documentId, doc.uploadedBy === "seller" ? "seller" : "auto", {}, deps);
  } catch (err: any) {
    console.warn(`[vdr] couldn't file document ${documentId} into the data room:`, err?.message ?? err);
    return null;
  }
}

/**
 * The seller replaced their checklist upload: the new version takes the old
 * one's place in the room, NOT shared. Call BEFORE the old row is deleted.
 */
export async function markReplacement(previousDocumentId: string, newDocumentId: string, deps: SetupDeps = defaultSetupDeps()): Promise<VdrItem | null> {
  try {
    const prev = (await deps.store.itemsForDocument(previousDocumentId)).find((r) => !r.removedAt);
    if (!prev) return null;
    const [prevDoc, doc] = await Promise.all([deps.store.getDocument(previousDocumentId), deps.store.getDocument(newDocumentId)]);
    if (!doc || doc.dealId !== prev.dealId || !isRoomMaterial(doc)) return null;
    // The broker's own title stays when they renamed it in the room.
    const title = prevDoc && prev.title !== prevDoc.name ? prev.title : (doc.name || doc.originalName || prev.title).slice(0, 200);
    let next = (await deps.store.itemsForDocument(newDocumentId)).find((r) => !r.removedAt) ?? null;
    if (next) {
      next = await deps.store.updateItem(next.id, { folderId: prev.folderId, position: prev.position, replacesItemId: prev.id, title });
    } else {
      next = await deps.store.insertItem({
        dealId: prev.dealId,
        folderId: prev.folderId,
        documentId: newDocumentId,
        title,
        position: prev.position,
        addedBy: "seller",
        replacesItemId: prev.id,
      });
      if (next) deps.enqueue(next.id);
    }
    if (!next) return null;
    await deps.store.updateItem(prev.id, { replacedByItemId: next.id });
    await logVdrQuietly(deps.store, logRow(prev.dealId, "new_version", { actorKind: "seller", itemId: next.id, folderId: prev.folderId, detail: { replaces: prev.id } }));
    return next;
  } catch (err: any) {
    console.warn(`[vdr] couldn't place the new version ${newDocumentId}:`, err?.message ?? err);
    return null;
  }
}

/** Who could open an item: a short summary for the log and the broker's To do. */
async function shareSummary(store: VdrStore, itemId: string) {
  const shares = await store.sharesForItem(itemId);
  const allow = shares.filter((s) => s.effect === "allow");
  return { shared: allow.length > 0, levels: allow.filter((s) => s.audience === "level").map((s) => s.accessLevel), buyers: allow.filter((s) => s.audience === "buyer").length };
}

/**
 * The document behind an item is gone (deleteDocumentAndProvenance's vdr
 * step, INTEGRATION §2.17, and the seller unlink route before its delete).
 * Never throws.
 */
export async function onSourceDeleted(doc: { id: string; dealId: string }, opts: { bySeller?: boolean } = {}, deps: SetupDeps = defaultSetupDeps()): Promise<number> {
  let n = 0;
  try {
    const live = (await deps.store.itemsForDocument(doc.id)).filter((r) => !r.removedAt);
    for (const it of live) {
      const was = await shareSummary(deps.store, it.id);
      const reason = opts.bySeller ? "seller_removed" : "source_deleted";
      const cleanCopy = it.cleanCopyPath;
      const replacedBy = it.replacedByItemId ?? null;
      await deps.store.updateItem(it.id, { removedAt: deps.now(), removedReason: reason, documentId: null, cleanCopyPath: null, cleanCopyName: null, cleanCopyMime: null, cleanCopyAt: null, prepared: null });
      await removeCleanCopy(cleanCopy, it.dealId);
      await removeItemCache(it.dealId, it.id);
      await deps.store.deletePageText(it.id);
      await logVdrQuietly(deps.store, logRow(it.dealId, "item_tombstoned", { actorKind: opts.bySeller ? "seller" : "system", itemId: it.id, folderId: it.folderId, detail: { reason, replacedBy, title: it.title, ...was } }));
      if (opts.bySeller && was.shared && !replacedBy) {
        await logVdrQuietly(deps.store, logRow(it.dealId, "seller_removed_shared", { actorKind: "seller", itemId: it.id, folderId: it.folderId, detail: { title: it.title, ...was } }));
      }
      n++;
    }
  } catch (err: any) {
    console.warn(`[vdr] couldn't take deleted source ${doc.id} out of the data room:`, err?.message ?? err);
  }
  return n;
}

/** The source became broker-only (Information tab): out of the room at once, shares dropped. Never throws. */
export async function onSourceMadePrivate(documentId: string, deps: SetupDeps = defaultSetupDeps()): Promise<number> {
  let n = 0;
  try {
    const live = (await deps.store.itemsForDocument(documentId)).filter((r) => !r.removedAt);
    for (const it of live) {
      const was = await shareSummary(deps.store, it.id);
      // Its prepared pages and text go (a private file is not kept searchable); restoring prepares it again.
      await deps.store.updateItem(it.id, { removedAt: deps.now(), removedReason: "made_private", prepared: null });
      await deps.store.deleteSharesForItem(it.id);
      await removeItemCache(it.dealId, it.id);
      await deps.store.deletePageText(it.id);
      await logVdrQuietly(deps.store, logRow(it.dealId, "item_tombstoned", { actorKind: "broker", itemId: it.id, folderId: it.folderId, detail: { reason: "made_private", title: it.title, ...was } }));
      n++;
    }
  } catch (err: any) {
    console.warn(`[vdr] couldn't take private source ${documentId} out of the data room:`, err?.message ?? err);
  }
  return n;
}

/** restampSourceVisibility's vdr step (INTEGRATION §2.17). Shared again → nothing automatic ("Put it back"). */
export async function onSourceVisibilityChanged(documentId: string, brokerOnly: boolean, deps: SetupDeps = defaultSetupDeps()): Promise<void> {
  if (brokerOnly) await onSourceMadePrivate(documentId, deps);
}

/** gl calls this on every ledger status change: the item is re-prepared (its forFile includes the status). */
export async function onLedgerStatusChanged(documentId: string, deps: SetupDeps = defaultSetupDeps()): Promise<void> {
  try {
    const live = (await deps.store.itemsForDocument(documentId)).filter((r) => !r.removedAt);
    for (const it of live) {
      await deps.store.deletePageText(it.id);
      deps.enqueue(it.id);
    }
  } catch (err: any) {
    console.warn(`[vdr] ledger status change for ${documentId} failed:`, err?.message ?? err);
  }
}

/** "Put it back": a `made_private` tombstone returns, unshared, once its document is shared again. */
export async function restoreItem(itemId: string, by: string, deps: SetupDeps = defaultSetupDeps()): Promise<{ ok: true; item: VdrItem } | { ok: false; reason: string }> {
  const it = await deps.store.getItem(itemId);
  if (!it || !it.removedAt) return { ok: false, reason: "It's already in the room." };
  if (it.removedReason !== "made_private" && it.removedReason !== "broker") return { ok: false, reason: "The file behind it was deleted. Upload it again." };
  if (!it.documentId) return { ok: false, reason: "The file behind it was deleted. Upload it again." };
  const doc = await deps.store.getDocument(it.documentId);
  if (!doc || !isRoomMaterial(doc)) return { ok: false, reason: doc?.visibility === "broker_only" ? "It's still marked broker-only. Share it on the Information tab first." : "It can't go in the data room." };
  const live = (await deps.store.itemsForDocument(it.documentId)).find((r) => !r.removedAt);
  if (live) return { ok: false, reason: "It's already in the room." };
  const items = await deps.store.listItems(it.dealId);
  const back = await deps.store.updateItem(it.id, { removedAt: null, removedReason: null, position: nextPosition(items, it.folderId), prepared: null });
  if (!back) return { ok: false, reason: "It can't go in the data room." };
  await logVdrQuietly(deps.store, logRow(it.dealId, "item_restored", { actorKind: "broker", actorId: by, itemId: it.id, folderId: it.folderId }));
  deps.enqueue(it.id);
  return { ok: true, item: back };
}

/** "Share with the same people": the replaced item's grants, copied onto the new version. */
export async function shareLikeReplaced(itemId: string, by: string, deps: SetupDeps = defaultSetupDeps()): Promise<{ copied: number }> {
  const it = await deps.store.getItem(itemId);
  if (!it || it.removedAt || !it.replacesItemId) return { copied: 0 };
  const old = await deps.store.sharesForItem(it.replacesItemId);
  const doc = it.documentId ? await deps.store.getDocument(it.documentId) : null;
  const ledger = !!doc && (isLedgerDoc(doc) || isGlDocument(doc));
  const rows = old
    .filter((s) => !(ledger && s.audience === "level" && s.accessLevel !== DD_ACCESS_LEVEL))
    .map((s) => ({ dealId: it.dealId, itemId: it.id, audience: s.audience, accessLevel: s.accessLevel, buyerEmail: s.buyerEmail, viaAccessId: s.viaAccessId, effect: s.effect, createdBy: by }));
  await deps.store.insertShares(rows);
  if (rows.length) await logVdrQuietly(deps.store, logRow(it.dealId, "shared", { actorKind: "broker", actorId: by, itemId: it.id, detail: { likeReplaced: it.replacesItemId, rows: rows.length } }));
  return { copied: rows.length };
}

/** The live item for a document, if it's in the room. */
export async function liveItemForDocument(documentId: string, store: VdrStore = dbVdrStore): Promise<VdrItem | null> {
  return (await store.itemsForDocument(documentId)).find((r) => !r.removedAt) ?? null;
}

export type { Document };
