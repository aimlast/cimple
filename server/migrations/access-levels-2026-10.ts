/**
 * The access-level tidy-up (October 2026) — the ONLY access-level data
 * migration (INTEGRATION §2.1 rule 7). A post-deploy script, never a boot
 * step: every reader normalises through shared/access-levels.ts, so nothing
 * depends on it having run, and running it twice is harmless.
 *
 *   tidy:     legacy values → the level they always meant
 *             teaser → blind, full → blind, loi → named   (LEGACY_ACCESS_LEVELS)
 *   rollback: back to values the previous code reads, if this release is reverted
 *             named → loi, blind → full, teaser_only → teaser (+ every ACTIVE
 *             teaser_only link expires now: old code can't serve a teaser, so it
 *             fails closed with "expired"; --restore-teaser-links undoes it later)
 *
 * Tables: buyer_access, buyer_visits, deal_members (their access_level text
 * column). Not rewritten: access_events entries (history — readers label legacy
 * values through accessLevelLabel) and vdr_shares (vdr only ever writes
 * normalised keys).
 *
 * Each table's change is recorded by the statement that makes it
 * (WITH old … FOR UPDATE … UPDATE … RETURNING), inside one transaction with
 * lock_timeout, statement_timeout and pg_try_advisory_xact_lock. The pure
 * planners and SQL builders are unit-tested (tests/unit/access-level-tidy.test.ts).
 * Scripts: scripts/migrate-access-levels.ts, scripts/rollback-access-levels.ts.
 */
import { sql, type SQL } from "drizzle-orm";
import { ACCESS_LEVELS, LEGACY_ACCESS_LEVELS, TEASER_ACCESS_LEVEL, mapLegacyLevelValue } from "@shared/access-levels";

export const TIDY_TABLES = ["buyer_access", "buyer_visits", "deal_members"] as const;
export type TidyTable = (typeof TIDY_TABLES)[number];

/** Session lock key shared by the tidy-up and its rollback (one run at a time). */
export const TIDY_LOCK_KEY = "cimple:access-levels-2026-10";
export const LOCK_TIMEOUT = "5s";
export const STATEMENT_TIMEOUT = "60s";

const LEGACY_VALUES = Object.keys(LEGACY_ACCESS_LEVELS);

/** What the previous release reads for each new key (the reverse mapping is total). */
export const ROLLBACK_ACCESS_LEVELS: Readonly<Record<string, string>> = {
  blind: "full",          // old code: full = the Blind CIM, every section (none was ever locked)
  named: "loi",           // old code: loi = the named CIM
  teaser_only: "teaser",  // old code can't serve a teaser: the link is expired as well (fail closed)
};
const ROLLBACK_VALUES = Object.keys(ROLLBACK_ACCESS_LEVELS);

/** The rollback's mapping; anything else (legacy values, due_diligence, junk) unchanged. */
export function mapRollbackLevelValue(v: string): string {
  return Object.prototype.hasOwnProperty.call(ROLLBACK_ACCESS_LEVELS, v) ? ROLLBACK_ACCESS_LEVELS[v] : v;
}

// ── Pure plans ──────────────────────────────────────────────────────────

export interface LevelRow {
  table: string;
  id: string;
  level: string | null;
  dealId?: string | null;
  /** buyer_access only: not revoked and not expired (the rollback expires these teaser links). */
  active?: boolean;
}

export interface LevelChange {
  table: string;
  id: string;
  dealId: string | null;
  from: string;
  to: string;
  /** Rollback: this link is expired as part of the change. */
  expire?: boolean;
}

export interface TidyPlan {
  /** Per table: "from→to" → count. */
  counts: Record<string, Record<string, number>>;
  total: number;
  changes: LevelChange[];
}

function tally(changes: LevelChange[]): TidyPlan {
  const counts: Record<string, Record<string, number>> = {};
  for (const t of TIDY_TABLES) counts[t] = {};
  for (const c of changes) {
    const k = `${c.from}→${c.to}`;
    (counts[c.table] ??= {})[k] = (counts[c.table][k] ?? 0) + 1;
  }
  return { counts, total: changes.length, changes };
}

/** Pure: which rows the tidy-up changes. Rows already on a new key (or junk) are never touched. */
export function planAccessLevelTidy(rows: ReadonlyArray<LevelRow>): TidyPlan {
  const changes: LevelChange[] = [];
  for (const r of rows) {
    if (r.level == null || !LEGACY_VALUES.includes(r.level)) continue;
    changes.push({ table: r.table, id: r.id, dealId: r.dealId ?? null, from: r.level, to: mapLegacyLevelValue(r.level) });
  }
  return tally(changes);
}

