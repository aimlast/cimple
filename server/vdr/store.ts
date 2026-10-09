/**
 * Database access for the data room (vdr spec §9.1). Everything the room's
 * server code reads or writes goes through a VdrStore, so the hooks and the
 * prepare pipeline are unit-tested with an in-memory store
 * (tests/unit/vdr-hooks.test.ts) and run on Postgres in the app.
 *
 * Item inserts are ON CONFLICT DO NOTHING (one live item per document, the
 * partial unique index) followed by a re-read, so two uploads finishing at
 * once can't place a document twice.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  documents,
  vdrActivity,
  vdrBuyerSettings,
  vdrFolders,
  vdrItems,
  vdrPageText,
  vdrRequests,
  vdrRooms,
  vdrShares,
  vdrTeamMembers,
  vdrViews,
  type Document,
  type InsertVdrActivity,
  type InsertVdrBuyerSettings,
  type InsertVdrFolder,
  type InsertVdrItem,
  type InsertVdrRoom,
  type InsertVdrShare,
  type InsertVdrView,
  type VdrActivity,
  type VdrBuyerSettings,
  type VdrFolder,
  type VdrItem,
  type VdrPageText,
  type VdrRequest,
  type VdrRoom,
  type VdrShare,
  type VdrTeamMember,
  type VdrView,
} from "@shared/schema";

/** A merge into a view: the larger of each counter wins (GREATEST), never less. */
export type ViewMerge = { activeMs: number; pageMs: Record<string, number>; maxPage: number | null; lastSeenAt: Date };

/** The GREATEST merge of a view's counters (pure; the DB store and the fake share it). */
export function mergeViewCounters(
  prev: { activeMs: number; pageMs: Record<string, number> | null; maxPage: number | null },
  next: Omit<ViewMerge, "lastSeenAt">,
): { activeMs: number; pageMs: Record<string, number>; maxPage: number | null } {
  const pageMs: Record<string, number> = { ...(prev.pageMs ?? {}) };
  for (const [k, v] of Object.entries(next.pageMs)) pageMs[k] = Math.max(pageMs[k] ?? 0, v);
  const maxPage = prev.maxPage == null ? next.maxPage : next.maxPage == null ? prev.maxPage : Math.max(prev.maxPage, next.maxPage);
  return { activeMs: Math.max(prev.activeMs ?? 0, next.activeMs), pageMs, maxPage };
}

