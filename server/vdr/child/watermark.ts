/**
 * The watermark, burned into every page image a reader sees (vdr spec §9.7),
 * inside the render child.
 *
 *  - Diagonal (−30°) rows of the reader's line ("Jane Doe · jane@… ·
 *    2026-10-09 14:02 UTC · 7F3K2Q"), 22 px at 1,400 wide (14 px at 700), ink
 *    #46423B at 10 % alpha, rows 300 px apart.
 *  - A solid footer band, 18 px: "Confidential · viewed by {email} on
 *    {Oct 9, 2026, 18:53 UTC} · shared by {firm}".
 *  - The font is LiberationSans from pdf.js's bundled standard fonts
 *    (node_modules), registered explicitly: a server with no system fonts
 *    would otherwise draw no watermark at all.
 *  - Served as JPEG q82 (a composite costs ~22 ms vs ~117 ms as WebP, §9.5).
 *
 * The broker's own view gets no watermark, only a small footer naming them.
 */
import fs from "node:fs";
import path from "node:path";
import { ChildJobError } from "./errors";
import { loadCanvas, standardFontDir } from "./libs";
import { readJobFile } from "./read-file";
import type { PageWidth } from "./limits";

export const WATERMARK_FONT = "VdrWatermarkSans";
const INK = "70, 66, 59"; // #46423B

let fontReady: Promise<boolean> | null = null;
/** Registers LiberationSans once per child. False when it can't be found (the band still draws). */
export function ensureWatermarkFont(): Promise<boolean> {
  if (!fontReady) {
    fontReady = (async () => {
      const { GlobalFonts } = await loadCanvas();
      const file = path.join(standardFontDir(), "LiberationSans-Regular.ttf");
      if (!fs.existsSync(file)) return false;
      return !!GlobalFonts.registerFromPath(file, WATERMARK_FONT);
    })();
    fontReady.catch(() => { fontReady = null; });
  }
  return fontReady;
}

export type WatermarkSpec = {
  /** The diagonal line; null = no diagonal text (the broker's own view). */
  line: string | null;
  /** The footer band's text. */
  footer: string;
};

type Ctx = {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(a: number): void;
  fillText(t: string, x: number, y: number): void;
  measureText(t: string): { width: number };
  fillRect(x: number, y: number, w: number, h: number): void;
  font: string;
  fillStyle: unknown;
  textBaseline: string;
};

/** Draws the diagonal rows and the footer band on a canvas of width × height. */
export function drawWatermark(ctx: Ctx, width: number, height: number, spec: WatermarkSpec): void {
  const small = width < 1000;
  const fontPx = small ? 14 : 22;
  if (spec.line) {
    ctx.save();
    ctx.font = `${fontPx}px ${WATERMARK_FONT}`;
    ctx.fillStyle = `rgba(${INK}, 0.10)`;
    ctx.textBaseline = "middle";
    const text = `${spec.line}     `;
    const unit = Math.max(40, ctx.measureText(text).width);
    const spacing = small ? 150 : 300;
    // Rotate about the centre and cover the whole page's diagonal.
    ctx.translate(width / 2, height / 2);
    ctx.rotate((-30 * Math.PI) / 180);
    const reach = Math.ceil(Math.hypot(width, height) / 2) + spacing;
    for (let y = -reach, row = 0; y <= reach; y += spacing, row++) {
      const offset = (row % 2) * (unit / 2);
      for (let x = -reach - unit + offset; x <= reach; x += unit) ctx.fillText(text, x, y);
    }
    ctx.restore();
  }
  // Footer band.
  const band = small ? 14 : 18;
  ctx.save();
  ctx.fillStyle = "rgba(251, 249, 244, 0.94)";
  ctx.fillRect(0, height - band, width, band);
  ctx.fillStyle = `rgb(${INK})`;
  ctx.font = `${small ? 9 : 11}px ${WATERMARK_FONT}`;
  ctx.textBaseline = "middle";
  const max = width - 16;
  let footer = spec.footer;
  while (footer.length > 8 && ctx.measureText(footer).width > max) footer = footer.slice(0, -2);
  if (footer !== spec.footer) footer = footer.replace(/\s*\S?$/, "…");
  ctx.fillText(footer, 8, height - band / 2);
  ctx.restore();
}

/**
 * A base page (WebP, 1,400 px, personal numbers already covered) → the page a
 * reader sees: scaled to `width`, watermark burned in, JPEG.
 */
export async function compositePage(file: string, width: PageWidth, spec: WatermarkSpec, quality = 82): Promise<{ jpeg: Uint8Array; width: number; height: number }> {
  if (typeof file !== "string" || !/[\\/]private-vdr-cache[\\/]/.test(file) || !/\.webp$/.test(file)) {
    throw new ChildJobError("unreadable", "no usable page image");
  }
  const bytes = await readJobFile(file);
  const [{ createCanvas, loadImage }] = await Promise.all([loadCanvas(), ensureWatermarkFont()]);
  let img;
  try {
    img = await loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    throw new ChildJobError("unreadable", "the page image couldn't be decoded");
  }
  const scale = Math.min(1, width / img.width);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  drawWatermark(ctx as unknown as Ctx, w, h, spec);
  const jpeg = new Uint8Array(await canvas.encode("jpeg", quality));
  return { jpeg, width: w, height: h };
}
