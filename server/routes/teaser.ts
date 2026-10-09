/**
 * Teaser routes (spec §6.2). Broker routes are requireBroker +
 * requireOwnedDeal; bodies are parsed with zod .strict() (unknown keys → 400);
 * block ids are looked up inside that deal's doc. Mutations take `rev` and
 * return the full TeaserState (server/teaser/summary.ts). Buyer routes
 * (/api/view/:token/…) work only on a teaser link and are limited per link.
 *
 * Registered from server/routes.ts with one line (after
 * registerEngagementInsightRoutes). Rate limits: applyTeaserRateLimits,
 * mounted in server/index.ts's "teaser limiters" block.
 */
import type { Express, Request, RequestHandler, Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { BuyerAccess, BuyerApprovalRequest, Deal } from "@shared/schema";
import { isTeaserOnly } from "@shared/access-levels";
import {
  TEASER_AUTO_GRANTS,
  TEASER_LAYOUTS,
  TEASER_LINK_LIFETIMES,
  TEASER_PASS_REASONS,
  isTeaserLayout,
  type TeaserBlock,
} from "@shared/teaser";
import { NUMBER_STYLES } from "@shared/deal-bands";
import { guardTeaserText } from "@shared/teaser-guard";
import { checkTeaserDoc, swapCodename, teaserTerms, NO_CODENAME } from "@shared/teaser-view";
import { TEASER_TEMPLATES, savedTemplateId, templateDef } from "@shared/teaser-templates";
import { isBuiltInTeaserTemplate } from "@shared/teaser";
import { ndaBuyerProfileSchema, hasMatchableProfile } from "@shared/nda-buyer-profile";
import { storage } from "../storage";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes";
import { viewLinkProblem, viewLinkError } from "../buyers/view-access";
import { createPerKeyLimiter } from "../security/per-key-limit";
import { aiLimiterWhen, runLimiter, setTeaserAiLimiter, teaserAiLimiter } from "../security/ai-limit-when";
import {
  TeaserConflict,
  deleteTeaser,
  getDealTeaser,
  saveDraft,
  teaserPublished,
  teaserStore,
  type TeaserRow,
} from "../teaser/store";
import {
  TeaserOpError,
  addBlock,
  applyTemplateSlots,
  duplicateBlock,
  freshCellsFor,
  patchBlock,
  patchCell,
  patchHeader,
  publishProblems,
  publishedSnapshot,
  recomputeFixed,
  removeBlock,
  reorder,
  setLayout,
  undoDoc,
} from "../teaser/doc-ops";
import {
  TeaserWriteRefused,
  assembleTeaserDoc,
  discrepancyGateFor,
  fillSlotsInBackground,
  startTeaserGeneration,
  teaserBriefDeps,
  teaserGate,
  writeBlock,
  writeTeaser,
} from "../teaser/generate";
import { servedCodenameFor, teaserState, teaserSummary } from "../teaser/summary";
import { buyerTeaserFor, linkOpenForBuyer } from "../teaser/serve";
import { teaserEngagement } from "../teaser/engagement";
import { SellerCheckError, sendSellerCheck, sellerOwner } from "../teaser/seller-check";
import { TemplateLimitError, deleteTeaserTemplate, getTeaserSettings, listTeaserTemplates, patchTeaserSettings, renameTeaserTemplate, saveTeaserTemplate } from "../teaser/templates-store";
import { requireEmailCheck, sendEmailCode, verifyEmailCode } from "../teaser/email-check";
import { TeaserRequestError, ensureTeaserRequest, recordFreshLinkRequest, recordTeaserPass, requestStateFor, updateRequestNote } from "../teaser/requests";
import { teaserFigures } from "../teaser/key-numbers";


/** What the routes need from server/routes.ts (the grant flow lives there). */
export interface TeaserRouteDeps {
  /** grantApprovedBuyer(request, deal, baseUrl, review, opts) */
  grant?: (request: BuyerApprovalRequest, deal: Deal, baseUrl: string, review: Record<string, unknown>, opts: { grantedBy: "broker" | "seller" | "auto"; notifyBuyer: boolean; level?: string }) => Promise<unknown>;
}

const rev = z.number().int().nonnegative();

// ── Errors ─────────────────────────────────────────────────────────────────

async function sendError(res: Response, err: unknown, deal: Deal | null, fallback: string): Promise<void> {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "That request wasn't readable.", code: "invalid" });
    return;
  }
  if (err instanceof TeaserConflict) {
    if (err.code === "missing") {
      res.status(404).json({ error: err.message, code: "no_teaser" });
      return;
    }
    const row = deal ? await getDealTeaser(deal.id).catch(() => null) : null;
    res.status(409).json({ error: err.message, code: err.code, ...(deal && row && err.code === "stale" ? { teaser: await teaserState(deal, row, { staleness: false }) } : {}) });
    return;
  }
  if (err instanceof TeaserOpError) {
    res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    return;
  }
  if (err instanceof TeaserWriteRefused) {
    res.status(409).json({ error: err.message, code: "refused" });
    return;
  }
  if (err instanceof TemplateLimitError) {
    res.status(409).json({ error: err.message, code: "template_limit" });
    return;
  }
  if (err instanceof SellerCheckError || err instanceof TeaserRequestError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  console.error(`[teaser] ${fallback}:`, err);
  res.status(500).json({ error: fallback });
}

const dealOf = (res: Response) => res.locals.deal as Deal;

async function stateOf(deal: Deal, row: TeaserRow, staleness = false) {
  return teaserState(deal, row, { staleness });
}

async function requireRow(deal: Deal): Promise<TeaserRow> {
  const row = await getDealTeaser(deal.id);
  if (!row) throw new TeaserConflict("missing", "There's no teaser yet.");
  return row;
}

