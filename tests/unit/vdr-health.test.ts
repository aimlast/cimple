/**
 * vdr Wave 0: GET /api/vdr/health — the real route on an Express app (no
 * database: the session is faked), rendering the built-in PDF in a real
 * render process.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-health.test.ts
 *
 *  - no broker session → 401, and nothing is rendered
 *  - a broker → 200 { renderer: "ok", node, pdfjs, canvas, disk: { cacheMb }, child }
 *  - the result is kept for 30 s (a second call doesn't render again)
 *  - the page-image cache size is measured from UPLOADS_DIR/private-vdr-cache
 *  - a failing renderer → the plain reason, never a stack trace
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const uploads = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-health-"));
process.env.UPLOADS_DIR = uploads;
process.env.SESSION_SECRET = "test-session-secret-value";
// 1.5 MB of cached page images in two folders.
fs.mkdirSync(path.join(uploads, "private-vdr-cache", "deal-1", "item-1", "abc"), { recursive: true });
fs.writeFileSync(path.join(uploads, "private-vdr-cache", "deal-1", "item-1", "abc", "p1.webp"), Buffer.alloc(1024 * 1024));
fs.mkdirSync(path.join(uploads, "private-vdr-cache", "deal-2"), { recursive: true });
fs.writeFileSync(path.join(uploads, "private-vdr-cache", "deal-2", "p2.webp"), Buffer.alloc(512 * 1024));

const express = (await import("express")).default;
const { registerDataRoomRoutes } = await import("../../server/routes/data-room");
const { renderPool, createRenderPool } = await import("../../server/vdr/render-pool");
const { cacheSizeMb, healthFromStatus, _resetVdrHealthCache, vdrHealth } = await import("../../server/vdr/health");

const app = express();
app.use((req, _res, next) => {
  (req as any).session = req.headers["x-test-broker"] ? { brokerId: String(req.headers["x-test-broker"]) } : {};
  next();
});
registerDataRoomRoutes(app);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// 1. Signed out: 401 and no render process started.
{
  const r = await fetch(`${base}/api/vdr/health`);
  assert.equal(r.status, 401);
  assert.equal(renderPool.stats().children.length, 0, "nothing rendered for a signed-out caller");
}

// 2. A broker: the canary renders.
let first: any;
{
  const r = await fetch(`${base}/api/vdr/health`, { headers: { "x-test-broker": "b1" } });
  first = await r.json();
  assert.equal(r.status, 200, JSON.stringify(first));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(first.renderer, "ok");
  assert.equal(first.node, process.version);
  assert.equal(first.pdfjs, "5.4.296");
  assert.equal(first.canvas, "0.1.80");
  assert.equal(first.disk.cacheMb, 1.5);
  assert.ok(!Number.isNaN(Date.parse(first.checkedAt)));
  assert.equal(first.child.node, process.version);
  assert.equal(typeof first.child.shimInstalled, "boolean");
  assert.deepEqual(first.child.modules, { "pdf-lib": "ok", mammoth: "ok", "sanitize-html": "ok", xlsx: "ok" });
  assert.deepEqual([first.child.image.width, first.child.image.height], [700, 466]);
  assert.ok(first.child.ink.box > 0.95);
  assert.ok(!first.child.envKeys.includes("SESSION_SECRET") && !first.child.envKeys.includes("DATABASE_URL") && !first.child.envKeys.includes("ANTHROPIC_API_KEY"));
  assert.ok(!("jpeg" in first.child), "no image bytes in the JSON");
}

// 3. Kept for 30 s: the same answer, no new render.
{
  const r = await fetch(`${base}/api/vdr/health`, { headers: { "x-test-broker": "b1" } });
  const again = await r.json();
  assert.equal(again.checkedAt, first.checkedAt, "the kept result");
  // Concurrent callers share one render after the cache is cleared.
  _resetVdrHealthCache();
  const [a, b] = await Promise.all([vdrHealth(), vdrHealth()]);
  assert.equal(a, b, "one render shared by both callers");
}

// 4. The cache size helper; a missing folder is 0.
assert.equal(await cacheSizeMb(path.join(uploads, "nowhere")), 0);
assert.equal(await cacheSizeMb(), 1.5);

// 5. A failing renderer: plain reason, installed versions still reported, 503 from the route shape.
{
  const broken = createRenderPool({ childPath: path.join(uploads, "missing-child.js") });
  _resetVdrHealthCache();
  const h = await vdrHealth(broken);
  assert.match(h.renderer, /^renderer_unavailable: the render process isn't installed/);
  assert.equal(h.pdfjs, "5.4.296", "installed version read from package.json without loading pdf.js");
  assert.equal(h.canvas, "0.1.80");
  assert.equal(h.child, undefined);
  assert.doesNotMatch(JSON.stringify(h), /\n\s+at /, "no stack traces");
  await broken.close();
  const shaped = healthFromStatus({ ok: false, reason: "timeout: no answer within 20000 ms", code: "timeout" }, 0, new Date("2026-10-09T00:00:00Z"));
  assert.deepEqual(Object.keys(shaped).sort(), ["canvas", "checkedAt", "disk", "node", "pdfjs", "renderer"]);
  _resetVdrHealthCache();
}

server.close();
await renderPool.close();
fs.rmSync(uploads, { recursive: true, force: true });
console.log("vdr health: ok");
