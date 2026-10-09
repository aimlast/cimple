/**
 * The data room's side of the gl contract (INTEGRATION §2.6, vdr spec §11.2).
 *
 * Since the gl merge (INTEGRATION §6 step 7) these are gl's own exports:
 *   - isGlDocument, ledgerStatusForVdr, ledgerSummaryForVdr, ledgerRowsForBuyer
 *     (server/gl/viewer.ts — isGlDocument is gl's pure test in server/gl/audience.ts);
 *   - withHeavySheetSlot (server/documents/heavy-sheet.ts): one heavy
 *     spreadsheet parse at a time across gl's worker, the generic parser and
 *     the data room's render child (C19 — prepare.ts wraps every sheet job).
 * gl tells the room when a ledger's status changes (read, needs columns,
 * failed, deleted): server/routes/gl-data-room-wiring.ts registers
 * setup.ts onLedgerStatusChanged on gl's events.
 *
 * A ledger stays `ledger_pending` until gl says it is ready: never served,
 * indexed, downloaded or listed to buyers. vdr never parses a ledger itself,
 * so the staff names and personal entries gl withholds can't leak. The async
 * calls load gl on first use (the room's own module graph stays light).
 */
import type { BuyerLedgerRows, LedgerRowsQueryForBuyer, LedgerStatusForVdr as GlLedgerStatusForVdr } from "../gl/viewer";

export type LedgerStatusForVdr = GlLedgerStatusForVdr;

/** gl's pure ledger test (subcategory general_ledger). */
export { isGlDocument } from "../gl/audience";

/** gl's reading status for a ledger document (null: no ledger row — not read yet, or never a ledger → ledger_pending). */
export async function ledgerStatusForVdr(documentId: string): Promise<LedgerStatusForVdr | null> {
  const gl = await import("../gl/viewer");
  return gl.ledgerStatusForVdr(documentId);
}

/** gl's one-line ledger description (no amounts, no names); "" until the ledger is ready. */
export async function ledgerSummaryForVdr(documentId: string): Promise<string> {
  const gl = await import("../gl/viewer");
  return gl.ledgerSummaryForVdr(documentId);
}

/** gl's heavy-spreadsheet slot (C19): one heavy sheet parse at a time across gl, the parser and the vdr child. */
export { withHeavySheetSlot } from "../documents/heavy-sheet";

/** The buyer's rows query, from the request's query string (anything else is ignored). */
export function ledgerQueryFrom(query: Record<string, unknown>): LedgerRowsQueryForBuyer {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const int = (v: unknown) => {
    const n = typeof v === "string" && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return { fy: str(query.fy), account: str(query.account), q: str(query.q), page: int(query.page) ?? 0, around: int(query.around) };
}

/**
 * gl's ledger rows for a buyer (INTEGRATION §2.6), behind the room's own
 * access check (`assertBuyerDocumentAccess` built `ctx`; a room item that
 * isn't a ready ledger is null at once, without asking gl). gl checks again —
 * a ready, buyer-visible ledger of ctx.deal, and ctx.mode === "dd" — and
 * masks every row; any refusal is null → the route answers 404 "Not found".
 * Each new query (year / account / search) is logged once through the room's
 * own open-log (never for the broker's preview of a buyer's link).
 */
export async function ledgerRowsForBuyer(ctx: import("./access").VdrBuyerDocCtx, documentId: string, query: Record<string, unknown>): Promise<BuyerLedgerRows | null> {
  // Only a room item the room itself prepared as a READY ledger (gl said so) is asked for rows.
  if (ctx.item.prepared?.kind !== "ledger" || ctx.item.documentId !== documentId) return null;
  const gl = await import("../gl/viewer");
  try {
    return await gl.ledgerRowsForBuyer(
      {
        deal: { id: ctx.deal.id },
        mode: ctx.mode,
        accessId: ctx.access.id,
        logView: (q) => ctx.logView({ ledger: true, year: q.fy, account: q.account ? true : false, searched: q.q ? true : false, rows: q.rows }),
      },
      documentId,
      ledgerQueryFrom(query),
    );
  } catch (err) {
    if (err instanceof gl.GlLedgerNotFound) return null;
    throw err;
  }
}
