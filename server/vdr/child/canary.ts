/**
 * The renderer canary, run inside the render child: render the built-in PDF
 * (canary-pdf.ts) to a JPEG with pdf.js + the native canvas, measure the ink
 * where the page has its black box and its line of text, and load every
 * library the data room's child needs (pdf-lib, mammoth, sanitize-html,
 * SheetJS). The web process judges the measurements (canary-pdf.ts
 * `judgeCanary`); nothing here touches the disk.
 */
import v8 from "node:v8";
import { CANARY_BOX, CANARY_PAGE, CANARY_TEXT_POS, canaryPdfBytes } from "../canary-pdf";
import type { CanaryResult } from "../render-jobs";
import { loadCanvas, loadPdfjs, loadedCanvasBinary, packageVersion } from "./libs";
import { openPdf, pageText, renderPage } from "./pdf";

/** Share of dark pixels (luminance < 60) inside a canvas rectangle, edges trimmed by `inset` px. */
function darkShare(data: Uint8ClampedArray, canvasWidth: number, r: { x1: number; y1: number; x2: number; y2: number }, inset: number): number {
  const x1 = Math.ceil(Math.min(r.x1, r.x2) + inset), x2 = Math.floor(Math.max(r.x1, r.x2) - inset);
  const y1 = Math.ceil(Math.min(r.y1, r.y2) + inset), y2 = Math.floor(Math.max(r.y1, r.y2) - inset);
  let dark = 0, all = 0;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const i = (y * canvasWidth + x) * 4;
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (lum < 60) dark++;
      all++;
    }
  }
  return all ? dark / all : 0;
}

async function checkModule(name: string, check: () => Promise<boolean>): Promise<string> {
  try {
    return (await check()) ? "ok" : `${name} loaded but didn't work`;
  } catch (err: any) {
    return `${name} didn't load: ${String(err?.message || err).slice(0, 200)}`;
  }
}

export async function runCanary(shimInstalled: boolean): Promise<CanaryResult> {
  const t0 = performance.now();
  const [pdfjs] = await Promise.all([loadPdfjs(), loadCanvas()]);
  const bytes = canaryPdfBytes();
  const doc = await openPdf(bytes);
  try {
    const tLoad = performance.now();
    const r = await renderPage(doc, 1, 700);
    const tRender = performance.now();
    const text = await pageText(r.page);
    const ctx = r.canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, r.width, r.height).data as unknown as Uint8ClampedArray;
    const rect = (x: number, y: number, w: number, h: number) => {
      const [x1, y1, x2, y2] = r.viewport.convertToViewportRectangle([x, y, x + w, y + h]);
      return { x1, y1, x2, y2 };
    };
    const ink = {
      box: darkShare(data, r.width, rect(CANARY_BOX.x, CANARY_BOX.y, CANARY_BOX.w, CANARY_BOX.h), 3),
      // the text line: from just below the baseline to the cap height, across the first ~150 pt
      text: darkShare(data, r.width, rect(CANARY_TEXT_POS.x, CANARY_TEXT_POS.y - 4, 150, CANARY_TEXT_POS.size), 0),
      // a band with nothing printed on it (between the box and the text)
      outside: darkShare(data, r.width, rect(0, CANARY_BOX.y + CANARY_BOX.h + 6, CANARY_PAGE.width, 30), 0),
    };
    const jpeg = new Uint8Array(await r.canvas.encode("jpeg", 82));
    const tEncode = performance.now();

    const modules: Record<string, string> = {
      "pdf-lib": await checkModule("pdf-lib", async () => {
        const { PDFDocument } = await import("pdf-lib");
        const d = await PDFDocument.load(bytes, { updateMetadata: false });
        return d.getPageCount() === 1;
      }),
      mammoth: await checkModule("mammoth", async () => {
        const m: any = await import("mammoth");
        return typeof (m.default ?? m).convertToHtml === "function";
      }),
      "sanitize-html": await checkModule("sanitize-html", async () => {
        const m: any = await import("sanitize-html");
        const sanitize = m.default ?? m;
        const out = sanitize('<p>ok<script>alert(1)</script><a href="javascript:x">!</a></p>', { allowedTags: ["p"], allowedAttributes: {} });
        return out === "<p>ok!</p>";
      }),
      xlsx: await checkModule("xlsx", async () => {
        const m: any = await import("xlsx");
        const XLSX = m.read ? m : m.default;
        const wb = XLSX.read("a,b\n1,2", { type: "string" });
        return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })[1]?.[1] === 2;
      }),
    };

    return {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      shimInstalled,
      heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024)),
      envKeys: Object.keys(process.env).sort(),
      pdfjs: String(pdfjs.version ?? packageVersion("pdfjs-dist")),
      canvas: packageVersion("@napi-rs/canvas"),
      canvasBinary: loadedCanvasBinary(),
      modules,
      pages: doc.numPages,
      text,
      image: {
        width: r.width,
        height: r.height,
        bytes: jpeg.length,
        format: "jpeg",
        magicOk: jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[2] === 0xff,
      },
      ink,
      ms: {
        load: Math.round(tLoad - t0),
        render: Math.round(tRender - tLoad),
        encode: Math.round(tEncode - tRender),
        total: Math.round(performance.now() - t0),
      },
      jpeg,
    };
  } finally {
    await doc.destroy().catch(() => {});
  }
}
