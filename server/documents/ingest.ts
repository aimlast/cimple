/**
 * ingest.ts — one pipeline for every source of information about a deal.
 *
 * A "source" is a documents row of any kind: an uploaded document, an email,
 * a phone/in-person call transcript, a video-call transcript, a CRM note, a
 * website page or a social-media post (documents.sourceKind). Each is parsed
 * (files) or taken as text, read by the supporting model with a prompt that
 * knows what kind of source it is (who is speaking, what counts as a fact),
 * and merged into deals.extractedInfo with provenance
 * {source: kind, documentId, at} — see mergeExtractedData / SOURCE_RANK.
 *
 *   createAndIngestSource({...})  → creates the row, then ingests it
 *   ingestDocument(documentId)    → (re)ingests an existing row
 *
 * Used by the upload route, the Information tab's "Add source", and other
 * workstreams (CRM seller sync, demo seeding).
 */
import fs from "fs";
import path from "path";
import { storage } from "../storage";
import { extractTextFromFile } from "./parser";
import { extractDocumentData, mergeExtractedData, type ExtractedDocumentData, type MergeSource } from "./extractor";
import { addPrivateNote, isSourceKind, sourceRowLookup, SOURCE_META_KEYS, type SourceKind } from "../interview/info-merger";
import type { Document, DocumentSourceMeta } from "@shared/schema";
import { withDealFactsLock } from "./facts-lock";
import { normalisePeriod, stampSourceDetails, type MergeConflict, type MergeContext } from "./merge-policy";
import { recordMergeConflicts } from "./merge-conflicts";

export type SourceVisibility = "shared" | "broker_only";

const uploadsDir = () => process.env.UPLOADS_DIR || path.join(process.cwd(), "public", "uploads");

/** Parser category for a kind when the caller doesn't pick one. */
export function defaultCategoryForKind(kind: SourceKind): string {
  switch (kind) {
    case "call":
    case "video_call":
      return "transcripts";
    case "website":
    case "social":
      return "marketing";
    default:
      return "other";
  }
}

/** Kinds whose rows are broker-private unless the caller says otherwise. */
export function defaultVisibilityForKind(kind: SourceKind): SourceVisibility {
  return kind === "crm" ? "broker_only" : "shared";
}

/** documents.sourceKind as a SourceKind (legacy rows → "document"). */
export function documentKind(doc: Pick<Document, "sourceKind">): SourceKind {
  return isSourceKind(doc.sourceKind) ? doc.sourceKind : "document";
}

export function isBrokerOnly(doc: Pick<Document, "visibility">): boolean {
  return doc.visibility === "broker_only";
}

/** Only the documented metadata keys, as trimmed strings (durationMin a number). */
export function cleanSourceMeta(raw: unknown): DocumentSourceMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: DocumentSourceMeta = {};
  for (const key of ["from", "to", "subject", "date", "participants", "url", "platform", "provider", "recordType", "recordId", "periodEnd"] as const) {
    const v = r[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim().slice(0, 500);
    else if (typeof v === "number") out[key] = String(v);
  }
  const d = Number(r.durationMin);
  if (Number.isFinite(d) && d > 0) out.durationMin = Math.round(d);
  return Object.keys(out).length > 0 ? out : null;
}

