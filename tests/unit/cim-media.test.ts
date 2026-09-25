/**
 * Unit checks for CIM media — no database, no AI, no network.
 *   npx tsx tests/unit/cim-media.test.ts
 *
 * Covers video-link parsing, map regions, the deterministic blind rules for
 * photo/video/map sections (via buildBuyerCim, the view room's authority),
 * upload sniffing and metadata scrubbing.
 */
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { promises as fsp } from "fs";
import {
  buyerMediaLayoutData,
  dealAddressFragments,
  dealStreetAddress,
  mediaIdsIn,
  mediaTextSkeleton,
  normalizeGallery,
  normalizeLocationMap,
  normalizeVideo,
  parseVideoUrl,
  regionFromAddress,
  withoutMedia,
  type MediaAssetRef,
} from "../../shared/cim-media";
import { buildBuyerCim } from "../../shared/cim-buyer-view";
import { canAiRewriteLayout, canAiWriteLayout, getCimLayout } from "../../shared/cim-layouts";
import { detectMediaType, imageDimensions, neutralizeVideoMetadata, stripImageMetadata } from "../../server/cim/media-files";
import type { CimSection, CimSectionOverride } from "../../shared/schema";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

const IMG_SAFE = "11111111-1111-4111-8111-111111111111";
const IMG_PRIVATE = "22222222-2222-4222-8222-222222222222";
const VID_SAFE = "33333333-3333-4333-8333-333333333333";
const OTHER_DEAL = "44444444-4444-4444-8444-444444444444";
const assets: MediaAssetRef[] = [
  { id: IMG_SAFE, kind: "image", blindSafe: true },
  { id: IMG_PRIVATE, kind: "image", blindSafe: false },
  { id: VID_SAFE, kind: "video", blindSafe: true },
];
const ADDRESS = "1450 Lakeshore Rd E, Oakville, ON L6J 1L9";

