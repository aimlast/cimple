/**
 * vdr Wave 0: the render pool runs the REAL render child (render-child.ts
 * under tsx), never pdf.js in this process.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-render.test.ts
 *
 *  - the canary renders the built-in PDF: text out, ink in the box, JPEG, every library loads
 *  - the child's environment holds no secrets; its heap is capped
 *  - Node 20 simulation: getBuiltinModule (and other post-20 globals) deleted → the shim is installed and it still renders
 *  - a PDF page as a JPEG; hasText; a 501-page PDF → too_long; a password → password; junk → unreadable; a photo
 *  - a timeout kills the child (SIGKILL) and the next job gets a new one
 *  - a child that dies mid-job fails that job (unreadable); the next job succeeds
 *  - a missing child script → renderer_unavailable, with a plain reason
 *  - the web process never loads pdf.js / the canvas; the child never imports them statically
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import { createRenderPool, rendererStatus, RenderJobError, childEnv, childExecArgv } from "../../server/vdr/render-pool";
import { CANARY_TEXT, judgeCanary } from "../../server/vdr/canary-pdf";

const root = path.resolve(import.meta.dirname, "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-render-"));

// Secrets present in the web process must never reach the child.
process.env.SESSION_SECRET = "test-session-secret-value";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://unused/x";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "disabled";
process.env.RECALL_API_KEY = "test-recall-key";

function makePdf(file: string, build: (doc: PDFKit.PDFDocument) => void, opts: PDFKit.PDFDocumentOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", ...opts });
    const out = fs.createWriteStream(file);
    out.on("finish", () => resolve(file));
    out.on("error", reject);
    doc.pipe(out);
    build(doc);
    doc.end();
  });
}

async function expectCode(p: Promise<unknown>, code: string, label: string) {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof RenderJobError, `${label}: a RenderJobError (got ${err})`);
    assert.equal((err as RenderJobError).code, code, `${label}: code ${code} (got ${(err as RenderJobError).code}: ${(err as Error).message})`);
    return err as RenderJobError;
  }
  assert.fail(`${label}: expected ${code}, but the job succeeded`);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitGone(pid: number, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end && alive(pid)) await new Promise((r) => setTimeout(r, 25));
  return !alive(pid);
}

// ── Pure helpers ───────────────────────────────────────────────────────────
{
  const env = childEnv({ PATH: "/usr/bin", NODE_ENV: "production", DATABASE_URL: "postgres://secret", ANTHROPIC_API_KEY: "sk-x", SESSION_SECRET: "s", RESEND_API_KEY: "r", TZ: "UTC", LD_LIBRARY_PATH: "/nix/lib" });
  assert.deepEqual(Object.keys(env).sort(), ["LD_LIBRARY_PATH", "NODE_ENV", "PATH", "TZ", "VDR_CHILD"]);
  const argv = childExecArgv(["--require", "/x/preflight.cjs", "--import", "file:///x/tsx/loader.mjs", "--inspect=9229", "--max-old-space-size=4096"], "/app/server/vdr/render-child.ts", 384);
  assert.deepEqual(argv, ["--require", "/x/preflight.cjs", "--import", "file:///x/tsx/loader.mjs", "--max-old-space-size=384"], "debugger flags and the parent's heap size dropped; the cap added last");
  assert.deepEqual(childExecArgv([], "/app/dist/vdr/render-child.js", 384), ["--max-old-space-size=384"], "production: just the heap cap");
  assert.deepEqual(childExecArgv([], "/app/server/vdr/render-child.ts", 256), ["--import", "tsx", "--max-old-space-size=256"], "a .ts child always gets a TypeScript loader");
  // The judge refuses each kind of bad measurement.
  const good = { pages: 1, text: CANARY_TEXT, image: { width: 700, height: 466, bytes: 9000, magicOk: true }, ink: { box: 1, text: 0.15, outside: 0 }, modules: { "pdf-lib": "ok" } };
  assert.equal(judgeCanary(good), "ok");
  assert.match(judgeCanary({ ...good, pages: 2 }), /2 pages/);
  assert.match(judgeCanary({ ...good, text: "" }), /text didn't come out/);
  assert.match(judgeCanary({ ...good, ink: { box: 0.2, text: 0.15, outside: 0 } }), /black box/);
  assert.match(judgeCanary({ ...good, ink: { box: 1, text: 0, outside: 0 } }), /fonts missing/);
  assert.match(judgeCanary({ ...good, image: { ...good.image, magicOk: false } }), /JPEG/);
  assert.match(judgeCanary({ ...good, modules: { mammoth: "mammoth didn't load: x" } }), /mammoth didn't load/);
}

// ── The child never imports a third-party package statically (esbuild would hoist it above the shim) ──
{
  const files = [path.join(root, "server/vdr/render-child.ts"), ...fs.readdirSync(path.join(root, "server/vdr/child")).filter((f) => f.endsWith(".ts")).map((f) => path.join(root, "server/vdr/child", f))];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) {
      assert.ok(m[1].startsWith(".") || m[1].startsWith("node:"), `${path.relative(root, f)}: static import of "${m[1]}" (third-party packages must be imported dynamically)`);
    }
  }
  // The web-process side never imports pdf.js or the canvas at all.
  for (const f of ["server/vdr/render-pool.ts", "server/vdr/health.ts", "server/routes/data-room.ts", "server/vdr/render-jobs.ts", "server/vdr/canary-pdf.ts"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm)) {
      const spec = m[1] ?? m[2];
      assert.ok(!/pdfjs-dist|@napi-rs\/canvas|pdf-lib|mammoth|sanitize-html/.test(spec), `${f} must not import ${spec}`);
    }
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const threePages = await makePdf(path.join(tmp, "three.pdf"), (doc) => {
  doc.fontSize(20).text("T2 Corporation Income Tax Return 2023", 72, 72);
  doc.fontSize(12).text("Sales  $29,180,000\nTaxable income  $591,500", 72, 120);
  doc.addPage().fontSize(12).text("Shareholder: Test Person   60% of the shares", 72, 100);
  doc.addPage();
  doc.rect(100, 100, 200, 200).fill("#000000"); // page 3: a picture-like block, no text
});
const tooLong = await makePdf(path.join(tmp, "501.pdf"), (doc) => {
  doc.fontSize(8).text("p1", 50, 50);
  for (let i = 2; i <= 501; i++) doc.addPage().text(`p${i}`, 50, 50);
}, { size: [200, 200] });
const locked = await makePdf(path.join(tmp, "locked.pdf"), (doc) => { doc.text("secret", 72, 72); }, { userPassword: "letmein", ownerPassword: "owner", pdfVersion: "1.7" });
const junk = path.join(tmp, "junk.pdf");
fs.writeFileSync(junk, "this is not a pdf at all");
const { createCanvas } = await import("@napi-rs/canvas"); // the TEST draws its photo fixture; the pool never imports the canvas
const photoCanvas = createCanvas(1600, 900);
const pctx = photoCanvas.getContext("2d");
pctx.fillStyle = "#336699"; pctx.fillRect(0, 0, 1600, 900);
const photo = path.join(tmp, "photo.png");
fs.writeFileSync(photo, await photoCanvas.encode("png"));
const { loadImage } = await import("@napi-rs/canvas");

// ── 1. The canary, with secrets in this process's environment ────────────
const pool = createRenderPool({ maxChildren: 1 });
const status = await rendererStatus(pool);
assert.ok(status.ok, `renderer ok (got ${!status.ok ? status.reason : ""})`);
if (status.ok) {
  const d = status.detail;
  assert.equal(d.pages, 1);
  assert.equal(d.text, CANARY_TEXT);
  assert.equal(d.image.width, 700);
  assert.ok(d.ink.box > 0.95, "the black box is black in the page image");
  assert.ok(d.ink.text > 0.02, "the text is drawn (pdf.js found its standard fonts)");
  assert.equal(d.ink.outside, 0, "blank paper stays blank");
  assert.deepEqual(d.modules, { "pdf-lib": "ok", mammoth: "ok", "sanitize-html": "ok", xlsx: "ok" });
  assert.equal(d.pdfjs, "5.4.296");
  assert.equal(d.canvas, "0.1.80");
  assert.match(d.canvasBinary ?? "", /^@napi-rs\/canvas-[a-z0-9-]+@0\.1\.80$/);
  assert.equal(d.node, process.version);
  // No secrets: only allowlisted names (macOS adds __CF_USER_TEXT_ENCODING to every process).
  const keys = d.envKeys.filter((k) => !k.startsWith("__CF_"));
  for (const k of keys) assert.ok(["NODE_ENV", "PATH", "TMPDIR", "TZ", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "VDR_CHILD"].includes(k), `child env has ${k}`);
  for (const secret of ["SESSION_SECRET", "DATABASE_URL", "ANTHROPIC_API_KEY", "RECALL_API_KEY"]) assert.ok(!d.envKeys.includes(secret), `child env must not carry ${secret}`);
  // Heap capped at 384 MB old space (V8 adds the young generation on top; the default here would be several GB).
  assert.ok(d.heapLimitMb >= 384 && d.heapLimitMb <= 700, `child heap limit ${d.heapLimitMb} MB`);
  assert.equal(status.jpeg[0], 0xff); assert.equal(status.jpeg[1], 0xd8);
}
// The web process (this test) never loaded pdf.js: it sets these globals when it loads.
assert.equal((globalThis as any).pdfjsLib, undefined, "pdf.js never loaded in the web process");
assert.equal(typeof (globalThis as any).DOMMatrix, "undefined", "pdf.js's DOMMatrix polyfill never ran in the web process");

// ── 2. A PDF page; hasText; caps and plain failures ──────────────────────
{
  const p1 = await pool.run({ kind: "pdfPage", file: threePages, page: 1, width: 1400 });
  assert.equal(p1.pages, 3);
  assert.equal(p1.width, 1400);
  assert.equal(p1.height, Math.floor(792 * (1400 / 612)));
  assert.equal(p1.hasText, true);
  assert.equal(p1.capped, false);
  const img = await loadImage(Buffer.from(p1.jpeg));
  assert.equal(img.width, 1400, "decodes as a 1,400 px JPEG");
  const p3 = await pool.run({ kind: "pdfPage", file: threePages, page: 3, width: 700 });
  assert.equal(p3.hasText, false, "a page with no text says so (the Scanned flag later)");
  const c = createCanvas(p3.width, p3.height); const cx = c.getContext("2d");
  cx.drawImage(await loadImage(Buffer.from(p3.jpeg)), 0, 0);
  const px = cx.getImageData(Math.round(200 * 700 / 612), Math.round(200 * 700 / 612), 1, 1).data;
  assert.ok(px[0] < 40 && px[1] < 40 && px[2] < 40, "the drawn block is dark in the page image");
  await expectCode(pool.run({ kind: "pdfPage", file: threePages, page: 4, width: 700 }), "unreadable", "no page 4");
  await expectCode(pool.run({ kind: "pdfPage", file: tooLong, page: 1, width: 700 }), "too_long", "501 pages");
  await expectCode(pool.run({ kind: "pdfPage", file: locked, page: 1, width: 700 }), "password", "password PDF");
  await expectCode(pool.run({ kind: "pdfPage", file: junk, page: 1, width: 700 }), "unreadable", "not a PDF");
  await expectCode(pool.run({ kind: "pdfPage", file: path.join(tmp, "nope.pdf"), page: 1, width: 700 }), "file_missing", "missing file");
  await expectCode(pool.run({ kind: "pdfPage", file: "relative/path.pdf", page: 1, width: 700 }), "file_missing", "relative path refused");
  await expectCode(pool.run({ kind: "pdfPage", file: threePages, page: 1, width: 999 as any }), "unreadable", "width must be 700 or 1400");
  const ph = await pool.run({ kind: "photo", file: photo, width: 700 });
  assert.deepEqual(ph.source, { type: "png", width: 1600, height: 900 });
  assert.equal(ph.width, 700); assert.equal(ph.height, Math.round(900 * 700 / 1600));
  assert.equal(ph.jpeg[0], 0xff);
}

// ── 3. Timeout: the child is killed (SIGKILL) and replaced ───────────────
{
  const before = pool.stats().children.map((c) => c.pid!);
  assert.equal(before.length, 1);
  const err = await expectCode(pool.run({ kind: "canary" }, { timeoutMs: 1 }), "timeout", "1 ms timeout");
  assert.match(err!.message, /no answer within 1 ms/);
  assert.equal(pool.stats().children.length, 0, "the timed-out child is gone from the pool at once");
  assert.ok(await waitGone(before[0]), "the timed-out child process was killed");
  const again = await rendererStatus(pool);
  assert.ok(again.ok, "the next job runs on a new child");
  const after = pool.stats().children.map((c) => c.pid!);
  assert.equal(after.length, 1);
  assert.notEqual(after[0], before[0], "a new process");
}

// ── 4. A child that dies mid-job fails that job; the next job succeeds ───
{
  const job = pool.run({ kind: "pdfPage", file: threePages, page: 1, width: 1400 });
  const busy = pool.stats().children.find((c) => c.busy);
  assert.ok(busy?.pid && busy.ready, "the warm child took the job");
  process.kill(busy!.pid!, "SIGKILL");
  await expectCode(job, "unreadable", "child killed mid-job");
  const next = await pool.run({ kind: "pdfPage", file: threePages, page: 2, width: 700 });
  assert.equal(next.page, 2, "the next job succeeds on a new child");
  assert.notEqual(pool.stats().children[0].pid, busy!.pid);
}
await pool.close();
assert.equal(pool.stats().children.length, 0);
await expectCode(pool.run({ kind: "canary" }), "renderer_unavailable", "a closed pool refuses work");

// ── 5. Node 20 simulation: no getBuiltinModule (nor other post-20 globals) → the shim, and it still renders ──
{
  const node20 = [
    "delete process.getBuiltinModule",
    "delete Promise.withResolvers", "delete URL.parse", "delete Array.fromAsync",
    "delete Object.groupBy", "delete Map.groupBy", "delete globalThis.Iterator", "delete globalThis.Float16Array",
    ...["union", "intersection", "difference", "symmetricDifference", "isSubsetOf", "isSupersetOf", "isDisjointFrom"].map((k) => `delete Set.prototype.${k}`),
  ].join(";");
  const old = createRenderPool({ maxChildren: 1, extraExecArgv: ["--import", `data:text/javascript,${encodeURIComponent(node20)}`] });
  const s = await rendererStatus(old);
  assert.ok(s.ok, `renders without getBuiltinModule (got ${!s.ok ? s.reason : ""})`);
  if (s.ok) assert.equal(s.detail.shimInstalled, true, "the shim was installed");
  const pg = await old.run({ kind: "pdfPage", file: threePages, page: 1, width: 700 });
  assert.equal(pg.hasText, true, "text extraction works with the shim");
  await old.close();
}

// ── 6. A missing child script: renderer_unavailable with a plain reason ──
{
  const none = createRenderPool({ childPath: path.join(tmp, "missing-child.js") });
  const s = await rendererStatus(none);
  assert.equal(s.ok, false);
  if (!s.ok) {
    assert.equal(s.code, "renderer_unavailable");
    assert.match(s.reason, /render process isn't installed/);
  }
  await none.close();
  // A child that crashes while starting (before it's ready) → renderer_unavailable, not "unreadable".
  const crashing = path.join(tmp, "crash-child.mjs");
  fs.writeFileSync(crashing, "process.exit(3);\n");
  const bad = createRenderPool({ childPath: crashing });
  const s2 = await rendererStatus(bad);
  assert.equal(s2.ok, false);
  if (!s2.ok) {
    assert.equal(s2.code, "renderer_unavailable");
    assert.match(s2.reason, /didn't start \(exit code 3\)/);
  }
  await bad.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("vdr render: ok");
