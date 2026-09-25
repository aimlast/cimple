/**
 * media-files — what an uploaded CIM photo/video really is, and scrubbing
 * the hidden data that could identify the business.
 *
 *   detectMediaType()     content sniffing from the file's first bytes —
 *                         the extension and browser-declared type are never
 *                         trusted. JPEG/PNG/WebP/GIF and MP4/MOV/WebM only
 *                         (no SVG: it is a script-capable document).
 *   stripImageMetadata()  removes EXIF/XMP/IPTC/comments (GPS position,
 *                         camera owner, captions) from JPEG, PNG and WebP.
 *                         A JPEG's orientation is kept so phone photos don't
 *                         turn sideways.
 *   imageDimensions()     display width/height.
 *   neutralizeVideoMetadata()  MP4/MOV: renames every `udta`/`meta` box
 *                         (where phones store the recording location) to
 *                         `free` in place — same sizes, so nothing else in
 *                         the file moves and players skip them.
 *
 * Pure except neutralizeVideoMetadata (reads/writes the file).
 */
import { promises as fsp } from "fs";

export type DetectedMedia =
  | { kind: "image"; mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; ext: "jpg" | "png" | "webp" | "gif" }
  | { kind: "video"; mime: "video/mp4" | "video/quicktime" | "video/webm"; ext: "mp4" | "mov" | "webm" };

const MP4_BRANDS = new Set([
  "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4VP", "mmp4", "dash",
  "3gp4", "3gp5", "3gp6", "MSNV", "f4v ",
]);
const NOT_VIDEO_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis", "M4A ", "M4B ", "M4P ", "crx "]);
const QT_TOP_BOXES =new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

/** Sniff the real type from the first bytes (≥ 64 recommended). */
export function detectMediaType(head: Buffer): DetectedMedia | null {
  if (head.length < 12) return null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: "image", mime: "image/png", ext: "png" };
  }
  const a6 = head.toString("latin1", 0, 6);
  if (a6 === "GIF87a" || a6 === "GIF89a") return { kind: "image", mime: "image/gif", ext: "gif" };
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
    return { kind: "image", mime: "image/webp", ext: "webp" };
  }
  const box = head.toString("latin1", 4, 8);
  if (box === "ftyp") {
    const brand = head.toString("latin1", 8, 12);
    if (brand === "qt  ") return { kind: "video", mime: "video/quicktime", ext: "mov" };
    if (MP4_BRANDS.has(brand)) return { kind: "video", mime: "video/mp4", ext: "mp4" };
    // HEIC/AVIF stills and audio-only files share the container — refuse.
    if (NOT_VIDEO_BRANDS.has(brand)) return null;
    // Compatible brands (e.g. a camera's own major brand listing isom).
    const size = head.readUInt32BE(0);
    const end = Math.min(size, head.length);
    for (let o = 16; o + 4 <= end; o += 4) {
      const b = head.toString("latin1", o, o + 4);
      if (b === "qt  ") return { kind: "video", mime: "video/quicktime", ext: "mov" };
      if (MP4_BRANDS.has(b)) return { kind: "video", mime: "video/mp4", ext: "mp4" };
    }
    return null; // HEIC/AVIF/audio-only and friends
  }
  if (QT_TOP_BOXES.has(box) && head.readUInt32BE(0) >= 8) return { kind: "video", mime: "video/quicktime", ext: "mov" };
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    // EBML: only the WebM doctype (not arbitrary Matroska).
    if (head.toString("latin1").includes("webm")) return { kind: "video", mime: "video/webm", ext: "webm" };
  }
  return null;
}

// ── Images ───────────────────────────────────────────────────────────────

export function stripImageMetadata(buf: Buffer, mime: string): Buffer {
  try {
    if (mime === "image/jpeg") return stripJpeg(buf);
    if (mime === "image/png") return stripPng(buf);
    if (mime === "image/webp") return stripWebp(buf);
  } catch (err) {
    // A file we can't walk is rejected by the caller (it may be malformed on purpose).
    throw new Error(`Couldn't read this image: ${(err as Error).message}`);
  }
  return buf; // GIF: no location metadata
}

