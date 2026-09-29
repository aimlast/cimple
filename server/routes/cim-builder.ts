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
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { cimSections, type CimGenerationStatus, type CimSection, type CimSectionAiTask, type Deal } from "@shared/schema";
import {
  BUYER_ACCESS_LEVELS,
  canAiRewriteLayout,
  canAiWriteLayout,
  defaultLayoutData,
  getCimLayout,
  isCimFallbackSection,
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
import { buildBuyerCim, buyersReadWorkingCopy } from "@shared/cim-buyer-view";
import { discrepancyBlocksCim } from "@shared/discrepancy-gate";
import { factAmounts, withStatedChartTotal } from "@shared/cim-chart-values";
import { codenameProblem, renameDealCodename } from "../cim/codenames";
import {
  deleteSection,
  duplicateSection,
  historyWith,
  insertSectionAt,
  undoLastChange,
  withStaleStamps,
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
import { refreshSectionDd, ddRunning, lastDdRun, DdUnavailableError } from "../cim/dd-enrichment";
import { cimFinancialsFor, StaleFinancialAnalysisError } from "../cim/cim-financials";

/**
 * Why the DD version can't be refreshed now: the financial analysis the CIM
 * uses was built from a statement since deleted (the same stop as CIM
 * generation) — said plainly instead of a generic failure.
 */
async function staleFinancialsBlock(dealId: string): Promise<string | null> {
  const [analyses, docs] = await Promise.all([storage.getFinancialAnalysesByDeal(dealId), storage.getDocumentsByDeal(dealId)]);
  try {
    cimFinancialsFor(analyses, docs);
    return null;
  } catch (err) {
    if (err instanceof StaleFinancialAnalysisError) return err.message.replace(/Generation is stopped until then\.$/, "The DD version can't be refreshed until then.");
    throw err;
  }
}
import { dealStreetAddress } from "@shared/cim-media";
import { lastGenerationFacts, openBuyerLinks } from "../cim/generation-jobs";
import { cimStaleness, writerFactsSnapshot } from "../cim/cim-staleness";
import { backfillLegacyLiveApprovals, withdrawApprovalsAfterChange } from "../cim/approvals";
import { keepPublishedBeforeChange } from "../cim/published-versions";
import { listedAskingPrice } from "../information/deal-mirror";
import { historySnapshots } from "@shared/cim-approvals";

const NO_AI_MEDIA = "The AI can't choose photos or videos — add them yourself in the section's editor.";

/** Deals with a DD run in progress — shared with the CIM tab's full DD run (dd-enrichment). */
const ddRefreshRunning = ddRunning;

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

/**
 * Critical discrepancies block every AI step that writes CIM content — the
 * one rule every gate uses (shared/discrepancy-gate.ts, also the builder's
 * useAiGate): open or awaiting review, and a critical routed to a seller who
 * had already finished the interview, until they answer.
 */
async function discrepancyBlock(deal: Pick<Deal, "id" | "interviewCompleted">): Promise<string | null> {
  const blocking = (await storage.getDiscrepanciesByDeal(deal.id)).filter((d) => discrepancyBlocksCim(d, deal.interviewCompleted));
  return discrepancyBlockMessage(blocking);
}

/** The 409 text for the rows discrepancyBlocksCim picked (null = nothing blocks). Pure. */
export function discrepancyBlockMessage(blocking: Array<{ status: string }>): string | null {
  if (blocking.length === 0) return null;
  const withSeller = blocking.filter((d) => d.status === "ask_seller").length;
  if (withSeller === blocking.length) {
    return `Waiting on the seller to answer ${withSeller} critical question${withSeller === 1 ? "" : "s"} you sent them — or resolve ${withSeller === 1 ? "it" : "them"} on the Overview tab — before the AI writes CIM content`;
  }
  return `${blocking.length} critical discrepanc${blocking.length === 1 ? "y" : "ies"} must be resolved before the AI writes CIM content`;
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
  // Marker entries (the approval rule's mark) are not versions to undo to.
  const history = historySnapshots<{ reason: string; at: string }>(contentHistory);
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
    /** A section the AI couldn't write: a hidden placeholder, never served to buyers. */
    placeholder: isCimFallbackSection(s),
  };
}

function sendTaskError(res: Response, err: unknown) {
  if (err instanceof SectionTaskRunningError) return res.status(409).json({ error: err.message });
  console.error("[cim-builder] task start failed:", err);
  return res.status(500).json({ error: "Couldn't start the AI. Please try again." });
}

/** A fact value short enough for a banner line. */
function clip(v: string | null): string | null {
  if (!v) return v;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 90 ? `${t.slice(0, 87)}…` : t;
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
        // A live CIM approved before the per-section rule gets its untouched sections ticked.
        backfillLegacyLiveApprovals(deal),
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
      // Facts changed since the CIM was written: which sections still show an
      // old value (cim-staleness.ts). Best-effort — never blocks the builder.
      const factsThen = lastGenerationFacts(deal);
      const staleness = factsThen
        ? await writerFactsSnapshot(deal).then((now) => cimStaleness(factsThen, now, sections)).catch((err) => {
            console.warn("[cim-builder] staleness check failed:", err);
            return null;
          })
        : null;
      const staleBy = new Map((staleness?.sections ?? []).map((x) => [x.id, x.facts]));
      // The same chart totals buyers get (a chart written before it carried its stated total).
      const amounts = factAmounts(deal.extractedInfo);
      const rows = sections.map((s) => ({
        ...toBuilderSection(withStatedChartTotal(s, amounts), blindGenerated, withOverride.has(s.id), { generated: ddGenerated, has: withDd.has(s.id) }),
        /** Changed facts whose old value this section still shows. */
        factsChanged: staleBy.get(s.id) ?? [],
      }));
      const generation = deal.cimGeneration as CimGenerationStatus | null | undefined;
      const active = buyers.filter((b) => !b.revokedAt);
      const byLevel = Object.fromEntries(BUYER_ACCESS_LEVELS.map((l) => [l.key, 0])) as Record<string, number>;
      for (const b of active) byLevel[b.accessLevel || "teaser"] = (byLevel[b.accessLevel || "teaser"] ?? 0) + 1;
      const blind = summarizeBlindRows(deal.id, rows);
      res.json({
        sections: rows,
        blind: {
          generated: blindGenerated,
          codename: deal.blindCodename ?? null,
          /** Why the codename (chosen before a stricter check, or before a fact changed) would point at the business; null when it is neutral. */
          codenameProblem: deal.blindCodename ? codenameProblem(deal, deal.blindCodename) : null,
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
          /** The last full DD run: what couldn't be written, or why nothing changed. */
          lastRun: lastDdRun(deal.id),
        },
        // `total` = links that can open the CIM now (not revoked, not expired):
        // the count the regenerate dialogs quote and the hold is decided on.
        buyers: { total: openBuyerLinks(buyers), byLevel },
        deal: {
          isLive: !!deal.isLive,
          cimLayoutGeneratedAt: deal.cimLayoutGeneratedAt ?? null,
          // The price buyers see on the cover and key numbers (the view room
          // applies it at view time) — the previews show the same.
          listedAskingPrice: listedAskingPrice(deal),
        },
        // What the broker must look at before publishing: the last run's
        // notes, placeholders, a hold from buyers, facts changed since.
        review: {
          heldFromBuyers: generation?.buyerHold ?? null,
          warnings: generation?.status === "done" ? generation.warnings ?? [] : [],
          warningsAt: generation?.status === "done" ? generation.finishedAt ?? null : null,
          placeholders: rows.filter((r) => r.placeholder).length,
          facts: staleness && (staleness.changes.length > 0 || staleness.notesChanged)
            ? {
                changes: staleness.changes.slice(0, 12).map((c) => ({ label: c.label, before: clip(c.before), after: clip(c.after) })),
                more: Math.max(0, staleness.changes.length - 12),
                sections: staleness.sections.length,
                notesChanged: staleness.notesChanged,
              }
            : null,
        },
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
        const blocked = await discrepancyBlock(deal);
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
            // hidden and the broker shows it when it's ready. (While buyers
            // read the kept copy of an update under review, it's draft.)
            isVisible: !buyersReadWorkingCopy(deal),
            accessTier: body.accessTier === "full" ? "full" : "teaser",
            blindStaleAt: new Date(),
          },
          position,
        );
      } catch (err: any) {
        if (err?.message === "not_in_deal") return res.status(400).json({ error: "That position isn't in this CIM" });
        throw err;
      }
      // A new shown section: the CIM's approvals no longer cover all of it.
      if (created.isVisible !== false) await withdrawApprovalsAfterChange(deal.id);

      if (mode === "ai") {
        const task = await startSectionTask(created, deal, "write", { brief: brief || undefined });
        return res.status(202).json({ section: { ...created, aiTask: task }, task, startedHidden: buyersReadWorkingCopy(deal) });
      }
      scheduleBlindRefresh(deal.id);
      res.status(201).json({ section: created, startedHidden: buyersReadWorkingCopy(deal) });
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
      const hidden = buyersReadWorkingCopy(owned.deal);
      const copy = await duplicateSection(owned.section, { hidden });
      res.status(201).json({ section: copy, startedHidden: hidden });
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
        // On a live CIM buyers keep the approved version (a blank layout's
        // sample data never reaches them) until the broker approves this.
        await keepPublishedBeforeChange(section, deal);
        const [updated] = await db
          .update(cimSections)
          .set({
            layoutType,
            layoutOverride: section.layoutOverride || section.layoutType,
            ...(sameLayoutFamily(section.layoutType, layoutType)
              ? {}
              : { layoutData: defaultLayoutData(layoutType, blankContext(deal, section.sectionTitle)) as any }),
            contentHistory: historyWith(section, "Changed layout"),
            // A different layout is a change the approvals didn't cover.
            brokerApproved: false,
            updatedAt: new Date(),
          })
          .where(eq(cimSections.id, section.id))
          .returning();
        const at = await invalidateBlind(deal.id, [section.id]);
        if (updated.isVisible !== false) await withdrawApprovalsAfterChange(deal.id);
        return res.json({ section: withStaleStamps(updated, at) });
      }

      const blocked = await discrepancyBlock(deal);
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
      const blocked = await discrepancyBlock(owned.deal);
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
      const blocked = await discrepancyBlock(owned.deal);
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
      const blocked = (await discrepancyBlock(deal)) ?? (await staleFinancialsBlock(deal.id));
      if (blocked) return res.status(409).json({ error: blocked });
      const { warning } = await refreshSectionDd(section, deal);
      res.json({ success: true, warning: warning ?? null });
    } catch (err: any) {
      if (err?.message === "changed") {
        return res.status(409).json({ error: "The section changed while its DD version was being written. Refresh it again." });
      }
      if (err instanceof DdUnavailableError) return res.status(503).json({ error: err.message });
      if (err instanceof StaleFinancialAnalysisError) return res.status(409).json({ error: err.message });
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
      const blocked = (await discrepancyBlock(deal)) ?? (await staleFinancialsBlock(deal.id));
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
        // A tier change is a change to what buyers read (a teaser stops
        // seeing the section): updatedAt moves, as it does through PATCH, so
        // an unreviewed AI answer drawn from it is withdrawn (qa/cim-context
        // answerStillHolds). A section already at that tier is left alone.
        const r = await db
          .update(cimSections)
          .set({ accessTier: tier, updatedAt: new Date() })
          .where(and(eq(cimSections.id, id), eq(cimSections.dealId, deal.id), sql`${cimSections.accessTier} is distinct from ${tier}`))
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
