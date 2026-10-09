/**
 * The broker's marks on coverage-board items (coverage_marks): "come back to
 * this later", a private note, "Seller will send it" on a document request,
 * "confirmed by you", and the system's "asked" / "not known" marks.
 *
 * One ACTIVE row per (deal, item, kind), kept in code under the deal's facts
 * lock (the same per-deal queue every fact writer uses). Clearing stamps
 * cleared_at; rows are never hard-deleted except with the deal.
 */
import { and, eq, isNull } from "drizzle-orm";
import { coverageMarks, type CoverageMarkRow } from "@shared/schema";
import type { CoverageMarkKind } from "@shared/coverage-board";
import { withDealFactsLock } from "../documents/facts-lock";

export const MARK_KINDS: readonly CoverageMarkKind[] = ["verify_later", "note", "asked", "not_known", "confirmed", "doc_promised"];
/** Kinds a broker sets directly from the board. */
export const BROKER_MARK_KINDS: readonly CoverageMarkKind[] = ["verify_later", "note", "doc_promised"];
export const MARK_NOTE_MAX = 1000;

export interface NewMark {
  dealId: string;
  itemId: string;
  kind: CoverageMarkKind;
  sectionKey?: string | null;
  note?: string | null;
  valueHash?: string | null;
  sittingId?: string | null;
  createdBy: string;
}

/** Storage seam (tests replace it with an in-memory one). */
export interface MarksStore {
  active(dealId: string): Promise<CoverageMarkRow[]>;
  insert(row: NewMark): Promise<CoverageMarkRow>;
  clear(dealId: string, itemId: string, kind: CoverageMarkKind): Promise<number>;
}

const dbStore: MarksStore = {
  async active(dealId) {
    const { db } = await import("../db");
    return db.select().from(coverageMarks).where(and(eq(coverageMarks.dealId, dealId), isNull(coverageMarks.clearedAt)));
  },
  async insert(row) {
    const { db } = await import("../db");
    const [created] = await db
      .insert(coverageMarks)
      .values({
        dealId: row.dealId,
        itemId: row.itemId,
        kind: row.kind,
        sectionKey: row.sectionKey ?? null,
        note: row.note ?? null,
        valueHash: row.valueHash ?? null,
        sittingId: row.sittingId ?? null,
        createdBy: row.createdBy,
      })
      .returning();
    return created;
  },
  async clear(dealId, itemId, kind) {
    const { db } = await import("../db");
    const rows = await db
      .update(coverageMarks)
      .set({ clearedAt: new Date() })
      .where(and(eq(coverageMarks.dealId, dealId), eq(coverageMarks.itemId, itemId), eq(coverageMarks.kind, kind), isNull(coverageMarks.clearedAt)))
      .returning({ id: coverageMarks.id });
    return rows.length;
  },
};

let store: MarksStore = dbStore;

export function _setMarksStoreForTests(s: MarksStore | null): void {
  store = s ?? dbStore;
}

export function marksStore(): MarksStore {
  return store;
}

/** Add or replace the deal's active mark of this kind on an item. */
export async function setMark(mark: NewMark): Promise<CoverageMarkRow> {
  const note = typeof mark.note === "string" ? mark.note.trim().slice(0, MARK_NOTE_MAX) : null;
  return withDealFactsLock(mark.dealId, async () => {
    await store.clear(mark.dealId, mark.itemId, mark.kind);
    return store.insert({ ...mark, note: note || null });
  });
}

/** Clear the deal's active mark of this kind on an item (no-op when none). */
export async function clearMark(dealId: string, itemId: string, kind: CoverageMarkKind): Promise<number> {
  return withDealFactsLock(dealId, () => store.clear(dealId, itemId, kind));
}

export async function activeMarks(dealId: string): Promise<CoverageMarkRow[]> {
  return store.active(dealId);
}

/** Item ids the board accepts marks on: `section:key`, `doc:<requirementId>`, `routed:<discrepancyId>`. */
export const ITEM_ID_RE = /^(?:[a-z_]{2,40}:[A-Za-z][A-Za-z0-9_]{0,63}|doc:[A-Za-z0-9-]{1,64}|routed:[A-Za-z0-9-]{1,64})$/;
