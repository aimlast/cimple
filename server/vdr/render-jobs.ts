/**
 * The message contract between the web process (render-pool.ts) and the
 * render child (render-child.ts). Types and plain constants only: importing
 * this file never loads pdf.js or the canvas.
 *
 * Jobs carry absolute file paths the web process has already confined (vdr
 * spec §9.5), never file contents from a buyer, and never secrets.
 */
import type { ImageHeader, PageWidth, ZipTotals } from "./child/limits";

/** Why a job failed. The same codes the data room stores on an item (vdr spec §8). */
export type RenderErrorCode =
  | "file_missing"
  | "too_long"
  | "too_large"
  | "unreadable"
  | "password"
  | "xfa"
  | "renderer_unavailable"
  | "timeout";

export type RenderJob =
  /** Render the built-in PDF (canary-pdf.ts) and load every library the child uses. */
  | { kind: "canary" }
  /** One page of a PDF as a JPEG. */
  | { kind: "pdfPage"; file: string; page: number; width: PageWidth; quality?: number }
  /** A photo, size-checked from its header first, re-encoded as a JPEG. */
  | { kind: "photo"; file: string; width: PageWidth; quality?: number }
  /** A zip container's central-directory totals (xlsx, docx, pptx), refused when over the caps. */
  | { kind: "zipCheck"; file: string }
  /**
   * Prepare a data-room document (vdr spec §9.5): writes the served copy and
   * the cache files into `outDir` (a confined private-vdr-cache folder) and
   * returns what it found. `text` is the document's stored text, used for
   * PowerPoint / .doc / .ppt when the file itself can't be read as text.
   */
  | { kind: "prepare"; file: string; outDir: string; fileKind: PrepareFileKind; ext: string; text?: string | null; prerender?: number }
  /** Render one page's base image (1,400 px, personal numbers covered) into the cache, for pages past the pre-rendered ones. */
  | { kind: "basePage"; outDir: string; page: number; source: "served" | "original"; file?: string | null }
  /** A base page → the page a reader sees: scaled, watermark burned in, JPEG (vdr spec §9.7). */
  | { kind: "composite"; file: string; width: PageWidth; mark: WatermarkSpec; quality?: number }
  /** Download: a PDF of watermarked page images (no text layer, no file details). */
  | { kind: "pagesPdf"; outDir: string; pages: number; source: "served" | "original" | "image"; file?: string | null; mark: WatermarkSpec }
  /** Download: a values-only workbook of the covered cells, with a first "Confidential" sheet. */
  | { kind: "valuesXlsx"; outDir: string; sheets: Array<{ index: number; name: string }>; stamp: string }
  /** Download: the sanitised served PDF, stamped on every page. */
  | { kind: "originalPdf"; outDir: string; mark: WatermarkSpec };

/** The watermark burned into a page (child/watermark.ts). `line` null = no diagonal text (the broker's own view). */
export type WatermarkSpec = { line: string | null; footer: string };

export type CanaryResult = {
  node: string;
  platform: string;
  /** True when the child had to install the process.getBuiltinModule shim (Node < 20.16). */
  shimInstalled: boolean;
  /** V8 heap limit inside the child (set by --max-old-space-size). */
  heapLimitMb: number;
  /** Names (never values) of the child's environment variables. */
  envKeys: string[];
  pdfjs: string;
  canvas: string;
  /** The native canvas package that actually loaded, e.g. "@napi-rs/canvas-linux-x64-gnu@0.1.80". */
  canvasBinary: string | null;
  /** Each library the child needs: "ok" or why it didn't load. */
  modules: Record<string, string>;
  pages: number;
  text: string;
  image: { width: number; height: number; bytes: number; format: "jpeg"; magicOk: boolean };
  /** Share of dark pixels inside the black box and inside the text line (0..1). */
  ink: { box: number; text: number; outside: number };
  ms: { load: number; render: number; encode: number; total: number };
  jpeg: Uint8Array;
};

export type PdfPageResult = {
  pages: number;
  page: number;
  width: number;
  height: number;
  /** True when the page was taller than 3 × its width and was scaled down to fit. */
  capped: boolean;
  hasText: boolean;
  jpeg: Uint8Array;
};

export type PhotoResult = { source: ImageHeader; width: number; height: number; jpeg: Uint8Array };

export type ZipCheckResult = ZipTotals;

export type PrepareFileKind = "pdf" | "image" | "sheet" | "html" | "text";

/** One row of vdr_page_text: the SERVED text (covered, hidden words dropped). */
export type PageTextRow = { page: number; label: string; text: string };

export type PrepareResult = {
  kind: PrepareFileKind;
  pages?: Array<{ w: number; h: number; hasText: boolean }>;
  sheets?: Array<{ name: string; rows: number; cols: number; firstRow: number; firstCol: number; hidden?: boolean; truncated?: boolean }>;
  personal: { count: number; kinds: Array<"sin" | "ssn" | "card" | "account">; pages: number[] };
  officeScan?: { count: number; parts: string[] };
  hidden?: { count: number; pages: number[] };
  forms?: { fields: number; covered: number };
  strippedAnnotations?: number;
  /** "sanitised": served.pdf was written; "original": the PDF couldn't be rewritten (e.g. encrypted), so pages render with no annotations and no original download is offered. */
  servedCopy?: "sanitised" | "original";
  pageTexts: PageTextRow[];
  /** Base page images written (1-based page numbers). */
  rendered: number[];
  ms: number;
};

export type BasePageResult = { page: number; width: number; height: number; bytes: number };

export type CompositeResult = { jpeg: Uint8Array; width: number; height: number };
export type DownloadResult = { bytes: Uint8Array };

export type RenderResultFor<J extends RenderJob> =
  J extends { kind: "canary" } ? CanaryResult
  : J extends { kind: "pdfPage" } ? PdfPageResult
  : J extends { kind: "photo" } ? PhotoResult
  : J extends { kind: "zipCheck" } ? ZipCheckResult
  : J extends { kind: "prepare" } ? PrepareResult
  : J extends { kind: "basePage" } ? BasePageResult
  : J extends { kind: "composite" } ? CompositeResult
  : J extends { kind: "pagesPdf" } ? DownloadResult
  : J extends { kind: "valuesXlsx" } ? DownloadResult
  : J extends { kind: "originalPdf" } ? DownloadResult
  : never;

// ── Wire protocol (IPC, advanced serialization) ────────────────────────────

export type ChildRequest = { id: number; job: RenderJob };

export type ChildMessage =
  | { type: "ready"; pid: number }
  | { type: "result"; id: number; ok: true; result: unknown }
  | { type: "result"; id: number; ok: false; code: RenderErrorCode; message: string };

/** Environment variables the child may inherit. Nothing secret can be listed here. */
export const CHILD_ENV_ALLOWLIST = ["NODE_ENV", "PATH", "TMPDIR", "TZ", "LANG", "LC_ALL", "LD_LIBRARY_PATH"] as const;
