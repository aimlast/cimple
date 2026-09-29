/**
 * published-snapshot — buyers keep the CIM they were given while the broker
 * reviews a regenerated one.
 *
 * Beacon (rebuild, 2026-09-28): regenerating a LIVE CIM took the deal off
 * live and held all 12 buyers — the due-diligence buyer included — on "This
 * CIM isn't available yet" until the broker re-approved and re-published.
 * Now, when a live CIM is about to be replaced (generation-jobs.ts
 * persistDocument), its sections and Blind / DD versions are copied here
 * first; the deal stays live, and every buyer path — the view room, the Q&A
 * chatbot, media, analytics — reads this copy (buyerCimRows) until the broker
 * approves and publishes the new CIM. Publishing deletes the copy
 * (releaseBuyerHold), and buyers get the new version.
 *
 * The copy goes through the same buyer rules as the live CIM
 * (shared/cim-buyer-view.ts buildBuyerCim): hidden and failed sections
 * never leave, tiers lock, Blind is served only where its redacted version
 * was current when the copy was taken and still passes the identity guard
 * (fail closed — a section the guard now rejects is held back, never
 * re-redacted from a draft buyers can't see), and the NDA gate runs first.
 */
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { cimPublishedSnapshots, type CimSection, type CimSectionOverride, type Deal } from "@shared/schema";
import { cimModeForAccessLevel } from "@shared/cim-layouts";
import { servesPublishedSnapshot } from "@shared/cim-buyer-view";

export interface PublishedCim {
  sections: CimSection[];
  blindOverrides: CimSectionOverride[];
  ddOverrides: CimSectionOverride[];
  blindCodename: string | null;
  takenAt: string;
}

/** Where the kept copies live (the database; tests swap in memory). */
export interface SnapshotStore {
  save(dealId: string, cim: Omit<PublishedCim, "takenAt">): Promise<void>;
  get(dealId: string): Promise<PublishedCim | null>;
  drop(dealId: string): Promise<void>;
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const dbStore: SnapshotStore = {
  async save(dealId, cim) {
    await db.transaction(async (tx) => {
      await tx.delete(cimPublishedSnapshots).where(eq(cimPublishedSnapshots.dealId, dealId));
      await tx.insert(cimPublishedSnapshots).values({
        dealId,
        sections: cim.sections as any,
        blindOverrides: cim.blindOverrides as any,
        ddOverrides: cim.ddOverrides as any,
        blindCodename: cim.blindCodename,
      });
    });
  },
  async get(dealId) {
    const [row] = await db
      .select()
      .from(cimPublishedSnapshots)
      .where(eq(cimPublishedSnapshots.dealId, dealId))
      .orderBy(desc(cimPublishedSnapshots.takenAt))
      .limit(1);
    if (!row) return null;
    return {
      sections: list<CimSection>(row.sections),
      blindOverrides: list<CimSectionOverride>(row.blindOverrides),
      ddOverrides: list<CimSectionOverride>(row.ddOverrides),
      blindCodename: row.blindCodename ?? null,
      takenAt: row.takenAt instanceof Date ? row.takenAt.toISOString() : String(row.takenAt),
    };
  },
  async drop(dealId) {
    await db.delete(cimPublishedSnapshots).where(eq(cimPublishedSnapshots.dealId, dealId));
  },
};

let store: SnapshotStore = dbStore;
/** Tests: keep copies in memory (null restores the database). */
export function _setSnapshotStoreForTests(s: SnapshotStore | null): void {
  store = s ?? dbStore;
}

/** An in-memory store (tests, offline replays). */
export function memorySnapshotStore(): SnapshotStore & { rows: Map<string, PublishedCim> } {
  const rows = new Map<string, PublishedCim>();
  return {
    rows,
    async save(dealId, cim) { rows.set(dealId, JSON.parse(JSON.stringify({ ...cim, takenAt: new Date().toISOString() }))); },
    async get(dealId) { return rows.get(dealId) ?? null; },
    async drop(dealId) { rows.delete(dealId); },
  };
}

/**
 * Copy the deal's CIM as buyers have it now. Replaces any earlier copy.
 * Throws on failure — the caller must not replace a live CIM it couldn't
 * keep for its buyers.
 */
export async function takePublishedSnapshot(deal: Pick<Deal, "id" | "blindCodename">): Promise<void> {
  const [sections, blindOverrides, ddOverrides] = await Promise.all([
    storage.getCimSectionsByDeal(deal.id),
    storage.getCimSectionOverrides(deal.id, "blind"),
    storage.getCimSectionOverrides(deal.id, "dd"),
  ]);
  await store.save(deal.id, { sections, blindOverrides, ddOverrides, blindCodename: deal.blindCodename ?? null });
}

/** The deal's kept copy, or null. */
export async function getPublishedSnapshot(dealId: string): Promise<PublishedCim | null> {
  return store.get(dealId);
}

/** The broker published the new CIM: the kept copy goes. */
export async function dropPublishedSnapshot(dealId: string): Promise<void> {
  await store.drop(dealId);
}

export interface BuyerCimRows {
  sections: CimSection[];
  overrides: CimSectionOverride[];
  /** The rows are the kept copy (never re-redact or refresh them — the draft is not what buyers see). */
  fromSnapshot: boolean;
  /** The deal is serving a kept copy that isn't there: serve nothing (fail closed). */
  missing?: boolean;
}

/**
 * The rows a buyer's CIM is built from: the live sections and the overrides
 * for the buyer's version — or, while a regenerated CIM waits for the
 * broker (servesPublishedSnapshot), the kept copy's.
 */
export async function buyerCimRows(
  deal: Pick<Deal, "id" | "isLive" | "cimGeneration">,
  accessLevel: string | null | undefined,
): Promise<BuyerCimRows> {
  const mode = cimModeForAccessLevel(accessLevel);
  if (servesPublishedSnapshot(deal)) {
    const snap = await getPublishedSnapshot(deal.id);
    if (!snap) return { sections: [], overrides: [], fromSnapshot: true, missing: true };
    return {
      sections: snap.sections,
      overrides: mode === "blind" ? snap.blindOverrides : mode === "dd" ? snap.ddOverrides : [],
      fromSnapshot: true,
    };
  }
  const [sections, overrides] = await Promise.all([
    storage.getCimSectionsByDeal(deal.id),
    mode === "normal" ? Promise.resolve([] as CimSectionOverride[]) : storage.getCimSectionOverrides(deal.id, mode),
  ]);
  return { sections, overrides, fromSnapshot: false };
}

/**
 * The codename buyers know the deal by while they read the kept copy: the
 * one its Blind sections were redacted under (a codename changed during the
 * review applies with the update). Null when buyers read the live CIM.
 */
export async function servedBlindCodename(deal: Pick<Deal, "id" | "isLive" | "cimGeneration">): Promise<string | null> {
  if (!servesPublishedSnapshot(deal)) return null;
  const snap = await getPublishedSnapshot(deal.id);
  return snap?.blindCodename || null;
}

/** Sections a buyer's analytics may name: the live ones and, while one is kept, the copy's. */
export async function buyerSectionsForAnalytics(deal: Pick<Deal, "id" | "isLive" | "cimGeneration">): Promise<Array<Pick<CimSection, "id" | "sectionKey">>> {
  const live = await storage.getCimSectionsByDeal(deal.id);
  if (!servesPublishedSnapshot(deal)) return live;
  const snap = await getPublishedSnapshot(deal.id);
  return [...live, ...(snap?.sections ?? [])];
}
