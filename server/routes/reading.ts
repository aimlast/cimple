/**
 * POST /api/view/:token/reading — the view room's reading tracker sends its
 * cumulative per-visit counters here (shared/analytics-v2.ts ReadingPayload),
 * by fetch every ~15 s and by navigator.sendBeacon when the tab hides or
 * closes. Named "reading" (not analytics/track/beacon) so common blockers
 * leave it alone. Owned by the CAPTURE stream (server/analytics/reading-ingest.ts
 * does the writes); registered from server/routes.ts.
 *
 * Gates (base, kept by the implementation):
 *   - the token must be a usable link (not revoked/expired) on a published deal;
 *   - NDA required and not signed → 204, nothing stored (never 4xx: the
 *     tracker must not retry, and nothing is revealed);
 *   - the body is text/plain JSON (a beacon) or application/json, ≤ 64 KB,
 *     validated with readingPayloadSchema → 400 when malformed.
 * Then server/analytics/reading-ingest.ts stores it: 400 for a rendition or
 * page this buyer was never served, 409 for a visit id of another link.
 * Answer: 204 (accepted). The buyer learns nothing from the response.
 * Rate limit: server/index.ts (per link, not the AI limiter).
 */
import express, { type Express } from "express";
import { READING_RULES, readingPayloadSchema, type ReadingPayload } from "@shared/analytics-v2";
import { dealPublishedForBuyers } from "@shared/buyer-publish-gate";
import { ndaBlocksBuyer } from "@shared/cim-buyer-view";
import { storage } from "../storage";
import { viewLinkProblem } from "../buyers/view-access.js";
import { dbReadingStore, ingestReading, networkKey, uaFamilyOf, type ReadingStore } from "../analytics/reading-ingest";

let store: ReadingStore = dbReadingStore;
/** Tests: swap in an in-memory store (server/analytics/reading-ingest.ts memoryReadingStore). */
export function setReadingStore(s: ReadingStore): void {
  store = s;
}

const textBody = express.text({ type: "text/plain", limit: READING_RULES.maxBodyBytes });

export function registerReadingRoutes(app: Express): void {
  app.post("/api/view/:token/reading", textBody, async (req, res) => {
    try {
      const access = await storage.getBuyerAccessByToken(req.params.token);
      if (!access || viewLinkProblem(access)) return res.status(404).json({ error: "Not found" });
      const deal = await storage.getDeal(access.dealId);
      if (!deal || !dealPublishedForBuyers(deal)) return res.status(404).json({ error: "Not found" });
      if (ndaBlocksBuyer(deal, access)) return res.status(204).end();

      let raw: unknown = req.body;
      if (typeof raw === "string") {
        try { raw = JSON.parse(raw); } catch { return res.status(400).json({ error: "Malformed" }); }
      }
      const parsed = readingPayloadSchema.safeParse(raw);
      if (!parsed.success) return res.status(400).json({ error: "Malformed" });
      const payload: ReadingPayload = parsed.data as ReadingPayload;
      // The owning broker previewing the room: stored, excluded everywhere, never a view.
      const sessionBroker = (req as { session?: { brokerId?: string } }).session?.brokerId;
      const result = await ingestReading(store, {
        deal: { id: deal.id },
        access: { id: access.id, dealId: access.dealId, accessLevel: access.accessLevel },
        payload,
        now: new Date(),
        selfView: !!sessionBroker && sessionBroker === deal.brokerId,
        ipHash: networkKey(deal.id, req.ip || req.socket?.remoteAddress || null),
        uaFamily: uaFamilyOf(typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null),
      });
      if (result.status !== 204) return res.status(result.status).json({ error: result.status === 409 ? "Conflict" : "Malformed" });
      res.status(204).end();
    } catch (err) {
      console.error("[reading] ingest", err);
      res.status(500).json({ error: "Failed" });
    }
  });
}
