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
import { isTogetherSitting } from "../together/transcript";
import { extractTextWithPages, isPdfSource, UnreadableFormatError } from "./parser";
import { newDocumentFileName, resolveDocumentPath } from "./document-path";
import {
  extractDocumentData,
  extractionChecklist,
  extractionRetryDelays,
  extractWithRetries,
  mergeExtractedData,
  readFoundNothing,
  SCANNED_REASON,
  unreadableExtraction,
  type ExtractedDocumentData,
  type MergeSource,
  type TextLayout,
} from "./extractor";
import { releaseRequirementsFor } from "./requirements";
import { recordFactSpeakers } from "../interview/fact-guards";
import {
  addPrivateNote,
  isSourceKind,
  privateNoteTextsFromSource,
  removePrivateNoteWordings,
  sourceRowLookup,
  SOURCE_META_KEYS,
  type SourceKind,
} from "../interview/info-merger";
import type { Document, DocumentSourceMeta } from "@shared/schema";
import { isHousekeepingNote, noteRecordedAsFact } from "@shared/private-notes";
import { withDealFactsLock } from "./facts-lock";
import { normalisePeriod, stampSourceDetails, type MergeConflict, type MergeContext } from "./merge-policy";
import { applyRosterCounts, recordMergeConflicts, settleMergeRowsQuietly } from "./merge-conflicts";
import { scheduleNotesReview } from "./private-notes-review";
import { reconcileMirroredFacts } from "../information/deal-mirror";
import { setBrokerFact } from "../information/facts";

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

