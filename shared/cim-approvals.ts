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
 *  - One rule everywhere: publishReadiness is built on deal-progress
 *    designApprovalState, which the checklist, the deal list and the
 *    dashboard's next step use with the same count of sections awaiting.
 *  - A CIM that was already live before this rule — whatever its design
 *    flags say (the demo's TrueNorth went live with neither flag) — counts
 *    its untouched sections as approved (legacyLiveApprovedIds); a change
 *    after publishing still needs approving. "Untouched" = written before
 *    PER_SECTION_APPROVAL_SINCE and never changed by this code: every write
 *    here that un-ticks a section marks its history (approvalRule).
 *  - On a live CIM the tick decides what buyers get: a changed section is
 *    served in its last approved version until approved again
 *    (shared/cim-published.ts) — the deal's approvals themselves stay.
 *  - A section still showing its blank layout's sample data ("Category A
 *    60 / B 40") is never approved as it stands (hasSampleData): the design
 *    approval doesn't tick it and publishing waits for it.
 *
 * Pure — no server or browser dependencies.
 */
import { designApprovalState, phaseIndex } from "./deal-progress";
import { hasSampleData, isCimFallbackSection } from "./cim-layouts";

export type DealApprovalFlag =
  | "contentApprovedByBroker"
  | "contentApprovedBySeller"
  | "designApprovedByBroker"
  | "designApprovedBySeller";

export interface ApprovalDeal {
  isLive?: boolean | null;
  /** The generation status: a live deal whose regenerated CIM waits for review edits a draft, not what buyers see. */
  cimGeneration?: unknown;
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
  /** Last write to the section (ISO string from the API, Date on the server). */
  updatedAt?: string | Date | null;
  /** For the sample-data check (hasSampleData); absent = not checked. */
  layoutType?: string | null;
  layoutData?: unknown;
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
  // (A live deal whose buyers read the previously published version while
  // its regenerated CIM waits for review: the approvals cover the draft.)
  const reviewingUpdate = !!(deal.cimGeneration as { buyerHold?: { servingPublished?: boolean } } | null | undefined)?.buyerHold?.servingPublished;
  if (deal.isLive && !reviewingUpdate) return {};
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

/**
 * The per-section rule's cutoff. It must not precede the deploy of this code
 * (a section of a live CIM written by the old code after the cutoff would
 * look unapproved), so it is set after the latest expected deploy; the gap
 * between the deploy and the cutoff is covered by the history mark below —
 * every write by this code that un-ticks a section marks it, and a marked
 * section is never "legacy".
 */
export const PER_SECTION_APPROVAL_SINCE = "2026-09-29T00:00:00.000Z";

/**
 * The mark this code leaves in a section's history (cim_sections.
 * content_history) whenever it un-ticks the section: on every undo snapshot
 * it pushes, and — where a change pushes none (showing a section, the
 * broker's own un-tick, an undo, a new section) — on the latest entry, or as
 * a marker entry with no content that the undo stack skips.
 */
export const APPROVAL_RULE_FLAG = "approvalRule" as const;

type HistoryEntry = { at?: unknown; reason?: unknown; marker?: unknown; approvalRule?: unknown };

/** A marker entry (no content): never an undo step, never "the latest change". */
export function isHistoryMarker(entry: unknown): boolean {
  return !!entry && typeof entry === "object" && (entry as HistoryEntry).marker === true;
}

/** The history's real versions (undo snapshots), without marker entries. */
export function historySnapshots<T = unknown>(contentHistory: unknown): T[] {
  return Array.isArray(contentHistory) ? (contentHistory.filter((e) => !isHistoryMarker(e)) as T[]) : [];
}

/** Has this code changed (un-ticked) the section? */
export function markedByApprovalRule(contentHistory: unknown): boolean {
  return Array.isArray(contentHistory) && contentHistory.some((e) => !!e && typeof e === "object" && (e as HistoryEntry)[APPROVAL_RULE_FLAG] === true);
}

/**
 * The history with this code's mark on it (unchanged when already marked):
 * the latest entry carries the flag, or — with no history — a marker entry.
 */
export function withApprovalRuleMark<T>(contentHistory: T[] | unknown, at: Date = new Date()): T[] {
  const history = Array.isArray(contentHistory) ? [...(contentHistory as T[])] : [];
  if (markedByApprovalRule(history)) return history;
  const last = history.length - 1;
  if (last >= 0 && history[last] && typeof history[last] === "object") {
    history[last] = { ...(history[last] as object), [APPROVAL_RULE_FLAG]: true } as T;
    return history;
  }
  return [...history, { at: at.toISOString(), reason: "", marker: true, [APPROVAL_RULE_FLAG]: true } as T];
}

const toMs = (v: unknown): number => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" && v) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
};

/**
 * Sections of a CIM that was already live before the per-section rule that
 * count as approved: the deal is live (whatever its design flags — a CIM
 * published before the rule was approved as a whole, or with no recorded
 * approval at all), and the section — shown, written, unticked — hasn't been
 * written to (updatedAt) or changed (a history entry) since the rule's
 * cutoff, and this code has never un-ticked it (no approvalRule mark). A
 * change after publishing is marked (or newer than the cutoff), so it still
 * needs approving; a section with no write time on record can't be proved
 * untouched and isn't included. The server ticks them on the broker's first
 * read of the sections (server/cim/approvals.ts backfillLegacyLiveApprovals).
 */
export function legacyLiveApprovedIds(deal: ApprovalDeal | null | undefined, sections: readonly ApprovalSection[]): string[] {
  if (!deal?.isLive) return [];
  const since = Date.parse(PER_SECTION_APPROVAL_SINCE);
  return sections
    .filter((s) => {
      if (s.isVisible === false || s.brokerApproved || isCimFallbackSection(s) || hasSampleData(s)) return false;
      const written = toMs(s.updatedAt);
      if (!Number.isFinite(written) || written >= since) return false;
      if (markedByApprovalRule(s.contentHistory)) return false;
      const history = Array.isArray(s.contentHistory) ? (s.contentHistory as HistoryEntry[]) : [];
      return !history.some((h) => toMs(h?.at) >= since);
    })
    .map((s) => s.id);
}

/**
 * Shown, written sections the broker hasn't approved as they stand now.
 * With the deal, a live CIM's sections from before the per-section rule
 * count as approved (legacyLiveApprovedIds).
 */
export function sectionsAwaitingApproval(sections: readonly ApprovalSection[], deal?: ApprovalDeal | null): SectionAwaitingApproval[] {
  const legacy = new Set(legacyLiveApprovedIds(deal, sections));
  return sections
    // A section still showing its blank layout's sample data ("Category A
    // 60 / B 40") is never approved as it stands, ticked or not.
    .filter((s) => s.isVisible !== false && !isCimFallbackSection(s) && ((!s.brokerApproved && !legacy.has(s.id)) || hasSampleData(s)))
    .map((s) => {
      if (hasSampleData(s)) return { id: s.id, title: s.sectionTitle, lastChange: "Still shows sample data" };
      const history = historySnapshots<{ reason?: unknown }>(s.contentHistory);
      const last = history[history.length - 1];
      return {
        id: s.id,
        title: s.sectionTitle,
        ...(typeof last?.reason === "string" && last.reason ? { lastChange: last.reason } : {}),
      };
    });
}

/** Sections the broker's design approval ticks: every shown, written section (never one still showing sample data). */
export function sectionsApprovedWithDesign<T extends ApprovalSection>(sections: readonly T[]): T[] {
  return sections.filter((s) => s.isVisible !== false && !s.brokerApproved && !isCimFallbackSection(s) && !hasSampleData(s));
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
  const awaiting = sectionsAwaitingApproval(sections, deal);
  // One rule with the checklist, the deal list and the dashboard (shared/deal-progress).
  return { ...designApprovalState(deal, awaiting.length), awaiting };
}
