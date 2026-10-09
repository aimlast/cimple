/**
 * The data room's render process (vdr spec §9.5, V14). A SEPARATE esbuild
 * entry (`dist/vdr/render-child.js`), forked by render-pool.ts; the web
 * server never imports it, pdf.js or the native canvas.
 *
 *  - Its environment holds no secrets (the pool passes an allowlist only).
 *  - Its V8 heap is capped by the pool (--max-old-space-size).
 *  - It runs one job at a time; the pool kills it (SIGKILL) on a timeout.
 *  - It installs the process.getBuiltinModule shim BEFORE pdf.js loads
 *    (every third-party import below is dynamic, see child/libs.ts).
 *  - It exits when the web process goes away (IPC disconnect).
 */
import { installGetBuiltinModuleShim } from "./child/shim";
import { ChildJobError } from "./child/errors";
import { runCanary } from "./child/canary";
import { isPageWidth, zipTooLarge, zipTotals } from "./child/limits";
import { openPdf, pageText, renderPage } from "./child/pdf";
import { renderPhoto } from "./child/photo";
import { readJobFile } from "./child/read-file";
import type { ChildMessage, ChildRequest, RenderJob } from "./render-jobs";

const shimInstalled = installGetBuiltinModuleShim();

async function runJob(job: RenderJob): Promise<unknown> {
  switch (job?.kind) {
    case "canary":
      return runCanary(shimInstalled);
    case "pdfPage": {
      if (!isPageWidth(job.width)) throw new ChildJobError("unreadable", "width must be 700 or 1400");
      const doc = await openPdf(await readJobFile(job.file));
      try {
        const r = await renderPage(doc, job.page, job.width);
        const text = await pageText(r.page);
        const jpeg = new Uint8Array(await r.canvas.encode("jpeg", clampQuality(job.quality)));
        return { pages: doc.numPages, page: job.page, width: r.width, height: r.height, capped: r.capped, hasText: text.replace(/\s/g, "").length >= 20, jpeg };
      } finally {
        await doc.destroy().catch(() => {});
      }
    }
    case "photo": {
      if (!isPageWidth(job.width)) throw new ChildJobError("unreadable", "width must be 700 or 1400");
      return renderPhoto(await readJobFile(job.file), job.width, clampQuality(job.quality));
    }
    case "zipCheck": {
      const totals = zipTotals(await readJobFile(job.file));
      if (!totals) throw new ChildJobError("unreadable", "not a readable zip container");
      if (zipTooLarge(totals)) throw new ChildJobError("too_large", `${totals.entries} entries, ${totals.uncompressedBytes} bytes uncompressed`);
      return totals;
    }
    default:
      throw new ChildJobError("unreadable", "unknown job");
  }
}

function clampQuality(q: unknown): number {
  return typeof q === "number" && q >= 40 && q <= 95 ? Math.round(q) : 82;
}

function send(msg: ChildMessage) {
  if (process.connected) process.send!(msg);
}

if (!process.send) {
  console.error("[vdr-render-child] must be started by the render pool (no IPC channel)");
  process.exit(2);
}

let busy = false;
process.on("message", async (raw: unknown) => {
  const req = raw as ChildRequest;
  if (!req || typeof req.id !== "number") return;
  if (busy) {
    send({ type: "result", id: req.id, ok: false, code: "renderer_unavailable", message: "the render process is busy" });
    return;
  }
  busy = true;
  try {
    const result = await runJob(req.job);
    send({ type: "result", id: req.id, ok: true, result });
  } catch (err: any) {
    if (err instanceof ChildJobError) {
      send({ type: "result", id: req.id, ok: false, code: err.code, message: err.message });
    } else {
      // A library that won't load (e.g. the native canvas) means the renderer itself is down.
      const unavailable = err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "MODULE_NOT_FOUND" || /native binding|dlopen|\.node\b/i.test(String(err?.message));
      send({
        type: "result",
        id: req.id,
        ok: false,
        code: unavailable ? "renderer_unavailable" : "unreadable",
        message: String(err?.message || err).slice(0, 300),
      });
    }
  } finally {
    busy = false;
  }
});
process.on("disconnect", () => process.exit(0));
send({ type: "ready", pid: process.pid });
