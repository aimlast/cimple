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
import { extractDocumentData, extractionChecklist, mergeExtractedData, normaliseExtraction, type ExtractedDocumentData } from "./extractor";
import { isDerivedMetricKey } from "./extraction-guard";
import { recordFactSpeakers } from "../interview/fact-guards";
import { KNOWN_EXTRACTED_FIELDS } from "../interview/knowledge-base";
import {
  getFieldSources,
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
  FIELD_SOURCES_KEY,
  FIELD_ALTERNATES_KEY,
  FIELD_CORROBORATIONS_KEY,
  BROKER_SUPPRESSED_KEY,
  LEGACY_SOURCE_NOTE,
  SOURCE_META_KEYS,
  type FieldSource,
} from "../interview/info-merger";
import { documentKind, mergeableExtraction, mergeSourceFor, refreshSourceNotes, rememberPeriodEnd } from "./ingest";
import { compactPrivateNotes } from "../interview/info-merger";
import { withDealFactsLock } from "./facts-lock";
import { cleanYearMap, effectiveRank, interimYears, isBrokerProcessKey, noteConflict, outranksFor, reconcileHeadlines, stampSourceDetails, type MergeConflict, type MergeContext } from "./merge-policy";
import { fieldLabel as fieldLabelText } from "../interview/interview-plan";
import { recordMergeConflicts } from "./merge-conflicts";

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
  const checklist = extractionChecklist(deal);
  const extractForDoc = async (
    doc: (typeof documents)[number],
  ): Promise<ExtractedDocumentData | null> => {
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
        const fresh = await extractDocumentData(text, doc.category || "other", doc.subcategory, documentKind(doc), { checklist });
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
  let rebuilt = overlayExistingFacts(docsMerged, existing, ctx);
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
  return withDealFactsLock(dealId, async () => {
    const latest = ((await storage.getDeal(dealId))?.extractedInfo as Record<string, unknown> | null) || {};
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

    await storage.updateDeal(dealId, { extractedInfo: rebuilt } as any);
    // Material conflicts the rebuild saw become discrepancies (deduplicated).
    await recordMergeConflicts(dealId, conflicts, documents, rebuilt).catch((err) =>
      console.error(`[reprocess] recording merge conflicts failed for ${dealId}:`, err));

    // Report the coverage-known field count — the same vocabulary as the
    // interview header and the CIM COVERAGE panel.
    const fieldsAfter = Object.entries(rebuilt).filter(
      ([k, v]) => KNOWN_EXTRACTED_FIELDS.has(k) && v !== null && v !== undefined && v !== "",
    ).length;

    return { documentsReprocessed, fieldsAfter };
  });
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

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

/**
 * Pure: lays the deal's existing facts over a fresh re-extraction of its
 * sources (`docsMerged`).
 * - A value a source row asserted (document, email, transcript, CRM note…)
 *   is refreshed from that row's re-extraction.
 * - Everything else — broker edits and choices, the seller's interview and
 *   intake answers, untracked legacy values — is kept as it was, whatever
 *   documentId an older merge bug stamped on its source; a differing fresh
 *   value is kept as an alternate (never silently dropped), an equal one as
 *   a corroboration.
 * - Map facts (revenue by year) merge year by year: years a source row
 *   contributed are refreshed, years the broker or seller set are kept.
 * - Per-source notes (summary, red flags, …) are never deal facts.
 */
export function overlayExistingFacts(
  docsMerged: Record<string, unknown>,
  existing: Record<string, unknown>,
  /** Collects material conflicts; `lookup` reads older bare-id year entries as their rows. */
  ctx: MergeContext = {},
): Record<string, unknown> {
  const existingSources = getFieldSources(existing);
  const freshSources = getFieldSources(docsMerged);
  const rebuilt: Record<string, unknown> = { ...docsMerged };
  const clearSource = (key: string) => {
    const s = { ...getFieldSources(rebuilt) };
    delete s[key];
    rebuilt[FIELD_SOURCES_KEY] = s;
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
      // fees…) is the broker's private note, never a business fact.
      addPrivateNote(rebuilt, `${fieldLabelText(key)}: ${typeof value === "string" ? value : JSON.stringify(value)}`, {
        documentId: src!.documentId,
        reason: "Broker process detail",
        ...(src!.brokerOnly ? { brokerOnly: true } : {}),
      });
      clearSource(key);
      delete rebuilt[key];
      continue;
    }

    if (isMap(value) && isMap(fresh)) {
      // Year by year, each year through its own source (info-merger
      // yearSource): years a source row stated are refreshed from the
      // re-extraction; years the broker or seller set (or legacy) are kept.
      const years: Record<string, FieldSource> = src
        ? resolvedYearSources(src, value, ctx.lookup)
        : Object.fromEntries(Object.keys(value).map((y) => [y, { source: "system", note: LEGACY_SOURCE_NOTE } as FieldSource]));
      const out: Record<string, unknown> = { ...fresh };
      const outYears: Record<string, FieldSource> = freshSrc ? resolvedYearSources(freshSrc, fresh, ctx.lookup) : {};
      for (const [y, v] of Object.entries(value)) {
        const ys = years[y];
        if (isRowBackedSource(ys)) {
          // A derived figure's year the rows no longer yield was calculated by an older prompt.
          if (isDerivedMetricKey(key)) continue;
          // A row's year is kept only if it is still a valid yearly figure
          // under the current rules ("FY25" → "2025"; a budget, an SDE
          // figure or "Last year" under revenue is dropped).
          const { map: valid } = cleanYearMap(key.replace(/ByYear$/, "") || key, { [y]: typeof v === "string" ? v : String(v) });
          const [vy, vv] = Object.entries(valid)[0] ?? [];
          if (!vy) continue;
          if (out[vy] !== undefined) continue; // the rows' fresh figure wins
          out[vy] = vv; // re-extraction missed it — keep the figure on file
          outYears[vy] = ys;
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
      rebuilt[key] = out;
      if (Object.values(outYears).every((s) => isUntrackedSource(s))) clearSource(key);
      else setFieldSource(rebuilt, key, summariseMapSource(outYears)!);
      continue;
    }

    if (rowBacked && fresh !== undefined) continue; // fresh extraction wins
    // A derived figure (SDE, EBITDA, add-backs…) a source row no longer
    // yields was one an older prompt calculated — it goes, never kept. On a
    // by-year map only the rows' years go; years the broker or the seller
    // set stay.
    if (isDerivedMetricKey(key)) {
      if (isMap(value) && src && fresh === undefined) {
        const ys = resolvedYearSources(src, value, ctx.lookup);
        const own = Object.keys(value).filter((y) => !isRowBackedSource(ys[y]));
        if (own.length === 0) continue;
        if (own.length < Object.keys(value).length) {
          rebuilt[key] = Object.fromEntries(own.map((y) => [y, value[y]]));
          const ownSources = Object.fromEntries(own.filter((y) => ys[y]).map((y) => [y, ys[y]]));
          if (Object.values(ownSources).every((s) => isUntrackedSource(s))) clearSource(key);
          else setFieldSource(rebuilt, key, summariseMapSource(ownSources)!);
          continue;
        }
      } else if (rowBacked) continue;
    }
    const keptSrc: FieldSource | null = src ? { ...src } : null;
    if (keptSrc && !rowBacked) delete keptSrc.documentId; // stray link from an older merge bug
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
