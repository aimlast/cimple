/**
 * viewer.ts — what other parts of Cimple read about a ledger (gl spec §8.2,
 * INTEGRATION §2.6). The data room imports these at the gl merge (its
 * server/vdr/gl-adapter.ts):
 *
 *   isGlDocument(doc)              pure: a document filed as a general ledger
 *   ledgerStatusForVdr(documentId) { status, allowOriginalDownload } | null
 *   ledgerSummaryForVdr(documentId) one line — no amounts, no names
 *
 *   isBuyerVisibleLedger(doc, ledger) pure: never a ledger private to the broker
 *   ledgerRowsForBuyer(ctx, documentId, query) a due-diligence buyer's rows,
 *                                  masked (sensitive.ts), searched field by field
 *
 * The broker's rows are served by server/routes/gl.ts.
 */
import { storage } from "../storage";
import { glStore } from "./store";
import { isGlDocument } from "./audience";
import { formatCount, formatPeriod, softwareLabel } from "@shared/gl-copy";
import type { GlLedgerStatus } from "@shared/gl-types";
import { maskForBuyer, type BuyerMaskContext } from "./sensitive";
import { isBuyerVisibleLedger } from "./audience";
import { personsFor } from "./match-run";
import { personsIn, type Person } from "./match";
import { loadEvidenceState } from "./evidence";
import { parseMoneyToCents } from "./text";
import type { GlLedger, Document as DocRow, GlTransaction } from "@shared/schema";

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

// ── Buyers: the ledger in the data room (DD only, masked) ───────────────

/**
 * What the data room hands gl for one buyer (vdr's VdrBuyerDocCtx carries
 * at least these): the deal, the buyer's CIM mode, and a way to log the view.
 */
export interface GlBuyerDocCtx {
  deal: { id: string };
  mode: "blind" | "normal" | "dd";
  accessId?: string | null;
  /** Called once per new query (year / account / search) — the data room's activity log. */
  logView?: (q: { fy: string | null; account: string | null; q: string | null; rows: number }) => void | Promise<void>;
}

export interface LedgerRowsQueryForBuyer { fy?: string | null; account?: string | null; q?: string | null; page?: number; around?: number | null }

export class GlLedgerNotFound extends Error {
  status = 404;
  constructor() {
    super("Not found");
  }
}

export interface BuyerLedgerRow {
  rowNo: number;
  date: string;
  fiscalYear: string;
  account: string;
  name: string | null;
  memo: string | null;
  number: string | null;
  amountCents: number;
  withheld?: "personal" | "staff" | "keep_out";
}

export interface BuyerLedgerRows {
  ledger: { documentId: string; software: string | null; period: string; rowCount: number; accountCount: number };
  years: string[];
  accounts: Array<{ accountKey: string; account: string; lines: number; netCents: number }>;
  page: number;
  pageSize: number;
  total: number;
  /** "Showing the first 2,000 matches — narrow your search" when a search hit the cap. */
  capped: boolean;
  rows: BuyerLedgerRow[];
}

const BUYER_PAGE = 100;
const BUYER_SEARCH_CAP = 2000;
const loggedQueries = new Map<string, number>();

/** The masking context of every row of a deal's ledgers, for one request. */
async function rowMasking(dealId: string): Promise<{ maskFor: (t: GlTransaction, showStaffNames: boolean) => ReturnType<typeof maskForBuyer> }> {
  const s = await loadEvidenceState(dealId);
  const owners: Person[] = personsIn(s.ownerText).slice(0, 3);
  const byRow = new Map<string, { parties: Person[]; personal: boolean; show: boolean | null }>();
  const traces = new Map(s.traces.map((t) => [t.id, t]));
  for (const k of s.links) {
    if (k.state !== "confirmed" || !k.ledgerId || k.rowNo == null) continue;
    const t = traces.get(k.traceId);
    if (!t || t.removedAt) continue;
    const key = `${k.ledgerId}:${k.rowNo}`;
    const prev = byRow.get(key);
    const personal = t.category === "discretionary" || t.category === "owner_comp" || /\b(?:personal|owner|family|spouse|related)\b/i.test(t.label);
    const show = k.showDetails ?? null;
    byRow.set(key, {
      parties: [...(prev?.parties ?? []), ...personsFor(t, s.ownerText)],
      personal: (prev?.personal ?? false) || personal,
      // Withholding wins when two add-backs disagree.
      show: prev ? (prev.show === false || show === false ? false : prev.show === true && show === true ? true : null) : show,
    });
  }
  return {
    maskFor: (t, showStaffNames) => {
      const r = byRow.get(`${t.ledgerId}:${t.rowNo}`);
      const ctx: BuyerMaskContext = {
        staffNames: s.staffNames, heldNames: s.heldNames, parties: r ? [...owners, ...r.parties] : owners,
        personalAddback: r?.personal ?? false, showStaffNames,
      };
      return maskForBuyer({ account: t.account, name: t.name, memo: t.memo }, ctx, r?.show ?? null);
    },
  };
}

