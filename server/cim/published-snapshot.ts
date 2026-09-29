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
 *
 * The copy is what buyers were SERVED, not the raw rows: on a live CIM a
 * changed section is served in its last approved version, and a section
 * never approved not at all (shared/cim-published.ts, review round 2). The
 * copy applies that rule when it is taken (servedCopy: the named sections,
 * and the Blind and DD overrides that went with them), so it is served as it
 * stands — buyerCimRows returns `published: null` for it (the approved
 * versions on record by then belong to the draft).
 */
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { cimPublishedSnapshots, type CimSection, type CimSectionOverride, type Deal } from "@shared/schema";
import { cimModeForAccessLevel } from "@shared/cim-layouts";
import { servesPublishedSnapshot } from "@shared/cim-buyer-view";
import { PUBLISHED_MODES, servedVersions } from "@shared/cim-published";
import { loadPublishedVersions } from "./published-versions";

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
 * What buyers of a live CIM are served from these rows (shared/cim-published.ts):
 * one set of sections (the named version; a section with no approved Blind /
 * DD version of its own is marked stale for that version, so it stays held
 * back there) and the Blind and DD overrides that go with them. Pure.
 */
export function servedCopy(input: {
  deal: { id: string; isLive?: boolean | null };
  sections: CimSection[];
  blindOverrides: CimSectionOverride[];
  ddOverrides: CimSectionOverride[];
  published: CimSectionOverride[];
}): Pick<PublishedCim, "sections" | "blindOverrides" | "ddOverrides"> {
  const { deal, sections, blindOverrides, ddOverrides, published } = input;
  const named = servedVersions({ deal, mode: "normal", sections, overrides: [], published });
  const blind = servedVersions({ deal, mode: "blind", sections, overrides: blindOverrides, published });
  const dd = servedVersions({ deal, mode: "dd", sections, overrides: ddOverrides, published });
  const blindById = new Map(blind.sections.map((s) => [s.id, s]));
  const ddById = new Map(dd.sections.map((s) => [s.id, s]));
  const out = named.sections.map((s) => {
    const b = blindById.get(s.id);
    const d = ddById.get(s.id);
    return {
      ...s,
      ...(b ? { blindTitle: b.blindTitle, blindStaleAt: b.blindStaleAt } : {}),
      ...(d ? { ddStaleAt: d.ddStaleAt } : {}),
    };
  });
  const ids = new Set(out.map((s) => String(s.id)));
  return {
    sections: out,
    blindOverrides: blind.overrides.filter((o) => ids.has(String(o.cimSectionId))),
    ddOverrides: dd.overrides.filter((o) => ids.has(String(o.cimSectionId))),
  };
}

/**
 * Copy the deal's CIM as buyers are served it now (servedCopy). Replaces
 * any earlier copy. Throws on failure — the caller must not replace a live
 * CIM it couldn't keep for its buyers.
 */
export async function takePublishedSnapshot(deal: Pick<Deal, "id" | "blindCodename"> & { isLive?: boolean | null }): Promise<void> {
  const [sections, blindOverrides, ddOverrides, ...publishedByMode] = await Promise.all([
    storage.getCimSectionsByDeal(deal.id),
    storage.getCimSectionOverrides(deal.id, "blind"),
    storage.getCimSectionOverrides(deal.id, "dd"),
    ...PUBLISHED_MODES.map((m) => storage.getCimSectionOverrides(deal.id, m)),
  ]);
  // Only a live CIM is kept (generation-jobs.ts): its approval rule applies.
  const served = servedCopy({ deal: { id: deal.id, isLive: deal.isLive ?? true }, sections, blindOverrides, ddOverrides, published: publishedByMode.flat() });
  await store.save(deal.id, { ...served, blindCodename: deal.blindCodename ?? null });
}

/** The deal's kept copy, or null. */
export async function getPublishedSnapshot(dealId: string): Promise<PublishedCim | null> {
  return store.get(dealId);
}

/**
 * Take one section out of the kept copy (it stops reaching buyers now, the
 * draft is untouched) — for a section the broker can't leave in front of
 * buyers until the update is published, e.g. one still stating a staff
 * matter now held back. Returns false when there's no such section.
 */
export async function withdrawFromPublishedSnapshot(dealId: string, sectionId: string): Promise<boolean> {
  const snap = await store.get(dealId);
  if (!snap || !snap.sections.some((s) => String(s.id) === sectionId && s.isVisible !== false)) return false;
  await store.save(dealId, {
    sections: snap.sections.map((s) => (String(s.id) === sectionId ? { ...s, isVisible: false } : s)),
    blindOverrides: snap.blindOverrides,
    ddOverrides: snap.ddOverrides,
    blindCodename: snap.blindCodename,
  });
  return true;
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
  /**
   * A live CIM's approved versions, for buildBuyerCim (shared/cim-published.ts;
   * [] after a failed read = nothing unapproved is served). Null for the kept
   * copy: it already is what buyers were served.
   */
  published: CimSectionOverride[] | null;
}

/**
 * The rows a buyer's CIM is built from: the live sections and the overrides
 * for the buyer's version — or, while a regenerated CIM waits for the
 * broker (servesPublishedSnapshot), the kept copy's.
 */
export async function buyerCimRows(
  deal: { id: string; isLive?: boolean | null; cimGeneration?: unknown },
  accessLevel: string | null | undefined,
): Promise<BuyerCimRows> {
  const mode = cimModeForAccessLevel(accessLevel);
  if (servesPublishedSnapshot(deal)) {
    const snap = await getPublishedSnapshot(deal.id);
    if (!snap) return { sections: [], overrides: [], fromSnapshot: true, missing: true, published: null };
    return {
      sections: snap.sections,
      overrides: mode === "blind" ? snap.blindOverrides : mode === "dd" ? snap.ddOverrides : [],
      fromSnapshot: true,
      published: null,
    };
  }
  const [sections, overrides, published] = await Promise.all([
    storage.getCimSectionsByDeal(deal.id),
    mode === "normal" ? Promise.resolve([] as CimSectionOverride[]) : storage.getCimSectionOverrides(deal.id, mode),
    // A live CIM's changes wait for the broker's approval: the approved
    // versions are served meanwhile. On a failed read nothing unapproved is
    // served ([] = no records).
    loadPublishedVersions(deal).catch((): CimSectionOverride[] => []),
  ]);
  return { sections, overrides, fromSnapshot: false, published };
}

/**
 * The codename buyers know the deal by while they read the kept copy: the
 * one its Blind sections were redacted under (a codename changed during the
 * review applies with the update). Null when buyers read the live CIM.
 */
export async function servedBlindCodename(deal: { id: string; isLive?: boolean | null; cimGeneration?: unknown }): Promise<string | null> {
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