/** Fixed-block builder for a slot (template switches): cells / trend from the facts now. */
async function fixedBlockFor(deal: Deal, row: TeaserRow, slot: string, templateKey: string): Promise<TeaserBlock | null> {
  const def = templateDef(templateKey);
  const slotDef = def.slots.find((s) => s.slot === slot);
  if (!slotDef || slotDef.src === "ai") return null;
  const f = await teaserFigures(deal);
  const one = assembleTeaserDoc({ def: { ...def, slots: [slotDef] }, figures: f, numbers: row.numbers, showAskingPrice: row.showAskingPrice, wording: await getTeaserSettings(deal.brokerId), written: null });
  const b = one.blocks[0];
  return b && !b.placeholder ? b : null;
}

/** The per-link limiter for the buyer's request steps (10 an hour; fresh link once a day). */
const linkKey = (req: Request) => createHash("sha256").update(String(req.params.token ?? "")).digest("hex").slice(0, 32);
const requestLimiter = createPerKeyLimiter({ limit: 10, windowMs: 3_600_000 });
const freshLimiter = createPerKeyLimiter({ limit: 1, windowMs: 86_400_000 });
const perLink = (limiter: ReturnType<typeof createPerKeyLimiter>): RequestHandler => (req, res, next) => {
  if (!limiter.take(linkKey(req))) {
    res.status(429).json({ error: "Too many requests from this link. Try again later.", code: "rate_limited" });
    return;
  }
  next();
};
export function _resetTeaserLinkLimitsForTests(): void {
  requestLimiter.reset();
  freshLimiter.reset();
}

/**
 * Mounted by server/index.ts ("teaser limiters"): the AI limiter on the
 * model-running teaser routes only (a body predicate where the path alone
 * can't tell).
 */
export function applyTeaserRateLimits(app: Express, aiLimiter: RequestHandler): void {
  setTeaserAiLimiter(aiLimiter);
  app.use("/api/deals/:dealId/teaser/generate", aiLimiter);
  app.use("/api/deals/:dealId/teaser/blocks/:blockId/rewrite", aiLimiter);
  app.use("/api/deals/:dealId/teaser/blocks", aiLimiterWhen(aiLimiter, (req) => req.method === "POST" && /\/teaser\/blocks\/?$/.test(req.originalUrl.split("?")[0]) && req.body?.mode === "ai"));
  app.use("/api/deals/:dealId/teaser/blocks/:blockId/layout", aiLimiterWhen(aiLimiter, (req) => req.body?.convert === "ai"));
}

async function viewAccess(req: Request, res: Response): Promise<{ access: BuyerAccess; deal: Deal } | null> {
  const access = await storage.getBuyerAccessByToken(req.params.token);
  const problem = viewLinkProblem(access);
  if (problem || !access) {
    const e = viewLinkError(problem ?? "not_found");
    res.status(e.status).json({ error: e.error });
    return null;
  }
  const deal = await storage.getDeal(access.dealId);
  if (!deal) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return { access, deal };
}

