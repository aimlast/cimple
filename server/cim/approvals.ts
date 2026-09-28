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
 *  - publishBlock: the publish gate's section check.
 */
import { storage } from "../storage";
import {
  approvalsWithdrawnByChange,
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

/** Sections that still need the broker's approval before the CIM can go live (empty = none). */
export async function sectionsBlockingPublish(dealId: string): Promise<SectionAwaitingApproval[]> {
  return sectionsAwaitingApproval(await storage.getCimSectionsByDeal(dealId));
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
