/**
 * published-versions — records the version of each section a buyer of a
 * live CIM keeps getting until the broker approves a change (the rule is in
 * shared/cim-published.ts).
 *
 *  - recordPublishedVersions: the section was approved (the broker's tick,
 *    "Approve all", the design approval, the pre-rule backfill) — record it
 *    as it stands, with its Blind and DD versions when those are up to date.
 *  - recordPublishedBlind / recordPublishedDd: a Blind or DD version was
 *    written for a section still approved as it stands — record it too.
 *  - keepPublishedBeforeChange: called by the change paths before they
 *    write, for a section approved before this record existed (a CIM live
 *    since before free round 2): its current version is recorded first, so
 *    the change never reaches its buyers unapproved.
 *  - dropPublishedVersions: a full regenerate replaces every section.
 *  - loadPublishedVersions: what the buyer paths pass to buildBuyerCim.
 *
 * Stored as cim_section_overrides rows under the "published*" modes — no
 * schema change; a deleted section's rows go with its other overrides.
 * Never throws: a record that couldn't be written is logged (the section
 * then isn't served to buyers of a live CIM until approved again — safe).
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { cimSections, cimSectionOverrides, type CimSection, type CimSectionOverride } from "@shared/schema";
import { isCimFallbackSection } from "@shared/cim-layouts";
import { legacyLiveApprovedIds } from "@shared/cim-approvals";
import {
  PUBLISHED_BLIND_MODE,
  PUBLISHED_DD_MODE,
  PUBLISHED_MODE,
  PUBLISHED_MODES,
  publishedOverrideOf,
  publishedSectionOf,
} from "@shared/cim-published";

type Mode = (typeof PUBLISHED_MODES)[number];

async function upsert(section: Pick<CimSection, "id" | "dealId">, mode: Mode, layoutData: unknown): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(cimSectionOverrides).where(and(eq(cimSectionOverrides.cimSectionId, section.id), eq(cimSectionOverrides.mode, mode)));
    await tx.insert(cimSectionOverrides).values({ dealId: section.dealId, cimSectionId: section.id, mode, layoutData: layoutData as any, contentOverride: null });
  });
}

async function remove(sectionId: string, mode: Mode): Promise<void> {
  await db.delete(cimSectionOverrides).where(and(eq(cimSectionOverrides.cimSectionId, sectionId), eq(cimSectionOverrides.mode, mode)));
}

/** Record one section as approved now, from its row and its current Blind / DD override rows. */
async function recordOne(row: CimSection, blind: CimSectionOverride | undefined, dd: CimSectionOverride | undefined): Promise<void> {
  if (isCimFallbackSection(row)) return;
  const at = new Date();
  await upsert(row, PUBLISHED_MODE, publishedSectionOf(row, at));
  // A Blind / DD version that isn't up to date with this content is not the
  // approved one: none is recorded (the one written later is — see below).
  if (blind && !row.blindStaleAt) await upsert(row, PUBLISHED_BLIND_MODE, publishedOverrideOf(blind, row.blindTitle ?? null, at));
  else await remove(row.id, PUBLISHED_BLIND_MODE);
  if (dd && !row.ddStaleAt) await upsert(row, PUBLISHED_DD_MODE, publishedOverrideOf(dd, undefined, at));
  else await remove(row.id, PUBLISHED_DD_MODE);
}

async function rowsWithOverrides(sectionIds: string[]) {
  const [rows, overrides] = await Promise.all([
    db.select().from(cimSections).where(inArray(cimSections.id, sectionIds)),
    db.select().from(cimSectionOverrides).where(and(inArray(cimSectionOverrides.cimSectionId, sectionIds), inArray(cimSectionOverrides.mode, ["blind", "dd"]))),
  ]);
  const of = (id: string, mode: string) => overrides.find((o) => o.cimSectionId === id && o.mode === mode);
  return rows.map((row) => ({ row, blind: of(row.id, "blind"), dd: of(row.id, "dd") }));
}