export function registerTeaserRoutes(app: Express, deps: TeaserRouteDeps = {}): void {
  const broker = [requireBroker, requireOwnedDeal];

  // ── Read ────────────────────────────────────────────────────────────────
  app.get("/api/deals/:dealId/teaser", ...broker, async (_req, res) => {
    const deal = dealOf(res);
    try {
      const row = await getDealTeaser(deal.id);
      if (row) return res.json(await stateOf(deal, row, true));
      const f = await teaserFigures(deal);
      const gate = await teaserGate(deal, f, "ranges");
      // Which narrative "Write my teaser" would use (no AI, no codename created on a read).
      const codename = await servedCodenameFor(deal);
      const served = codename !== NO_CODENAME ? await teaserBriefDeps().servedBlind(deal, codename).catch(() => null) : null;
      const { templates, defaultTemplate } = await listTeaserTemplates(deal.brokerId).catch(() => ({ templates: [], defaultTemplate: null }));
      res.json({
        teaser: null,
        canWrite: { ok: gate.ok, reasons: gate.reasons, notes: gate.notes },
        basis: served && served.sections.length > 0 ? "blind_cim" : "redacted_facts",
        templates,
        defaultTemplate,
        summary: await teaserSummary(deal, null),
        sellerOwner: (await sellerOwner(deal.id).catch(() => null))?.name ?? null,
      });
    } catch (err) {
      await sendError(res, err, deal, "Couldn't load the teaser");
    }
  });

  app.get("/api/deals/:dealId/teaser/summary", ...broker, async (_req, res) => {
    const deal = dealOf(res);
    try {
      res.json(await teaserSummary(deal, await getDealTeaser(deal.id)));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't load the teaser");
    }
  });

  // ── Write ───────────────────────────────────────────────────────────────
  app.post("/api/deals/:dealId/teaser/generate", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ templateKey: z.string().max(80), replace: z.boolean().optional() }).strict().parse(req.body ?? {});
      if (!isBuiltInTeaserTemplate(body.templateKey) && !savedTemplateId(body.templateKey)) return res.status(400).json({ error: "Pick a template.", code: "invalid" });
      const existing = await getDealTeaser(deal.id);
      if (existing?.generation?.status === "running") return res.status(409).json({ error: "Cimple is writing your teaser — try again in a moment.", code: "writing" });
      if (existing && existing.draft.blocks.length > 0 && !body.replace) {
        return res.status(409).json({ error: "Replace the current draft? You can undo it.", code: "has_draft" });
      }
      const f = await teaserFigures(deal);
      const gate = await teaserGate(deal, f, existing?.numbers ?? templateDef(body.templateKey).numbers);
      if (!gate.ok) return res.status(400).json({ error: gate.reasons[0], reasons: gate.reasons, code: "gate" });
      const started = await startTeaserGeneration(deal, { templateKey: body.templateKey });
      if ("busy" in started) return res.status(409).json({ error: "Cimple is writing your teaser — try again in a moment.", code: "writing" });
      res.status(202).json({ started: true });
    } catch (err) {
      await sendError(res, err, deal, "Couldn't start writing the teaser");
    }
  });

  app.post("/api/deals/:dealId/teaser/from-template", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ templateKey: z.string().max(80), replace: z.boolean().optional() }).strict().parse(req.body ?? {});
      if (!isBuiltInTeaserTemplate(body.templateKey) && !savedTemplateId(body.templateKey)) return res.status(400).json({ error: "Pick a template.", code: "invalid" });
      const existing = await getDealTeaser(deal.id);
      if (existing?.generation?.status === "running") return res.status(409).json({ error: "Cimple is writing your teaser — try again in a moment.", code: "writing" });
      if (existing && existing.draft.blocks.length > 0 && !body.replace) return res.status(409).json({ error: "Replace the current draft? You can undo it.", code: "has_draft" });
      const f = await teaserFigures(deal);
      const def = templateDef(body.templateKey);
      const numbers = existing?.numbers ?? def.numbers;
      const gate = await teaserGate(deal, f, numbers);
      if (!gate.ok) return res.status(400).json({ error: gate.reasons[0], reasons: gate.reasons, code: "gate" });
      const bySlot = new Map((existing?.draft.blocks ?? []).map((b) => [b.slot, b.id]));
      const written = await writeTeaser(deal, { templateKey: body.templateKey, numbers, showAskingPrice: existing?.showAskingPrice ?? true, mode: "template", startedAt: new Date().toISOString(), ownedBlockIds: [], idForSlot: (s) => bySlot.get(s) });
      const store = teaserStore();
      if (!existing) await store.create(deal.id, { templateKey: body.templateKey, numbers });
      const row = await store.update(deal.id, (r) => ({
        templateKey: body.templateKey,
        numbers,
        draft: written.doc,
        draftRev: r.draftRev + 1,
        history: [...r.history, { at: new Date().toISOString(), reason: "Started from the template", doc: r.draft }].slice(-20),
        codenameUsed: written.codename,
        generation: { ...written.generation, fullRewrite: false },
      }));
      res.json(await stateOf(deal, row!));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't start the teaser");
    }
  });

  app.patch("/api/deals/:dealId/teaser/settings", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({
        rev,
        templateKey: z.string().max(80).optional(),
        designTemplateId: z.string().max(80).nullable().optional(),
        pageSize: z.enum(["letter", "a4"]).optional(),
        numbers: z.enum(NUMBER_STYLES as unknown as [string, ...string[]]).optional(),
        showAskingPrice: z.boolean().optional(),
        linkLifetime: z.enum(TEASER_LINK_LIFETIMES as unknown as [string, ...string[]]).optional(),
        autoGrant: z.enum(TEASER_AUTO_GRANTS as unknown as [string, ...string[]]).optional(),
      }).strict().parse(req.body ?? {});
      const row = await requireRow(deal);
      if (body.templateKey !== undefined && !isBuiltInTeaserTemplate(body.templateKey) && !savedTemplateId(body.templateKey)) return res.status(400).json({ error: "Pick a template.", code: "invalid" });
      if (body.designTemplateId) {
        const { findTemplate } = await import("../cim/templates");
        if (!(await findTemplate(deal.brokerId, body.designTemplateId))) return res.status(400).json({ error: "That look doesn't exist.", code: "invalid" });
      }
      const f = body.numbers !== undefined || body.templateKey !== undefined ? await teaserFigures(deal) : null;
      // A template switch: missing slots added (fixed ones from the facts now; AI ones written in the background).
      let toFill: string[] = [];
      const fixedBlocks = new Map<string, TeaserBlock | null>();
      if (body.templateKey && body.templateKey !== row.templateKey) {
        const { savedTemplateDef } = await import("../teaser/templates-store");
        const def = isBuiltInTeaserTemplate(body.templateKey) ? TEASER_TEMPLATES[body.templateKey] : await savedTemplateDef(body.templateKey, deal.brokerId);
        if (!def) return res.status(400).json({ error: "Pick a template.", code: "invalid" });
        for (const s of def.slots) if (s.src !== "ai" && !row.draft.blocks.some((b) => b.slot === s.slot)) fixedBlocks.set(s.slot, await fixedBlockFor(deal, row, s.slot, body.templateKey));
      }
      const updated = await saveDraft(deal.id, body.rev, (doc, r) => {
        let next = doc;
        if (body.templateKey && body.templateKey !== r.templateKey) {
          const def = templateDef(body.templateKey);
          const applied = applyTemplateSlots(next, def, (slot) => fixedBlocks.get(slot) ?? null);
          next = applied.doc;
          toFill = applied.toFill;
        }
        const numbers = (body.numbers ?? r.numbers) as TeaserRow["numbers"];
        if (f && (body.numbers !== undefined && body.numbers !== r.numbers)) {
          next = recomputeFixed(next, body.templateKey ?? r.templateKey, f, { numbers, showAskingPrice: body.showAskingPrice ?? r.showAskingPrice }).doc;
        }
        return {
          doc: next,
          reason: body.templateKey && body.templateKey !== r.templateKey ? "Applied another template" : "Changed the settings",
          extra: {
            ...(body.templateKey !== undefined ? { templateKey: body.templateKey } : {}),
            ...(body.designTemplateId !== undefined ? { designTemplateId: body.designTemplateId } : {}),
            ...(body.pageSize !== undefined ? { pageSize: body.pageSize as TeaserRow["pageSize"] } : {}),
            ...(body.numbers !== undefined ? { numbers } : {}),
            ...(body.showAskingPrice !== undefined ? { showAskingPrice: body.showAskingPrice } : {}),
            ...(body.linkLifetime !== undefined ? { linkLifetime: body.linkLifetime as TeaserRow["linkLifetime"] } : {}),
            ...(body.autoGrant !== undefined ? { autoGrant: body.autoGrant as TeaserRow["autoGrant"] } : {}),
          },
        };
      }, []);
      if (toFill.length > 0) fillSlotsInBackground(deal, updated, toFill);
      res.json(await stateOf(deal, updated));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't save the settings");
    }
  });

  app.patch("/api/deals/:dealId/teaser/header", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ rev, label: z.string().max(200).optional(), tagline: z.string().max(400).optional(), chips: z.array(z.string().max(80)).max(10).optional() }).strict().parse(req.body ?? {});
      const row = await saveDraft(deal.id, body.rev, (doc) => ({ doc: patchHeader(doc, body), reason: "Edited the header" }), []);
      res.json(await stateOf(deal, row));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't save the header");
    }
  });

  app.post("/api/deals/:dealId/teaser/blocks", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({
        rev,
        after: z.string().max(80).nullable().optional(),
        layoutType: z.enum(TEASER_LAYOUTS as unknown as [string, ...string[]]),
        title: z.string().max(200),
        mode: z.enum(["blank", "ai"]),
        brief: z.string().max(600).nullable().optional(),
      }).strict().parse(req.body ?? {});
      await requireRow(deal);
      let content: { title: string; layoutData: Record<string, unknown>; body: string | null } | null = null;
      let warning: string | null = null;
      if (body.mode === "ai") {
        if (!isTeaserLayout(body.layoutType) || body.layoutType === "two_column" || body.layoutType === "line_chart" || body.layoutType === "divider") {
          return res.status(400).json({ error: "Cimple can write text, lists and highlights. Start this one blank.", code: "invalid" });
        }
        const p = await writeBlock(deal, { layoutType: body.layoutType, title: body.title, instructions: body.brief ?? null });
        content = { title: p.title, layoutData: p.layoutData, body: p.body };
        if (p.pinpoint.length) warning = `“${p.pinpoint[0]}” may let someone recognise the business. Buyers will see it — reword it if it's too specific.`;
      }
      const row = await saveDraft(deal.id, body.rev, (doc) => ({
        doc: addBlock(doc, { after: body.after ?? null, layoutType: body.layoutType, title: content?.title ?? body.title, layoutData: content?.layoutData ?? null, body: content?.body ?? null, origin: content ? "ai" : "broker" }).doc,
        reason: "Added a block",
      }), []);
      res.json({ ...(await stateOf(deal, row)), ...(warning ? { warning } : {}) });
    } catch (err) {
      await sendError(res, err, deal, "Couldn't add the block");
    }
  });

  app.patch("/api/deals/:dealId/teaser/blocks/:blockId", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ rev, title: z.string().max(400).optional(), layoutData: z.record(z.unknown()).optional(), body: z.string().max(8000).nullable().optional(), hidden: z.boolean().optional() }).strict().parse(req.body ?? {});
      const { rev: r, ...patch } = body;
      const row = await saveDraft(deal.id, r, (doc) => ({ doc: patchBlock(doc, req.params.blockId, patch), reason: "Edited a block" }), [req.params.blockId]);
      res.json(await stateOf(deal, row));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't save the block");
    }
  });

  app.patch("/api/deals/:dealId/teaser/blocks/:blockId/cells/:key", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ rev, value: z.string().max(200).optional(), reset: z.literal(true).optional() }).strict().parse(req.body ?? {});
      if (!body.reset && body.value === undefined) return res.status(400).json({ error: "Type a value, or use Reset from the facts.", code: "invalid" });
      const row0 = await requireRow(deal);
      let fresh: ReturnType<typeof freshCellsFor> = null;
      if (body.reset) {
        const block = row0.draft.blocks.find((b) => b.id === req.params.blockId);
        if (block) fresh = freshCellsFor(block.slot, row0.templateKey, await teaserFigures(deal), { numbers: row0.numbers, showAskingPrice: row0.showAskingPrice }, block);
      }
      const row = await saveDraft(deal.id, body.rev, (doc) => ({
        doc: patchCell(doc, req.params.blockId, req.params.key, body.reset ? null : body.value!, fresh ?? undefined),
        reason: body.reset ? "Reset a key number from the facts" : "Typed over a key number",
      }), [req.params.blockId]);
      res.json(await stateOf(deal, row));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't save the key number");
    }
  });

  app.delete("/api/deals/:dealId/teaser/blocks/:blockId", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const r = z.coerce.number().int().nonnegative().parse(req.query.rev);
      const row = await saveDraft(deal.id, r, (doc) => ({ doc: removeBlock(doc, req.params.blockId), reason: "Deleted a block" }), [req.params.blockId]);
      res.json(await stateOf(deal, row));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't delete the block");
    }
  });

  app.post("/api/deals/:dealId/teaser/blocks/:blockId/duplicate", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ rev }).strict().parse(req.body ?? {});
      const row = await saveDraft(deal.id, body.rev, (doc) => ({ doc: duplicateBlock(doc, req.params.blockId).doc, reason: "Duplicated a block" }), []);
      res.json(await stateOf(deal, row));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't duplicate the block");
    }
  });

  app.post("/api/deals/:dealId/teaser/reorder", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ rev, ids: z.array(z.string().max(80)).max(40) }).strict().parse(req.body ?? {});
      const row = await saveDraft(deal.id, body.rev, (doc) => ({ doc: reorder(doc, body.ids), reason: "Moved blocks" }), []);
      res.json(await stateOf(deal, row));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't move the blocks");
    }
  });

  app.patch("/api/deals/:dealId/teaser/blocks/:blockId/layout", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ rev, layoutType: z.enum(TEASER_LAYOUTS as unknown as [string, ...string[]]), convert: z.enum(["blank", "ai"]) }).strict().parse(req.body ?? {});
      const row0 = await requireRow(deal);
      const block = row0.draft.blocks.find((b) => b.id === req.params.blockId);
      if (!block) return res.status(404).json({ error: "That block isn't in this teaser any more." });
      let converted: { title: string; layoutData: Record<string, unknown>; body: string | null } | null = null;
      if (body.convert === "ai" && isTeaserLayout(body.layoutType) && !["two_column", "line_chart", "divider"].includes(body.layoutType)) {
        const p = await writeBlock(deal, { layoutType: body.layoutType, title: block.title, current: { title: block.title, body: block.body, layoutData: block.layoutData }, instructions: "Keep the meaning; only change the layout." });
        converted = { title: p.title, layoutData: p.layoutData, body: p.body };
      }
      const row = await saveDraft(deal.id, body.rev, (doc) => {
        let next = setLayout(doc, req.params.blockId, body.layoutType);
        if (converted) next = patchBlock(next, req.params.blockId, { layoutData: converted.layoutData, body: converted.body });
        return { doc: next, reason: "Changed a block's layout" };
      }, [req.params.blockId]);
      res.json(await stateOf(deal, row));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't change the layout");
    }
  });

  app.post("/api/deals/:dealId/teaser/blocks/:blockId/rewrite", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ instructions: z.string().max(600).nullable().optional(), tones: z.array(z.string().max(30)).max(3).optional(), length: z.enum(["shorter", "same", "longer"]).nullable().optional() }).strict().parse(req.body ?? {});
      const row = await requireRow(deal);
      const block = row.draft.blocks.find((b) => b.id === req.params.blockId);
      if (!block) return res.status(404).json({ error: "That block isn't in this teaser any more." });
      if (["two_column", "line_chart", "divider", "metric_grid"].includes(block.layoutType) || block.origin === "fixed") {
        return res.status(400).json({ error: "This block is made from the deal's information — edit it directly or use Reset from the facts.", code: "fixed" });
      }
      const proposal = await writeBlock(deal, {
        layoutType: block.layoutType,
        title: block.title,
        current: { title: block.title, body: block.body, layoutData: block.layoutData },
        instructions: body.instructions ?? null,
        tones: body.tones,
        length: body.length ?? null,
      });
      res.json({ proposal });
    } catch (err) {
      await sendError(res, err, deal, "Couldn't rewrite the block");
    }
  });

  app.post("/api/deals/:dealId/teaser/blocks/:blockId/reset", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ rev }).strict().parse(req.body ?? {});
      const row0 = await requireRow(deal);
      const block = row0.draft.blocks.find((b) => b.id === req.params.blockId);
      if (!block) return res.status(404).json({ error: "That block isn't in this teaser any more." });
      const f = await teaserFigures(deal);
      const s = { numbers: row0.numbers, showAskingPrice: row0.showAskingPrice };
      const fixedish = block.slot === "trend" || freshCellsFor(block.slot, row0.templateKey, f, s, block) !== null;
      if (fixedish) {
        const row = await saveDraft(deal.id, body.rev, (doc) => ({ doc: recomputeFixed(doc, row0.templateKey, f, s, { all: true, onlyBlockId: block.id }).doc, reason: "Reset a block from the facts" }), [block.id]);
        return res.json(await stateOf(deal, row));
      }
      if (block.slot === "next_step" || block.slot === "confidentiality") {
        const fresh = await fixedBlockFor(deal, row0, block.slot, row0.templateKey);
        const row = await saveDraft(deal.id, body.rev, (doc) => ({
          doc: { ...doc, blocks: doc.blocks.map((b) => (b.id === block.id && fresh ? { ...fresh, id: b.id } : b)) },
          reason: "Reset a block",
        }), [block.id]);
        return res.json(await stateOf(deal, row));
      }
      // An AI block: a fresh proposal (not saved) — on the AI limit.
      if (!(await runLimiter(teaserAiLimiter(), req, res))) return;
      const proposal = await writeBlock(deal, { layoutType: block.layoutType, title: block.title, instructions: null });
      res.json({ proposal });
    } catch (err) {
      await sendError(res, err, deal, "Couldn't reset the block");
    }
  });

  app.post("/api/deals/:dealId/teaser/undo", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ rev }).strict().parse(req.body ?? {});
      let nothing = false;
      const store = teaserStore();
      let conflict: TeaserConflict | null = null;
      const row = await store.update(deal.id, (r) => {
        if (r.draftRev !== body.rev) {
          conflict = new TeaserConflict("stale", "This teaser changed in another tab — showing the latest.");
          return null;
        }
        if (r.generation?.status === "running") {
          conflict = new TeaserConflict("writing", "Cimple is writing your teaser — try again in a moment.");
          return null;
        }
        const u = undoDoc(r.history);
        if (!u) {
          nothing = true;
          return null;
        }
        return { draft: u.doc, draftRev: r.draftRev + 1, history: r.history.slice(0, -1) };
      });
      if (conflict) throw conflict;
      if (!row) throw new TeaserConflict("missing", "There's no teaser yet.");
      if (nothing) return res.status(409).json({ error: "There's nothing to undo.", code: "nothing_to_undo" });
      res.json(await stateOf(deal, row));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't undo");
    }
  });

  app.post("/api/deals/:dealId/teaser/confirm-review", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ rev }).strict().parse(req.body ?? {});
      const row0 = await requireRow(deal);
      if (row0.draftRev !== body.rev) throw new TeaserConflict("stale", "This teaser changed in another tab — showing the latest.");
      // Only when the check can't run (now): a check that runs needs no confirmation.
      const k = await teaserBriefDeps().keepOut(deal.id, await teaserBriefDeps().facts(deal));
      if (!(k.by === "rules" && !!k.warning)) return res.status(409).json({ error: "The confidentiality check ran — there's nothing to confirm.", code: "review_ok" });
      const row = await teaserStore().update(deal.id, () => ({ reviewConfirmed: { by: (req.session as { brokerId?: string }).brokerId ?? null, at: new Date().toISOString() } }));
      res.json(await stateOf(deal, row!));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't save your confirmation");
    }
  });

  app.post("/api/deals/:dealId/teaser/publish", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ rev }).strict().parse(req.body ?? {});
      const row0 = await requireRow(deal);
      if (row0.draftRev !== body.rev) throw new TeaserConflict("stale", "This teaser changed in another tab — showing the latest.");
      if (row0.generation?.status === "running") throw new TeaserConflict("writing", "Cimple is writing your teaser — try again in a moment.");
      const codename = await servedCodenameFor(deal);
      if (codename === NO_CODENAME) {
        const { ensureDealCodename } = await import("../cim/codenames");
        await ensureDealCodename(deal);
      }
      const current = await servedCodenameFor({ ...deal, blindCodename: (await storage.getDeal(deal.id))?.blindCodename ?? deal.blindCodename } as Deal);
      const terms = teaserTerms(deal, current);
      const draft = swapCodename(row0.draft, row0.codenameUsed, current);
      const checks = checkTeaserDoc(draft, terms);
      const h = draft.header;
      const headerProblem = h && !guardTeaserText([h.label, h.tagline, ...h.chips], terms).ok ? "The header names the business — reword the one-line description or a chip." : null;
      const { codenameProblem } = await import("../cim/codenames");
      // The confidentiality review must succeed now (cached per content; one
      // call after a restart) — or the broker confirmed they checked it. A
      // visible block naming something the review holds (an unannounced
      // bid's customer…) is refused like a block naming the business.
      const info = await teaserBriefDeps().facts(deal);
      const k = await teaserBriefDeps().keepOut(deal.id, info);
      const reviewRanNow = !(k.by === "rules" && !!k.warning);
      const reviewOk = reviewRanNow || !!row0.reviewConfirmed;
      const { mentionsHeldName } = await import("../cim/sensitive-facts");
      const { collectStrings } = await import("@shared/blind-guard");
      const heldNameProblems: string[] = [];
      if (k.names.length > 0) {
        for (const b of draft.blocks.filter((x) => !x.hidden)) {
          const hit = mentionsHeldName(collectStrings([b.title, b.body ?? "", b.layoutData]).join("\n"), k.names);
          if (hit) heldNameProblems.push(`${b.title || "A block"}: it mentions “${hit}”, which the seller asked to keep confidential. Reword it.`);
        }
        if (h && mentionsHeldName([h.tagline, ...h.chips].join("\n"), k.names)) heldNameProblems.push("The header mentions something the seller asked to keep confidential. Reword it.");
      }
      const discrepancies = discrepancyGateFor((await storage.getDiscrepanciesByDeal(deal.id).catch(() => [])) as never, row0.numbers);
      const problems = [...publishProblems(draft, {
        codenameProblem: codenameProblem(deal as never, current),
        checks,
        headerProblem,
        reviewOk,
        discrepancyReasons: discrepancies.reasons,
      }), ...heldNameProblems];
      if (problems.length > 0) return res.status(409).json({ error: problems[0], problems, code: "cant_publish" });
      let conflict: TeaserConflict | null = null;
      const row = await teaserStore().update(deal.id, (r) => {
        if (r.draftRev !== body.rev) {
          conflict = new TeaserConflict("stale", "This teaser changed in another tab — showing the latest.");
          return null;
        }
        return {
          draft,
          codenameUsed: current,
          published: publishedSnapshot(draft),
          publishedRev: r.publishedRev + 1,
          publishedAt: new Date(),
          unpublishedAt: null,
          ...(reviewRanNow && r.generation?.reviewFailed ? { generation: { ...r.generation, reviewFailed: false } } : {}),
        };
      });
      if (conflict) throw conflict;
      res.json(await stateOf(deal, row!));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't publish the teaser");
    }
  });

  app.post("/api/deals/:dealId/teaser/unpublish", ...broker, async (_req, res) => {
    const deal = dealOf(res);
    try {
      await requireRow(deal);
      const row = await teaserStore().update(deal.id, () => ({ unpublishedAt: new Date() }));
      res.json(await stateOf(deal, row!));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't take the teaser offline");
    }
  });

  app.delete("/api/deals/:dealId/teaser", ...broker, async (_req, res) => {
    const deal = dealOf(res);
    try {
      await deleteTeaser(deal.id);
      res.status(204).end();
    } catch (err) {
      await sendError(res, err, deal, "Couldn't delete the teaser");
    }
  });

  app.post("/api/deals/:dealId/teaser/seller-check", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const { sellerReviewLimiter } = await import("./seller-review");
      if (!(await runLimiter(sellerReviewLimiter, req, res))) return;
      const body = z.object({ rev }).strict().parse(req.body ?? {});
      const row = await sendSellerCheck(deal, body.rev);
      res.json(await stateOf(deal, row));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't send the teaser to the seller");
    }
  });

  /** The buyer payload for the published (or draft) teaser — the broker's preview, no token, no reading recorded. */
  app.get("/api/deals/:dealId/teaser/preview", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const row = await requireRow(deal);
      const draft = req.query.draft === "1" || !row.published;
      const built = await buyerTeaserFor(deal, row, { draft });
      res.json({
        document: "teaser",
        preview: true,
        draft,
        deal: { id: deal.id, businessName: built.codename, industry: deal.industry },
        teaser: { header: built.teaser.header, blocks: built.teaser.blocks, pageSize: row.pageSize },
        heldBack: built.teaser.leaked.map((id) => ({ blockId: id, reason: built.teaser.leakReasons[id] })),
        design: built.design,
        branding: { companyName: built.design.brokerage.firmName, logoUrl: built.design.brokerage.logoUrl, disclaimer: built.design.brokerage.disclaimer },
        contact: built.contact,
        ndaRequired: !!deal.ndaRequired,
      });
    } catch (err) {
      await sendError(res, err, deal, "Couldn't load the preview");
    }
  });

  app.get("/api/deals/:dealId/teaser/engagement", ...broker, async (_req, res) => {
    const deal = dealOf(res);
    try {
      res.json(await teaserEngagement(deal.id));
    } catch (err) {
      await sendError(res, err, deal, "Couldn't load the teaser's reading");
    }
  });

  // ── Saved templates and brokerage wording ───────────────────────────────
  app.get("/api/broker/teaser-templates", requireBroker, async (req, res) => {
    try {
      res.json(await listTeaserTemplates((req.session as { brokerId: string }).brokerId));
    } catch (err) {
      await sendError(res, err, null, "Couldn't load your templates");
    }
  });

  app.post("/api/deals/:dealId/teaser/save-template", ...broker, async (req, res) => {
    const deal = dealOf(res);
    try {
      const body = z.object({ name: z.string().min(1).max(200), makeDefault: z.boolean().optional() }).strict().parse(req.body ?? {});
      const row = await requireRow(deal);
      const basedOn = isBuiltInTeaserTemplate(row.templateKey) ? row.templateKey : null;
      const template = await saveTeaserTemplate(deal.brokerId, { name: body.name, basedOn, doc: row.draft, settings: { pageSize: row.pageSize, numbers: row.numbers, showAskingPrice: row.showAskingPrice }, makeDefault: body.makeDefault });
      res.json({ template });
    } catch (err) {
      await sendError(res, err, deal, "Couldn't save the template");
    }
  });

  app.patch("/api/broker/teaser-templates/:id", requireBroker, async (req, res) => {
    try {
      const body = z.object({ name: z.string().min(1).max(200).optional(), makeDefault: z.boolean().optional() }).strict().parse(req.body ?? {});
      const t = await renameTeaserTemplate((req.session as { brokerId: string }).brokerId, req.params.id, body);
      if (!t) return res.status(404).json({ error: "That template isn't there any more." });
      res.json({ template: t });
    } catch (err) {
      await sendError(res, err, null, "Couldn't save the template");
    }
  });

  app.delete("/api/broker/teaser-templates/:id", requireBroker, async (req, res) => {
    try {
      const ok = await deleteTeaserTemplate((req.session as { brokerId: string }).brokerId, req.params.id);
      if (!ok) return res.status(404).json({ error: "That template isn't there any more." });
      res.status(204).end();
    } catch (err) {
      await sendError(res, err, null, "Couldn't delete the template");
    }
  });

  /** Settings → Brand & templates → Teaser: the brokerage's confidentiality line, next-step wording, default template. */
  app.get("/api/broker/teaser-settings", requireBroker, async (req, res) => {
    try {
      res.json(await getTeaserSettings((req.session as { brokerId: string }).brokerId));
    } catch (err) {
      await sendError(res, err, null, "Couldn't load the teaser settings");
    }
  });

  app.patch("/api/broker/teaser-settings", requireBroker, async (req, res) => {
    try {
      const body = z.object({ confidentiality: z.string().max(400).nullable().optional(), nextStep: z.string().max(400).nullable().optional(), defaultTemplate: z.string().max(80).nullable().optional() }).strict().parse(req.body ?? {});
      const brokerId = (req.session as { brokerId: string }).brokerId;
      if (body.defaultTemplate) {
        const { templates } = await listTeaserTemplates(brokerId);
        if (!isBuiltInTeaserTemplate(body.defaultTemplate) && !templates.some((t) => t.key === body.defaultTemplate)) return res.status(400).json({ error: "That template doesn't exist." });
      }
      res.json(await patchTeaserSettings(brokerId, body));
    } catch (err) {
      await sendError(res, err, null, "Couldn't save the teaser settings");
    }
  });

  // ── Buyer: the email check, asking for the CIM, "Not for me", a fresh link ──
  const buyerTeaserGate = async (req: Request, res: Response): Promise<{ access: BuyerAccess; deal: Deal; row: TeaserRow } | null> => {
    const found = await viewAccess(req, res);
    if (!found) return null;
    if (!isTeaserOnly(found.access.accessLevel)) {
      res.status(409).json({ error: "You already have the CIM.", code: "already_cim" });
      return null;
    }
    const row = await getDealTeaser(found.deal.id);
    if (!row || !linkOpenForBuyer(found.deal, found.access, row)) {
      res.status(403).json({ code: "not_published", error: "This summary isn't available right now." });
      return null;
    }
    return { ...found, row };
  };

  app.post("/api/view/:token/email-check", perLink(requestLimiter), async (req, res) => {
    try {
      const g = await buyerTeaserGate(req, res);
      if (!g) return;
      const { brokerageBrand } = await import("../cim/templates");
      const firm = (await brokerageBrand(g.deal.brokerId).catch(() => null))?.firmName ?? null;
      const r = await sendEmailCode(g.access, g.deal, { buyerId: (req.session as { buyerId?: string } | undefined)?.buyerId ?? null, firm });
      if ("limited" in r) return res.status(429).json({ error: r.error, code: "too_many_codes" });
      res.json(r);
    } catch (err) {
      await sendError(res, err, null, "Couldn't send the code");
    }
  });

  app.post("/api/view/:token/email-check/verify", perLink(requestLimiter), async (req, res) => {
    try {
      const g = await buyerTeaserGate(req, res);
      if (!g) return;
      const body = z.object({ code: z.string().max(20) }).strict().parse(req.body ?? {});
      const r = await verifyEmailCode(g.access, body.code);
      if (r.verified) return res.json({ verified: true });
      if (r.code === "wrong") return res.status(400).json({ error: `That code isn't right — ${r.triesLeft} ${r.triesLeft === 1 ? "try" : "tries"} left.`, code: "wrong_code", triesLeft: r.triesLeft });
      if (r.code === "expired") return res.status(410).json({ error: "That code has expired. Send a new one.", code: "expired" });
      if (r.code === "locked") return res.status(400).json({ error: "Too many tries. Send a new code.", code: "locked", triesLeft: 0 });
      return res.status(400).json({ error: "Send a code first.", code: "no_code" });
    } catch (err) {
      await sendError(res, err, null, "Couldn't check the code");
    }
  });

  app.post("/api/view/:token/cim-request", perLink(requestLimiter), async (req, res) => {
    try {
      const g = await buyerTeaserGate(req, res);
      if (!g) return;
      const body = z.object({ profile: z.unknown().optional(), confirmProfile: z.boolean().optional(), note: z.string().max(1000).nullable().optional() }).strict().parse(req.body ?? {});
      const check = await requireEmailCheck(g.access, g.deal, (req.session as { buyerId?: string } | undefined)?.buyerId ?? null);
      if (!check.ok) return res.status(400).json({ error: "Confirm your email first.", code: "email_check_required" });
      let profile: Record<string, unknown> | null = null;
      if (g.deal.ndaRequired) {
        if (!g.access.ndaSigned) return res.status(400).json({ error: "Sign the NDA first.", code: "nda_required" });
      } else {
        // No NDA on this deal: the "About you" step is the request's profile.
        if (body.profile !== undefined) {
          const parsed = ndaBuyerProfileSchema.safeParse(body.profile);
          if (!parsed.success) {
            const issue = parsed.error.issues[0];
            return res.status(400).json({ error: issue?.message || "Please complete the form", field: issue?.path?.[0] ?? null, code: "profile_invalid" });
          }
          profile = parsed.data as unknown as Record<string, unknown>;
          await storage.updateBuyerAccess(g.access.id, { buyerName: parsed.data.name, buyerCompany: parsed.data.company ?? g.access.buyerCompany, ndaProfile: { ...((g.access.ndaProfile as Record<string, unknown> | null) ?? {}), ...parsed.data, submittedAt: new Date().toISOString() } } as never);
          try {
            const { applyNdaProfile } = await import("../buyers/nda-profile.js");
            const fresh = await storage.getBuyerAccess(g.access.id);
            if (fresh) await applyNdaProfile(fresh, parsed.data);
          } catch (err) {
            console.error("[teaser] applying the request profile failed:", err);
          }
        } else if (body.confirmProfile) {
          const { ndaProfileAccount } = await import("../buyers/nda-profile.js");
          const acct = await ndaProfileAccount(g.access);
          if (!acct || !hasMatchableProfile(acct)) return res.status(400).json({ error: "Please tell us a little about yourself first", code: "profile_required" });
        } else if (!g.access.ndaProfile) {
          return res.status(400).json({ error: "Please tell us a little about yourself first", code: "profile_required" });
        }
      }
      const access = (await storage.getBuyerAccess(g.access.id)) ?? g.access;
      const result = await ensureTeaserRequest(access, g.deal, { profile: profile as never, note: body.note ?? null, emailCheck: check.method, linkName: g.access.buyerName ?? null }, {
        autoGrantLevel: g.row.autoGrant,
        autoGrant: deps.grant
          ? async (request, level) => {
              const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
              await deps.grant!(request, g.deal, baseUrl, {}, { grantedBy: "auto", notifyBuyer: false, level });
            }
          : undefined,
      });
      res.json({ state: result.state, autoGranted: result.autoGranted });
    } catch (err) {
      await sendError(res, err, null, "Couldn't send your request");
    }
  });

  app.post("/api/view/:token/cim-request/note", perLink(requestLimiter), async (req, res) => {
    try {
      const found = await viewAccess(req, res);
      if (!found) return;
      if (!isTeaserOnly(found.access.accessLevel)) return res.status(409).json({ error: "You already have the CIM.", code: "already_cim" });
      const body = z.object({ note: z.string().max(1000) }).strict().parse(req.body ?? {});
      const ok = await updateRequestNote(found.access, body.note);
      if (!ok) return res.status(409).json({ error: "Ask for the CIM first.", code: "no_request" });
      res.json({ ok: true });
    } catch (err) {
      await sendError(res, err, null, "Couldn't save your note");
    }
  });

  app.post("/api/view/:token/teaser-pass", perLink(requestLimiter), async (req, res) => {
    try {
      const g = await buyerTeaserGate(req, res);
      if (!g) return;
      const body = z.object({ reasons: z.array(z.enum(TEASER_PASS_REASONS as unknown as [string, ...string[]])).max(6), note: z.string().max(500).nullable().optional() }).strict().parse(req.body ?? {});
      await recordTeaserPass(g.access, body.reasons, body.note ?? null);
      res.json({ ok: true });
    } catch (err) {
      await sendError(res, err, null, "Couldn't send that");
    }
  });

  /** An EXPIRED (not revoked) teaser link asks for a fresh one (recorded once a day; the broker decides). */
  app.post("/api/view/:token/fresh-link", perLink(freshLimiter), async (req, res) => {
    try {
      const access = await storage.getBuyerAccessByToken(req.params.token);
      if (!access) return res.status(404).json({ error: "Access denied or link expired" });
      const r = await recordFreshLinkRequest(access);
      if (r === "revoked") return res.status(403).json({ error: "Access has been revoked" });
      if (r === "not_teaser" || r === "not_expired") return res.status(409).json({ error: "This link doesn't need a new one.", code: r });
      res.json({ ok: true, already: r === "already" });
    } catch (err) {
      await sendError(res, err, null, "Couldn't send that");
    }
  });

  /** The request state for a buyer's teaser link (used by the request flow after a reload). */
  app.get("/api/view/:token/cim-request", async (req, res) => {
    try {
      const found = await viewAccess(req, res);
      if (!found) return;
      const requests = await storage.getBuyerApprovalRequestsByDeal(found.deal.id);
      res.json(requestStateFor(found.access.id, requests as never));
    } catch (err) {
      await sendError(res, err, null, "Couldn't load your request");
    }
  });

  void teaserPublished;
}
