/**
 * Figure notes and due-diligence checks — broker routes (stream "dd", spec §9.2).
 * Every route: requireBroker + requireOwnedDeal; ids are looked up WITH the
 * deal id; GETs never write.
 *
 * Pass 1 (this file so far):
 *   GET  /api/deals/:dealId/figure-layer?level=<access level>   the builder's buyer preview (D21)
 *   GET  /api/deals/:dealId/figures/status                      poll target while a refresh/build runs
 *   POST /api/deals/:dealId/figures/refresh                     deterministic refresh now ($0)
 * The workspace routes (notes, checks, publish, settings, questions) follow in pass 2.
 */
import type { Express } from "express";
import type { CimSection, Deal } from "@shared/schema";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes.js";
import { storage } from "../storage";
import { buildBuyerCim } from "@shared/cim-buyer-view";
import { cimModeForAccessLevel, isTeaserOnly, parseAccessLevelInput } from "@shared/access-levels";
import { DD_SOURCE_CHECK_PAGE_ID } from "@shared/figure-layer";
import { listedAskingPrice } from "../information/deal-mirror";
import { loadMediaAssets } from "../cim/media-store";
import { figureInputsFor, loadFigureRaw } from "../cim/figures/serve";
import { getFigureState } from "../cim/figures/store";
import { refreshFingerprint, runFigureRefresh, scheduleFigureRefresh } from "../cim/figures/refresh";

const BASE = "/api/deals/:dealId";

/** At most one manual refresh per deal every 30 s (a second click joins the running one). */
const lastManual = new Map<string, number>();

export function registerFigureRoutes(app: Express): void {
  /**
   * The broker's preview of a buyer version: the figure layer over exactly the
   * sections the builder previews (working copy + that version's overrides),
   * with everything shown and `preview` marks on what buyers don't see yet.
   * Returns the extra page ("How the figures check out") to insert in DD.
   */
  app.get(`${BASE}/figure-layer`, requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const level = parseAccessLevelInput(req.query.level);
      if (!level) return res.status(400).json({ error: "Choose which buyer to preview as." });
      if (isTeaserOnly(level)) return res.json({ layer: null, extraSections: [], refreshing: false });
      const mode = cimModeForAccessLevel(level);
      const [raw, sections, overrides, media, state, fingerprint] = await Promise.all([
        loadFigureRaw(deal.id),
        storage.getCimSectionsByDeal(deal.id),
        mode === "normal" ? Promise.resolve([]) : storage.getCimSectionOverrides(deal.id, mode),
        loadMediaAssets(deal.id),
        getFigureState(deal.id),
        refreshFingerprint(deal.id),
      ]);
      const figures = figureInputsFor(raw, { audience: "broker", mode });
      // The level as the client sent it (validated above): legacy keys
      // ("loi", "full") and new ones read the same through the registry.
      const view = buildBuyerCim({
        deal, accessLevel: String(req.query.level), sections: sections as CimSection[], overrides, media, askingPrice: listedAskingPrice(deal), figures,
      });
      const stale = state?.refreshedFingerprint !== fingerprint;
      // Never a write in a GET: a stale deal is refreshed in the background.
      if (stale) scheduleFigureRefresh(deal.id, "preview");
      const i = view.sections.findIndex((s) => s.id === DD_SOURCE_CHECK_PAGE_ID);
      const extraSections = i >= 0 ? [{ afterId: i > 0 ? view.sections[i - 1].id : null, section: view.sections[i] }] : [];
      res.json({
        layer: view.figureLayer,
        extraSections,
        refreshing: stale,
        ...(view.figureLayerDropped ? { dropped: view.figureLayerDropped } : {}),
        noFigures: raw.noFigures,
        hasOtherRecords: raw.sources.some((s) => s.kind !== "statements"),
      });
    } catch (err) {
      console.error("[figures] preview layer", err);
      res.status(500).json({ error: "Couldn't load the figure notes for this preview." });
    }
  });

  app.get(`${BASE}/figures/status`, requireBroker, requireOwnedDeal, async (_req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const state = await getFigureState(deal.id);
      res.json({
        build: state?.build ?? null,
        refreshedAt: state?.refreshedAt ?? null,
        version: state?.updatedAt ?? null,
      });
    } catch (err) {
      console.error("[figures] status", err);
      res.status(500).json({ error: "Couldn't load the status." });
    }
  });

  app.post(`${BASE}/figures/refresh`, requireBroker, requireOwnedDeal, async (_req, res) => {
    const deal = res.locals.deal as Deal;
    const last = lastManual.get(deal.id) ?? 0;
    if (Date.now() - last < 30_000) {
      runFigureRefresh(deal.id).catch(() => {});
      return res.status(202).json({ started: false, running: true });
    }
    lastManual.set(deal.id, Date.now());
    try {
      const r = await runFigureRefresh(deal.id);
      res.json({ ok: true, located: r.located, written: r.written, proposals: r.proposals, removed: r.removed });
    } catch (err) {
      console.error("[figures] refresh", err);
      res.status(500).json({ error: "Cimple couldn't check the numbers just now. Try again in a minute." });
    }
  });
}