/** Pure: which rows the rollback changes, and which teaser links it expires. */
export function planAccessLevelRollback(rows: ReadonlyArray<LevelRow>): TidyPlan {
  const changes: LevelChange[] = [];
  for (const r of rows) {
    if (r.level == null || !ROLLBACK_VALUES.includes(r.level)) continue;
    const expire = r.table === "buyer_access" && r.level === TEASER_ACCESS_LEVEL && !!r.active;
    changes.push({ table: r.table, id: r.id, dealId: r.dealId ?? null, from: r.level, to: mapRollbackLevelValue(r.level), ...(expire ? { expire } : {}) });
  }
  return tally(changes);
}

/** "teaser→blind 33, full→blind 26, loi→named 120" — one table's counts in words. */
export function countsLine(counts: Record<string, number>): string {
  const parts = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(", ") : "nothing to change";
}

// ── SQL builders (drizzle SQL; unit-tested as text) ─────────────────────

function assertTable(table: string): asserts table is TidyTable {
  if (!(TIDY_TABLES as readonly string[]).includes(table)) throw new Error(`not an access-level table: ${table}`);
}

const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
const dealScope = (dealId?: string | null, alias?: string) =>
  dealId ? (alias ? sql` AND ${sql.identifier(alias)}.deal_id = ${dealId}` : sql` AND deal_id = ${dealId}`) : sql``;
