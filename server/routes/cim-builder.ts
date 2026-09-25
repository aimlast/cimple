/**
 * CIM builder: add/delete/duplicate/rewrite sections, access tiers (workstream: cim-builder).
 * Registered from server/routes.ts (merge anchor) — keep this workstream's
 * new endpoints in this file.
 *
 * Every route requires a broker session and checks that the deal (or the
 * section's deal) belongs to that broker; section ids from another deal are
 * treated as not found. AI work (write / regenerate / rewrite / convert)
 * runs in the background — the request returns 202 and the builder polls
 * GET /api/deals/:dealId/cim-builder.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { cimSections, type CimSection, type CimSectionAiTask, type Deal } from "@shared/schema";
import {
  BUYER_ACCESS_LEVELS,
  canAiRewriteLayout,
  canAiWriteLayout,
  defaultLayoutData,
  getCimLayout,
  isCimLayoutKey,
  sameLayoutFamily,
  sectionTier,
} from "@shared/cim-layouts";
import { requireBroker, requireOwnedDeal, getOwnedDeal } from "../broker-auth/routes";
import {
  summarizeBlindRows,
  blindSectionError,
  retryBlindNow,
  invalidateBlind,
  scheduleBlindRefresh,
  redoSectionsBlind,
  redoLeakedBlind,
  dealHasBlindVersion,
} from "../cim/blind-sync";
import { buildBuyerCim } from "@shared/cim-buyer-view";
import { renameDealCodename } from "../cim/codenames";
import {
  deleteSection,
  duplicateSection,
  historyWith,
  insertSectionAt,
  undoLastChange,
} from "../cim/section-ops";
import {
  SectionTaskRunningError,
  applyRewrite,
  clearTask,
  isTaskRunning,
  normalizeTask,
  startSectionTask,
} from "../cim/section-tasks";
import { REWRITE_TONES } from "../cim/layout-engine";
import { refreshSectionDd } from "../cim/dd-enrichment";
import { dealStreetAddress } from "@shared/cim-media";

const NO_AI_MEDIA = "The AI can't choose photos or videos — add them yourself in the section's editor.";

/** Deals whose out-of-date DD sections are being refreshed right now. */
const ddRefreshRunning = new Set<string>();

/** Context for a blank section's starting data (a map starts at the deal's address). */
function blankContext(deal: Deal, title: string | null) {
  return { businessName: deal.businessName, industry: deal.industry, title, address: dealStreetAddress(deal.extractedInfo) };
}

// Same ceiling as the other AI endpoints (server/index.ts aiLimiter).
const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});

/** Critical discrepancies block every AI step that writes CIM content. */
async function discrepancyBlock(dealId: string): Promise<string | null> {
  const open = (await storage.getDiscrepanciesByDeal(dealId)).filter(
    (d) => d.severity === "critical" && (d.status === "open" || d.status === "seller_responded"),
  );
  if (open.length === 0) return null;
  return `${open.length} critical discrepanc${open.length === 1 ? "y" : "ies"} must be resolved before the AI writes CIM content`;
}

/** Load a section the session broker owns (via its deal), or answer 404. */
async function ownedSection(req: Request, res: Response): Promise<{ section: CimSection; deal: Deal } | null> {
  const [section] = await db.select().from(cimSections).where(eq(cimSections.id, String(req.params.sectionId)));
  const deal = section ? await getOwnedDeal(section.dealId, req.session.brokerId) : null;
  if (!section || !deal) {
    res.status(404).json({ error: "Section not found" });
    return null;
  }
  return { section, deal };
}

/**
 * DD version of a section: "none" (the deal has no DD CIM), "fresh",
 * "stale" (edited since its DD version was written — DD buyers see the
 * named content until it is refreshed), "missing" (added after the DD CIM),
 * "excluded" (cover/divider/media: nothing to enrich).
 */
type DdStatus = "none" | "fresh" | "stale" | "missing" | "excluded";
function ddStatusOf(s: CimSection, ddGenerated: boolean, hasDd: boolean): DdStatus {
  if (!ddGenerated) return "none";
  if (s.layoutType === "cover_page" || s.layoutType === "divider" || getCimLayout(s.layoutType)?.editor === "media") return "excluded";
  if (!hasDd) return "missing";
  return s.ddStaleAt ? "stale" : "fresh";
}

