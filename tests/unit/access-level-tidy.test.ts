/**
 * The access-level tidy-up and its rollback (server/migrations/access-levels-2026-10.ts):
 * the pure plans, the SQL each statement sends (as text), the one-transaction
 * guard (timeouts + advisory lock) and the proof-mode refusal. No database:
 * a fake connection records what would run. (The real-Postgres proof is run
 * on a QA OCT clone — see the stream's handoff.)
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/access-level-tidy.test.ts
 */
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  ROLLBACK_ACCESS_LEVELS, TIDY_LOCK_KEY, TIDY_TABLES, TidyBusyError, applyRollback, applyTidy, countsLine, mapRollbackLevelValue,
  planAccessLevelRollback, planAccessLevelTidy, proofDealRefusal, readTidyPlan, restoreTeaserLinkStatement, rollbackSelectStatement,
  rollbackUpdateStatements, tidySelectStatement, tidyUpdateStatement, type TidyDb,
} from "../../server/migrations/access-levels-2026-10";
import { mapLegacyLevelValue, normalizeAccessLevel } from "../../shared/access-levels";

const dialect = new PgDialect();
const text = (q: SQL) => dialect.sqlToQuery(q);

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

console.log("tidy plan");

await test("mapLegacyLevelValue: legacy → new; new keys and junk unchanged", () => {
  assert.equal(mapLegacyLevelValue("teaser"), "blind");
  assert.equal(mapLegacyLevelValue("full"), "blind");
  assert.equal(mapLegacyLevelValue("loi"), "named");
  for (const v of ["blind", "named", "due_diligence", "teaser_only", "x"]) assert.equal(mapLegacyLevelValue(v), v);
});

await test("the plan counts exactly the legacy rows, per table, and never touches new keys", () => {
  const rows = [
    ...Array.from({ length: 33 }, (_, i) => ({ table: "buyer_access", id: `t${i}`, level: "teaser" })),
    ...Array.from({ length: 26 }, (_, i) => ({ table: "buyer_access", id: `f${i}`, level: "full" })),
    ...Array.from({ length: 120 }, (_, i) => ({ table: "buyer_access", id: `l${i}`, level: "loi" })),
    { table: "buyer_access", id: "dd1", level: "due_diligence" },
    { table: "buyer_access", id: "dd2", level: "due_diligence" },
    { table: "buyer_access", id: "n1", level: "named" },
    { table: "buyer_access", id: "x1", level: "junk" },
    { table: "buyer_access", id: "z1", level: null },
    ...Array.from({ length: 38 }, (_, i) => ({ table: "buyer_visits", id: `vf${i}`, level: "full" })),
    ...Array.from({ length: 12 }, (_, i) => ({ table: "buyer_visits", id: `vl${i}`, level: "loi" })),
    ...Array.from({ length: 12 }, (_, i) => ({ table: "buyer_visits", id: `vt${i}`, level: "teaser" })),
  ];
  const plan = planAccessLevelTidy(rows);
  assert.deepEqual(plan.counts.buyer_access, { "teaser→blind": 33, "full→blind": 26, "loi→named": 120 });
  assert.deepEqual(plan.counts.buyer_visits, { "full→blind": 38, "loi→named": 12, "teaser→blind": 12 });
  assert.deepEqual(plan.counts.deal_members, {});
  assert.equal(plan.total, 33 + 26 + 120 + 62);
  assert.ok(!plan.changes.some((c) => ["dd1", "dd2", "n1", "x1", "z1"].includes(c.id)), "new keys, junk and nulls untouched");
  // Every change keeps the meaning the row always had.
  for (const c of plan.changes) assert.equal(normalizeAccessLevel(c.from), c.to);
  assert.equal(countsLine(plan.counts.buyer_access), "full→blind 26, loi→named 120, teaser→blind 33");
  assert.equal(countsLine({}), "nothing to change");
});

