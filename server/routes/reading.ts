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
 * Answer: 204 (accepted). The buyer learns nothing from the response.
 * Rate limit: server/index.ts (per link, not the AI limiter).
 */
import express, { type Express } from "express";
import { READING_RULES, readingPayloadSchema, type ReadingPayload } from "@shared/analytics-v2";
import { dealPublishedForBuyers } from "@shared/buyer-publish-gate";
import { ndaBlocksBuyer } from "@shared/cim-buyer-view";
import { storage } from "../storage";
import { viewLinkProblem } from "../buyers/view-access.js";

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
      // CAPTURE stream: ingestReading({ deal, access, payload, req }) — visit
      // upsert (GREATEST), rollups, events, clamp, self-view, view_count.
      void payload;
      res.status(204).end();
    } catch (err) {
      console.error("[reading] ingest", err);
      res.status(500).json({ error: "Failed" });
    }
  });
}