/** CASE <col> WHEN 'teaser' THEN 'blind' … END, built from one mapping (no hand-written copy). */
function caseOf(col: SQL, mapping: Readonly<Record<string, string>>): SQL {
  const whens = Object.entries(mapping).map(([from, to]) => sql` WHEN ${from} THEN ${to}`);
  return sql`CASE ${col}${sql.join(whens, sql``)} END`;
}
/** A timestamp as exact text (no Date parsing across the Mac's time zone). */
const tsText = (col: SQL) => sql`to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
/** "now" in UTC, the way every timestamp column here is written (TZ=UTC in production). */
const NOW_UTC = sql`(now() AT TIME ZONE 'UTC')`;

/** The read-only rows the tidy-up would change. */
export function tidySelectStatement(table: string, dealId?: string | null): SQL {
  assertTable(table);
  return sql`SELECT id, deal_id AS "dealId", access_level AS "level" FROM ${sql.identifier(table)}
    WHERE access_level IN (${list(LEGACY_VALUES)})${dealScope(dealId)} ORDER BY id`;
}

/** The one statement that maps a table's legacy rows and returns the change record. */
export function tidyUpdateStatement(table: string, dealId?: string | null): SQL {
  assertTable(table);
  const t = sql.identifier(table);
  return sql`WITH old AS (
      SELECT id, access_level FROM ${t}
      WHERE access_level IN (${list(LEGACY_VALUES)})${dealScope(dealId)}
      FOR UPDATE)
    UPDATE ${t} b
       SET access_level = ${caseOf(sql`old.access_level`, LEGACY_ACCESS_LEVELS)}
      FROM old WHERE b.id = old.id
    RETURNING b.id, b.deal_id AS "dealId", old.access_level AS "from", b.access_level AS "to"`;
}

/** The read-only rows the rollback would change (with whether a teaser link is still open). */
export function rollbackSelectStatement(table: string, dealId?: string | null): SQL {
  assertTable(table);
  const active = table === "buyer_access"
    ? sql`(revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${NOW_UTC}))`
    : sql`false`;
  return sql`SELECT id, deal_id AS "dealId", access_level AS "level", ${active} AS "active" FROM ${sql.identifier(table)}
    WHERE access_level IN (${list(ROLLBACK_VALUES)})${dealScope(dealId)} ORDER BY id`;
}

/**
 * The rollback's statements for a table. buyer_access gets two: teaser_only
 * links first (value → teaser; an ACTIVE one also expires now — its old and
 * new expiry are returned as text for --restore-teaser-links), then the rest.
 */
export function rollbackUpdateStatements(table: string, dealId?: string | null): SQL[] {
  assertTable(table);
  const t = sql.identifier(table);
  const out: SQL[] = [];
  if (table === "buyer_access") {
    const stamp = sql`date_trunc('milliseconds', ${NOW_UTC})`;
    out.push(sql`WITH old AS (
        SELECT id, access_level, expires_at, revoked_at FROM ${t}
        WHERE access_level = ${TEASER_ACCESS_LEVEL}${dealScope(dealId)}
        FOR UPDATE)
      UPDATE ${t} b
         SET access_level = ${ROLLBACK_ACCESS_LEVELS[TEASER_ACCESS_LEVEL]},
             expires_at = CASE WHEN old.revoked_at IS NULL AND (old.expires_at IS NULL OR old.expires_at > ${NOW_UTC})
                               THEN ${stamp} ELSE old.expires_at END
        FROM old WHERE b.id = old.id
      RETURNING b.id, b.deal_id AS "dealId", old.access_level AS "from", b.access_level AS "to",
                ${tsText(sql`old.expires_at`)} AS "previousExpiresAt", ${tsText(sql`b.expires_at`)} AS "expiresAt",
                (b.expires_at IS DISTINCT FROM old.expires_at) AS "expired"`);
  }
  const rest = Object.fromEntries(Object.entries(ROLLBACK_ACCESS_LEVELS).filter(([from]) => table !== "buyer_access" || from !== TEASER_ACCESS_LEVEL));
  out.push(sql`WITH old AS (
      SELECT id, access_level FROM ${t}
      WHERE access_level IN (${list(Object.keys(rest))})${dealScope(dealId)}
      FOR UPDATE)
    UPDATE ${t} b
       SET access_level = ${caseOf(sql`old.access_level`, rest)}
      FROM old WHERE b.id = old.id
    RETURNING b.id, b.deal_id AS "dealId", old.access_level AS "from", b.access_level AS "to"`);
  return out;
}

/**
 * After a re-deploy: put the teaser links a rollback expired back as they were
 * — only a row still exactly as the rollback left it (value teaser, or blind
 * if the tidy-up ran since; expiry unchanged). Anything the broker changed
 * meanwhile is left alone and reported.
 */
export function restoreTeaserLinkStatement(link: RestoreLink): SQL {
  const sameExpiry = link.expiresAt === null ? sql`expires_at IS NULL` : sql`expires_at = ${link.expiresAt}::timestamp`;
  return sql`UPDATE buyer_access
       SET access_level = ${TEASER_ACCESS_LEVEL},
           expires_at = ${link.expired ? (link.previousExpiresAt === null ? sql`NULL` : sql`${link.previousExpiresAt}::timestamp`) : sql`expires_at`}
     WHERE id = ${link.id} AND access_level IN (${list([ROLLBACK_ACCESS_LEVELS[TEASER_ACCESS_LEVEL], mapLegacyLevelValue(ROLLBACK_ACCESS_LEVELS[TEASER_ACCESS_LEVEL])])}) AND ${sameExpiry}
     RETURNING id`;
}

/** One teaser link the rollback changed (all of them — an expired one too, so none stays a Blind CIM link). */
export interface RestoreLink {
  id: string;
  dealId: string | null;
  previousExpiresAt: string | null;
  /** What the rollback left (text, exact). */
  expiresAt: string | null;
  /** The rollback set the expiry (the link was active). */
  expired: boolean;
}

// ── Running it (one transaction, one run at a time) ─────────────────────

/** Anything with drizzle's execute + transaction (server/db's `db`). */
export interface TidyDb {
  execute(q: SQL): Promise<unknown>;
  transaction<T>(fn: (tx: { execute(q: SQL): Promise<unknown> }) => Promise<T>): Promise<T>;
}

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] })?.rows ?? []));

export class TidyBusyError extends Error {
  constructor() {
    super("Another access-level run is in progress — nothing was changed. Try again in a minute.");
  }
}

async function guarded<T>(db: TidyDb, fn: (tx: { execute(q: SQL): Promise<unknown> }) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`));
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`));
    const [lock] = rowsOf<{ locked: boolean }>(await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${TIDY_LOCK_KEY})) AS locked`));
    if (!lock?.locked) throw new TidyBusyError();
    return fn(tx);
  });
}

/** Read-only (a READ ONLY transaction): what the tidy-up would change now. */
export async function readTidyPlan(db: TidyDb, opts: { dealId?: string | null } = {}): Promise<TidyPlan> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const rows: LevelRow[] = [];
    for (const table of TIDY_TABLES) {
      for (const r of rowsOf<{ id: string; dealId: string | null; level: string }>(await tx.execute(tidySelectStatement(table, opts.dealId)))) {
        rows.push({ table, id: r.id, dealId: r.dealId, level: r.level });
      }
    }
    return planAccessLevelTidy(rows);
  });
}