await test("a second plan after the tidy-up is empty (idempotent)", () => {
  const first = planAccessLevelTidy([{ table: "buyer_access", id: "a", level: "loi" }, { table: "deal_members", id: "m", level: "full" }]);
  const after = first.changes.map((c) => ({ table: c.table, id: c.id, level: c.to }));
  assert.equal(planAccessLevelTidy(after).total, 0);
});

console.log("tidy SQL");

await test("one statement per table: legacy rows FOR UPDATE → mapped → RETURNING the change record", () => {
  for (const table of TIDY_TABLES) {
    const q = text(tidyUpdateStatement(table));
    assert.match(q.sql, new RegExp(`WITH old AS \\(\\s*SELECT id, access_level FROM "${table}"`));
    assert.match(q.sql, /WHERE access_level IN \(\$1, \$2, \$3\)/);
    assert.match(q.sql, /FOR UPDATE\)/);
    assert.match(q.sql, new RegExp(`UPDATE "${table}" b\\s+SET access_level = CASE old.access_level WHEN \\$4 THEN \\$5 WHEN \\$6 THEN \\$7 WHEN \\$8 THEN \\$9 END`));
    assert.match(q.sql, /FROM old WHERE b\.id = old\.id/);
    assert.match(q.sql, /RETURNING b\.id, b\.deal_id AS "dealId", old\.access_level AS "from", b\.access_level AS "to"/);
    assert.deepEqual(q.params, ["teaser", "full", "loi", "teaser", "blind", "full", "blind", "loi", "named"]);
    assert.ok(!/deal_id = \$/.test(q.sql), "no deal scope unless asked");
  }
});

await test("--deal scopes every statement to one deal", () => {
  const q = text(tidyUpdateStatement("buyer_access", "deal-1"));
  assert.match(q.sql, /access_level IN \(\$1, \$2, \$3\) AND deal_id = \$4/);
  assert.equal(q.params[3], "deal-1");
  const s = text(tidySelectStatement("buyer_visits", "deal-1"));
  assert.match(s.sql, /FROM "buyer_visits"\s+WHERE access_level IN \(\$1, \$2, \$3\) AND deal_id = \$4/);
  for (const r of rollbackUpdateStatements("buyer_access", "deal-1")) assert.match(text(r).sql, /AND deal_id = \$\d+/);
  assert.match(text(rollbackSelectStatement("deal_members", "deal-1")).sql, /AND deal_id = \$\d+/);
});

await test("only the three level tables", () => {
  assert.throws(() => tidyUpdateStatement("users"), /not an access-level table/);
  assert.throws(() => rollbackUpdateStatements("vdr_shares"), /not an access-level table/);
});

console.log("rollback");

await test("the rollback maps back totally; open Teaser links expire, closed ones only change value", () => {
  assert.deepEqual(ROLLBACK_ACCESS_LEVELS, { blind: "full", named: "loi", teaser_only: "teaser" });
  assert.equal(mapRollbackLevelValue("named"), "loi");
  assert.equal(mapRollbackLevelValue("blind"), "full");
  assert.equal(mapRollbackLevelValue("teaser_only"), "teaser");
  assert.equal(mapRollbackLevelValue("due_diligence"), "due_diligence");
  assert.equal(mapRollbackLevelValue("loi"), "loi");
  const plan = planAccessLevelRollback([
    { table: "buyer_access", id: "a", level: "named" },
    { table: "buyer_access", id: "b", level: "blind" },
    { table: "buyer_access", id: "c", level: "teaser_only", active: true },
    { table: "buyer_access", id: "d", level: "teaser_only", active: false },
    { table: "buyer_access", id: "e", level: "due_diligence" },
    { table: "buyer_visits", id: "v", level: "teaser_only", active: true },
  ]);
  assert.deepEqual(plan.counts.buyer_access, { "named→loi": 1, "blind→full": 1, "teaser_only→teaser": 2 });
  assert.deepEqual(plan.changes.filter((c) => c.expire).map((c) => c.id), ["c"], "only an open Teaser link on buyer_access expires");
  // Old code reads every rolled-back value with no more access than before.
  assert.equal(normalizeAccessLevel(mapRollbackLevelValue("blind")), "blind");
  assert.equal(normalizeAccessLevel(mapRollbackLevelValue("named")), "named");
});

