/**
 * Fit of the buyers who have a deal's CIM (Buyers tab → "Have the CIM").
 *
 * Automatic: every time the list loads, each buyer's fit is checked against a
 * fingerprint of what it was computed from (the buyer's criteria + the deal's
 * facts). Unchanged → the stored score is reused, including one that the
 * broker asked the AI to check. Changed (the buyer's profile was edited, a new
 * fact landed) → it is re-scored by the rule-based engine (never the AI) and
 * saved on the access row (buyer_access.match_score / match_breakdown).
 * There is no "Run match" button any more.
 *
 * The criteria are the buyer's profile as this broker sees it (broker edits >
 * the buyer's own answers > the broker's private CRM profile — the same merge
 * Suggested buyers uses), so editing a buyer's profile page changes their fit
 * here. Criteria typed on a deal's access row before buyer profiles existed
 * are only used when the buyer has no profile criteria.
 */
import { createHash } from "node:crypto";
import type { BuyerAccess, BuyerUser, BrokerBuyerContact, Deal } from "@shared/schema";
import { fitLabel, hasAnyCriteria, type AccessFit, type FitBreakdownLike } from "@shared/buyer-fit";
import { matchBuyerToDeal, finiteScore, type MatchBreakdown } from "./engine";

type DealForMatch = Parameters<typeof matchBuyerToDeal>[1];

/** Bookkeeping kept inside the stored breakdown (no schema change). */
export interface FitStamp { key: string; at: string; ai: boolean }
export type StoredFitBreakdown = MatchBreakdown & { _fit?: FitStamp };

export interface CriteriaForAccess {
  criteria: Record<string, any>;
  from: "profile" | "deal" | null;
  profileBuyerId: string | null;
}

/** JSON with sorted keys, so the same inputs always hash the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * The deal side of the match. Private/bookkeeping facts (`_`-prefixed keys:
 * provenance stamps, broker notes) are left out — they never feed the engine
 * and would make every fit look stale whenever a timestamp moved.
 */
export function dealForFit(deal: Pick<Deal, "industry" | "subIndustry" | "askingPrice" | "description" | "extractedInfo">, fa?: { reclassifiedPnl?: unknown; normalization?: unknown; workingCapital?: unknown } | null): DealForMatch {
  const info = Object.fromEntries(
    Object.entries((deal.extractedInfo as Record<string, any>) || {}).filter(([k]) => !k.startsWith("_")),
  );
  return {
    industry: deal.industry || "",
    subIndustry: deal.subIndustry ?? null,
    askingPrice: deal.askingPrice ?? null,
    description: deal.description ?? null,
    extractedInfo: info,
    financialAnalysis: fa ? { reclassifiedPnl: fa.reclassifiedPnl, normalization: fa.normalization, workingCapital: fa.workingCapital } : undefined,
  };
}

/** Fingerprint of everything a fit is computed from. */
export function fitKey(criteria: Record<string, any>, deal: DealForMatch): string {
  return createHash("sha1").update(stable({ criteria, deal })).digest("hex").slice(0, 20);
}

/**
 * Which criteria a buyer-access row is scored on. `entry` is the buyer on the
 * broker's list (matched by account id, else by email), already merged the
 * way the broker sees it.
 */
export function criteriaForAccess(
  access: Pick<BuyerAccess, "buyerCriteria">,
  entry: { buyerId: string; profile: Pick<BuyerUser, "buyerCriteria" | "targetIndustries" | "targetLocations"> } | null,
): CriteriaForAccess {
  if (entry) {
    const p = entry.profile;
    const criteria: Record<string, any> = {
      ...((p.buyerCriteria as Record<string, any>) || {}),
      targetIndustries: (p.targetIndustries as string[] | null) || [],
      targetLocations: (p.targetLocations as string[] | null) || [],
    };
    if (hasAnyCriteria(criteria)) return { criteria, from: "profile", profileBuyerId: entry.buyerId };
  }
  const legacy = (access.buyerCriteria as Record<string, any> | null) || {};
  if (hasAnyCriteria(legacy)) return { criteria: legacy, from: "deal", profileBuyerId: entry?.buyerId ?? null };
  return { criteria: {}, from: null, profileBuyerId: entry?.buyerId ?? null };
}

/** The stored fit, as the Buyers tab shows it. */
export function toAccessFit(accessId: string, bd: StoredFitBreakdown | null, c: CriteriaForAccess): AccessFit {
  const has = !!c.from;
  const { label, tone, score } = fitLabel(bd as FitBreakdownLike | null, has);
  return {
    accessId,
    label,
    tone,
    score,
    criteriaMatched: has && bd ? bd.criteriaMatched ?? 0 : 0,
    criteriaTested: has && bd ? bd.criteriaTested ?? 0 : 0,
    ai: has && !!bd?.aiQualitative,
    aiAssessment: has && bd?.aiQualitative?.overallAssessment ? bd.aiQualitative.overallAssessment : null,
    excludedBy: has && bd?.excludedIndustry ? bd.excludedBy ?? null : null,
    criteriaFrom: c.from,
    profileBuyerId: c.profileBuyerId,
    computedAt: has && bd?._fit?.at ? bd._fit.at : null,
    breakdown: has && bd ? (({ _fit, ...rest }) => rest)(bd) as FitBreakdownLike : null,
  };
}

export interface FitDeps {
  persist: (accessId: string, patch: { matchScore: number | null; matchBreakdown: StoredFitBreakdown | null }) => Promise<unknown>;
  match?: typeof matchBuyerToDeal;
  now?: () => Date;
}

