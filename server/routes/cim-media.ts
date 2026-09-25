/**
 * CIM media: uploads, gated media serving, map/video/gallery blocks (workstream: cim-media).
 * Registered from server/routes.ts (merge anchor) — keep this workstream's
 * new endpoints in this file.
 *
 *   GET    /api/deals/:dealId/media            the deal's media library (+ where each file is used)
 *   POST   /api/deals/:dealId/media            upload one photo or video (multipart "file")
 *   PATCH  /api/deals/:dealId/media/:mediaId   caption, blindSafe
 *   DELETE /api/deals/:dealId/media/:mediaId   ?detach=1 also removes it from the sections using it
 *   GET    /api/media/:mediaId                 the file — owning broker session, the deal's
 *                                              seller token (?token= / X-Seller-Token), or a
 *                                              buyer view token (?t=) whose CIM shows it.
 *                                              Supports Range requests (video seeking).
 *
 * Uploads are sniffed from their bytes (never the extension), SVG is never
 * accepted, photos lose their EXIF/XMP/IPTC (GPS!) and MP4/MOV lose their
 * user-data boxes, and files get random names under private-media/, which
 * is never served statically.
 */
import type { Express, NextFunction, Request, Response } from "express";
import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import multer from "multer";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { cimSections, dealMedia, type CimSection, type Deal, type DealMedia } from "@shared/schema";
import { MEDIA_LIMITS, isMediaId, mediaIdsIn, withoutMedia } from "@shared/cim-media";
import { requireBroker, requireOwnedDeal, getOwnedDeal, sellerTokenMatchesDeal } from "../broker-auth/routes";
import { invalidateBlind } from "../cim/blind-sync";
import { historyWith } from "../cim/section-ops";
import {
  PRIVATE_MEDIA_DIR,
  canBuyerSeeMedia,
  dealMediaDir,
  invalidateBuyerMedia,
  listDealMedia,
  mediaFilePath,
} from "../cim/media-store";
import { detectMediaType, imageDimensions, neutralizeVideoMetadata, stripImageMetadata } from "../cim/media-files";

const MAX_FILES_PER_DEAL = 300;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      // requireOwnedDeal ran first — res.locals isn't reachable here, but
      // the id was already verified against the session broker.
      try {
        const dir = dealMediaDir(String(_req.params.dealId));
        fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
      } catch (err) {
        cb(err as Error, "");
      }
    },
    filename: (_req, _file, cb) => cb(null, `${randomBytes(16).toString("hex")}.part`),
  }),
  limits: { fileSize: MEDIA_LIMITS.videoBytes, files: 1, fields: 4, fieldSize: 2000 },
});

/** Runs multer and turns its errors into plain-English JSON. */
function receiveFile(req: Request, res: Response, next: NextFunction) {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    const code = (err as { code?: string })?.code;
    if (code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "That file is too big. Videos can be up to 150 MB and photos up to 15 MB." });
    }
    if (code === "LIMIT_UNEXPECTED_FILE" || code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ error: "Upload one file at a time, in the \"file\" field." });
    }
    console.error("[cim-media] upload failed:", err);
    return res.status(500).json({ error: "Couldn't receive the file. Please try again." });
  });
}

/** The media row as the broker's browser receives it (never the file path). */
function toClient(row: DealMedia, usedIn: Array<{ sectionId: string; sectionTitle: string }> = []) {
  return {
    id: row.id,
    dealId: row.dealId,
    kind: row.kind,
    mimeType: row.mimeType,
    size: row.size,
    width: row.width ?? null,
    height: row.height ?? null,
    caption: row.caption ?? "",
    blindSafe: !!row.blindSafe,
    originalName: row.originalName ?? null,
    createdAt: row.createdAt,
    url: `/api/media/${row.id}`,
    usedIn,
  };
}

/** Where each of the deal's uploads is used: mediaId → sections. */
function usageMap(sections: CimSection[]): Map<string, Array<{ sectionId: string; sectionTitle: string }>> {
  const map = new Map<string, Array<{ sectionId: string; sectionTitle: string }>>();
  for (const s of sections) {
    for (const id of Array.from(new Set(mediaIdsIn(s.layoutType, s.layoutData)))) {
      const list = map.get(id) ?? [];
      list.push({ sectionId: s.id, sectionTitle: s.sectionTitle });
      map.set(id, list);
    }
  }
  return map;
}

