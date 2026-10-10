/**
 * buyer-extras.ts — the one helper that builds what buildBuyerCim adds for a
 * buyer on top of the CIM's sections (INTEGRATION §2.2). Every buyer path
 * goes through it, so the view room, the recorded renditions (reading
 * analytics) and the buyer Q&A chatbot always see the same CIM:
 *
 *   - the view route's content branch (server/routes.ts GET /api/view/:token)
 *   - servedCimFor (server/analytics/renditions.ts)
 *   - the chatbot's CIM (server/qa/cim-context.ts readerCim; the chat route)
 *
 * Broker previews build their own live payloads (gl: buildEvidence(…,
 * "live"); dd: GET …/figure-layer) and never call this.
 *
 *   glEvidence  gl: the DD page / the Full and Blind note (null when nothing is published)
 *   figures     dd: the figure notes / due-diligence checks inputs (null for a
 *               Teaser link, or when the figure layer can't be built)
 */
import type { Deal } from "@shared/schema";
import type { GlEvidencePayload } from "@shared/gl-evidence";
import type { FigureInputs } from "@shared/figure-layer";
import { glEvidenceForBuyer } from "../gl/evidence";
import { buyerFigureInputs } from "./figures/serve";
import { seesCim } from "@shared/access-levels";

/** dd's figure inputs, as buildBuyerCim takes them. */
export type BuyerFigureInputs = FigureInputs;

export async function buyerCimExtras(
  deal: Pick<Deal, "id">,
  accessLevel: string | null | undefined,
  accessId: string | null,
): Promise<{ glEvidence: GlEvidencePayload | null; figures: BuyerFigureInputs | null }> {
  // A Teaser link is served no CIM, so nothing goes on top of one (INTEGRATION §2.2).
  if (!seesCim(accessLevel)) return { glEvidence: null, figures: null };
  const [glEvidence, figures] = await Promise.all([
    glEvidenceForBuyer(deal.id, accessLevel, accessId), // gl; null when nothing published
    buyerFigureInputs(deal, accessLevel),               // dd; null when no layer can be built
  ]);
  return { glEvidence, figures };
}
