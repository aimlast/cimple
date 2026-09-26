/**
 * reprocess.ts
 *
 * One-time backfill for deals whose documents were extracted BEFORE the
 * document merge path was canonicalised (see mergeExtractedData in
 * ./extractor.ts). Those deals have extractedInfo full of verbatim extractor
 * keys (revenue, licenses, keyPersonnel, …) that the coverage classifier and
 * the interview prompt cannot see.
 *
 * For a given deal this module:
 *   1. Re-runs full text extraction (new prompt with the canonical CIM
 *      vocabulary) per document — from the file on disk when present, else
 *      from the stored parsed text — so narrative fields (strengths,
 *      targetMarket, seasonality, …) get captured.
 *   2. Falls back to replaying the stored extractedData through the NEW
 *      canonicalising merge only when no fresh extraction was possible.
 *   3. Rebuilds deal.extractedInfo: documents merge into a fresh object
 *      first, then the deal's EXISTING values are laid over it
 *      (overlayExistingFacts) — the broker's and the seller's own values
 *      stay; each source row's contribution is replaced by its fresh read,
 *      keeping only what its text still states; a row whose read failed
 *      keeps what it had.
 *
 * The broker's endpoint runs it as a background job (reprocess-jobs.ts).
 */
import fs from "fs";
import path from "path";
import { storage } from "../storage";
import { extractTextFromFile } from "./parser";
import { extractDocumentData, extractionChecklist, mergeExtractedData, normaliseExtraction, type ExtractedDocumentData } from "./extractor";
import { groundedInSource, groundedValue, restates, SPOKEN_KINDS } from "./extraction-guard";
import { recordFactSpeakers } from "../interview/fact-guards";
import { KNOWN_EXTRACTED_FIELDS } from "../interview/knowledge-base";
import {
  canonicalFieldName,
  getFieldSources,
  getFieldAlternates,
  getFieldCorroborations,
  setFieldSource,
  mergeAlternateMaps,
  recordAlternate,
  noteSameValue,
  displaceCorroborations,
  isRowBackedSource,
  isUntrackedSource,
  addPrivateNote,
  repairCharIndexedValue,
  resolvedYearSources,
  summariseMapSource,
  sourceRowLookup,
  yearSource,
  typedNumericValues,
  FIELD_SOURCES_KEY,
  FIELD_ALTERNATES_KEY,
  FIELD_CORROBORATIONS_KEY,
  BROKER_SUPPRESSED_KEY,
  LEGACY_SOURCE_NOTE,
  SOURCE_META_KEYS,
  type FieldSource,
  type SourceKind,
} from "../interview/info-merger";
import { documentKind, mergeableExtraction, mergeSourceFor, refreshSourceNotes, rememberPeriodEnd } from "./ingest";
import { compactPrivateNotes } from "../interview/info-merger";
import { withDealFactsLock } from "./facts-lock";
import {
  cleanYearMap,
  effectiveRank,
  interimYears,
  interimKeyFor,
  isBrokerProcessKey,
  isSpecialistSource,
  isYearMapKey,
  mergeMapEntryInto,
  mergeScalarInto,
  mergeYearMapInto,
  noteConflict,
  outranksFor,
  periodForYear,
  receivablesMeasureKey,
  reconcileHeadlines,
  stampSourceDetails,
  yearMapKeyFor,
  yearSuffixedKey,
  type MergeConflict,
  type MergeContext,
  type SetAsideYear,
} from "./merge-policy";
import { fieldLabel as fieldLabelText } from "../interview/interview-plan";
import { recordMergeConflicts, settleMergeRowsQuietly } from "./merge-conflicts";
import { reviewPrivateNotes } from "./private-notes-review";
import { reconcileMirroredFacts } from "../information/deal-mirror";
import { setBrokerFact } from "../information/facts";

/** Where a running reprocess is (for the broker's progress display). */
export interface ReprocessProgress {
  phase: "reading" | "merging" | "saving";
  /** Sources read so far / to read. */
  done: number;
  total: number;
}

export interface ReprocessResult {
  documentsReprocessed: number;
  fieldsAfter: number;
  /** Sources whose fresh read failed (they keep what they had). */
  documentsKeptAsBefore: number;
  /** Values the sources no longer yield and their text does not state (removed). */
  removed: OverlayReport["dropped"];
  /** Values a source no longer yielded but still states word for word (kept). */
  keptFromText: OverlayReport["kept"];
}

