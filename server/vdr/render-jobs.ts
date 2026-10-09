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
  | { kind: "zipCheck"; file: string };

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

export type RenderResultFor<J extends RenderJob> =
  J extends { kind: "canary" } ? CanaryResult
  : J extends { kind: "pdfPage" } ? PdfPageResult
  : J extends { kind: "photo" } ? PhotoResult
  : J extends { kind: "zipCheck" } ? ZipCheckResult
  : never;

// ── Wire protocol (IPC, advanced serialization) ────────────────────────────

export type ChildRequest = { id: number; job: RenderJob };

export type ChildMessage =
  | { type: "ready"; pid: number }
  | { type: "result"; id: number; ok: true; result: unknown }
  | { type: "result"; id: number; ok: false; code: RenderErrorCode; message: string };

/** Environment variables the child may inherit. Nothing secret can be listed here. */
export const CHILD_ENV_ALLOWLIST = ["NODE_ENV", "PATH", "TMPDIR", "TZ", "LANG", "LC_ALL", "LD_LIBRARY_PATH"] as const;
