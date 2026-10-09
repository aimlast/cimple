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
 * Facts are cached 30 s per (deal, filters, last write in this process) —
 * server/engagement/facts-cache.ts, shared with the call list and buyer lists.
 */
import type { Express } from "express";
import type { BuyerAccessEvent, Deal } from "@shared/schema";
import {
  parseEngagementFilters,
  type EngagementFilters,
  type CimMode,
  type CimVariant,
  type EngagementRenditionResponse,
  type MarkContactedResponse,
} from "@shared/analytics-v2";
import { dealPublishedForBuyers } from "@shared/buyer-publish-gate";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes.js";
import { storage } from "../storage";
import { getDealAccess } from "../engagement/access";
import { decisionHistory, loadTitleSources, readingSource, type CaptureFacts } from "../engagement/facts";
import { pageTitle, titleIndex } from "../engagement/titles";
import { NAMED_ACCESS_LEVEL } from "@shared/cim-layouts";
import {
  buildBuyersResponse,
  buildDocumentResponse,
  buildJourneyResponse,
  buildSummaryResponse,
} from "../engagement/responses";
import { invalidateBrokerEngagement } from "./engagement-insights";
import { cachedDealReadingFacts, invalidateDealFacts } from "../engagement/facts-cache";
import { liveRendition } from "../engagement/legacy";

const BASE = "/api/deals/:dealId/engagement";

/** Reading facts for a deal and filter set — cached briefly (the tab polls every 20 s). */
const factsFor = (deal: Deal, filters: EngagementFilters): Promise<CaptureFacts> => cachedDealReadingFacts(deal, filters);
/** Forget a deal's cached facts (a broker action changed what they show). */
const invalidate = invalidateDealFacts;

export function registerEngagementRoutes(app: Express): void {
  app.get(`${BASE}/summary`, requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const facts = await factsFor(deal, parseEngagementFilters(req.query as Record<string, unknown>));
      res.json(buildSummaryResponse(facts, dealPublishedForBuyers(deal), deal.businessName));
    } catch (err) {
      console.error("[engagement] summary", err);
      res.status(500).json({ error: "Couldn't load buyer engagement" });
    }
  });

  app.get(`${BASE}/buyers`, requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const facts = await factsFor(res.locals.deal as Deal, parseEngagementFilters(req.query as Record<string, unknown>));
      res.json(buildBuyersResponse(facts));
    } catch (err) {
      console.error("[engagement] buyers", err);
      res.status(500).json({ error: "Couldn't load buyer engagement" });
    }
  });

  app.get(`${BASE}/document`, requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const facts = await factsFor(res.locals.deal as Deal, parseEngagementFilters(req.query as Record<string, unknown>));
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
      let row = await readingSource().rendition(deal.id, rid);
      if (!row) {
        // Old-tracker reading is drawn on the CIM as it would be served now
        // (server/engagement/legacy.ts): that version isn't stored — rebuild it.
        // Broker side: a CIM held from buyers is drawn as they will get it (ignoreHold).
        const levels = Array.from(new Set([...(await storage.getBuyerAccessByDeal(deal.id)).map((a) => a.accessLevel), NAMED_ACCESS_LEVEL]));
        for (const level of levels) {
          const lr = await liveRendition(deal, level, new Date(), { ignoreHold: true });
          if (lr?.raw.id === rid) { row = lr.row; break; }
        }
      }
      if (!row) return res.status(404).json({ error: "Not found" });
      // Real (named) titles, broker side: the served page's own (titles.ts) —
      // never the title of a section that continues it after a regeneration.
      const [live, stored] = await Promise.all([storage.getCimSectionsByDeal(deal.id), readingSource().renditions(deal.id)]);
      const pages = row.pageIndex ?? [];
      const titles = titleIndex(await loadTitleSources(deal, live, stored, row, new Map([[row.id, pages]])));
      const realTitles: Record<string, string> = {};
      for (const p of pages) realTitles[p.pageId] = pageTitle(p, row.mode as CimMode, titles).title || p.servedTitle;
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
      const [facts, decisions] = await Promise.all([factsFor(deal, filters), decisionHistory(deal.id, access.id).catch(() => [])]);
      const journey = buildJourneyResponse(facts, access.id, decisions);
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
      invalidate(deal.id);
      // The cross-deal call list shows "Contacted today" at once, not after its cache expires.
      if (req.session.brokerId) invalidateBrokerEngagement(req.session.brokerId);
      const body: MarkContactedResponse = { ok: true, contactedAt: at };
      res.json(body);
    } catch (err) {
      console.error("[engagement] contacted", err);
      res.status(500).json({ error: "Couldn't save that" });
    }
  });
}
