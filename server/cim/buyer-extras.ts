/**
 * buyer-extras — the ONE helper that builds the extra layers of a buyer's
 * CIM (INTEGRATION §2.2): gl's evidence page and dd's figure notes / checks.
 * Callers (only these): the view route's content branch, servedCimFor
 * (server/analytics/renditions.ts) and the chatbot build
 * (server/qa/cim-context.ts). Broker previews use their own live payloads.
 *
 * STAND-IN on the dd branch: stream "gl" creates this file with
 * glEvidenceForBuyer; at the merge the integrator keeps gl's file and drops in
 * dd's `buyerFigureInputs(deal, accessLevel)` line (identical shape below).
 */
import type { Deal } from "@shared/schema";
import type { FigureInputs } from "@shared/figure-layer";
import { seesCim } from "@shared/access-levels";
import { buyerFigureInputs } from "./figures/serve";

export async function buyerCimExtras(
  deal: Deal,
  accessLevel: string | null | undefined,
  accessId: string | null,
): Promise<{ glEvidence: null; figures: FigureInputs | null }> {
  void accessId; // gl: per-buyer data-room tightening of the evidence page
  if (!seesCim(accessLevel)) return { glEvidence: null, figures: null };
  const [glEvidence, figures] = await Promise.all([
    Promise.resolve(null), // gl: glEvidenceForBuyer(deal.id, accessLevel, accessId)
    buyerFigureInputs(deal, accessLevel),
  ]);
  return { glEvidence, figures };
}
