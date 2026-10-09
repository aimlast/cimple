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
  glLedgers, glTransactions, glTracing, glTraceLinks, glAddbackTraces,
  type GlLedger, type InsertGlLedger, type GlTransaction, type InsertGlTransaction, type GlTracing, type GlTraceLink,
  type GlAddbackTrace, type InsertGlAddbackTrace, type InsertGlTraceLink,
} from "@shared/schema";
import { escapeLike, escapeRegexTerm, parseMoneyToCents } from "./text";

export interface LedgerRowsQuery {
  ledgerId: string;
  fy?: string | null;
  accountKey?: string | null;
  /** Any of these accounts (a buyer's folded "Other account"); an empty list matches nothing. */
  accountKeys?: string[] | null;
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

  // ── Traced add-backs (pass 2) ──
  listTraces(dealId: string): Promise<GlAddbackTrace[]>;
  getTrace(id: string): Promise<GlAddbackTrace | undefined>;
  /** Insert, or update the analysis-owned fields given, by (deal_id, addback_key). */
  upsertTrace(row: InsertGlAddbackTrace & { dealId: string; addbackKey: string }): Promise<GlAddbackTrace>;
  updateTrace(id: string, patch: Partial<GlAddbackTrace>): Promise<GlAddbackTrace | undefined>;

  // ── Links (pass 2) ──
  linksOfTrace(traceId: string): Promise<GlTraceLink[]>;
  /**
   * A proposal run for one trace: deletes ONLY its `proposed` links in
   * these years, then inserts the new ones ON CONFLICT DO NOTHING — a
   * confirmed or rejected entry is never touched or proposed again.
   */
  replaceProposals(traceId: string, years: string[], rows: InsertGlTraceLink[]): Promise<void>;
  /** One decision on one ledger entry (upsert on trace + ledger + row): confirmed or rejected, with who decided. */
  decideEntryLink(row: InsertGlTraceLink & { traceId: string; ledgerId: string; rowNo: number; state: "confirmed" | "rejected" | "proposed" }): Promise<GlTraceLink>;
  /** Many decisions at once (one statement per 500): the seller's "Tick all", "Yes, that's right". */
  decideEntryLinks(rows: Array<InsertGlTraceLink & { traceId: string; ledgerId: string; rowNo: number; state: "confirmed" | "rejected" | "proposed" }>): Promise<void>;
  /** "Untick": a confirmed entry goes back to a proposal when Cimple had proposed it, else the link goes. */
  removeEntryLink(traceId: string, ledgerId: string, rowNo: number): Promise<void>;
  removeEntryLinks(traceId: string, refs: Array<{ ledgerId: string; rowNo: number }>): Promise<void>;
  /** A document link for one year (upsert on trace + document + year). */
  upsertDocLink(row: InsertGlTraceLink & { traceId: string; documentId: string; fiscalYear: string }): Promise<GlTraceLink>;
  deleteDocLinks(where: { documentId?: string; traceId?: string; fiscalYear?: string }): Promise<number>;
  setLinkShowDetails(ids: string[], showDetails: boolean | null): Promise<void>;
  updateLink(id: string, patch: Partial<GlTraceLink>): Promise<void>;

  // ── Entries for matching, search and tie-out (pass 2) ──
  /** Candidate entries for one fiscal year (§7.1): by account, a term in account/name/memo, or an amount. Never copies. */
  candidateRows(q: CandidateQuery): Promise<GlTransaction[]>;
  /** Entries by (ledger, row) — only of the deal. */
  rowsForKeys(dealId: string, keys: Array<{ ledgerId: string; rowNo: number }>): Promise<GlTransaction[]>;
  /** A search over the given ledgers (seller "Add an entry we missed", broker search) — at most `limit` rows. */
  searchRows(q: SearchQuery): Promise<GlTransaction[]>;
  /** Per fiscal year and account: entries and net amount over the given ledgers (copies left out). */
  dealAccountTotals(dealId: string, ledgerIds: string[]): Promise<DealAccountTotal[]>;
  /** Every entry of these accounts in one year (whole-account proposals). */
  accountRows(dealId: string, ledgerIds: string[], fiscalYear: string, accountKeys: string[]): Promise<GlTransaction[]>;
  /** The fiscal-year end changed (D26): entries and links move to the right years, proposals go — one transaction. */
  changeFiscalYearEnd(dealId: string, fiscalYearEnd: string): Promise<void>;
  /** Per ledger and fiscal year: entries, debits, credits, accounts, first and last date (copies included, as when read). */
  ledgerYearSummaries(dealId: string): Promise<Array<{ ledgerId: string; fiscalYear: string; lines: number; debitCents: number; creditCents: number; accounts: number; firstDate: string; lastDate: string }>>;

  // ── Buyers (pass 3) ──
  /**
   * A buyer's search of one ledger (§9.3): `q` matched only against fields
   * never withheld (account, number, the amount when it is money) — and the
   * name / description only on accounts that aren't payroll-type. At most
   * `limit` (2,000) candidates, in file order; the caller re-checks each on
   * the masked view.
   */
  buyerSearchRows(q: { ledgerId: string; fy?: string | null; accountKey?: string | null; accountKeys?: string[] | null; q: string; limit?: number }): Promise<GlTransaction[]>;
  /**
   * "Move the ticked entries to…" (an add-back renamed by a re-run of the
   * analysis): the decided links of `from` for these years move to `to`;
   * a proposal on `to` for the same entry gives way. Returns how many moved.
   */
  moveDecidedLinks(fromTraceId: string, toTraceId: string, years: string[]): Promise<number>;
  /** The atomic AI budget reservation (§7.4): true when this call fits today's cap. */
  reserveAi(dealId: string, kind: GlAiKind, cap: number, day: string): Promise<boolean>;
}