export async function reprocessDealDocuments(
  dealId: string,
  onProgress?: (p: ReprocessProgress) => void,
): Promise<ReprocessResult> {
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error(`Deal ${dealId} not found`);

  const documents = await storage.getDocumentsByDeal(dealId);

  // Same resolution as parseDocumentAsync / /api/documents/:id/parse in
  // server/routes.ts: fileUrl is "/uploads/docs/<name>" relative to uploadsDir.
  const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), "public", "uploads");

  let docsMerged: Record<string, unknown> = {};
  let documentsReprocessed = 0;

  // One extraction per document. Prefers fresh re-extraction (from the file
  // on disk, else the stored parsed text) so the new canonical-vocabulary
  // prompt applies; falls back to the previously stored extraction ONLY when
  // no fresh extraction happened — replaying both would append near-duplicate
  // stale phrasing under every narrative field (merge appends on difference).
  const checklist = extractionChecklist(deal);
  /** The row's extraction, and the text when it was freshly re-read from it. */
  type Read = { data: ExtractedDocumentData | null; freshText: string | null };
  const extractForDoc = async (
    doc: (typeof documents)[number],
  ): Promise<Read> => {
    // A stored extraction replayed as-is still goes through the guard (and
    // the current structure): an SDE or EBITDA an older prompt computed must
    // not come back as a fact.
    const stored =
      doc.extractedData && typeof doc.extractedData === "object"
        ? normaliseExtraction(doc.extractedData as Record<string, unknown>, doc.extractedText ?? null, documentKind(doc))
        : null;

    let text: string | null = null;
    const relative = (doc.fileUrl || "").replace(/^\/uploads\//, "");
    const filePath = relative ? path.join(uploadsDir, relative) : null;
    if (filePath && fs.existsSync(filePath)) {
      try {
        text = await extractTextFromFile(filePath, doc.mimeType);
      } catch (err) {
        console.error(`[reprocess] parse failed for doc ${doc.id} (${doc.name}):`, err);
      }
    }
    // Parsed text is persisted on the row — lets the new prompt re-run even
    // when the file only exists on another machine's volume.
    if (!text && doc.extractedText) text = doc.extractedText;

    if (text) {
      try {
        let fresh = await extractDocumentData(text, doc.category || "other", doc.subcategory, documentKind(doc), { checklist });
        // A dropped connection or an overloaded API gives the failure stub:
        // one more try before the source falls back to what it had.
        if (fresh.summary === "Extraction failed") {
          await new Promise((r) => setTimeout(r, 3000));
          fresh = await extractDocumentData(text, doc.category || "other", doc.subcategory, documentKind(doc), { checklist });
        }
        // extractDocumentData never throws — API failures come back as a
        // stub ({_confidence:"low", summary:"Extraction failed"} or
        // {_documentType:"unreadable"}). A stub must not overwrite the
        // stored extraction or count as a fresh result.
        const substantiveKeys = Object.keys(fresh).filter(
          (k) => !k.startsWith("_") && !(k === "summary" && fresh.summary === "Extraction failed"),
        );
        if (substantiveKeys.length === 0) {
          console.error(`[reprocess] extraction returned no data for doc ${doc.id} (${doc.name}) — keeping stored extraction`);
        } else {
          await storage.updateDocument(doc.id, {
            status: "extracted",
            extractedText: text,
            extractedData: fresh,
            isProcessed: true,
            ...rememberPeriodEnd(doc, fresh),
          } as any);
          return { data: fresh, freshText: text };
        }
      } catch (err) {
        console.error(`[reprocess] re-extraction failed for doc ${doc.id} (${doc.name}) — falling back to stored extraction:`, err);
      }
    } else {
      console.log(`[reprocess] no file or stored text for doc ${doc.id} (${doc.name}) — replaying stored extraction only`);
    }
    return { data: stored, freshText: null };
  };

  // Claude calls run in bounded-parallel batches; merging happens afterwards
  // in stable document order so precedence stays deterministic.
  const BATCH_SIZE = 4;
  const results: { doc: (typeof documents)[number]; data: ExtractedDocumentData | null; freshText: string | null }[] = [];
  onProgress?.({ phase: "reading", done: 0, total: documents.length });
  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE);
    results.push(...(await Promise.all(batch.map(async (d) => ({ doc: d, ...(await extractForDoc(d)) })))));
    onProgress?.({ phase: "reading", done: results.length, total: documents.length });
  }
  onProgress?.({ phase: "merging", done: documents.length, total: documents.length });
  // Keys the broker deleted stay deleted — the merge skips them.
  const suppressed = (deal.extractedInfo as Record<string, unknown> | null)?.[BROKER_SUPPRESSED_KEY];
  if (Array.isArray(suppressed) && suppressed.length > 0) docsMerged[BROKER_SUPPRESSED_KEY] = suppressed;
  // Merged oldest upload first, like ingestion — though who wins no longer
  // depends on the order: authority, then the newer fiscal period, then the
  // newer source date decide (see merge-policy.ts).
  const conflicts: MergeConflict[] = [];
  const ctx: MergeContext = { conflicts, lookup: sourceRowLookup(documents) };
  const ordered = [...results].sort(
    (a, b) => +new Date(a.doc.createdAt) - +new Date(b.doc.createdAt) || a.doc.id.localeCompare(b.doc.id),
  );
  for (const { doc, data } of ordered) {
    if (data) {
      docsMerged = mergeExtractedData(docsMerged, mergeableExtraction(doc, data), mergeSourceFor(doc, data), ctx);
      recordFactSpeakers(docsMerged, data._speakers, doc.id); // who said it, on calls
      documentsReprocessed++;
    }
  }

  // 3) Overlay the deal's existing extractedInfo. The seller's own words
  //    (interview, questionnaire) and untracked legacy values win; values
  //    recorded as document-derived are refreshed from the re-extraction so
  //    stale facts don't survive, and provenance maps are merged, not clobbered.
  const existing = (deal.extractedInfo as Record<string, unknown> | null) || {};
  // A row's contribution is replaced by its fresh read; a row whose read
  // failed (replayed from its stored extraction) keeps everything it had.
  const rows = new Map<string, RereadRow>();
  for (const { doc, data, freshText } of results) {
    if (!data || freshText === null) continue;
    const type = typeof data._documentType === "string" ? data._documentType : "";
    const { period, dated, brokerOnly } = mergeSourceFor(doc, data);
    rows.set(doc.id, { text: freshText, kind: documentKind(doc), title: [doc.name, doc.subcategory, type].filter(Boolean).join(" · "), period, dated, brokerOnly });
  }
  const report: OverlayReport = { dropped: [], kept: [] };
  let rebuilt = overlayExistingFacts(docsMerged, existing, ctx, { rows, report });
  if (report.dropped.length > 0 || report.kept.length > 0) {
    // Keys only (values are the seller's business data).
    console.log(`[reprocess] ${dealId}: removed ${report.dropped.length} value(s) no source states any more (${report.dropped.map((d) => d.key).slice(0, 60).join(", ")}); kept ${report.kept.length} a source still states`);
  }
  // Headlines follow their by-year maps; every source entry carries its
  // row's visibility. Broker process data the fresh extractions set aside
  // (referral source, fees…) is in their _privateNotes and joins the
  // broker-private notes with the rest of each source's notes
  // (refreshSourceNotes, under the lock below).
  reconcileHeadlines(rebuilt, ctx);
  rebuilt = stampSourceDetails(rebuilt, documents);
  const existingAlts = (existing[FIELD_ALTERNATES_KEY] as Record<string, unknown[]> | undefined) || {};

  // Re-extraction can take minutes. Re-read the deal and carry over anything
  // that changed meanwhile (an interview turn, a broker edit, another upload)
  // so this rebuild never clobbers it — under the deal's facts lock.
  onProgress?.({ phase: "saving", done: documents.length, total: documents.length });
  const result = await withDealFactsLock(dealId, async () => {
    const latestDeal = await storage.getDeal(dealId);
    const latest = (latestDeal?.extractedInfo as Record<string, unknown> | null) || {};
    const latestSources = getFieldSources(latest);
    const finalSources = { ...(rebuilt[FIELD_SOURCES_KEY] as Record<string, unknown>) };
    const carried: string[] = [];
    for (const key of Array.from(new Set([...Object.keys(latest), ...Object.keys(existing)]))) {
      if (key === FIELD_SOURCES_KEY || key === FIELD_ALTERNATES_KEY || key === FIELD_CORROBORATIONS_KEY) continue;
      if (JSON.stringify(latest[key]) === JSON.stringify(existing[key])) continue;
      carried.push(key);
      if (latest[key] === undefined) { delete rebuilt[key]; delete finalSources[key]; continue; }
      rebuilt[key] = latest[key];
      if (latestSources[key]) finalSources[key] = latestSources[key];
    }
    rebuilt[FIELD_SOURCES_KEY] = finalSources;
    const finalCorr = carryCorroborations(
      rebuilt[FIELD_CORROBORATIONS_KEY] as Record<string, unknown> | undefined,
      existing[FIELD_CORROBORATIONS_KEY] as Record<string, unknown> | undefined,
      latest[FIELD_CORROBORATIONS_KEY] as Record<string, unknown> | undefined,
      carried,
    );
    if (Object.keys(finalCorr).length > 0) rebuilt[FIELD_CORROBORATIONS_KEY] = finalCorr;
    else delete rebuilt[FIELD_CORROBORATIONS_KEY];
    // Alternates recorded since the rebuild started (not the stale ones it re-derived).
    const latestAlts = (latest[FIELD_ALTERNATES_KEY] as Record<string, unknown[]> | undefined) || {};
    const addedSince: Record<string, unknown[]> = {};
    for (const [k, list] of Object.entries(latestAlts)) {
      const before = new Set((existingAlts[k] ?? []).map((a) => (a as { value?: string }).value));
      const fresh = (Array.isArray(list) ? list : []).filter((a) => !before.has((a as { value?: string }).value));
      if (fresh.length > 0) addedSince[k] = fresh;
    }
    rebuilt[FIELD_ALTERNATES_KEY] = mergeAlternateMaps(rebuilt[FIELD_ALTERNATES_KEY] as Record<string, unknown>, addedSince);

    // Private notes follow the re-extraction: each source's notes are what it
    // says now, and notes that say the same thing in other words are folded
    // into one (keeping every source's words). A note the fresh run simply
    // didn't repeat is KEPT — a model run is not a correction, and the note
    // may be the broker's only record of it. It goes only when this source
    // now records it as a business fact (a dividend, a guarantee an older
    // prompt filed as private), or when it is no note at all ("NDA in
    // place", a sample-document label).
    for (const { doc, data } of results) if (data) refreshSourceNotes(rebuilt, doc, data);
    compactPrivateNotes(rebuilt);

    // The deal's own name, industry and listed price are the broker's facts
    // (deal-mirror.ts): a tax return's NAICS line or a CRM note's "steel fab"
    // stays another value — saved that way, not only shown that way.
    const { columnPatch } = reconcileMirroredFacts(latestDeal ?? deal, rebuilt, setBrokerFact);
    await storage.updateDeal(dealId, { extractedInfo: rebuilt, ...columnPatch } as any);
    // Material conflicts the rebuild saw become discrepancies (deduplicated).
    await recordMergeConflicts(dealId, conflicts, documents, rebuilt).catch((err) =>
      console.error(`[reprocess] recording merge conflicts failed for ${dealId}:`, err));
    // Merge rows the rebuilt facts no longer bear out are superseded.
    await settleMergeRowsQuietly(dealId, "reprocess");

    // Report the coverage-known field count — the same vocabulary as the
    // interview header and the CIM COVERAGE panel.
    const fieldsAfter = Object.entries(rebuilt).filter(
      ([k, v]) => KNOWN_EXTRACTED_FIELDS.has(k) && v !== null && v !== undefined && v !== "",
    ).length;

    return {
      documentsReprocessed,
      fieldsAfter,
      documentsKeptAsBefore: results.filter((r) => r.data && r.freshText === null).length,
      removed: report.dropped,
      keptFromText: report.kept,
    };
  });
  // The notes each source re-stated in new words, and what is no note at
  // all or a business fact, are consolidated by the supporting model (only
  // wordings it has never seen are asked about) — outside the facts lock.
  await reviewPrivateNotes(dealId).catch((err) => console.error(`[reprocess] private-notes review failed for ${dealId}:`, err));
  return result;
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A source's own notes (summary, red flags, "… notes"): what it says in passing, not a fact filed under a name. */
const NOTE_LIKE_KEY = /Notes$|^(?:summary|keyFacts|redFlags)$/;

