/**
 * Staff-private matters held back from the CIM (server/cim/staff-private.ts).
 *
 *   GET  /api/deals/:dealId/cim-held-private            the held items, each with its include switch
 *   POST /api/deals/:dealId/cim-held-private/:itemId    { include: boolean } — back into the CIM inputs
 *                                                       on the next generation (or out again)
 *
 * Broker-only (requireBroker + requireOwnedDeal). No model call.
 */
import type { Express } from "express";
import type { Deal } from "@shared/schema";
import { STAFF_PRIVATE_ID_RE } from "@shared/staff-private";
import { requireBroker, requireOwnedDeal, getOwnedDeal } from "../broker-auth/routes";
import { heldPrivateForDeal, setHeldPrivateIncluded } from "../cim/held-private";

export function registerCimHeldPrivateRoutes(app: Express): void {
  app.get("/api/deals/:dealId/cim-held-private", requireBroker, requireOwnedDeal, async (_req, res) => {
    try {
      res.json({ items: heldPrivateForDeal(res.locals.deal as Deal) });
    } catch (err) {
      console.error("[cim-held-private] list failed:", err);
      res.status(500).json({ error: "Couldn't load what the CIM holds back" });
    }
  });

  app.post("/api/deals/:dealId/cim-held-private/:itemId", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const id = String(req.params.itemId || "");
      const include = req.body?.include;
      if (!STAFF_PRIVATE_ID_RE.test(id) || typeof include !== "boolean") return res.status(400).json({ error: "Send { include: true | false } for a held item" });
      // Only an item the CIM actually holds can be switched in (switching out always works).
      if (include && !heldPrivateForDeal(deal).some((i) => i.id === id)) return res.status(404).json({ error: "That item is no longer held back — the facts have changed. Refresh the page." });
      await setHeldPrivateIncluded(deal.id, id, include);
      const fresh = (await getOwnedDeal(deal.id, req.session.brokerId)) ?? deal;
      res.json({ items: heldPrivateForDeal(fresh) });
    } catch (err) {
      console.error("[cim-held-private] update failed:", err);
      res.status(500).json({ error: "Couldn't save that choice" });
    }
  });
}
