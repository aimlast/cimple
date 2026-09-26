/**
 * CIM readiness — one honest number for "how good will the CIM be with what
 * we know so far?", derived from section coverage weighted by how much each
 * section matters to buyers of this business (see section importance).
 *
 * Pure and shared: the server computes it for API responses and interview
 * turns; the client only renders. Scores are explainable — a broker can
 * always see which gaps are holding the number down.
 */

export type ReadinessLevel = "critical" | "important" | "helpful";
export type CoverageStatus = "well_covered" | "partial" | "missing";

export interface ReadinessInputSection {
  key: string;
  title: string;
  status: CoverageStatus;
  importance?: ReadinessLevel;
  importanceReason?: string;
  /** Data points the section asks for (checklist + generic items). */
  totalItems?: number;
  /** Data points with no verified value yet. */
  openItems?: number;
  /** Of those, items marked critical. */
  openCriticalItems?: number;
  /** Items on file only as unverified leads (CRM note, website, social). */
  unverifiedItems?: number;
  /** Items the seller (interview, call, questionnaire) or the broker stated. */
  sellerSourcedItems?: number;
  /** Items backed by a written document or set by the broker. */
  documentedItems?: number;
}

export interface ReadinessGap {
  key: string;
  title: string;
  importance: ReadinessLevel;
  status: "partial" | "missing";
  reason: string;
}

export interface CimReadiness {
  /** 0–100 */
  score: number;
  label: "Thin" | "Developing" | "Solid" | "Buyer-ready";
  /** One line a broker or seller can act on. */
  summary: string;
  byLevel: Record<ReadinessLevel, { covered: number; partial: number; total: number }>;
  /** Biggest holes first: missing/partial critical, then important. At most 5. */
  gaps: ReadinessGap[];
  /** True when at least one critical section is still missing — caps the score. */
  criticalGap: boolean;
  /** Data points still open across all sections (when the caller supplied item counts). */
  openItems: number;
  /** Buyer-critical data points still open. */
  openCriticalItems: number;
  /** Facts on file only as unverified leads. */
  unverifiedItems: number;
}

const WEIGHT: Record<ReadinessLevel, number> = { critical: 3, important: 2, helpful: 1 };
const STATUS_VALUE: Record<CoverageStatus, number> = { well_covered: 1, partial: 0.5, missing: 0 };
/** A CIM with a critical section missing can't honestly be "buyer-ready". */
const CRITICAL_GAP_CAP = 79;
/**
 * When item counts are known, the score is 80% section coverage and 20% the
 * share of data points on file — every section can be "well covered" while
 * half the industry checklist is still open, and the number should show it.
 */
const ITEM_SHARE = 0.2;
/**
 * Below "Buyer-ready": a critical section only partly covered, a buyer-critical
 * data point still open, or nothing yet from the seller themselves (every
 * fact came from documents or leads).
 */
const NOT_BUYER_READY_CAP = 84;
/**
 * No financial figure backed by a document (statements, tax returns) or set
 * by the broker: whatever was said on a call, the CIM can't be "Solid" yet.
 */
const NO_STATEMENTS_CAP = 59;

export function readinessLabel(score: number): CimReadiness["label"] {
  if (score >= 85) return "Buyer-ready";
  if (score >= 60) return "Solid";
  if (score >= 35) return "Developing";
  return "Thin";
}

