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
}

const WEIGHT: Record<ReadinessLevel, number> = { critical: 3, important: 2, helpful: 1 };
const STATUS_VALUE: Record<CoverageStatus, number> = { well_covered: 1, partial: 0.5, missing: 0 };
/** A CIM with a critical section missing can't honestly be "buyer-ready". */
const CRITICAL_GAP_CAP = 79;

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
  let score = possible > 0 ? Math.round((earned / possible) * 100) : 0;
  if (criticalGap) score = Math.min(score, CRITICAL_GAP_CAP);

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
  } else if (gaps.length > 0) {
    summary = `Every critical section is covered; ${gaps.length} supporting section${gaps.length === 1 ? "" : "s"} could add depth.`;
  } else summary = "Every section is well covered.";

  return { score, label, summary, byLevel, gaps: topGaps, criticalGap };
}