/** JPEG segments kept: JFIF (APP0), ICC colour profile (APP2), Adobe (APP14) and the image itself. */
function stripJpeg(buf: Buffer): Buffer {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("not a JPEG");
  const out: Buffer[] = [buf.subarray(0, 2)];
  let orientation = 0;
  let o = 2;
  let wroteOrientation = false;
  while (o < buf.length) {
    if (buf[o] !== 0xff) throw new Error("bad JPEG marker");
    // Fill bytes.
    while (buf[o + 1] === 0xff) o++;
    const marker = buf[o + 1];
    if (marker === 0xd9) { out.push(buf.subarray(o, o + 2)); break; }
    // Standalone markers (RSTn, TEM) carry no length.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(buf.subarray(o, o + 2)); o += 2; continue; }
    if (o + 4 > buf.length) throw new Error("truncated JPEG");
    const len = buf.readUInt16BE(o + 2);
    const segEnd = o + 2 + len;
    if (len < 2 || segEnd > buf.length) throw new Error("truncated JPEG segment");
    const seg = buf.subarray(o, segEnd);
    if (marker === 0xe1) {
      const o2 = readExifOrientation(buf.subarray(o + 4, segEnd));
      if (o2) orientation = o2;
    } else if (marker === 0xda) {
      // Start of scan: the rest of the file is image data.
      if (orientation > 1 && !wroteOrientation) { out.push(orientationApp1(orientation)); wroteOrientation = true; }
      out.push(buf.subarray(o));
      return Buffer.concat(out);
    } else if (marker === 0xe0 || marker === 0xe2 || marker === 0xee || !(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) {
      // Keep JFIF, ICC, Adobe and every non-APP, non-comment segment
      // (quantisation/huffman tables, frame header, restart interval…).
      if (orientation > 1 && !wroteOrientation && !(marker >= 0xe0 && marker <= 0xef)) {
        out.push(orientationApp1(orientation));
        wroteOrientation = true;
      }
      out.push(seg);
    }
    o = segEnd;
  }
  return Buffer.concat(out);
}

/** Orientation (1–8) from an APP1 Exif payload, or 0. */
function readExifOrientation(p: Buffer): number {
  if (p.length < 14 || p.toString("latin1", 0, 6) !== "Exif\0\0") return 0;
  const t = p.subarray(6);
  const le = t.toString("latin1", 0, 2) === "II";
  const u16 = (i: number) => (le ? t.readUInt16LE(i) : t.readUInt16BE(i));
  const u32 = (i: number) => (le ? t.readUInt32LE(i) : t.readUInt32BE(i));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return 0;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}

/** A minimal APP1 Exif segment holding only the orientation tag. */
function orientationApp1(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 offset
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22); // no next IFD
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.alloc(4);
  head[0] = 0xff; head[1] = 0xe1;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

function stripPng(buf: Buffer): Buffer {
  const out: Buffer[] = [buf.subarray(0, 8)];
  let o = 8;
  while (o + 12 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("latin1", o + 4, o + 8);
    const end = o + 12 + len;
    if (end > buf.length) throw new Error("truncated PNG chunk");
    if (!PNG_DROP.has(type)) out.push(buf.subarray(o, end));
    o = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(out);
}

function stripWebp(buf: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let o = 12;
  let vp8x: Buffer | null = null;
  while (o + 8 <= buf.length) {
    const type = buf.toString("latin1", o, o + 4);
    const len = buf.readUInt32LE(o + 4);
    const end = o + 8 + len + (len % 2);
    if (o + 8 + len > buf.length) throw new Error("truncated WebP chunk");
    const chunk = Buffer.from(buf.subarray(o, Math.min(end, buf.length)));
    if (type === "VP8X") vp8x = chunk;
    if (type !== "EXIF" && type !== "XMP ") chunks.push(chunk);
    o = end;
  }
  if (vp8x && vp8x.length >= 9) vp8x[8] &= ~(0x08 | 0x04); // clear EXIF + XMP flags
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}

/** Display width/height, or null when the header can't be read. */
export function imageDimensions(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === "image/png") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === "image/gif") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === "image/webp") return webpDims(buf);
    if (mime === "image/jpeg") return jpegDims(buf);
  } catch {
    /* fall through */
  }
  return null;
}

