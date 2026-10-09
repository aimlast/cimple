/**
 * safe db:push (scripts/safe-db-push.cjs): the decision on recorded drizzle-kit push statement sets,
 * the flow (push only when purely additive; never anything in noop / skip / error), the read-only
 * guard, and the package.json wiring. No database.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/safe-db-push.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { decide, formatSkip, formatPush } = require("../../scripts/safe-db-push/decide.cjs");
const { run, scrub } = require("../../scripts/safe-db-push.cjs");
const { readOnlyGuard } = require("../../scripts/safe-db-push/sim.cjs");

type Step = { stmt: any; sql: string[] };

// ── Recorded from production (read-only), 2026-10-09 ─────────────────────────────────────────
// A copy of main's schema plus a new table zz_safe_probe (FK to deals, index, unique index) and two
// new columns on faq_items (nullable; NOT NULL with a default).
const RECORDED_ADD: { steps: Step[]; questions: any[]; notNull: any[]; hasRows: Record<string, boolean>; tablesFilter: string[] } = {
  steps: [
    {
      stmt: {
        type: "create_table", tableName: "zz_safe_probe", schema: "",
        columns: [
          { name: "id", type: "varchar", primaryKey: true, notNull: true, default: "gen_random_uuid()" },
          { name: "deal_id", type: "varchar", primaryKey: false, notNull: false },
          { name: "kind", type: "text", primaryKey: false, notNull: true },
          { name: "payload", type: "jsonb", primaryKey: false, notNull: true, default: "'{}'::jsonb" },
          { name: "created_at", type: "timestamp", primaryKey: false, notNull: true, default: "now()" },
        ],
        compositePKs: [], compositePkName: "", uniqueConstraints: [], policies: [], checkConstraints: [], isRLSEnabled: false,
      },
      sql: ['CREATE TABLE "zz_safe_probe" (\n\t"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,\n\t"deal_id" varchar,\n\t"kind" text NOT NULL,\n\t"payload" jsonb DEFAULT \'{}\'::jsonb NOT NULL,\n\t"created_at" timestamp DEFAULT now() NOT NULL\n);\n'],
    },
    {
      stmt: { type: "alter_table_add_column", tableName: "faq_items", column: { name: "zz_safe_note", type: "text", primaryKey: false, notNull: false }, schema: "" },
      sql: ['ALTER TABLE "faq_items" ADD COLUMN "zz_safe_note" text;'],
    },
    {
      stmt: { type: "alter_table_add_column", tableName: "faq_items", column: { name: "zz_safe_flag", type: "boolean", primaryKey: false, notNull: true, default: false }, schema: "" },
      sql: ['ALTER TABLE "faq_items" ADD COLUMN "zz_safe_flag" boolean DEFAULT false NOT NULL;'],
    },
    {
      stmt: { type: "create_reference", tableName: "zz_safe_probe", data: "zz_safe_probe_deal_id_deals_id_fk;zz_safe_probe;deal_id;deals;id;no action;cascade;public", schema: "" },
      sql: ['ALTER TABLE "zz_safe_probe" ADD CONSTRAINT "zz_safe_probe_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;'],
    },
    {
      stmt: { type: "create_index_pg", tableName: "zz_safe_probe", data: { name: "zz_safe_probe_deal_idx", columns: [{ expression: "deal_id", isExpression: false, asc: true, nulls: "last" }], isUnique: false, with: {}, method: "btree", concurrently: false }, schema: "" },
      sql: ['CREATE INDEX "zz_safe_probe_deal_idx" ON "zz_safe_probe" USING btree ("deal_id");'],
    },
    {
      stmt: { type: "create_index_pg", tableName: "zz_safe_probe", data: { name: "zz_safe_probe_deal_kind_uq", columns: [{ expression: "deal_id", isExpression: false, asc: true, nulls: "last" }, { expression: "kind", isExpression: false, asc: true, nulls: "last" }], isUnique: true, with: {}, method: "btree", concurrently: false }, schema: "" },
      sql: ['CREATE UNIQUE INDEX "zz_safe_probe_deal_kind_uq" ON "zz_safe_probe" USING btree ("deal_id","kind");'],
    },
  ],
  questions: [],
  notNull: [],
  hasRows: {},
  tablesFilter: ["!user_sessions"],
};

// A copy of main's schema without faq_items (1 row) and integration_emails (empty).
const RECORDED_MISSING = {
  steps: [
    { stmt: { type: "drop_table", tableName: "faq_items", schema: "", policies: [] }, sql: ['DROP TABLE "faq_items" CASCADE;'] },
    { stmt: { type: "drop_table", tableName: "integration_emails", schema: "", policies: [] }, sql: ['DROP TABLE "integration_emails" CASCADE;'] },
  ],
  questions: [{ kind: "data-loss-approval", info: ["You're about to delete faq_items table with 1 items"] }],
  notNull: [],
  hasRows: {},
  tablesFilter: ["!user_sessions"],
};

const sim = (steps: Step[], extra: Record<string, any> = {}) => ({ steps, questions: [], notNull: [], hasRows: {}, tablesFilter: ["!user_sessions"], ...extra });
const col = (table: string, column: Record<string, any>): Step => ({ stmt: { type: "alter_table_add_column", tableName: table, column: { primaryKey: false, notNull: false, ...column }, schema: "" }, sql: [`ALTER TABLE "${table}" ADD COLUMN "${column.name}" text;`] });
const idx = (table: string, name: string, extra: Record<string, any> = {}): Step => ({ stmt: { type: "create_index_pg", tableName: table, data: { name, columns: [{ expression: "x", isExpression: false, asc: true, nulls: "last" }], isUnique: false, with: {}, method: "btree", concurrently: false, ...extra }, schema: "" }, sql: [`CREATE ${extra.isUnique ? "UNIQUE " : ""}INDEX "${name}" ON "${table}" USING btree ("x");`] });
const newTable = (name: string): Step => ({ stmt: { type: "create_table", tableName: name, schema: "", columns: [{ name: "id", type: "varchar", primaryKey: true, notNull: true }] }, sql: [`CREATE TABLE "${name}" ("id" varchar PRIMARY KEY NOT NULL);`] });
const fk = (table: string, name: string, to = "deals"): Step => ({ stmt: { type: "create_reference", tableName: table, data: `${name};${table};deal_id;${to};id;no action;cascade;public`, schema: "" }, sql: [`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("deal_id") REFERENCES "public"."${to}"("id");`] });
const other = (type: string, fields: Record<string, any> = {}, sqlText = `-- ${type}`): Step => ({ stmt: { type, schema: "", ...fields }, sql: [sqlText] });

// ── 1. The recorded sets ──────────────────────────────────────────────────────────────────────
{
  const r = decide(RECORDED_ADD);
  assert.equal(r.action, "push", "a new table + nullable / defaulted columns is purely additive");
  assert.deepEqual(r.additive.map((a: any) => a.label), [
    "table zz_safe_probe",
    "column faq_items.zz_safe_note",
    "column faq_items.zz_safe_flag",
    "foreign key zz_safe_probe_deal_id_deals_id_fk on zz_safe_probe",
    "index zz_safe_probe_deal_idx on zz_safe_probe",
    "index zz_safe_probe_deal_kind_uq on zz_safe_probe",
  ]);
  assert.equal(r.blocked.length, 0);
  assert.match(formatPush(r), /6 additive change\(s\)/);
}
{
  const r = decide(RECORDED_MISSING);
  assert.equal(r.action, "skip", "a table in the database that the schema lacks is never dropped");
  assert.deepEqual(r.blocked.map((b: any) => b.label), ["table faq_items", "table integration_emails"]);
  assert.match(r.blocked[1].reason, /push would DROP it/, "the EMPTY table (push would drop it silently) is held back too");
  assert.equal(r.questions.length, 1);
  const text = formatSkip(r);
  assert.match(text, /db:push SKIPPED — NOTHING was changed in the database\. The app starts normally\./);
  assert.match(text, /DROP TABLE "faq_items" CASCADE;/);
  assert.match(text, /DROP TABLE "integration_emails" CASCADE;/);
  assert.match(text, /Do you still want to push changes\?/);
}
assert.equal(decide(sim([])).action, "noop");

// ── 2. Conservative additive rules ───────────────────────────────────────────────────────────
const skip = (s: any, why: RegExp, msg: string) => {
  const r = decide(s);
  assert.equal(r.action, "skip", msg);
  assert.ok(r.blocked.some((b: any) => why.test(b.reason)), `${msg}: ${JSON.stringify(r.blocked.map((b: any) => b.reason))}`);
};
const push = (s: any, msg: string) => assert.equal(decide(s).action, "push", msg);

skip(sim([col("faq_items", { name: "x", notNull: true })]), /NOT NULL without a default/, "NOT NULL column without a default");
push(sim([col("faq_items", { name: "x", notNull: true, default: "0" })]), "NOT NULL column with a default");
push(sim([col("faq_items", { name: "x", notNull: false })]), "nullable column");
skip(sim([col("faq_items", { name: "x", primaryKey: true, notNull: true, default: "1" })]), /primary key/, "a primary-key column on an existing table");
skip(sim([col("faq_items", { name: "x", generated: { as: "1", type: "stored" } })]), /generated/, "a generated column");
skip(sim([col("faq_items", { name: "x", identity: "x;always;1;1;1;1;1;false" })]), /identity/, "an identity column");

skip(sim([idx("faq_items", "u1", { isUnique: true })]), /unique index/, "unique index on an existing table whose rows are unknown");
skip(sim([idx("faq_items", "u1", { isUnique: true })], { hasRows: { faq_items: true } }), /unique index/, "unique index on a table with rows");
push(sim([idx("faq_items", "u1", { isUnique: true })], { hasRows: { faq_items: false } }), "unique index on an empty existing table");
push(sim([newTable("t_new"), idx("t_new", "u1", { isUnique: true })]), "unique index on a table created in the same push");
push(sim([idx("faq_items", "i1")], { hasRows: { faq_items: true } }), "a plain index on a table with rows");
skip(sim([idx("faq_items", "i1", { concurrently: true })]), /CONCURRENTLY/, "a CONCURRENTLY index");

skip(sim([fk("faq_items", "faq_items_deal_id_deals_id_fk")], { hasRows: { faq_items: true } }), /existing rows could violate/, "FK on an existing table with rows");
push(sim([newTable("t_new"), fk("t_new", "t_new_deal_id_deals_id_fk")]), "FK from a new table");
skip(sim([other("create_unique_constraint", { tableName: "faq_items", data: "faq_items_q_unique;question;false" })]), /existing rows could violate/, "unique constraint on an existing table");
skip(sim([other("create_check_constraint", { tableName: "faq_items", data: "faq_items_chk;order > 0" })]), /existing rows could violate/, "check constraint on an existing table");
skip(sim([other("create_composite_pk", { tableName: "faq_items", data: "faq_items_pk;id,order", constraintName: "faq_items_pk" })]), /primary-key change/, "a composite primary key on an existing table");

for (const [type, fields, why] of [
  ["drop_table", { tableName: "zz_other_branch" }, /DROP/],
  ["alter_table_drop_column", { tableName: "deals", columnName: "zz_other_branch_col" }, /DROP/],
  ["drop_index", { tableName: "deals", data: "deals_x_idx;x--true--last;false;btree;{}" }, /DROP/],
  ["delete_reference", { tableName: "deals", data: "deals_fk;deals;a;b;id;;;public" }, /DROPPED/],
  ["delete_unique_constraint", { tableName: "deals", data: "deals_u;a;false" }, /DROPPED/],
  ["pg_alter_table_alter_column_set_type", { tableName: "faq_items", columnName: "question", oldDataType: { name: "text", isEnum: false }, newDataType: { name: "varchar(500)", isEnum: false } }, /type change .*text -> varchar\(500\)/],
  ["alter_table_alter_column_set_default", { tableName: "faq_items", columnName: "order", newDefaultValue: "1" }, /default change/],
  ["alter_table_alter_column_drop_default", { tableName: "faq_items", columnName: "order" }, /default removed/],
  ["alter_table_alter_column_set_notnull", { tableName: "faq_items", columnName: "answer" }, /SET NOT NULL/],
  ["alter_table_alter_column_drop_notnull", { tableName: "faq_items", columnName: "answer" }, /DROP NOT NULL/],
  ["rename_table", { tableNameFrom: "a", tableNameTo: "b" }, /rename of table a -> b/],
  ["alter_table_rename_column", { tableName: "faq_items", oldColumnName: "answer", newColumnName: "answer_text" }, /rename of column/],
  ["alter_reference", { tableName: "deals", data: "deals_fk;deals;a;b;id;;;public" }, /changed/],
  ["enable_rls", { tableName: "deals" }, /not a purely additive/],
  ["create_policy", { tableName: "deals", data: "p" }, /not a purely additive/],
  ["create_view", { name: "v" }, /not a purely additive/],
  ["some_future_statement_type", { tableName: "deals" }, /not a purely additive/],
] as [string, Record<string, any>, RegExp][]) {
  skip(sim([other(type, fields)]), why, `${type} is held back`);
}

push(sim([other("create_type_enum", { name: "status_kind", values: ["a"] }, `CREATE TYPE "public"."status_kind" AS ENUM('a');`)]), "a new enum");
push(sim([other("alter_type_add_value", { name: "status_kind", value: "b" }, `ALTER TYPE "public"."status_kind" ADD VALUE 'b';`)]), "a new enum value");
push(sim([other("create_sequence", { name: "s1" }, `CREATE SEQUENCE "public"."s1";`)]), "a new sequence");

skip(sim([{ ...col("faq_items", { name: "x", notNull: true }), sql: ['truncate table "faq_items" cascade;', 'ALTER TABLE "faq_items" ADD COLUMN "x" text NOT NULL;'] }]), /TRUNCATE/, "any truncate");
skip(sim([newTable("user_sessions")]), /user_sessions/, "anything on user_sessions");
skip(sim([newTable("t_" + "x".repeat(70))]), /longer than 63 bytes/, "an identifier over 63 bytes");
skip(sim([newTable("t_new")], { tablesFilter: [] }), /must exclude "!user_sessions"/, "a config that no longer excludes user_sessions");

// questions always skip, even when every statement is additive
for (const q of [
  { kind: "rename-question", entity: "column", table: "deals", created: ["a"], deleted: ["b"] },
  { kind: "unique-truncate-question", table: "deals", constraint: "u", rows: 3 },
  { kind: "data-loss-approval", info: ["x"] },
]) {
  const r = decide(sim([newTable("t_new")], { questions: [q] }));
  assert.equal(r.action, "skip", `question ${q.kind} → skip`);
  assert.match(formatSkip(r), /a question is a crash/);
}

// all-or-nothing: one blocked statement holds back the additive ones too, and the warning says so
{
  const r = decide(sim([newTable("t_new"), other("drop_table", { tableName: "zz_other_branch" }, 'DROP TABLE "zz_other_branch" CASCADE;')]));
  assert.equal(r.action, "skip");
  assert.equal(r.additive.length, 1);
  assert.match(formatSkip(r), /Held back with them[\s\S]*\+ table t_new/);
}

// ── 3. The flow: nothing runs except on "push"; the start never fails unless strict ─────────
type Calls = { simulate: number; push: number; lock: number; released: number };
function harness(opts: { sims?: any[]; simulateError?: Error; hang?: boolean; argv?: string[]; env?: Record<string, string>; lockNull?: boolean; pushResult?: any }) {
  const calls: Calls = { simulate: 0, push: 0, lock: 0, released: 0 };
  const logs: string[] = [];
  const warns: string[] = [];
  const sims = [...(opts.sims || [])];
  const deps = {
    argv: opts.argv || [],
    env: opts.env || {},
    log: (s: string) => logs.push(s),
    warn: (s: string) => warns.push(s),
    simulate: async () => {
      calls.simulate++;
      if (opts.hang) return new Promise(() => {});
      if (opts.simulateError) throw opts.simulateError;
      return sims.shift();
    },
    push: async () => {
      calls.push++;
      return opts.pushResult || { code: 0 };
    },
    lock: async () => {
      calls.lock++;
      return opts.lockNull ? null : { release: async () => { calls.released++; } };
    },
  };
  return { deps, calls, logs, warns };
}

(async () => {
  {
    const h = harness({ sims: [sim([])] });
    assert.equal(await run(h.deps), 0);
    assert.deepEqual(h.logs, ["db:push: no changes"]);
    assert.equal(h.calls.push, 0, "noop runs nothing");
    assert.equal(h.calls.released, 1, "the lock is released");
  }
  {
    const h = harness({ sims: [RECORDED_MISSING] });
    assert.equal(await run(h.deps), 0, "skip still lets the app start");
    assert.equal(h.calls.push, 0, "skip runs nothing");
    assert.equal(h.calls.simulate, 1);
    assert.match(h.warns.join("\n"), /DROP TABLE "faq_items" CASCADE;/);
  }
  {
    const h = harness({ sims: [RECORDED_ADD, sim([])] });
    assert.equal(await run(h.deps), 0);
    assert.equal(h.calls.push, 1, "push runs drizzle-kit push exactly once");
    assert.equal(h.calls.simulate, 2, "and simulates again to verify");
    assert.match(h.logs.join("\n"), /done — verified/);
    assert.equal(h.warns.length, 0);
  }
  {
    const h = harness({ sims: [RECORDED_ADD], argv: ["--dry-run"] });
    assert.equal(await run(h.deps), 0);
    assert.equal(h.calls.push, 0, "--dry-run never pushes");
    assert.equal(h.calls.lock, 0);
    assert.match(h.logs.join("\n"), /NOT run/);
  }
  {
    const h = harness({ sims: [RECORDED_ADD, RECORDED_ADD], pushResult: { code: 1 } });
    assert.equal(await run(h.deps), 0, "a failed push still lets the app start");
    assert.match(h.warns.join("\n"), /exited with code 1/);
    assert.match(h.warns.join("\n"), /still differs/);
  }
  {
    const secret = "postgres://admin:s3cret@db.internal:5432/railway";
    const h = harness({ simulateError: new Error(`connect ECONNREFUSED ${secret}`), env: { DATABASE_URL: secret } });
    assert.equal(await run(h.deps), 0, "an error in the check never fails the start");
    assert.equal(h.calls.push, 0, "and pushes nothing");
    const out = h.warns.join("\n");
    assert.ok(!out.includes("s3cret") && !out.includes("db.internal"), "no connection string in the output");
    assert.match(out, /could not check the database schema/);
  }
  {
    const h = harness({ simulateError: new Error("boom"), env: { SAFE_DB_PUSH_STRICT: "1" } });
    assert.equal(await run(h.deps), 1, "SAFE_DB_PUSH_STRICT=1 fails the start on a check error");
    assert.equal(h.calls.push, 0);
  }
  {
    const h = harness({ hang: true, env: { SAFE_DB_PUSH_SIM_TIMEOUT_MS: "50" } });
    assert.equal(await run(h.deps), 0, "a hanging check times out and the app starts");
    assert.equal(h.calls.push, 0);
    assert.match(h.warns.join("\n"), /took longer than 50 ms/);
  }
  {
    const h = harness({ sims: [RECORDED_ADD], lockNull: true });
    assert.equal(await run(h.deps), 0);
    assert.equal(h.calls.simulate, 0, "no lock: nothing is checked or run");
    assert.equal(h.calls.push, 0);
    assert.match(h.warns.join("\n"), /holds the lock/);
  }
  assert.equal(scrub("x postgresql://u:p@h/db y", {}), "x <DATABASE_URL> y");

  // ── 4. The read-only guard on every simulation query ─────────────────────────────────────
  {
    let ran = 0;
    const q = readOnlyGuard(async () => { ran++; return []; });
    for (const ok of ["SELECT 1", "\n\t\tSELECT n.nspname FROM pg_namespace", "select count(*) as count from \"deals\"", "WITH x AS (SELECT 1) SELECT * FROM x", "SHOW transaction_read_only"]) {
      await q(ok);
    }
    assert.equal(ran, 5);
    for (const bad of ["CREATE TABLE x (a int)", "ALTER TABLE deals ADD COLUMN x text", 'DROP TABLE "faq_items" CASCADE;', "INSERT INTO x VALUES (1)", "UPDATE deals SET x = 1", "DELETE FROM deals", "truncate table deals cascade;", "BEGIN", "SET default_transaction_read_only = off", "DO $$ BEGIN END $$"]) {
      await assert.rejects(() => q(bad), /refused a non-read query/, bad);
    }
    assert.equal(ran, 5, "a refused query never reaches the database");
  }

  // ── 5. Structure: the simulation only reads; db:push points at the wrapper ────────────────
  {
    const simSrc = fs.readFileSync(path.join(REPO, "scripts/safe-db-push/sim.cjs"), "utf8");
    const literalQueries = [...simSrc.matchAll(/\.query\(\s*[`"']([^`"']*)/g)].map((m) => m[1].trim());
    assert.ok(literalQueries.length > 0);
    for (const q of literalQueries) assert.match(q, /^(select|show)\b/i, `sim.cjs only issues reads: ${q}`);
    assert.match(simSrc, /default_transaction_read_only=on/);
    const runSrc = fs.readFileSync(path.join(REPO, "scripts/safe-db-push.cjs"), "utf8");
    assert.equal((runSrc.match(/deps\.push\(/g) || []).length, 1, "one place runs the push");
    assert.match(runSrc, /spawn\(process\.execPath, \[binPath, "push", "--verbose"\], \{ cwd, env, stdio: \["ignore", "pipe", "pipe"\] \}\)/,
      "the real push: plain `drizzle-kit push` (no --force, no --strict), stdin closed so any question fails instead of waiting");

    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
    assert.equal(pkg.scripts["db:push"], "node scripts/safe-db-push.cjs");
    assert.equal(pkg.scripts["db:push:raw"], "drizzle-kit push");
    const railway = fs.readFileSync(path.join(REPO, "railway.toml"), "utf8");
    assert.ok(railway.includes('startCommand = "npm run db:push && NODE_ENV=production exec node dist/index.js"'), "railway.toml untouched");
  }
  // ── 6. The real-push runner: output relayed with secrets scrubbed, stdin closed, timeout kills ──
  {
    const { runRealPush } = require("../../scripts/safe-db-push.cjs");
    const os = require("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-db-push-test-"));
    const okBin = path.join(dir, "ok.cjs");
    fs.writeFileSync(okBin, `
      process.stdout.write("Reading config file\\nUsing DATABASE_URL=" + process.env.DATABASE_URL + "\\n");
      process.stdout.write("argv=" + process.argv.slice(2).join(" ") + " stdinTTY=" + !!process.stdin.isTTY + "\\n");
      process.stderr.write("\\u001b[32m[✓] Changes applied\\u001b[0m\\n");
    `);
    const lines: string[] = [];
    const env = { ...process.env, DATABASE_URL: "postgres://admin:s3cret@db.internal:5432/railway" };
    const res = await runRealPush({ binPath: okBin, env, timeoutMs: 10000, log: (s: string) => lines.push(s), cwd: dir });
    assert.equal(res.code, 0);
    assert.ok(!lines.join("\n").includes("s3cret"), "the push output is scrubbed");
    assert.ok(lines.some((l) => l.includes("Using DATABASE_URL=<DATABASE_URL>")));
    assert.ok(lines.some((l) => l.includes("argv=push --verbose stdinTTY=false")), "plain push --verbose, no TTY");
    assert.ok(lines.some((l) => l === "  drizzle-kit | [✓] Changes applied"), "colour codes stripped");

    const slowBin = path.join(dir, "slow.cjs");
    fs.writeFileSync(slowBin, "setTimeout(() => {}, 60000);");
    const t0 = Date.now();
    const slow = await runRealPush({ binPath: slowBin, env, timeoutMs: 300, log: () => {}, cwd: dir });
    assert.equal(slow.timedOut, true, "a push that hangs is stopped");
    assert.ok(Date.now() - t0 < 5000);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("safe-db-push: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
