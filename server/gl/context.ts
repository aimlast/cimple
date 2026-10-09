/**
 * context.ts — what every GL step needs to know about a deal at once: its
 * fiscal-year end, its ledgers and who may see each (D25), the years they
 * cover, the supporting documents. Loaded once per request/run.
 */
import { storage } from "../storage";
import type { Deal, Document, GlLedger, GlTracing } from "@shared/schema";
import type { ReconcileContext } from "@shared/gl-reconcile";
import { glStore } from "./store";
import { isSellerVisibleLedger } from "./audience";
import { fiscalYearEndFor } from "./fiscal";

export interface GlDealContext {
  dealId: string;
  deal: Deal | undefined;
  tracing: GlTracing;
  fye: string;
  ledgers: GlLedger[];
  docs: Document[];
  docById: Map<string, Document>;
  /** Ready ledgers whose document still exists. */
  ready: GlLedger[];
  readyIds: Set<string>;
  /** Ready ledgers the seller may see (and so may be proposed to them, credit the checklist, reach buyers). */
  sellerLedgerIds: Set<string>;
  /** Ready ledgers private to the broker. */
  brokerOnlyLedgerIds: Set<string>;
  /** Fiscal years any ready ledger covers / a seller-visible one covers. */
  yearsAll: Set<string>;
  yearsSeller: Set<string>;
  /** Supporting documents (T4s, invoices) the seller may see. */
  sellerDocIds: Set<string>;
}

export async function loadGlContext(dealId: string): Promise<GlDealContext> {
  const store = glStore();
  const [deal, docs, ledgers, existing] = await Promise.all([
    storage.getDeal(dealId),
    storage.getDocumentsByDeal(dealId),
    store.listLedgers(dealId),
    store.getTracing(dealId),
  ]);
  const tracing = existing ?? (await store.ensureTracing(dealId, fiscalYearEndFor(deal, docs)));
  const docById = new Map(docs.map((d) => [d.id, d]));
  const ready = ledgers.filter((l) => l.status === "ready" && docById.has(l.documentId));
  const sellerLedgerIds = new Set<string>();
  const brokerOnlyLedgerIds = new Set<string>();
  const yearsAll = new Set<string>();
  const yearsSeller = new Set<string>();
  for (const l of ready) {
    const doc = docById.get(l.documentId)!;
    const seller = isSellerVisibleLedger(doc, l);
    (seller ? sellerLedgerIds : brokerOnlyLedgerIds).add(l.id);
    for (const y of Object.keys((l.years as Record<string, unknown> | null) ?? {})) {
      yearsAll.add(y);
      if (seller) yearsSeller.add(y);
    }
  }
  const sellerDocIds = new Set(docs.filter((d) => d.subcategory === "addback_support" && d.visibility !== "broker_only").map((d) => d.id));
  return {
    dealId, deal, tracing, fye: tracing.fiscalYearEnd, ledgers, docs, docById, ready, readyIds: new Set(ready.map((l) => l.id)),
    sellerLedgerIds, brokerOnlyLedgerIds, yearsAll, yearsSeller, sellerDocIds,
  };
}

/** Reconciliation as the broker sees it: every ledger counts (private ones flagged). */
export function brokerReconcileCtx(c: GlDealContext): ReconcileContext {
  const supportIds = new Set(c.docs.filter((d) => d.subcategory === "addback_support").map((d) => d.id));
  return { ledgerYears: c.yearsAll, hasLedger: c.ready.length > 0, countedLedgerIds: c.readyIds, brokerOnlyLedgerIds: c.brokerOnlyLedgerIds, countedDocumentIds: supportIds };
}

/** Reconciliation as the seller sees it: only what they may see counts. */
export function sellerReconcileCtx(c: GlDealContext): ReconcileContext {
  return { ledgerYears: c.yearsSeller, hasLedger: c.sellerLedgerIds.size > 0, countedLedgerIds: c.sellerLedgerIds, countedDocumentIds: c.sellerDocIds };
}

/** Owner names the deal's facts give (for owner pay with no name in its label). */
export function ownerNamesText(deal: Deal | undefined): string {
  const info = (deal?.extractedInfo && typeof deal.extractedInfo === "object" ? deal.extractedInfo : {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(info)) {
    if (k.startsWith("_")) continue;
    if (!/^(?:[cl]:)?(?:owner(?:s|Name|Names)?|sellerName|president|ceo|principal|shareholders?)$/i.test(k)) continue;
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) parts.push(...v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? Object.values(x).filter((y) => typeof y === "string").join(" ") : "")));
    else if (v && typeof v === "object") parts.push(...Object.values(v).filter((y): y is string => typeof y === "string"));
  }
  return parts.join(" ; ").slice(0, 2000);
}
