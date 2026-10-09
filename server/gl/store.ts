/**
 * store.ts — every database read and write of the general-ledger stream,
 * behind one interface (gl spec §12.2): `pgStore` (drizzle; hand-written SQL
 * only for the duplicate marking) and `memoryStore` (tests, and
 * GL_STORE=memory for local runs before the tables exist — ignored in
 * production). Rows of one ledger are written in batches, one transaction
 * per batch.
 */
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  glLedgers, glTransactions, glTracing, glTraceLinks,
  type GlLedger, type InsertGlLedger, type GlTransaction, type InsertGlTransaction, type GlTracing, type GlTraceLink,
} from "@shared/schema";
import { escapeLike, parseMoneyToCents } from "./text";

export interface LedgerRowsQuery {
  ledgerId: string;
  fy?: string | null;
  accountKey?: string | null;
  q?: string | null;
  page?: number;
  pageSize?: number;
  /** Open the page holding this row number. */
  around?: number | null;
}

export interface LedgerAccountTotal { accountKey: string; account: string; lines: number; netCents: number }

export interface LedgerRowsPage {
  rows: GlTransaction[];
  total: number;
  page: number;
  pageSize: number;
}

export interface GlStore {
  getTracing(dealId: string): Promise<GlTracing | undefined>;
  /** The deal's tracing row, created with `fiscalYearEnd` when missing (concurrent callers get the same row). */
  ensureTracing(dealId: string, fiscalYearEnd: string): Promise<GlTracing>;
  updateTracing(dealId: string, patch: Partial<GlTracing>): Promise<GlTracing | undefined>;

  createLedger(row: InsertGlLedger): Promise<GlLedger>;
  getLedger(id: string): Promise<GlLedger | undefined>;
  getLedgerByDocument(documentId: string): Promise<GlLedger | undefined>;
  listLedgers(dealId: string): Promise<GlLedger[]>;
  /** Ledgers left "reading" (startup recovery). */
  listReadingLedgers(): Promise<GlLedger[]>;
  updateLedger(id: string, patch: Partial<GlLedger>): Promise<GlLedger | undefined>;
  deleteLedger(id: string): Promise<void>;

  insertTransactions(rows: InsertGlTransaction[]): Promise<void>;
  deleteTransactionsOfLedger(ledgerId: string): Promise<number>;
  /** Clears every duplicate flag of the deal, then marks entries already in an earlier-created ready ledger. */
  recomputeDuplicates(dealId: string): Promise<void>;
  countDuplicates(ledgerId: string): Promise<number>;
  ledgerRows(q: LedgerRowsQuery): Promise<LedgerRowsPage>;
  accountTotals(ledgerId: string, fy?: string | null): Promise<LedgerAccountTotal[]>;
  findRow(ledgerId: string, rowNo: number): Promise<GlTransaction | undefined>;

  /** A deleted or replaced ledger's links keep their snapshot and become "orphaned". */
  orphanLinksOfLedger(ledgerId: string): Promise<number>;
  /** Orphaned links of the deal re-attach to an entry of `ledgerId` with the same date, account, amount, name and memo. */
  reattachOrphans(dealId: string, ledgerId: string): Promise<number>;
  linksOfDeal(dealId: string): Promise<GlTraceLink[]>;
}

const PAGE_SIZE = 100;

// ── Postgres ─────────────────────────────────────────────────────────────

async function pgDb() {
  return (await import("../db")).db;
}

/** The text a viewer search compares: the amount when `q` is money, else account / name / memo / number. */
function searchCondition(q: string): SQL {
  const cents = /\d/.test(q) ? parseMoneyToCents(q) : null;
  const like = `%${escapeLike(q.toLowerCase())}%`;
  const text = sql`(lower(${glTransactions.account}) LIKE ${like} ESCAPE '\\' OR lower(coalesce(${glTransactions.name}, '')) LIKE ${like} ESCAPE '\\' OR lower(coalesce(${glTransactions.memo}, '')) LIKE ${like} ESCAPE '\\' OR lower(coalesce(${glTransactions.txnNumber}, '')) LIKE ${like} ESCAPE '\\')`;
  if (cents === null) return text;
  return sql`(${text} OR abs(${glTransactions.amountCents}) = ${Math.abs(cents)})`;
}

