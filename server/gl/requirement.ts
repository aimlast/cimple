/**
 * requirement.ts — the general-ledger checklist row's status, set only here
 * (gl spec D23, E21). The row reads "uploaded" (credited to the ledger's
 * document) once a ledger the seller may see has been read; a ledger private
 * to the broker never credits it (the seller would see its name). Called
 * when a ledger becomes ready, is deleted, or changes audience.
 */
import { storage } from "../storage";
import { GL_REQUIREMENT_SOURCE, isGlRequirement } from "../documents/requirements";
import { glStore, type GlStore } from "./store";
import { isSellerVisibleLedger } from "./audience";
import type { Document, GlLedger } from "@shared/schema";

export interface RequirementDeps {
  store: GlStore;
  getDocumentRequirementsByDeal: typeof storage.getDocumentRequirementsByDeal;
  updateDocumentRequirement: typeof storage.updateDocumentRequirement;
  getDocumentsByDeal: typeof storage.getDocumentsByDeal;
}

const defaultDeps = (): RequirementDeps => ({
  store: glStore(),
  getDocumentRequirementsByDeal: (id) => storage.getDocumentRequirementsByDeal(id),
  updateDocumentRequirement: (id, u) => storage.updateDocumentRequirement(id, u),
  getDocumentsByDeal: (id) => storage.getDocumentsByDeal(id),
});

/** The ledger that answers the checklist row: a ready, seller-visible main ledger (newest), else an adjustments file. Pure. */
export function creditingLedger(ledgers: GlLedger[], docs: Map<string, Document>): { ledger: GlLedger; doc: Document } | null {
  const ready = ledgers
    .filter((l) => l.status === "ready")
    .map((l) => ({ ledger: l, doc: docs.get(l.documentId) }))
    .filter((x): x is { ledger: GlLedger; doc: Document } => !!x.doc && isSellerVisibleLedger(x.doc, x.ledger))
    .sort((a, b) => (a.ledger.role === b.ledger.role ? +new Date(b.ledger.createdAt) - +new Date(a.ledger.createdAt) : a.ledger.role === "ledger" ? -1 : 1));
  return ready[0] ?? null;
}

/** Brings the deal's general-ledger row in line with its ledgers. Never throws. */
export async function syncGlRequirement(dealId: string, deps: RequirementDeps = defaultDeps()): Promise<void> {
  try {
    const rows = (await deps.getDocumentRequirementsByDeal(dealId)).filter((r) => isGlRequirement(r));
    if (rows.length === 0) return;
    const [ledgers, docs] = await Promise.all([deps.store.listLedgers(dealId), deps.getDocumentsByDeal(dealId)]);
    const byId = new Map(docs.map((d) => [d.id, d]));
    const credit = creditingLedger(ledgers, byId);
    for (const row of rows) {
      if (credit) {
        if (row.uploadedFileId === credit.doc.id && (row.status === "uploaded" || row.status === "verified")) continue;
        await deps.updateDocumentRequirement(row.id, {
          status: "uploaded",
          uploadedFileId: credit.doc.id,
          uploadedBy: credit.ledger.uploadedBy === "seller" ? "seller" : "broker",
          uploadedAt: new Date(credit.ledger.createdAt),
        } as any);
      } else if (row.status !== "missing" || row.uploadedFileId) {
        await deps.updateDocumentRequirement(row.id, { status: "missing", uploadedFileId: null, uploadedBy: null, uploadedAt: null } as any);
      }
    }
  } catch (err) {
    console.warn(`[gl] couldn't update the general-ledger checklist row on deal ${dealId}:`, err);
  }
}

export { GL_REQUIREMENT_SOURCE };
