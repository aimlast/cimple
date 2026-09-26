/**
 * section-ops — structural edits to a deal's CIM sections for the CIM builder:
 * ordering, insert, delete, duplicate, the undo stack, and the one PATCH
 * handler every section edit goes through.
 *
 * Invariants kept here:
 *   - A deal's sections are numbered 0..n-1 with no gaps or ties (generation
 *     writes 1-based, the old reorder wrote 0-based — they are renumbered on
 *     every structural change).
 *   - sectionKey is unique within a deal (duplicates broke regenerate,
 *     relatedSections, analytics and the legacy cimContent map).
 *   - Any change to what a section says goes through invalidateBlind(), so
 *     the Blind CIM never serves stale or un-redacted content.
 */
import type { Request, Response } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  cimSections,
  cimSectionOverrides,
  type CimSection,
  type CimSectionSnapshot,
  type InsertCimSection,
} from "@shared/schema";
import { CIM_ACCESS_TIERS, defaultLayoutData, isCimLayoutKey, sameLayoutFamily } from "@shared/cim-layouts";
import { getOwnedDeal } from "../broker-auth/routes";
import { invalidateBlind } from "./blind-sync";
import { uniqueSectionKey } from "./section-ops-keys";
import { isMediaLayout } from "@shared/cim-media";
import { cleanMediaLayoutForDeal } from "./media-store";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const HISTORY_LIMIT = 10;

export { uniqueSectionKey };

// ── Ordering ─────────────────────────────────────────────────────────────

async function orderedSections(tx: Tx | typeof db, dealId: string) {
  return tx
    .select({ id: cimSections.id, order: cimSections.order, sectionKey: cimSections.sectionKey })
    .from(cimSections)
    .where(eq(cimSections.dealId, dealId))
    .orderBy(asc(cimSections.order), asc(cimSections.createdAt));
}

/** Write order = index for every id whose stored order differs. */
async function renumber(tx: Tx, ids: string[], current: Map<string, number>) {
  for (let i = 0; i < ids.length; i++) {
    if (current.get(ids[i]) !== i) {
      await tx.update(cimSections).set({ order: i }).where(eq(cimSections.id, ids[i]));
    }
  }
}

/**
 * Reorder a deal's sections. `orderedIds` must all belong to the deal (else
 * nothing is written); sections it leaves out keep their relative order
 * after the listed ones. One transaction, 0-based.
 */
export async function reorderDealSections(
  dealId: string,
  orderedIds: unknown,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== "string" && typeof id !== "number")) {
    return { ok: false, status: 400, error: "orderedIds must be a list of section ids" };
  }
  const wanted = orderedIds.map(String);
  if (new Set(wanted).size !== wanted.length) {
    return { ok: false, status: 400, error: "A section appears twice in the new order" };
  }
  return db.transaction(async (tx) => {
    const rows = await orderedSections(tx, dealId);
    const mine = new Set(rows.map((r) => r.id));
    if (wanted.some((id) => !mine.has(id))) {
      return { ok: false as const, status: 400, error: "Every section must belong to this deal" };
    }
    const listed = new Set(wanted);
    const finalIds = [...wanted, ...rows.filter((r) => !listed.has(r.id)).map((r) => r.id)];
    await renumber(tx, finalIds, new Map(rows.map((r) => [r.id, r.order])));
    return { ok: true as const };
  });
}

/** Where a new section goes: after a given section, at the start, or at the end. */
export type InsertPosition = { afterSectionId?: string | null; atStart?: boolean };

/**
 * Insert a section at a position and renumber, in one transaction.
 * Throws "not_in_deal" when afterSectionId isn't one of the deal's sections.
 */
export async function insertSectionAt(
  dealId: string,
  fields: Omit<InsertCimSection, "dealId" | "order" | "sectionKey"> & { sectionKey?: string },
  position: InsertPosition,
): Promise<CimSection> {
  return db.transaction(async (tx) => {
    const rows = await orderedSections(tx, dealId);
    let index = rows.length;
    if (position.atStart) index = 0;
    else if (position.afterSectionId) {
      const at = rows.findIndex((r) => r.id === position.afterSectionId);
      if (at < 0) throw new Error("not_in_deal");
      index = at + 1;
    }
    const sectionKey = uniqueSectionKey(fields.sectionKey || fields.sectionTitle, rows.map((r) => r.sectionKey));
    const [created] = await tx
      .insert(cimSections)
      .values({ ...fields, dealId, sectionKey, order: index } as InsertCimSection)
      .returning();
    const ids = rows.map((r) => r.id);
    ids.splice(index, 0, created.id);
    await renumber(tx, ids, new Map([...rows.map((r) => [r.id, r.order] as const), [created.id, index]]));
    return { ...created, order: index };
  });
}

