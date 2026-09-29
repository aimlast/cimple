/**
 * The one gate in front of everything under /uploads.
 *
 * The old documents check was mounted as app.use("/uploads/docs", …), and
 * Express matches a mount against the RAW path, while the static server
 * behind it decodes and normalises the path itself. So "/uploads//docs/x",
 * "/uploads/%64ocs/x", "/uploads/docs%2Fx" and "/uploads/./docs/x" skipped
 * the check and were served straight from <UPLOADS_DIR>/docs — confidential
 * tax returns, statements and broker-only CRM notes, to anyone, no login.
 *
 * Now every /uploads request is classified on the path the static server
 * would actually resolve (decoded, "\" → "/", posix-normalised, lower-cased
 * for the folder test — a case-insensitive disk serves DOCS/ as docs/):
 *   - documents (docs/…)           → the access check, then served here by
 *                                   the shared resolver (document-path.ts);
 *                                   never handed to the static server;
 *   - private folders              → 404 (CIM media is served only through
 *                                   GET /api/media/:id; past-CIM uploads are
 *                                   transient);
 *   - anything else (brand logos)  → the public static server.
 */
import type { Express, Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import { DOCS_URL_PREFIX, resolveDocumentPath } from "../documents/document-path";

/** Folders under /uploads that are never served statically. */
const PRIVATE_FOLDERS = ["private-media", "tmp-past-cim"];

export type UploadsPath =
  | { kind: "document"; name: string }
  | { kind: "blocked" }
  | { kind: "public" };

/** How the static server would see this path, and what may happen to it. */
export function classifyUploadsPath(rawPath: string): UploadsPath {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { kind: "blocked" };
  }
  if (decoded.includes("\0")) return { kind: "blocked" };
  // Every name Cimple writes under /uploads is printable ASCII. Anything else
  // is refused outright: a case-insensitive disk folds more than
  // toLowerCase() does (macOS APFS folds "ſ" U+017F to "s", so "docſ" would
  // open docs/), and no real file needs it.
  if (/[^\x20-\x7e]/.test(decoded)) return { kind: "blocked" };
  const norm = path.posix.normalize("/" + decoded.replace(/\\/g, "/"));
  const lower = norm.toLowerCase();
  // "/docs" itself, "/docs/…", and anything whose first segment is "docs"
  // however it was spelled.
  const first = lower.split("/").filter(Boolean)[0] ?? "";
  if (first === "docs") {
    const rest = norm.split("/").filter(Boolean).slice(1);
    // Documents are flat files: exactly one segment after docs/.
    if (rest.length !== 1) return { kind: "blocked" };
    return { kind: "document", name: rest[0] };
  }
  if (PRIVATE_FOLDERS.includes(first)) return { kind: "blocked" };
  return { kind: "public" };
}

export interface UploadsGateDeps {
  /** Every row pointing at the file (a copied document may share one). */
  getDocumentsByFileUrl(fileUrl: string): Promise<Array<{ id: string; dealId: string; fileUrl?: string | null; visibility?: string | null }>>;
  getDeal(dealId: string): Promise<{ id: string; brokerId?: string | null } | undefined>;
  getSellerInviteByToken(token: string): Promise<{ dealId: string } | undefined>;
}

/**
 * Who may open a stored document: the broker session that owns the deal,
 * or (for anything not broker-only) the holder of that deal's seller token.
 * A document whose deal no longer exists is never served.
 */
export async function mayOpenDocument(
  deps: UploadsGateDeps,
  doc: { dealId: string; visibility?: string | null },
  who: { brokerId?: string | null; sellerToken?: string | null },
): Promise<boolean> {
  const deal = await deps.getDeal(doc.dealId);
  if (!deal) return false;
  if (who.brokerId && deal.brokerId === who.brokerId) return true;
  // Broker-only sources (CRM notes, private emails) are never served to
  // the seller, whatever token they hold.
  if (doc.visibility === "broker_only") return false;
  if (who.sellerToken) {
    const invite = await deps.getSellerInviteByToken(who.sellerToken);
    if (invite && invite.dealId === doc.dealId) return true;
  }
  return false;
}

export function registerUploadsGate(app: Express, uploadsDir: string, deps: UploadsGateDeps, serveStatic: (root: string) => any): void {
  app.use("/uploads", async (req: Request, res: Response, next: NextFunction) => {
    const route = classifyUploadsPath(req.path);
    if (route.kind === "public") return next();
    if (route.kind === "blocked") return res.status(404).json({ error: "Not found" });
    try {
      const fileUrl = `${DOCS_URL_PREFIX}${route.name}`;
      const rows = await deps.getDocumentsByFileUrl(fileUrl);
      if (rows.length === 0) return res.status(404).json({ error: "Not found" });
      const token = (typeof req.query.token === "string" ? req.query.token : undefined)
        || (req.headers["x-seller-token"] as string | undefined);
      const who = { brokerId: req.session?.brokerId, sellerToken: token };
      let ok = false;
      for (const doc of rows) {
        if (await mayOpenDocument(deps, doc, who)) { ok = true; break; }
      }
      if (!ok) return res.status(401).json({ error: "Not authorized" });
      const abs = resolveDocumentPath({ fileUrl }, uploadsDir);
      if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: "Not found" });
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.sendFile(abs, { dotfiles: "deny" }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "Not found" });
      });
    } catch (err) {
      console.error("Document access check failed:", err);
      return res.status(500).json({ error: "Access check failed" });
    }
  });

  app.use("/uploads", serveStatic(uploadsDir));
}
