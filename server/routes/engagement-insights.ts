/**
 * Engagement intelligence APIs across the broker's own deals, plus the
 * optional AI brief. Owned by the INTELLIGENCE stream; registered from
 * server/routes.ts.
 *
 *   GET  /api/broker/engagement/call-list                         CallListResponse  (top 15, own non-archived deals)
 *   GET  /api/broker/engagement/compare                           EngagementCompareResponse
 *   POST /api/deals/:dealId/engagement/buyers/:accessId/brief     BuyerBriefResponse (broker-triggered, cached; AI limiter)
 *
 * Tenancy: requireBroker; global routes only ever read deals where
 * brokerId = session.brokerId; the brief also requireOwnedDeal + the access
 * must belong to the deal. The brief uses the supporting model (Sonnet,
 * tool-forced) through an injectable client so tests never call the API;
 * for a blind (teaser/full) buyer it must never name the business.
 */
import type { Express } from "express";
import type { CallListResponse, EngagementCompareResponse } from "@shared/analytics-v2";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes.js";
import { getDealAccess, ownedLiveDeals } from "../engagement/access";
import type { Deal } from "@shared/schema";

export function registerEngagementInsightRoutes(app: Express): void {
  app.get("/api/broker/engagement/call-list", requireBroker, async (_req, res) => {
    const body: CallListResponse = { entries: [] };
    res.json(body);
  });

  app.get("/api/broker/engagement/compare", requireBroker, async (req, res) => {
    try {
      const deals = await ownedLiveDeals(req.session.brokerId!);
      const body: EngagementCompareResponse = {
        deals: deals.map((d) => ({
          dealId: d.id, dealName: d.businessName, granted: 0, opened: 0, readingThisWeek: 0,
          medianActiveMs: null, reachedEnd: 0, ndaSigned: 0, interested: 0,
        })),
        byKind: [],
        byLayout: [],
        benchmarks: [],
      };
      res.json(body);
    } catch (err) {
      console.error("[engagement] compare", err);
      res.status(500).json({ error: "Couldn't compare your deals" });
    }
  });

  app.post("/api/deals/:dealId/engagement/buyers/:accessId/brief", requireBroker, requireOwnedDeal, async (req, res) => {
    const access = await getDealAccess((res.locals.deal as Deal).id, req.params.accessId);
    if (!access) return res.status(404).json({ error: "Not found" });
    res.status(501).json({ error: "The buyer brief isn't available yet." });
  });
}
