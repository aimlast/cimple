/**
 * PDF opening and page rendering inside the render child (vdr spec §9.5).
 * Caps before anything is decoded: pdf.js with eval, font-face, system fonts,
 * XFA and OffscreenCanvas off and `maxImageSize`; over 500 pages → too_long;
 * a password → password; pure XFA → xfa; the page canvas is 700 or 1,400 px
 * wide and never taller than 3 × its width.
 */
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist/legacy/build/pdf.mjs";
import { fitPageCanvas, VDR_RENDER_LIMITS, type PageWidth } from "./limits";
import { ChildJobError } from "./errors";
import { loadCanvas, loadPdfjs, standardFontDir } from "./libs";

export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  // pdf.js tolerates junk before the header; anything without one in the first 1 KB isn't a PDF.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw new ChildJobError("unreadable", "not a PDF");
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes), // pdf.js takes ownership of the buffer
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: VDR_RENDER_LIMITS.maxImageSize,
    standardFontDataUrl: standardFontDir(),
    verbosity: 0, // errors only
  });
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (err: any) {
    await task.destroy().catch(() => {});
    if (err?.name === "PasswordException") throw new ChildJobError("password", "the PDF has a password");
    throw new ChildJobError("unreadable", `pdf.js couldn't open it: ${err?.name || "Error"} ${String(err?.message ?? "").slice(0, 150)}`.trim());
  }
  if (doc.numPages > VDR_RENDER_LIMITS.maxPages) {
    await doc.destroy().catch(() => {});
    throw new ChildJobError("too_long", `${doc.numPages} pages (over ${VDR_RENDER_LIMITS.maxPages})`);
  }
  if (doc.isPureXfa) {
    await doc.destroy().catch(() => {});
    throw new ChildJobError("xfa", "an XFA form");
  }
  return doc;
}

export type RenderedPage = {
  page: PDFPageProxy;
  viewport: PageViewport;
  canvas: import("@napi-rs/canvas").Canvas;
  width: number;
  height: number;
  capped: boolean;
};

/**
 * Renders one page on a white canvas.
 *   "forms" (the canary's default): pdf.js ENABLE_FORMS — no form-field values drawn;
 *   "all":  every annotation drawn — used on the SANITISED served copy, where
 *           only form widgets are left, so their filled-in values show;
 *   "none": no annotation drawn at all (a PDF Cimple couldn't sanitise).
 */
export async function renderPage(doc: PDFDocumentProxy, pageNo: number, width: PageWidth, annotations: "forms" | "all" | "none" = "forms"): Promise<RenderedPage> {
  if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > doc.numPages) {
    throw new ChildJobError("unreadable", `no page ${pageNo}`);
  }
  const [pdfjs, { createCanvas }] = await Promise.all([loadPdfjs(), loadCanvas()]);
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const fit = fitPageCanvas(base.width, base.height, width);
  if (!fit) throw new ChildJobError("unreadable", "the page has no size");
  const viewport = page.getViewport({ scale: fit.scale });
  const canvas = createCanvas(fit.width, fit.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, fit.width, fit.height);
  await page.render({
    canvas: null,
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
    annotationMode: annotations === "all" ? pdfjs.AnnotationMode.ENABLE : annotations === "none" ? pdfjs.AnnotationMode.DISABLE : pdfjs.AnnotationMode.ENABLE_FORMS,
  }).promise;
  return { page, viewport, canvas, width: fit.width, height: fit.height, capped: fit.capped };
}

/** The page's text, item by item joined with spaces (enough for the canary and `hasText`). */
export async function pageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  return content.items
    .map((it) => ("str" in it ? it.str : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