export function computeCimReadiness(sections: ReadinessInputSection[]): CimReadiness {
  const byLevel: CimReadiness["byLevel"] = {
    critical: { covered: 0, partial: 0, total: 0 },
    important: { covered: 0, partial: 0, total: 0 },
    helpful: { covered: 0, partial: 0, total: 0 },
  };
  let earned = 0;
  let possible = 0;
  const gaps: ReadinessGap[] = [];

  for (const s of sections) {
    const level: ReadinessLevel = s.importance ?? "important";
    const w = WEIGHT[level];
    possible += w;
    earned += w * STATUS_VALUE[s.status];
    byLevel[level].total += 1;
    if (s.status === "well_covered") byLevel[level].covered += 1;
    else if (s.status === "partial") byLevel[level].partial += 1;
    if (s.status !== "well_covered") {
      gaps.push({ key: s.key, title: s.title, importance: level, status: s.status, reason: s.importanceReason ?? "" });
    }
  }

  const criticalGap = gaps.some((g) => g.importance === "critical" && g.status === "missing");
  const sum = (pick: (s: ReadinessInputSection) => number | undefined) =>
    sections.reduce((n, s) => n + (pick(s) ?? 0), 0);
  const openItems = sum((s) => s.openItems);
  const openCriticalItems = sum((s) => s.openCriticalItems);
  const unverifiedItems = sum((s) => s.unverifiedItems);
  // Item counts are optional (older callers pass statuses only); the seller
  // check applies only when the caller counted seller-sourced items.
  const countsKnown = sections.some((s) => s.sellerSourcedItems !== undefined);
  const noSellerSource = countsKnown && sum((s) => s.sellerSourcedItems) === 0;
  const totalItems = sum((s) => s.totalItems);
  const sectionScore = possible > 0 ? (earned / possible) * 100 : 0;
  const itemScore = totalItems > 0 ? (1 - Math.min(openItems, totalItems) / totalItems) * 100 : null;
  let score = Math.round(itemScore === null ? sectionScore : sectionScore * (1 - ITEM_SHARE) + itemScore * ITEM_SHARE);
  if (criticalGap) score = Math.min(score, CRITICAL_GAP_CAP);
  const criticalPartial = gaps.some((g) => g.importance === "critical");
  if (criticalPartial || openCriticalItems > 0 || noSellerSource) score = Math.min(score, NOT_BUYER_READY_CAP);
  const financials = sections.find((s) => s.key === "financials");
  const noStatements = !!financials && financials.documentedItems === 0;
  if (noStatements) score = Math.min(score, NO_STATEMENTS_CAP);

  // Order: missing before partial within a level; critical → important → helpful.
  const levelRank: Record<ReadinessLevel, number> = { critical: 0, important: 1, helpful: 2 };
  gaps.sort((a, b) =>
    levelRank[a.importance] - levelRank[b.importance] ||
    (a.status === "missing" ? 0 : 1) - (b.status === "missing" ? 0 : 1),
  );
  const topGaps = gaps.slice(0, 5);

  const label = readinessLabel(score);
  const criticalOpen = gaps.filter((g) => g.importance === "critical");
  let summary: string;
  if (sections.length === 0) summary = "No information collected yet.";
  else if (criticalOpen.length > 0) {
    const names = criticalOpen.slice(0, 3).map((g) => g.title).join(", ");
    summary = `${criticalOpen.length} critical section${criticalOpen.length === 1 ? "" : "s"} still need${criticalOpen.length === 1 ? "s" : ""} work: ${names}${criticalOpen.length > 3 ? "…" : ""}.`;
  } else if (openCriticalItems > 0) {
    summary = `${openCriticalItems} buyer-critical data point${openCriticalItems === 1 ? " is" : "s are"} still open.`;
  } else if (gaps.length > 0) {
    summary = `Every critical section is covered; ${gaps.length} supporting section${gaps.length === 1 ? "" : "s"} could add depth.`;
  } else if (openItems > 0) {
    summary = `Every section has solid coverage; ${openItems} data point${openItems === 1 ? " is" : "s are"} still open.`;
  } else summary = "Every section is well covered.";
  if (noSellerSource && sections.length > 0) summary += " Nothing is confirmed by the seller yet — it all comes from documents.";
  if (noStatements) summary = `No financial statements on file yet — the figures so far are only what was said. ${summary}`;
  if (unverifiedItems > 0 && sections.length > 0) {
    summary += ` ${unverifiedItems} fact${unverifiedItems === 1 ? " is an unverified lead" : "s are unverified leads"} (CRM notes, website) — confirm with the seller.`;
  }

  return { score, label, summary, byLevel, gaps: topGaps, criticalGap, openItems, openCriticalItems, unverifiedItems };
}
