/**
 * Buyers' document requests (vdr spec §5.8, §9.1 requests.ts).
 *
 * Pass 1 ships only the hook the upload paths call: when a file is linked to
 * a checklist row the broker created from a buyer's request (source
 * "buyer_request"), every request waiting on that row becomes "Ready to
 * share" and appears in the broker's To do. Nothing is shared and nobody is
 * emailed here — sharing is the broker's one click.
 */
import { dbVdrStore, logVdrQuietly, type VdrStore } from "./store";

export async function onRequirementFulfilled(requirementId: string, documentId: string, store: VdrStore = dbVdrStore): Promise<number> {
  try {
    const ready = await store.markRequestsReady(requirementId, documentId);
    for (const r of ready) {
      await logVdrQuietly(store, {
        dealId: r.dealId,
        action: "request_ready",
        actorKind: "seller",
        buyerEmail: r.buyerEmail,
        detail: { requestId: r.id, requirementId, documentId },
      });
    }
    return ready.length;
  } catch (err: any) {
    console.warn(`[vdr] couldn't mark requests ready for checklist row ${requirementId}:`, err?.message ?? err);
    return 0;
  }
}
