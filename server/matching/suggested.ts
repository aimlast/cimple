/**
 * Suggested buyers for a deal — the first-pass (rule-based) score of every
 * buyer in the broker's contact list, shared by the Suggested buyers list and
 * the AI deep check so both always see the same candidates.
 */
import { isTeaserOnly } from "@shared/access-levels";
import { storage } from "../storage";
import { matchBuyerToDeal, type MatchBreakdown } from "./engine";
import { calculateQualifiedLeadScore } from "../scoring/buyer-score";
import { type BrokerBuyerContact, type BuyerUser, type Deal } from "@shared/schema";
import { mergedForBroker } from "../buyers/profile-view";
import { loadBrokerScope } from "../buyers/provenance-scope";

const DIMENSION_LABELS: Record<string, string> = {
  financialFit: "Financials",
  industryFit: "Industry",
  locationFit: "Location",
  operationalFit: "Operations",
  dealStructureFit: "Deal structure",
  qualificationFit: "Qualification",
};

export function topDimensions(bd: any): string[] {
  if (!bd) return [];
  const entries: Array<[string, number]> = [];
  for (const key of Object.keys(DIMENSION_LABELS)) {
    const cat = bd[key];
    if (cat && cat.max > 0) {
      const pct = (cat.score / cat.max) * 100;
      if (pct >= 60) entries.push([DIMENSION_LABELS[key], pct]);
    }
  }
  entries.sort((a, b) => b[1] - a[1]);
  return entries.slice(0, 3).map((e) => e[0]);
}

export interface ScoredBuyer {
  buyer: BuyerUser;                    // merged: broker's edits > buyer's own > broker's private CRM profile
  /** The liquid-funds figure is the buyer's own (promised to show as a range only) — AI prompts get the range. */
  fundsRange: string | null;
  contact: BrokerBuyerContact | null;
  lastActivityAt: Date | null;
  breakdown: MatchBreakdown | null;
  score: ReturnType<typeof calculateQualifiedLeadScore>;
}

export async function scoreBuyersForDeal(deal: Deal): Promise<ScoredBuyer[]> {
  const [list, scope] = await Promise.all([
    storage.getBrokerBuyerContactList(deal.brokerId!),
    loadBrokerScope(deal.brokerId!),
  ]);
  return Promise.all(list.map(async ({ buyerUser, contact, lastActivityAt }) => {
    const merged = mergedForBroker(buyerUser, contact, scope);
    const buyer = { ...merged.profile, hasProofOfFunds: !!merged.profile.hasProofOfFunds };
    const criteria: any = {
      ...((buyer.buyerCriteria as any) || {}),
      targetIndustries: buyer.targetIndustries || [],
      targetLocations: buyer.targetLocations || [],
    };
    let breakdown: MatchBreakdown | null = null;
    try {
      breakdown = await matchBuyerToDeal(
        criteria,
        {
          industry: deal.industry || "",
          subIndustry: (deal as any).subIndustry,
          askingPrice: (deal as any).askingPrice,
          description: (deal as any).description ?? null,
          extractedInfo: (deal as any).extractedInfo || {},
        },
        { skipAI: true },
      );
    } catch { /* unscorable profile */ }
    const score = calculateQualifiedLeadScore({ buyer, match: breakdown });
    return { buyer, fundsRange: merged.fundsMasked ? merged.display.liquidFunds : null, contact: contact ?? null, lastActivityAt, breakdown, score };
  }));
}

/**
 * Who has already been reached on this deal. An access grant links the
 * buyer's account only once they verify their email (before the NDA a row
 * can carry just the address), so both sides are matched on the account id
 * AND on the lower-cased email — a buyer who has access is never suggested
 * as if they didn't.
 */