/**
 * Pure: the corroborations map after a rebuild, carrying over what changed on
 * the deal while it ran (like the facts and alternates next to it):
 * - a fact that changed meanwhile (carried over from `latest`) takes its
 *   corroborations — whole-fact and per-year ("revenueByYear.2024") — from
 *   `latest` too: the re-derived ones described the value it replaced;
 * - for every other fact, the re-derived list plus any corroboration
 *   recorded since the rebuild started.
 */
export function carryCorroborations(
  rebuiltCorr: Record<string, unknown> | undefined,
  existingCorr: Record<string, unknown> | undefined,
  latestCorr: Record<string, unknown> | undefined,
  carriedKeys: string[],
): Record<string, unknown[]> {
  const listAt = (m: Record<string, unknown> | undefined, k: string): unknown[] =>
    m && Array.isArray(m[k]) ? (m[k] as unknown[]) : [];
  const belongsToCarried = (k: string) => carriedKeys.some((c) => k === c || k.startsWith(`${c}.`));
  const out: Record<string, unknown[]> = {};
  for (const [k, list] of Object.entries(rebuiltCorr || {})) {
    if (!belongsToCarried(k) && Array.isArray(list) && list.length > 0) out[k] = list;
  }
  const addedSince: Record<string, unknown[]> = {};
  for (const k of Object.keys(latestCorr || {})) {
    const latestList = listAt(latestCorr, k);
    if (belongsToCarried(k)) {
      if (latestList.length > 0) out[k] = latestList;
      continue;
    }
    const before = new Set(listAt(existingCorr, k).map((c) => JSON.stringify(c)));
    const fresh = latestList.filter((c) => !before.has(JSON.stringify(c)));
    if (fresh.length > 0) addedSince[k] = fresh;
  }
  const merged = mergeAlternateMaps(out, addedSince);
  for (const k of Object.keys(merged)) if (merged[k].length === 0) delete merged[k];
  return merged;
}

