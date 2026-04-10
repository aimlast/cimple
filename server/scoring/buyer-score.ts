/**
 * Buyer Qualified-Lead Composite Score
 *
 * Combines four signals into a single 0-100 broker-facing score that answers
 * "how qualified is this buyer overall?":
 *
 *   1. Match-fit          — how well their criteria match a specific deal (35%)
 *   2. Profile completeness — how much we know about them (25%)
 *   3. Engagement          — have they actually viewed/asked about deals (25%)
 *   4. Proof of funds      — financial verification (15%)
 *
 * Scoring is profile-only when no deal context is supplied — match-fit is
 * skipped and the remaining weights are renormalised.
 *
 * IMPORTANT: This composite is BROKER-FACING ONLY. It is never shown to
 * buyers. Buyers see raw criteria-matched counts and dimension chips —
 * never a 0-100 score, percentage, or letter grade.
 */
import type { BuyerUser } from "@shared/schema";
import type { MatchBreakdown } from "../matching/engine.js";

export interface QualifiedLeadInput {
  buyer: Pick<
    BuyerUser,
    "profileCompletionPct" | "hasProofOfFunds" | "buyerType" | "liquidFunds" | "buyerCriteria" | "targetIndustries"
  >;
  /** Optional deep match against a specific deal — when present, match-fit factors into the score. */
  match?: Pick<MatchBreakdown, "criteriaMatched" | "criteriaTested" | "deterministicScore" | "finalScore"> | null;
  /** Engagement signals from analytics — used when scoring buyers who have viewed deals. */
  engagement?: {
    viewCount?: number;
    sectionsViewed?: number;
    totalTimeSeconds?: number;
    questionCount?: number;
    ndaSigned?: boolean;
  } | null;
}

export type QualifiedLeadTier = "hot" | "warm" | "cool" | "cold";

export interface QualifiedLeadScore {
  total: number;                                    // 0-100
  tier: QualifiedLeadTier;                          // hot ≥ 75 · warm ≥ 50 · cool ≥ 25 · cold < 25
  breakdown: {
    matchFit: number;          // 0-100, or null when no deal context
    profile: number;           // 0-100
    engagement: number;        // 0-100
    proofOfFunds: number;      // 0-100 (binary)
  };
  weights: {
    matchFit: number;
    profile: number;
    engagement: number;
    proofOfFunds: number;
  };
  hasDealContext: boolean;
  reasons: string[];           // Short broker-facing strings explaining the score
}

const DEFAULT_WEIGHTS = {
  matchFit: 0.35,
  profile: 0.25,
  engagement: 0.25,
  proofOfFunds: 0.15,
};

// When no deal is given, redistribute the matchFit weight across the others
const PROFILE_ONLY_WEIGHTS = {
  matchFit: 0,
  profile: 0.45,
  engagement: 0.35,
  proofOfFunds: 0.20,
};

function tierFor(total: number): QualifiedLeadTier {
  if (total >= 75) return "hot";
  if (total >= 50) return "warm";
  if (total >= 25) return "cool";
  return "cold";
}

function engagementSubScore(e: QualifiedLeadInput["engagement"]): { score: number; reason: string | null } {
  if (!e) return { score: 0, reason: null };

  // Weighted: time 35, sections 25, questions 20, return visits 15, NDA 5
  const time = Math.min((e.totalTimeSeconds ?? 0) / 300, 1) * 35;             // 5 min = full
  const sections = Math.min((e.sectionsViewed ?? 0) / 8, 1) * 25;             // 8 sections = full
  const questions = Math.min((e.questionCount ?? 0) / 3, 1) * 20;             // 3 questions = full
  const returnVisits = Math.min(Math.max(((e.viewCount ?? 0) - 1) / 2, 0), 1) * 15;  // 3 visits = full
  const nda = e.ndaSigned ? 5 : 0;
  const score = Math.round(time + sections + questions + returnVisits + nda);

  let reason: string | null = null;
  if (score >= 70) reason = "Highly engaged with similar deals";
  else if (score >= 40) reason = "Moderate engagement";
  else if (score > 0) reason = "Limited engagement so far";

  return { score, reason };
}

function matchFitSubScore(m: QualifiedLeadInput["match"]): { score: number; reason: string | null } {
  if (!m) return { score: 0, reason: null };

  // Use the deterministic score directly (it's already 0-100). The full match
  // engine produces a finalScore that may include AI qualitative blending — we
  // honour that when present.
  const score = m.finalScore ?? m.deterministicScore ?? 0;

  let reason: string | null = null;
  const matched = m.criteriaMatched ?? 0;
  if (score >= 70 && matched >= 3) reason = `${matched} criteria matched`;
  else if (score >= 40 && matched >= 1) reason = `${matched} criteria matched`;
  else if (score > 0) reason = "Partial criteria match";

  return { score, reason };
}

/**
 * Compute the composite qualified-lead score for a buyer.
 *
 * Pure function — no IO, no side effects. Safe to call in tight loops when
 * scoring an entire buyer list.
 */
export function calculateQualifiedLeadScore(input: QualifiedLeadInput): QualifiedLeadScore {
  const hasDealContext = !!input.match;
  const weights = hasDealContext ? DEFAULT_WEIGHTS : PROFILE_ONLY_WEIGHTS;

  // ── Sub-scores ────────────────────────────────────────────────────────────
  const profile = input.buyer.profileCompletionPct ?? 0;
  const proofOfFunds = input.buyer.hasProofOfFunds ? 100 : 0;
  const matchFit = matchFitSubScore(input.match ?? null);
  const engagement = engagementSubScore(input.engagement ?? null);

  // ── Weighted total ────────────────────────────────────────────────────────
  const total = Math.round(
    matchFit.score * weights.matchFit +
    profile * weights.profile +
    engagement.score * weights.engagement +
    proofOfFunds * weights.proofOfFunds,
  );

  // ── Reasons (broker-facing chips, in priority order) ──────────────────────
  const reasons: string[] = [];
  if (matchFit.reason) reasons.push(matchFit.reason);
  if (input.buyer.hasProofOfFunds) reasons.push("Proof of funds verified");
  if (engagement.reason) reasons.push(engagement.reason);
  if (profile >= 80) reasons.push("Complete profile");
  else if (profile >= 50) reasons.push("Profile filled in");

  return {
    total: Math.max(0, Math.min(100, total)),
    tier: tierFor(total),
    breakdown: {
      matchFit: matchFit.score,
      profile,
      engagement: engagement.score,
      proofOfFunds,
    },
    weights,
    hasDealContext,
    reasons,
  };
}

/**
 * Friendly broker-facing tier labels (used by UI).
 */
export const TIER_LABELS: Record<QualifiedLeadTier, { label: string; description: string }> = {
  hot: { label: "Hot", description: "Strong fit and ready to engage" },
  warm: { label: "Warm", description: "Good fit, worth reaching out" },
  cool: { label: "Cool", description: "Partial fit, could be educated into a buyer" },
  cold: { label: "Cold", description: "Weak fit on current data" },
};
