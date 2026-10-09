/**
 * Preparing a PDF for the data room (vdr spec §9.5 step 2), inside the
 * render child:
 *
 *  1. Open the original (password → password; > 500 pages → too_long; pure
 *     XFA → xfa).
 *  2. Sanitise it (sanitise.ts) into served.pdf; everything below reads the
 *     served copy. A PDF pdf-lib can't rewrite (encrypted) is read as it is,
 *     drawn with NO annotations, and never offered as an original download.
 *  3. Per page: text pieces + form-field values (getAnnotations — they are
 *     not in getTextContent but ARE drawn); render; the hidden-words check
 *     on the render (before Cimple's own covers); lines assembled from the
 *     visible pieces (+ "Form field: …" lines); personal numbers found on
 *     lines and covered — every piece a number touches, or the whole widget;
 *     page text with the numbers masked.
 *  4. Pages 1–3 are kept as base images (1,400 px WebP); later pages are
 *     rendered on demand (basePage job) with the same covers (masks.json,
 *     stored as fractions of the page).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { assembleLines, findPersonalNumbers, applyMasks, piecesTouched, personalKinds, type TextPiece, type PersonalMatch } from "../../../shared/vdr-sensitive";
import { openPdf, renderPage } from "./pdf";
import { sanitisePdf } from "./sanitise";
import { visiblePart, visibleChars, wordChars, type PixelBox } from "./hidden";
import { loadPdfjs } from "./libs";
import type { PageTextRow, PrepareResult } from "../render-jobs";

/** A cover, as fractions (0..1) of the page image: [x0, y0, x1, y1]. */
export type MaskBox = [number, number, number, number];
export type MasksFile = { v: 1; pages: Record<string, MaskBox[]> };

const COVER_INK = "#1F1C18";
const MAX_PAGE_TEXT = 200_000;

function normBox(r: number[]): PixelBox {
  return { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) };
}

/** Draws covers (fractions of the page) on a canvas context, 2 px larger each side. */
export function drawCovers(ctx: { fillStyle: unknown; fillRect: (x: number, y: number, w: number, h: number) => void }, width: number, height: number, boxes: ReadonlyArray<MaskBox>): void {
  ctx.fillStyle = COVER_INK;
  for (const [x0, y0, x1, y1] of boxes) {
    const x = Math.max(0, Math.floor(x0 * width) - 2);
    const y = Math.max(0, Math.floor(y0 * height) - 2);
    ctx.fillRect(x, y, Math.min(width, Math.ceil(x1 * width) + 2) - x, Math.min(height, Math.ceil(y1 * height) + 2) - y);
  }
}

type PageWork = {
  hasText: boolean;
  w: number;
  h: number;
  text: string;
  masks: MaskBox[];
  personal: PersonalMatch["kind"][];
  hiddenSpans: number;
  formFields: number;
  formCovered: number;
};

async function preparePage(doc: PDFDocumentProxy, n: number, width: 700 | 1400, annotations: "all" | "none", keep: string | null): Promise<PageWork> {
  const pdfjs = await loadPdfjs();
  const r = await renderPage(doc, n, width, annotations);
  const { page, viewport, canvas } = r;
  const W = r.width, H = r.height;
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, W, H).data as unknown as Uint8ClampedArray;

  // Text pieces (PDF user space) and their boxes on the image.
  const content = await page.getTextContent();
  const pieces: TextPiece[] = [];
  const pieceBoxes: PixelBox[] = [];
  let hiddenSpans = 0;
  let visible = 0;
  for (const it of content.items as any[]) {
    if (typeof it?.str !== "string" || it.str.length === 0) continue;
    const t = it.transform as number[];
    const h = Number(it.height) || Math.hypot(t[2], t[3]) || 10;
    const x = t[4], y = t[5], w = Number(it.width) || 0;
    // The cover box (generous: descenders to the top of the em) and the
    // band the hidden-words check measures (between the baseline and the
    // cap height, where every glyph has ink — a redaction box drawn tightly
    // around the letters still covers all of it).
    const box = normBox(viewport.convertToViewportRectangle([x, y - 0.25 * h, x + w, y + h]));
    const band = normBox(viewport.convertToViewportRectangle([x, y + 0.05 * h, x + w, y + 0.6 * h]));
    let str = it.str as string;
    if (w > 0 && wordChars(str) >= 3) {
      const v = visiblePart(str, band, img, W, H);
      hiddenSpans += v.hiddenSpans;
      str = v.text;
    }
    if (!str) continue;
    visible += visibleChars(str);
    pieces.push({ str, x, y, w, h });
    pieceBoxes.push(box);
  }
  const lines = assembleLines(pieces);

  // Form fields: their values are drawn on the page but are not page text.
  const formLines: string[] = [];
  const formBoxes: PixelBox[] = [];
  let formFields = 0;
  if (annotations === "all") {
    const annots = await page.getAnnotations();
    for (const a of annots as any[]) {
      if (a?.subtype !== "Widget") continue;
      const raw = a.fieldValue;
      const values = Array.isArray(raw) ? raw : [raw];
      const text = values.filter((v) => typeof v === "string" && v.trim() && v !== "Off").join(", ");
      if (!text || !Array.isArray(a.rect)) continue;
      formFields++;
      formLines.push(`Form field: ${text.replace(/\s+/g, " ").trim()}`);
      formBoxes.push(normBox(viewport.convertToViewportRectangle(a.rect)));
    }
  }

  const allLines = [...lines.map((l) => l.text), ...formLines];
  const matches = findPersonalNumbers(allLines);
  const masks: MaskBox[] = [];
  let formCovered = 0;
  const frac = (b: PixelBox): MaskBox => [b.x0 / W, b.y0 / H, b.x1 / W, b.y1 / H];
  const coveredForms = new Set<number>();
  for (const m of matches) {
    if (m.line < lines.length) {
      for (const p of piecesTouched(lines[m.line], m.start, m.end)) masks.push(frac(pieceBoxes[p]));
    } else {
      const fi = m.line - lines.length;
      if (!coveredForms.has(fi)) {
        coveredForms.add(fi);
        formCovered++;
        masks.push(frac(formBoxes[fi]));
      }
    }
  }
  drawCovers(ctx as any, W, H, masks);
  if (keep) await fs.writeFile(keep, new Uint8Array(await canvas.encode("webp", 82)));

  let text = applyMasks(allLines, matches).join("\n");
  if (text.length > MAX_PAGE_TEXT) text = text.slice(0, MAX_PAGE_TEXT);
  const base = page.getViewport({ scale: 1 });
  page.cleanup();
  void pdfjs;
  return {
    hasText: visible >= 20,
    w: Math.round(base.width),
    h: Math.round(base.height),
    text,
    masks,
    personal: matches.map((m) => m.kind),
    hiddenSpans,
    formFields,
    formCovered,
  };
}