/**
 * Fit for one access row — reuses the stored one when its fingerprint still
 * matches, otherwise re-scores (rule-based only) and saves. With `withAI`
 * (the broker's "Check fit with AI"), always re-scores including the AI.
 * Never throws: a buyer that can't be scored comes back unscored.
 */
export async function ensureAccessFit(
  access: Pick<BuyerAccess, "id" | "buyerCriteria" | "matchScore" | "matchBreakdown">,
  c: CriteriaForAccess,
  deal: DealForMatch,
  deps: FitDeps,
  opts: { withAI?: boolean } = {},
): Promise<{ fit: AccessFit; recomputed: boolean; aiUnavailable?: string }> {
  const stored = (access.matchBreakdown as StoredFitBreakdown | null) ?? null;
  if (!c.from) {
    // Nothing to compare. A score left over from older criteria is cleared.
    if (stored || access.matchScore != null) {
      await deps.persist(access.id, { matchScore: null, matchBreakdown: null }).catch((err) => {
        console.error(`[buyer-fit] couldn't clear fit for access ${access.id}:`, (err as Error)?.message ?? err);
      });
    }
    return { fit: toAccessFit(access.id, null, c), recomputed: !!stored };
  }
  const key = fitKey(c.criteria, deal);
  if (!opts.withAI && stored?._fit?.key === key) {
    return { fit: toAccessFit(access.id, stored, c), recomputed: false };
  }
  let bd: MatchBreakdown;
  try {
    bd = await (deps.match ?? matchBuyerToDeal)(c.criteria as any, deal, { skipAI: !opts.withAI });
  } catch (err) {
    console.error(`[buyer-fit] access ${access.id} could not be scored:`, (err as Error)?.message ?? err);
    return { fit: toAccessFit(access.id, null, c), recomputed: false };
  }
  const aiUnavailable = opts.withAI && !bd.aiQualitative
    ? (bd.aiQualitativeUnavailable || (bd.criteriaTested ? "The AI check isn't available right now." : "There's nothing in this buyer's criteria the AI can check yet."))
    : undefined;
  const next: StoredFitBreakdown = { ...bd, _fit: { key, at: (deps.now?.() ?? new Date()).toISOString(), ai: !!bd.aiQualitative } };
  try {
    await deps.persist(access.id, { matchScore: finiteScore(bd.finalScore), matchBreakdown: next });
  } catch (err) {
    console.error(`[buyer-fit] fit for access ${access.id} not saved:`, (err as Error)?.message ?? err);
  }
  return { fit: toAccessFit(access.id, next, c), recomputed: true, ...(aiUnavailable ? { aiUnavailable } : {}) };
}

/**
 * Match access rows to the broker's list: by linked account id first, then
 * by email (a buyer's account is linked to an access row only once they
 * verify their email, but the broker's list may already hold them).
 */
export function listEntryFinder<E extends { buyerUser: Pick<BuyerUser, "id" | "email"> }>(entries: E[]) {
  const byId = new Map(entries.map((e) => [e.buyerUser.id, e]));
  const byEmail = new Map<string, E>();
  for (const e of entries) {
    const em = (e.buyerUser.email || "").trim().toLowerCase();
    if (em && !byEmail.has(em)) byEmail.set(em, e);
  }
  return (access: Pick<BuyerAccess, "buyerUserId" | "buyerEmail">): E | null =>
    (access.buyerUserId ? byId.get(access.buyerUserId) : undefined)
    ?? byEmail.get((access.buyerEmail || "").trim().toLowerCase())
    ?? null;
}

/**
 * Loads everything and returns the fit of every buyer with access (not
 * revoked) on the deal. `withAIFor` = one access id to re-check with the AI.
 */
export async function loadDealBuyerFits(deal: Deal, opts: { withAIFor?: string } = {}): Promise<{ fits: AccessFit[]; aiUnavailable?: string }> {
  const { storage } = await import("../storage");
  const { mergedForBroker } = await import("../buyers/profile-view");
  const { loadBrokerScope } = await import("../buyers/provenance-scope");
  const [rows, fa, list, scope] = await Promise.all([
    storage.getBuyerAccessByDeal(deal.id),
    storage.getLatestFinancialAnalysis(deal.id),
    storage.getBrokerBuyerContactList(deal.brokerId!),
    loadBrokerScope(deal.brokerId!),
  ]);
  const find = listEntryFinder(list as Array<{ buyerUser: BuyerUser; contact: BrokerBuyerContact | null }>);
  const dealInputs = dealForFit(deal, fa ?? null);
  const deps: FitDeps = { persist: (id, patch) => storage.updateBuyerAccess(id, patch as any) };
  let aiUnavailable: string | undefined;
  const fits = await Promise.all(rows.filter((r) => !r.revokedAt).map(async (row) => {
    const e = find(row);
    const entry = e ? { buyerId: e.buyerUser.id, profile: mergedForBroker(e.buyerUser, e.contact, scope).profile } : null;
    const withAI = opts.withAIFor === row.id;
    const r = await ensureAccessFit(row, criteriaForAccess(row, entry), dealInputs, deps, { withAI });
    if (withAI && r.aiUnavailable) aiUnavailable = r.aiUnavailable;
    return r.fit;
  }));
  return { fits, ...(aiUnavailable ? { aiUnavailable } : {}) };
}