export function reachedBuyers(
  outreach: Array<{ buyerUserId?: string | null; buyerEmail?: string | null }>,
  access: Array<{ buyerUserId?: string | null; buyerEmail?: string | null; accessLevel?: string | null }>,
  approvals: Array<{ buyerEmail?: string | null; status?: string | null }> = [],
): (buyer: { id: string; email?: string | null }) => { alreadyHasAccess: boolean; alreadyContacted: boolean; inApproval: boolean; teaserOnly: boolean } {
  const norm = (e?: string | null) => (e || "").trim().toLowerCase();
  const ids = (rows: typeof outreach) => new Set(rows.map((r) => r.buyerUserId).filter((x): x is string => !!x));
  const emails = (rows: typeof outreach) => new Set(rows.map((r) => norm(r.buyerEmail)).filter(Boolean));
  const accessIds = ids(access), accessEmails = emails(access);
  // A buyer whose only link here is a Teaser link has the summary, not the CIM ("Have the teaser").
  // (A row passed without its level is never counted as a teaser link.)
  const cimAccess = access.filter((a) => a.accessLevel == null || !isTeaserOnly(a.accessLevel));
  const cimIds = ids(cimAccess), cimEmails = emails(cimAccess);
  const contactedIds = ids(outreach), contactedEmails = emails(outreach);
  // Submitted for approval (waiting on the broker or the seller, approved, or
  // turned down): already in the pipeline, so never suggested again.
  const approvalEmails = new Set(approvals.filter((a) => a.status !== "withdrawn").map((a) => norm(a.buyerEmail)).filter(Boolean));
  return (buyer) => {
    const email = norm(buyer.email);
    const alreadyHasAccess = accessIds.has(buyer.id) || (!!email && accessEmails.has(email));
    return {
      alreadyHasAccess,
      alreadyContacted: contactedIds.has(buyer.id) || (!!email && contactedEmails.has(email)),
      inApproval: !!email && approvalEmails.has(email),
      teaserOnly: alreadyHasAccess && !(cimIds.has(buyer.id) || (!!email && cimEmails.has(email))),
    };
  };
}

/** The buyer rules out this deal's industry (never suggested, never deep-checked). */
export function isExcludedBuyer(s: Pick<ScoredBuyer, "breakdown">): boolean {
  const bd: any = s.breakdown;
  return !!(bd?.excludedIndustry || bd?.industryFit?.details?.excluded);
}

/**
 * Who the Suggested buyers list and the AI deep check work on — one
 * definition for both, so the button's count, the job's "N reviewed" and the
 * list always agree:
 *   - `pool`: buyers who could still be approached (no access to this deal
 *     yet, not submitted for approval) and don't rule out its industry —
 *     what the list shows;
 *   - `candidates`: those in the pool who pass the first pass — what the
 *     deep check reads;
 *   - `excluded`: buyers who rule out the industry (listed apart, never
 *     selectable).
 */
export function suggestionPools<T extends ScoredBuyer>(
  scored: T[],
  reached: (buyer: { id: string; email?: string | null }) => { alreadyHasAccess: boolean; inApproval?: boolean },
): { pool: T[]; candidates: T[]; excluded: T[]; withAccess: T[] } {
  const withAccess: T[] = [], excluded: T[] = [], pool: T[] = [];
  for (const s of scored) {
    const r = reached(s.buyer);
    if (r.alreadyHasAccess || r.inApproval) withAccess.push(s);
    else if (isExcludedBuyer(s)) excluded.push(s);
    else pool.push(s);
  }
  return { pool, candidates: pool.filter(passesFirstPass), excluded, withAccess };
}

/**
 * "Matches the CIM in the first place": not an excluded industry, and not a
 * clear rule-based mismatch (2+ criteria testable and none met). Buyers with
 * nothing testable but a written profile still qualify — only the AI can
 * judge them.
 */
export function passesFirstPass(s: ScoredBuyer): boolean {
  const bd: any = s.breakdown;
  if (isExcludedBuyer(s)) return false;
  const tested = bd?.criteriaTested ?? 0;
  const matched = bd?.criteriaMatched ?? 0;
  if (tested >= 2 && matched === 0) return false;
  if (tested === 0) {
    const c = (s.buyer.buyerCriteria as Record<string, any>) || {};
    return !!(s.buyer.background || c.lookingFor || (Array.isArray(s.buyer.targetIndustries) && s.buyer.targetIndustries.length));
  }
  return true;
}