function rowsWhere(q: LedgerRowsQuery): SQL {
  const parts: SQL[] = [eq(glTransactions.ledgerId, q.ledgerId)];
  if (q.fy) parts.push(eq(glTransactions.fiscalYear, q.fy));
  if (q.accountKey) parts.push(eq(glTransactions.accountKey, q.accountKey));
  const term = (q.q ?? "").trim().slice(0, 100);
  if (term) parts.push(searchCondition(term));
  return and(...parts)!;
}

export const pgStore: GlStore = {
  async getTracing(dealId) {
    const db = await pgDb();
    const [row] = await db.select().from(glTracing).where(eq(glTracing.dealId, dealId)).limit(1);
    return row;
  },
  async ensureTracing(dealId, fiscalYearEnd) {
    const db = await pgDb();
    await db.insert(glTracing).values({ dealId, fiscalYearEnd } as any).onConflictDoNothing({ target: glTracing.dealId });
    const [row] = await db.select().from(glTracing).where(eq(glTracing.dealId, dealId)).limit(1);
    return row!;
  },
  async updateTracing(dealId, patch) {
    const db = await pgDb();
    const [row] = await db.update(glTracing).set({ ...patch, updatedAt: new Date() } as any).where(eq(glTracing.dealId, dealId)).returning();
    return row;
  },

  async createLedger(row) {
    const db = await pgDb();
    const [created] = await db.insert(glLedgers).values(row as any).returning();
    return created;
  },
  async getLedger(id) {
    const db = await pgDb();
    const [row] = await db.select().from(glLedgers).where(eq(glLedgers.id, id)).limit(1);
    return row;
  },
  async getLedgerByDocument(documentId) {
    const db = await pgDb();
    const [row] = await db.select().from(glLedgers).where(eq(glLedgers.documentId, documentId)).limit(1);
    return row;
  },
  async listLedgers(dealId) {
    const db = await pgDb();
    return db.select().from(glLedgers).where(eq(glLedgers.dealId, dealId)).orderBy(asc(glLedgers.createdAt));
  },
  async listReadingLedgers() {
    const db = await pgDb();
    return db.select().from(glLedgers).where(eq(glLedgers.status, "reading"));
  },
  async updateLedger(id, patch) {
    const db = await pgDb();
    const [row] = await db.update(glLedgers).set({ ...patch, updatedAt: new Date() } as any).where(eq(glLedgers.id, id)).returning();
    return row;
  },
  async deleteLedger(id) {
    const db = await pgDb();
    await db.delete(glLedgers).where(eq(glLedgers.id, id));
  },

  async insertTransactions(rows) {
    if (rows.length === 0) return;
    const db = await pgDb();
    await db.transaction(async (tx) => {
      // Postgres caps one statement's parameters at 65,535 (20 columns × 1,000 rows fits).
      for (let i = 0; i < rows.length; i += 1000) await tx.insert(glTransactions).values(rows.slice(i, i + 1000) as any);
    });
  },
  async deleteTransactionsOfLedger(ledgerId) {
    const db = await pgDb();
    const res = await db.delete(glTransactions).where(eq(glTransactions.ledgerId, ledgerId)).returning({ id: glTransactions.id });
    return res.length;
  },
  async recomputeDuplicates(dealId) {
    const db = await pgDb();
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE gl_transactions SET duplicate = false WHERE deal_id = ${dealId} AND duplicate`);
      await tx.execute(sql`
        UPDATE gl_transactions t SET duplicate = true
        FROM gl_ledgers l
        WHERE t.deal_id = ${dealId} AND l.id = t.ledger_id
          AND EXISTS (
            SELECT 1 FROM gl_transactions e JOIN gl_ledgers el ON el.id = e.ledger_id
            WHERE e.deal_id = ${dealId} AND el.status = 'ready'
              AND (el.created_at, el.id) < (l.created_at, l.id)
              AND e.fiscal_year = t.fiscal_year AND e.account_key = t.account_key
              AND e.txn_date = t.txn_date AND e.amount_cents = t.amount_cents
              AND coalesce(e.name, '') = coalesce(t.name, '') AND coalesce(e.memo, '') = coalesce(t.memo, '')
              AND coalesce(e.txn_number, '') = coalesce(t.txn_number, ''))`);
    });
  },
  async countDuplicates(ledgerId) {
    const db = await pgDb();
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(glTransactions).where(and(eq(glTransactions.ledgerId, ledgerId), eq(glTransactions.duplicate, true)));
    return r?.n ?? 0;
  },
  async ledgerRows(q) {
    const db = await pgDb();
    const pageSize = Math.min(Math.max(q.pageSize ?? PAGE_SIZE, 1), 500);
    const where = rowsWhere(q);
    const [{ n: total }] = await db.select({ n: sql<number>`count(*)::int` }).from(glTransactions).where(where);
    let page = Math.max(0, Math.floor(q.page ?? 0));
    if (q.around && q.around > 0) {
      const [{ n: before }] = await db.select({ n: sql<number>`count(*)::int` }).from(glTransactions).where(and(where, sql`${glTransactions.rowNo} < ${q.around}`));
      page = Math.floor(before / pageSize);
    }
    const rows = await db.select().from(glTransactions).where(where).orderBy(asc(glTransactions.rowNo)).limit(pageSize).offset(page * pageSize);
    return { rows, total, page, pageSize };
  },
  async accountTotals(ledgerId, fy) {
    const db = await pgDb();
    const where = fy ? and(eq(glTransactions.ledgerId, ledgerId), eq(glTransactions.fiscalYear, fy)) : eq(glTransactions.ledgerId, ledgerId);
    const rows = await db
      .select({
        accountKey: glTransactions.accountKey,
        account: sql<string>`min(${glTransactions.account})`,
        lines: sql<number>`count(*)::int`,
        netCents: sql<number>`coalesce(sum(${glTransactions.amountCents}), 0)::bigint`,
      })
      .from(glTransactions)
      .where(where)
      .groupBy(glTransactions.accountKey)
      .orderBy(desc(sql`count(*)`));
    return rows.map((r) => ({ ...r, netCents: Number(r.netCents) }));
  },
  async findRow(ledgerId, rowNo) {
    const db = await pgDb();
    const [row] = await db.select().from(glTransactions).where(and(eq(glTransactions.ledgerId, ledgerId), eq(glTransactions.rowNo, rowNo))).limit(1);
    return row;
  },

  async orphanLinksOfLedger(ledgerId) {
    const db = await pgDb();
    const res = await db
      .update(glTraceLinks)
      .set({ state: "orphaned", updatedAt: new Date() } as any)
      .where(and(eq(glTraceLinks.ledgerId, ledgerId), inArray(glTraceLinks.state, ["confirmed", "rejected"])))
      .returning({ id: glTraceLinks.id });
    // Proposals point at rows that no longer exist: they go.
    await db.delete(glTraceLinks).where(and(eq(glTraceLinks.ledgerId, ledgerId), eq(glTraceLinks.state, "proposed")));
    return res.length;
  },
  async reattachOrphans(dealId, ledgerId) {
    const db = await pgDb();
    const res = await db.execute(sql`
      UPDATE gl_trace_links k SET ledger_id = m.ledger_id, row_no = m.row_no, state = 'confirmed', updated_at = now()
      FROM (
        SELECT DISTINCT ON (k2.id) k2.id AS link_id, t.ledger_id, t.row_no
        FROM gl_trace_links k2
        JOIN gl_transactions t ON t.ledger_id = ${ledgerId} AND t.deal_id = ${dealId}
          AND t.txn_date = k2.txn_date AND t.account = k2.account AND t.amount_cents = k2.amount_cents
          AND coalesce(t.name, '') = coalesce(k2.name, '') AND coalesce(t.memo, '') = coalesce(k2.memo, '')
        WHERE k2.deal_id = ${dealId} AND k2.state = 'orphaned' AND k2.document_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM gl_trace_links x WHERE x.trace_id = k2.trace_id AND x.ledger_id = t.ledger_id AND x.row_no = t.row_no)
        ORDER BY k2.id, t.row_no
      ) m
      WHERE k.id = m.link_id
      RETURNING k.id`);
    return Array.isArray(res) ? res.length : ((res as any)?.rowCount ?? 0);
  },
  async linksOfDeal(dealId) {
    const db = await pgDb();
    return db.select().from(glTraceLinks).where(eq(glTraceLinks.dealId, dealId));
  },
};

// ── Memory (tests; GL_STORE=memory locally) ──────────────────────────────

let seq = 0;
const newId = () => `mem-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface MemoryStoreData {
  tracing: GlTracing[];
  ledgers: GlLedger[];
  transactions: GlTransaction[];
  links: GlTraceLink[];
}

export function memoryStore(data: MemoryStoreData = { tracing: [], ledgers: [], transactions: [], links: [] }): GlStore & { data: MemoryStoreData } {
  const now = () => new Date();
  const matches = (t: GlTransaction, q: LedgerRowsQuery) => {
    if (t.ledgerId !== q.ledgerId) return false;
    if (q.fy && t.fiscalYear !== q.fy) return false;
    if (q.accountKey && t.accountKey !== q.accountKey) return false;
    const term = (q.q ?? "").trim().slice(0, 100).toLowerCase();
    if (term) {
      const cents = /\d/.test(term) ? parseMoneyToCents(term) : null;
      const hay = [t.account, t.name ?? "", t.memo ?? "", t.txnNumber ?? ""].map((s) => s.toLowerCase());
      if (!hay.some((h) => h.includes(term)) && !(cents !== null && Math.abs(t.amountCents) === Math.abs(cents))) return false;
    }
    return true;
  };
  const store: GlStore & { data: MemoryStoreData } = {
    data,
    async getTracing(dealId) { return data.tracing.find((t) => t.dealId === dealId); },
    async ensureTracing(dealId, fiscalYearEnd) {
      let row = data.tracing.find((t) => t.dealId === dealId);
      if (!row) {
        row = {
          id: newId(), dealId, fiscalYearEnd, analysisId: null, syncedFingerprint: null, requestedAt: null, requestedBy: null,
          recipients: null, sellerMessage: null, lastRemindedAt: null, withdrawnAt: null, sellerDoneAt: null, sellerConfirmation: null,
          cantGetLedger: null, accountantRequest: null, sellerSuggestions: [], emailLinkSends: null, tieOut: null, tieOutAccepted: {},
          accountClasses: {}, waived: null, reviewedAt: null, requireBeforeCim: false, published: null, publishedAt: null, publishedBy: null,
          aiDay: null, aiBrokerMapping: 0, aiBrokerRanking: 0, aiSellerMapping: 0, aiSellerRanking: 0, createdAt: now(), updatedAt: now(),
        } as GlTracing;
        data.tracing.push(row);
      }
      return row;
    },
    async updateTracing(dealId, patch) {
      const row = data.tracing.find((t) => t.dealId === dealId);
      if (!row) return undefined;
      Object.assign(row, patch, { updatedAt: now() });
      return row;
    },
    async createLedger(row) {
      if (data.ledgers.some((l) => l.documentId === row.documentId)) throw new Error("duplicate key value violates unique constraint \"gl_ledgers_document_uq\"");
      const created = {
        id: newId(), role: "ledger", status: "reading", software: null, basis: null, layout: null, layoutBy: null, headerFingerprint: null,
        fiscalYearEndUsed: "12-31", periodStart: null, periodEnd: null, years: null, rowCount: 0, accountCount: 0, duplicateCount: 0,
        skippedCount: 0, progress: null, attempts: 0, problems: [], failure: null, uploadedBy: "broker", sharedWithSellerByBroker: false,
        showStaffNames: false, allowOriginalDownload: false, createdAt: new Date(Date.now() + data.ledgers.length), updatedAt: now(),
        ...row,
      } as GlLedger;
      data.ledgers.push(created);
      return created;
    },
    async getLedger(id) { return data.ledgers.find((l) => l.id === id); },
    async getLedgerByDocument(documentId) { return data.ledgers.find((l) => l.documentId === documentId); },
    async listLedgers(dealId) { return data.ledgers.filter((l) => l.dealId === dealId).sort((a, b) => +a.createdAt - +b.createdAt); },
    async listReadingLedgers() { return data.ledgers.filter((l) => l.status === "reading"); },
    async updateLedger(id, patch) {
      const row = data.ledgers.find((l) => l.id === id);
      if (!row) return undefined;
      Object.assign(row, patch, { updatedAt: now() });
      return row;
    },
    async deleteLedger(id) { data.ledgers = data.ledgers.filter((l) => l.id !== id); },
    async insertTransactions(rows) {
      for (const r of rows) {
        if (data.transactions.some((t) => t.ledgerId === r.ledgerId && t.rowNo === r.rowNo)) throw new Error("duplicate key value violates unique constraint \"gl_transactions_ledger_row_uq\"");
        data.transactions.push({ id: newId(), sheet: null, accountNumber: null, accountType: null, name: null, memo: null, txnType: null, txnNumber: null, debitCents: null, creditCents: null, duplicate: false, sensitiveHint: null, ...r } as GlTransaction);
      }
    },
    async deleteTransactionsOfLedger(ledgerId) {
      const before = data.transactions.length;
      data.transactions = data.transactions.filter((t) => t.ledgerId !== ledgerId);
      return before - data.transactions.length;
    },
    async recomputeDuplicates(dealId) {
      const ledgers = new Map(data.ledgers.map((l) => [l.id, l]));
      const deal = data.transactions.filter((t) => t.dealId === dealId);
      for (const t of deal) t.duplicate = false;
      const sig = (t: GlTransaction) => [t.fiscalYear, t.accountKey, t.txnDate, t.amountCents, t.name ?? "", t.memo ?? "", t.txnNumber ?? ""].join("\u0001");
      const order = (l: GlLedger) => `${new Date(l.createdAt).toISOString()}|${l.id}`;
      // Each signature → the earliest ready ledger it appears in.
      const first = new Map<string, string>();
      for (const t of deal) {
        const l = ledgers.get(t.ledgerId);
        if (!l || l.status !== "ready") continue;
        const k = sig(t);
        const prev = first.get(k);
        if (!prev || order(l) < prev) first.set(k, order(l));
      }
      for (const t of deal) {
        const l = ledgers.get(t.ledgerId);
        if (!l) continue;
        const earliest = first.get(sig(t));
        if (earliest && earliest < order(l)) t.duplicate = true;
      }
    },
    async countDuplicates(ledgerId) { return data.transactions.filter((t) => t.ledgerId === ledgerId && t.duplicate).length; },
    async ledgerRows(q) {
      const pageSize = Math.min(Math.max(q.pageSize ?? PAGE_SIZE, 1), 500);
      const all = data.transactions.filter((t) => matches(t, q)).sort((a, b) => a.rowNo - b.rowNo);
      let page = Math.max(0, Math.floor(q.page ?? 0));
      if (q.around && q.around > 0) page = Math.floor(all.filter((t) => t.rowNo < q.around!).length / pageSize);
      return { rows: all.slice(page * pageSize, page * pageSize + pageSize), total: all.length, page, pageSize };
    },
    async accountTotals(ledgerId, fy) {
      const map = new Map<string, LedgerAccountTotal>();
      for (const t of data.transactions) {
        if (t.ledgerId !== ledgerId || (fy && t.fiscalYear !== fy)) continue;
        const a = map.get(t.accountKey) ?? { accountKey: t.accountKey, account: t.account, lines: 0, netCents: 0 };
        a.lines++;
        a.netCents += t.amountCents;
        if (t.account < a.account) a.account = t.account;
        map.set(t.accountKey, a);
      }
      return Array.from(map.values()).sort((a, b) => b.lines - a.lines);
    },
    async findRow(ledgerId, rowNo) { return data.transactions.find((t) => t.ledgerId === ledgerId && t.rowNo === rowNo); },
    async orphanLinksOfLedger(ledgerId) {
      let n = 0;
      data.links = data.links.filter((k) => !(k.ledgerId === ledgerId && k.state === "proposed"));
      for (const k of data.links) if (k.ledgerId === ledgerId && (k.state === "confirmed" || k.state === "rejected")) { k.state = "orphaned"; n++; }
      return n;
    },
    async reattachOrphans(dealId, ledgerId) {
      let n = 0;
      for (const k of data.links) {
        if (k.dealId !== dealId || k.state !== "orphaned" || k.documentId) continue;
        const t = data.transactions
          .filter((x) => x.ledgerId === ledgerId && x.txnDate === k.txnDate && x.account === k.account && x.amountCents === k.amountCents && (x.name ?? "") === (k.name ?? "") && (x.memo ?? "") === (k.memo ?? ""))
          .filter((x) => !data.links.some((o) => o.traceId === k.traceId && o.ledgerId === x.ledgerId && o.rowNo === x.rowNo))
          .sort((a, b) => a.rowNo - b.rowNo)[0];
        if (!t) continue;
        k.ledgerId = t.ledgerId;
        k.rowNo = t.rowNo;
        k.state = "confirmed";
        n++;
      }
      return n;
    },
    async linksOfDeal(dealId) { return data.links.filter((k) => k.dealId === dealId); },
  };
  return store;
}

/** The store in use: Postgres, or the memory store when GL_STORE=memory outside production. */
let active: GlStore | null = null;
export function glStore(): GlStore {
  if (active) return active;
  if (process.env.GL_STORE === "memory" && process.env.NODE_ENV !== "production") {
    console.warn("[gl] memory store — nothing is saved");
    active = memoryStore();
  } else {
    active = pgStore;
  }
  return active;
}

/** Tests: use this store. */
export function _setGlStoreForTests(store: GlStore | null): void {
  active = store;
}
