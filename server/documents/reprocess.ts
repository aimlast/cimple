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
 *   3. Rebuilds deal.extractedInfo additively: documents merge into a fresh
 *      object first, then the deal's EXISTING extractedInfo values are
 *      overlaid on top — interview/questionnaire-confirmed data always wins
 *      on key collision.
 *
 * No route is registered here — callers wire their own endpoint/script.
 */
import fs from "fs";
import path from "path";
import { storage } from "../storage";
import { extractTextFromFile } from "./parser";
import { extractDocumentData, mergeExtractedData, type ExtractedDocumentData } from "./extractor";
import { KNOWN_EXTRACTED_FIELDS } from "../interview/knowledge-base";
import {
  getFieldSources,
  mergeAlternateMaps,
  FIELD_SOURCES_KEY,
  FIELD_ALTERNATES_KEY,
  BROKER_SUPPRESSED_KEY,
} from "../interview/info-merger";
import { documentKind } from "./ingest";

export async function reprocessDealDocuments(
  dealId: string,
): Promise<{ documentsReprocessed: number; fieldsAfter: number }> {
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
  const extractForDoc = async (
    doc: (typeof documents)[number],
  ): Promise<ExtractedDocumentData | null> => {
    const stored =
      doc.extractedData && typeof doc.extractedData === "object"
        ? (doc.extractedData as ExtractedDocumentData)
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
        const fresh = await extractDocumentData(text, doc.category || "other", doc.subcategory, documentKind(doc));
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
          } as any);
          return fresh;
        }
      } catch (err) {
        console.error(`[reprocess] re-extraction failed for doc ${doc.id} (${doc.name}) — falling back to stored extraction:`, err);
      }
    } else {
      console.log(`[reprocess] no file or stored text for doc ${doc.id} (${doc.name}) — replaying stored extraction only`);
    }
    return stored;
  };

  // Claude calls run in bounded-parallel batches; merging happens afterwards
  // in stable document order so precedence stays deterministic.
  const BATCH_SIZE = 4;
  const results: { doc: (typeof documents)[number]; data: ExtractedDocumentData | null }[] = [];
  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE);
    results.push(...(await Promise.all(batch.map(async (d) => ({ doc: d, data: await extractForDoc(d) })))));
  }
  // Keys the broker deleted stay deleted — the merge skips them.
  const suppressed = (deal.extractedInfo as Record<string, unknown> | null)?.[BROKER_SUPPRESSED_KEY];
  if (Array.isArray(suppressed) && suppressed.length > 0) docsMerged[BROKER_SUPPRESSED_KEY] = suppressed;
  for (const { doc, data } of results) {
    if (data) {
      docsMerged = mergeExtractedData(docsMerged, data, { documentId: doc.id, source: documentKind(doc) });
      documentsReprocessed++;
    }
  }

  // 3) Overlay the deal's existing extractedInfo. The seller's own words
  //    (interview, questionnaire) and untracked legacy values win; values
  //    recorded as document-derived are refreshed from the re-extraction so
  //    stale facts don't survive, and provenance maps are merged, not clobbered.
  const existing = (deal.extractedInfo as Record<string, unknown> | null) || {};
  const existingSources = getFieldSources(existing);
  const rebuilt: Record<string, unknown> = { ...docsMerged };
  const rebuiltSources = { ...getFieldSources(docsMerged) };
  for (const [key, value] of Object.entries(existing)) {
    if (key === FIELD_SOURCES_KEY || key === FIELD_ALTERNATES_KEY) continue;
    if (value === null || value === undefined || value === "") continue;
    const src = existingSources[key];
    // A value asserted by a source row (document, email, call transcript,
    // CRM note, …) is refreshed from that row's re-extraction; everything
    // else — the seller's words, the questionnaire, broker edits, untracked
    // legacy values — is kept as it was.
    if (src?.documentId && rebuilt[key] !== undefined) continue; // fresh extraction wins
    rebuilt[key] = value;
    if (src) rebuiltSources[key] = src;
    else delete rebuiltSources[key]; // legacy value stays untracked (seller-authored by default)
  }
  rebuilt[FIELD_SOURCES_KEY] = rebuiltSources;
  // Alternates: keep the ones not tied to a source row, then add the rebuilt
  // set (which re-derives every source-row alternate from fresh extractions).
  const existingAlts = (existing[FIELD_ALTERNATES_KEY] as Record<string, unknown[]> | undefined) || {};
  const keptAlts: Record<string, unknown[]> = {};
  for (const [k, list] of Object.entries(existingAlts)) {
    const kept = (Array.isArray(list) ? list : []).filter((a) => !(a as { documentId?: string }).documentId);
    if (kept.length > 0) keptAlts[k] = kept;
  }
  rebuilt[FIELD_ALTERNATES_KEY] = mergeAlternateMaps(keptAlts, docsMerged[FIELD_ALTERNATES_KEY] as Record<string, unknown> | undefined);

  // Re-extraction can take minutes. Re-read the deal and carry over anything
  // that changed meanwhile (an interview turn, a broker edit, another upload)
  // so this rebuild never clobbers it.
  const latest = ((await storage.getDeal(dealId))?.extractedInfo as Record<string, unknown> | null) || {};
  const latestSources = getFieldSources(latest);
  const finalSources = { ...(rebuilt[FIELD_SOURCES_KEY] as Record<string, unknown>) };
  for (const key of Array.from(new Set([...Object.keys(latest), ...Object.keys(existing)]))) {
    if (key === FIELD_SOURCES_KEY || key === FIELD_ALTERNATES_KEY) continue;
    if (JSON.stringify(latest[key]) === JSON.stringify(existing[key])) continue;
    if (latest[key] === undefined) { delete rebuilt[key]; delete finalSources[key]; continue; }
    rebuilt[key] = latest[key];
    if (latestSources[key]) finalSources[key] = latestSources[key];
  }
  rebuilt[FIELD_SOURCES_KEY] = finalSources;
  // Alternates recorded since the rebuild started (not the stale ones it re-derived).
  const latestAlts = (latest[FIELD_ALTERNATES_KEY] as Record<string, unknown[]> | undefined) || {};
  const addedSince: Record<string, unknown[]> = {};
  for (const [k, list] of Object.entries(latestAlts)) {
    const before = new Set((existingAlts[k] ?? []).map((a) => (a as { value?: string }).value));
    const fresh = (Array.isArray(list) ? list : []).filter((a) => !before.has((a as { value?: string }).value));
    if (fresh.length > 0) addedSince[k] = fresh;
  }
  rebuilt[FIELD_ALTERNATES_KEY] = mergeAlternateMaps(rebuilt[FIELD_ALTERNATES_KEY] as Record<string, unknown>, addedSince);

  await storage.updateDeal(dealId, { extractedInfo: rebuilt } as any);

  // Report the coverage-known field count — the same vocabulary as the
  // interview header and the CIM COVERAGE panel.
  const fieldsAfter = Object.entries(rebuilt).filter(
    ([k, v]) => KNOWN_EXTRACTED_FIELDS.has(k) && v !== null && v !== undefined && v !== "",
  ).length;

  return { documentsReprocessed, fieldsAfter };
}
