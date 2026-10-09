/**
 * vdr Wave 0: size caps applied BEFORE anything is decoded, and the web
 * process's event loop stays free while the pool renders.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-limits.test.ts
 *
 *  - a PNG whose header says 30,000 × 30,000 → too_large without decoding (pure + through the child)
 *  - JPEG / WebP headers read without decoding
 *  - a zip (xlsx) whose central directory sums to > 300 MB → too_large (pure + through the child)
 *  - a tall PDF page → canvas height capped at 3 × width
 *  - while the pool renders 20 dense pages, this process's event-loop delay p99 < 20 ms
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import zlib from "node:zlib";
import PDFDocument from "pdfkit";
import {
  VDR_RENDER_LIMITS, fitPageCanvas, photoTooLarge, readImageHeader, zipTooLarge, zipTotals,
} from "../../server/vdr/child/limits";
import { createRenderPool, RenderJobError } from "../../server/vdr/render-pool";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-limits-"));

async function expectCode(p: Promise<unknown>, code: string, label: string) {
  try { await p; } catch (err) {
    assert.ok(err instanceof RenderJobError, `${label}: RenderJobError (got ${err})`);
    assert.equal((err as RenderJobError).code, code, `${label}: ${(err as Error).message}`);
    return;
  }
  assert.fail(`${label}: expected ${code}`);
}

// ── Photo headers ──────────────────────────────────────────────────────────
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A PNG that CLAIMS w × h but carries one tiny compressed row: decoding it would be the bomb. */
function pngClaiming(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.alloc(1 + 3 * 16))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
{
  const bomb = pngClaiming(30_000, 30_000);
  assert.deepEqual(readImageHeader(bomb), { type: "png", width: 30_000, height: 30_000 });
  assert.equal(photoTooLarge(readImageHeader(bomb)!), "too_large", "900 MP is over the 40 MP cap");
  assert.equal(photoTooLarge({ type: "png", width: 6000, height: 6000 }), null, "36 MP is fine");
  assert.equal(photoTooLarge({ type: "png", width: 8000, height: 6000 }), "too_large", "48 MP is not");
  assert.equal(photoTooLarge({ type: "png", width: 0, height: 10 }), "too_large", "a zero size is refused");
  // JPEG: SOF0 after an APP0 segment.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xb8, 0x0f, 0xa0, 0x03, ...Buffer.alloc(9)]);
  assert.deepEqual(readImageHeader(jpeg), { type: "jpeg", width: 4000, height: 3000 });
  // WebP: VP8X (extended) carries the canvas size minus one.
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0); webp.writeUInt32LE(22, 4); webp.write("WEBPVP8X", 8); webp.writeUInt32LE(10, 16);
  webp.writeUIntLE(9999, 24, 3); webp.writeUIntLE(4999, 27, 3);
  assert.deepEqual(readImageHeader(webp), { type: "webp", width: 10_000, height: 5_000 });
  assert.equal(readImageHeader(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null, "SVG is never a photo");
  assert.equal(readImageHeader(Buffer.alloc(0)), null);
}

