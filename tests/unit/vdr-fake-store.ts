/**
 * An in-memory VdrStore for the data room's unit tests (no database). It
 * mirrors the constraints the real tables enforce: one live item per
 * document (vdr_items_document_live_uq), one preset folder per deal
 * (vdr_folders_deal_preset_uq), unique level / buyer share rows.
 */
import { randomUUID } from "node:crypto";
import { mergeViewCounters, type VdrStore } from "../../server/vdr/store";

export function fakeVdrStore(seed: { documents?: any[] } = {}) {
  const rooms = new Map<string, any>();
  const folders: any[] = [];
  const items: any[] = [];
  const shares: any[] = [];
  const pageText: any[] = [];
  const activity: any[] = [];
  const requests: any[] = [];
  const settings: any[] = [];
  const views: any[] = [];
  const team: any[] = [];
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
    async insertFolders(rows) {
      const out: any[] = [];
      for (const r of rows) { const f = await store.insertFolder(r); if (f) out.push(f); }
      return out;
    },
    async insertItems(rows) {
      const out: any[] = [];
      for (const r of rows) { const it = await store.insertItem(r); if (it) out.push(it); }
      return out;
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
    async logMany(rows) { for (const row of rows) activity.push({ id: randomUUID(), at: now(), ...row }); },
    async getDocument(id) { return documents.find((d) => d.id === id) ?? null; },
    async listDocuments(dealId) { return documents.filter((d) => d.dealId === dealId); },
    async markRequestsReady(requirementId, documentId) {
      const out = requests.filter((r) => r.requirementId === requirementId && (r.status === "open" || r.status === "asked_seller"));
      for (const r of out) Object.assign(r, { status: "ready_to_share", readyDocumentId: documentId });
      return out;
    },
    async updateFolder(id, patch) {
      const f = folders.find((x) => x.id === id);
      if (!f) return null;
      Object.assign(f, structuredClone(patch), { updatedAt: now() });
      return f;
    },
    async deleteFolder(id) { const i = folders.findIndex((x) => x.id === id); if (i >= 0) folders.splice(i, 1); },
    async moveItems(moves) {
      for (const m of moves) { const it = items.find((i) => i.id === m.id); if (it) Object.assign(it, { folderId: m.folderId, position: m.position, updatedAt: now() }); }
    },
    async replaceShares(changes) {
      for (const c of changes) {
        for (let i = shares.length - 1; i >= 0; i--) if (shares[i].itemId === c.itemId) shares.splice(i, 1);
        await store.insertShares(c.rows);
      }
    },
    async listBuyerSettings(dealId) { return settings.filter((s) => s.dealId === dealId); },
    async upsertBuyerSettings(dealId, buyerEmail, patch) {
      let s = settings.find((x) => x.dealId === dealId && x.buyerEmail === buyerEmail);
      if (!s) { s = { id: randomUUID(), dealId, buyerEmail, roomAccess: "auto", allowDownloads: false, lastVisitAt: null, previousVisitAt: null, updatedBy: null, updatedAt: now() }; settings.push(s); }
      Object.assign(s, structuredClone(patch), { updatedAt: now() });
      return s;
    },
    async insertView(row) {
      const v = { id: randomUUID(), startedAt: now(), lastSeenAt: now(), activeMs: 0, pageMs: {}, maxPage: null, deviceClass: null, downloaded: false, teamMemberId: null, documentId: null, fileVersion: 1, source: null, ...row };
      views.push(v);
      return v;
    },
    async getView(id) { return views.find((v) => v.id === id) ?? null; },
    async mergeView(id, m) {
      const v = views.find((x) => x.id === id);
      if (!v) return null;
      Object.assign(v, mergeViewCounters(v, m));
      if (m.lastSeenAt.getTime() > new Date(v.lastSeenAt).getTime()) v.lastSeenAt = m.lastSeenAt;
      return v;
    },
    async markViewDownloaded(id) { const v = views.find((x) => x.id === id); if (v) v.downloaded = true; },
    async listViews(dealId) { return views.filter((v) => v.dealId === dealId); },
    async searchPageText(dealId, itemIds, q, limit) {
      const needle = q.toLowerCase();
      return pageText
        .filter((r) => r.dealId === dealId && itemIds.includes(r.itemId) && String(r.text).toLowerCase().includes(needle))
        .sort((a, b) => a.itemId.localeCompare(b.itemId) || a.page - b.page)
        .slice(0, limit)
        .map((r) => ({ itemId: r.itemId, page: r.page, label: r.label, text: r.text }));
    },
    async getPageText(itemId) { return pageText.filter((r) => r.itemId === itemId).sort((a, b) => a.page - b.page); },
    async listActivity(dealId, limit) { return activity.filter((a) => a.dealId === dealId).slice(-limit).reverse(); },
    async teamMemberByTokenHash(hash) { return team.find((t) => t.tokenHash === hash) ?? null; },
    async listTeamMembers(dealId) { return team.filter((t) => t.dealId === dealId); },
    async updateTeamMember(id, patch) { const t = team.find((x) => x.id === id); if (t) Object.assign(t, patch); },
    async getTeamMember(id) { return team.find((x) => x.id === id) ?? null; },
    async insertTeamMember(row) {
      // Mirrors vdr_team_members_deal_email_uq (deal, principal, email) and the token's partial unique.
      if (team.some((t) => t.dealId === row.dealId && t.principalEmail === row.principalEmail && t.email === row.email)) return null;
      if (row.tokenHash && team.some((t) => t.tokenHash === row.tokenHash)) return null;
      const r = { id: randomUUID(), status: "requested", tokenHash: null, ackAt: null, ackName: null, ackIpHash: null, lastVisitAt: null, previousVisitAt: null, linkSentAt: null, createdAt: now(), updatedAt: now(), ...row };
      team.push(r);
      return r;
    },
    async listRequests(dealId) { return requests.filter((r) => r.dealId === dealId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()); },
    async getRequest(id) { return requests.find((r) => r.id === id) ?? null; },
    async insertRequests(rows) {
      const out: any[] = [];
      for (const r of rows) {
        const row = { id: randomUUID(), teamMemberId: null, listId: null, itemId: null, documentId: null, status: "open", requirementId: null, readyDocumentId: null, brokerNote: null, resolvedAt: null, resolvedBy: null, createdAt: now(), ...r };
        requests.push(row);
        out.push(row);
      }
      return out;
    },
    async updateRequest(id, patch) { const r = requests.find((x) => x.id === id); if (!r) return null; Object.assign(r, structuredClone(patch)); return r; },
    async listActivityByActions(dealId, actions) { return activity.filter((a) => a.dealId === dealId && actions.includes(a.action)).slice().reverse(); },
    async itemsWithPendingSummaries(limit) {
      return items.filter((i) => !i.removedAt && i.documentId && i.buyerSummaryStatus === "pending").sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()).slice(0, limit);
    },
  };
  return { store, rooms, folders, items, shares, pageText, activity, requests, documents, settings, views, team };
}
