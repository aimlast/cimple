/**
 * viewer.ts — what other parts of Cimple read about a ledger (gl spec §8.2,
 * INTEGRATION §2.6). The data room imports these at the gl merge (its
 * server/vdr/gl-adapter.ts):
 *
 *   isGlDocument(doc)              pure: a document filed as a general ledger
 *   ledgerStatusForVdr(documentId) { status, allowOriginalDownload } | null
 *   ledgerSummaryForVdr(documentId) one line — no amounts, no names
 *
 * Buyers' rows (masked, DD only) come with the DD evidence (pass 3:
 * ledgerRowsForBuyer). The broker's rows are served by server/routes/gl.ts.
 */
import { storage } from "../storage";
import { glStore } from "./store";
import { isGlDocument } from "./audience";
import { formatCount, formatPeriod, softwareLabel } from "@shared/gl-copy";
import type { GlLedgerStatus } from "@shared/gl-types";

export { isGlDocument };

export interface LedgerStatusForVdr {
  status: GlLedgerStatus;
  allowOriginalDownload: boolean;
}

/** The ledger's reading status for the data room, or null when the document has no ledger row (not read yet / never a ledger). */
export async function ledgerStatusForVdr(documentId: string): Promise<LedgerStatusForVdr | null> {
  const l = await glStore().getLedgerByDocument(documentId);
  if (!l) return null;
  return { status: l.status as GlLedgerStatus, allowOriginalDownload: l.allowOriginalDownload };
}

/** gl's own name for the same lookup (C18). */
export const glLedgerState = ledgerStatusForVdr;

/**
 * The ledger's notes in the data room: "General ledger, QuickBooks Online
 * export: 48,213 entries, Jan 2022–Dec 2024, 212 accounts." — never an
 * amount, a vendor or a person. "" when the ledger isn't ready.
 */
export async function ledgerSummaryForVdr(documentId: string): Promise<string> {
  const l = await glStore().getLedgerByDocument(documentId);
  if (!l || l.status !== "ready") return "";
  const doc = await storage.getDocument(documentId);
  if (!doc) return "";
  const period = l.periodStart && l.periodEnd ? `, ${formatPeriod(l.periodStart, l.periodEnd)}` : "";
  const sw = l.software && l.software !== "other" ? `, ${softwareLabel(l.software)}` : "";
  return `General ledger${sw}: ${formatCount(l.rowCount)} entries${period}, ${formatCount(l.accountCount)} accounts.`;
}