/** Delete a section, its overrides, and close the gap in the numbering. */
export async function deleteSection(section: CimSection): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(cimSectionOverrides).where(eq(cimSectionOverrides.cimSectionId, section.id));
    await tx.delete(cimSections).where(and(eq(cimSections.id, section.id), eq(cimSections.dealId, section.dealId)));
    const rows = await orderedSections(tx, section.dealId);
    await renumber(tx, rows.map((r) => r.id), new Map(rows.map((r) => [r.id, r.order])));
  });
}

/** Copy a section (fresh key, "(copy)" title) right after the original. */
export async function duplicateSection(section: CimSection, opts: { hidden: boolean }): Promise<CimSection> {
  const created = await insertSectionAt(
    section.dealId,
    {
      sectionTitle: `${section.sectionTitle} (copy)`.slice(0, 200),
      sectionKey: section.sectionKey,
      layoutType: section.layoutType,
      layoutData: section.layoutData as any,
      aiLayoutReasoning: section.aiLayoutReasoning,
      tags: section.tags as any,
      aiDraftContent: section.aiDraftContent,
      brokerEditedContent: section.brokerEditedContent,
      brokerApproved: false,
      isVisible: opts.hidden ? false : section.isVisible,
      layoutOverride: section.layoutOverride,
      accessTier: section.accessTier ?? "teaser",
      blindStaleAt: new Date(),
    },
    { afterSectionId: section.id },
  );
  return withStaleStamps(created, await invalidateBlind(section.dealId, [created.id]));
}

// ── Undo stack ───────────────────────────────────────────────────────────

export function snapshotOf(section: CimSection, reason: string): CimSectionSnapshot {
  return {
    at: new Date().toISOString(),
    reason,
    sectionTitle: section.sectionTitle,
    layoutType: section.layoutType,
    layoutData: section.layoutData ?? null,
    aiDraftContent: section.aiDraftContent ?? null,
    brokerEditedContent: section.brokerEditedContent ?? null,
  };
}

/** The section's history with the current version pushed (capped). */
export function historyWith(section: CimSection, reason: string): CimSectionSnapshot[] {
  const prev = Array.isArray(section.contentHistory) ? (section.contentHistory as CimSectionSnapshot[]) : [];
  return [...prev, snapshotOf(section, reason)].slice(-HISTORY_LIMIT);
}

/** Restore the most recent snapshot. Null when there is nothing to undo. */
export async function undoLastChange(section: CimSection): Promise<CimSection | null> {
  const history = Array.isArray(section.contentHistory) ? [...(section.contentHistory as CimSectionSnapshot[])] : [];
  const last = history.pop();
  if (!last) return null;
  const [updated] = await db
    .update(cimSections)
    .set({
      sectionTitle: last.sectionTitle,
      layoutType: last.layoutType,
      layoutData: last.layoutData as any,
      aiDraftContent: last.aiDraftContent,
      brokerEditedContent: last.brokerEditedContent,
      contentHistory: history,
      updatedAt: new Date(),
    })
    .where(eq(cimSections.id, section.id))
    .returning();
  const at = await invalidateBlind(section.dealId, [section.id]);
  return updated ? withStaleStamps(updated, at) : null;
}

/**
 * The row as stored once invalidateBlind has run: its blind and DD versions
 * are stale from `at`. The UPDATE's RETURNING row predates that stamp, so a
 * PATCH reported ddStaleAt: null while the builder showed "DD stale".
 */
export function withStaleStamps<T extends { blindStaleAt?: Date | null; ddStaleAt?: Date | null }>(row: T, at: Date): T {
  return { ...row, blindStaleAt: at, ddStaleAt: at };
}

/** The prose the renderer shows (broker edit → body → AI draft). */
export function displayedProse(section: Pick<CimSection, "layoutType" | "layoutData" | "brokerEditedContent" | "aiDraftContent">): string {
  const data = (section.layoutData as Record<string, unknown> | null) || {};
  if (section.brokerEditedContent) return section.brokerEditedContent;
  if (section.layoutType === "prose_highlight" && typeof data.body === "string" && data.body) return data.body;
  return section.aiDraftContent || "";
}

// ── The section PATCH (shared by every edit path) ─────────────────────────

/**
 * PATCH /api/cim-sections/:sectionId (and the legacy /api/sections/:id).
 * Whitelisted, validated fields only. Content changes push an undo snapshot
 * and invalidate the section's blind version; visibility, approval and
 * access tier don't touch content.
 */
