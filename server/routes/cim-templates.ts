/**
 * CIM design templates and branding (workstream: cim-templates).
 * Registered from server/routes.ts (merge anchor) — keep this workstream's
 * new endpoints in this file.
 *
 *   GET    /api/cim-templates                  built-ins + the broker's custom templates, and the default
 *   POST   /api/cim-templates                  create a custom template {name, description?, tokens?, basedOn?}
 *   PATCH  /api/cim-templates/:id              rename / edit tokens / clear the section outline (custom only)
 *   DELETE /api/cim-templates/:id              delete a custom template (deals using it fall back to the default)
 *   POST   /api/cim-templates/:id/clone        copy a built-in or custom template {name?}
 *   POST   /api/cim-templates/:id/default      make it the brokerage default
 *   POST   /api/cim-templates/from-cim         "Match my existing CIM": upload a past CIM (multipart "file");
 *                                              its section outline becomes a new custom template
 *   POST   /api/cim-templates/brand-logo       brokerage logo upload (multipart "file"; PNG/JPG/WebP/GIF, no SVG)
 *   GET    /api/deals/:dealId/design           the deal's template pick + business branding (+ what applies)
 *   PATCH  /api/deals/:dealId/design           {templateId?: string|null, business?: {...}}
 *
 * Every route requires a broker session; templates, branding and deals are
 * scoped to that broker — another brokerage's template id is "not found".
 */
import type { Express, NextFunction, Request, Response } from "express";
import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { cimTemplates, deals, type Deal } from "@shared/schema";
import {
  BUILTIN_TEMPLATES,
  getBuiltinTemplate,
  sanitizeBusinessBranding,
  sanitizeOutline,
  sanitizeTokens,
  type CimBusinessBranding,
} from "@shared/cim-theme";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes";
import {
  brokerDefaultTemplateId,
  brokerageBrand,
  builtinView,
  customView,
  dealImageIds,
  findTemplate,
  getCustomTemplate,
  listCustomTemplates,
  setBrokerDefaultTemplate,
  templateForDeal,
} from "../cim/templates";
import { uploadsRoot, invalidateBuyerMedia } from "../cim/media-store";
import { detectMediaType, stripImageMetadata } from "../cim/media-files";
import { extractTextFromFile } from "../documents/parser";
import { extractCimOutline, NotACimError } from "../cim/outline-extract";

const MAX_CUSTOM_TEMPLATES = 50;
const LOGO_MAX_BYTES = 5 * 1024 * 1024;
const PAST_CIM_MAX_BYTES = 25 * 1024 * 1024;

// Same ceiling as the other AI endpoints (server/index.ts aiLimiter).
const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LOGO_MAX_BYTES, files: 1, fields: 2 } });
const pastCimUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(uploadsRoot(), "tmp-past-cim");
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename: (_req, _file, cb) => cb(null, `${randomBytes(16).toString("hex")}.part`),
  }),
  limits: { fileSize: PAST_CIM_MAX_BYTES, files: 1, fields: 4, fieldSize: 500 },
});

function receive(mw: ReturnType<typeof multer>, tooBig: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    mw.single("file")(req, res, (err: unknown) => {
      if (!err) return next();
      const code = (err as { code?: string })?.code;
      if (code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: tooBig });
      if (code === "LIMIT_UNEXPECTED_FILE" || code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({ error: "Upload one file, in the \"file\" field." });
      }
      console.error("[cim-templates] upload failed:", err);
      return res.status(500).json({ error: "Couldn't receive the file. Please try again." });
    });
  };
}

function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return s || fallback;
}

function cleanDescription(v: unknown): string | null {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return s || null;
}

async function underTemplateLimit(brokerId: string, res: Response): Promise<boolean> {
  const rows = await listCustomTemplates(brokerId);
  if (rows.length >= MAX_CUSTOM_TEMPLATES) {
    res.status(409).json({ error: `You already have ${MAX_CUSTOM_TEMPLATES} templates. Delete one you no longer use first.` });
    return false;
  }
  return true;
}

async function removeQuietly(p: string | null | undefined) {
  if (!p) return;
  try {
    await fsp.unlink(p);
  } catch {
    /* already gone */
  }
}

/** A past CIM's type from its bytes (the parser picks by extension). */
function pastCimExt(head: Buffer, originalName: string): ".pdf" | ".docx" | ".pptx" | null {
  if (head.toString("latin1", 0, 5) === "%PDF-") return ".pdf";
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  const ext = path.extname(originalName || "").toLowerCase();
  if (isZip && ext === ".docx") return ".docx";
  if (isZip && ext === ".pptx") return ".pptx";
  return null;
}

