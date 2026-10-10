/**
 * audience.ts — who may see a ledger (gl spec D25). Pure; used by every query.
 *
 * A ledger is broker-audience ("private to you") when its document is
 * broker-only, or came from the broker's CRM and the broker hasn't chosen
 * "Share it with the seller". Broker-audience ledgers are read and usable by
 * the broker, but never reach any seller or buyer path: search, proposals,
 * the seller's view, checklist credit, buyer evidence, the buyer viewer.
 * Reading a ledger never changes its document's visibility.
 */
export type LedgerAudience = "shared" | "broker";

type DocLike = { visibility?: string | null; sourceKind?: string | null; subcategory?: string | null };
type LedgerLike = { sharedWithSellerByBroker?: boolean | null; status?: string | null } | null | undefined;

export function ledgerAudience(doc: DocLike, ledger: LedgerLike): LedgerAudience {
  if (doc.visibility === "broker_only") return "broker";
  if (doc.sourceKind === "crm" && !ledger?.sharedWithSellerByBroker) return "broker";
  return "shared";
}

/** The seller may see this ledger and its entries. */
export function isSellerVisibleLedger(doc: DocLike, ledger: LedgerLike): boolean {
  return ledgerAudience(doc, ledger) === "shared";
}

/**
 * The ledger may appear in a buyer's evidence or data room at all (further
 * gated by the DD access level, the broker's share and serve-time masking).
 * The same rule as the seller's: a ledger private to the broker never leaves.
 */
export function isBuyerVisibleLedger(doc: DocLike, ledger: LedgerLike): boolean {
  return ledgerAudience(doc, ledger) === "shared";
}

/**
 * gl's pure ledger test, for the data room (INTEGRATION §2.6): a document
 * filed as a general ledger. Every document that gets a gl_ledgers row is
 * filed so (the ledger reader sets subcategory "general_ledger"), and
 * "Read it as a normal document instead" clears both — so the subcategory
 * alone answers "a ledger row in any status" too.
 */
export function isGlDocument(doc: { subcategory?: string | null } | null | undefined): boolean {
  return !!doc && doc.subcategory === "general_ledger";
}

/** A supporting document for an add-back (T4, payroll summary, invoice). */
export function isGlSupportDocument(doc: { subcategory?: string | null } | null | undefined): boolean {
  return !!doc && doc.subcategory === "addback_support";
}
