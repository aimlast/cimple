/**
 * Data room (VDR) broker routes — vdr spec §9.2. Registered from
 * server/routes.ts.
 *
 * Wave 0 (the renderer canary) ships only:
 *   GET /api/vdr/health   broker session required →
 *     200 { renderer: "ok", node, pdfjs, canvas, disk: { cacheMb }, checkedAt, child }
 *     503 the same shape with `renderer` = the plain reason it failed
 * The data room's own routes arrive with its UI (later waves).
 */
import type { Express } from "express";
import { requireBroker } from "../broker-auth/routes.js";
import { vdrHealth } from "../vdr/health";

export function registerDataRoomRoutes(app: Express) {
  app.get("/api/vdr/health", requireBroker, async (_req, res) => {
    try {
      const health = await vdrHealth();
      res.setHeader("Cache-Control", "no-store");
      res.status(health.renderer === "ok" ? 200 : 503).json(health);
    } catch (err: any) {
      console.error("[vdr] health check failed:", err);
      res.status(503).json({ renderer: `renderer_unavailable: ${String(err?.message || err).slice(0, 200)}`, node: process.version });
    }
  });
}