/** Section row for the builder: task normalised, undo stack summarised. */
function toBuilderSection(s: CimSection, blindGenerated: boolean, hasOverride: boolean, dd: { generated: boolean; has: boolean } = { generated: false, has: false }) {
  const { contentHistory, ...rest } = s;
  const history = Array.isArray(contentHistory) ? (contentHistory as Array<{ reason: string; at: string }>) : [];
  const last = history[history.length - 1];
  const excluded = getCimLayout(s.layoutType)?.blind === "exclude";
  return {
    ...rest,
    accessTier: sectionTier(s),
    aiTask: normalizeTask(s.id, s.aiTask),
    historyCount: history.length,
    lastChange: last ? { reason: last.reason, at: last.at } : null,
    blindStatus: excluded
      ? "excluded"
      : !blindGenerated
        ? "none"
        : hasOverride && !s.blindStaleAt
          ? "fresh"
          : blindSectionError(s.id)
            ? "held"
            : "updating",
    /** Why the blind version is held back (last redaction failed), for the broker. */
    blindError: excluded ? null : blindSectionError(s.id),
    ddStatus: ddStatusOf(s, dd.generated, dd.has),
    /** Figures/names the check couldn't trace to the deal's data (empty = clean). */
    figureWarnings: Array.isArray(s.figureWarnings) ? s.figureWarnings : [],
  };
}

function sendTaskError(res: Response, err: unknown) {
  if (err instanceof SectionTaskRunningError) return res.status(409).json({ error: err.message });
  console.error("[cim-builder] task start failed:", err);
  return res.status(500).json({ error: "Couldn't start the AI. Please try again." });
}

const TITLE_MAX = 200;
function cleanTitle(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t && t.length <= TITLE_MAX ? t : null;
}