// ── Zip central directory ──────────────────────────────────────────────────
/** A zip whose central directory claims these uncompressed sizes (no real data needed: nothing is inflated). */
function zipClaiming(sizes: number[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  sizes.forEach((size, i) => {
    const name = Buffer.from(`xl/worksheets/sheet${i + 1}.xml`);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(0, 20); cd.writeUInt32LE(size, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, name); central.push(cd, name);
    offset += local.length + name.length;
  });
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(sizes.length, 8); eocd.writeUInt16LE(sizes.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}
const bigZip = zipClaiming([200 * 1024 * 1024, 150 * 1024 * 1024]);
const okZip = zipClaiming([1024, 2048, 4096]);
{
  assert.deepEqual(zipTotals(bigZip), { entries: 2, uncompressedBytes: 350 * 1024 * 1024 });
  assert.equal(zipTooLarge(zipTotals(bigZip)!), "too_large", "350 MB uncompressed is over the 300 MB cap");
  assert.deepEqual(zipTotals(okZip), { entries: 3, uncompressedBytes: 7168 });
  assert.equal(zipTooLarge(zipTotals(okZip)!), null);
  assert.equal(zipTooLarge({ entries: VDR_RENDER_LIMITS.maxZipEntries + 1, uncompressedBytes: 10 }), "too_large", "too many entries");
  assert.equal(zipTotals(Buffer.from("not a zip")), null);
}

// ── Page canvas caps (pure) ────────────────────────────────────────────────
{
  assert.deepEqual(fitPageCanvas(612, 792, 1400), { scale: 1400 / 612, width: 1400, height: Math.floor(792 * 1400 / 612), capped: false });
  const tall = fitPageCanvas(612, 612 * 5, 1400)!;
  assert.equal(tall.capped, true);
  assert.equal(tall.height, 4200, "never taller than 3 × 1,400");
  assert.equal(tall.width, Math.floor(612 * (4200 / (612 * 5))), "scaled down to fit, not stretched");
  assert.equal(fitPageCanvas(0, 792, 700), null);
  assert.equal(fitPageCanvas(Number.NaN, 792, 700), null);
}

// ── Through the render child ───────────────────────────────────────────────
const pool = createRenderPool({ maxChildren: 2 });
{
  const bombFile = path.join(tmp, "bomb.png"); fs.writeFileSync(bombFile, pngClaiming(30_000, 30_000));
  const t = performance.now();
  await expectCode(pool.run({ kind: "photo", file: bombFile, width: 1400 }), "too_large", "30,000 × 30,000 PNG");
  assert.ok(performance.now() - t < 10_000, "refused from the header, not after decoding");
  const zipFile = path.join(tmp, "huge.xlsx"); fs.writeFileSync(zipFile, bigZip);
  await expectCode(pool.run({ kind: "zipCheck", file: zipFile }), "too_large", "350 MB xlsx");
  const okFile = path.join(tmp, "ok.xlsx"); fs.writeFileSync(okFile, okZip);
  assert.deepEqual(await pool.run({ kind: "zipCheck", file: okFile }), { entries: 3, uncompressedBytes: 7168 });

  const tallPdf = path.join(tmp, "tall.pdf");
  await new Promise<void>((res) => {
    const doc = new PDFDocument({ size: [612, 612 * 5] });
    const out = fs.createWriteStream(tallPdf); out.on("finish", () => res()); doc.pipe(out);
    doc.fontSize(14).text("A very tall page (a long receipt)", 72, 72);
    doc.end();
  });
  const page = await pool.run({ kind: "pdfPage", file: tallPdf, page: 1, width: 1400 });
  assert.equal(page.capped, true);
  assert.equal(page.height, 4200, "the tall page's canvas is capped at 3 × width");
  assert.ok(page.width < 1400);
}

// ── Event loop stays free while 20 dense pages render ─────────────────────
{
  const dense = path.join(tmp, "twenty.pdf");
  await new Promise<void>((res) => {
    const doc = new PDFDocument({ size: "LETTER" });
    const out = fs.createWriteStream(dense); out.on("finish", () => res()); doc.pipe(out);
    for (let p = 0; p < 20; p++) {
      if (p) doc.addPage();
      doc.fontSize(10);
      for (let l = 0; l < 50; l++) doc.text(`Line ${l} account 5${p}${l} Fuel and oil ${(l * 1234.56).toFixed(2)}  Vendor ${l}`, 50, 40 + l * 14);
    }
    doc.end();
  });
  // Warm both children first: a child's first job loads pdf.js (that's the child's time, not ours, but keep it out of the window).
  await Promise.all([pool.run({ kind: "canary" }), pool.run({ kind: "canary" })]);
  // The machine's own noise (a busy test run elsewhere): the same window with nothing rendering.
  const idle = monitorEventLoopDelay({ resolution: 5 });
  idle.enable();
  await new Promise((r) => setTimeout(r, 1500));
  idle.disable();
  const baseline = Math.max(0, idle.percentile(99) / 1e6 - 5);
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const t0 = performance.now();
  const pages = await Promise.all(Array.from({ length: 20 }, (_, i) => pool.run({ kind: "pdfPage", file: dense, page: i + 1, width: 1400 })));
  const ms = performance.now() - t0;
  h.disable();
  assert.equal(pages.length, 20);
  assert.ok(pages.every((p) => p.hasText && p.jpeg.length > 10_000), "20 dense pages rendered");
  // The histogram records the whole timer interval, so subtract the 5 ms tick to get the delay itself.
  const p99 = h.percentile(99) / 1e6 - 5;
  console.log(`20 pages in ${Math.round(ms)} ms; this process's event-loop delay: p99 ${p99.toFixed(1)} ms (idle ${baseline.toFixed(1)} ms), max ${(h.max / 1e6 - 5).toFixed(1)} ms`);
  // Rendering adds less than 20 ms to the web process's p99 (measured over the machine's own noise).
  assert.ok(p99 - baseline < 20, `web-process event-loop delay p99 ${p99.toFixed(1)} ms (idle ${baseline.toFixed(1)} ms) must stay within 20 ms of idle`);
}
await pool.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("vdr limits: ok");
