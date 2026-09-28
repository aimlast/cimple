/**
 * Broker engagement APIs — how buyers read one deal's CIM
 * (shared/analytics-v2.ts has every response shape). Owned by the CAPTURE
 * stream (aggregation); judgement comes from server/engagement/insights.ts
 * (INTELLIGENCE). Registered from server/routes.ts.
 *
 *   GET  /api/deals/:dealId/engagement/summary                     EngagementSummaryResponse
 *   GET  /api/deals/:dealId/engagement/buyers?<filters>            EngagementBuyersResponse
 *   GET  /api/deals/:dealId/engagement/document?<filters>          EngagementDocumentResponse
 *   GET  /api/deals/:dealId/engagement/renditions/:renditionId     EngagementRenditionResponse
 *   GET  /api/deals/:dealId/engagement/buyers/:accessId/journey    BuyerJourneyResponse
 *   POST /api/deals/:dealId/engagement/buyers/:accessId/contacted  MarkContactedResponse
 *
 * Tenancy: requireBroker + requireOwnedDeal on every route; an accessId or
 * renditionId must belong to the deal (else 404, like a missing deal).
 * Filters: parseEngagementFilters(req.query) — lenient, unknown → defaults.
 */
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { cimRenditions, type BuyerAccessEvent, type Deal } from "@shared/schema";
import {
  parseEngagementFilters,
  type CimMode,
  type CimVariant,
  type EngagementRenditionResponse,
  type MarkContactedResponse,
} from "@shared/analytics-v2";
import { dealPublishedForBuyers } from "@shared/buyer-publish-gate";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes.js";
import { storage } from "../storage";
import { getDealAccess } from "../engagement/access";
import { loadDealReadingFacts } from "../engagement/facts";
import {
  buildBuyersResponse,
  buildDocumentResponse,
  buildJourneyResponse,
  buildSummaryResponse,
} from "../engagement/responses";

const BASE = "/api/deals/:dealId/engagement";

export function registerEngagementRoutes(app: Express): void {
  app.get(`${BASE}/summary`, requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const facts = await loadDealReadingFacts(deal, parseEngagementFilters(req.query as Record<string, unknown>));
      res.json(buildSummaryResponse(facts, dealPublishedForBuyers(deal), deal.businessName));
    } catch (err) {
      console.error("[engagement] summary", err);
      res.status(500).json({ error: "Couldn't load buyer engagement" });
    }
  });

  app.get(`${BASE}/buyers`, requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const facts = await loadDealReadingFacts(res.locals.deal as Deal, parseEngagementFilters(req.query as Record<string, unknown>));
      res.json(buildBuyersResponse(facts));
    } catch (err) {
      console.error("[engagement] buyers", err);
      res.status(500).json({ error: "Couldn't load buyer engagement" });
    }
  });

  app.get(`${BASE}/document`, requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const facts = await loadDealReadingFacts(res.locals.deal as Deal, parseEngagementFilters(req.query as Record<string, unknown>));
      res.json(buildDocumentResponse(facts));
    } catch (err) {
      console.error("[engagement] document", err);
      res.status(500).json({ error: "Couldn't load reading by page" });
    }
  });

  app.get(`${BASE}/renditions/:renditionId`, requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const rid = String(req.params.renditionId || "");
      if (!/^[0-9a-f]{32}$/.test(rid)) return res.status(404).json({ error: "Not found" });
      const [row] = await db.select().from(cimRenditions)
        .where(and(eq(cimRenditions.id, rid), eq(cimRenditions.dealId, deal.id)))
        .limit(1);
      if (!row) return res.status(404).json({ error: "Not found" });
      const live = await storage.getCimSectionsByDeal(deal.id);
      const realTitles: Record<string, string> = {};
      for (const s of live) realTitles[s.id] = s.sectionTitle;
      const body: EngagementRenditionResponse = {
        id: row.id,
        mode: row.mode as CimMode,
        variant: row.variant as CimVariant,
        createdAt: row.createdAt.toISOString(),
        sections: (row.sections as unknown[]) ?? [],
        design: row.design ?? null,
        pages: row.pageIndex ?? [],
        realTitles,
      };
      res.json(body);
    } catch (err) {
      console.error("[engagement] rendition", err);
      res.status(500).json({ error: "Couldn't load that version of the CIM" });
    }
  });

  app.get(`${BASE}/buyers/:accessId/journey`, requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const access = await getDealAccess(deal.id, req.params.accessId);
      if (!access) return res.status(404).json({ error: "Not found" });
      const filters = { ...parseEngagementFilters(req.query as Record<string, unknown>), buyers: [access.id] };
      const journey = buildJourneyResponse(await loadDealReadingFacts(deal, filters), access.id);
      if (!journey) return res.status(404).json({ error: "Not found" });
      res.json(journey);
    } catch (err) {
      console.error("[engagement] journey", err);
      res.status(500).json({ error: "Couldn't load this buyer's visits" });
    }
  });

  // "Mark contacted": recorded on the access row's broker-action history; the
  // call list drops the buyer's priority for 48 h and shows "Contacted today".
  app.post(`${BASE}/buyers/:accessId/contacted`, requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const access = await getDealAccess(deal.id, req.params.accessId);
      if (!access) return res.status(404).json({ error: "Not found" });
      const at = new Date().toISOString();
      const history = [...((access.accessEvents as BuyerAccessEvent[] | null) ?? []), { type: "contacted" as const, at }];
      await storage.updateBuyerAccess(access.id, { accessEvents: history } as any);
      const body: MarkContactedResponse = { ok: true, contactedAt: at };
      res.json(body);
    } catch (err) {
      console.error("[engagement] contacted", err);
      res.status(500).json({ error: "Couldn't save that" });
    }
  });
}