export function registerCimTemplateRoutes(app: Express): void {
  // ── Templates ──
  app.get("/api/cim-templates", requireBroker, async (req, res) => {
    try {
      const brokerId = req.session.brokerId!;
      const [rows, defaultTemplateId, brokerage] = await Promise.all([
        listCustomTemplates(brokerId),
        brokerDefaultTemplateId(brokerId),
        brokerageBrand(brokerId),
      ]);
      res.json({
        templates: [...BUILTIN_TEMPLATES.map((t) => builtinView(t.id)!), ...rows.map(customView)],
        defaultTemplateId,
        // The saved brokerage brand, so previews show templates as they'll look.
        brokerage,
      });
    } catch (err) {
      console.error("[cim-templates] list failed:", err);
      res.status(500).json({ error: "Couldn't load your templates" });
    }
  });

  app.post("/api/cim-templates", requireBroker, async (req, res) => {
    try {
      const brokerId = req.session.brokerId!;
      if (!(await underTemplateLimit(brokerId, res))) return;
      const body = (req.body || {}) as Record<string, unknown>;
      const base = await findTemplate(brokerId, typeof body.basedOn === "string" ? body.basedOn : null);
      const tokens = sanitizeTokens(body.tokens ?? base?.tokens, base?.tokens);
      const [row] = await db
        .insert(cimTemplates)
        .values({
          brokerId,
          name: cleanName(body.name, base ? `${base.name} (custom)` : "My template"),
          description: cleanDescription(body.description) ?? base?.description ?? null,
          tokens,
          sectionOutline: sanitizeOutline(body.sectionOutline) ?? base?.sectionOutline ?? null,
          basedOn: base?.id ?? null,
        })
        .returning();
      res.status(201).json(customView(row));
    } catch (err) {
      console.error("[cim-templates] create failed:", err);
      res.status(500).json({ error: "Couldn't create the template" });
    }
  });

  app.patch("/api/cim-templates/:id", requireBroker, async (req, res) => {
    try {
      const brokerId = req.session.brokerId!;
      const id = String(req.params.id);
      if (getBuiltinTemplate(id)) return res.status(400).json({ error: "Built-in templates can't be changed — make a copy to edit." });
      const row = await getCustomTemplate(brokerId, id);
      if (!row) return res.status(404).json({ error: "Template not found" });
      const body = (req.body || {}) as Record<string, unknown>;
      const set: Partial<typeof cimTemplates.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) set.name = cleanName(body.name, row.name);
      if (body.description !== undefined) set.description = cleanDescription(body.description);
      if (body.tokens !== undefined) set.tokens = sanitizeTokens(body.tokens, sanitizeTokens(row.tokens));
      if (body.sectionOutline !== undefined) {
        if (body.sectionOutline === null) set.sectionOutline = null;
        else {
          const outline = sanitizeOutline(body.sectionOutline);
          if (!outline) return res.status(400).json({ error: "The section outline needs at least one section title." });
          set.sectionOutline = outline;
        }
      }
      const [updated] = await db
        .update(cimTemplates)
        .set(set)
        .where(and(eq(cimTemplates.id, row.id), eq(cimTemplates.brokerId, brokerId)))
        .returning();
      res.json(customView(updated));
    } catch (err) {
      console.error("[cim-templates] update failed:", err);
      res.status(500).json({ error: "Couldn't save the template" });
    }
  });

  app.delete("/api/cim-templates/:id", requireBroker, async (req, res) => {
    try {
      const brokerId = req.session.brokerId!;
      const id = String(req.params.id);
      if (getBuiltinTemplate(id)) return res.status(400).json({ error: "Built-in templates can't be deleted." });
      const row = await getCustomTemplate(brokerId, id);
      if (!row) return res.status(404).json({ error: "Template not found" });
      // Deals and the brokerage default that point at it fall back to the
      // default / Classic Paper (templateForDeal treats a missing id that way;
      // clearing keeps the data tidy).
      await db
        .update(deals)
        .set({ designTemplateId: null })
        .where(and(eq(deals.brokerId, brokerId), eq(deals.designTemplateId, row.id)));
      const branding = await storage.getBrandingByBroker(brokerId);
      if (branding?.defaultTemplateId === row.id) await setBrokerDefaultTemplate(brokerId, null);
      await db.delete(cimTemplates).where(and(eq(cimTemplates.id, row.id), eq(cimTemplates.brokerId, brokerId)));
      res.json({ success: true, deletedId: row.id });
    } catch (err) {
      console.error("[cim-templates] delete failed:", err);
      res.status(500).json({ error: "Couldn't delete the template" });
    }
  });

  app.post("/api/cim-templates/:id/clone", requireBroker, async (req, res) => {
    try {
      const brokerId = req.session.brokerId!;
      const source = await findTemplate(brokerId, String(req.params.id));
      if (!source) return res.status(404).json({ error: "Template not found" });
      if (!(await underTemplateLimit(brokerId, res))) return;
      const [row] = await db
        .insert(cimTemplates)
        .values({
          brokerId,
          name: cleanName(req.body?.name, `${source.name} copy`),
          description: `Your version of ${source.name}.`,
          tokens: sanitizeTokens(source.tokens),
          sectionOutline: source.sectionOutline,
          basedOn: source.id,
        })
        .returning();
      res.status(201).json(customView(row));
    } catch (err) {
      console.error("[cim-templates] clone failed:", err);
      res.status(500).json({ error: "Couldn't copy the template" });
    }
  });

  app.post("/api/cim-templates/:id/default", requireBroker, async (req, res) => {
    try {
      const brokerId = req.session.brokerId!;
      const t = await findTemplate(brokerId, String(req.params.id));
      if (!t) return res.status(404).json({ error: "Template not found" });
      await setBrokerDefaultTemplate(brokerId, t.id);
      res.json({ success: true, defaultTemplateId: t.id });
    } catch (err) {
      console.error("[cim-templates] set default failed:", err);
      res.status(500).json({ error: "Couldn't set the default template" });
    }
  });

  // ── Match my existing CIM ──
  app.post(
    "/api/cim-templates/from-cim",
    requireBroker,
    aiLimiter,
    async (req, res, next) => {
      try {
        if (await underTemplateLimit(req.session.brokerId!, res)) next();
      } catch (err) {
        next(err);
      }
    },
    receive(pastCimUpload, "That file is too big. Upload a CIM up to 25 MB."),
    async (req, res) => {
      const file = req.file;
      if (!file) return res.status(400).json({ error: "Choose your past CIM (a PDF) to upload." });
      let readable: string | null = null;
      try {
        const brokerId = req.session.brokerId!;
        const fh = await fsp.open(file.path, "r");
        const head = Buffer.alloc(16);
        await fh.read(head, 0, 16, 0);
        await fh.close();
        const ext = pastCimExt(head, file.originalname);
        if (!ext) return res.status(415).json({ error: "Upload the CIM as a PDF (Word .docx and PowerPoint .pptx also work)." });
        readable = file.path.replace(/\.part$/, ext);
        await fsp.rename(file.path, readable);
        const text = await extractTextFromFile(readable);
        const sourceName = (file.originalname || `past CIM${ext}`).slice(0, 200);
        const outline = await extractCimOutline(text, sourceName);
        const base =
          (await findTemplate(brokerId, typeof req.body?.basedOn === "string" ? req.body.basedOn : null)) ??
          (await findTemplate(brokerId, await brokerDefaultTemplateId(brokerId)))!;
        const title = sourceName.replace(/\.(pdf|docx|pptx)$/i, "").replace(/[_]+/g, " ").trim().slice(0, 50);
        const [row] = await db
          .insert(cimTemplates)
          .values({
            brokerId,
            name: cleanName(req.body?.name, `Matched: ${title || "past CIM"}`),
            description: `Follows the ${outline.sections.length}-section structure of ${sourceName}. Styled like ${base.name}.`,
            tokens: sanitizeTokens(base.tokens),
            sectionOutline: outline,
            basedOn: base.id,
          })
          .returning();
        res.status(201).json(customView(row));
      } catch (err) {
        if (err instanceof NotACimError) return res.status(422).json({ error: err.message });
        console.error("[cim-templates] from-cim failed:", err);
        res.status(500).json({ error: "Couldn't read that CIM. Try again, or try a different file." });
      } finally {
        // The past CIM is another client's confidential document — never kept.
        await removeQuietly(file.path);
        await removeQuietly(readable);
      }
    },
  );

  // ── Brokerage logo ──
  app.post(
    "/api/cim-templates/brand-logo",
    requireBroker,
    receive(logoUpload, "Logos can be up to 5 MB."),
    async (req, res) => {
      try {
        const file = req.file;
        if (!file?.buffer) return res.status(400).json({ error: "Choose a logo image to upload." });
        const type = detectMediaType(file.buffer.subarray(0, 4100));
        if (!type || type.kind !== "image") {
          return res.status(415).json({ error: "Upload the logo as a PNG, JPG, WebP or GIF image. SVG isn't supported — export it as a PNG." });
        }
        let clean: Buffer;
        try {
          clean = stripImageMetadata(file.buffer, type.mime);
        } catch (err) {
          return res.status(415).json({ error: `${(err as Error).message}. Try exporting it again as a PNG.` });
        }
        // Brokerage logos are public marketing assets (shown in Blind CIMs
        // too), served statically — under an unguessable name.
        const dir = path.join(uploadsRoot(), "brand");
        await fsp.mkdir(dir, { recursive: true });
        const name = `${randomBytes(16).toString("hex")}.${type.ext}`;
        await fsp.writeFile(path.join(dir, name), clean, { mode: 0o644 });
        res.status(201).json({ url: `/uploads/brand/${name}` });
      } catch (err) {
        console.error("[cim-templates] logo upload failed:", err);
        res.status(500).json({ error: "Couldn't save the logo. Please try again." });
      }
    },
  );

  // ── A deal's design ──
  app.get("/api/deals/:dealId/design", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const brokerId = req.session.brokerId!;
      const branding = (await storage.getBrandingByBroker(brokerId)) ?? null;
      const [own, effective, defaultTemplateId, brokerage] = await Promise.all([
        findTemplate(brokerId, deal.designTemplateId),
        templateForDeal(deal, branding),
        brokerDefaultTemplateId(brokerId, branding),
        brokerageBrand(brokerId, branding),
      ]);
      res.json({
        templateId: own?.id ?? null,
        defaultTemplateId,
        template: effective,
        brokerage,
        business: sanitizeBusinessBranding(deal.businessBranding),
      });
    } catch (err) {
      console.error("[cim-templates] design read failed:", err);
      res.status(500).json({ error: "Couldn't load this CIM's design" });
    }
  });

  app.patch("/api/deals/:dealId/design", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const brokerId = req.session.brokerId!;
      const body = (req.body || {}) as Record<string, unknown>;
      const set: Partial<Deal> = {};
      if (body.templateId !== undefined) {
        if (body.templateId === null) set.designTemplateId = null;
        else {
          const t = await findTemplate(brokerId, typeof body.templateId === "string" ? body.templateId : null);
          if (!t) return res.status(404).json({ error: "Template not found" });
          set.designTemplateId = t.id;
        }
      }
      if (body.business !== undefined) {
        if (!body.business || typeof body.business !== "object") return res.status(400).json({ error: "business must be an object" });
        const incoming = body.business as Record<string, unknown>;
        const merged = sanitizeBusinessBranding({ ...sanitizeBusinessBranding(deal.businessBranding), ...incoming });
        // Colours: a value that isn't a colour is refused, not silently dropped.
        for (const k of ["primaryColor", "accentColor"] as const) {
          if (incoming[k] !== undefined && incoming[k] !== null && incoming[k] !== "" && !merged[k]) {
            return res.status(400).json({ error: "Colours must be hex values like #1F3A68." });
          }
        }
        // Logo / cover photo must be photos in THIS deal's media library.
        const images = await dealImageIds(deal.id);
        for (const k of ["logoMediaId", "coverPhotoMediaId"] as const) {
          if (incoming[k] !== undefined && incoming[k] !== null && (!merged[k] || !images.has(merged[k]!))) {
            return res.status(400).json({ error: "Pick a photo from this deal's media library." });
          }
        }
        set.businessBranding = merged as CimBusinessBranding;
      }
      if (Object.keys(set).length === 0) return res.status(400).json({ error: "Nothing to change" });
      const updated = await storage.updateDeal(deal.id, set as any);
      // Which files a named-CIM buyer may fetch just changed.
      if (set.businessBranding !== undefined) invalidateBuyerMedia(deal.id);
      const branding = (await storage.getBrandingByBroker(brokerId)) ?? null;
      const effective = await templateForDeal(updated ?? { ...deal, ...set }, branding);
      res.json({
        templateId: (updated ?? deal).designTemplateId ?? null,
        template: effective,
        business: sanitizeBusinessBranding((updated ?? { ...deal, ...set }).businessBranding),
      });
    } catch (err) {
      console.error("[cim-templates] design update failed:", err);
      res.status(500).json({ error: "Couldn't save this CIM's design" });
    }
  });
}