/** Escapes a search term for ILIKE (%, _ and \ are literal). */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface VdrStore {
  getRoom(dealId: string): Promise<VdrRoom | null>;
  /** Creates the room row (no-op when it exists) and returns it. */
  ensureRoom(row: InsertVdrRoom): Promise<VdrRoom>;
  updateRoom(dealId: string, patch: Partial<InsertVdrRoom>): Promise<void>;

  listFolders(dealId: string): Promise<VdrFolder[]>;
  insertFolder(row: InsertVdrFolder): Promise<VdrFolder | null>;
  /** Several folders in one statement (existing preset folders are skipped). */
  insertFolders(rows: InsertVdrFolder[]): Promise<VdrFolder[]>;

  listItems(dealId: string): Promise<VdrItem[]>;
  getItem(id: string): Promise<VdrItem | null>;
  /** Every item row (live or removed) that points at a document. */
  itemsForDocument(documentId: string): Promise<VdrItem[]>;
  /** null when a live item for the same document already exists. */
  insertItem(row: InsertVdrItem): Promise<VdrItem | null>;
  /** Several items in one statement; rows whose document already has a live item are skipped. */
  insertItems(rows: InsertVdrItem[]): Promise<VdrItem[]>;
  updateItem(id: string, patch: Partial<InsertVdrItem>): Promise<VdrItem | null>;
  /** Live items whose preparation hasn't started, or stalled before `staleBefore`. */
  itemsNeedingPrepare(staleBefore: Date): Promise<Array<{ id: string }>>;

  sharesForItem(itemId: string): Promise<VdrShare[]>;
  listShares(dealId: string): Promise<VdrShare[]>;
  insertShares(rows: InsertVdrShare[]): Promise<void>;
  deleteSharesForItem(itemId: string): Promise<number>;

  replacePageText(i: { dealId: string; itemId: string; forFile: string; rows: Array<{ page: number; label: string; text: string }> }): Promise<void>;
  deletePageText(itemId: string): Promise<void>;

  log(row: InsertVdrActivity): Promise<void>;
  logMany(rows: InsertVdrActivity[]): Promise<void>;

  getDocument(id: string): Promise<Document | null>;
  listDocuments(dealId: string): Promise<Document[]>;

  /** Buyer requests waiting on this checklist row become "ready to share". */
  markRequestsReady(requirementId: string, documentId: string): Promise<VdrRequest[]>;

  // ── Pass 2: the broker's tab and the buyer's room ──
  updateFolder(id: string, patch: Partial<InsertVdrFolder>): Promise<VdrFolder | null>;
  deleteFolder(id: string): Promise<void>;
  /** Several items moved / reordered in one transaction. */
  moveItems(moves: Array<{ id: string; folderId: string; position: number }>): Promise<void>;
  /** Replaces the grants of several items at once, atomically (one transaction). */
  replaceShares(changes: Array<{ itemId: string; rows: InsertVdrShare[] }>): Promise<void>;
  listBuyerSettings(dealId: string): Promise<VdrBuyerSettings[]>;
  upsertBuyerSettings(dealId: string, buyerEmail: string, patch: Partial<InsertVdrBuyerSettings>): Promise<VdrBuyerSettings>;
  insertView(row: InsertVdrView): Promise<VdrView>;
  getView(id: string): Promise<VdrView | null>;
  /** GREATEST merge of the view's counters (never lowers one). */
  mergeView(id: string, m: ViewMerge): Promise<VdrView | null>;
  markViewDownloaded(id: string): Promise<void>;
  listViews(dealId: string): Promise<VdrView[]>;
  /** Page text rows of these items that contain `q` (case-insensitive, literal). */
  searchPageText(dealId: string, itemIds: string[], q: string, limit: number): Promise<Array<Pick<VdrPageText, "itemId" | "page" | "label" | "text">>>;
  getPageText(itemId: string): Promise<VdrPageText[]>;
  listActivity(dealId: string, limit: number): Promise<VdrActivity[]>;
  teamMemberByTokenHash(hash: string): Promise<VdrTeamMember | null>;
  listTeamMembers(dealId: string): Promise<VdrTeamMember[]>;
  updateTeamMember(id: string, patch: Partial<VdrTeamMember>): Promise<void>;
}

async function getDb() {
  return (await import("../db")).db;
}

