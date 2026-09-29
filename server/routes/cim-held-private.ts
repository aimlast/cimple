/**
 * Staff-private matters held back from the CIM (server/cim/staff-private.ts).
 *
 *   GET  /api/deals/:dealId/cim-held-private            the held items, each with its include switch
 *   POST /api/deals/:dealId/cim-held-private/:itemId    { include: boolean } — back into the CIM inputs
 *                                                       on the next generation (or out again)
 *   POST /api/deals/:dealId/cim-held-private/withdraw/:sectionId
 *                                                       take a section out of the kept copy buyers read
 *                                                       while a live CIM's update waits for review
 *
 * Broker-only (requireBroker + requireOwnedDeal). No model call.
 */
import type { Express } from "express";
import type { Deal } from "@shared/schema";
import { STAFF_PRIVATE_ID_RE } from "@shared/staff-private";
import { requireBroker, requireOwnedDeal, getOwnedDeal } from "../broker-auth/routes";
import { storage } from "../storage";
import { heldPrivateForDeal, heldPrivateStateForDeal, servedHeldPrivateForDeal, setHeldPrivateIncluded } from "../cim/held-private";
import { withdrawFromPublishedSnapshot } from "../cim/published-snapshot";
import { servesPublishedSnapshot } from "@shared/cim-buyer-view";

/**
 * The list, plus the written sections that still state a held item (they
 * need regenerating), plus what buyers are still SERVED that states one —
 * the kept copy during a live CIM's review, or a changed section's approved
 * version (they need publishing, or the section hiding).
 */
async function stateFor(deal: Deal) {
  const sections = await storage.getCimSectionsByDeal(deal.id).catch(() => []);
  const { items, showing } = heldPrivateStateForDeal(deal, sections);
  const served = await servedHeldPrivateForDeal(deal, sections, items).catch((err) => {
    console.warn("[cim-held-private] served-version scan failed:", err);
    return { source: null, showing: [] };
  });
  const brief = (s: { id: string; title: string; descriptions: string[] }) => ({ id: s.id, title: s.title, descriptions: s.descriptions });
  return {
    items,
    showing: showing.map(brief),
    servedShowing: served.showing.map(brief),
    servedFrom: served.showing.length > 0 ? served.source : null,
  };
}

export function registerCimHeldPrivateRoutes(app: Express): void {
  app.get("/api/deals/:dealId/cim-held-private", requireBroker, requireOwnedDeal, async (_req, res) => {
    try {
      res.json(await stateFor(res.locals.deal as Deal));
    } catch (err) {
      console.error("[cim-held-private] list failed:", err);
      res.status(500).json({ error: "Couldn't load what the CIM holds back" });
    }
  });

  // Take a section out of the copy buyers read while a regenerated live CIM
  // waits for review (the draft is untouched; publishing replaces the copy).
  app.post("/api/deals/:dealId/cim-held-private/withdraw/:sectionId", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      if (!servesPublishedSnapshot(deal)) {
        return res.status(409).json({ error: "Buyers aren't reading a kept copy of this CIM — hide the section in the CIM builder instead." });
      }
      const ok = await withdrawFromPublishedSnapshot(deal.id, String(req.params.sectionId || ""));
      if (!ok) return res.status(404).json({ error: "That section isn't in the version buyers are reading." });
      res.json(await stateFor(deal));
    } catch (err) {
      console.error("[cim-held-private] withdraw failed:", err);
      res.status(500).json({ error: "Couldn't take that section away from buyers" });
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
      res.json(await stateFor(fresh));
    } catch (err) {
      console.error("[cim-held-private] update failed:", err);
      res.status(500).json({ error: "Couldn't save that choice" });
    }
  });
}