export async function patchCimSection(req: Request, res: Response) {
  try {
    const sectionId = String(req.params.sectionId ?? req.params.id);
    const [section] = await db.select().from(cimSections).where(eq(cimSections.id, sectionId));
    if (!section || !(await getOwnedDeal(section.dealId, req.session.brokerId))) {
      return res.status(404).json({ error: "Section not found" });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const set: Partial<InsertCimSection> & Record<string, unknown> = {};
    const bad = (error: string) => res.status(400).json({ error });

    if (body.sectionTitle !== undefined) {
      const t = typeof body.sectionTitle === "string" ? body.sectionTitle.replace(/\s+/g, " ").trim() : "";
      if (!t) return bad("A section needs a title");
      if (t.length > 200) return bad("Keep the title under 200 characters");
      if (t !== section.sectionTitle) set.sectionTitle = t;
    }
    if (body.brokerEditedContent !== undefined) {
      if (body.brokerEditedContent !== null && typeof body.brokerEditedContent !== "string") return bad("Content must be text");
      const v = body.brokerEditedContent as string | null;
      if (v !== section.brokerEditedContent) set.brokerEditedContent = v && v.length > 0 ? v.slice(0, 50_000) : null;
    }
    if (body.layoutData !== undefined) {
      if (!body.layoutData || typeof body.layoutData !== "object" || Array.isArray(body.layoutData)) return bad("Section data must be an object");
      if (JSON.stringify(body.layoutData).length > 200_000) return bad("Section data is too large");
      set.layoutData = body.layoutData as any;
    }
    if (body.layoutType !== undefined && body.layoutType !== section.layoutType) {
      if (!isCimLayoutKey(body.layoutType)) return bad("Unknown layout type");
      set.layoutType = body.layoutType;
      // Keep the AI's original choice across repeated changes.
      set.layoutOverride = section.layoutOverride || section.layoutType;
      // Different data shape and no new data supplied → start the layout blank
      // (the old data stays in the undo stack) instead of feeding a renderer
      // data it can't draw.
      if (set.layoutData === undefined && !sameLayoutFamily(section.layoutType, body.layoutType)) {
        set.layoutData = defaultLayoutData(body.layoutType, { title: section.sectionTitle }) as any;
      }
    }
    if (body.layoutOverride !== undefined && set.layoutOverride === undefined) {
      if (body.layoutOverride !== null && typeof body.layoutOverride !== "string") return bad("Invalid layoutOverride");
      set.layoutOverride = body.layoutOverride as string | null;
    }
    if (body.isVisible !== undefined) {
      if (typeof body.isVisible !== "boolean") return bad("isVisible must be true or false");
      set.isVisible = body.isVisible;
    }
    // The designer historically sent `isApproved`; the column is brokerApproved.
    const approved = body.brokerApproved !== undefined ? body.brokerApproved : body.isApproved;
    if (approved !== undefined) {
      if (typeof approved !== "boolean") return bad("brokerApproved must be true or false");
      set.brokerApproved = approved;
    }
    // The broker checked the flagged figures and they're right.
    if (body.dismissFigureWarnings === true) set.figureWarnings = null;
    if (body.accessTier !== undefined) {
      if (!(CIM_ACCESS_TIERS as readonly unknown[]).includes(body.accessTier)) return bad("Access must be teaser or full");
      set.accessTier = body.accessTier as string;
    }

    // Photo / video / map sections: valid links only, and only this deal's
    // own uploads (shared/cim-media.ts rules).
    const effectiveType = (set.layoutType as string | undefined) ?? section.layoutType;
    if (set.layoutData !== undefined && isMediaLayout(effectiveType)) {
      set.layoutData = (await cleanMediaLayoutForDeal(effectiveType, set.layoutData, section.dealId)) as any;
    }

    const contentChanged = ["sectionTitle", "brokerEditedContent", "layoutData", "layoutType"].some((k) => k in set);
    if (Object.keys(set).length === 0) return res.json(section);
    if (contentChanged) {
      const reason = "layoutType" in set ? "Changed layout" : "sectionTitle" in set && Object.keys(set).length === 1 ? "Renamed" : "Edited";
      set.contentHistory = historyWith(section, reason);
      // The broker edited the content: the figure check's flags described
      // the AI's version, and the broker now owns what the section says.
      if ("layoutData" in set || "brokerEditedContent" in set || "layoutType" in set) set.figureWarnings = null;
    }
    const [updated] = await db
      .update(cimSections)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(cimSections.id, section.id))
      .returning();
    res.json(contentChanged ? withStaleStamps(updated, await invalidateBlind(section.dealId, [section.id])) : updated);
  } catch (err) {
    console.error("[cim-sections] update failed:", err);
    res.status(500).json({ error: "Failed to update section" });
  }
}

/** Sections by id, restricted to one deal (ids from elsewhere are dropped). */
export async function sectionsInDeal(dealId: string, ids: string[]): Promise<CimSection[]> {
  if (ids.length === 0) return [];
  return db.select().from(cimSections).where(and(eq(cimSections.dealId, dealId), inArray(cimSections.id, ids)));
}