export const dbVdrStore: VdrStore = {
  async getRoom(dealId) {
    const db = await getDb();
    const [r] = await db.select().from(vdrRooms).where(eq(vdrRooms.dealId, dealId));
    return r ?? null;
  },
  async ensureRoom(row) {
    const db = await getDb();
    await db.insert(vdrRooms).values(row).onConflictDoNothing();
    const [r] = await db.select().from(vdrRooms).where(eq(vdrRooms.dealId, row.dealId));
    return r;
  },
  async updateRoom(dealId, patch) {
    const db = await getDb();
    await db.update(vdrRooms).set({ ...patch, updatedAt: new Date() }).where(eq(vdrRooms.dealId, dealId));
  },

  async listFolders(dealId) {
    const db = await getDb();
    return db.select().from(vdrFolders).where(eq(vdrFolders.dealId, dealId)).orderBy(asc(vdrFolders.position));
  },
  async insertFolder(row) {
    const db = await getDb();
    const [r] = await db.insert(vdrFolders).values(row).onConflictDoNothing().returning();
    return r ?? null;
  },
  async insertFolders(rows) {
    if (rows.length === 0) return [];
    const db = await getDb();
    return db.insert(vdrFolders).values(rows).onConflictDoNothing().returning();
  },

  async listItems(dealId) {
    const db = await getDb();
    return db.select().from(vdrItems).where(eq(vdrItems.dealId, dealId)).orderBy(asc(vdrItems.position));
  },
  async getItem(id) {
    const db = await getDb();
    const [r] = await db.select().from(vdrItems).where(eq(vdrItems.id, id));
    return r ?? null;
  },
  async itemsForDocument(documentId) {
    const db = await getDb();
    return db.select().from(vdrItems).where(eq(vdrItems.documentId, documentId));
  },
  async insertItem(row) {
    const db = await getDb();
    const [r] = await db.insert(vdrItems).values(row).onConflictDoNothing().returning();
    return r ?? null;
  },
  async insertItems(rows) {
    if (rows.length === 0) return [];
    const db = await getDb();
    return db.insert(vdrItems).values(rows).onConflictDoNothing().returning();
  },
  async updateItem(id, patch) {
    const db = await getDb();
    const [r] = await db.update(vdrItems).set({ ...patch, updatedAt: new Date() }).where(eq(vdrItems.id, id)).returning();
    return r ?? null;
  },
  async itemsNeedingPrepare(staleBefore) {
    const db = await getDb();
    return db
      .select({ id: vdrItems.id })
      .from(vdrItems)
      .where(and(
        isNull(vdrItems.removedAt),
        sql`${vdrItems.documentId} IS NOT NULL`,
        sql`(${vdrItems.prepared} IS NULL OR (${vdrItems.prepared}->>'status' = 'pending' AND COALESCE((${vdrItems.prepared}->>'startedAt')::timestamptz, 'epoch') < ${staleBefore.toISOString()}::timestamptz))`,
      ))
      .limit(500);
  },

  async sharesForItem(itemId) {
    const db = await getDb();
    return db.select().from(vdrShares).where(eq(vdrShares.itemId, itemId));
  },
  async listShares(dealId) {
    const db = await getDb();
    return db.select().from(vdrShares).where(eq(vdrShares.dealId, dealId));
  },
  async insertShares(rows) {
    if (rows.length === 0) return;
    const db = await getDb();
    await db.insert(vdrShares).values(rows).onConflictDoNothing();
  },
  async deleteSharesForItem(itemId) {
    const db = await getDb();
    const r = await db.delete(vdrShares).where(eq(vdrShares.itemId, itemId)).returning({ id: vdrShares.id });
    return r.length;
  },

  async replacePageText({ dealId, itemId, forFile, rows }) {
    const db = await getDb();
    await db.transaction(async (tx) => {
      await tx.delete(vdrPageText).where(eq(vdrPageText.itemId, itemId));
      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200).map((r) => ({ dealId, itemId, forFile, page: r.page, label: r.label.slice(0, 200), text: r.text }));
        if (batch.length) await tx.insert(vdrPageText).values(batch).onConflictDoNothing();
      }
    });
  },
  async deletePageText(itemId) {
    const db = await getDb();
    await db.delete(vdrPageText).where(eq(vdrPageText.itemId, itemId));
  },

  async log(row) {
    const db = await getDb();
    await db.insert(vdrActivity).values(row);
  },
  async logMany(rows) {
    if (rows.length === 0) return;
    const db = await getDb();
    await db.insert(vdrActivity).values(rows);
  },

  async getDocument(id) {
    const db = await getDb();
    const [r] = await db.select().from(documents).where(eq(documents.id, id));
    return r ?? null;
  },
  async listDocuments(dealId) {
    const db = await getDb();
    return db.select().from(documents).where(eq(documents.dealId, dealId));
  },

  async markRequestsReady(requirementId, documentId) {
    const db = await getDb();
    return db
      .update(vdrRequests)
      .set({ status: "ready_to_share", readyDocumentId: documentId })
      .where(and(eq(vdrRequests.requirementId, requirementId), inArray(vdrRequests.status, ["open", "asked_seller"])))
      .returning();
  },

  async updateFolder(id, patch) {
    const db = await getDb();
    const [r] = await db.update(vdrFolders).set({ ...patch, updatedAt: new Date() }).where(eq(vdrFolders.id, id)).returning();
    return r ?? null;
  },
  async deleteFolder(id) {
    const db = await getDb();
    await db.delete(vdrFolders).where(eq(vdrFolders.id, id));
  },
  async moveItems(moves) {
    if (moves.length === 0) return;
    const db = await getDb();
    await db.transaction(async (tx) => {
      for (const m of moves) await tx.update(vdrItems).set({ folderId: m.folderId, position: m.position, updatedAt: new Date() }).where(eq(vdrItems.id, m.id));
    });
  },
  async replaceShares(changes) {
    if (changes.length === 0) return;
    const db = await getDb();
    await db.transaction(async (tx) => {
      for (const c of changes) {
        await tx.delete(vdrShares).where(eq(vdrShares.itemId, c.itemId));
        if (c.rows.length) await tx.insert(vdrShares).values(c.rows).onConflictDoNothing();
      }
    });
  },
  async listBuyerSettings(dealId) {
    const db = await getDb();
    return db.select().from(vdrBuyerSettings).where(eq(vdrBuyerSettings.dealId, dealId));
  },
  async upsertBuyerSettings(dealId, buyerEmail, patch) {
    const db = await getDb();
    const set = { ...patch, updatedAt: new Date() };
    await db.insert(vdrBuyerSettings).values({ dealId, buyerEmail, ...patch }).onConflictDoUpdate({ target: [vdrBuyerSettings.dealId, vdrBuyerSettings.buyerEmail], set });
    const [r] = await db.select().from(vdrBuyerSettings).where(and(eq(vdrBuyerSettings.dealId, dealId), eq(vdrBuyerSettings.buyerEmail, buyerEmail)));
    return r;
  },
  async insertView(row) {
    const db = await getDb();
    const [r] = await db.insert(vdrViews).values(row).returning();
    return r;
  },
  async getView(id) {
    const db = await getDb();
    const [r] = await db.select().from(vdrViews).where(eq(vdrViews.id, id));
    return r ?? null;
  },
  async mergeView(id, m) {
    const db = await getDb();
    return db.transaction(async (tx) => {
      const [cur] = await tx.select().from(vdrViews).where(eq(vdrViews.id, id)).for("update");
      if (!cur) return null;
      const merged = mergeViewCounters({ activeMs: cur.activeMs, pageMs: (cur.pageMs as Record<string, number> | null) ?? {}, maxPage: cur.maxPage }, m);
      const lastSeenAt = m.lastSeenAt.getTime() > new Date(cur.lastSeenAt).getTime() ? m.lastSeenAt : cur.lastSeenAt;
      const [r] = await tx.update(vdrViews).set({ ...merged, lastSeenAt }).where(eq(vdrViews.id, id)).returning();
      return r ?? null;
    });
  },
  async markViewDownloaded(id) {
    const db = await getDb();
    await db.update(vdrViews).set({ downloaded: true }).where(eq(vdrViews.id, id));
  },
  async listViews(dealId) {
    const db = await getDb();
    return db.select().from(vdrViews).where(eq(vdrViews.dealId, dealId)).orderBy(desc(vdrViews.lastSeenAt)).limit(5000);
  },
  async searchPageText(dealId, itemIds, q, limit) {
    if (itemIds.length === 0) return [];
    const db = await getDb();
    const pattern = `%${escapeLike(q)}%`;
    return db
      .select({ itemId: vdrPageText.itemId, page: vdrPageText.page, label: vdrPageText.label, text: vdrPageText.text })
      .from(vdrPageText)
      .where(and(eq(vdrPageText.dealId, dealId), inArray(vdrPageText.itemId, itemIds), sql`${vdrPageText.text} ILIKE ${pattern} ESCAPE '\\'`))
      .orderBy(asc(vdrPageText.itemId), asc(vdrPageText.page))
      .limit(limit);
  },
  async getPageText(itemId) {
    const db = await getDb();
    return db.select().from(vdrPageText).where(eq(vdrPageText.itemId, itemId)).orderBy(asc(vdrPageText.page));
  },
  async listActivity(dealId, limit) {
    const db = await getDb();
    return db.select().from(vdrActivity).where(eq(vdrActivity.dealId, dealId)).orderBy(desc(vdrActivity.at)).limit(limit);
  },
  async teamMemberByTokenHash(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const db = await getDb();
    const [r] = await db.select().from(vdrTeamMembers).where(eq(vdrTeamMembers.tokenHash, hash));
    return r ?? null;
  },
  async listTeamMembers(dealId) {
    const db = await getDb();
    return db.select().from(vdrTeamMembers).where(eq(vdrTeamMembers.dealId, dealId));
  },
  async updateTeamMember(id, patch) {
    const db = await getDb();
    await db.update(vdrTeamMembers).set({ ...patch, updatedAt: new Date() }).where(eq(vdrTeamMembers.id, id));
  },
};

/** Logs without ever failing the caller (the log is best-effort; the action stands). */
export async function logVdrQuietly(store: VdrStore, row: InsertVdrActivity | InsertVdrActivity[]): Promise<void> {
  const rows = Array.isArray(row) ? row : [row];
  if (rows.length === 0) return;
  try {
    if (rows.length === 1) await store.log(rows[0]);
    else await store.logMany(rows);
  } catch (err: any) {
    console.warn(`[vdr] couldn't log ${rows[0].action} on ${rows[0].dealId}:`, err?.message ?? err);
  }
}