/** These sections were just approved: record each as it stands (only those still approved). */
export async function recordPublishedVersions(sectionIds: string[]): Promise<void> {
  if (sectionIds.length === 0) return;
  try {
    for (const { row, blind, dd } of await rowsWithOverrides(sectionIds)) {
      if (!row.brokerApproved) continue;
      await recordOne(row, blind, dd);
    }
  } catch (err) {
    console.error("[published-versions] couldn't record the approved versions:", err);
  }
}

/** A Blind version was just committed for this section: record it when the section is approved as it stands. */
export async function recordPublishedBlind(section: Pick<CimSection, "id" | "dealId" | "brokerApproved">, override: Pick<CimSectionOverride, "layoutData" | "contentOverride">, blindTitle: string | null): Promise<void> {
  if (!section.brokerApproved) return;
  try {
    await upsert(section, PUBLISHED_BLIND_MODE, publishedOverrideOf(override, blindTitle));
  } catch (err) {
    console.error(`[published-versions] couldn't record the blind version of section ${section.id}:`, err);
  }
}

/** A Blind version was found to leak or was dropped for a redo: its record goes too (never served again). */
export async function dropPublishedBlind(sectionIds: string[]): Promise<void> {
  if (sectionIds.length === 0) return;
  try {
    await db.delete(cimSectionOverrides).where(and(inArray(cimSectionOverrides.cimSectionId, sectionIds), eq(cimSectionOverrides.mode, PUBLISHED_BLIND_MODE)));
  } catch (err) {
    console.error("[published-versions] couldn't drop blind records:", err);
  }
}

/** DD versions were just written for a deal: record them for the sections approved as they stand. */
export async function recordPublishedDd(dealId: string): Promise<void> {
  try {
    const rows = await db.select().from(cimSections).where(eq(cimSections.dealId, dealId));
    const approved = rows.filter((r) => r.brokerApproved && !r.ddStaleAt && !isCimFallbackSection(r));
    if (approved.length === 0) return;
    const dd = await db.select().from(cimSectionOverrides).where(and(eq(cimSectionOverrides.dealId, dealId), eq(cimSectionOverrides.mode, "dd")));
    for (const r of approved) {
      const o = dd.find((x) => x.cimSectionId === r.id);
      if (o) await upsert(r, PUBLISHED_DD_MODE, publishedOverrideOf(o));
    }
  } catch (err) {
    console.error(`[published-versions] couldn't record the DD versions of deal ${dealId}:`, err);
  }
}

/**
 * Before a change to a section of a live CIM: when it is approved as it
 * stands (ticked, or an untouched pre-rule section) and no approved version
 * is on record yet, record the current one — so the change reaches its
 * buyers only once approved. Call BEFORE the write (and before its blind
 * version is dropped).
 */
export async function keepPublishedBeforeChange(section: CimSection, deal: { isLive?: boolean | null } | null | undefined): Promise<void> {
  if (!deal?.isLive || section.isVisible === false) return;
  try {
    const approved = !!section.brokerApproved || legacyLiveApprovedIds(deal, [section]).length > 0;
    if (!approved) return;
    const existing = await db
      .select({ id: cimSectionOverrides.id })
      .from(cimSectionOverrides)
      .where(and(eq(cimSectionOverrides.cimSectionId, section.id), eq(cimSectionOverrides.mode, PUBLISHED_MODE)));
    if (existing.length > 0) return;
    const [current] = await rowsWithOverrides([section.id]);
    if (current) await recordOne(current.row, current.blind, current.dd);
  } catch (err) {
    console.error(`[published-versions] couldn't keep section ${section.id}'s published version:`, err);
  }
}

/** Every record of a deal (a full regenerate replaced its sections). */
export async function dropPublishedVersions(dealId: string): Promise<void> {
  for (const mode of PUBLISHED_MODES) await storage.deleteCimSectionOverrides(dealId, mode);
}

/** The records buyer paths pass to buildBuyerCim (only a live CIM uses them). */
export async function loadPublishedVersions(deal: { id: string; isLive?: boolean | null }): Promise<CimSectionOverride[]> {
  if (!deal.isLive) return [];
  return db.select().from(cimSectionOverrides).where(and(eq(cimSectionOverrides.dealId, deal.id), inArray(cimSectionOverrides.mode, [...PUBLISHED_MODES])));
}
