/**
 * Lazy loaders for the render child's libraries. Every third-party import is
 * DYNAMIC: esbuild hoists static imports of external packages to the top of
 * the bundle, which would load pdf.js before the getBuiltinModule shim runs.
 * tests/unit/vdr-render.test.ts checks that no file under server/vdr/child
 * (or render-child.ts) imports these packages statically.
 */
import { createRequire } from "node:module";
import path from "node:path";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type Canvas = typeof import("@napi-rs/canvas");

let pdfjsP: Promise<PdfJs> | null = null;
let canvasP: Promise<Canvas> | null = null;

export function loadPdfjs(): Promise<PdfJs> {
  if (!pdfjsP) {
    pdfjsP = import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsP.catch(() => { pdfjsP = null; });
  }
  return pdfjsP;
}

export function loadCanvas(): Promise<Canvas> {
  if (!canvasP) {
    canvasP = import("@napi-rs/canvas");
    canvasP.catch(() => { canvasP = null; });
  }
  return canvasP;
}

type PdfLib = typeof import("pdf-lib");
let pdfLibP: Promise<PdfLib> | null = null;
/** pdf-lib (sanitising the served copy; later stamping and page-image PDFs). */
export function loadPdfLib(): Promise<PdfLib> {
  if (!pdfLibP) {
    pdfLibP = import("pdf-lib").then((m: any) => (m.PDFDocument ? m : m.default) as PdfLib);
    pdfLibP.catch(() => { pdfLibP = null; });
  }
  return pdfLibP;
}

/** SheetJS (spreadsheets). */
export async function loadXlsx(): Promise<typeof import("xlsx")> {
  const m: any = await import("xlsx");
  return (m.read ? m : m.default) as typeof import("xlsx");
}

/** JSZip (reading every part of an office file; rewriting a docx before mammoth). */
export async function loadJszip(): Promise<typeof import("jszip")> {
  const m: any = await import("jszip");
  return (m.loadAsync ? m : m.default) as typeof import("jszip");
}

/** mammoth (docx → HTML). */
export async function loadMammoth(): Promise<any> {
  const m: any = await import("mammoth");
  return m.convertToHtml ? m : m.default;
}

/** sanitize-html. */
export async function loadSanitizeHtml(): Promise<any> {
  const m: any = await import("sanitize-html");
  return m.default ?? m;
}

const req = createRequire(import.meta.url);

/** pdf.js's bundled standard fonts (Helvetica, Times…), read from node_modules, never from the system. */
export function standardFontDir(): string {
  return path.join(path.dirname(req.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;
}

/** Installed version of a package ("?" when it can't be read). */
export function packageVersion(name: string): string {
  try {
    return String(req(`${name}/package.json`).version ?? "?");
  } catch {
    return "?";
  }
}

/** The native canvas package that actually loaded (found in the require cache after loading the canvas). */
export function loadedCanvasBinary(): string | null {
  for (const key of Object.keys(req.cache)) {
    const m = key.split(path.sep).join("/").match(/\/node_modules\/(@napi-rs\/canvas-[^/]+)\//);
    if (m) return `${m[1]}@${packageVersion(m[1])}`;
    if (/skia\.[^/\\]+\.node$/.test(key)) return path.basename(key);
  }
  return null;
}