function jpegDims(buf: Buffer): { width: number; height: number } | null {
  let o = 2;
  let orientation = 0;
  while (o + 9 < buf.length) {
    if (buf[o] !== 0xff) return null;
    const marker = buf[o + 1];
    if (marker === 0xff) { o++; continue; }
    const len = buf.readUInt16BE(o + 2);
    if (marker === 0xe1) orientation = readExifOrientation(buf.subarray(o + 4, o + 2 + len)) || orientation;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const h = buf.readUInt16BE(o + 5);
      const w = buf.readUInt16BE(o + 7);
      return orientation >= 5 ? { width: h, height: w } : { width: w, height: h };
    }
    if (marker === 0xda) return null;
    o += 2 + len;
  }
  return null;
}

function webpDims(buf: Buffer): { width: number; height: number } | null {
  const type = buf.toString("latin1", 12, 16);
  const d = 20;
  if (type === "VP8X") return { width: 1 + buf.readUIntLE(d + 4, 3), height: 1 + buf.readUIntLE(d + 7, 3) };
  if (type === "VP8 ") return { width: buf.readUInt16LE(d + 6) & 0x3fff, height: buf.readUInt16LE(d + 8) & 0x3fff };
  if (type === "VP8L") {
    const b = buf.readUInt32LE(d + 1);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  return null;
}

// ── Video ────────────────────────────────────────────────────────────────

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);
const SCRUB = new Set(["udta", "meta"]);
const MAX_MOOV = 64 * 1024 * 1024;

/**
 * MP4/MOV: rename every user-data/metadata box to `free` (in place).
 * Returns how many boxes were neutralised. WebM is left as is.
 */
export async function neutralizeVideoMetadata(filePath: string, mime: string): Promise<number> {
  if (mime !== "video/mp4" && mime !== "video/quicktime") return 0;
  const fh = await fsp.open(filePath, "r+");
  try {
    const { size: fileSize } = await fh.stat();
    let count = 0;
    let o = 0;
    const head = Buffer.alloc(16);
    while (o + 8 <= fileSize) {
      await fh.read(head, 0, 16, o);
      let size = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      let headerLen = 8;
      if (size === 1) {
        size = Number(head.readBigUInt64BE(8));
        headerLen = 16;
      } else if (size === 0) {
        size = fileSize - o;
      }
      if (size < headerLen || o + size > fileSize) break;
      if (SCRUB.has(type)) {
        await fh.write(Buffer.from("free", "latin1"), 0, 4, o + 4);
        count++;
      } else if (type === "moov" && size <= MAX_MOOV) {
        const moov = Buffer.alloc(size);
        await fh.read(moov, 0, size, o);
        const n = scrubBoxes(moov, headerLen, size);
        if (n > 0) {
          await fh.write(moov, 0, size, o);
          count += n;
        }
      }
      o += size;
    }
    return count;
  } finally {
    await fh.close();
  }
}

function scrubBoxes(buf: Buffer, start: number, end: number): number {
  let count = 0;
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString("latin1", o + 4, o + 8);
    let headerLen = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = Number(buf.readBigUInt64BE(o + 8));
      headerLen = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < headerLen || o + size > end) break;
    if (SCRUB.has(type)) {
      buf.write("free", o + 4, "latin1");
      count++;
    } else if (CONTAINERS.has(type)) {
      count += scrubBoxes(buf, o + headerLen, o + size);
    }
    o += size;
  }
  return count;
}
