/**
 * Server side of "can the AI write the whole CIM now?" — the rule itself is
 * shared/deal-progress.ts cimGenerationGate (a completed interview, or enough
 * information from any source); this module computes the deal's readiness
 * the same way GET /api/deals/:dealId/cim-readiness does, so the number the
 * broker sees and the number the gate checks are one number.
 */
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { interviewSessions, type Deal } from "@shared/schema";
import { computeCimReadiness, type CimReadiness } from "@shared/cim-readiness";
import { cimGenerationGate, type CimGenerationGate } from "@shared/deal-progress";
import { buildSectionCoverage } from "../interview/knowledge-base";
import { getSectionImportance } from "../interview/section-importance";
import { getInterviewOutline } from "../interview/outline";
import { coverageAdjustmentsForDeal } from "../interview/interview-plan";

/** Section coverage + readiness for a deal (confidence from its latest interview session). */
export async function computeDealReadiness(deal: Deal) {
  const [latest] = await db
    .select({ extractedInfo: interviewSessions.extractedInfo })
    .from(interviewSessions)
    .where(eq(interviewSessions.dealId, deal.id))
    .orderBy(desc(interviewSessions.lastActivityAt))
    .limit(1);
  const meta = (latest?.extractedInfo as Record<string, unknown> | null) || {};
  const confidence = meta._confidenceLevels as Record<string, string> | undefined;
  const sections = buildSectionCoverage(
    (deal.extractedInfo || {}) as any,
    confidence,
    getSectionImportance(deal),
    getInterviewOutline(deal).excludedSections,
    coverageAdjustmentsForDeal(deal),
  );
  return { readiness: computeCimReadiness(sections), sections };
}

/** The shared gate, with the deal's readiness filled in. */
export async function checkCimGenerationGate(deal: Deal): Promise<CimGenerationGate & { readiness: CimReadiness | null }> {
  if (deal.interviewCompleted) return { ...cimGenerationGate(deal, null), readiness: null };
  const { readiness } = await computeDealReadiness(deal);
  return { ...cimGenerationGate(deal, readiness.score), readiness };
}