async function main() {
  console.log("registry");
  await test("media layouts are registered in the Media category", () => {
    for (const k of ["image_gallery", "video", "location_map"]) {
      assert.equal(getCimLayout(k)?.category, "media", k);
      assert.equal(getCimLayout(k)?.editor, "media", k);
    }
    assert.ok(!canAiWriteLayout("image_gallery") && !canAiWriteLayout("video"));
    assert.ok(canAiWriteLayout("location_map") && !canAiRewriteLayout("location_map"));
    assert.ok(canAiWriteLayout("prose_highlight") && canAiRewriteLayout("bar_chart"));
  });

  console.log("video links");
  await test("YouTube links of every shape → nocookie embed", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "youtube.com/shorts/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ]) {
      const p = parseVideoUrl(url);
      assert.equal(p?.source, "youtube", url);
      assert.equal(p?.id, "dQw4w9WgXcQ");
      assert.ok(p!.embedUrl.startsWith("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"), url);
    }
    assert.ok(parseVideoUrl("https://youtu.be/dQw4w9WgXcQ?t=1m5s")!.embedUrl.includes("start=65"));
  });
  await test("Vimeo public, unlisted and player links → dnt embed", () => {
    assert.equal(parseVideoUrl("https://vimeo.com/76979871")?.embedUrl, "https://player.vimeo.com/video/76979871?dnt=1");
    assert.equal(parseVideoUrl("https://vimeo.com/76979871/abc123def0")?.embedUrl, "https://player.vimeo.com/video/76979871?dnt=1&h=abc123def0");
    assert.equal(parseVideoUrl("https://player.vimeo.com/video/76979871?h=abc123")?.id, "76979871");
  });
  await test("anything else is rejected", () => {
    for (const bad of ["https://evil.example/watch?v=dQw4w9WgXcQ", "javascript:alert(1)", "https://youtube.com/watch?v=short", "", "https://vimeo.com/about"]) {
      assert.equal(parseVideoUrl(bad), null, bad);
    }
  });

  console.log("map regions");
  await test("province/state from codes, names and postal codes", () => {
    assert.equal(regionFromAddress(ADDRESS), "Ontario, Canada");
    assert.equal(regionFromAddress("200 Main St, Austin, TX 78701"), "Texas, USA");
    assert.equal(regionFromAddress("12 Rue Sainte-Catherine, Montréal, Québec"), "Quebec, Canada");
    assert.equal(regionFromAddress("88 Pine Ave, Kelowna V1Y 2A1"), "British Columbia, Canada");
    assert.equal(regionFromAddress("5 High St, Bath, United Kingdom"), "United Kingdom");
  });
  await test("the street line never counts, and unknown → null", () => {
    assert.equal(regionFromAddress("12 Ontario Street"), null);
    assert.equal(regionFromAddress("12 Main St, Oakville"), null);
    assert.equal(regionFromAddress(""), null);
  });
  await test("deal address helpers", () => {
    assert.equal(dealStreetAddress({ address: ADDRESS }), ADDRESS);
    assert.equal(dealStreetAddress({ address: "Oakville" }), null);
    const frags = dealAddressFragments({ address: ADDRESS, city: "Oakville", _private: "x" });
    assert.ok(frags.includes("oakville") && frags.includes("1450lakeshorerde"));
  });

  console.log("normalisation");
  await test("gallery keeps valid uploads and https links only", () => {
    const g = normalizeGallery({
      style: "carousel",
      images: [{ mediaId: IMG_SAFE, caption: "  Front  desk " }, { url: "http://insecure.example/a.jpg" }, { url: "https://cdn.example/a.jpg" }, { mediaId: "../../etc/passwd" }, "junk"],
    });
    assert.equal(g.style, "carousel");
    assert.deepEqual(g.images, [{ mediaId: IMG_SAFE, caption: "Front desk" }, { url: "https://cdn.example/a.jpg" }]);
  });
  await test("video items are canonicalised; bad links dropped", () => {
    const v = normalizeVideo({ items: [{ url: "https://youtu.be/dQw4w9WgXcQ", blindSafe: true }, { url: "https://evil.example" }, { source: "upload", mediaId: VID_SAFE }] });
    assert.deepEqual(v.items, [
      { source: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", blindSafe: true },
      { source: "upload", mediaId: VID_SAFE },
    ]);
  });
  await test("mediaIdsIn / withoutMedia", () => {
    const data = { images: [{ mediaId: IMG_SAFE }, { mediaId: IMG_PRIVATE }] };
    assert.deepEqual(mediaIdsIn("image_gallery", data), [IMG_SAFE, IMG_PRIVATE]);
    assert.deepEqual(withoutMedia("image_gallery", data, IMG_SAFE), { images: [{ mediaId: IMG_PRIVATE }] });
    assert.equal(withoutMedia("image_gallery", data, OTHER_DEAL), null);
  });
  await test("the redactor sees only words — no ids, links or addresses", () => {
    const g = mediaTextSkeleton("image_gallery", { images: [{ mediaId: IMG_SAFE, caption: "Harbourline front" }] });
    assert.deepEqual(g, { images: [{ caption: "Harbourline front" }] });
    const m = mediaTextSkeleton("location_map", { locations: [{ label: "Main", address: ADDRESS, note: "Leased" }] });
    assert.ok(!JSON.stringify(m).includes("Lakeshore"));
  });

  console.log("buyer rules");
  const gallery = { style: "grid", images: [{ mediaId: IMG_SAFE, caption: "Harbourline Dental reception" }, { mediaId: IMG_PRIVATE, caption: "Sign" }, { url: "https://harbourline.example/x.jpg" }, { mediaId: OTHER_DEAL }] };
  await test("normal: every upload of this deal + web photos; other deals' ids dropped", () => {
    const d = buyerMediaLayoutData("image_gallery", gallery, null, "normal", { assets: new Map(assets.map((a) => [a.id, a])) }) as any;
    assert.deepEqual(d.images.map((i: any) => i.mediaId ?? i.url), [IMG_SAFE, IMG_PRIVATE, "https://harbourline.example/x.jpg"]);
  });
  await test("blind: only blind-safe uploads, words from the redacted copy", () => {
    const override = { images: [{ caption: "Reception area" }, { caption: "Sign" }, {}, {}] };
    const d = buyerMediaLayoutData("image_gallery", gallery, override, "blind", { assets: new Map(assets.map((a) => [a.id, a])), identifiers: ["Harbourline Dental"] }) as any;
    assert.deepEqual(d.images, [{ mediaId: IMG_SAFE, caption: "Reception area" }]);
    assert.ok(!JSON.stringify(d).includes("harbourline"));
  });
  await test("blind: a redacted caption that still names the business is dropped", () => {
    const d = buyerMediaLayoutData("image_gallery", gallery, { images: [{ caption: "The Harbourline Dental team" }] }, "blind", {
      assets: new Map(assets.map((a) => [a.id, a])),
      identifiers: ["Harbourline Dental"],
    }) as any;
    assert.deepEqual(d.images, [{ mediaId: IMG_SAFE }]);
  });
  await test("blind: no library known → no uploads; nothing left → section dropped", () => {
    assert.equal(buyerMediaLayoutData("image_gallery", gallery, {}, "blind", { assets: null }), null);
    assert.equal(buyerMediaLayoutData("image_gallery", { images: [{ mediaId: IMG_PRIVATE }] }, {}, "blind", { assets: new Map(assets.map((a) => [a.id, a])) }), null);
  });
  await test("blind video: safe uploads + links the broker marked safe", () => {
    const v = { items: [{ url: "https://youtu.be/dQw4w9WgXcQ" }, { url: "https://vimeo.com/76979871", blindSafe: true }, { source: "upload", mediaId: VID_SAFE }, { source: "upload", mediaId: IMG_SAFE }] };
    const d = buyerMediaLayoutData("video", v, { items: [{}, { title: "Tour" }, {}, {}] }, "blind", { assets: new Map(assets.map((a) => [a.id, a])) }) as any;
    assert.deepEqual(d.items, [
      { source: "vimeo", url: "https://vimeo.com/76979871", title: "Tour" },
      { source: "upload", mediaId: VID_SAFE },
    ]);
    assert.ok(!("blindSafe" in d.items[0]));
  });
  await test("blind map: region only, never the address or city", () => {
    const map = { zoom: 16, locations: [{ label: "Oakville clinic", address: ADDRESS, note: "Plaza unit" }, { label: "Satellite", address: "9 Queen St, Burlington, ON L7R 2E5" }] };
    const override = { locations: [{ label: "Oakville clinic", note: "Plaza unit" }, { label: "Satellite office" }] };
    const d = buyerMediaLayoutData("location_map", map, override, "blind", { assets: null, identifiers: [] }) as any;
    assert.equal(d.regionOnly, true);
    assert.equal(d.zoom, 5);
    assert.deepEqual(d.locations, [{ note: "Plaza unit", region: "Ontario, Canada" }], "one region, city-bearing label dropped");
    const s = JSON.stringify(d).toLowerCase();
    assert.ok(!s.includes("lakeshore") && !s.includes("oakville") && !s.includes("burlington"));
  });
  await test("blind map: hidden when the broker chose so, or no region", () => {
    assert.equal(buyerMediaLayoutData("location_map", { blindMap: "hide", locations: [{ address: ADDRESS }] }, {}, "blind", { assets: null }), null);
    assert.equal(buyerMediaLayoutData("location_map", { locations: [{ address: "12 Main St, Oakville" }] }, {}, "blind", { assets: null }), null);
  });

  // ── Through buildBuyerCim (the view room / chatbot authority) ──
  const deal = { id: "d1", businessName: "Harbourline Dental", blindCodename: "Project Kestrel", extractedInfo: { address: ADDRESS } };
  let n = 0;
  const section = (p: Partial<CimSection>): CimSection => ({
    id: `s${++n}`, dealId: "d1", sectionKey: `key_${n}`, sectionTitle: `Section ${n}`, order: n,
    layoutType: "prose_highlight", layoutData: {}, aiLayoutReasoning: null, tags: [], aiDraftContent: null,
    brokerEditedContent: null, sellerEditedContent: null, finalContent: null, brokerApproved: false, sellerApproved: false,
    isVisible: true, layoutOverride: null, charts: null, images: null, accessTier: "teaser", blindStaleAt: null,
    blindTitle: null, aiTask: null, contentHistory: null, createdAt: new Date(), updatedAt: new Date(), ...p,
  } as CimSection);
  const ov = (s: CimSection, layoutData: unknown, mode = "blind"): CimSectionOverride =>
    ({ id: `o${s.id}`, dealId: "d1", cimSectionId: s.id, mode, layoutData, contentOverride: "", createdAt: new Date() } as CimSectionOverride);

  const gal = section({ layoutType: "image_gallery", layoutData: gallery });
  const map = section({ layoutType: "location_map", layoutData: { locations: [{ label: "Clinic", address: ADDRESS }] } });
  const empty = section({ layoutType: "video", layoutData: { items: [{ url: "https://youtu.be/dQw4w9WgXcQ" }] } });

  await test("view room, LOI buyer: full media, exact address", () => {
    const out = buildBuyerCim({ deal, accessLevel: "loi", sections: [gal, map, empty], overrides: [], media: assets });
    assert.equal(out.sections.length, 3);
    assert.ok(JSON.stringify(out.sections[1].layoutData).includes("Lakeshore"));
  });
  await test("view room, teaser buyer: safe photo only, region map, unsafe video section gone", () => {
    const out = buildBuyerCim({
      deal, accessLevel: "teaser", sections: [gal, map, empty],
      overrides: [ov(gal, { images: [{ caption: "Reception" }, {}, {}, {}] }), ov(map, { locations: [{ label: "Clinic" }] }), ov(empty, { items: [{}] })],
      media: assets,
    });
    assert.deepEqual(out.sections.map((s) => s.layoutType), ["image_gallery", "location_map"]);
    const all = JSON.stringify(out.sections).toLowerCase();
    for (const leak of [IMG_PRIVATE, "lakeshore", "oakville", "l6j", "harbourline"]) assert.ok(!all.includes(leak.toLowerCase()), leak);
    assert.equal((out.sections[1].layoutData as any).locations[0].region, "Ontario, Canada");
  });
  await test("view room, teaser buyer without the media list: no uploads at all", () => {
    const out = buildBuyerCim({ deal, accessLevel: "full", sections: [gal], overrides: [ov(gal, { images: [{}] })] });
    assert.equal(out.sections.length, 0);
  });
  await test("DD buyer gets base media data (the enricher never touches refs)", () => {
    const out = buildBuyerCim({ deal, accessLevel: "due_diligence", sections: [gal], overrides: [ov(gal, { images: [{ mediaId: OTHER_DEAL }] }, "dd")], media: assets });
    assert.deepEqual(mediaIdsIn("image_gallery", out.sections[0].layoutData), [IMG_SAFE, IMG_PRIVATE]);
  });

  console.log("layout engine");
  await test("AI maps keep only addresses found in the deal's facts", async () => {
    const { groundLocationMap } = await import("../../server/cim/layout-engine");
    const facts = { extractedInfo: { leaseAddress: "Unit 4, 210 Fairway Road South, Kitchener, Ontario N2C 1X1" } };
    const out = groundLocationMap({
      locations: [
        { label: "Clinic", address: "210 Fairway Rd S, Kitchener, ON" },
        { label: "Made up", address: "55 King St W, Toronto, ON" },
        { label: "No number", address: "Fairway Road" },
      ],
    }, facts) as any;
    assert.deepEqual(out.locations.map((l: any) => l.label), ["Clinic"]);
  });

  console.log("upload sniffing & scrubbing");
  const png = pngWithText();
  const jpeg = jpegWithExif(6);
  await test("real type from the bytes; SVG/HTML/PDF/HEIC refused", () => {
    assert.equal(detectMediaType(png)?.mime, "image/png");
    assert.equal(detectMediaType(jpeg)?.mime, "image/jpeg");
    assert.equal(detectMediaType(Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00\x00", "latin1"))?.ext, "gif");
    assert.equal(detectMediaType(riff("WEBP"))?.mime, "image/webp");
    assert.equal(detectMediaType(ftyp("isom"))?.mime, "video/mp4");
    assert.equal(detectMediaType(ftyp("qt  "))?.mime, "video/quicktime");
    assert.equal(detectMediaType(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("....B\x82\x84webm........", "latin1")]))?.mime, "video/webm");
    for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), Buffer.from("<!doctype html><html>...."), Buffer.from("%PDF-1.7\n.........."), ftyp("heic")]) {
      assert.equal(detectMediaType(bad), null);
    }
  });
  await test("PNG text chunks removed, image kept", () => {
    const out = stripImageMetadata(png, "image/png");
    assert.ok(!out.includes(Buffer.from("GPS 43.44")));
    assert.ok(out.includes(Buffer.from("IDAT")) && out.includes(Buffer.from("IEND")));
    assert.deepEqual(imageDimensions(out, "image/png"), { width: 2, height: 3 });
  });
  await test("JPEG EXIF (GPS) removed; orientation kept; display size swapped", () => {
    const out = stripImageMetadata(jpeg, "image/jpeg");
    assert.ok(!out.includes(Buffer.from("SECRET-GPS")));
    assert.ok(out.includes(Buffer.from("Exif\0\0MM", "latin1")), "minimal orientation segment");
    assert.equal(out[out.length - 1], 0xd9);
    // Stored 20 wide × 40 high; orientation 6 rotates it a quarter turn.
    assert.deepEqual(imageDimensions(out, "image/jpeg"), { width: 40, height: 20 }, "display size follows orientation");
  });
  await test("MP4 user-data boxes neutralised in place", async () => {
    const file = path.join(os.tmpdir(), `cim-media-test-${process.pid}.mp4`);
    const udta = box("udta", box("©xyz", Buffer.from("+43.4-079.7/")));
    const moov = box("moov", Buffer.concat([box("mvhd", Buffer.alloc(20)), udta, box("trak", box("meta", Buffer.from("loc")))]));
    const buf = Buffer.concat([ftyp("isom"), moov, box("mdat", Buffer.alloc(16))]);
    await fsp.writeFile(file, buf);
    const n = await neutralizeVideoMetadata(file, "video/mp4");
    const out = await fsp.readFile(file);
    await fsp.unlink(file);
    assert.equal(n, 2);
    assert.equal(out.length, buf.length, "same size");
    assert.ok(!out.includes(Buffer.from("udta")) && !out.includes(Buffer.from("meta")));
  });

  console.log(`\n${passed} checks passed`);
}