/** A source row re-read in this run: the text it was read from, its kind and title. */
export interface RereadRow {
  text: string | null;
  kind: SourceKind;
  /** The row's title (and type) — decides the measure a customer figure is (receivablesMeasureKey). */
  title?: string;
  /** The row's source details today (mergeSourceFor): fiscal period, own date, visibility. */
  period?: string;
  dated?: string;
  brokerOnly?: boolean;
}

/** What a rebuild did with the values source rows had asserted before. */
export interface OverlayReport {
  /** Values a re-read row no longer yields and its text does not state — gone. */
  dropped: Array<{ key: string; value: string; documentId?: string }>;
  /** Values a re-read row no longer yields but its text states word for word — kept. */
  kept: Array<{ key: string; value: string; documentId?: string }>;
}

export interface OverlayOptions {
  /**
   * The rows re-read in this run (documentId → text). A row NOT listed —
   * its re-read failed, or it had no text to read — keeps everything it had.
   * Omitted: every row counts as re-read, with no text to check against.
   */
  rows?: ReadonlyMap<string, RereadRow>;
  report?: OverlayReport;
}

/**
 * Pure: lays the deal's existing facts over a fresh re-extraction of its
 * sources (`docsMerged`).
 * - A source row's contribution (document, email, transcript, CRM note…) is
 *   REPLACED by that row's re-extraction: a value the row yields again (as
 *   the fact on file, another value or a confirmation) is the fresh one. A
 *   value the fresh read no longer yields — a stale year-suffixed key
 *   ("cash2021") next to the new by-year maps, a ratio or growth rate an
 *   older prompt worked out, NAICS text as the industry, a garbled line —
 *   goes, UNLESS the row's own text still states it (groundedInSource): a
 *   figure the source printed, or a faithful summary of what a seller said,
 *   is never lost to model variance. A summary in the reader's own words
 *   comes back only when the fresh read didn't file the same fact under
 *   another name; a list of figures comes back without the one the reader
 *   worked out; a budget, an unreviewed or a part-year year comes back as
 *   what it is. Such a value is merged back as the row's (a suffixed key onto
 *   its by-year map) and the usual authority decides. A row whose re-read
 *   failed keeps everything it had.
 * - Everything else — broker edits and choices, the seller's interview and
 *   intake answers, untracked legacy values — is kept as it was, whatever
 *   documentId an older merge bug stamped on its source; a differing fresh
 *   value is kept as an alternate (never silently dropped), an equal one as
 *   a corroboration.
 * - Map facts (revenue by year) merge year by year: years a source row
 *   contributed follow the row rule above, years the broker or seller set
 *   are kept.
 * - Per-source notes (summary, red flags, …) are never deal facts.
 */
