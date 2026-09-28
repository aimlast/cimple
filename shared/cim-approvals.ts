/**
 * cim-approvals — when a CIM is approved, and what a change after approval
 * undoes. One rule for the server's publish gate and the Overview's
 * "Ready to publish" card.
 *
 * How brokers and sellers approve today: the broker ticks sections in the
 * CIM builder ("Approve section", "Approve all"), and on the Overview records
 * the broker's and the seller's approval of the content (phase 3) and of the
 * design (phase 4). Publishing needs both design approvals.
 *
 * The gap (smoke test 2026-09-27): regenerating one section after both
 * design approvals reset that section's tick but not the deal's approvals —
 * the Overview still said "Ready to publish · All approvals received" and
 * the server let AI content the seller never saw go live.
 *
 * The rule now:
 *  - The broker's design approval approves every section as it stands (the
 *    server ticks each shown section).
 *  - Any change to what a shown section says — an AI regenerate / rewrite /
 *    convert, the broker's own edit, a layout change, undo, a new or copied
 *    section, showing a hidden one — un-ticks that section and, on a CIM
 *    that isn't live yet, withdraws the deal's approvals: the design
 *    approvals always, the content approvals while the deal is still in
 *    Content Creation. Both approvals are then recorded again.
 *  - Publishing needs both design approvals AND every shown section ticked
 *    (so a CIM approved before this rule, with a section changed since, is
 *    held too). The Overview lists the sections that need approval.
 *
 * Pure — no server or browser dependencies.
 */
import { phaseIndex } from "./deal-progress";
import { isCimFallbackSection } from "./cim-layouts";

export type DealApprovalFlag =
  | "contentApprovedByBroker"
  | "contentApprovedBySeller"
  | "designApprovedByBroker"
  | "designApprovedBySeller";

export interface ApprovalDeal {
  isLive?: boolean | null;
  phase?: string | null;
  contentApprovedByBroker?: boolean | null;
  contentApprovedBySeller?: boolean | null;
  designApprovedByBroker?: boolean | null;
  designApprovedBySeller?: boolean | null;
}

export interface ApprovalSection {
  id: string;
  sectionTitle: string;
  isVisible?: boolean | null;
  brokerApproved?: boolean | null;
  aiLayoutReasoning?: string | null;
  contentHistory?: unknown;
}

export interface SectionAwaitingApproval {
  id: string;
  title: string;
  /** The latest change to it ("Regenerated with AI", "Edited"…), when one is on record. */
  lastChange?: string;
}

/**
 * The deal's approvals a change to a shown section withdraws (none on a live
 * CIM: its approvals are the record of what was published). Empty when
 * nothing is to be cleared.
 */
export function approvalsWithdrawnByChange(deal: ApprovalDeal): Partial<Record<DealApprovalFlag, false>> {
  if (deal.isLive) return {};
  const out: Partial<Record<DealApprovalFlag, false>> = {};
  if (deal.designApprovedByBroker) out.designApprovedByBroker = false;
  if (deal.designApprovedBySeller) out.designApprovedBySeller = false;
  // Content approvals belong to Content Creation; once the deal has moved to
  // Design the design approvals are the ones that cover the CIM.
  if (phaseIndex(deal.phase) < phaseIndex("phase4_design_finalization")) {
    if (deal.contentApprovedByBroker) out.contentApprovedByBroker = false;
    if (deal.contentApprovedBySeller) out.contentApprovedBySeller = false;
  }
  return out;
}

/** JSON with object keys sorted (stored jsonb comes back in its own key order). */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The section fields whose change is a change to what the section says. */
export const SECTION_CONTENT_FIELDS = ["sectionTitle", "brokerEditedContent", "layoutData", "layoutType"] as const;

/**
 * Does this edit to a section need the section approved again? A change to
 * what it says, or showing a section that was hidden (its content was never
 * part of what was approved). Visibility off, access tier, the approval tick
 * itself and dismissed figure flags don't.
 */
export function editNeedsReapproval(
  before: { isVisible?: boolean | null } & Partial<Record<(typeof SECTION_CONTENT_FIELDS)[number], unknown>>,
  set: Record<string, unknown>,
): boolean {
  const same = (a: unknown, b: unknown) => stableJson(a ?? null) === stableJson(b ?? null);
  // Re-saving what is already there (the builder sends the whole section) isn't a change.
  if (SECTION_CONTENT_FIELDS.some((k) => k in set && !same(set[k], before[k]))) return true;
  return set.isVisible === true && before.isVisible === false;
}

/** Shown, written sections the broker hasn't approved as they stand now. */
export function sectionsAwaitingApproval(sections: readonly ApprovalSection[]): SectionAwaitingApproval[] {
  return sections
    .filter((s) => s.isVisible !== false && !s.brokerApproved && !isCimFallbackSection(s))
    .map((s) => {
      const history = Array.isArray(s.contentHistory) ? (s.contentHistory as Array<{ reason?: unknown }>) : [];
      const last = history[history.length - 1];
      return {
        id: s.id,
        title: s.sectionTitle,
        ...(typeof last?.reason === "string" && last.reason ? { lastChange: last.reason } : {}),
      };
    });
}

/** Sections the broker's design approval ticks: every shown, written section. */
export function sectionsApprovedWithDesign<T extends ApprovalSection>(sections: readonly T[]): T[] {
  return sections.filter((s) => s.isVisible !== false && !s.brokerApproved && !isCimFallbackSection(s));
}

export interface PublishReadiness {
  /** The broker's design approval covers the CIM as it stands. */
  brokerApproved: boolean;
  /** The seller's design approval is on record. */
  sellerApproved: boolean;
  /** Sections changed since approval (or never approved). */
  awaiting: SectionAwaitingApproval[];
  /** Both approvals, and every shown section approved. */
  ready: boolean;
}

/** Can this CIM be published? (Discrepancies and placeholders are gated separately.) */
export function publishReadiness(deal: ApprovalDeal, sections: readonly ApprovalSection[]): PublishReadiness {
  const awaiting = sectionsAwaitingApproval(sections);
  const brokerApproved = !!deal.designApprovedByBroker && awaiting.length === 0;
  const sellerApproved = !!deal.designApprovedBySeller;
  return { brokerApproved, sellerApproved, awaiting, ready: brokerApproved && sellerApproved };
}
