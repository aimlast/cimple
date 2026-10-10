/**
 * The render child's `prepare` and `basePage` jobs (vdr spec §9.5): one
 * dispatcher per file kind. Every path arrives already confined by the web
 * process (server/vdr/files.ts); the child still refuses anything that isn't
 * an absolute path, and writes only inside `outDir`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ChildJobError } from "./errors";
import { readJobFile } from "./read-file";
import { photoTooLarge, readImageHeader } from "./limits";
import { loadCanvas } from "./libs";
import { preparePdf, renderBasePage } from "./prepare-pdf";
import { prepareSheet } from "./sheet";
import { prepareDocx, prepareText } from "./docx";
import type { BasePageResult, PrepareResult, RenderJob } from "../render-jobs";

function checkOutDir(dir: unknown): string {
  if (typeof dir !== "string" || !path.isAbsolute(dir) || dir.includes("\0") || !/[\\/]private-vdr-cache[\\/]/.test(dir)) {
    throw new ChildJobError("unreadable", "no usable output folder");
  }
  return dir;
}

async function prepareImage(bytes: Uint8Array, outDir: string): Promise<PrepareResult> {
  const t0 = performance.now();
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
  const scale = Math.min(1, 1400 / img.width);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "p1.webp"), new Uint8Array(await canvas.encode("webp", 82)));
  return {
    kind: "image",
    pages: [{ w: header.width, h: header.height, hasText: false }],
    personal: { count: 0, kinds: [], pages: [] },
    pageTexts: [],
    rendered: [1],
    ms: Math.round(performance.now() - t0),
  };
}

export async function runPrepare(job: Extract<RenderJob, { kind: "prepare" }>): Promise<PrepareResult> {
  const outDir = checkOutDir(job.outDir);
  const bytes = await readJobFile(job.file);
  const ext = String(job.ext ?? "").toLowerCase();
  const prerender = Math.max(0, Math.min(10, Number(job.prerender ?? 3) || 0));
  switch (job.fileKind) {
    case "pdf": return preparePdf(bytes, outDir, prerender);
    case "image": return prepareImage(bytes, outDir);
    case "sheet": return prepareSheet(bytes, ext, outDir);
    case "html": return prepareDocx(bytes, outDir);
    case "text": return prepareText(bytes, ext, job.text, outDir);
    default: throw new ChildJobError("unreadable", "this kind of file can't be shown");
  }
}

export async function runBasePage(job: Extract<RenderJob, { kind: "basePage" }>): Promise<BasePageResult> {
  const outDir = checkOutDir(job.outDir);
  if (!Number.isInteger(job.page) || job.page < 1) throw new ChildJobError("unreadable", `no page ${job.page}`);
  const source = job.source === "served" ? await readJobFile(path.join(outDir, "served.pdf")) : await readJobFile(job.file);
  return renderBasePage(source, outDir, job.page, job.source === "served" ? "all" : "none");
}