/** Absolute path of a row's file under the uploads volume, or null (see document-path.ts). */
export { resolveDocumentPath };

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
      filename = newDocumentFileName("src", path.extname(abs));
      fs.copyFileSync(abs, path.join(docsDir, filename));
    }
    try { fileSize = fs.statSync(path.join(docsDir, filename)).size; } catch { /* size is optional */ }
  } else if (typeof input.text === "string" && input.text.trim()) {
    filename = newDocumentFileName("src", ".txt", safeStem(input.title));
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
 * `facts` is the same source's extraction: a note that only repeats a
 * business fact the source also recorded (a dividend, a personal guarantee
 * of company debt — noteRecordedAsFact) is the fact filed twice, not a note.
 */
export function addPrivateNotes(
  info: Record<string, unknown>,
  raw: unknown,
  doc: Pick<Document, "id" | "name" | "sourceKind" | "visibility">,
  facts?: Record<string, unknown>,
): void {
  const list = Array.isArray(raw) ? raw.map((x) => String(x ?? "")) : typeof raw === "string" ? raw.split("\n") : [];
  const brokerOnly = isBrokerOnly(doc);
  // At most 10 from one extraction; notes already on file (a reprocess re-adding them) all stay.
  const lines = Array.from(new Set(list.map((n) => n.trim()).filter(Boolean))).slice(0, Array.isArray(raw) ? undefined : 10);
  // A note already on file (an earlier version of the same CRM note, another
  // email) gains this source too — so retiring or deleting that other source
  // leaves the note in place while this one still states it.
  for (const note of lines) {
    if (facts && noteRecordedAsFact(note, facts)) continue;
    addPrivateNote(info, note, { reason: `From ${doc.name}`, documentId: doc.id, ...(brokerOnly ? { brokerOnly: true } : {}) });
  }
}

/**
 * A re-read source's private notes (reprocess; mutates): what it says now,
 * plus every note it stated before that the fresh run simply didn't repeat
 * — a model run is not a correction, and the note may be the broker's only
 * record of it. An earlier note goes only when this source now records it
 * as a business fact (a dividend, a guarantee an older prompt filed as
 * private), or when it is no note at all ("NDA in place", a sample label).
 * The earlier wordings stay exactly where they are — taking them out and
 * adding them back re-folded the notes in another order and split some on
 * every reprocess — and new wordings fold into the note they restate.
 */
export function refreshSourceNotes(
  info: Record<string, unknown>,
  doc: Pick<Document, "id" | "name" | "sourceKind" | "visibility">,
  data: Record<string, unknown>,
): void {
  const earlier = privateNoteTextsFromSource(info, doc.id);
  removePrivateNoteWordings(info, doc.id, earlier.filter((t) => noteRecordedAsFact(t, data) || isHousekeepingNote(t)));
  addPrivateNotes(info, data._privateNotes, doc, data);
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
  /** "busy": the source was already being read — nothing was started. */
  status: "extracted" | "failed" | "missing" | "busy";
  /** Keys this source newly asserted or replaced on the deal. */
  fieldsWritten: string[];
}

/**
 * The row's sourceMeta after a read (pure): the fiscal period end
 * remembered; a failed read says why (`readFailed`, `retryable` when
 * reading it again may work — an outage, not a scanned image); a read that
 * worked clears that and says whether only part of a long source was read
 * (`partialRead`). Null when there's nothing to keep.
 */
export function sourceMetaAfterRead(
  doc: Pick<Document, "sourceMeta">,
  extracted: ExtractedDocumentData,
  failed: boolean,
  at: string = new Date().toISOString(),
): DocumentSourceMeta | null {
  const meta: DocumentSourceMeta = { ...(((doc.sourceMeta as DocumentSourceMeta | null) ?? {}) as DocumentSourceMeta) };
  if (failed) {
    meta.readFailed = {
      at,
      reason: typeof extracted._failureReason === "string" ? extracted._failureReason : "the extraction returned nothing usable",
      ...(extracted._failure === "transient" ? { retryable: true } : {}),
    };
  } else {
    Object.assign(meta, rememberPeriodEnd(doc, extracted).sourceMeta ?? {});
    delete meta.readFailed;
    const partial = extracted._partialRead as unknown as Omit<NonNullable<DocumentSourceMeta["partialRead"]>, "at"> | undefined;
    if (partial && typeof partial === "object") meta.partialRead = { ...partial, at };
    else delete meta.partialRead;
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

/** Sources being read by this server process right now (a row stuck "parsing" that isn't here was interrupted). */
const activeReads = new Set<string>();

/** True while this server is reading the source (its first read, or a read started again). */
export function isBeingRead(documentId: string): boolean {
  return activeReads.has(documentId);
}

/** A row left "reading" this long, by no live read, was interrupted (a redeploy mid-read). */
export const STUCK_READ_MS = 30 * 60_000;

/** True when a row still says it is being read but no read is running (pure). */
export function isInterruptedRead(
  doc: Pick<Document, "id" | "status" | "updatedAt">,
  now: number = Date.now(),
  active: ReadonlySet<string> = activeReads,
): boolean {
  if (doc.status !== "pending" && doc.status !== "parsing") return false;
  if (active.has(doc.id)) return false;
  return now - new Date(doc.updatedAt).getTime() > STUCK_READ_MS;
}

/** What an interrupted read tells the broker. */
export const INTERRUPTED_READ_REASON = "Cimple was restarted while it was reading this source";

/**
 * On startup: every source left "reading" by a server that stopped mid-read
 * (a redeploy sends SIGTERM and the process exits within seconds) is marked
 * failed with why, so the Information tab stops polling forever and offers
 * "Read it again". Only rows untouched for STUCK_READ_MS — another live
 * instance's fresh read is never taken for a stuck one.
 */
export async function recoverInterruptedReads(): Promise<number> {
  const { db } = await import("../db");
  const { documents } = await import("@shared/schema");
  const { inArray } = await import("drizzle-orm");
  const rows = await db.select().from(documents).where(inArray(documents.status, ["pending", "parsing"]));
  let n = 0;
  for (const d of rows) {
    if (!isInterruptedRead(d)) continue;
    const meta = { ...(((d.sourceMeta as DocumentSourceMeta | null) ?? {}) as DocumentSourceMeta), readFailed: { at: new Date().toISOString(), reason: INTERRUPTED_READ_REASON, retryable: true } };
    await storage.updateDocument(d.id, { status: "failed", sourceMeta: meta } as any).catch(() => undefined);
    n++;
  }
  if (n > 0) console.warn(`[ingest] ${n} source(s) were left mid-read by a restart — marked "couldn't read" (they can be read again)`);
  return n;
}

/**
 * Runs recoverInterruptedReads at startup, and once more when a read cut off
 * just before the restart has been untouched long enough to count as stuck.
 */
export function startInterruptedReadRecovery(): void {
  const run = () => recoverInterruptedReads().catch((err) => console.error("[ingest] interrupted-read recovery failed:", err));
  void run();
  const later = setTimeout(run, STUCK_READ_MS + 60_000);
  later.unref?.();
}

/** Why a file couldn't be opened, in plain words (a format Cimple can't read, a damaged or locked file). */
export function parseProblem(err: unknown): string {
  if (err instanceof UnreadableFormatError) return err.message;
  return "the file couldn't be opened — it may be damaged or password-protected; save it again (or as a PDF) and upload that";
}

/** Why a source with neither its file nor its text on the server can't be read. */
export const NO_COPY_REASON = "there is no copy of its file or text left on the server — upload it again";

/** While a source is being read, its row is touched this often (a long read is never taken for a stopped one). */
export const READ_HEARTBEAT_MS = 5 * 60_000;

/**
 * Keeps a row's "last changed" fresh while it is being read. A long source
 * read in parts (each with its own retries) can run past STUCK_READ_MS; the
 * Information tab and the startup recovery would then call it stopped and
 * offer a second, concurrent read. Returns the stop function.
 */
export function startReadHeartbeat(
  documentId: string,
  touch: (id: string) => Promise<unknown> = (id) => storage.updateDocument(id, {} as any),
  every: number = READ_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    touch(documentId).catch(() => undefined);
  }, every);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * (Re)ingests an existing documents row: parse the file (falling back to the
 * stored text), extract with the kind-aware prompt, merge into the deal with
 * provenance. The deal is re-read immediately before the write so an
 * interview turn or another upload finishing meanwhile is never clobbered.
 * A dropped connection or an overloaded API is retried with growing waits
 * (extractWithRetries, as a re-read is); a read that still fails, or finds
 * nothing to read, says why on the row — and a source with no readable text
 * (a scanned image, a .doc file) no longer counts as the checklist document
 * it was uploaded for, so the seller is asked for a readable copy.
 */
export async function ingestDocument(documentId: string): Promise<IngestResult> {
  const doc = await storage.getDocument(documentId);
  if (!doc) return { status: "missing", fieldsWritten: [] };
  // 1. An "Interview together" transcript is filed live, answer by answer,
  // through the interview's guards — it is never read again from its text
  // (specs/together.md §5.8; hook order: INTEGRATION §2.17).
  if (isTogetherSitting(doc)) return { status: "extracted", fieldsWritten: [] };
  const kind = documentKind(doc);
  // Already being read (a second "parse" while the first read runs): one read at a time.
  if (activeReads.has(doc.id)) return { status: "busy", fieldsWritten: [] };
  activeReads.add(doc.id);
  const stopHeartbeat = startReadHeartbeat(doc.id);
  try {
    await storage.updateDocument(doc.id, { status: "parsing" } as any);
    let text = "";
    // How the text was laid out (a PDF's pages) — tells a scan from a readable file.
    let layout: TextLayout = { pdf: isPdfSource(doc) };
    let problem: string | null = null;
    const filePath = resolveDocumentPath(doc);
    if (filePath && fs.existsSync(filePath)) {
      try {
        const parsed = await extractTextWithPages(filePath, doc.mimeType);
        text = parsed.text;
        layout = { pages: parsed.pages, pageTexts: parsed.pageTexts, pdf: parsed.pdf };
      } catch (err) {
        console.error(`[ingest] couldn't open doc ${doc.id}:`, (err as Error)?.message ?? err);
        problem = parseProblem(err);
      }
    }
    if (!text && doc.extractedText) text = doc.extractedText;

    const dealForChecklist = await storage.getDeal(doc.dealId);
    const extracted: ExtractedDocumentData = problem && !text
      ? unreadableExtraction(text, kind, problem)
      : (await extractWithRetries(
          () => extractDocumentData(text, doc.category || "other", doc.subcategory, kind, {
            checklist: dealForChecklist ? extractionChecklist(dealForChecklist) : undefined,
            ...layout,
          }),
          extractionRetryDelays(),
          (attempt, wait, why) => console.warn(`[ingest] read of doc ${doc.id} failed (${why}) — attempt ${attempt + 1} in ${Math.round(wait / 1000)}s`),
        )).data;
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
      sourceMeta: sourceMetaAfterRead(doc, extracted, failed),
    } as any);
    if (failed) {
      // Nothing readable in it: it is not the checklist document it was uploaded for.
      if (extracted._failure === "unreadable" && !hadExtraction) {
        await releaseRequirementsFor(doc.dealId, doc.id, {
          fileName: doc.originalName || doc.name,
          reason: typeof extracted._failureReason === "string" ? extracted._failureReason : "it has no readable text",
        });
      }
      return { status: "failed", fieldsWritten: [] };
    }
    // Read, but nothing about the business came out of a text this thin (a
    // scan with a typed cover page): it is not yet the checklist document it
    // was uploaded for — the row asks for a readable copy again.
    if (kind === "document" && !hadExtraction && readFoundNothing(extracted, text, layout)) {
      await releaseRequirementsFor(doc.dealId, doc.id, { fileName: doc.originalName || doc.name, reason: SCANNED_REASON });
    }
    return await mergeExtractionIntoDeal(doc, extracted);
  } catch (err) {
    console.error(`[ingest] failed for doc ${documentId}:`, err);
    const meta = { ...(((doc.sourceMeta as DocumentSourceMeta | null) ?? {}) as DocumentSourceMeta), readFailed: { at: new Date().toISOString(), reason: "something went wrong while reading it", retryable: true } };
    await storage.updateDocument(documentId, { status: "failed", sourceMeta: meta } as any).catch(() => {});
    return { status: "failed", fieldsWritten: [] };
  } finally {
    stopHeartbeat();
    activeReads.delete(doc.id);
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
  let gone = false;
  const result = await withDealFactsLock(doc.dealId, async () => {
    // The source was deleted while it was being read (the broker's Delete on
    // a "Reading…" source, a seller replacing an upload): its facts must not
    // land — nothing could ever take them off again.
    if (!(await storage.getDocument(doc.id))) {
      gone = true;
      return { status: "missing" as const, fieldsWritten: [] };
    }
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
    recordFactSpeakers(merged, extracted._speakers, doc.id); // who said it, on calls
    // Head counts by role: the roster is the authority (decision A), across facts.
    applyRosterCounts(merged, documents);
    // A note that only repeats a business fact this source recorded is not a note.
    addPrivateNotes(merged, extracted._privateNotes, doc, extracted as Record<string, unknown>);
    // The deal's own name, industry and listed price stay the broker's facts
    // (deal-mirror.ts) — a CRM note's or a tax return's wording is another value.
    const { columnPatch } = reconcileMirroredFacts(deal, merged, setBrokerFact);
    const fieldsWritten = Object.keys(merged).filter(
      (k) => !k.startsWith("_") && JSON.stringify(merged[k]) !== JSON.stringify(before[k]),
    );
    await storage.updateDeal(doc.dealId, { extractedInfo: merged, ...columnPatch } as any);
    saved = merged;
    return { status: "extracted" as const, fieldsWritten };
  });
  if (gone) {
    console.log(`[ingest] doc ${doc.id} was deleted while it was being read — its facts were not merged`);
    return result;
  }
  // Material conflicts still standing after the merge become discrepancies (deduplicated).
  await recordMergeConflicts(doc.dealId, conflicts, documents, saved).catch((err) =>
    console.error(`[ingest] recording merge conflicts failed for doc ${doc.id}:`, err));
  // Earlier merge rows this source settled (its figure agrees now, or it
  // restates a value another row already disputes) stop standing.
  await settleMergeRowsQuietly(doc.dealId, "ingest");
  // New private notes are consolidated with the deal's others shortly after
  // (several sources finishing together → one review).
  if (extracted._privateNotes) scheduleNotesReview(doc.dealId);
  return result;
}
