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
        const fresh = await extractDocumentData(text, doc.category || "other", doc.subcategory);
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
  const results: (ExtractedDocumentData | null)[] = [];
  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE);
    results.push(...(await Promise.all(batch.map(extractForDoc))));
  }
  for (const extracted of results) {
    if (extracted) {
      docsMerged = mergeExtractedData(docsMerged, extracted);
      documentsReprocessed++;
    }
  }

  // 3) Overlay the deal's existing extractedInfo — interview answers,
  //    questionnaire seeds, and prior confirmations win on collision.
  const existing = (deal.extractedInfo as Record<string, unknown> | null) || {};
  const rebuilt: Record<string, unknown> = { ...docsMerged };
  for (const [key, value] of Object.entries(existing)) {
    if (value !== null && value !== undefined && value !== "") {
      rebuilt[key] = value;
    }
  }

  await storage.updateDeal(dealId, { extractedInfo: rebuilt } as any);

  // Report the coverage-known field count — the same vocabulary as the
  // interview header and the CIM COVERAGE panel.
  const fieldsAfter = Object.entries(rebuilt).filter(
    ([k, v]) => KNOWN_EXTRACTED_FIELDS.has(k) && v !== null && v !== undefined && v !== "",
  ).length;

  return { documentsReprocessed, fieldsAfter };
}