async function ownedMedia(req: Request, res: Response): Promise<DealMedia | null> {
  const deal = res.locals.deal as Deal;
  const id = String(req.params.mediaId);
  if (!isMediaId(id)) {
    res.status(404).json({ error: "File not found" });
    return null;
  }
  const [row] = await db.select().from(dealMedia).where(and(eq(dealMedia.id, id), eq(dealMedia.dealId, deal.id)));
  if (!row) {
    res.status(404).json({ error: "File not found" });
    return null;
  }
  return row;
}

async function removeQuietly(p: string | null | undefined) {
  if (!p) return;
  try {
    await fsp.unlink(p);
  } catch {
    /* already gone */
  }
}

function cleanCaption(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, MEDIA_LIMITS.captionChars) : null;
}

export function registerCimMediaRoutes(app: Express): void {
  // ── The library ──
  app.get("/api/deals/:dealId/media", requireBroker, requireOwnedDeal, async (_req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const [rows, sections] = await Promise.all([listDealMedia(deal.id), storage.getCimSectionsByDeal(deal.id)]);
      const usage = usageMap(sections);
      res.json(rows.map((r) => toClient(r, usage.get(r.id))));
    } catch (err) {
      console.error("[cim-media] list failed:", err);
      res.status(500).json({ error: "Couldn't load the media library" });
    }
  });

  // ── Upload ──
  app.post("/api/deals/:dealId/media", requireBroker, requireOwnedDeal, async (req, res, next) => {
    // Refuse before receiving 150 MB when the library is full.
    try {
      const deal = res.locals.deal as Deal;
      const rows = await db.select({ id: dealMedia.id }).from(dealMedia).where(eq(dealMedia.dealId, deal.id));
      if (rows.length >= MAX_FILES_PER_DEAL) {
        return res.status(409).json({ error: `This deal already has ${MAX_FILES_PER_DEAL} files. Delete some you no longer use first.` });
      }
      next();
    } catch (err) {
      next(err);
    }
  }, receiveFile, async (req, res) => {
    const file = req.file;
    const deal = res.locals.deal as Deal;
    if (!file) return res.status(400).json({ error: "Choose a photo or video to upload." });
    const partPath = file.path;
    let finalPath: string | null = null;
    try {
      const fh = await fsp.open(partPath, "r");
      const head = Buffer.alloc(4100);
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      await fh.close();
      const type = detectMediaType(head.subarray(0, bytesRead));
      if (!type) {
        await removeQuietly(partPath);
        return res.status(415).json({ error: "That file type isn't supported. Use a JPG, PNG, WebP or GIF photo, or an MP4, MOV or WebM video." });
      }
      if (type.kind === "image" && file.size > MEDIA_LIMITS.imageBytes) {
        await removeQuietly(partPath);
        return res.status(413).json({ error: "Photos can be up to 15 MB. Try a smaller or compressed version." });
      }

      const name = `${randomBytes(16).toString("hex")}.${type.ext}`;
      finalPath = path.join(dealMediaDir(deal.id), name);
      let size = file.size;
      let dims: { width: number; height: number } | null = null;
      if (type.kind === "image") {
        const raw = await fsp.readFile(partPath);
        let clean: Buffer;
        try {
          clean = stripImageMetadata(raw, type.mime);
        } catch (err) {
          await removeQuietly(partPath);
          return res.status(415).json({ error: `${(err as Error).message}. Try exporting it again as a JPG or PNG.` });
        }
        dims = imageDimensions(clean, type.mime);
        await fsp.writeFile(finalPath, clean, { mode: 0o640 });
        await removeQuietly(partPath);
        size = clean.length;
      } else {
        await neutralizeVideoMetadata(partPath, type.mime);
        await fsp.rename(partPath, finalPath);
      }

      const [row] = await db
        .insert(dealMedia)
        .values({
          dealId: deal.id,
          brokerId: req.session.brokerId!,
          kind: type.kind,
          fileUrl: `${PRIVATE_MEDIA_DIR}/${deal.id}/${name}`,
          mimeType: type.mime,
          size,
          width: dims?.width ?? null,
          height: dims?.height ?? null,
          caption: cleanCaption(req.body?.caption),
          blindSafe: false,
          originalName: typeof file.originalname === "string" ? file.originalname.slice(0, 200) : null,
        })
        .returning();
      res.status(201).json(toClient(row));
    } catch (err) {
      console.error("[cim-media] processing failed:", err);
      await removeQuietly(partPath);
      await removeQuietly(finalPath);
      res.status(500).json({ error: "Couldn't save the file. Please try again." });
    }
  });

  // ── Caption / blind-safe ──
  app.patch("/api/deals/:dealId/media/:mediaId", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const row = await ownedMedia(req, res);
      if (!row) return;
      const body = (req.body || {}) as Record<string, unknown>;
      const set: Partial<DealMedia> = {};
      if (body.caption !== undefined) {
        if (body.caption !== null && typeof body.caption !== "string") return res.status(400).json({ error: "Caption must be text" });
        set.caption = cleanCaption(body.caption);
      }
      if (body.blindSafe !== undefined) {
        if (typeof body.blindSafe !== "boolean") return res.status(400).json({ error: "blindSafe must be true or false" });
        set.blindSafe = body.blindSafe;
      }
      if (Object.keys(set).length === 0) return res.json(toClient(row));
      const [updated] = await db.update(dealMedia).set(set).where(eq(dealMedia.id, row.id)).returning();
      if ("blindSafe" in set) invalidateBuyerMedia(row.dealId);
      res.json(toClient(updated));
    } catch (err) {
      console.error("[cim-media] update failed:", err);
      res.status(500).json({ error: "Couldn't update the file" });
    }
  });

  // ── Delete (optionally removing it from the sections that use it) ──
  app.delete("/api/deals/:dealId/media/:mediaId", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const row = await ownedMedia(req, res);
      if (!row) return;
      const deal = res.locals.deal as Deal;
      const sections = await storage.getCimSectionsByDeal(deal.id);
      const using = sections.filter((s) => mediaIdsIn(s.layoutType, s.layoutData).includes(row.id));
      if (using.length > 0 && req.query.detach !== "1") {
        return res.status(409).json({
          error: `This file is used in ${using.length} section${using.length === 1 ? "" : "s"}.`,
          usedIn: using.map((s) => ({ sectionId: s.id, sectionTitle: s.sectionTitle })),
        });
      }
      for (const s of using) {
        const next = withoutMedia(s.layoutType, s.layoutData, row.id);
        if (!next) continue;
        await db
          .update(cimSections)
          .set({ layoutData: next as any, contentHistory: historyWith(s, "Removed a photo or video"), updatedAt: new Date() })
          .where(eq(cimSections.id, s.id));
      }
      if (using.length > 0) await invalidateBlind(deal.id, using.map((s) => s.id));
      await db.delete(dealMedia).where(eq(dealMedia.id, row.id));
      await removeQuietly(mediaFilePath(row));
      invalidateBuyerMedia(deal.id);
      res.json({ success: true, deletedId: row.id, detachedFrom: using.length });
    } catch (err) {
      console.error("[cim-media] delete failed:", err);
      res.status(500).json({ error: "Couldn't delete the file" });
    }
  });

  // ── The file itself (gated) ──
  app.get("/api/media/:mediaId", async (req, res) => {
    try {
      const id = String(req.params.mediaId);
      const buyerToken = typeof req.query.t === "string" ? req.query.t : null;
      const sellerToken = (req.headers["x-seller-token"] as string | undefined) || (typeof req.query.token === "string" ? req.query.token : null);
      if (!req.session.brokerId && !buyerToken && !sellerToken) {
        return res.status(401).json({ error: "Not authorized" });
      }
      if (!isMediaId(id)) return res.status(404).json({ error: "Not found" });
      const [row] = await db.select().from(dealMedia).where(eq(dealMedia.id, id));
      if (!row) return res.status(404).json({ error: "Not found" });

      let allowed = false;
      if (req.session.brokerId && (await getOwnedDeal(row.dealId, req.session.brokerId))) allowed = true;
      if (!allowed && buyerToken) allowed = await canBuyerSeeMedia(buyerToken, row);
      if (!allowed && sellerToken) allowed = await sellerTokenMatchesDeal(req, row.dealId);
      if (!allowed) return res.status(404).json({ error: "Not found" });

      const abs = mediaFilePath(row);
      if (!abs) return res.status(404).json({ error: "Not found" });
      res.setHeader("Content-Type", row.mimeType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", "inline");
      // A file opened on its own can't run anything.
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; sandbox");
      // dotfiles: the path is ours (random name) — allow a dotted parent dir.
      res.sendFile(abs, { acceptRanges: true, cacheControl: false, dotfiles: "allow", headers: { "Cache-Control": "private, max-age=300" } }, (err) => {
        if (!err) return;
        const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
        if (res.headersSent) return;
        if (status === 404 || (err as NodeJS.ErrnoException).code === "ENOENT") {
          res.status(404).json({ error: "Not found" });
        } else if (status === 416) {
          res.status(416).end();
        } else {
          console.error("[cim-media] send failed:", err);
          res.status(500).json({ error: "Couldn't send the file" });
        }
      });
    } catch (err) {
      console.error("[cim-media] serve failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "Couldn't load the file" });
    }
  });
}
