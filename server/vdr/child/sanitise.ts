/**
 * The served copy of a PDF (vdr spec V7, §9.5 step 2): what buyers get,
 * rewritten with pdf-lib so nothing the eye can't see goes with it.
 *
 *  - Removed from the catalog: the document information dictionary, XMP
 *    metadata, /Names (embedded files, document JavaScript), /OpenAction,
 *    /AA, /Outlines, associated files (/AF), page labels, threads, …
 *  - Removed from every page: /AA, /AF, metadata, and every annotation
 *    EXCEPT form widgets (comments, sticky notes, stamps, file attachments,
 *    links). Widgets keep their filled-in values; their actions are removed.
 *  - XFA is removed from the AcroForm (the static form is what we show).
 *  - Then every object nothing points at any more is dropped, so the bytes
 *    of what was removed (an attachment, the old title, a script) are not in
 *    the file at all.
 * An encrypted PDF pdf-lib can't rewrite → null (the caller renders the
 * original with no annotations and never offers it as a download).
 */
import { loadPdfLib } from "./libs";

const CATALOG_DROP = [
  "Names", "OpenAction", "AA", "Outlines", "Metadata", "PageLabels", "Threads", "SpiderInfo", "URI", "PieceInfo",
  "Collection", "Perms", "Legal", "AF", "Dests", "StructTreeRoot", "MarkInfo", "Requirements",
];
const PAGE_DROP = ["AA", "AF", "Metadata", "PieceInfo", "Thumb", "B"];

export type SanitiseResult = { bytes: Uint8Array; strippedAnnotations: number; widgets: number };

export async function sanitisePdf(input: Uint8Array): Promise<SanitiseResult | null> {
  const lib = await loadPdfLib();
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream } = lib;
  let doc;
  try {
    doc = await PDFDocument.load(input, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: false });
  } catch {
    return null; // encrypted (owner password) or something pdf-lib can't parse
  }
  const ctx = doc.context;
  const cat = doc.catalog;
  for (const k of CATALOG_DROP) cat.delete(PDFName.of(k));
  const acro = cat.lookup(PDFName.of("AcroForm"));
  if (acro instanceof PDFDict) {
    acro.delete(PDFName.of("XFA"));
    acro.delete(PDFName.of("AA"));
  }
  let stripped = 0;
  let widgets = 0;
  for (const page of doc.getPages()) {
    const node = page.node;
    for (const k of PAGE_DROP) node.delete(PDFName.of(k));
    const annots = node.Annots();
    if (!annots) continue;
    const keep: unknown[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const a = annots.lookupMaybe(i, PDFDict);
      const subtype = a?.lookup(PDFName.of("Subtype"));
      if (a && subtype && subtype.toString() === "/Widget") {
        a.delete(PDFName.of("A"));
        a.delete(PDFName.of("AA"));
        keep.push(raw);
        widgets++;
      } else {
        stripped++;
      }
    }
    if (keep.length > 0) node.set(PDFName.of("Annots"), ctx.obj(keep as any));
    else node.delete(PDFName.of("Annots"));
  }
  ctx.trailerInfo.Info = undefined;

  // Drop every object nothing reachable from the catalog points at.
  const reach = new Set<string>();
  const walk = (o: unknown, depth: number) => {
    if (depth > 2000 || o == null) return;
    if (o instanceof PDFRef) {
      if (reach.has(o.tag)) return;
      reach.add(o.tag);
      walk(ctx.lookup(o), depth + 1);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) walk(v, depth + 1);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) walk(o.get(i), depth + 1);
    } else if (o instanceof PDFStream) {
      walk(o.dict, depth + 1);
    }
  };
  walk(ctx.trailerInfo.Root, 0);
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reach.has(ref.tag)) ctx.delete(ref);
  }
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false, addDefaultPage: false });
  return { bytes, strippedAnnotations: stripped, widgets };
}
