/**
 * `GET /api/vdr/health` (vdr spec §9.2; INTEGRATION §5 Wave 0): the
 * renderer canary. It renders the built-in PDF in a real render process and
 * reports, for a signed-in broker:
 *   { renderer: "ok" | reason, node, pdfjs, canvas, disk: { cacheMb }, … }
 * A hard gate before any data-room UI ships: if it isn't "ok" on Railway,
 * page images fall back to the text view.
 *
 * The result is kept for 30 s and concurrent calls share one render, so the
 * route can't be used to keep the render processes busy.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { rendererStatus, renderPool, type RendererStatus, type RenderPool } from "./render-pool";

export type VdrHealth = {
  renderer: "ok" | string;
  node: string;
  pdfjs: string;
  canvas: string;
  disk: { cacheMb: number };
  checkedAt: string;
  /** What the render process measured (absent when it couldn't start). */
  child?: {
    node: string;
    platform: string;
    shimInstalled: boolean;
    heapLimitMb: number;
    envKeys: string[];
    canvasBinary: string | null;
    modules: Record<string, string>;
    image: { width: number; height: number; bytes: number };
    ink: { box: number; text: number; outside: number };
    ms: { load: number; render: number; encode: number; total: number };
  };
};

const req = createRequire(import.meta.url);

/** Installed version, read from package.json (the web process never imports pdf.js or the canvas). */
function installedVersion(name: string): string {
  try {
    return String(req(`${name}/package.json`).version ?? "?");
  } catch {
    return "not installed";
  }
}

function uploadsRoot(): string {
  return process.env.UPLOADS_DIR || path.join(process.cwd(), "public", "uploads");
}

/** Size of the data room's page-image cache, in MB (one decimal). Stops counting after 100,000 files. */
export async function cacheSizeMb(dir = path.join(uploadsRoot(), "private-vdr-cache")): Promise<number> {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length && files < 100_000) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      continue; // missing (no room has been prepared yet) or unreadable
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files++;
        try { bytes += (await fs.stat(p)).size; } catch { /* removed meanwhile */ }
      }
    }
  }
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

export function healthFromStatus(status: RendererStatus, cacheMb: number, now = new Date()): VdrHealth {
  const d = status.detail;
  return {
    renderer: status.ok ? "ok" : status.reason,
    node: process.version,
    pdfjs: d?.pdfjs ?? installedVersion("pdfjs-dist"),
    canvas: d?.canvas ?? installedVersion("@napi-rs/canvas"),
    disk: { cacheMb },
    checkedAt: now.toISOString(),
    ...(d
      ? {
          child: {
            node: d.node,
            platform: d.platform,
            shimInstalled: d.shimInstalled,
            heapLimitMb: d.heapLimitMb,
            envKeys: d.envKeys,
            canvasBinary: d.canvasBinary,
            modules: d.modules,
            image: { width: d.image.width, height: d.image.height, bytes: d.image.bytes },
            ink: {
              box: Math.round(d.ink.box * 1000) / 1000,
              text: Math.round(d.ink.text * 1000) / 1000,
              outside: Math.round(d.ink.outside * 1000) / 1000,
            },
            ms: d.ms,
          },
        }
      : {}),
  };
}

const CACHE_MS = 30_000;
let cached: { at: number; value: VdrHealth } | null = null;
let inFlight: Promise<VdrHealth> | null = null;

/** The health payload; one render per 30 s at most, shared by concurrent callers. */
export function vdrHealth(pool: RenderPool = renderPool): Promise<VdrHealth> {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.value);
  if (!inFlight) {
    inFlight = (async () => {
      const [status, cacheMb] = await Promise.all([rendererStatus(pool), cacheSizeMb()]);
      const value = healthFromStatus(status, cacheMb);
      cached = { at: Date.now(), value };
      return value;
    })().finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** Tests only: forget the kept result. */
export function _resetVdrHealthCache() {
  cached = null;
}
