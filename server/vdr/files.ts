/**
 * Where the data room keeps its files (vdr spec §8 "Disk"), all under
 * UPLOADS_DIR and all private (the uploads gate 404s both folders):
 *
 *   private-vdr/<dealId>/<random>.<ext>                     the broker's cleaned copies
 *   private-vdr-cache/<dealId>/<itemId>/<forFile>/…         prepared files: served.pdf,
 *       p<n>.webp (base page at 1,400 px, personal numbers covered), masks.json, spots.json,
 *       sheet-<i>-<chunk>.json, doc.html, text.txt
 *
 * Every path is built from server-generated parts and confined with
 * path.resolve + a prefix check (like resolveDocumentPath); anything else is
 * refused (null). The render child only ever receives paths made here.
 */
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { resolveDocumentPath, uploadsRoot } from "../documents/document-path";

export const VDR_PRIVATE_FOLDER = "private-vdr";
export const VDR_CACHE_FOLDER = "private-vdr-cache";

/** Ids we put in paths: uuids and other plain tokens. */
export function isSafeId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}
export function isForFile(v: unknown): v is string {
  return typeof v === "string" && /^[a-f0-9]{16}$/.test(v);
}

function within(base: string, abs: string): boolean {
  return abs === base || abs.startsWith(base + path.sep);
}

function confined(base: string, ...parts: string[]): string | null {
  const b = path.resolve(base);
  const abs = path.resolve(b, ...parts);
  return within(b, abs) && abs !== b ? abs : null;
}

/** A new private file name: 128 random bits + a plain short extension. */
export function newPrivateName(ext: string): string {
  const safe = /^\.[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : "";
  return `${randomBytes(16).toString("hex")}${safe}`;
}
function isPrivateName(name: unknown): name is string {
  return typeof name === "string" && /^[a-f0-9]{32}(\.[a-z0-9]{1,8})?$/.test(name);
}

/** The relative path stored on vdr_items.clean_copy_path. */
export function cleanCopyRelPath(dealId: string, name: string): string | null {
  if (!isSafeId(dealId) || !isPrivateName(name)) return null;
  return `${VDR_PRIVATE_FOLDER}/${dealId}/${name}`;
}

/** Absolute path of a new cleaned copy, or null. */
export function cleanCopyPath(dealId: string, name: string, root: string = uploadsRoot()): string | null {
  if (!isSafeId(dealId) || !isPrivateName(name)) return null;
  return confined(path.join(root, VDR_PRIVATE_FOLDER), dealId, name);
}

/** A stored clean_copy_path → absolute path, only if it is exactly private-vdr/<dealId>/<private name>. */
export function resolveCleanCopy(rel: string | null | undefined, dealId: string, root: string = uploadsRoot()): string | null {
  if (typeof rel !== "string") return null;
  const parts = rel.split("/");
  if (parts.length !== 3 || parts[0] !== VDR_PRIVATE_FOLDER || parts[1] !== dealId) return null;
  return cleanCopyPath(dealId, parts[2], root);
}

/** The file buyers are served for an item: the broker's cleaned copy, else the document's own file. */
export function servedFilePath(
  item: { dealId: string; cleanCopyPath?: string | null },
  doc: { fileUrl?: string | null } | null,
  root: string = uploadsRoot(),
): string | null {
  if (item.cleanCopyPath) return resolveCleanCopy(item.cleanCopyPath, item.dealId, root);
  return doc ? resolveDocumentPath(doc, root) : null;
}

/** The deal's cache root (private-vdr-cache/<dealId>). */
export function vdrDealCacheDir(dealId: string, root: string = uploadsRoot()): string | null {
  return isSafeId(dealId) ? confined(path.join(root, VDR_CACHE_FOLDER), dealId) : null;
}
/** The deal's cleaned-copy folder (private-vdr/<dealId>). */
export function vdrDealPrivateDir(dealId: string, root: string = uploadsRoot()): string | null {
  return isSafeId(dealId) ? confined(path.join(root, VDR_PRIVATE_FOLDER), dealId) : null;
}

/** An item's cache folder for one served file (private-vdr-cache/<dealId>/<itemId>/<forFile>). */
export function vdrCacheDir(dealId: string, itemId: string, forFile: string, root: string = uploadsRoot()): string | null {
  if (!isSafeId(dealId) || !isSafeId(itemId) || !isForFile(forFile)) return null;
  return confined(path.join(root, VDR_CACHE_FOLDER), dealId, itemId, forFile);
}

const CACHE_NAME = /^(served\.pdf|masks\.json|spots\.json|doc\.html|text\.txt|manifest\.json|p[1-9]\d{0,3}\.webp|sheet-\d{1,3}-\d{1,4}\.json)$/;

/** A file inside a cache folder; only the names the prepare pipeline writes. */
export function cacheFile(dir: string, name: string): string | null {
  if (!CACHE_NAME.test(name)) return null;
  return confined(dir, name);
}

export const basePageName = (page: number) => `p${page}.webp`;
export const sheetChunkName = (sheet: number, chunk: number) => `sheet-${sheet}-${chunk}.json`;

/** Removes an item's cache folders (all of them, or all but `keepForFile`). Best effort. */
export async function removeItemCache(dealId: string, itemId: string, keepForFile?: string | null, root: string = uploadsRoot()): Promise<number> {
  const deal = vdrDealCacheDir(dealId, root);
  if (!deal || !isSafeId(itemId)) return 0;
  const itemDir = confined(deal, itemId);
  if (!itemDir) return 0;
  let removed = 0;
  let names: string[] = [];
  try { names = await fs.promises.readdir(itemDir); } catch { return 0; }
  for (const n of names) {
    if (keepForFile && n === keepForFile) continue;
    const p = confined(itemDir, n);
    if (!p) continue;
    await fs.promises.rm(p, { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  if (!keepForFile) await fs.promises.rm(itemDir, { recursive: true, force: true }).catch(() => {});
  return removed;
}

/** Removes a stored cleaned copy file. Best effort. */
export async function removeCleanCopy(rel: string | null | undefined, dealId: string, root: string = uploadsRoot()): Promise<boolean> {
  const abs = resolveCleanCopy(rel, dealId, root);
  if (!abs) return false;
  try { await fs.promises.unlink(abs); return true; } catch { return false; }
}

/** The deal's two private folders (removed with the deal). */
export function vdrDealDirs(dealId: string, root: string = uploadsRoot()): string[] {
  return [vdrDealPrivateDir(dealId, root), vdrDealCacheDir(dealId, root)].filter((p): p is string => !!p);
}
