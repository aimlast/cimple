/**
 * source-visibility.ts — a source switched between "Broker only" and shared.
 *
 * Every value a source gives is stamped with its row's visibility when it is
 * merged (`brokerOnly` on the fact's source, its other values and
 * confirmations, and its private notes' sources), and the seller-side
 * readers (the interview's seller view, the CIM) go by that stamp. Changing
 * only the row left the stamp as it was: an email imported broker-only and
 * then shared kept its facts hidden from the interview, which re-asked every
 * one of them ("never re-ask" broken) until a reprocess the UI can't start.
 * restampSourceVisibility re-stamps the deal's facts from the rows at once.
 */
import { storage } from "../storage";
import {
  getPrivateNotes,
  BROKER_PRIVATE_NOTES_KEY,
  type BrokerPrivateNote,
  type PrivateNoteSource,
} from "../interview/info-merger";
import type { DocumentSourceMeta } from "@shared/schema";
import { stampSourceDetails } from "./merge-policy";
import { withDealFactsLock } from "./facts-lock";
import { settleMergeRowsQuietly } from "./merge-conflicts";

type Info = Record<string, unknown>;

/** Pure: the private notes with every source entry of `documentId` stamped `brokerOnly` (or not). */
export function stampNoteSources(info: Info, documentId: string, brokerOnly: boolean): Info {
  const notes = getPrivateNotes(info);
  if (notes.length === 0) return info;
  let changed = false;
  const stamp = <T extends PrivateNoteSource>(s: T): T => {
    if (s.documentId !== documentId || !!s.brokerOnly === brokerOnly) return s;
    changed = true;
    const { brokerOnly: _b, ...rest } = s;
    return (brokerOnly ? { ...rest, brokerOnly: true } : rest) as T;
  };
  const next: BrokerPrivateNote[] = notes.map((n) => {
    const own = stamp(n);
    return Array.isArray(n.alsoFrom) ? { ...own, alsoFrom: n.alsoFrom.map(stamp) } : own;
  });
  return changed ? { ...info, [BROKER_PRIVATE_NOTES_KEY]: next } : info;
}

/**
 * Re-stamps the deal's facts (sources, other values, confirmations, private
 * notes) with each row's current visibility — after the broker switched
 * `documentId` to broker-only or shared. Under the deal's facts lock.
 */
export async function restampSourceVisibility(dealId: string, documentId: string, brokerOnly: boolean): Promise<void> {
  await withDealFactsLock(dealId, async () => {
    const deal = await storage.getDeal(dealId);
    if (!deal) return;
    const before = (deal.extractedInfo as Info | null) || {};
    const documents = await storage.getDocumentsByDeal(dealId);
    const after = stampNoteSources(stampSourceDetails(before, documents), documentId, brokerOnly);
    if (JSON.stringify(after) !== JSON.stringify(before)) await storage.updateDeal(dealId, { extractedInfo: after } as any);
  });
  // Merge rows are re-read against the re-stamped facts.
  await settleMergeRowsQuietly(dealId, "visibility");
  // A general ledger or an add-back's supporting document (INTEGRATION §2.17
  // step 1): who may see its entries changes with it — the checklist row and
  // the seller's and buyers' views follow at once. Never throws.
  const { onGlSourceAudienceChanged } = await import("../gl/ingest");
  await onGlSourceAudienceChanged(documentId);
}

/** What Cimple recorded about reading a source — kept when the broker edits its details. */
export function keptReadState(meta: DocumentSourceMeta | null | undefined): Partial<DocumentSourceMeta> {
  const out: Partial<DocumentSourceMeta> = {};
  if (!meta) return out;
  if (meta.periodEnd) out.periodEnd = meta.periodEnd;
  if (meta.rereadFailed) out.rereadFailed = meta.rereadFailed;
  if (meta.readFailed) out.readFailed = meta.readFailed;
  if (meta.partialRead) out.partialRead = meta.partialRead;
  return out;
}
