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
 * "live")) and never call this.
 *
 *   glEvidence  gl: the DD page / the Full and Blind note (null when nothing is published)
 *   figures     dd: filled at dd's merge (buyerFigureInputs) — null until then
 */
import type { Deal } from "@shared/schema";
import type { GlEvidencePayload } from "@shared/gl-evidence";
import { glEvidenceForBuyer } from "../gl/evidence";
import { isTeaserOnly } from "../gl/levels";

/** dd's figure inputs (dd defines the type at its merge). */
export type BuyerFigureInputs = never;

export async function buyerCimExtras(
  deal: Pick<Deal, "id">,
  accessLevel: string | null | undefined,
  accessId: string | null,
): Promise<{ glEvidence: GlEvidencePayload | null; figures: BuyerFigureInputs | null }> {
  // INTEGRATOR: `if (!seesCim(accessLevel))` from @shared/access-levels once teaser is merged.
  if (isTeaserOnly(accessLevel)) return { glEvidence: null, figures: null };
  const [glEvidence] = await Promise.all([
    glEvidenceForBuyer(deal.id, accessLevel, accessId), // gl; null when nothing published
    // buyerFigureInputs(deal, accessLevel),             // dd (returns null until dd merges)
  ]);
  return { glEvidence, figures: null };
}
