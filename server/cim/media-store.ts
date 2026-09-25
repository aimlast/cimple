/**
 * media-store — where CIM photos/videos live and who may fetch them.
 *
 * Files: <UPLOADS_DIR>/private-media/<dealId>/<random>.<ext>. server/routes.ts
 * refuses every /uploads/private-media/* request before the public static
 * handler, so the only way to a file is GET /api/media/:id, which asks
 * canBuyerSeeMedia() for view-room tokens: the buyer's link must be valid,
 * past the NDA if one is required, and the file must be in a section this
 * buyer's CIM actually shows (the same buildBuyerCim() rules as the view
 * room — so a Blind buyer never gets a photo that isn't blind-safe, and a
 * teaser buyer never gets one from a locked section).
 */
import path from "path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { dealMedia, type BuyerAccess, type DealMedia } from "@shared/schema";
import { buildBuyerCim, ndaBlocksBuyer } from "@shared/cim-buyer-view";
import { cimModeForAccessLevel } from "@shared/cim-layouts";
import { mediaIdsIn, normalizeMediaLayoutData, type MediaAssetRef, type MediaLayoutKey } from "@shared/cim-media";
import { businessBrandingMediaIds } from "./templates";

export const PRIVATE_MEDIA_DIR = "private-media";

export function uploadsRoot(): string {
  return process.env.UPLOADS_DIR || path.join(process.cwd(), "public", "uploads");
}

export function dealMediaDir(dealId: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(dealId)) throw new Error("Invalid deal id");
  return path.join(uploadsRoot(), PRIVATE_MEDIA_DIR, dealId);
}

/** Absolute path of a media row's file — only ever inside private-media/. */
export function mediaFilePath(row: Pick<DealMedia, "fileUrl">): string | null {
  const root = path.resolve(uploadsRoot(), PRIVATE_MEDIA_DIR);
  const abs = path.resolve(uploadsRoot(), row.fileUrl);
  return abs.startsWith(root + path.sep) ? abs : null;
}

export async function listDealMedia(dealId: string): Promise<DealMedia[]> {
  return db.select().from(dealMedia).where(eq(dealMedia.dealId, dealId)).orderBy(dealMedia.createdAt);
}

/** The library as the buyer-view rules need it. */
export async function loadMediaAssets(dealId: string): Promise<MediaAssetRef[]> {
  const rows = await db
    .select({ id: dealMedia.id, kind: dealMedia.kind, blindSafe: dealMedia.blindSafe })
    .from(dealMedia)
    .where(eq(dealMedia.dealId, dealId));
  return rows.map((r) => ({ id: r.id, kind: r.kind === "video" ? "video" : "image", blindSafe: !!r.blindSafe }));
}

/**
 * A media section's data as it may be stored: normalised (valid links,
 * limits) and pointing only at uploads in THIS deal's library, of the
 * right kind. Used on every write of a gallery / video / map section.
 */
export async function cleanMediaLayoutForDeal(
  layoutType: MediaLayoutKey,
  data: unknown,
  dealId: string,
): Promise<Record<string, unknown>> {
  const clean = normalizeMediaLayoutData(layoutType, data);
  if (layoutType === "location_map") return clean;
  const assets = new Map((await loadMediaAssets(dealId)).map((a) => [a.id, a]));
  const want = layoutType === "image_gallery" ? "image" : "video";
  const key = layoutType === "image_gallery" ? "images" : "items";
  const list = Array.isArray(clean[key]) ? (clean[key] as Array<{ mediaId?: string }>) : [];
  return { ...clean, [key]: list.filter((it) => !it.mediaId || assets.get(it.mediaId)?.kind === want) };
}

// ── Buyer access to one file ────────────────────────────────────────────

/**
 * `access` fingerprints what the set was built from (level + NDA state): a
 * broker downgrading/upgrading the link or the buyer signing the NDA changes
 * it, so the next request rebuilds instead of serving the old tier's photos.
 */
interface Visible { at: number; dealId: string; access: string; ids: Set<string> }
const visibleByToken = new Map<string, Visible>();
const VISIBLE_TTL_MS = 30_000;

/** Forget cached buyer visibility for a deal (media or sections changed). */
export function invalidateBuyerMedia(dealId: string): void {
  visibleByToken.forEach((v, token) => {
    if (v.dealId === dealId) visibleByToken.delete(token);
  });
}

function accessUsable(access: BuyerAccess | undefined): access is BuyerAccess {
  if (!access || access.revokedAt) return false;
  if (access.expiresAt && new Date(access.expiresAt) < new Date()) return false;
  return true;
}

const accessFingerprint = (a: BuyerAccess) => `${a.accessLevel}|${a.ndaSigned ? 1 : 0}`;

/** Media ids shown in the CIM this buyer link currently receives. */
async function visibleMediaFor(token: string, access: BuyerAccess): Promise<Visible> {
  const hit = visibleByToken.get(token);
  if (hit && Date.now() - hit.at < VISIBLE_TTL_MS && hit.dealId === access.dealId && hit.access === accessFingerprint(access)) return hit;
  const ids = new Set<string>();
  const deal = await storage.getDeal(access.dealId);
  if (deal && !ndaBlocksBuyer(deal, access)) {
    const mode = cimModeForAccessLevel(access.accessLevel);
    const [sections, overrides, media] = await Promise.all([
      storage.getCimSectionsByDeal(deal.id),
      mode === "normal" ? Promise.resolve([]) : storage.getCimSectionOverrides(deal.id, mode),
      loadMediaAssets(deal.id),
    ]);
    const cim = buildBuyerCim({ deal, accessLevel: access.accessLevel, sections, overrides, media });
    for (const s of cim.sections) {
      if (s.locked) continue;
      for (const id of mediaIdsIn(s.layoutType, s.layoutData)) ids.add(id);
    }
    // The business's logo and cover photo (cim-templates): named CIMs only.
    if (mode !== "blind" && !cim.preparing) {
      for (const id of businessBrandingMediaIds(deal)) ids.add(id);
    }
  }
  const v = { at: Date.now(), dealId: access.dealId, access: accessFingerprint(access), ids };
  visibleByToken.set(token, v);
  if (visibleByToken.size > 5000) visibleByToken.clear();
  return v;
}

export async function canBuyerSeeMedia(token: string, row: DealMedia): Promise<boolean> {
  const access = await storage.getBuyerAccessByToken(token);
  if (!accessUsable(access) || access.dealId !== row.dealId) return false;
  const visible = await visibleMediaFor(token, access);
  return visible.ids.has(row.id);
}
