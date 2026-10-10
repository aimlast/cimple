/**
 * Preparing a Word file (.docx) for the data room (vdr spec §9.5 step 5),
 * inside the render child.
 *
 *  - The zip's central directory is checked first; every XML part (headers,
 *    footers, comments, footnotes …) is scanned for personal numbers — they
 *    aren't shown, but they block an original download.
 *  - Linked pictures (r:link → a file path or URL) are stripped from the
 *    document BEFORE mammoth sees it: mammoth 1.8 would read a linked path
 *    straight from the server's disk.
 *  - mammoth → HTML; pictures only as png/jpeg/gif/webp data, 5 MB in all
 *    (beyond that, or any other type such as SVG: "[picture left out]").
 *  - sanitize-html allowlist: p, h1–h6, strong, em, u, s, ul, ol, li, table,
 *    thead, tbody, tr, th, td, br, blockquote, img[src^="data:image/…"].
 *    No links, styles or classes.
 *  - Personal numbers are covered per paragraph (a number split across runs
 *    — bold "046 454" + plain " 286" — is one paragraph's text): a block that
 *    holds one becomes its masked plain text.
 *  - doc.html is returned to buyers as JSON for a sandboxed iframe, never as
 *    text/html.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { findPersonalNumbers, applyMasks, scanOfficeParts, decodeXmlText, personalKinds, type PersonalKind } from "../../../shared/vdr-sensitive";
import { ChildJobError } from "./errors";
import { checkZip } from "./sheet";
import { loadJszip, loadMammoth, loadSanitizeHtml } from "./libs";
import type { PrepareResult } from "../render-jobs";

export const DOCX_IMAGE_BUDGET = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const LEFT_OUT = "[picture left out]";
const BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "blockquote"]);

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Removes linked (not embedded) picture references from every XML part of a docx. */
export async function stripLinkedPictures(bytes: Uint8Array): Promise<{ bytes: Uint8Array; removed: number }> {
  const JSZip: any = await loadJszip();
  const zip = await JSZip.loadAsync(bytes);
  let removed = 0;
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !/^word\/.*\.xml$/i.test(name)) continue;
    const xml: string = await zip.files[name].async("string");
    const next = xml.replace(/\s[A-Za-z0-9_]+:link="[^"]*"/g, () => {
      removed++;
      return "";
    });
    if (next !== xml) zip.file(name, next);
  }
  if (removed === 0) return { bytes, removed };
  return { bytes: new Uint8Array(await zip.generateAsync({ type: "uint8array" })), removed };
}

/**
 * Covers personal numbers block by block. Text inside a block (with its inline
 * tags) is the block's text; a block whose text holds a number is replaced by
 * its masked plain text. Pure over sanitised HTML (the tag set is small and
 * well-formed after sanitize-html).
 */
export function coverHtmlBlocks(html: string): { html: string; count: number; kinds: PersonalKind[] } {
  const tokens = html.split(/(<[^>]+>)/g).filter((t) => t !== "");
  type Open = { tag: string; start: number; text: string; inner: number };
  const stack: Open[] = [];
  const replacements: Array<{ from: number; to: number; text: string }> = [];
  let count = 0;
  const kinds: PersonalKind[] = [];
  tokens.forEach((tok, i) => {
    const m = tok.match(/^<(\/?)([a-z0-9]+)\b[^>]*?(\/?)>$/i);
    if (m) {
      const closing = m[1] === "/";
      const tag = m[2].toLowerCase();
      if (!BLOCKS.has(tag)) return;
      if (!closing && m[3] !== "/") {
        stack.push({ tag, start: i, text: "", inner: 0 });
      } else if (closing) {
        const idx = stack.map((s) => s.tag).lastIndexOf(tag);
        if (idx < 0) return;
        const open = stack.splice(idx, 1)[0];
        if (open.inner === 0) {
          const text = decodeXmlText(open.text);
          const found = findPersonalNumbers([text]);
          if (found.length > 0) {
            count += found.length;
            kinds.push(...found.map((f) => f.kind));
            replacements.push({ from: open.start + 1, to: i - 1, text: escapeHtml(applyMasks([text], found)[0]) });
          }
        }
        if (stack.length) stack[stack.length - 1].inner += 1;
      }
      return;
    }
    if (tok.startsWith("<")) return; // inline tag (strong, em, br, img …)
    if (stack.length) stack[stack.length - 1].text += tok;
  });
  if (replacements.length === 0) return { html, count, kinds };
  const out = tokens.slice();
  for (const r of replacements.sort((a, b) => b.from - a.from)) {
    out.splice(r.from, Math.max(0, r.to - r.from + 1), r.text);
  }
  return { html: out.join(""), count, kinds };
}

