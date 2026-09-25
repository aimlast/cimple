/**
 * Run Match for one buyer-access row (POST /api/deals/:dealId/match-buyers).
 *
 * Each buyer is scored and saved on its own and never throws: a buyer whose
 * criteria can't be scored, an AI failure or a failed write comes back as
 * that buyer's `error`, and the rest of the batch still returns 200. Only a
 * finite integer score is ever written to the integer match_score column
 * (a NaN once failed the whole batch after partial writes).
 */
import { finiteScore, matchBuyerToDeal, type MatchBreakdown } from "./engine";

type DealForMatch = Parameters<typeof matchBuyerToDeal>[1];

export interface MatchRowResult {
  buyerId: string;
  buyerName: string;
  buyerEmail: string | null;
  buyerCompany: string | null;
  buyerType: string | null;
  prequalified?: boolean | null;
  proofOfFunds?: boolean | null;
  matchScore: number | null;
  breakdown: MatchBreakdown | null;
  noCriteria?: boolean;
  error?: string;
}

export async function matchBuyerDealRow(
  buyer: any,
  deal: DealForMatch,
  opts: {
    skipAI?: boolean;
    persist: (id: string, patch: { matchScore: number | null; matchBreakdown: MatchBreakdown }) => Promise<void>;
    match?: typeof matchBuyerToDeal;
  },
): Promise<MatchRowResult> {
  const base = {
    buyerId: buyer.id,
    buyerName: buyer.buyerName || "Unknown",
    buyerEmail: buyer.buyerEmail ?? null,
    buyerCompany: buyer.buyerCompany ?? null,
    buyerType: buyer.buyerType ?? null,
  };
  const criteria = (buyer.buyerCriteria || {}) as any;
  if (Object.keys(criteria).length === 0) {
    return { ...base, matchScore: null, breakdown: null, noCriteria: true };
  }
  let breakdown: MatchBreakdown;
  try {
    breakdown = await (opts.match ?? matchBuyerToDeal)(criteria, deal, { skipAI: opts.skipAI });
  } catch (err) {
    console.error(`[matching] buyer ${buyer.id} could not be scored:`, (err as Error)?.message ?? err);
    return { ...base, matchScore: null, breakdown: null, error: "This buyer's criteria couldn't be scored." };
  }
  const matchScore = finiteScore(breakdown.finalScore);
  try {
    await opts.persist(buyer.id, { matchScore, matchBreakdown: breakdown });
  } catch (err) {
    console.error(`[matching] buyer ${buyer.id} score not saved:`, (err as Error)?.message ?? err);
    return { ...base, prequalified: buyer.prequalified, proofOfFunds: buyer.proofOfFunds, matchScore, breakdown, error: "Scored, but the score couldn't be saved." };
  }
  return { ...base, prequalified: buyer.prequalified, proofOfFunds: buyer.proofOfFunds, matchScore, breakdown };
}