/** Read-only: what the rollback would change now. */
export async function readRollbackPlan(db: TidyDb, opts: { dealId?: string | null } = {}): Promise<TidyPlan> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const rows: LevelRow[] = [];
    for (const table of TIDY_TABLES) {
      for (const r of rowsOf<{ id: string; dealId: string | null; level: string; active: boolean }>(await tx.execute(rollbackSelectStatement(table, opts.dealId)))) {
        rows.push({ table, id: r.id, dealId: r.dealId, level: r.level, active: !!r.active });
      }
    }
    return planAccessLevelRollback(rows);
  });
}

export interface TidyResult extends TidyPlan {
  /** Rollback only: every teaser link it changed, for --restore-teaser-links. */
  teaserLinks?: RestoreLink[];
}

/** The tidy-up, in one transaction. The RETURNING rows are the change record. */
export async function applyTidy(db: TidyDb, opts: { dealId?: string | null } = {}): Promise<TidyResult> {
  const changes = await guarded(db, async (tx) => {
    const out: LevelChange[] = [];
    for (const table of TIDY_TABLES) {
      for (const r of rowsOf<{ id: string; dealId: string | null; from: string; to: string }>(await tx.execute(tidyUpdateStatement(table, opts.dealId)))) {
        out.push({ table, id: r.id, dealId: r.dealId, from: r.from, to: r.to });
      }
    }
    return out;
  });
  return tally(changes);
}

/** The rollback, in one transaction. */
export async function applyRollback(db: TidyDb, opts: { dealId?: string | null } = {}): Promise<TidyResult> {
  const { changes, teaserLinks } = await guarded(db, async (tx) => {
    const out: LevelChange[] = [];
    const links: RestoreLink[] = [];
    for (const table of TIDY_TABLES) {
      for (const stmt of rollbackUpdateStatements(table, opts.dealId)) {
        type Row = { id: string; dealId: string | null; from: string; to: string; previousExpiresAt?: string | null; expiresAt?: string | null; expired?: boolean };
        for (const r of rowsOf<Row>(await tx.execute(stmt))) {
          out.push({ table, id: r.id, dealId: r.dealId, from: r.from, to: r.to, ...(r.expired ? { expire: true } : {}) });
          if (table === "buyer_access" && r.from === TEASER_ACCESS_LEVEL) {
            links.push({ id: r.id, dealId: r.dealId, previousExpiresAt: r.previousExpiresAt ?? null, expiresAt: r.expiresAt ?? null, expired: !!r.expired });
          }
        }
      }
    }
    return { changes: out, teaserLinks: links };
  });
  return { ...tally(changes), teaserLinks };
}

/** --restore-teaser-links: one transaction; returns the ids restored and those left alone. */
export async function restoreTeaserLinks(db: TidyDb, links: ReadonlyArray<RestoreLink>): Promise<{ restored: string[]; skipped: string[] }> {
  return guarded(db, async (tx) => {
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const link of links) {
      const rows = rowsOf<{ id: string }>(await tx.execute(restoreTeaserLinkStatement(link)));
      (rows.length ? restored : skipped).push(link.id);
    }
    return { restored, skipped };
  });
}

// ── Proof mode (--deal): only our own QA copies ────────────────────────

export const PROOF_BROKER_USERNAME = "qa_cimgen";
export const PROOF_DEAL_PREFIX = "QA OCT — ";

/** Pure: may --deal run on this deal? null = yes; else why not. */
export function proofDealRefusal(row: { name: string | null; username: string | null } | null | undefined): string | null {
  if (!row) return "No such deal.";
  if (row.username !== PROOF_BROKER_USERNAME) return `--deal only runs on ${PROOF_BROKER_USERNAME}'s deals.`;
  if (!(row.name ?? "").startsWith(PROOF_DEAL_PREFIX)) return `--deal only runs on deals named "${PROOF_DEAL_PREFIX}…".`;
  return null;
}

/** Read-only lookup for proofDealRefusal. */
export async function proofDealCheck(db: TidyDb, dealId: string): Promise<string | null> {
  const rows = rowsOf<{ name: string | null; username: string | null }>(await db.execute(sql`
    SELECT d.business_name AS "name", u.username AS "username"
    FROM deals d LEFT JOIN users u ON u.id = d.broker_id WHERE d.id = ${dealId}`));
  return proofDealRefusal(rows[0]);
}

/** Every key the registry knows — the dry runs say when a table holds something else. */
export const KNOWN_LEVEL_VALUES: ReadonlySet<string> = new Set([...ACCESS_LEVELS.map((l) => l.key), ...LEGACY_VALUES]);