export function htmlToText(html: string): string {
  return decodeXmlText(
    html
      .replace(/<\/(p|h[1-6]|li|tr|blockquote|table)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(td|th)>/gi, " | ")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").replace(/(\s\|\s*)+$/, "").trim())
    .filter(Boolean)
    .join("\n");
}

export async function docxToSafeHtml(input: Uint8Array): Promise<{ html: string; imagesLeftOut: number }> {
  const mammoth = await loadMammoth();
  const sanitize = await loadSanitizeHtml();
  const { bytes } = await stripLinkedPictures(input);
  let budget = DOCX_IMAGE_BUDGET;
  let leftOut = 0;
  const convertImage = mammoth.images.imgElement(async (image: any) => {
    const type = String(image.contentType ?? "").toLowerCase();
    if (!IMAGE_TYPES.has(type)) {
      leftOut++;
      return { src: "", alt: LEFT_OUT };
    }
    try {
      const b64: string = await image.read("base64");
      const size = Math.floor((b64.length * 3) / 4);
      if (size > budget) {
        leftOut++;
        return { src: "", alt: LEFT_OUT };
      }
      budget -= size;
      return { src: `data:${type};base64,${b64}` };
    } catch {
      leftOut++;
      return { src: "", alt: LEFT_OUT };
    }
  });
  let raw: string;
  try {
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) }, { convertImage, includeDefaultStyleMap: true });
    raw = String(result.value ?? "");
  } catch (err: any) {
    throw new ChildJobError("unreadable", `the Word file couldn't be read: ${String(err?.message ?? err).slice(0, 150)}`);
  }
  // Pictures we refused become a plain marker before sanitising.
  const marked = raw.replace(/<img\b[^>]*>/gi, (tag) => (/\ssrc="data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+"/i.test(tag) ? tag : LEFT_OUT));
  const html: string = sanitize(marked, {
    allowedTags: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "u", "s", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "br", "blockquote", "img"],
    allowedAttributes: { img: ["src", "alt"] },
    allowedSchemes: [],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    exclusiveFilter: (frame: any) => frame.tag === "img" && !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(String(frame.attribs?.src ?? "")),
  });
  return { html, imagesLeftOut: leftOut };
}

export async function prepareDocx(bytes: Uint8Array, outDir: string): Promise<PrepareResult> {
  const t0 = performance.now();
  checkZip(bytes);
  await fs.mkdir(outDir, { recursive: true });
  const JSZip: any = await loadJszip();
  const zip = await JSZip.loadAsync(bytes);
  const parts: Array<{ name: string; text: string }> = [];
  for (const n of Object.keys(zip.files)) {
    if (zip.files[n].dir || !/\.(xml|rels|vml)$/i.test(n)) continue;
    parts.push({ name: n, text: await zip.files[n].async("string") });
  }
  const officeScan = scanOfficeParts(parts);
  const { html } = await docxToSafeHtml(bytes);
  const covered = coverHtmlBlocks(html);
  await fs.writeFile(path.join(outDir, "doc.html"), covered.html);
  const text = htmlToText(covered.html).slice(0, 200_000);
  return {
    kind: "html",
    personal: { count: covered.count, kinds: personalKinds(covered.kinds.map((k) => ({ kind: k }))), pages: covered.count ? [1] : [] },
    officeScan,
    pageTexts: [{ page: 1, label: "Document", text }],
    rendered: [],
    ms: Math.round(performance.now() - t0),
  };
}

/** PowerPoint, .doc, .ppt, .txt, .md: plain text, covered line by line. */
export async function prepareText(bytes: Uint8Array, ext: string, storedText: string | null | undefined, outDir: string): Promise<PrepareResult> {
  const t0 = performance.now();
  await fs.mkdir(outDir, { recursive: true });
  let officeScan: PrepareResult["officeScan"];
  if (ext === ".pptx") {
    checkZip(bytes);
    const JSZip: any = await loadJszip();
    const zip = await JSZip.loadAsync(bytes);
    const parts: Array<{ name: string; text: string }> = [];
    for (const n of Object.keys(zip.files)) {
      if (zip.files[n].dir || !/\.(xml|rels|vml)$/i.test(n)) continue;
      parts.push({ name: n, text: await zip.files[n].async("string") });
    }
    officeScan = scanOfficeParts(parts);
  }
  let text = "";
  if (ext === ".txt" || ext === ".md") text = new TextDecoder("utf-8").decode(bytes);
  else text = String(storedText ?? "");
  if (!text.trim()) {
    if (ext === ".pptx" || ext === ".doc" || ext === ".ppt") {
      try {
        const m: any = await import("officeparser");
        const parse = m.parseOfficeAsync ?? m.default?.parseOfficeAsync;
        text = String(await parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)) ?? "");
      } catch {
        throw new ChildJobError("unreadable", "the file's text couldn't be read");
      }
    }
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const matches = findPersonalNumbers(lines);
  const covered = applyMasks(lines, matches).join("\n").slice(0, 2_000_000);
  await fs.writeFile(path.join(outDir, "text.txt"), covered);
  return {
    kind: "text",
    personal: { count: matches.length, kinds: personalKinds(matches), pages: matches.length ? [1] : [] },
    ...(officeScan ? { officeScan } : {}),
    pageTexts: [{ page: 1, label: "Document", text: covered.slice(0, 200_000) }],
    rendered: [],
    ms: Math.round(performance.now() - t0),
  };
}