// ── Tiny synthetic files ─────────────────────────────────────────────────
function crcTable() {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC = crcTable();
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  let c = 0xffffffff;
  for (const b of td) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function pngWithText() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(3, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from("Comment\0GPS 43.44,-79.68", "latin1")),
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function seg(marker: number, payload: Buffer) {
  const h = Buffer.from([0xff, marker, 0, 0]);
  h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}
function jpegWithExif(orientation: number) {
  const tiff = Buffer.alloc(26 + 12);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.write("SECRET-GPS", 26, "latin1");
  const sof = Buffer.from([8, 0, 40, 0, 20, 1, 1, 0x11, 0]); // 40 high × 20 wide
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff])),
    seg(0xfe, Buffer.from("taken at the clinic", "latin1")),
    seg(0xdb, Buffer.alloc(65)),
    seg(0xc0, sof),
    seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0xd9]),
  ]);
}
function riff(kind: string) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(22, 4);
  b.write(kind, 8, "latin1");
  b.write("VP8L", 12, "latin1");
  return b;
}
function box(type: string, payload: Buffer) {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(payload.length + 8, 0);
  h.write(type, 4, "latin1");
  return Buffer.concat([h, payload]);
}
function ftyp(brand: string) {
  return box("ftyp", Buffer.concat([Buffer.from(brand, "latin1"), Buffer.alloc(4), Buffer.from("isommp41", "latin1")]));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
