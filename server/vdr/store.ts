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
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  documents,
  vdrActivity,
  vdrFolders,
  vdrItems,
  vdrPageText,
  vdrRequests,
  vdrRooms,
  vdrShares,
  type Document,
  type InsertVdrActivity,
  type InsertVdrFolder,
  type InsertVdrItem,
  type InsertVdrRoom,
  type InsertVdrShare,
  type VdrFolder,
  type VdrItem,
  type VdrRequest,
  type VdrRoom,
  type VdrShare,
} from "@shared/schema";

export interface VdrStore {
  getRoom(dealId: string): Promise<VdrRoom | null>;
  /** Creates the room row (no-op when it exists) and returns it. */
  ensureRoom(row: InsertVdrRoom): Promise<VdrRoom>;
  updateRoom(dealId: string, patch: Partial<InsertVdrRoom>): Promise<void>;

  listFolders(dealId: string): Promise<VdrFolder[]>;
  insertFolder(row: InsertVdrFolder): Promise<VdrFolder | null>;

  listItems(dealId: string): Promise<VdrItem[]>;
  getItem(id: string): Promise<VdrItem | null>;
  /** Every item row (live or removed) that points at a document. */
  itemsForDocument(documentId: string): Promise<VdrItem[]>;
  /** null when a live item for the same document already exists. */
  insertItem(row: InsertVdrItem): Promise<VdrItem | null>;
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

  getDocument(id: string): Promise<Document | null>;
  listDocuments(dealId: string): Promise<Document[]>;

  /** Buyer requests waiting on this checklist row become "ready to share". */
  markRequestsReady(requirementId: string, documentId: string): Promise<VdrRequest[]>;
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
};

/** Logs without ever failing the caller (the log is best-effort; the action stands). */
export async function logVdrQuietly(store: VdrStore, row: InsertVdrActivity): Promise<void> {
  try {
    await store.log(row);
  } catch (err: any) {
    console.warn(`[vdr] couldn't log ${row.action} on ${row.dealId}:`, err?.message ?? err);
  }
}
