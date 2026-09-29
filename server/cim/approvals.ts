/**
 * approvals — keeps the deal's CIM approvals true to the CIM as it stands
 * (rules in shared/cim-approvals.ts).
 *
 *  - withdrawApprovalsAfterChange: called by every path that changes what a
 *    shown section says (AI regenerate / rewrite / convert / write, the
 *    broker's edit, layout change, undo, add, duplicate, unhide, a removed
 *    photo). The changed section's own tick is reset by the caller in the
 *    same write as the content.
 *  - approveSectionsWithDesign: the broker's design approval ticks every
 *    shown section.
 *  - sectionsBlockingPublish: the publish gate's section check.
 *  - backfillLegacyLiveApprovals: a live CIM approved before the per-section
 *    rule gets its untouched sections ticked on the broker's first read.
 *  - legacySectionInsert: the legacy "create a section" body, through the
 *    same rule as the builder's "Add section".
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { cimSections, type CimSection, type Deal, type InsertCimSection } from "@shared/schema";
import { CIM_ACCESS_TIERS, isCimLayoutKey } from "@shared/cim-layouts";
import { buyersReadWorkingCopy } from "@shared/cim-buyer-view";
import {
  APPROVAL_RULE_FLAG,
  PER_SECTION_APPROVAL_SINCE,
  approvalsWithdrawnByChange,
  legacyLiveApprovedIds,
  sectionsApprovedWithDesign,
  sectionsAwaitingApproval,
  type SectionAwaitingApproval,
} from "@shared/cim-approvals";

/**
 * A shown section's content changed: withdraw the deal's approvals that
 * covered the old content (not on a live CIM). Returns the flags cleared.
 * Never throws — an approval that couldn't be withdrawn is logged, and the
 * publish gate still holds the unticked section back.
 */
export async function withdrawApprovalsAfterChange(dealId: string): Promise<string[]> {
  try {
    const deal = await storage.getDeal(dealId);
    if (!deal) return [];
    const patch = approvalsWithdrawnByChange(deal);
    const cleared = Object.keys(patch);
    if (cleared.length > 0) await storage.updateDeal(dealId, patch);
    return cleared;
  } catch (err) {
    console.error(`[approvals] couldn't withdraw the approvals on deal ${dealId}:`, err);
    return [];
  }
}

/** The broker approved the design: every shown section is approved as it stands. */
export async function approveSectionsWithDesign(dealId: string): Promise<number> {
  const sections = await storage.getCimSectionsByDeal(dealId);
  const toTick = sectionsApprovedWithDesign(sections);
  for (const s of toTick) await storage.updateCimSection(s.id, { brokerApproved: true });
  return toTick.length;
}

/** jsonb containment test for a history carrying this code's mark (shared/cim-approvals). */
const APPROVAL_RULE_MARK_JSON = JSON.stringify([{ [APPROVAL_RULE_FLAG]: true }]);

/** Sections that still need the broker's approval before the CIM can go live (empty = none). */
export async function sectionsBlockingPublish(dealId: string): Promise<SectionAwaitingApproval[]> {
  const [deal, sections] = await Promise.all([storage.getDeal(dealId), storage.getCimSectionsByDeal(dealId)]);
  return sectionsAwaitingApproval(sections, deal);
}

/**
 * A CIM that was live before the per-section rule (legacyLiveApprovedIds —
 * whatever its design flags): tick its untouched sections so the Overview,
 * the builder and the deal list don't show a published CIM as unapproved.
 * One-off per deal in effect — once ticked they no longer qualify, and a
 * change after publishing is marked (or newer than the cutoff) so it still
 * needs approving. The UPDATE re-checks the rule in SQL (still unticked,
 * written before the cutoff, never marked by this code), so a change that
 * lands between the read and the write is never ticked. The write leaves
 * updatedAt alone (it is the deal list's "last activity" and the rule's own
 * test). Returns the sections as they now stand. Never throws: on a failed
 * write the sections come back as read (the shared rule still counts them
 * as approved).
 */
