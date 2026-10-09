/**
 * Interview together + the coverage board (specs/together.md §7.2).
 *
 *   GET    /api/deals/:dealId/coverage-board?audience=broker|screen      the board (never calls a model, starts nothing)
 *   GET    /api/deals/:dealId/coverage-board/items/:itemId?audience=     popover detail
 *   POST   /api/deals/:dealId/coverage-board/items/:itemId/marks         {kind: verify_later|note|doc_promised, note?}
 *   DELETE /api/deals/:dealId/coverage-board/items/:itemId/marks/:kind
 *   POST   /api/deals/:dealId/coverage-board/items/:itemId/confirm       ✓ Confirmed (a "confirmed" mark; a lead is vouched for)
 *   GET    /api/seller/:token/coverage                                    the seller's "What we've covered" (statuses only)
 *
 * Tenancy: every broker route is requireBroker + requireOwnedDeal (404 for
 * another brokerage's deal); the seller route checks the invite token.
 * Rate limits: server/together/limits.ts (mounted in server/index.ts).
 */
import type { Express, Request, Response } from "express";
import type { CoverageAudience, CoverageMarkKind } from "@shared/coverage-board";
import type { Deal } from "@shared/schema";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes.js";
import { storage } from "../storage";
import { buildCoverageBoard, itemDetail, loadCoverageInputs } from "../interview/coverage-board";
import { BROKER_MARK_KINDS, ITEM_ID_RE, MARK_KINDS, MARK_NOTE_MAX, clearMark, setMark } from "../together/marks";
import { BoardActionError, confirmItem } from "../together/capture-apply";

function brokerAudience(req: Request): Exclude<CoverageAudience, "seller"> {
  return req.query.audience === "screen" ? "screen" : "broker";
}

function itemIdParam(req: Request): string | null {
  const id = String(req.params.itemId ?? "");
  return ITEM_ID_RE.test(id) ? id : null;
}

function fail(res: Response, err: unknown, fallback: string) {
  if (err instanceof BoardActionError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
  console.error(`[together] ${fallback}:`, (err as Error)?.message ?? err);
  return res.status(500).json({ error: fallback });
}

export function registerTogetherRoutes(app: Express): void {
  app.get("/api/deals/:dealId/coverage-board", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      res.json(await buildCoverageBoard(deal, { audience: brokerAudience(req) }));
    } catch (err) {
      fail(res, err, "Couldn't load the checklist");
    }
  });

  app.get("/api/deals/:dealId/coverage-board/items/:itemId", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const itemId = itemIdParam(req);
      if (!itemId) return res.status(400).json({ error: "That isn't a checklist item" });
      const detail = itemDetail(await loadCoverageInputs(res.locals.deal as Deal), brokerAudience(req), itemId);
      if (!detail) return res.status(404).json({ error: "That data point isn't on the checklist any more." });
      res.json(detail);
    } catch (err) {
      fail(res, err, "Couldn't load that data point");
    }
  });

  app.post("/api/deals/:dealId/coverage-board/items/:itemId/marks", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const itemId = itemIdParam(req);
      if (!itemId) return res.status(400).json({ error: "That isn't a checklist item" });
      const kind = String(req.body?.kind ?? "") as CoverageMarkKind;
      if (!BROKER_MARK_KINDS.includes(kind)) return res.status(400).json({ error: "That isn't a mark the board can set" });
      if ((kind === "doc_promised") !== itemId.startsWith("doc:")) return res.status(400).json({ error: "That mark doesn't fit this item" });
      const note = typeof req.body?.note === "string" ? req.body.note : null;
      if (kind === "note" && !note?.trim()) return res.status(400).json({ error: "Write the note first" });
      if (note && note.length > MARK_NOTE_MAX) return res.status(400).json({ error: "That note is too long" });
      const sectionKey = itemId.includes(":") && !/^(doc|routed):/.test(itemId) ? itemId.split(":")[0] : null;
      await setMark({
        dealId: req.params.dealId,
        itemId,
        kind,
        sectionKey,
        note: kind === "note" ? note : null,
        sittingId: typeof req.body?.sittingId === "string" ? req.body.sittingId.slice(0, 64) : null,
        createdBy: String(req.session.brokerId),
      });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, "Couldn't save that");
    }
  });

  app.delete("/api/deals/:dealId/coverage-board/items/:itemId/marks/:kind", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const itemId = itemIdParam(req);
      if (!itemId) return res.status(400).json({ error: "That isn't a checklist item" });
      const kind = String(req.params.kind ?? "") as CoverageMarkKind;
      if (!MARK_KINDS.includes(kind) || kind === "asked") return res.status(400).json({ error: "That isn't a mark the board can clear" });
      const cleared = await clearMark(req.params.dealId, itemId, kind);
      res.json({ ok: true, cleared });
    } catch (err) {
      fail(res, err, "Couldn't clear that");
    }
  });

  app.post("/api/deals/:dealId/coverage-board/items/:itemId/confirm", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const itemId = itemIdParam(req);
      if (!itemId || /^(doc|routed):/.test(itemId)) return res.status(400).json({ error: "That isn't a data point" });
      const deal = res.locals.deal as Deal;
      const board = await confirmItem(deal, itemId, String(req.session.brokerId), {
        sittingId: typeof req.body?.sittingId === "string" ? req.body.sittingId.slice(0, 64) : null,
        reload: async () => (await storage.getDeal(deal.id)) ?? deal,
      });
      res.json({ ok: true, board });
    } catch (err) {
      fail(res, err, "Couldn't confirm that");
    }
  });

  // The seller's "What we've covered" (statuses and counts only — no values,
  // sources, reasons or notes; broker-added labels hidden).
  app.get("/api/seller/:token/coverage", async (req, res) => {
    try {
      const invite = await storage.getSellerInviteByToken(req.params.token);
      if (!invite) return res.status(404).json({ error: "Invite not found" });
      const deal = await storage.getDeal(invite.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      res.json(await buildCoverageBoard(deal, { audience: "seller" }));
    } catch (err) {
      fail(res, err, "Couldn't load your progress");
    }
  });
}
