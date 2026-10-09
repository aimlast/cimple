import type { Request, Response, NextFunction } from "express";

/**
 * A request for a static file that doesn't exist gets a plain 404, never the app's HTML page.
 *
 * The single-page app answers every unknown path with index.html (status 200), so its own
 * routes (/broker/deals, /view/:token …) work on a reload. For a picture, stylesheet, script or
 * font that answer is wrong: a removed logo linked from outside, a stale hashed bundle after a
 * redeploy, or a browser's automatic /favicon.ico lookup would receive a web page instead and
 * fail silently. This middleware runs just before that fallback (production `serveStatic` and
 * the dev server in server/vite.ts), so it only sees paths no file answered.
 *
 * App routes never end in one of these extensions (ids and tokens carry no dots), and
 * /api/* has its own JSON 404 earlier in the chain.
 */
export const STATIC_ASSET_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|woff2?|ttf|otf)$/i;

export function isStaticAssetPath(pathname: string): boolean {
  return STATIC_ASSET_EXT.test(pathname);
}

export function missingStaticAssetNotFound(req: Request, res: Response, next: NextFunction): void {
  if ((req.method === "GET" || req.method === "HEAD") && isStaticAssetPath(req.path)) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  next();
}