export async function backfillLegacyLiveApprovals(deal: Pick<Deal, "id" | "isLive">): Promise<CimSection[]> {
  const sections = await storage.getCimSectionsByDeal(deal.id);
  const ids = legacyLiveApprovedIds(deal, sections);
  if (ids.length === 0) return sections;
  try {
    const rows = await db
      .update(cimSections)
      .set({ brokerApproved: true })
      .where(and(
        eq(cimSections.dealId, deal.id),
        inArray(cimSections.id, ids),
        sql`${cimSections.brokerApproved} is not true`,
        lt(cimSections.updatedAt, new Date(PER_SECTION_APPROVAL_SINCE)),
        sql`not (coalesce(${cimSections.contentHistory}, '[]'::jsonb) @> ${APPROVAL_RULE_MARK_JSON}::jsonb)`,
      ))
      .returning({ id: cimSections.id });
    const ticked = new Set(rows.map((r) => r.id));
    if (ticked.size > 0) console.log(`[approvals] live deal ${deal.id}: ${ticked.size} section(s) approved before the per-section rule ticked`);
    return sections.map((s) => (ticked.has(s.id) ? { ...s, brokerApproved: true } : s));
  } catch (err) {
    console.error(`[approvals] couldn't tick the pre-rule sections of live deal ${deal.id}:`, err);
    return sections;
  }
}

/**
 * The legacy POST /api/deals/:dealId/sections body as a new section, by the
 * same rule as the builder's "Add section": never approved on arrival (the
 * body can't set brokerApproved / sellerApproved), held back from blind
 * buyers until redacted, hidden on a live CIM until the broker shows it, and
 * none of the server-owned columns (blind title, AI task, history, figure
 * warnings, DD state, order, deal) from the body. The caller inserts it with
 * insertSectionAt and withdraws the approvals it voids.
 */
export function legacySectionInsert(
  body: unknown,
  deal: Pick<Deal, "isLive" | "cimGeneration">,
): { ok: true; fields: Omit<InsertCimSection, "dealId" | "order" | "sectionKey"> & { sectionKey?: string } } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const title = typeof b.sectionTitle === "string" ? b.sectionTitle.replace(/\s+/g, " ").trim() : "";
  if (!title || title.length > 200) return { ok: false, error: "Give the section a title (up to 200 characters)" };
  const layoutType = b.layoutType === undefined ? "prose_highlight" : b.layoutType;
  if (!isCimLayoutKey(layoutType)) return { ok: false, error: "Unknown layout type" };
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const tier = (CIM_ACCESS_TIERS as readonly string[]).includes(b.accessTier as string) ? (b.accessTier as string) : "teaser";
  return {
    ok: true,
    fields: {
      ...(typeof b.sectionKey === "string" && b.sectionKey.trim() ? { sectionKey: b.sectionKey.trim().slice(0, 80) } : {}),
      sectionTitle: title,
      layoutType,
      layoutData: (b.layoutData && typeof b.layoutData === "object" ? b.layoutData : null) as InsertCimSection["layoutData"],
      aiLayoutReasoning: "Added by the broker.",
      tags: (Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === "string") : []) as InsertCimSection["tags"],
      aiDraftContent: text(b.aiDraftContent),
      brokerEditedContent: text(b.brokerEditedContent),
      brokerApproved: false,
      sellerApproved: false,
      // A live CIM doesn't show a section nobody has approved (buyers
      // reading the kept copy of an update under review don't see the draft).
      isVisible: buyersReadWorkingCopy(deal) ? false : b.isVisible !== false,
      accessTier: tier,
      blindStaleAt: new Date(),
    },
  };
}

/** The 409 body for a publish held back by sections awaiting approval. */
export function sectionsNeedApprovalResponse(awaiting: SectionAwaitingApproval[]) {
  const names = awaiting.slice(0, 3).map((s) => `"${s.title}"`).join(", ");
  const more = awaiting.length > 3 ? ` and ${awaiting.length - 3} more` : "";
  return {
    error: `${awaiting.length === 1 ? "One section hasn't" : `${awaiting.length} sections haven't`} been approved as ${awaiting.length === 1 ? "it stands" : "they stand"} (${names}${more}). Approve ${awaiting.length === 1 ? "it" : "them"} in the CIM builder, or approve the design again, before publishing.`,
    code: "sections_need_approval",
    sections: awaiting,
  };
}