await test("rollback SQL: Teaser links first (expire the open ones, return old + new expiry as text), then the rest", () => {
  const [teaser, rest] = rollbackUpdateStatements("buyer_access").map(text);
  assert.match(teaser.sql, /WHERE access_level = \$1/);
  assert.equal(teaser.params[0], "teaser_only");
  assert.match(teaser.sql, /SET access_level = \$\d+,\s+expires_at = CASE WHEN old\.revoked_at IS NULL AND \(old\.expires_at IS NULL OR old\.expires_at > \(now\(\) AT TIME ZONE 'UTC'\)\)\s+THEN date_trunc\('milliseconds', \(now\(\) AT TIME ZONE 'UTC'\)\) ELSE old\.expires_at END/);
  assert.match(teaser.sql, /to_char\(old\.expires_at, 'YYYY-MM-DD"T"HH24:MI:SS\.US'\) AS "previousExpiresAt"/);
  assert.match(teaser.sql, /\(b\.expires_at IS DISTINCT FROM old\.expires_at\) AS "expired"/);
  assert.match(rest.sql, /CASE old\.access_level WHEN \$\d+ THEN \$\d+ WHEN \$\d+ THEN \$\d+ END/);
  assert.ok(rest.params.includes("blind") && rest.params.includes("named") && !rest.params.includes("teaser_only"));
  const [visits] = rollbackUpdateStatements("buyer_visits").map(text);
  assert.ok(visits.params.includes("teaser_only"), "a teaser visit's level maps back too (no expiry on visits)");
  assert.ok(!/expires_at/.test(visits.sql));
});

await test("restore puts a Teaser link back only when it is still as the rollback left it", () => {
  const q = text(restoreTeaserLinkStatement({ id: "a1", dealId: "d", previousExpiresAt: null, expiresAt: "2026-10-09T10:00:00.123000", expired: true }));
  assert.match(q.sql, /SET access_level = \$1,\s+expires_at = NULL/);
  assert.match(q.sql, /WHERE id = \$2 AND access_level IN \(\$3, \$4\) AND expires_at = \$5::timestamp/);
  assert.deepEqual(q.params, ["teaser_only", "a1", "teaser", "blind", "2026-10-09T10:00:00.123000"]);
  const kept = text(restoreTeaserLinkStatement({ id: "a2", dealId: "d", previousExpiresAt: "2026-09-01T00:00:00.000000", expiresAt: "2026-09-01T00:00:00.000000", expired: false }));
  assert.match(kept.sql, /expires_at = expires_at/, "a closed link keeps its own expiry");
});

console.log("running it");

/** A fake connection: records statements, answers the lock and the RETURNING rows. */
function fakeDb(opts: { locked?: boolean; returning?: Record<string, unknown[] | ((sqlText: string) => unknown[])> } = {}) {
  const log: string[] = [];
  const exec = async (q: SQL) => {
    const t = text(q).sql.replace(/\s+/g, " ").trim();
    log.push(t);
    if (/pg_try_advisory_xact_lock/.test(t)) return [{ locked: opts.locked ?? true }];
    for (const [table, rows] of Object.entries(opts.returning ?? {})) if (t.includes(`UPDATE "${table}"`)) return typeof rows === "function" ? rows(t) : rows;
    return [];
  };
  const db: TidyDb = {
    execute: exec,
    transaction: async (fn) => {
      log.push("BEGIN");
      try {
        const r = await fn({ execute: exec });
        log.push("COMMIT");
        return r;
      } catch (e) {
        log.push("ROLLBACK");
        throw e;
      }
    },
  };
  return { db, log };
}

