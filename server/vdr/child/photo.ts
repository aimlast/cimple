/**
 * Photos inside the render child: the pixel size is read from the file
 * header BEFORE decoding (over 40 megapixels → too_large, never decoded),
 * then the photo is decoded, scaled to at most the page width and re-encoded
 * as a JPEG on a white background (vdr spec §9.5 step 3; SVG is never accepted).
 */
import { photoTooLarge, readImageHeader, type PageWidth } from "./limits";
import { ChildJobError } from "./errors";
import { loadCanvas } from "./libs";
import type { PhotoResult } from "../render-jobs";

export async function renderPhoto(bytes: Uint8Array, width: PageWidth, quality = 82): Promise<PhotoResult> {
  const header = readImageHeader(bytes);
  if (!header) throw new ChildJobError("unreadable", "not a PNG, JPEG or WebP picture");
  if (photoTooLarge(header)) throw new ChildJobError("too_large", `${header.width} × ${header.height} pixels`);
  const { createCanvas, loadImage } = await loadCanvas();
  let img;
  try {
    img = await loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    throw new ChildJobError("unreadable", "the picture couldn't be decoded");
  }
  const scale = Math.min(1, width / img.width);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const jpeg = new Uint8Array(await canvas.encode("jpeg", quality));
  return { source: header, width: w, height: h, jpeg };
}