/** The four AI counters of gl_tracing (broker / seller × mapping / ranking). */
export type GlAiKind = "broker_mapping" | "broker_ranking" | "seller_mapping" | "seller_ranking";

/** Payroll-type account keys (SQL and the memory twin agree; a little broader than sensitive.ts's PAYROLL_ACCOUNT_RE — safe: more rows lose name search). */
export const PAYROLL_KEY_SQL = "(wage|salar|payroll|remuneration|employee benefit|bonus|commission|vacation pay|cpp|ei expense|wsib)";
const PAYROLL_KEY_RE = new RegExp(PAYROLL_KEY_SQL, "i");

export interface CandidateQuery {
  dealId: string;
  fiscalYear: string;
  ledgerIds: string[];
  accountKeys: string[];
  /** Plain words (each escaped); matched case-insensitively anywhere in account / name / memo. */
  terms: string[];
  /** Amounts in cents; an entry within 1% matches. */
  amounts: number[];
  limit?: number;
}

export interface SearchQuery {
  dealId: string;
  ledgerIds: string[];
  fiscalYears?: string[] | null;
  q?: string | null;
  minCents?: number | null;
  maxCents?: number | null;
  accountKey?: string | null;
  limit?: number;
}

export interface DealAccountTotal {
  fiscalYear: string;
  accountKey: string;
  account: string;
  accountType: string | null;
  accountNumber: string | null;
  lines: number;
  netCents: number;
}

/** "MM-DD" fiscal-year end → the fiscal year of a yyyy-mm-dd date, in SQL (D26). */
function fiscalYearSql(dateCol: SQL, fye: string): SQL {
  return sql`CASE WHEN substr(${dateCol}, 6, 5) > ${fye} THEN (substr(${dateCol}, 1, 4)::int + 1)::text ELSE substr(${dateCol}, 1, 4) END`;
}