await test("apply: one transaction, timeouts first, the advisory lock, then one statement per table", async () => {
  const { db, log } = fakeDb({ returning: { buyer_access: [{ id: "a", dealId: "d", from: "loi", to: "named" }], buyer_visits: [{ id: "v", dealId: "d", from: "full", to: "blind" }] } });
  const r = await applyTidy(db);
  assert.equal(log[0], "BEGIN");
  assert.equal(log[1], "SET LOCAL lock_timeout = '5s'");
  assert.equal(log[2], "SET LOCAL statement_timeout = '60s'");
  assert.match(log[3], /^SELECT pg_try_advisory_xact_lock\(hashtext\(\$1\)\) AS locked$/);
  assert.equal(log.filter((l) => /^WITH old AS/.test(l)).length, 3);
  assert.equal(log[log.length - 1], "COMMIT");
  assert.deepEqual(r.counts.buyer_access, { "loi→named": 1 });
  assert.deepEqual(r.counts.buyer_visits, { "full→blind": 1 });
  assert.equal(r.total, 2);
  assert.equal(TIDY_LOCK_KEY, "cimple:access-levels-2026-10");
});

await test("a second run at the same time changes nothing (lock not taken → rolled back)", async () => {
  const { db, log } = fakeDb({ locked: false });
  await assert.rejects(applyTidy(db), TidyBusyError);
  assert.equal(log[log.length - 1], "ROLLBACK");
  assert.ok(!log.some((l) => /^WITH old AS/.test(l)), "no update ran");
  const r2 = fakeDb({ locked: false });
  await assert.rejects(applyRollback(r2.db), TidyBusyError);
});

await test("the dry run reads in a READ ONLY transaction and never updates", async () => {
  const { db, log } = fakeDb();
  const plan = await readTidyPlan(db, { dealId: "d1" });
  assert.equal(plan.total, 0);
  assert.equal(log[1], "SET TRANSACTION READ ONLY");
  assert.ok(!log.some((l) => /UPDATE|SET LOCAL|advisory/.test(l)));
});

await test("rollback apply returns every Teaser link it changed, for the restore", async () => {
  const { db } = fakeDb({ returning: { buyer_access: (t) => /expires_at = CASE/.test(t) ? [
    { id: "t1", dealId: "d", from: "teaser_only", to: "teaser", previousExpiresAt: null, expiresAt: "2026-10-09T10:00:00.123000", expired: true },
    { id: "t2", dealId: "d", from: "teaser_only", to: "teaser", previousExpiresAt: "2026-09-01T00:00:00.000000", expiresAt: "2026-09-01T00:00:00.000000", expired: false },
  ] : [{ id: "n1", dealId: "d", from: "named", to: "loi" }] } });
  const r = await applyRollback(db);
  assert.deepEqual(r.teaserLinks!.map((l) => [l.id, l.expired]), [["t1", true], ["t2", false]]);
  assert.deepEqual(r.changes.filter((c) => c.expire).map((c) => c.id), ["t1"]);
  assert.deepEqual(r.counts.buyer_access, { "teaser_only→teaser": 2, "named→loi": 1 });
});

await test("proof mode: only qa_cimgen's QA OCT copies", () => {
  assert.equal(proofDealRefusal({ name: "QA OCT — Pacific Coast Logistics Ltd.", username: "qa_cimgen" }), null);
  assert.match(proofDealRefusal({ name: "Pacific Coast Logistics Ltd.", username: "broker_demo" })!, /qa_cimgen/);
  assert.match(proofDealRefusal({ name: "QA OCT — Pacific", username: "broker_demo" })!, /qa_cimgen/);
  assert.match(proofDealRefusal({ name: "QA CIMGEN — Harbourline Dental", username: "qa_cimgen" })!, /QA OCT/);
  assert.match(proofDealRefusal(undefined)!, /No such deal/);
});

console.log(`\n${passed} passed`);
