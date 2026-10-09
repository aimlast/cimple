/**
 * An in-memory VdrStore for the data room's unit tests (no database). It
 * mirrors the constraints the real tables enforce: one live item per
 * document (vdr_items_document_live_uq), one preset folder per deal
 * (vdr_folders_deal_preset_uq), unique level / buyer share rows.
 */
import { randomUUID } from "node:crypto";
import type { VdrStore } from "../../server/vdr/store";

export function fakeVdrStore(seed: { documents?: any[] } = {}) {
  const rooms = new Map<string, any>();
  const folders: any[] = [];
  const items: any[] = [];
  const shares: any[] = [];
  const pageText: any[] = [];
  const activity: any[] = [];
  const requests: any[] = [];
  const documents: any[] = (seed.documents ?? []).map((d) => ({ createdAt: new Date(), uploadedBy: "broker", sourceKind: "document", visibility: "shared", subcategory: null, ...d }));
  const now = () => new Date();

  const store: VdrStore = {
    async getRoom(dealId) { return rooms.get(dealId) ?? null; },
    async ensureRoom(row) {
      if (!rooms.has(row.dealId)) rooms.set(row.dealId, { status: "open", autoAddNew: true, planAppliedAt: null, setUpAt: now(), setUpBy: null, closedAt: null, summaryBudgetDay: null, summaryBudgetUsed: 0, updatedAt: now(), ...row });
      return rooms.get(row.dealId);
    },
    async updateRoom(dealId, patch) { const r = rooms.get(dealId); if (r) Object.assign(r, patch, { updatedAt: now() }); },
    async listFolders(dealId) { return folders.filter((f) => f.dealId === dealId).sort((a, b) => a.position - b.position); },
    async insertFolder(row) {
      if (row.presetKey && folders.some((f) => f.dealId === row.dealId && f.presetKey === row.presetKey)) return null;
      const f = { id: randomUUID(), parentId: null, position: 0, presetKey: null, shareHint: null, createdAt: now(), updatedAt: now(), ...row };
      folders.push(f);
      return f;
    },
    async listItems(dealId) { return items.filter((i) => i.dealId === dealId).sort((a, b) => a.position - b.position); },
    async getItem(id) { return items.find((i) => i.id === id) ?? null; },
    async itemsForDocument(documentId) { return items.filter((i) => i.documentId === documentId); },
    async insertItem(row) {
      if (row.documentId && items.some((i) => i.documentId === row.documentId && !i.removedAt)) return null;
      const it = {
        id: randomUUID(), position: 0, addedBy: "broker", addedAt: now(), downloadable: false, downloadOriginal: false,
        cleanCopyPath: null, cleanCopyMime: null, cleanCopyName: null, cleanCopyAt: null,
        buyerSummary: null, buyerSummaryPoints: null, buyerSummarySource: null, buyerSummaryStatus: null, buyerSummaryHidden: false, buyerSummaryAt: null,
        prepared: null, checkedAt: null, checkedBy: null, checkedFlags: null, checkedForFile: null, fileVersion: 1, fileChangedAt: null,
        removedAt: null, removedReason: null, replacedByItemId: null, replacesItemId: null, createdAt: now(), updatedAt: now(),
        ...row,
      };
      items.push(it);
      return it;
    },
    async updateItem(id, patch) {
      const it = items.find((i) => i.id === id);
      if (!it) return null;
      if (patch.documentId && patch.documentId !== it.documentId && items.some((i) => i.id !== id && i.documentId === patch.documentId && !i.removedAt)) throw new Error("unique violation vdr_items_document_live_uq");
      if (patch.removedAt === null && it.documentId && items.some((i) => i.id !== id && i.documentId === it.documentId && !i.removedAt)) throw new Error("unique violation vdr_items_document_live_uq");
      Object.assign(it, structuredClone(patch), { updatedAt: now() });
      return it;
    },
    async itemsNeedingPrepare(staleBefore) {
      return items.filter((i) => !i.removedAt && i.documentId && (!i.prepared || (i.prepared.status === "pending" && new Date(i.prepared.startedAt ?? 0) < staleBefore))).map((i) => ({ id: i.id }));
    },
    async sharesForItem(itemId) { return shares.filter((s) => s.itemId === itemId); },
    async listShares(dealId) { return shares.filter((s) => s.dealId === dealId); },
    async insertShares(rows) {
      for (const r of rows) {
        const dup = shares.some((s) => s.itemId === r.itemId && s.audience === r.audience && (r.audience === "level" ? s.accessLevel === r.accessLevel : s.buyerEmail === r.buyerEmail));
        if (!dup) shares.push({ id: randomUUID(), effect: "allow", createdAt: now(), ...r });
      }
    },
    async deleteSharesForItem(itemId) {
      let n = 0;
      for (let i = shares.length - 1; i >= 0; i--) if (shares[i].itemId === itemId) { shares.splice(i, 1); n++; }
      return n;
    },
    async replacePageText({ dealId, itemId, forFile, rows }) {
      for (let i = pageText.length - 1; i >= 0; i--) if (pageText[i].itemId === itemId) pageText.splice(i, 1);
      for (const r of rows) pageText.push({ id: randomUUID(), dealId, itemId, forFile, ...r });
    },
    async deletePageText(itemId) { for (let i = pageText.length - 1; i >= 0; i--) if (pageText[i].itemId === itemId) pageText.splice(i, 1); },
    async log(row) { activity.push({ id: randomUUID(), at: now(), ...row }); },
    async getDocument(id) { return documents.find((d) => d.id === id) ?? null; },
    async listDocuments(dealId) { return documents.filter((d) => d.dealId === dealId); },
    async markRequestsReady(requirementId, documentId) {
      const out = requests.filter((r) => r.requirementId === requirementId && (r.status === "open" || r.status === "asked_seller"));
      for (const r of out) Object.assign(r, { status: "ready_to_share", readyDocumentId: documentId });
      return out;
    },
  };
  return { store, rooms, folders, items, shares, pageText, activity, requests, documents };
}
