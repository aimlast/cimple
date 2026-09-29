/**
 * Buyer fit — how well a buyer who has the CIM matches the business, as the
 * broker sees it on the deal's Buyers tab ("Have the CIM" → Fit column).
 *
 * Pure and shared: the server labels each score with `fitLabel`, the Fit
 * dialog lists what matched with `fitReasons`. The score itself comes from
 * the matching engine (server/matching/engine.ts) — this file only reads a
 * stored breakdown. Broker-facing only: buyers never see a fit label.
 */

export type FitTone = "strong" | "good" | "partial" | "weak" | "excluded" | "none";

/** The parts of the engine's MatchBreakdown this file reads. */
export interface FitBreakdownLike {
  financialFit?: FitCategoryLike;
  industryFit?: FitCategoryLike;
  locationFit?: FitCategoryLike;
  operationalFit?: FitCategoryLike;
  dealStructureFit?: FitCategoryLike;
  aiQualitative?: { overallAssessment?: string; score?: number } | null;
  finalScore?: number;
  criteriaMatched?: number;
  criteriaTested?: number;
  excludedIndustry?: boolean;
  excludedBy?: string | null;
}
interface FitCategoryLike {
  score: number;
  max: number;
  details?: Record<string, { score: number; max: number; note: string }>;
}

/** Scored categories, in the order the dialog lists them. */
export const FIT_CATEGORIES: Array<{ key: keyof FitBreakdownLike; label: string }> = [
  { key: "industryFit", label: "Industry" },
  { key: "financialFit", label: "Financials" },
  { key: "locationFit", label: "Location" },
  { key: "operationalFit", label: "Operations" },
  { key: "dealStructureFit", label: "Deal terms" },
];

/**
 * One label per fit. `hasCriteria` = the buyer's profile says what they want
 * (something to compare); without it there is no score to show.
 */
export function fitLabel(bd: FitBreakdownLike | null | undefined, hasCriteria: boolean): { label: string; tone: FitTone; score: number | null } {
  if (!hasCriteria || !bd) return { label: "No criteria yet", tone: "none", score: null };
  if (bd.excludedIndustry) return { label: "Rules out this industry", tone: "excluded", score: null };
  if (!bd.criteriaTested) return { label: "Not enough to compare", tone: "none", score: null };
  const score = Math.max(0, Math.min(100, Math.round(Number(bd.finalScore) || 0)));
  if (score >= 75) return { label: "Strong fit", tone: "strong", score };
  if (score >= 55) return { label: "Good fit", tone: "good", score };
  if (score >= 35) return { label: "Partial fit", tone: "partial", score };
  return { label: "Weak fit", tone: "weak", score };
}

export interface FitReason { category: string; note: string }

/**
 * What matched, what partly matched and what didn't — one line per criterion
 * the engine could test, in the engine's own words ("$2.1M — within range").
 * A criterion "matches" at 70%+ of its points, "partly" at 40%+.
 */
export function fitReasons(bd: FitBreakdownLike | null | undefined): { met: FitReason[]; partly: FitReason[]; unmet: FitReason[] } {
  const out = { met: [] as FitReason[], partly: [] as FitReason[], unmet: [] as FitReason[] };
  if (!bd) return out;
  for (const { key, label } of FIT_CATEGORIES) {
    const cat = bd[key] as FitCategoryLike | undefined;
    if (!cat || !cat.details) continue;
    for (const d of Object.values(cat.details)) {
      if (!d || typeof d.note !== "string" || !d.max) continue;
      const pct = (d.score / d.max) * 100;
      const reason = { category: label, note: d.note };
      if (pct >= 70) out.met.push(reason);
      else if (pct >= 40) out.partly.push(reason);
      else out.unmet.push(reason);
    }
  }
  return out;
}

/** Does a buyer's criteria object hold anything to compare? (empty strings / lists don't count) */
export function hasAnyCriteria(criteria: Record<string, unknown> | null | undefined): boolean {
  if (!criteria || typeof criteria !== "object") return false;
  return Object.entries(criteria).some(([k, v]) => {
    if (k.startsWith("_") || k === "lookingFor") return false;
    if (v === null || v === undefined || v === "" || v === false) return false;
    if (Array.isArray(v)) return v.some((x) => typeof x === "string" ? x.trim() && x !== "any" : x != null);
    return true;
  });
}

/** The fit of one buyer who has the CIM, as GET /api/deals/:dealId/buyer-fit returns it. */
export interface AccessFit {
  accessId: string;
  label: string;
  tone: FitTone;
  score: number | null;
  criteriaMatched: number;
  criteriaTested: number;
  /** The score includes the AI's read of the business (kept until the buyer's criteria or the deal's facts change). */
  ai: boolean;
  aiAssessment: string | null;
  excludedBy: string | null;
  /** Where the criteria came from: the buyer's profile, or criteria saved on this deal's access row before profiles existed. */
  criteriaFrom: "profile" | "deal" | null;
  /** The buyer's profile page (/broker/buyers/:id), when they are on the broker's list. */
  profileBuyerId: string | null;
  computedAt: string | null;
  breakdown: FitBreakdownLike | null;
  /** Criteria the broker saved for this buyer on this deal before buyer profiles existed (read-only now). */
  dealCriteria: Record<string, unknown> | null;
  /** Keys of those not on the buyer's profile yet — "Copy to their profile" adds them (gap-fill, private to the broker). */
  dealCriteriaToCopy: string[];
}