export function registerCimBuilderRoutes(app: Express): void {
  // ── Builder state: sections + blind/DD status + buyer access summary ──
  app.get("/api/deals/:dealId/cim-builder", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const [sections, blindOverrides, ddOverrides, buyers] = await Promise.all([
        storage.getCimSectionsByDeal(deal.id),
        storage.getCimSectionOverrides(deal.id, "blind"),
        storage.getCimSectionOverrides(deal.id, "dd"),
        storage.getBuyerAccessByDeal(deal.id),
      ]);
      const withOverride = new Set(blindOverrides.map((o) => o.cimSectionId));
      const withDd = new Set(ddOverrides.map((o) => o.cimSectionId));
      const blindGenerated = blindOverrides.length > 0;
      const ddGenerated = ddOverrides.length > 0;
      if (blindGenerated) {
        // The same final check the view room runs: a blind version that still
        // names something, or kept a "[Province/State]" placeholder, is redone
        // now rather than waiting for the first buyer to open the CIM.
        const check = buildBuyerCim({ deal, accessLevel: "full", sections, overrides: blindOverrides, media: null });
        if (check.leaked.length > 0) {
          redoLeakedBlind(deal.id, check.leaked, check.leakReasons).catch((err) => console.error("[cim-builder] blind redo failed:", err));
          for (const id of check.leaked) withOverride.delete(id);
        }
      }
      const rows = sections.map((s) => toBuilderSection(s, blindGenerated, withOverride.has(s.id), { generated: ddGenerated, has: withDd.has(s.id) }));
      const active = buyers.filter((b) => !b.revokedAt);
      const byLevel = Object.fromEntries(BUYER_ACCESS_LEVELS.map((l) => [l.key, 0])) as Record<string, number>;
      for (const b of active) byLevel[b.accessLevel || "teaser"] = (byLevel[b.accessLevel || "teaser"] ?? 0) + 1;
      const blind = summarizeBlindRows(deal.id, rows);
      res.json({
        sections: rows,
        blind: {
          generated: blindGenerated,
          codename: deal.blindCodename ?? null,
          running: blind.running,
          error: blind.error,
          /** Sections waiting for their redaction (not held back). */
          updating: blind.updating,
          /** Sections whose redaction failed — blind buyers don't get them until one succeeds. */
          held: blind.held,
        },
        dd: {
          generated: ddGenerated,
          /** Sections whose DD version is out of date or missing — DD buyers see the named content for them. */
          outOfDate: rows.filter((r) => r.ddStatus === "stale" || r.ddStatus === "missing").length,
          running: ddRefreshRunning.has(deal.id),
        },
        buyers: { total: active.length, byLevel },
        deal: { isLive: !!deal.isLive, cimLayoutGeneratedAt: deal.cimLayoutGeneratedAt ?? null },
      });
    } catch (err) {
      console.error("[cim-builder] state failed:", err);
      res.status(500).json({ error: "Couldn't load the CIM" });
    }
  });

  // ── Add a section (blank, or written by the AI from the deal's facts) ──
  app.post("/api/deals/:dealId/cim-sections", requireBroker, requireOwnedDeal, aiLimiter, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const body = req.body || {};
      const title = cleanTitle(body.title);
      if (!title) return res.status(400).json({ error: "Give the section a title (up to 200 characters)" });
      if (!isCimLayoutKey(body.layoutType)) return res.status(400).json({ error: "Pick a layout for the section" });
      const mode = body.mode === "ai" ? "ai" : body.mode === "blank" ? "blank" : null;
      if (!mode) return res.status(400).json({ error: "mode must be \"blank\" or \"ai\"" });
      if (mode === "ai" && !canAiWriteLayout(body.layoutType)) return res.status(400).json({ error: NO_AI_MEDIA });
      const brief = typeof body.brief === "string" ? body.brief.trim().slice(0, 1500) : "";
      if (mode === "ai") {
        const blocked = await discrepancyBlock(deal.id);
        if (blocked) return res.status(409).json({ error: blocked });
      }
      const position = body.position === "start"
        ? { atStart: true }
        : typeof body.afterSectionId === "string" && body.afterSectionId
          ? { afterSectionId: body.afterSectionId }
          : {};

      let created: CimSection;
      try {
        created = await insertSectionAt(
          deal.id,
          {
            sectionTitle: title,
            layoutType: body.layoutType,
            layoutData: defaultLayoutData(body.layoutType, blankContext(deal, title)) as any,
            aiLayoutReasoning: mode === "ai" ? "Added by the broker; written by the AI from the deal's information." : "Added by the broker.",
            tags: [] as any,
            brokerApproved: false,
            // A live CIM doesn't show a half-finished section: it starts
            // hidden and the broker shows it when it's ready.
            isVisible: !deal.isLive,
            accessTier: body.accessTier === "full" ? "full" : "teaser",
            blindStaleAt: new Date(),
          },
          position,
        );
      } catch (err: any) {
        if (err?.message === "not_in_deal") return res.status(400).json({ error: "That position isn't in this CIM" });
        throw err;
      }

      if (mode === "ai") {
        const task = await startSectionTask(created, deal, "write", { brief: brief || undefined });
        return res.status(202).json({ section: { ...created, aiTask: task }, task, startedHidden: !!deal.isLive });
      }
      scheduleBlindRefresh(deal.id);
      res.status(201).json({ section: created, startedHidden: !!deal.isLive });
    } catch (err) {
      console.error("[cim-builder] add section failed:", err);
      res.status(500).json({ error: "Couldn't add the section" });
    }
  });

  // ── Delete a section (and its blind/DD overrides) ──
  app.delete("/api/cim-sections/:sectionId", requireBroker, async (req, res) => {
    try {
      const owned = await ownedSection(req, res);
      if (!owned) return;
      if (isTaskRunning(owned.section.id)) {
        return res.status(409).json({ error: "The AI is working on this section — wait for it to finish, then delete it." });
      }
      await deleteSection(owned.section);
      res.json({ success: true, deletedId: owned.section.id });
    } catch (err) {
      console.error("[cim-builder] delete failed:", err);
      res.status(500).json({ error: "Couldn't delete the section" });
    }
  });

  // ── Duplicate a section (fresh key, placed right after the original) ──
  app.post("/api/cim-sections/:sectionId/duplicate", requireBroker, async (req, res) => {
    try {
      const owned = await ownedSection(req, res);
      if (!owned) return;
      const copy = await duplicateSection(owned.section, { hidden: !!owned.deal.isLive });
      res.status(201).json({ section: copy, startedHidden: !!owned.deal.isLive });
    } catch (err) {
      console.error("[cim-builder] duplicate failed:", err);
      res.status(500).json({ error: "Couldn't duplicate the section" });
    }
  });

  // ── Change layout: instant within a family, blank, or converted by the AI ──
  app.patch("/api/cim-sections/:sectionId/layout", requireBroker, aiLimiter, async (req, res) => {
    try {
      const owned = await ownedSection(req, res);
      if (!owned) return;
      const { section, deal } = owned;
      const layoutType = req.body?.layoutType;
      if (!isCimLayoutKey(layoutType)) return res.status(400).json({ error: "Pick a layout" });
      if (layoutType === section.layoutType) return res.json({ section });
      if (isTaskRunning(section.id)) return res.status(409).json({ error: "The AI is already working on this section." });
      // Photos and videos can't be produced by the AI — those start blank.
      const how = req.body?.convert === "ai" && canAiWriteLayout(layoutType) ? "ai" : "blank";

      if (sameLayoutFamily(section.layoutType, layoutType) || how === "blank") {
        const [updated] = await db
          .update(cimSections)
          .set({
            layoutType,
            layoutOverride: section.layoutOverride || section.layoutType,
            ...(sameLayoutFamily(section.layoutType, layoutType)
              ? {}
              : { layoutData: defaultLayoutData(layoutType, blankContext(deal, section.sectionTitle)) as any }),
            contentHistory: historyWith(section, "Changed layout"),
            updatedAt: new Date(),
          })
          .where(eq(cimSections.id, section.id))
          .returning();
        await invalidateBlind(deal.id, [section.id]);
        return res.json({ section: updated });
      }

      const blocked = await discrepancyBlock(deal.id);
      if (blocked) return res.status(409).json({ error: blocked });
      const task = await startSectionTask(section, deal, "convert", { layoutType });
      res.status(202).json({ task });
    } catch (err) {
      sendTaskError(res, err);
    }
  });

  // ── Regenerate one section from the deal's facts (background) ──
  app.post("/api/cim-sections/:sectionId/regenerate", requireBroker, aiLimiter, async (req, res) => {
    try {
      const owned = await ownedSection(req, res);
      if (!owned) return;
      if (!canAiWriteLayout(owned.section.layoutType)) return res.status(400).json({ error: NO_AI_MEDIA });
      const blocked = await discrepancyBlock(owned.deal.id);
      if (blocked) return res.status(409).json({ error: blocked });
      const brief = typeof req.body?.brief === "string" ? req.body.brief.trim().slice(0, 1500) : "";
      // A section whose first write failed is retried as a write.
      const prev = normalizeTask(owned.section.id, owned.section.aiTask);
      const kind = prev?.kind === "write" ? "write" : "regenerate";
      const task = await startSectionTask(owned.section, owned.deal, kind, { brief: brief || prev?.request?.brief });
      res.status(202).json({ task });
    } catch (err) {
      sendTaskError(res, err);
    }
  });

  // ── AI writer: rewrite with instructions / tone / length → a proposal ──
  app.post("/api/cim-sections/:sectionId/rewrite", requireBroker, aiLimiter, async (req, res) => {
    try {
      const owned = await ownedSection(req, res);
      if (!owned) return;
      if (!canAiRewriteLayout(owned.section.layoutType)) {
        return res.status(400).json({ error: "The AI writer doesn't rewrite photo, video or map sections — edit them directly." });
      }
      const body = req.body || {};
      const instructions = typeof body.instructions === "string" ? body.instructions.trim().slice(0, 2000) : "";
      const tones = Array.isArray(body.tones)
        ? body.tones.filter((t: unknown) => typeof t === "string" && (REWRITE_TONES as readonly string[]).includes(t))
        : [];
      const length = body.length === "shorter" || body.length === "longer" ? body.length : "same";
      if (!instructions && tones.length === 0 && length === "same") {
        return res.status(400).json({ error: "Tell the AI what to change — type an instruction, or pick a tone or length." });
      }
      const blocked = await discrepancyBlock(owned.deal.id);
      if (blocked) return res.status(409).json({ error: blocked });
      const task = await startSectionTask(owned.section, owned.deal, "rewrite", { instructions, tones, length });
      res.status(202).json({ task });
    } catch (err) {
      sendTaskError(res, err);
    }
  });

  app.post("/api/cim-sections/:sectionId/apply-rewrite", requireBroker, async (req, res) => {
    try {
      const owned = await ownedSection(req, res);
      if (!owned) return;
      const updated = await applyRewrite(owned.section);
      if (!updated) return res.status(409).json({ error: "There's no rewrite waiting for this section." });
      res.json({ section: updated });
    } catch (err) {
      console.error("[cim-builder] apply rewrite failed:", err);
      res.status(500).json({ error: "Couldn't apply the rewrite" });
    }
  });

  // Discard a rewrite proposal, dismiss a failed task, or — for a section
  // whose AI write failed — keep it as a blank section.
  app.post("/api/cim-sections/:sectionId/discard-task", requireBroker, async (req, res) => {
    try {
      const owned = await ownedSection(req, res);
      if (!owned) return;
      if (!(await clearTask(owned.section))) {
        return res.status(409).json({ error: "The AI is still working on this section." });
      }
      const task = owned.section.aiTask as CimSectionAiTask | null;
      // A failed write left a blank section that was hidden from buyers while
      // "being written" — it is a normal blank section now; redact it.
      if (task?.kind === "write") await invalidateBlind(owned.deal.id, [owned.section.id]);
      res.json({ success: true });
    } catch (err) {
      console.error("[cim-builder] discard task failed:", err);
      res.status(500).json({ error: "Couldn't discard" });
    }
  });

  // ── Undo the last content change (rewrite, edit, layout change…) ──
  app.post("/api/cim-sections/:sectionId/undo", requireBroker, async (req, res) => {
    try {
      const owned = await ownedSection(req, res);
      if (!owned) return;
      if (isTaskRunning(owned.section.id)) return res.status(409).json({ error: "The AI is working on this section." });
      const restored = await undoLastChange(owned.section);
      if (!restored) return res.status(409).json({ error: "Nothing to undo for this section." });
      res.json({ section: restored });
    } catch (err) {
      console.error("[cim-builder] undo failed:", err);
      res.status(500).json({ error: "Couldn't undo" });
    }
  });

  // ── Retry the blind version of stale sections now ──
  app.post("/api/deals/:dealId/cim-blind/refresh", requireBroker, requireOwnedDeal, aiLimiter, async (req, res) => {
    const deal = res.locals.deal as Deal;
    try {
      await retryBlindNow(deal.id);
      res.status(202).json({ started: true });
    } catch (err) {
      console.error("[cim-builder] blind retry failed:", err);
      res.status(500).json({ error: "Couldn't retry the blind version" });
    }
  });

  // ── Refresh ONE section's DD version (after an edit) ──
  // Replaces only that section's DD row. Synchronous: one section is ~20s.
  app.post("/api/cim-sections/:sectionId/dd/refresh", requireBroker, aiLimiter, async (req, res) => {
    try {
      const owned = await ownedSection(req, res);
      if (!owned) return;
      const { section, deal } = owned;
      if ((await storage.getCimSectionOverrides(deal.id, "dd")).length === 0) {
        return res.status(400).json({ error: "This CIM has no due-diligence version yet — generate it first." });
      }
      if (isTaskRunning(section.id)) return res.status(409).json({ error: "The AI is working on this section — wait for it to finish." });
      const blocked = await discrepancyBlock(deal.id);
      if (blocked) return res.status(409).json({ error: blocked });
      const { warning } = await refreshSectionDd(section, deal);
      res.json({ success: true, warning: warning ?? null });
    } catch (err: any) {
      if (err?.message === "changed") {
        return res.status(409).json({ error: "The section changed while its DD version was being written. Refresh it again." });
      }
      console.error("[cim-builder] DD refresh failed:", err);
      res.status(500).json({ error: "Couldn't refresh the DD version" });
    }
  });

  // ── Refresh every out-of-date DD section (background; the builder polls) ──
  app.post("/api/deals/:dealId/cim-dd/refresh", requireBroker, requireOwnedDeal, aiLimiter, async (req, res) => {
    const deal = res.locals.deal as Deal;
    try {
      if (ddRefreshRunning.has(deal.id)) return res.status(409).json({ error: "The DD version is already being refreshed." });
      const [sections, ddOverrides] = await Promise.all([
        storage.getCimSectionsByDeal(deal.id),
        storage.getCimSectionOverrides(deal.id, "dd"),
      ]);
      if (ddOverrides.length === 0) return res.status(400).json({ error: "This CIM has no due-diligence version yet — generate it first." });
      const blocked = await discrepancyBlock(deal.id);
      if (blocked) return res.status(409).json({ error: blocked });
      const withDd = new Set(ddOverrides.map((o) => o.cimSectionId));
      const todo = sections.filter((s) => {
        const st = ddStatusOf(s, true, withDd.has(s.id));
        return (st === "stale" || st === "missing") && !isTaskRunning(s.id);
      });
      ddRefreshRunning.add(deal.id);
      res.status(202).json({ started: true, sections: todo.length });
      void (async () => {
        try {
          for (let i = 0; i < todo.length; i += 3) {
            await Promise.all(
              todo.slice(i, i + 3).map((s) =>
                refreshSectionDd(s, deal).catch((err) => console.warn(`[cim-builder] DD refresh of ${s.id} skipped:`, err?.message)),
              ),
            );
          }
        } finally {
          ddRefreshRunning.delete(deal.id);
        }
      })();
    } catch (err) {
      ddRefreshRunning.delete(deal.id);
      console.error("[cim-builder] DD refresh-all failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "Couldn't refresh the DD version" });
    }
  });

  // ── Redo one section's blind version (e.g. it reads oddly, or is held back) ──
  app.post("/api/cim-sections/:sectionId/blind/redo", requireBroker, aiLimiter, async (req, res) => {
    try {
      const owned = await ownedSection(req, res);
      if (!owned) return;
      const { section, deal } = owned;
      if (getCimLayout(section.layoutType)?.blind === "exclude") {
        return res.status(400).json({ error: "This section is never shown in the Blind CIM." });
      }
      if (isTaskRunning(section.id)) return res.status(409).json({ error: "The AI is working on this section." });
      if (!(await dealHasBlindVersion(deal.id))) {
        return res.status(409).json({ error: "There's no blind version yet — generate it first." });
      }
      await redoSectionsBlind(deal.id, [section.id]);
      res.status(202).json({ started: true });
    } catch (err) {
      console.error("[cim-builder] blind redo failed:", err);
      res.status(500).json({ error: "Couldn't redo the blind version" });
    }
  });

  // ── Set or rename the Blind CIM's project codename ──
  app.patch("/api/deals/:dealId/codename", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const r = await renameDealCodename(deal, req.body?.codename);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      res.json({ codename: r.codename, updated: r.updated });
    } catch (err) {
      console.error("[cim-builder] codename change failed:", err);
      res.status(500).json({ error: "Couldn't change the codename" });
    }
  });

  // ── Set several sections' access tier at once ──
  app.post("/api/deals/:dealId/cim-sections/tiers", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const tier = req.body?.accessTier;
      const ids: unknown = req.body?.sectionIds;
      if (tier !== "teaser" && tier !== "full") return res.status(400).json({ error: "Access must be teaser or full" });
      if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) return res.status(400).json({ error: "sectionIds must be a list" });
      let changed = 0;
      for (const id of ids as string[]) {
        const r = await db
          .update(cimSections)
          .set({ accessTier: tier })
          .where(and(eq(cimSections.id, id), eq(cimSections.dealId, deal.id)))
          .returning({ id: cimSections.id });
        changed += r.length;
      }
      res.json({ success: true, changed });
    } catch (err) {
      console.error("[cim-builder] set tiers failed:", err);
      res.status(500).json({ error: "Couldn't change access" });
    }
  });
}
