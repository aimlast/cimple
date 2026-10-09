/**
 * Size caps for the data-room render processes (vdr spec §9.5), applied
 * BEFORE anything is decoded. Pure: no third-party imports, so both the web
 * process (render-pool) and the render child can use it, and unit tests can
 * call it directly.
 *
 *  - PDFs: at most 500 pages; page images 700 or 1,400 px wide; a page taller
 *    than 3 × its width is scaled down to fit; pdf.js `maxImageSize` 25 MP.
 *  - Photos: dimensions read from the file header (PNG IHDR, JPEG SOFn,
 *    WebP VP8/VP8L/VP8X); over 40 megapixels → too_large, never decoded.
 *  - Zip containers (xlsx, docx, pptx): the central directory is read first;
 *    over 300 MB uncompressed or 20,000 entries → too_large.
 */

export const VDR_RENDER_LIMITS = {
  /** A PDF with more pages than this is refused (`too_long`). */
  maxPages: 500,
  /** The only widths a page image is rendered at. */
  pageWidths: [700, 1400] as const,
  /** A page image is never taller than this many times its width. */
  maxHeightRatio: 3,
  /** pdf.js: embedded images over this many pixels are not decoded. */
  maxImageSize: 25_000_000,
  /** Photos over this many pixels are refused before decoding. */
  maxPhotoPixels: 40_000_000,
  /** Zip containers: uncompressed total and entry count. */
  maxZipUncompressedBytes: 300 * 1024 * 1024,
  maxZipEntries: 20_000,
  /** Files the child will read at all (the upload cap is 20 MB). */
  maxFileBytes: 25 * 1024 * 1024,
} as const;

/** Job timeouts in the web process (vdr spec §9.5). */
export const VDR_JOB_TIMEOUTS_MS = {
  prepare: 90_000,
  page: 20_000,
  composite: 5_000,
  download: 60_000,
  canary: 20_000,
  inspect: 5_000,
} as const;

export type PageWidth = (typeof VDR_RENDER_LIMITS.pageWidths)[number];

export function isPageWidth(w: unknown): w is PageWidth {
  return w === 700 || w === 1400;
}

/**
 * The canvas for one PDF page: `width` px wide at most, never taller than
 * `maxHeightRatio × width`. Returns null for a degenerate page size.
 */
export function fitPageCanvas(
  pageWidthPt: number,
  pageHeightPt: number,
  targetWidth: PageWidth,
): { scale: number; width: number; height: number; capped: boolean } | null {
  if (!(pageWidthPt > 0) || !(pageHeightPt > 0) || !Number.isFinite(pageWidthPt) || !Number.isFinite(pageHeightPt)) return null;
  const maxHeight = targetWidth * VDR_RENDER_LIMITS.maxHeightRatio;
  let scale = targetWidth / pageWidthPt;
  let capped = false;
  if (pageHeightPt * scale > maxHeight) {
    scale = maxHeight / pageHeightPt;
    capped = true;
  }
  const width = Math.max(1, Math.min(targetWidth, Math.floor(pageWidthPt * scale)));
  const height = Math.max(1, Math.min(maxHeight, Math.floor(pageHeightPt * scale)));
  return { scale, width, height, capped };
}

// ── Photo headers ──────────────────────────────────────────────────────────

export type ImageHeader = { type: "png" | "jpeg" | "webp"; width: number; height: number };

/** Reads a photo's pixel size from its header without decoding it. Null when the format isn't recognised. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const b = bytes;
  const u16be = (o: number) => (b[o] << 8) | b[o + 1];
  const u32be = (o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const u16le = (o: number) => b[o] | (b[o + 1] << 8);
  const u24le = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

  // PNG: signature, then the IHDR chunk (width, height big-endian).
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
    return { type: "png", width: u32be(16), height: u32be(20) };
  }
  // JPEG: walk the markers to the first start-of-frame (SOF0–SOF15 except DHT/JPG/DAC).
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) return null;
      const marker = b[o + 1];
      if (marker === 0xff) { o += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const len = u16be(o + 2);
      if (len < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { type: "jpeg", height: u16be(o + 5), width: u16be(o + 7) };
      if (marker === 0xda || marker === 0xd9) return null; // scan data before any frame header
      o += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X.
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === "VP8X") return { type: "webp", width: u24le(24) + 1, height: u24le(27) + 1 };
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { type: "webp", width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    }
    return null;
  }
  return null;
}

/** null when the photo may be decoded; otherwise the reason it may not. */
export function photoTooLarge(h: ImageHeader): "too_large" | null {
  if (!(h.width > 0) || !(h.height > 0)) return "too_large";
  return h.width * h.height > VDR_RENDER_LIMITS.maxPhotoPixels ? "too_large" : null;
}

// ── Zip containers ─────────────────────────────────────────────────────────

export type ZipTotals = { entries: number; uncompressedBytes: number };

/**
 * Sums a zip's central directory (entry count and uncompressed sizes) without
 * inflating anything. Null when the bytes are not a readable zip. Zip64
 * archives report their sizes in extra fields; their 0xFFFFFFFF markers are
 * counted as 4 GB each, so they always exceed the cap (fail closed).
 */
export function zipTotals(bytes: Uint8Array): ZipTotals | null {
  const b = bytes;
  const u16 = (o: number) => b[o] | (b[o + 1] << 8);
  const u32 = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  // End of central directory: last 22 bytes + up to 64 KB of comment.
  const min = Math.max(0, b.length - 22 - 0xffff);
  let eocd = -1;
  for (let o = b.length - 22; o >= min; o--) {
    if (b[o] === 0x50 && b[o + 1] === 0x4b && b[o + 2] === 0x05 && b[o + 3] === 0x06) { eocd = o; break; }
  }
  if (eocd < 0) return null;
  const total = u16(eocd + 10);
  const cdOffset = u32(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) return { entries: Infinity, uncompressedBytes: Infinity }; // zip64
  let o = cdOffset;
  let entries = 0;
  let uncompressed = 0;
  while (entries < total) {
    if (o + 46 > b.length || u32(o) !== 0x02014b50) return null;
    uncompressed += u32(o + 24);
    entries += 1;
    o += 46 + u16(o + 28) + u16(o + 30) + u16(o + 32);
  }
  return { entries, uncompressedBytes: uncompressed };
}

/** null when the zip may be opened; otherwise the reason it may not. */
export function zipTooLarge(t: ZipTotals): "too_large" | null {
  return t.entries > VDR_RENDER_LIMITS.maxZipEntries || t.uncompressedBytes > VDR_RENDER_LIMITS.maxZipUncompressedBytes
    ? "too_large"
    : null;
}
