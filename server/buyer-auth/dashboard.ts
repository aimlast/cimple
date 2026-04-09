/**
 * Buyer Dashboard
 *
 * Returns all CIMs a buyer has access to, enriched with:
 *   - deal metadata (industry, asking price, business name)
 *   - broker firm name
 *   - match info: count of criteria matched + top matching dimensions
 *
 * Match labelling is intentionally positive/specific:
 *   - Raw count of criteria matched ("7 criteria matched") — no letter grades
 *   - Top 3 matching dimensions as chips ("Industry · Size · Geography")
 *   - Never percentages or ranks that could discourage buyers
 */
import type { Express } from "express";
import { storage } from "../storage";
import { requireBuyer } from "./routes.js";
import { matchBuyerToDeal } from "../matching/engine.js";

interface DashboardDeal {
  dealId: string;
  businessName: string;
  industry: string | null;
  subIndustry: string | null;
  askingPrice: string | null;
  location: string | null;
  description: string | null;
  brokerFirm: string | null;
  accessToken: string;
  accessLevel: string;
  ndaSigned: boolean;
  lastAccessedAt: string | null;
  match: {
    criteriaMatched: number;     // raw count — the only number we show
    criteriaTested: number;
    topDimensions: string[];     // e.g. ["Industry", "Size", "Geography"]
    dataCompleteness: number;    // how much we know about this deal
  } | null;
}

// Map internal match category keys to friendly buyer-facing labels
const DIMENSION_LABELS: Record<string, string> = {
  financialFit: "Financials",
  industryFit: "Industry",
  locationFit: "Location",
  operationalFit: "Operations",
  dealStructureFit: "Deal structure",
  qualificationFit: "Qualification",
};

function topMatchingDimensions(breakdown: any, limit = 3): string[] {
  if (!breakdown) return [];
  const entries: Array<[string, number]> = [];
  for (const key of Object.keys(DIMENSION_LABELS)) {
    const cat = breakdown[key];
    if (cat && cat.max > 0) {
      const pct = (cat.score / cat.max) * 100;
      if (pct >= 60) entries.push([DIMENSION_LABELS[key], pct]);
    }
  }
  entries.sort((a, b) => b[1] - a[1]);
  return entries.slice(0, limit).map((e) => e[0]);
}

export function registerBuyerDashboardRoutes(app: Express) {
  // GET dashboard — full list of CIMs for this buyer
  app.get("/api/buyer-auth/dashboard", requireBuyer, async (req, res) => {
    try {
      const buyerUserId = req.session.buyerId!;
      const buyer = await storage.getBuyerUser(buyerUserId);
      if (!buyer) return res.status(404).json({ error: "Account not found" });

      // Find all buyerAccess rows linked to this buyer (by user id OR email)
      const byUser = await storage.getBuyerAccessByBuyerUser(buyerUserId);

      // Dedupe + enrich
      const seen = new Set<string>();
      const dashboardDeals: DashboardDeal[] = [];

      for (const access of byUser) {
        if (seen.has(access.dealId)) continue;
        seen.add(access.dealId);

        const deal = await storage.getDeal(access.dealId);
        if (!deal) continue;

        // Try to pull broker firm name from branding settings
        let brokerFirm: string | null = null;
        if (deal.brokerId) {
          try {
            const branding = await storage.getBrandingByBroker(deal.brokerId);
            brokerFirm = (branding as any)?.companyName || null;
          } catch {}
        }

        // Compute match using the buyer's profile criteria
        let match: DashboardDeal["match"] = null;
        try {
          // Merge top-level buyer profile fields into the criteria object
          // so the matching engine sees industries, locations, etc.
          const criteria: any = {
            ...(buyer.buyerCriteria as any || {}),
            targetIndustries: buyer.targetIndustries || [],
            targetLocations: buyer.targetLocations || [],
          };
          const result = await matchBuyerToDeal(
            criteria,
            {
              industry: deal.industry || "",
              subIndustry: (deal as any).subIndustry,
              askingPrice: (deal as any).askingPrice,
              extractedInfo: (deal as any).extractedInfo || {},
            },
            { skipAI: true },
          );
          match = {
            criteriaMatched: result.criteriaMatched,
            criteriaTested: result.criteriaTested,
            topDimensions: topMatchingDimensions(result),
            dataCompleteness: result.dataCompleteness,
          };
        } catch (err) {
          // Match failure is non-fatal — deal still shows in dashboard
        }

        // Extract asking price + location from extractedInfo if missing
        const extracted: any = (deal as any).extractedInfo || {};
        const location = extracted?.locationSite?.primaryLocation
          || extracted?.locationSite?.city
          || extracted?.locationSite?.state
          || null;

        dashboardDeals.push({
          dealId: deal.id,
          businessName: deal.businessName,
          industry: deal.industry || null,
          subIndustry: (deal as any).subIndustry || null,
          askingPrice: (deal as any).askingPrice || null,
          location,
          description: (deal as any).description || extracted?.executiveSummary || null,
          brokerFirm,
          accessToken: access.accessToken,
          accessLevel: access.accessLevel,
          ndaSigned: !!access.ndaSigned,
          lastAccessedAt: access.lastAccessedAt ? new Date(access.lastAccessedAt).toISOString() : null,
          match,
        });
      }

      // Sort: highest criteriaMatched first, then most recent access
      dashboardDeals.sort((a, b) => {
        const am = a.match?.criteriaMatched ?? 0;
        const bm = b.match?.criteriaMatched ?? 0;
        if (bm !== am) return bm - am;
        const at = a.lastAccessedAt ? new Date(a.lastAccessedAt).getTime() : 0;
        const bt = b.lastAccessedAt ? new Date(b.lastAccessedAt).getTime() : 0;
        return bt - at;
      });

      res.json({
        deals: dashboardDeals,
        profileCompletionPct: buyer.profileCompletionPct || 0,
      });
    } catch (error: any) {
      console.error("Buyer dashboard error:", error);
      res.status(500).json({ error: "Failed to load dashboard" });
    }
  });
}