/** The terms of a candidate query as one case-insensitive pattern (each term a literal). */
export function termsPattern(terms: string[]): string | null {
  const clean = Array.from(new Set(terms.map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 3 && t.length <= 40))).slice(0, 40);
  return clean.length ? clean.map(escapeRegexTerm).join("|") : null;
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
  if (q.accountKeys) parts.push(q.accountKeys.length ? inArray(glTransactions.accountKey, q.accountKeys) : sql`false`);
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

  async listTraces(dealId) {
    const db = await pgDb();
    return db.select().from(glAddbackTraces).where(eq(glAddbackTraces.dealId, dealId)).orderBy(asc(glAddbackTraces.createdAt));
  },
  async getTrace(id) {
    const db = await pgDb();
    const [row] = await db.select().from(glAddbackTraces).where(eq(glAddbackTraces.id, id)).limit(1);
    return row;
  },
  async upsertTrace(row) {
    const db = await pgDb();
    const { dealId, addbackKey, ...rest } = row as any;
    const set: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    delete set.id;
    delete set.createdAt;
    const [out] = await db
      .insert(glAddbackTraces)
      .values({ dealId, addbackKey, ...rest } as any)
      .onConflictDoUpdate({ target: [glAddbackTraces.dealId, glAddbackTraces.addbackKey], set: set as any })
      .returning();
    return out;
  },
  async updateTrace(id, patch) {
    const db = await pgDb();
    const [row] = await db.update(glAddbackTraces).set({ ...patch, updatedAt: new Date() } as any).where(eq(glAddbackTraces.id, id)).returning();
    return row;
  },

  async linksOfTrace(traceId) {
    const db = await pgDb();
    return db.select().from(glTraceLinks).where(eq(glTraceLinks.traceId, traceId));
  },
  async replaceProposals(traceId, years, rows) {
    const db = await pgDb();
    await db.transaction(async (tx) => {
      if (years.length) {
        await tx.delete(glTraceLinks).where(and(eq(glTraceLinks.traceId, traceId), eq(glTraceLinks.state, "proposed"), inArray(glTraceLinks.fiscalYear, years)));
      }
      for (let i = 0; i < rows.length; i += 500) {
        await tx.insert(glTraceLinks).values(rows.slice(i, i + 500) as any).onConflictDoNothing();
      }
    });
  },
  async decideEntryLink(row) {
    const db = await pgDb();
    // Hand-written upsert (the partial unique index needs its WHERE): one statement, no lock.
    const res = await db.execute(sql`
      INSERT INTO gl_trace_links (trace_id, deal_id, fiscal_year, ledger_id, row_no, txn_date, account, name, memo, amount_cents, state, proposed_by, confidence, reason, decided_by, decided_by_member, decided_at)
      VALUES (${row.traceId}, ${row.dealId}, ${row.fiscalYear}, ${row.ledgerId}, ${row.rowNo}, ${row.txnDate ?? null}, ${row.account ?? null}, ${row.name ?? null}, ${row.memo ?? null},
              ${row.amountCents}, ${row.state}, ${row.proposedBy ?? null}, ${row.confidence ?? null}, ${row.reason ?? null}, ${row.decidedBy ?? null}, ${row.decidedByMember ?? null}, ${row.decidedAt ? new Date(row.decidedAt as any).toISOString() : null}::timestamp)
      ON CONFLICT (trace_id, ledger_id, row_no) WHERE ledger_id IS NOT NULL
      DO UPDATE SET state = EXCLUDED.state, decided_by = EXCLUDED.decided_by, decided_by_member = EXCLUDED.decided_by_member,
                    decided_at = EXCLUDED.decided_at, fiscal_year = EXCLUDED.fiscal_year, updated_at = now()
      RETURNING id`);
    const id = ((res as any).rows ?? res)[0]?.id as string;
    const [out] = await db.select().from(glTraceLinks).where(eq(glTraceLinks.id, id)).limit(1);
    return out;
  },
  async removeEntryLink(traceId, ledgerId, rowNo) {
    const db = await pgDb();
    const where = and(eq(glTraceLinks.traceId, traceId), eq(glTraceLinks.ledgerId, ledgerId), eq(glTraceLinks.rowNo, rowNo));
    // Cimple had proposed it → it goes back to a proposal; ticked from a search → the link goes.
    await db.update(glTraceLinks)
      .set({ state: "proposed", decidedBy: null, decidedByMember: null, decidedAt: null, updatedAt: new Date() } as any)
      .where(and(where, inArray(glTraceLinks.proposedBy, ["rules", "ai"])));
    await db.delete(glTraceLinks).where(and(where, sql`coalesce(${glTraceLinks.proposedBy}, '') NOT IN ('rules', 'ai')`));
  },
  async decideEntryLinks(rows) {
    if (rows.length === 0) return;
    const db = await pgDb();
    const ts = (d: unknown) => (d ? new Date(d as any).toISOString() : null);
    for (let i = 0; i < rows.length; i += 500) {
      const values = rows.slice(i, i + 500).map((r) => sql`(${r.traceId}, ${r.dealId}, ${r.fiscalYear}, ${r.ledgerId}, ${r.rowNo}, ${r.txnDate ?? null}, ${r.account ?? null}, ${r.name ?? null}, ${r.memo ?? null},
        ${r.amountCents}, ${r.state}, ${r.proposedBy ?? null}, ${r.confidence ?? null}, ${r.reason ?? null}, ${r.decidedBy ?? null}, ${r.decidedByMember ?? null}, ${ts(r.decidedAt)}::timestamp)`);
      await db.execute(sql`
        INSERT INTO gl_trace_links (trace_id, deal_id, fiscal_year, ledger_id, row_no, txn_date, account, name, memo, amount_cents, state, proposed_by, confidence, reason, decided_by, decided_by_member, decided_at)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (trace_id, ledger_id, row_no) WHERE ledger_id IS NOT NULL
        DO UPDATE SET state = EXCLUDED.state, decided_by = EXCLUDED.decided_by, decided_by_member = EXCLUDED.decided_by_member,
                      decided_at = EXCLUDED.decided_at, fiscal_year = EXCLUDED.fiscal_year, updated_at = now()`);
    }
  },
  async removeEntryLinks(traceId, refs) {
    if (refs.length === 0) return;
    const db = await pgDb();
    const pairs = sql.join(refs.slice(0, 2000).map((r) => sql`(${r.ledgerId}, ${r.rowNo})`), sql`, `);
    const where = sql`${glTraceLinks.traceId} = ${traceId} AND (${glTraceLinks.ledgerId}, ${glTraceLinks.rowNo}) IN (${pairs})`;
    await db.update(glTraceLinks)
      .set({ state: "proposed", decidedBy: null, decidedByMember: null, decidedAt: null, updatedAt: new Date() } as any)
      .where(and(where, inArray(glTraceLinks.proposedBy, ["rules", "ai"])));
    await db.delete(glTraceLinks).where(and(where, sql`coalesce(${glTraceLinks.proposedBy}, '') NOT IN ('rules', 'ai')`));
  },
  async upsertDocLink(row) {
    const db = await pgDb();
    const res = await db.execute(sql`
      INSERT INTO gl_trace_links (trace_id, deal_id, fiscal_year, document_id, doc_amount_check, amount_cents, state, proposed_by, decided_by, decided_by_member, decided_at)
      VALUES (${row.traceId}, ${row.dealId}, ${row.fiscalYear}, ${row.documentId}, ${row.docAmountCheck ?? null}, ${row.amountCents}, ${row.state ?? "confirmed"},
              ${row.proposedBy ?? "seller_document"}, ${row.decidedBy ?? null}, ${row.decidedByMember ?? null}, ${row.decidedAt ? new Date(row.decidedAt as any).toISOString() : null}::timestamp)
      ON CONFLICT (trace_id, document_id, fiscal_year) WHERE document_id IS NOT NULL
      DO UPDATE SET amount_cents = EXCLUDED.amount_cents, doc_amount_check = EXCLUDED.doc_amount_check, state = EXCLUDED.state,
                    decided_by = EXCLUDED.decided_by, decided_by_member = EXCLUDED.decided_by_member, decided_at = EXCLUDED.decided_at, updated_at = now()
      RETURNING id`);
    const id = ((res as any).rows ?? res)[0]?.id as string;
    const [out] = await db.select().from(glTraceLinks).where(eq(glTraceLinks.id, id)).limit(1);
    return out;
  },
  async deleteDocLinks(where) {
    const db = await pgDb();
    const parts: SQL[] = [sql`${glTraceLinks.documentId} IS NOT NULL`];
    if (where.documentId) parts.push(eq(glTraceLinks.documentId, where.documentId));
    if (where.traceId) parts.push(eq(glTraceLinks.traceId, where.traceId));
    if (where.fiscalYear) parts.push(eq(glTraceLinks.fiscalYear, where.fiscalYear));
    if (parts.length === 1) return 0;
    const res = await db.delete(glTraceLinks).where(and(...parts)).returning({ id: glTraceLinks.id });
    return res.length;
  },
  async setLinkShowDetails(ids, showDetails) {
    if (ids.length === 0) return;
    const db = await pgDb();
    await db.update(glTraceLinks).set({ showDetails, updatedAt: new Date() } as any).where(inArray(glTraceLinks.id, ids));
  },

  async updateLink(id, patch) {
    const db = await pgDb();
    await db.update(glTraceLinks).set({ ...patch, updatedAt: new Date() } as any).where(eq(glTraceLinks.id, id));
  },
  async candidateRows(q) {
    if (q.ledgerIds.length === 0) return [];
    const db = await pgDb();
    const ors: SQL[] = [];
    if (q.accountKeys.length) ors.push(inArray(glTransactions.accountKey, q.accountKeys));
    const pattern = termsPattern(q.terms);
    if (pattern) {
      ors.push(sql`${glTransactions.account} ~* ${pattern}`);
      ors.push(sql`coalesce(${glTransactions.name}, '') ~* ${pattern}`);
      ors.push(sql`coalesce(${glTransactions.memo}, '') ~* ${pattern}`);
    }
    for (const a of q.amounts.slice(0, 12)) {
      const lo = Math.floor(Math.abs(a) * 0.99);
      const hi = Math.ceil(Math.abs(a) * 1.01);
      ors.push(sql`abs(${glTransactions.amountCents}) BETWEEN ${lo} AND ${hi}`);
    }
    if (ors.length === 0) return [];
    return db.select().from(glTransactions)
      .where(and(eq(glTransactions.dealId, q.dealId), eq(glTransactions.fiscalYear, q.fiscalYear), eq(glTransactions.duplicate, false), inArray(glTransactions.ledgerId, q.ledgerIds), sql`(${sql.join(ors, sql` OR `)})`))
      .orderBy(asc(glTransactions.txnDate), asc(glTransactions.rowNo))
      .limit(Math.min(q.limit ?? 3000, 3000));
  },
  async rowsForKeys(dealId, keys) {
    if (keys.length === 0) return [];
    const db = await pgDb();
    const pairs = keys.slice(0, 2000).map((k) => sql`(${k.ledgerId}, ${k.rowNo})`);
    return db.select().from(glTransactions)
      .where(and(eq(glTransactions.dealId, dealId), sql`(${glTransactions.ledgerId}, ${glTransactions.rowNo}) IN (${sql.join(pairs, sql`, `)})`));
  },
  async searchRows(q) {
    if (q.ledgerIds.length === 0) return [];
    const db = await pgDb();
    const parts: SQL[] = [eq(glTransactions.dealId, q.dealId), inArray(glTransactions.ledgerId, q.ledgerIds), eq(glTransactions.duplicate, false)];
    if (q.fiscalYears && q.fiscalYears.length) parts.push(inArray(glTransactions.fiscalYear, q.fiscalYears));
    if (q.accountKey) parts.push(eq(glTransactions.accountKey, q.accountKey));
    if (q.minCents !== null && q.minCents !== undefined) parts.push(sql`abs(${glTransactions.amountCents}) >= ${Math.abs(q.minCents)}`);
    if (q.maxCents !== null && q.maxCents !== undefined) parts.push(sql`abs(${glTransactions.amountCents}) <= ${Math.abs(q.maxCents)}`);
    const term = (q.q ?? "").trim().slice(0, 100);
    if (term) parts.push(searchCondition(term));
    return db.select().from(glTransactions).where(and(...parts)).orderBy(asc(glTransactions.txnDate), asc(glTransactions.rowNo)).limit(Math.min(q.limit ?? 50, 200));
  },
  async dealAccountTotals(dealId, ledgerIds) {
    if (ledgerIds.length === 0) return [];
    const db = await pgDb();
    const rows = await db
      .select({
        fiscalYear: glTransactions.fiscalYear,
        accountKey: glTransactions.accountKey,
        account: sql<string>`min(${glTransactions.account})`,
        accountType: sql<string | null>`min(${glTransactions.accountType})`,
        accountNumber: sql<string | null>`min(${glTransactions.accountNumber})`,
        lines: sql<number>`count(*)::int`,
        netCents: sql<number>`coalesce(sum(${glTransactions.amountCents}), 0)::bigint`,
      })
      .from(glTransactions)
      .where(and(eq(glTransactions.dealId, dealId), inArray(glTransactions.ledgerId, ledgerIds), eq(glTransactions.duplicate, false)))
      .groupBy(glTransactions.fiscalYear, glTransactions.accountKey);
    return rows.map((r) => ({ ...r, netCents: Number(r.netCents) }));
  },
  async accountRows(dealId, ledgerIds, fiscalYear, accountKeys) {
    if (ledgerIds.length === 0 || accountKeys.length === 0) return [];
    const db = await pgDb();
    return db.select().from(glTransactions)
      .where(and(eq(glTransactions.dealId, dealId), inArray(glTransactions.ledgerId, ledgerIds), eq(glTransactions.fiscalYear, fiscalYear), inArray(glTransactions.accountKey, accountKeys), eq(glTransactions.duplicate, false)))
      .orderBy(asc(glTransactions.txnDate), asc(glTransactions.rowNo))
      .limit(5000);
  },
  async changeFiscalYearEnd(dealId, fye) {
    const db = await pgDb();
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE gl_transactions SET fiscal_year = ${fiscalYearSql(sql`txn_date`, fye)} WHERE deal_id = ${dealId}`);
      await tx.execute(sql`UPDATE gl_trace_links SET fiscal_year = ${fiscalYearSql(sql`txn_date`, fye)}, updated_at = now() WHERE deal_id = ${dealId} AND document_id IS NULL AND txn_date IS NOT NULL`);
      await tx.execute(sql`DELETE FROM gl_trace_links WHERE deal_id = ${dealId} AND state = 'proposed'`);
      await tx.execute(sql`UPDATE gl_addback_traces SET proposal_fingerprint = NULL, updated_at = now() WHERE deal_id = ${dealId}`);
      await tx.execute(sql`UPDATE gl_ledgers SET fiscal_year_end_used = ${fye}, updated_at = now() WHERE deal_id = ${dealId}`);
      await tx.execute(sql`UPDATE gl_tracing SET fiscal_year_end = ${fye}, synced_fingerprint = NULL, tie_out = NULL, updated_at = now() WHERE deal_id = ${dealId}`);
    });
  },
  async buyerSearchRows(q) {
    const db = await pgDb();
    const term = q.q.trim().slice(0, 100).toLowerCase();
    if (!term) return [];
    const like = `%${escapeLike(term)}%`;
    const cents = /\d/.test(term) ? parseMoneyToCents(term) : null;
    const parts: SQL[] = [eq(glTransactions.ledgerId, q.ledgerId)];
    if (q.fy) parts.push(eq(glTransactions.fiscalYear, q.fy));
    if (q.accountKey) parts.push(eq(glTransactions.accountKey, q.accountKey));
    if (q.accountKeys) parts.push(q.accountKeys.length ? inArray(glTransactions.accountKey, q.accountKeys) : sql`false`);
    const never = sql`(lower(${glTransactions.account}) LIKE ${like} ESCAPE '\\' OR lower(coalesce(${glTransactions.txnNumber}, '')) LIKE ${like} ESCAPE '\\'${cents !== null ? sql` OR abs(${glTransactions.amountCents}) = ${Math.abs(cents)}` : sql``})`;
    const words = sql`(${glTransactions.accountKey} !~* ${PAYROLL_KEY_SQL} AND (lower(coalesce(${glTransactions.name}, '')) LIKE ${like} ESCAPE '\\' OR lower(coalesce(${glTransactions.memo}, '')) LIKE ${like} ESCAPE '\\'))`;
    parts.push(sql`(${never} OR ${words})`);
    return db.select().from(glTransactions).where(and(...parts)).orderBy(asc(glTransactions.rowNo)).limit(Math.min(q.limit ?? 2000, 2000));
  },
  async moveDecidedLinks(fromTraceId, toTraceId, years) {
    if (years.length === 0) return 0;
    const db = await pgDb();
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM gl_trace_links t
        WHERE t.trace_id = ${toTraceId} AND t.state = 'proposed' AND t.ledger_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM gl_trace_links f WHERE f.trace_id = ${fromTraceId} AND f.state IN ('confirmed', 'rejected')
                      AND f.ledger_id = t.ledger_id AND f.row_no = t.row_no AND f.fiscal_year IN (${sql.join(years.map((y) => sql`${y}`), sql`, `)}))`);
      const res = await tx.execute(sql`
        UPDATE gl_trace_links f SET trace_id = ${toTraceId}, updated_at = now()
        WHERE f.trace_id = ${fromTraceId} AND f.state IN ('confirmed', 'rejected') AND f.fiscal_year IN (${sql.join(years.map((y) => sql`${y}`), sql`, `)})
          AND NOT EXISTS (SELECT 1 FROM gl_trace_links x WHERE x.trace_id = ${toTraceId}
                          AND ((f.ledger_id IS NOT NULL AND x.ledger_id = f.ledger_id AND x.row_no = f.row_no)
                            OR (f.document_id IS NOT NULL AND x.document_id = f.document_id AND x.fiscal_year = f.fiscal_year)))
        RETURNING f.id`);
      return Array.isArray(res) ? res.length : ((res as unknown as { rowCount?: number | null }).rowCount ?? 0);
    });
  },
  async reserveAi(dealId, kind, cap, day) {
    const db = await pgDb();
    // One statement (§7.4): a new UTC day resets all four counters; otherwise only under the cap.
    // Every SET expression reads the row as it was, so ai_day below is the old day.
    const COLS = { broker_mapping: "ai_broker_mapping", broker_ranking: "ai_broker_ranking", seller_mapping: "ai_seller_mapping", seller_ranking: "ai_seller_ranking" } as const;
    const col = sql.raw(COLS[kind]);
    const sets: SQL[] = [
      sql`ai_day = ${day}`,
      sql`updated_at = now()`,
      sql`${col} = CASE WHEN ai_day = ${day} THEN ${col} + 1 ELSE 1 END`,
      ...Object.values(COLS).filter((c) => c !== COLS[kind]).map((c) => sql`${sql.raw(c)} = CASE WHEN ai_day = ${day} THEN ${sql.raw(c)} ELSE 0 END`),
    ];
    const res = await db.execute(sql`
      UPDATE gl_tracing SET ${sql.join(sets, sql`, `)}
      WHERE deal_id = ${dealId} AND (ai_day IS DISTINCT FROM ${day} OR ${col} < ${Math.max(0, Math.floor(cap))})
      RETURNING ${col}
    `);
    // postgres-js returns the rows (an array); other drivers a result with rowCount.
    return (Array.isArray(res) ? res.length : ((res as unknown as { rowCount?: number | null }).rowCount ?? 0)) > 0;
  },
  async ledgerYearSummaries(dealId) {
    const db = await pgDb();
    const rows = await db
      .select({
        ledgerId: glTransactions.ledgerId,
        fiscalYear: glTransactions.fiscalYear,
        lines: sql<number>`count(*)::int`,
        debitCents: sql<number>`coalesce(sum(coalesce(${glTransactions.debitCents}, greatest(${glTransactions.amountCents}, 0))), 0)::bigint`,
        creditCents: sql<number>`coalesce(sum(coalesce(${glTransactions.creditCents}, greatest(-${glTransactions.amountCents}, 0))), 0)::bigint`,
        accounts: sql<number>`count(distinct ${glTransactions.accountKey})::int`,
        firstDate: sql<string>`min(${glTransactions.txnDate})`,
        lastDate: sql<string>`max(${glTransactions.txnDate})`,
      })
      .from(glTransactions)
      .where(eq(glTransactions.dealId, dealId))
      .groupBy(glTransactions.ledgerId, glTransactions.fiscalYear);
    return rows.map((r) => ({ ...r, debitCents: Number(r.debitCents), creditCents: Number(r.creditCents) }));
  },
};