export function overlayExistingFacts(
  docsMerged: Record<string, unknown>,
  existing: Record<string, unknown>,
  /** Collects material conflicts; `lookup` reads older bare-id year entries as their rows. */
  ctx: MergeContext = {},
  opts: OverlayOptions = {},
): Record<string, unknown> {
  const existingSources = getFieldSources(existing);
  const freshSources = getFieldSources(docsMerged);
  const freshAlts = getFieldAlternates(docsMerged);
  const freshCorr = getFieldCorroborations(docsMerged);
  const rebuilt: Record<string, unknown> = { ...docsMerged };
  const clearSource = (key: string) => {
    const s = { ...getFieldSources(rebuilt) };
    delete s[key];
    rebuilt[FIELD_SOURCES_KEY] = s;
  };
  const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  const note = (list: "dropped" | "kept", key: string, value: unknown, documentId?: string) =>
    opts.report?.[list].push({ key, value: text(value), ...(documentId ? { documentId } : {}) });

  /** The row was re-read in this run (a failed re-read keeps what it had). */
  const reread = (docId: string) => !opts.rows || opts.rows.has(docId);
  /** The row's fresh read yields this fact (or this year of it): on file, as another value or as a confirmation. */
  const yielded = (docId: string, key: string, sub?: string): boolean => {
    const k = sub === undefined ? key : `${key}.${sub}`;
    const fs = freshSources[key];
    if (sub === undefined) {
      if (fs?.documentId === docId) return true;
    } else {
      // Only a year the fresh map actually has: yearSource falls back to the
      // map's base source for an unlisted year (older rows), so a year the
      // fresh read left out would count as its own and be lost unreported.
      const freshMap = docsMerged[key];
      if (fs && isMap(freshMap) && freshMap[sub] !== undefined && yearSource(fs, sub, ctx.lookup)?.documentId === docId) return true;
    }
    const mentions = (list: unknown) => Array.isArray(list) && list.some((a) => a && (a as FieldSource).documentId === docId);
    return mentions(freshAlts[k]) || mentions(freshCorr[k]);
  };
  /** The row's own text still states the value (see groundedInSource). */
  const grounded = (key: string, value: unknown, src: FieldSource): boolean => {
    if (src.valueInferred || !src.documentId) return false;
    const row = opts.rows?.get(src.documentId);
    return !!row && groundedInSource(key, value, row.text, { spoken: SPOKEN_KINDS.has(row.kind) });
  };
  /** What of the value the row's own text still states (a worked-out clause of a list goes), or null. */
  const groundedPart = (key: string, value: unknown, src: FieldSource, how: { close: boolean; whole: boolean }): string | null => {
    if (src.valueInferred || !src.documentId) return null;
    const row = opts.rows?.get(src.documentId);
    return row ? groundedValue(key, value, row.text, { spoken: SPOKEN_KINDS.has(row.kind), ...how }) : null;
  };
  /**
   * Everything each row's fresh read gives as a fact, another value or a
   * confirmation, under any key other than its source notes — to tell a fact
   * the fresh read filed under another name from one it no longer gives.
   */
  const freshByRow = new Map<string, Array<{ key: string; value: string }>>();
  {
    const add = (docId: string | undefined, key: string, v: unknown) => {
      if (!docId || typeof v !== "string" || !v.trim() || NOTE_LIKE_KEY.test(key)) return;
      const list = freshByRow.get(docId) ?? [];
      list.push({ key: key.split(".")[0], value: v });
      freshByRow.set(docId, list);
    };
    for (const [k, v] of Object.entries(docsMerged)) {
      if (k.startsWith("_") || SOURCE_META_KEYS.has(k)) continue;
      const s = freshSources[k];
      if (isMap(v)) {
        if (!s) continue;
        for (const [y, yv] of Object.entries(resolvedYearSources(s, v, ctx.lookup))) add(yv?.documentId, k, v[y]);
      } else add(s?.documentId, k, v);
    }
    for (const list of [freshAlts, freshCorr]) {
      for (const [k, entries] of Object.entries(list)) {
        for (const a of Array.isArray(entries) ? entries : []) add(a?.documentId, k, a?.value);
      }
    }
  }
  /** The row's fresh read gives the same fact under another key (it re-filed it). */
  const refiled = (docId: string, key: string, value: unknown): boolean =>
    typeof value === "string" &&
    (freshByRow.get(docId) ?? []).some((f) => f.key !== key && restates(value, f.value, { key, otherKey: f.key }));

  /**
   * The source a value merged back from its row records: the row as it is
   * read today (its period, date, visibility; a specialist for this fact or
   * not) — an older write often recorded none of it.
   */
  const replaySource = (src: FieldSource, key: string, year?: string): FieldSource => {
    const row = opts.rows?.get(src.documentId!);
    const { years: _y, specialist: _s, ...base } = src;
    const period = row?.period ?? base.period;
    return {
      ...base,
      ...(year ? { period: periodForYear(year, period) } : period ? { period } : {}),
      ...(row?.dated && !base.dated ? { dated: row.dated } : {}),
      ...(row?.brokerOnly !== undefined ? { brokerOnly: row.brokerOnly } : {}),
      ...(row?.title && isSpecialistSource(key, row.title) ? { specialist: true } : {}),
    };
  };
  /** A row's year figure that is a budget / unreviewed number (that year's other value) or a part-year one (the interim fact). */
  const keepSetAside = (mapKey: string, e: SetAsideYear, src: FieldSource): boolean => {
    if (e.note) recordAlternate(rebuilt, `${mapKey}.${e.period}`, e.value, { ...replaySource(src, mapKey, /^\d{4}$/.test(e.period) ? e.period : undefined), note: e.note });
    else mergeMapEntryInto(rebuilt, interimKeyFor(mapKey), e.period, e.value, replaySource(src, mapKey), replayCtx);
    return true;
  };
  // A value merged back is one the fresh read no longer asserts: it keeps
  // its place by authority, but opens no discrepancy of its own (the
  // conflicts the fresh read sees are raised by the fresh merge).
  const replayCtx: MergeContext = { lookup: ctx.lookup };

  /** A value a re-read row asserted and no longer yields: merged back when its text states it. */
  const replayScalar = (key: string, value: unknown, src: FieldSource) => {
    const docId = src.documentId!;
    // "cash2021": a figure for a year belongs on its by-year map.
    const suffixed = yearSuffixedKey(key);
    if (suffixed) {
      const mapKey = yearMapKeyFor(suffixed.metric);
      const { map: valid, setAside } = cleanYearMap(suffixed.metric, { [suffixed.year]: typeof value === "string" ? value : String(value) });
      const [y, v] = Object.entries(valid)[0] ?? [];
      if (y && yielded(docId, mapKey, y)) return; // the row's fresh figure for that year replaces it
      if (!y && setAside.length > 0 && !yielded(docId, mapKey, setAside[0].period) && grounded(mapKey, setAside[0].value, src) &&
          keepSetAside(mapKey, setAside[0], src)) return note("kept", `${mapKey}.${setAside[0].period}`, setAside[0].value, docId);
      if (!y || !grounded(mapKey, v, src)) return note("dropped", key, value, docId);
      mergeYearMapInto(rebuilt, mapKey, { [y]: v }, replaySource(src, mapKey, y), replayCtx);
      return note("kept", `${mapKey}.${y}`, v, docId);
    }
    // Today's name for the fact ("backlogValue" is "backlog"), and its measure.
    const target = receivablesMeasureKey(canonicalFieldName(key), value, opts.rows?.get(docId)?.title);
    if (target !== key && yielded(docId, target)) return; // replaced under today's name for it
    // In (nearly) the source's own words: back. A looser summary of what the
    // source says: back too — unless the fresh read gives the same fact under
    // another name (it re-filed it; one copy is enough). The whole value
    // first; else the part of a list of figures the source states.
    let part: string | null = null;
    for (const whole of [true, false]) {
      part = groundedPart(target, value, src, { close: true, whole });
      if (part !== null) break;
      part = groundedPart(target, value, src, { close: false, whole });
      if (part !== null && refiled(docId, target, part)) return;
      if (part !== null) break;
    }
    if (part === null) return note("dropped", key, value, docId);
    mergeScalarInto(rebuilt, target, part, replaySource(src, target), replayCtx);
    note("kept", target, part, docId);
  };

  for (const [key, rawValue] of Object.entries(existing)) {
    if (key === FIELD_SOURCES_KEY || key === FIELD_ALTERNATES_KEY || key === FIELD_CORROBORATIONS_KEY) continue;
    if (rawValue === null || rawValue === undefined || rawValue === "") continue;
    if (SOURCE_META_KEYS.has(key)) continue;
    if (key.startsWith("_")) { rebuilt[key] = rawValue; continue; } // broker bookkeeping carries over
    const value = repairCharIndexedValue(rawValue);
    const src = existingSources[key];
    const fresh = docsMerged[key];
    const freshSrc = freshSources[key];
    const rowBacked = isRowBackedSource(src);
    if (rowBacked && isBrokerProcessKey(key)) {
      // Broker process data a source row put in the facts (referral source,
      // fees, earlier approaches…) is the broker's private note, never a business fact.
      addPrivateNote(rebuilt, `${fieldLabelText(key)}: ${typeof value === "string" ? value : JSON.stringify(value)}`, {
        documentId: src!.documentId,
        reason: "Broker process detail",
        ...(src!.brokerOnly ? { brokerOnly: true } : {}),
      });
      clearSource(key);
      delete rebuilt[key];
      continue;
    }

    if (isMap(value) && (fresh === undefined || isMap(fresh))) {
      // Year by year, each year through its own source (info-merger
      // yearSource): a row's years follow the row rule; years the broker or
      // seller set (or legacy) are kept.
      const years: Record<string, FieldSource> = src
        ? resolvedYearSources(src, value, ctx.lookup)
        : Object.fromEntries(Object.keys(value).map((y) => [y, { source: "system", note: LEGACY_SOURCE_NOTE } as FieldSource]));
      const out: Record<string, unknown> = { ...(fresh ?? {}) };
      const outYears: Record<string, FieldSource> = fresh && freshSrc ? resolvedYearSources(freshSrc, fresh, ctx.lookup) : {};
      const replays: Array<[string, unknown, FieldSource]> = [];
      for (const [y, v] of Object.entries(value)) {
        const ys = years[y];
        if (isRowBackedSource(ys)) {
          const docId = ys.documentId!;
          if (yielded(docId, key, y)) continue; // the row's fresh figure replaces it
          if (!reread(docId)) {
            // Its re-read failed: the year stays — beside a fresh figure when there is one.
            if (out[y] === undefined) { out[y] = v; outYears[y] = ys; }
            else if (String(out[y]) !== String(v)) recordAlternate(rebuilt, `${key}.${y}`, v, ys);
            continue;
          }
          replays.push([y, v, ys]);
          continue;
        }
        if (out[y] !== undefined) {
          const fy: FieldSource = outYears[y] ?? { source: freshSrc?.source ?? "document" };
          if (String(out[y]) !== String(v)) {
            // A fresh statement outranks the questionnaire's year (never the broker's or the seller's live).
            if (outranksFor(key, fy, ys)) {
              recordAlternate(rebuilt, `${key}.${y}`, v, ys);
              noteConflict(ctx, key, y, { value: String(out[y]), src: fy }, { value: String(v), src: ys });
              continue;
            }
            recordAlternate(rebuilt, `${key}.${y}`, out[y], fy);
            noteConflict(ctx, key, y, { value: String(v), src: ys }, { value: String(out[y]), src: fy });
          } else if (fy.documentId) {
            noteSameValue(rebuilt, `${key}.${y}`, fy, { current: v, recorded: isUntrackedSource(ys) ? null : ys, setRecorded: () => {} });
          }
        }
        out[y] = v;
        outYears[y] = ys;
      }
      // An interim period on file (a run-rate, a quarter) is not a fiscal year.
      for (const y of interimYears(outYears)) {
        recordAlternate(rebuilt, `${key}.${y}`, out[y], { ...outYears[y], note: "Part-year / run-rate figure" });
        delete out[y];
        delete outYears[y];
      }
      if (Object.keys(out).length === 0) {
        delete rebuilt[key];
        clearSource(key);
      } else {
        rebuilt[key] = out;
        if (Object.values(outYears).every((s) => isUntrackedSource(s))) clearSource(key);
        else setFieldSource(rebuilt, key, summariseMapSource(outYears)!);
      }
      // A row's year its fresh read no longer yields: back only when its text states it.
      for (const [y, v, ys] of replays) {
        if (!grounded(key, v, ys)) { note("dropped", `${key}.${y}`, v, ys.documentId); continue; }
        if (isYearMapKey(key)) {
          const { map: valid, setAside } = cleanYearMap(key.replace(/ByYear$/, "") || key, { [y]: typeof v === "string" ? v : String(v) });
          const [vy, vv] = Object.entries(valid)[0] ?? [];
          if (!vy) {
            // A budget, an unreviewed number, a quarter: kept as what it is.
            if (setAside.length > 0 && keepSetAside(key, setAside[0], ys)) { note("kept", `${key}.${y}`, v, ys.documentId); continue; }
            note("dropped", `${key}.${y}`, v, ys.documentId);
            continue;
          }
          mergeYearMapInto(rebuilt, key, { [vy]: vv }, replaySource(ys, key, vy), replayCtx);
        } else {
          mergeMapEntryInto(rebuilt, key, y, String(v), replaySource(ys, key), replayCtx);
        }
        note("kept", `${key}.${y}`, v, ys.documentId);
      }
      continue;
    }

    if (rowBacked) {
      const docId = src!.documentId!;
      if (yielded(docId, key)) continue; // the row's fresh read replaces it
      if (!reread(docId)) {
        // Its re-read failed: what it had stays (weighed against any fresh value).
        if (fresh === undefined) {
          rebuilt[key] = value;
          setFieldSource(rebuilt, key, src!);
        } else mergeScalarInto(rebuilt, key, value, src!, ctx);
        continue;
      }
      replayScalar(key, value, src!);
      continue;
    }

    const keptSrc: FieldSource | null = src ? { ...src } : null;
    if (keptSrc) delete keptSrc.documentId; // stray link from an older merge bug
    // The broker's figure for a year under a year-suffixed key ("sde2024",
    // "revenue2023") goes on that metric's by-year map as the broker's year
    // — one place for the year, the broker's value kept (it outranks any
    // statement's figure, which stays another value).
    // The broker's own words are kept as the year's value.
    const suffixed = keptSrc?.source === "broker" && (typeof value === "string" || typeof value === "number") ? yearSuffixedKey(key) : null;
    if (suffixed && typedNumericValues(String(value)).some((t) => t.kind === "currency")) {
      const mapKey = yearMapKeyFor(suffixed.metric);
      const onFile = rebuilt[mapKey];
      // (A free-text value on file under the map key: the broker's key stays as it is.)
      if (onFile === undefined || onFile === null || onFile === "" || isMap(onFile)) {
        mergeYearMapInto(rebuilt, mapKey, { [suffixed.year]: String(value) }, { ...keptSrc!, period: periodForYear(suffixed.year, keptSrc!.period) }, replayCtx);
        continue;
      }
    }
    // The broker's and the seller's own values stay; a statement, lease or
    // registry document outranks the intake questionnaire for the facts it
    // is the authority on (founder decision A).
    if (fresh !== undefined && freshSrc && keptSrc && !isMap(value) && outranksFor(key, freshSrc, keptSrc)) {
      const same = JSON.stringify(fresh) === JSON.stringify(value) || String(fresh) === String(value);
      if (!same) {
        recordAlternate(rebuilt, key, value, keptSrc);
        noteConflict(ctx, key, undefined, { value: String(fresh), src: freshSrc }, { value: String(value), src: keptSrc });
        continue;
      }
    }
    rebuilt[key] = value;
    if (keptSrc) setFieldSource(rebuilt, key, keptSrc);
    else clearSource(key); // legacy value stays untracked (seller-authored by default)
    if (fresh !== undefined && freshSrc) {
      // The re-extracted value lost to the value on file: keep it visible.
      const same = JSON.stringify(fresh) === JSON.stringify(value) || String(fresh) === String(value);
      if (!same) {
        displaceCorroborations(rebuilt, key, value);
        recordAlternate(rebuilt, key, fresh, freshSrc);
        if (keptSrc) noteConflict(ctx, key, undefined, { value: String(value), src: keptSrc }, { value: String(fresh), src: freshSrc });
      } else if (src) noteSameValue(rebuilt, key, freshSrc, { outranks: (a, b) => effectiveRank(key, a) > effectiveRank(key, b) });
    }
  }

  // Alternates / corroborations: keep the ones not tied to a source row, then
  // add the rebuilt set (which re-derives every source-row entry from fresh
  // extractions, plus the displaced values recorded above).
  const keepNonRow = (raw: unknown): Record<string, unknown[]> => {
    const out: Record<string, unknown[]> = {};
    if (!isMap(raw)) return out;
    for (const [k, list] of Object.entries(raw)) {
      const kept = (Array.isArray(list) ? list : []).filter((a) => !isRowBackedSource(a as FieldSource));
      if (kept.length > 0) out[k] = kept;
    }
    return out;
  };
  rebuilt[FIELD_ALTERNATES_KEY] = mergeAlternateMaps(
    keepNonRow(existing[FIELD_ALTERNATES_KEY]),
    rebuilt[FIELD_ALTERNATES_KEY] as Record<string, unknown> | undefined,
  );
  const corr = mergeAlternateMaps(
    keepNonRow(existing[FIELD_CORROBORATIONS_KEY]),
    rebuilt[FIELD_CORROBORATIONS_KEY] as Record<string, unknown> | undefined,
  );
  if (Object.keys(corr).length > 0) rebuilt[FIELD_CORROBORATIONS_KEY] = corr;
  else delete rebuilt[FIELD_CORROBORATIONS_KEY];
  return rebuilt;
}
