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
import { listedAskingPrice } from "../information/deal-mirror";
import type { Express } from "express";
import { storage } from "../storage";
import { requireBuyer } from "./routes.js";
import { matchBuyerToDeal } from "../matching/engine.js";
import { ndaBlocksBuyer } from "@shared/cim-buyer-view";
import { dashboardShowsLinkedDeals, viewLinkProblem } from "../buyers/view-access.js";
import { dealPublishedForBuyers } from "@shared/buyer-publish-gate";
import { isTeaserOnly, normalizeAccessLevel, seesNamedCim } from "@shared/access-levels";

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

      // Find all buyerAccess rows linked to this buyer. An account that never
      // proved its inbox (self-signup, unverified) sees none: anyone can
      // register someone else's address, and each card carries the link's
      // view token.
      const verified = dashboardShowsLinkedDeals(buyer);
      // A verified account also picks up links shared with its email that
      // were never linked (granted before it verified, or signed at the NDA
      // while it wasn't) — the dashboard is where the buyer expects them.
      if (verified) {
        await storage.linkBuyerAccessToVerifiedBuyer(buyerUserId).catch((err) => {
          console.warn("[buyer-dashboard] linking shared deals failed:", err?.message || err);
        });
      }
      const byUser = verified ? await storage.getBuyerAccessByBuyerUser(buyerUserId) : [];

      // Dedupe + enrich
      const seen = new Set<string>();
      const dashboardDeals: DashboardDeal[] = [];

      for (const access of byUser) {
        // Revoked or expired links are not opportunities — the card would
        // link straight into a view room that rejects the token.
        if (viewLinkProblem(access)) continue;
        // A Teaser link reads the teaser, not the CIM: its card comes with the
        // teaser document (it needs the teaser to be published, not the CIM).
        if (isTeaserOnly(access.accessLevel)) continue;
        if (seen.has(access.dealId)) continue;
        seen.add(access.dealId);

        const deal = await storage.getDeal(access.dealId);
        // Unpublished CIMs don't show on the buyer's dashboard (shared/buyer-publish-gate.ts).
        if (!deal || !dealPublishedForBuyers(deal)) continue;

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
              description: (deal as any).description ?? null,
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

        // Blind CIM buyers — the dashboard card must not reveal what the view
        // room withholds (name, location, description).
        const blind = !seesNamedCim(access.accessLevel);
        dashboardDeals.push({
          dealId: deal.id,
          businessName: blind ? ((deal as any).blindCodename || "Confidential Opportunity") : deal.businessName,
          industry: deal.industry || null,
          subIndustry: (deal as any).subIndustry || null,
          // The broker's listed price only (never a seller's expectation).
          askingPrice: listedAskingPrice(deal),
          location: blind ? null : location,
          // CIM-derived text waits for a required NDA, as in the view room.
          description: blind || ndaBlocksBuyer(deal, access) ? null : ((deal as any).description || extracted?.executiveSummary || null),
          brokerFirm,
          accessToken: access.accessToken,
          accessLevel: normalizeAccessLevel(access.accessLevel),
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
        // The dashboard explains how to confirm the email (password reset).
        emailUnverified: !verified,
      });
    } catch (error: any) {
      console.error("Buyer dashboard error:", error);
      res.status(500).json({ error: "Failed to load dashboard" });
    }
  });
}
