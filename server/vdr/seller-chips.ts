/**
 * The seller's "In the data room" chip (vdr spec §7, founder question 1 —
 * default yes): a checklist file the broker has shared with buyers who
 * signed an NDA, while the room is open. Never names buyers, never shows
 * activity. Never throws (no chip on any failure).
 */
import { dbVdrStore, type VdrStore } from "./store";

/** Pure: documents with a live item that has at least one grant, in an open room. */
export function sharedDocumentIds(
  room: { status: string } | null,
  items: ReadonlyArray<{ id: string; documentId: string | null; removedAt: Date | string | null }>,
  shares: ReadonlyArray<{ itemId: string; effect: string }>,
): Set<string> {
  if (!room || room.status === "closed") return new Set();
  const granted = new Set(shares.filter((s) => s.effect === "allow").map((s) => s.itemId));
  return new Set(items.filter((i) => !i.removedAt && i.documentId && granted.has(i.id)).map((i) => i.documentId!));
}

export async function sellerRoomDocumentIds(dealId: string, store: VdrStore = dbVdrStore): Promise<Set<string>> {
  try {
    const room = await store.getRoom(dealId);
    if (!room || room.status === "closed") return new Set();
    const [items, shares] = await Promise.all([store.listItems(dealId), store.listShares(dealId)]);
    return sharedDocumentIds(room, items, shares);
  } catch {
    return new Set();
  }
}