/** Absolute path of a row's file under the uploads volume, or null. */
export function resolveDocumentPath(doc: Pick<Document, "fileUrl">): string | null {
  const relative = (doc.fileUrl || "").replace(/^\/uploads\//, "");
  if (!relative || relative.includes("..")) return null;
  return path.join(uploadsDir(), relative);
}

function safeStem(title: string): string {
  return title.replace(/[^a-zA-Z0-9-_ ]/g, " ").replace(/\s+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "source";
}

export interface CreateSourceInput {
  dealId: string;
  kind: SourceKind;
  /** Display title ("Email from Dr. Patel — Mar 3", "Discovery call"). */
  title: string;
  /** Pasted text — stored as a .txt file so it can be opened like any upload. */
  text?: string;
  /** A file already on disk (e.g. a multer upload). Copied under uploads/docs when outside it. */
  filePath?: string;
  originalName?: string;
  mimeType?: string;
  meta?: DocumentSourceMeta | null;
  visibility?: SourceVisibility;
  uploadedBy?: string;
  /** Parser category (financials, legal, …). Defaults from the kind. */
  category?: string;
  subcategory?: string | null;
  /** true: return right after the row exists and ingest in the background. */
  background?: boolean;
}

/**
 * Creates a documents row for a source and ingests it. Awaits the extraction
 * unless `background` is set; either way the returned row is the created one
 * (re-read after ingestion when awaited, so status reflects the result).
 */
export async function createAndIngestSource(input: CreateSourceInput): Promise<Document> {
  const kind: SourceKind = isSourceKind(input.kind) ? input.kind : "document";
  const docsDir = path.join(uploadsDir(), "docs");
  fs.mkdirSync(docsDir, { recursive: true });

  let filename: string;
  let fileSize: number | undefined;
  let mimeType = input.mimeType ?? null;
  if (input.filePath) {
    const abs = path.resolve(input.filePath);
    if (path.dirname(abs) === path.resolve(docsDir)) {
      filename = path.basename(abs);
    } else {
      filename = `src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${path.extname(abs)}`;
      fs.copyFileSync(abs, path.join(docsDir, filename));
    }
    try { fileSize = fs.statSync(path.join(docsDir, filename)).size; } catch { /* size is optional */ }
  } else if (typeof input.text === "string" && input.text.trim()) {
    filename = `src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeStem(input.title)}.txt`;
    fs.writeFileSync(path.join(docsDir, filename), input.text, "utf-8");
    fileSize = Buffer.byteLength(input.text, "utf-8");
    mimeType = "text/plain";
  } else {
    throw new Error("A source needs text or a file");
  }

  const title = (input.title || input.originalName || "Untitled source").trim().slice(0, 200);
  const doc = await storage.createDocument({
    dealId: input.dealId,
    uploadedBy: input.uploadedBy ?? "broker",
    name: title,
    originalName: (input.originalName || title).slice(0, 200),
    category: input.category || defaultCategoryForKind(kind),
    subcategory: input.subcategory ?? null,
    fileUrl: `/uploads/docs/${filename}`,
    fileSize: fileSize ?? null,
    mimeType,
    status: "pending",
    sourceKind: kind,
    sourceMeta: cleanSourceMeta(input.meta) ?? null,
    visibility: input.visibility ?? defaultVisibilityForKind(kind),
  } as any);

  if (input.background) {
    ingestDocument(doc.id).catch((err) => console.error(`[ingest] background ingest failed for ${doc.id}:`, err));
    return doc;
  }
  await ingestDocument(doc.id);
  return (await storage.getDocument(doc.id)) ?? doc;
}

/**
 * What of a source's extraction may become deal-level facts. Every source's
 * own summary / key facts / red flags / seller concerns / action items /
 * call notes describe that source (or the broker's to-dos), not the
 * business: they stay on the source row (documents.extractedData, shown in
 * the Sources panel) and never become deal-level keys that the CIM writer or
 * the interview agent would read as facts.
 */
export function mergeableExtraction(_doc: Pick<Document, "visibility">, data: ExtractedDocumentData): ExtractedDocumentData {
  return Object.fromEntries(Object.entries(data).filter(([k]) => !SOURCE_META_KEYS.has(k))) as ExtractedDocumentData;
}

/**
 * Sensitive personal matters the extractor kept out of the business fields
 * (health, family…) join the deal's broker-private notes — shown to the
 * broker on the Interview tab and excluded from every CIM path ("_" keys).
 * Each note carries its source's documentId (deleting the source removes
 * it) and, for a broker-only source, `brokerOnly: true`: those are the
 * broker's own notes and never reach the interview agent at all.
 */
export function addPrivateNotes(
  info: Record<string, unknown>,
  raw: unknown,
  doc: Pick<Document, "id" | "name" | "sourceKind" | "visibility">,
): void {
  if (typeof raw !== "string" || !raw.trim()) return;
  const brokerOnly = isBrokerOnly(doc);
  const lines = Array.from(new Set(raw.split("\n").map((n) => n.trim()).filter(Boolean))).slice(0, 10);
  // A note already on file (an earlier version of the same CRM note, another
  // email) gains this source too — so retiring or deleting that other source
  // leaves the note in place while this one still states it.
  for (const note of lines) {
    addPrivateNote(info, note, { reason: `From ${doc.name}`, documentId: doc.id, ...(brokerOnly ? { brokerOnly: true } : {}) });
  }
}

// The per-deal facts queue lives in its own module so broker edits and the
// interview turn (which can't import this pipeline) share it.
export { withDealFactsLock };

/**
 * Who asserted a source's extraction, for mergeExtractedData: the row, its
 * kind, its title (a dedicated source — the org chart, the lease — outranks
 * passing mentions for its own facts), the fiscal period it reports (its
 * extraction's periodEnd, else the one remembered on the row), its own date
 * and whether it is broker-only. Ingestion and reprocess use the same one,
 * so both decide every fact the same way.
 */
export function mergeSourceFor(
  doc: Pick<Document, "id" | "name" | "sourceKind" | "visibility" | "sourceMeta" | "createdAt" | "subcategory">,
  extracted?: ExtractedDocumentData | null,
): MergeSource {
  const meta = (doc.sourceMeta as DocumentSourceMeta | null) ?? null;
  const period = normalisePeriod(extracted?._periodEnd) ?? normalisePeriod(meta?.periodEnd);
  const dated = normalisePeriod(meta?.date) ?? normalisePeriod(doc.createdAt ? new Date(doc.createdAt).toISOString() : undefined);
  return {
    documentId: doc.id,
    source: documentKind(doc),
    title: [doc.name, doc.subcategory].filter(Boolean).join(" · "),
    ...(period ? { period } : {}),
    ...(dated ? { dated } : {}),
    brokerOnly: isBrokerOnly(doc),
  };
}

/** The row's sourceMeta with the extraction's fiscal period end remembered (a documents patch), or {}. */
export function rememberPeriodEnd(
  doc: Pick<Document, "sourceMeta">,
  extracted: ExtractedDocumentData | null | undefined,
): { sourceMeta?: DocumentSourceMeta } {
  const periodEnd = normalisePeriod(extracted?._periodEnd);
  const meta = (doc.sourceMeta as DocumentSourceMeta | null) ?? {};
  if (!periodEnd || meta.periodEnd === periodEnd) return {};
  return { sourceMeta: { ...meta, periodEnd } };
}

export interface IngestResult {
  status: "extracted" | "failed" | "missing";
  /** Keys this source newly asserted or replaced on the deal. */
  fieldsWritten: string[];
}

/**
 * (Re)ingests an existing documents row: parse the file (falling back to the
 * stored text), extract with the kind-aware prompt, merge into the deal with
 * provenance. The deal is re-read immediately before the write so an
 * interview turn or another upload finishing meanwhile is never clobbered.
 */
export async function ingestDocument(documentId: string): Promise<IngestResult> {
  const doc = await storage.getDocument(documentId);
  if (!doc) return { status: "missing", fieldsWritten: [] };
  const kind = documentKind(doc);
  try {
    await storage.updateDocument(doc.id, { status: "parsing" } as any);
    let text = "";
    const filePath = resolveDocumentPath(doc);
    if (filePath && fs.existsSync(filePath)) text = await extractTextFromFile(filePath, doc.mimeType);
    if (!text && doc.extractedText) text = doc.extractedText;

    const extracted: ExtractedDocumentData = await extractDocumentData(text, doc.category || "other", doc.subcategory, kind);
    const failed = extracted.summary === "Extraction failed" && Object.keys(extracted).every((k) => k.startsWith("_") || k === "summary");
    // A failed extraction (an API error, no credits) never replaces the
    // extraction on file — reprocess can still replay it.
    const hadExtraction = !!doc.extractedData && typeof doc.extractedData === "object" &&
      Object.keys(doc.extractedData as object).some((k) => !k.startsWith("_") && k !== "summary");
    await storage.updateDocument(doc.id, {
      status: failed ? (hadExtraction ? doc.status : "failed") : "extracted",
      extractedText: text,
      ...(failed && hadExtraction ? {} : { extractedData: extracted }),
      isProcessed: failed ? (hadExtraction ? doc.isProcessed : false) : true,
      ...(failed ? {} : rememberPeriodEnd(doc, extracted)),
    } as any);
    if (failed) return { status: "failed", fieldsWritten: [] };
    return await mergeExtractionIntoDeal(doc, extracted);
  } catch (err) {
    console.error(`[ingest] failed for doc ${documentId}:`, err);
    await storage.updateDocument(documentId, { status: "failed" } as any).catch(() => {});
    return { status: "failed", fieldsWritten: [] };
  }
}

/**
 * Merges one source row's extraction into its deal's facts with provenance
 * (the second half of ingestDocument; also used to replay a stored
 * extraction). Serialised per deal; material conflicts still standing after
 * the merge become discrepancies.
 */
export async function mergeExtractionIntoDeal(doc: Document, extracted: ExtractedDocumentData): Promise<IngestResult> {
  // Serialised per deal: several sources finishing at once (a CRM import
  // ingests a few in parallel) must not overwrite each other's facts.
  const conflicts: MergeConflict[] = [];
  let saved: Record<string, unknown> = {};
  const documents = await storage.getDocumentsByDeal(doc.dealId);
  const result = await withDealFactsLock(doc.dealId, async () => {
    const deal = await storage.getDeal(doc.dealId);
    if (!deal) return { status: "extracted" as const, fieldsWritten: [] };
    const before = (deal.extractedInfo as Record<string, unknown>) || {};
    const ctx: MergeContext = { conflicts, lookup: sourceRowLookup(documents) };
    // Every source entry carries its row's visibility (older entries too),
    // so the CIM writers and the deal list can tell broker-only years apart.
    const merged = stampSourceDetails(
      mergeExtractedData(before, mergeableExtraction(doc, extracted), mergeSourceFor(doc, extracted), ctx),
      documents,
    );
    addPrivateNotes(merged, extracted._privateNotes, doc);
    const fieldsWritten = Object.keys(merged).filter(
      (k) => !k.startsWith("_") && JSON.stringify(merged[k]) !== JSON.stringify(before[k]),
    );
    await storage.updateDeal(doc.dealId, { extractedInfo: merged } as any);
    saved = merged;
    return { status: "extracted" as const, fieldsWritten };
  });
  // Material conflicts still standing after the merge become discrepancies (deduplicated).
  await recordMergeConflicts(doc.dealId, conflicts, documents, saved).catch((err) =>
    console.error(`[ingest] recording merge conflicts failed for doc ${doc.id}:`, err));
  return result;
}
