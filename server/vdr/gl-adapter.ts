/**
 * The data room's side of the gl contract (INTEGRATION §2.6, vdr spec §11.2).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ INTEGRATOR, at the gl merge (INTEGRATION §6 step 7): replace the bodies  │
 * │ below with gl's exports —                                                │
 * │   export { isGlDocument, ledgerStatusForVdr, ledgerSummaryForVdr }       │
 * │     from "../gl/viewer";                                                  │
 * │   export { withHeavySheetSlot } from "../documents/heavy-sheet";          │
 * │ and have gl call setup.ts onLedgerStatusChanged(documentId).            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Until then (gl not merged) every ledger is `ledger_pending`: never served,
 * indexed, downloaded or listed to buyers. vdr never parses a ledger itself,
 * so the staff names and personal entries gl withholds can't leak.
 */

export type LedgerStatusForVdr = { status: "reading" | "needs_columns" | "ready" | "failed"; allowOriginalDownload: boolean };

/** gl's pure ledger test (subcategory general_ledger, or a gl_ledgers row in any status). Not merged yet → false. */
export function isGlDocument(_doc: { id?: string; subcategory?: string | null }): boolean {
  return false;
}

/** gl's reading status for a ledger document. Not merged yet → null (ledger_pending). */
export async function ledgerStatusForVdr(_documentId: string): Promise<LedgerStatusForVdr | null> {
  return null;
}

/** gl's one-line ledger description (no amounts, no names). Not merged yet → "". */
export async function ledgerSummaryForVdr(_documentId: string): Promise<string> {
  return "";
}

/** gl's heavy-spreadsheet slot (C19): one heavy sheet parse at a time across gl, the parser and the vdr child. */
export async function withHeavySheetSlot<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}