export async function preparePdf(original: Uint8Array, outDir: string, prerender: number): Promise<PrepareResult> {
  const t0 = performance.now();
  // 1. Refusals on the original (password, too long, XFA) — openPdf throws plain codes.
  const probe = await openPdf(original);
  await probe.destroy().catch(() => {});

  // 2. The served copy.
  await fs.mkdir(outDir, { recursive: true });
  let source = original;
  let annotations: "all" | "none" = "none";
  let servedCopy: "sanitised" | "original" = "original";
  let stripped: number | undefined;
  const sanitised = await sanitisePdf(original).catch(() => null);
  if (sanitised) {
    try {
      const check = await openPdf(sanitised.bytes);
      await check.destroy().catch(() => {});
      await fs.writeFile(path.join(outDir, "served.pdf"), sanitised.bytes);
      source = sanitised.bytes;
      annotations = "all";
      servedCopy = "sanitised";
      stripped = sanitised.strippedAnnotations;
    } catch {
      // pdf-lib wrote something pdf.js can't open: fall back to the original, drawn with no annotations.
    }
  }

  // 3. Every page.
  const doc = await openPdf(source);
  const pages: NonNullable<PrepareResult["pages"]> = [];
  const pageTexts: PageTextRow[] = [];
  const maskFile: MasksFile = { v: 1, pages: {} };
  const personalPages = new Set<number>();
  const kinds: PersonalMatch["kind"][] = [];
  const hiddenPages: number[] = [];
  const rendered: number[] = [];
  let hiddenCount = 0, formFields = 0, formCovered = 0;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const keep = n <= prerender ? path.join(outDir, `p${n}.webp`) : null;
      const pw = await preparePage(doc, n, keep ? 1400 : 700, annotations, keep);
      if (keep) rendered.push(n);
      pages.push({ w: pw.w, h: pw.h, hasText: pw.hasText });
      pageTexts.push({ page: n, label: `Page ${n}`, text: pw.text });
      if (pw.masks.length) maskFile.pages[String(n)] = pw.masks;
      if (pw.personal.length) { personalPages.add(n); kinds.push(...pw.personal); }
      if (pw.hiddenSpans) { hiddenCount += pw.hiddenSpans; hiddenPages.push(n); }
      formFields += pw.formFields;
      formCovered += pw.formCovered;
    }
  } finally {
    await doc.destroy().catch(() => {});
  }
  await fs.writeFile(path.join(outDir, "masks.json"), JSON.stringify(maskFile));
  return {
    kind: "pdf",
    pages,
    personal: { count: kinds.length, kinds: personalKinds(kinds.map((k) => ({ kind: k }))), pages: Array.from(personalPages).sort((a, b) => a - b) },
    hidden: { count: hiddenCount, pages: hiddenPages },
    forms: { fields: formFields, covered: formCovered },
    ...(stripped !== undefined ? { strippedAnnotations: stripped } : {}),
    servedCopy,
    pageTexts,
    rendered,
    ms: Math.round(performance.now() - t0),
  };
}

/** Renders one page's base image (1,400 px) with its covers, from the served copy or the original. */
export async function renderBasePage(source: Uint8Array, outDir: string, n: number, annotations: "all" | "none"): Promise<{ page: number; width: number; height: number; bytes: number }> {
  let masks: MasksFile = { v: 1, pages: {} };
  try { masks = JSON.parse(await fs.readFile(path.join(outDir, "masks.json"), "utf8")); } catch { /* none */ }
  const doc = await openPdf(source);
  try {
    const r = await renderPage(doc, n, 1400, annotations);
    drawCovers(r.canvas.getContext("2d") as any, r.width, r.height, masks.pages?.[String(n)] ?? []);
    const bytes = new Uint8Array(await r.canvas.encode("webp", 82));
    await fs.writeFile(path.join(outDir, `p${n}.webp`), bytes);
    r.page.cleanup();
    return { page: n, width: r.width, height: r.height, bytes: bytes.length };
  } finally {
    await doc.destroy().catch(() => {});
  }
}
