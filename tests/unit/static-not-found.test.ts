/**
 * A missing picture, script, stylesheet or font is a 404, never the app's HTML page
 * (server/static-not-found.ts, wired into both fallbacks in server/vite.ts).
 *
 * Before: GET /cimple-logo.png (the removed lockup) and GET /favicon.ico answered
 * "200 text/html" with index.html, so an outside link to the removed logo showed as a
 * silently broken image. App routes (/broker/deals, /view/:token, /deal/:id/…) must still
 * get index.html, so a reload on any page keeps working.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { isStaticAssetPath, missingStaticAssetNotFound } from "../../server/static-not-found";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── 1. The path rule ──────────────────────────────────────────────────────
for (const p of [
  "/cimple-logo.png", "/favicon.ico", "/FAVICON.ICO", "/assets/index-abc123.js", "/assets/index-abc123.css",
  "/assets/x.js.map", "/fonts/inter.woff2", "/fonts/inter.woff", "/img/a.jpeg", "/img/a.jpg", "/a.svg",
  "/a.webp", "/a.gif", "/a.avif", "/a.mjs", "/a.ttf", "/a.otf", "/uploads/logo_123.png",
]) {
  assert.ok(isStaticAssetPath(p), `${p} is a static-file path`);
}
for (const p of [
  "/", "/broker/deals", "/broker/buyers/1b2c", "/deal/9f1e2d3c-1111-2222-3333-444455556666/overview",
  "/view/AbC123xyz", "/view/AbC123xyz/data-room", "/seller/tok_abc/interview", "/buyer/login",
  "/broker/reset-password/abcdef", "/landing/v2", "/png", "/broker/deals?sort=name.png",
]) {
  assert.ok(!isStaticAssetPath(p.split("?")[0]), `${p} is an app route, not a file`);
}

// ── 2. Behaviour, on the same middleware chain as serveStatic ─────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "static-404-"));
fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>app</title>");
fs.copyFileSync(path.join(ROOT, "client/public/favicon.ico"), path.join(dir, "favicon.ico"));
fs.copyFileSync(path.join(ROOT, "client/public/favicon-32.png"), path.join(dir, "favicon-32.png"));

const app = express();
app.use(express.static(dir));
app.use(missingStaticAssetNotFound);
app.use("*", (_req, res) => res.sendFile(path.join(dir, "index.html")));
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

async function get(p: string, method = "GET") {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method });
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: method === "HEAD" ? "" : await res.text() };
}

try {
  for (const p of ["/cimple-logo.png", "/assets/index-oldhash.js", "/assets/index-oldhash.css", "/fonts/x.woff2", "/uploads/logo_gone.png"]) {
    const r = await get(p);
    assert.equal(r.status, 404, `${p}: missing file → 404 (was 200 + the app page)`);
    assert.match(r.type, /^text\/plain/, `${p}: plain text, not HTML`);
    assert.ok(!r.body.includes("<html") && !r.body.includes("<!doctype"), `${p}: never the app page`);
  }
  const head = await get("/missing.png", "HEAD");
  assert.equal(head.status, 404, "HEAD of a missing picture is a 404 too");

  // Files that exist are served as before.
  const ico = await get("/favicon.ico");
  assert.equal(ico.status, 200, "/favicon.ico is the tab icon now");
  assert.match(ico.type, /^image\/(x-icon|vnd\.microsoft\.icon)/);
  const png = await get("/favicon-32.png");
  assert.equal(png.status, 200);
  assert.match(png.type, /^image\/png/);

  // App routes still get the app page (a reload anywhere keeps working).
  for (const p of ["/", "/broker/deals", "/deal/9f1e2d3c-1111-2222-3333-444455556666/overview", "/view/AbC123xyz", "/seller/tok/interview", "/broker/deals?x=a.png"]) {
    const r = await get(p);
    assert.equal(r.status, 200, `${p}: app route → 200`);
    assert.match(r.type, /^text\/html/, `${p}: the app page`);
  }
  // Only GET/HEAD are answered here; anything else falls through unchanged.
  const post = await get("/thing.png", "POST");
  assert.notEqual(post.status, 404, "a POST is not answered by the static 404");
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 3. Both fallbacks in server/vite.ts use it, between the files and the app page ──
{
  const src = fs.readFileSync(path.join(ROOT, "server/vite.ts"), "utf8");
  const dev = src.slice(src.indexOf("export async function setupVite"), src.indexOf("export function serveStatic"));
  const prod = src.slice(src.indexOf("export function serveStatic"));
  const order = (block: string, first: string, name: string) => {
    const a = block.indexOf(first), b = block.indexOf("app.use(missingStaticAssetNotFound)"), c = block.indexOf('app.use("*"');
    assert.ok(a >= 0 && b > a && c > b, `${name}: files → missingStaticAssetNotFound → app page, in that order`);
  };
  order(dev, "app.use(vite.middlewares)", "setupVite (dev)");
  order(prod, "app.use(express.static(distPath))", "serveStatic (production)");
}

console.log("static-not-found: ok");