function shown(t: GlTransaction, m: ReturnType<typeof maskForBuyer>): BuyerLedgerRow {
  return {
    rowNo: t.rowNo, date: t.txnDate, fiscalYear: t.fiscalYear, account: m.account, name: m.name, memo: m.memo,
    number: t.txnNumber ?? null, amountCents: Number(t.amountCents), ...(m.withheld ? { withheld: m.withheld } : {}),
  };
}

/** Does the masked row still match the search (so a row that matched only through a withheld field drops out)? */
function stillMatches(row: BuyerLedgerRow, q: string): boolean {
  const term = q.trim().toLowerCase();
  const cents = /\d/.test(term) ? parseMoneyToCents(term) : null;
  if (cents !== null && Math.abs(row.amountCents) === Math.abs(cents)) return true;
  const fields = [row.account, row.number, row.withheld ? null : row.name, row.withheld ? null : row.memo];
  return fields.some((f) => (f ?? "").toLowerCase().includes(term));
}

/**
 * The ledger's rows for a due-diligence buyer (gl spec §8.2, §9.3). The data
 * room calls this behind its own access check; gl checks again: 404 unless
 * the document is a ready ledger of this deal that buyers may see and the
 * buyer reads the due-diligence CIM. Every row is masked as it is served.
 */
export async function ledgerRowsForBuyer(ctx: GlBuyerDocCtx, documentId: string, query: LedgerRowsQueryForBuyer = {}): Promise<BuyerLedgerRows> {
  if (ctx.mode !== "dd") throw new GlLedgerNotFound();
  const doc = (await storage.getDocument(documentId)) as DocRow | undefined;
  if (!doc || doc.dealId !== ctx.deal.id) throw new GlLedgerNotFound();
  const store = glStore();
  const ledger = (await store.getLedgerByDocument(documentId)) as GlLedger | undefined;
  if (!ledger || ledger.dealId !== ctx.deal.id || ledger.status !== "ready" || !isBuyerVisibleLedger(doc, ledger)) throw new GlLedgerNotFound();

  const fy = query.fy && /^\d{4}$/.test(query.fy) ? query.fy : null;
  const account = (query.account ?? "").slice(0, 300) || null;
  const q = (query.q ?? "").trim().slice(0, 100);
  const page = Math.max(0, Math.min(100_000, Math.floor(Number(query.page) || 0)));
  const { maskFor } = await rowMasking(ctx.deal.id);
  const showStaff = !!ledger.showStaffNames;
  let out: { rows: BuyerLedgerRow[]; total: number; page: number; capped: boolean };
  if (q) {
    const candidates = await store.buyerSearchRows({ ledgerId: ledger.id, fy, accountKey: account, q, limit: BUYER_SEARCH_CAP });
    const kept = candidates.map((t) => shown(t, maskFor(t, showStaff))).filter((r) => stillMatches(r, q));
    out = { rows: kept.slice(page * BUYER_PAGE, page * BUYER_PAGE + BUYER_PAGE), total: kept.length, page, capped: candidates.length >= BUYER_SEARCH_CAP };
  } else {
    const r = await store.ledgerRows({ ledgerId: ledger.id, fy, accountKey: account, page, pageSize: BUYER_PAGE, around: query.around ?? null });
    out = { rows: r.rows.map((t) => shown(t, maskFor(t, showStaff))), total: r.total, page: r.page, capped: false };
  }
  const accounts = await store.accountTotals(ledger.id, fy);
  if (ctx.logView) {
    const key = `${ctx.accessId ?? ""}|${documentId}|${fy ?? ""}|${account ?? ""}|${q}`;
    const now = Date.now();
    if (!loggedQueries.has(key) || now - loggedQueries.get(key)! > 10 * 60_000) {
      loggedQueries.set(key, now);
      if (loggedQueries.size > 5000) loggedQueries.delete(loggedQueries.keys().next().value as string);
      await ctx.logView({ fy, account, q: q || null, rows: out.total });
    }
  }
  return {
    ledger: { documentId, software: ledger.software ? softwareLabel(ledger.software) : null, period: formatPeriod(ledger.periodStart, ledger.periodEnd), rowCount: ledger.rowCount, accountCount: ledger.accountCount },
    years: Object.keys((ledger.years as Record<string, unknown> | null) ?? {}).sort(),
    accounts,
    page: out.page,
    pageSize: BUYER_PAGE,
    total: out.total,
    capped: out.capped,
    rows: out.rows,
  };
}

export { isBuyerVisibleLedger };
