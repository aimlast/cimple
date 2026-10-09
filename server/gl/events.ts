/**
 * events.ts — other parts of Cimple that want to know when a ledger's
 * status changes (read, needs columns, failed, deleted). The data room
 * (vdr) registers its `onLedgerStatusChanged(documentId)` here at the gl
 * merge (INTEGRATION §2.6, §6 step 7):
 *
 *   import { onGlLedgerStatusChanged } from "../gl/events";
 *   onGlLedgerStatusChanged((documentId) => onLedgerStatusChanged(documentId));
 *
 * A listener that throws never stops the ledger reader.
 */
type Listener = (documentId: string) => unknown;

const listeners = new Set<Listener>();

export function onGlLedgerStatusChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitGlLedgerStatusChanged(documentId: string): void {
  for (const l of Array.from(listeners)) {
    try {
      const r = l(documentId);
      if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch((err) => console.warn("[gl] ledger status listener failed:", err));
    } catch (err) {
      console.warn("[gl] ledger status listener failed:", err);
    }
  }
}