// ── Memory (tests; GL_STORE=memory locally) ──────────────────────────────

let seq = 0;
const newId = () => `mem-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function memLink(r: Partial<GlTraceLink> & InsertGlTraceLink): GlTraceLink {
  const at = new Date();
  return {
    id: newId(), ledgerId: null, rowNo: null, documentId: null, docAmountCheck: null, txnDate: null, account: null, name: null, memo: null,
    proposedBy: null, confidence: null, reason: null, decidedBy: null, decidedByMember: null, decidedAt: null, showDetails: null,
    createdAt: at, updatedAt: at, ...r,
  } as GlTraceLink;
}

export interface MemoryStoreData {
  tracing: GlTracing[];
  ledgers: GlLedger[];
  transactions: GlTransaction[];
  links: GlTraceLink[];
  traces: GlAddbackTrace[];
}

/** The fiscal year of a date for a fiscal-year end, the same way the SQL does it. */
function fiscalYearJs(date: string, fye: string): string {
  return date.slice(5, 10) > fye ? String(Number(date.slice(0, 4)) + 1) : date.slice(0, 4);
}

export function memoryStore(data: MemoryStoreData = { tracing: [], ledgers: [], transactions: [], links: [], traces: [] }): GlStore & { data: MemoryStoreData } {
  if (!data.traces) data.traces = [];
  const now = () => new Date();
  const matches = (t: GlTransaction, q: LedgerRowsQuery) => {
    if (t.ledgerId !== q.ledgerId) return false;
    if (q.fy && t.fiscalYear !== q.fy) return false;
    if (q.accountKey && t.accountKey !== q.accountKey) return false;
    if (q.accountKeys && !q.accountKeys.includes(t.accountKey)) return false;
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
          id: newId(), dealId, fiscalYearEnd, fiscalYearEndByBroker: false, analysisId: null, syncedFingerprint: null, requestedAt: null, requestedBy: null,
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

    async listTraces(dealId) { return data.traces.filter((t) => t.dealId === dealId).sort((a, b) => +a.createdAt - +b.createdAt); },
    async getTrace(id) { return data.traces.find((t) => t.id === id); },
    async upsertTrace(row) {
      const existing = data.traces.find((t) => t.dealId === row.dealId && t.addbackKey === row.addbackKey);
      if (existing) {
        const patch = { ...(row as any) };
        delete patch.id;
        delete patch.createdAt;
        Object.assign(existing, patch, { updatedAt: now() });
        return existing;
      }
      const created = {
        id: newId(), analysisId: null, analysisAddbackId: null, category: null, proof: "ledger", proofByBroker: false, sharePct: null, shareBasis: null,
        shareBasisDoc: null, yearLabels: null, sellerHint: null, privateEvidence: false, sentAt: null, sellerStatus: "not_started", reopenedNote: null,
        sellerNote: null, sellerNoteShown: false, notInLedger: null, question: null, brokerVerdict: null, reviewedAt: null, brokerNote: null,
        brokerNoteShown: false, buyerReason: null, leftOut: null, includeInCim: true, computed: null, proposalFingerprint: null, removedAt: null,
        createdAt: new Date(Date.now() + data.traces.length), updatedAt: now(), ...(row as any),
      } as GlAddbackTrace;
      data.traces.push(created);
      return created;
    },
    async updateTrace(id, patch) {
      const row = data.traces.find((t) => t.id === id);
      if (!row) return undefined;
      Object.assign(row, patch, { updatedAt: now() });
      return row;
    },
    async linksOfTrace(traceId) { return data.links.filter((k) => k.traceId === traceId); },
    async replaceProposals(traceId, years, rows) {
      data.links = data.links.filter((k) => !(k.traceId === traceId && k.state === "proposed" && years.includes(k.fiscalYear)));
      for (const r of rows) {
        const clash = data.links.some((k) =>
          k.traceId === r.traceId && ((r.ledgerId && k.ledgerId === r.ledgerId && k.rowNo === r.rowNo) || (r.documentId && k.documentId === r.documentId && k.fiscalYear === r.fiscalYear)));
        if (clash) continue;
        data.links.push(memLink(r));
      }
    },
    async decideEntryLink(row) {
      const existing = data.links.find((k) => k.traceId === row.traceId && k.ledgerId === row.ledgerId && k.rowNo === row.rowNo);
      if (existing) {
        Object.assign(existing, { state: row.state, decidedBy: row.decidedBy ?? null, decidedByMember: row.decidedByMember ?? null, decidedAt: row.decidedAt ?? null, fiscalYear: row.fiscalYear, updatedAt: now() });
        return existing;
      }
      const created = memLink(row);
      data.links.push(created);
      return created;
    },
    async removeEntryLink(traceId, ledgerId, rowNo) {
      const k = data.links.find((x) => x.traceId === traceId && x.ledgerId === ledgerId && x.rowNo === rowNo);
      if (!k) return;
      if (k.proposedBy === "rules" || k.proposedBy === "ai") Object.assign(k, { state: "proposed", decidedBy: null, decidedByMember: null, decidedAt: null, updatedAt: now() });
      else data.links = data.links.filter((x) => x !== k);
    },
    async decideEntryLinks(rows) {
      for (const r of rows) await store.decideEntryLink(r);
    },
    async removeEntryLinks(traceId, refs) {
      for (const r of refs) await store.removeEntryLink(traceId, r.ledgerId, r.rowNo);
    },
    async upsertDocLink(row) {
      const existing = data.links.find((k) => k.traceId === row.traceId && k.documentId === row.documentId && k.fiscalYear === row.fiscalYear);
      if (existing) {
        Object.assign(existing, { amountCents: row.amountCents, docAmountCheck: row.docAmountCheck ?? null, state: row.state ?? "confirmed", decidedBy: row.decidedBy ?? null, decidedByMember: row.decidedByMember ?? null, decidedAt: row.decidedAt ?? null, updatedAt: now() });
        return existing;
      }
      const created = memLink({ proposedBy: "seller_document", ...row, state: row.state ?? "confirmed" });
      data.links.push(created);
      return created;
    },
    async deleteDocLinks(where) {
      if (!where.documentId && !where.traceId && !where.fiscalYear) return 0;
      const before = data.links.length;
      data.links = data.links.filter((k) => !(k.documentId && (!where.documentId || k.documentId === where.documentId) && (!where.traceId || k.traceId === where.traceId) && (!where.fiscalYear || k.fiscalYear === where.fiscalYear)));
      return before - data.links.length;
    },
    async setLinkShowDetails(ids, showDetails) {
      for (const k of data.links) if (ids.includes(k.id)) Object.assign(k, { showDetails, updatedAt: now() });
    },
    async updateLink(id, patch) {
      const k = data.links.find((x) => x.id === id);
      if (k) Object.assign(k, patch, { updatedAt: now() });
    },
    async candidateRows(q) {
      if (q.ledgerIds.length === 0) return [];
      const pattern = termsPattern(q.terms);
      const re = pattern ? new RegExp(pattern, "i") : null;
      return data.transactions
        .filter((t) => t.dealId === q.dealId && t.fiscalYear === q.fiscalYear && !t.duplicate && q.ledgerIds.includes(t.ledgerId))
        .filter((t) =>
          q.accountKeys.includes(t.accountKey) ||
          (re && (re.test(t.account) || re.test(t.name ?? "") || re.test(t.memo ?? ""))) ||
          q.amounts.slice(0, 12).some((a) => Math.abs(t.amountCents) >= Math.floor(Math.abs(a) * 0.99) && Math.abs(t.amountCents) <= Math.ceil(Math.abs(a) * 1.01)))
        .sort((a, b) => (a.txnDate === b.txnDate ? a.rowNo - b.rowNo : a.txnDate < b.txnDate ? -1 : 1))
        .slice(0, Math.min(q.limit ?? 3000, 3000));
    },
    async rowsForKeys(dealId, keys) {
      return data.transactions.filter((t) => t.dealId === dealId && keys.some((k) => k.ledgerId === t.ledgerId && k.rowNo === t.rowNo));
    },
    async searchRows(q) {
      if (q.ledgerIds.length === 0) return [];
      const term = (q.q ?? "").trim().slice(0, 100);
      return data.transactions
        .filter((t) => t.dealId === q.dealId && q.ledgerIds.includes(t.ledgerId) && !t.duplicate)
        .filter((t) => !q.fiscalYears || q.fiscalYears.length === 0 || q.fiscalYears.includes(t.fiscalYear))
        .filter((t) => !q.accountKey || t.accountKey === q.accountKey)
        .filter((t) => q.minCents === null || q.minCents === undefined || Math.abs(t.amountCents) >= Math.abs(q.minCents))
        .filter((t) => q.maxCents === null || q.maxCents === undefined || Math.abs(t.amountCents) <= Math.abs(q.maxCents))
        .filter((t) => !term || matches(t, { ledgerId: t.ledgerId, q: term }))
        .sort((a, b) => (a.txnDate === b.txnDate ? a.rowNo - b.rowNo : a.txnDate < b.txnDate ? -1 : 1))
        .slice(0, Math.min(q.limit ?? 50, 200));
    },
    async dealAccountTotals(dealId, ledgerIds) {
      const map = new Map<string, DealAccountTotal>();
      for (const t of data.transactions) {
        if (t.dealId !== dealId || t.duplicate || !ledgerIds.includes(t.ledgerId)) continue;
        const k = `${t.fiscalYear}|${t.accountKey}`;
        const a = map.get(k) ?? { fiscalYear: t.fiscalYear, accountKey: t.accountKey, account: t.account, accountType: t.accountType ?? null, accountNumber: t.accountNumber ?? null, lines: 0, netCents: 0 };
        a.lines++;
        a.netCents += t.amountCents;
        if (t.account < a.account) a.account = t.account;
        if (t.accountType && (!a.accountType || t.accountType < a.accountType)) a.accountType = t.accountType;
        if (t.accountNumber && (!a.accountNumber || t.accountNumber < a.accountNumber)) a.accountNumber = t.accountNumber;
        map.set(k, a);
      }
      return Array.from(map.values());
    },
    async accountRows(dealId, ledgerIds, fiscalYear, accountKeys) {
      return data.transactions
        .filter((t) => t.dealId === dealId && ledgerIds.includes(t.ledgerId) && t.fiscalYear === fiscalYear && accountKeys.includes(t.accountKey) && !t.duplicate)
        .sort((a, b) => (a.txnDate === b.txnDate ? a.rowNo - b.rowNo : a.txnDate < b.txnDate ? -1 : 1));
    },
    async changeFiscalYearEnd(dealId, fye) {
      for (const t of data.transactions) if (t.dealId === dealId) t.fiscalYear = fiscalYearJs(t.txnDate, fye);
      for (const k of data.links) if (k.dealId === dealId && !k.documentId && k.txnDate) k.fiscalYear = fiscalYearJs(k.txnDate, fye);
      data.links = data.links.filter((k) => !(k.dealId === dealId && k.state === "proposed"));
      for (const t of data.traces) if (t.dealId === dealId) t.proposalFingerprint = null;
      for (const l of data.ledgers) if (l.dealId === dealId) l.fiscalYearEndUsed = fye;
      const tr = data.tracing.find((t) => t.dealId === dealId);
      if (tr) Object.assign(tr, { fiscalYearEnd: fye, syncedFingerprint: null, tieOut: null, updatedAt: now() });
    },
    async buyerSearchRows(q) {
      const term = q.q.trim().slice(0, 100).toLowerCase();
      if (!term) return [];
      const cents = /\d/.test(term) ? parseMoneyToCents(term) : null;
      const has = (v: string | null | undefined) => (v ?? "").toLowerCase().includes(term);
      return data.transactions
        .filter((t) => t.ledgerId === q.ledgerId && (!q.fy || t.fiscalYear === q.fy) && (!q.accountKey || t.accountKey === q.accountKey) && (!q.accountKeys || q.accountKeys.includes(t.accountKey)))
        .filter((t) => has(t.account) || has(t.txnNumber) || (cents !== null && Math.abs(t.amountCents) === Math.abs(cents)) || (!PAYROLL_KEY_RE.test(t.accountKey) && (has(t.name) || has(t.memo))))
        .sort((a, b) => a.rowNo - b.rowNo)
        .slice(0, Math.min(q.limit ?? 2000, 2000));
    },
    async moveDecidedLinks(fromTraceId, toTraceId, years) {
      const decided = data.links.filter((k) => k.traceId === fromTraceId && (k.state === "confirmed" || k.state === "rejected") && years.includes(k.fiscalYear));
      const same = (a: GlTraceLink, b: GlTraceLink) => (a.ledgerId && a.ledgerId === b.ledgerId && a.rowNo === b.rowNo) || (a.documentId && a.documentId === b.documentId && a.fiscalYear === b.fiscalYear);
      data.links = data.links.filter((t) => !(t.traceId === toTraceId && t.state === "proposed" && decided.some((f) => f.ledgerId && same(f, t))));
      let n = 0;
      for (const f of decided) {
        if (data.links.some((x) => x.traceId === toTraceId && same(f, x))) continue;
        f.traceId = toTraceId;
        f.updatedAt = now();
        n++;
      }
      return n;
    },
    async reserveAi(dealId, kind, cap, day) {
      // Synchronous read-modify-write: the memory twin of the one-statement reservation (no await inside).
      const row = data.tracing.find((t) => t.dealId === dealId);
      if (!row) return false;
      const r = row as unknown as Record<string, unknown>;
      const col = { broker_mapping: "aiBrokerMapping", broker_ranking: "aiBrokerRanking", seller_mapping: "aiSellerMapping", seller_ranking: "aiSellerRanking" }[kind];
      if (r.aiDay !== day) {
        r.aiDay = day;
        for (const c of ["aiBrokerMapping", "aiBrokerRanking", "aiSellerMapping", "aiSellerRanking"]) r[c] = 0;
      }
      if (Number(r[col] ?? 0) >= cap) return false;
      r[col] = Number(r[col] ?? 0) + 1;
      return true;
    },
    async ledgerYearSummaries(dealId) {
      const map = new Map<string, { ledgerId: string; fiscalYear: string; lines: number; debitCents: number; creditCents: number; accounts: number; firstDate: string; lastDate: string; keys: Set<string> }>();
      for (const t of data.transactions) {
        if (t.dealId !== dealId) continue;
        const k = `${t.ledgerId}|${t.fiscalYear}`;
        const a = map.get(k) ?? { ledgerId: t.ledgerId, fiscalYear: t.fiscalYear, lines: 0, debitCents: 0, creditCents: 0, accounts: 0, firstDate: t.txnDate, lastDate: t.txnDate, keys: new Set<string>() };
        a.lines++;
        a.debitCents += t.debitCents ?? Math.max(t.amountCents, 0);
        a.creditCents += t.creditCents ?? Math.max(-t.amountCents, 0);
        a.keys.add(t.accountKey);
        if (t.txnDate < a.firstDate) a.firstDate = t.txnDate;
        if (t.txnDate > a.lastDate) a.lastDate = t.txnDate;
        map.set(k, a);
      }
      return Array.from(map.values()).map(({ keys, ...r }) => ({ ...r, accounts: keys.size }));
    },
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
