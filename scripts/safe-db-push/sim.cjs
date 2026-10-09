// safe-db-push: READ-ONLY simulation of `drizzle-kit push`, with drizzle-kit's own code.
//
// 1. The schema is loaded the way `drizzle-kit push` loads it: drizzle.config.ts parsed by drizzle-kit's
//    own push rules (pushParams: schemaFilter defaults to ["public"], tablesFilter as configured, so
//    user_sessions stays excluded), shared/schema.ts required through tsx's CJS hook (what drizzle-kit
//    itself registers), then prepareFromExports + generatePgSnapshot.
// 2. The database is read with drizzle-kit's pgPushIntrospect over connections opened with
//    default_transaction_read_only=on (checked on each one before use). Every query also goes through a
//    guard that only lets SELECT / WITH / SHOW through. Nothing here can write.
// 3. The diff is drizzle-kit's applyPgSnapshotsDiff(..., "push"), with resolvers that record the
//    "is this a rename?" questions push would ask instead of asking them.
// 4. pgSuggestions (push's data-loss / truncate checks — only `select count(*)` queries) is ported line
//    for line from drizzle-kit 0.31; its questions are recorded, never shown. fromJson(..., "push")
//    gives the exact SQL push would run.
// The internals are reached by compiling node_modules/drizzle-kit/api.js with a few export lines
// appended in memory. Nothing on disk changes.
"use strict";
const fs = require("fs");
const path = require("path");
const Module = require("module");
const crypto = require("crypto");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SUPPORTED_KIT = /^0\.31\./; // the internals below were read from drizzle-kit 0.31.x
const LOCK_SQL_KEY = "hashtext('cimple:schema-push')::bigint"; // shared with the additive-ddl tool

const KIT_EXPORTS = `
;module.exports.__safeDbPushKit = function () {
  init_pgSchema(); init_snapshotsDiffer(); init_sqlgenerator(); init_pgSerializer(); init_pgImports();
  init_getTablesFilterByExtensions(); init_cli();
  return {
    pushParams: pushParams,
    applyPgSnapshotsDiff: snapshotsDiffer_exports.applyPgSnapshotsDiff,
    squashPgScheme: squashPgScheme,
    pgSchema: pgSchema,
    fromJson: fromJson,
    pgPushIntrospect: pgPushIntrospect,
    generatePgSnapshot: generatePgSnapshot,
    prepareFromExports: prepareFromExports,
    tableNameWithSchemaFrom: tableNameWithSchemaFrom,
    getTablesFilterByExtensions: getTablesFilterByExtensions,
  };
};
`;

function repoRequire(root) {
  return Module.createRequire(path.join(root, "package.json"));
}

let kitCache = null;
function loadKit(root) {
  if (kitCache && kitCache.root === root) return kitCache.kit;
  const apiPath = repoRequire(root).resolve("drizzle-kit/api");
  const version = JSON.parse(fs.readFileSync(path.join(path.dirname(apiPath), "package.json"), "utf8")).version;
  if (!SUPPORTED_KIT.test(version)) {
    throw new Error(`drizzle-kit ${version} is not the version this check was written for (0.31.x); re-check scripts/safe-db-push/sim.cjs`);
  }
  const m = new Module(apiPath, module);
  m.filename = apiPath;
  m.paths = Module._nodeModulePaths(path.dirname(apiPath));
  m._compile(fs.readFileSync(apiPath, "utf8") + KIT_EXPORTS, apiPath);
  const kit = m.exports.__safeDbPushKit();
  for (const [k, v] of Object.entries(kit)) if (v === undefined) throw new Error(`drizzle-kit ${version}: internal "${k}" not found`);
  kit.version = version;
  kit.binPath = path.join(path.dirname(apiPath), "bin.cjs");
  kitCache = { root, kit };
  return kit;
}

let tsxRegistered = false;
function registerTsx(root) {
  if (tsxRegistered) return;
  repoRequire(root)("tsx/cjs/api").register(); // what drizzle-kit's own loader registers
  tsxRegistered = true;
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? [...v] : [v]);

function loadConfig(root, kit) {
  registerTsx(root);
  const file = ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs", "drizzle.config.cjs"]
    .map((f) => path.join(root, f))
    .find((f) => fs.existsSync(f));
  if (!file) throw new Error("no drizzle.config.* at the repo root");
  let raw = repoRequire(root)(file);
  raw = raw && raw.default ? raw.default : raw;
  const { dbCredentials, ...rest } = raw; // never read or printed here
  const parsed = kit.pushParams.safeParse(rest);
  if (!parsed.success) throw new Error(`drizzle.config does not parse as push params: ${parsed.error.message}`);
  const cfg = parsed.data;
  if (cfg.dialect !== "postgresql") throw new Error(`drizzle.config dialect is ${cfg.dialect}, expected postgresql`);
  const schemaPaths = asArray(cfg.schema).map((p) => {
    if (/[*?{[]/.test(p)) throw new Error(`glob schema paths are not supported: ${p}`);
    return path.resolve(root, p);
  });
  const tablesFilter = [...asArray(cfg.tablesFilter), ...kit.getTablesFilterByExtensions({ ...cfg, dialect: "postgresql" })];
  return { file, schemaPaths, tablesFilter, schemasFilter: asArray(cfg.schemaFilter), entities: cfg.entities, casing: cfg.casing };
}

function schemaSnapshot(root, kit, config) {
  registerTsx(root);
  const tables = [], enums = [], schemas = [], sequences = [], views = [], matViews = [], roles = [], policies = [];
  for (const f of config.schemaPaths) {
    const prepared = kit.prepareFromExports(repoRequire(root)(f));
    tables.push(...prepared.tables);
    enums.push(...prepared.enums);
    schemas.push(...prepared.schemas);
    sequences.push(...prepared.sequences);
    views.push(...prepared.views);
    matViews.push(...prepared.matViews);
    roles.push(...prepared.roles);
    policies.push(...prepared.policies);
  }
  return kit.generatePgSnapshot(
    Array.from(new Set(tables)), enums, schemas, sequences, roles, policies, views, matViews,
    config.casing, config.schemasFilter,
  );
}

// ---------------------------------------------------------------------------------------------
// Read-only database access
// ---------------------------------------------------------------------------------------------
const READ_SQL = /^\s*(select|with|show)\b/i;

/** Wrap a query function so only reads get through (the connection itself is read-only too). */
function readOnlyGuard(queryFn) {
  return async (sql, params) => {
    if (typeof sql !== "string" || !READ_SQL.test(sql)) {
      throw new Error(`safe-db-push: refused a non-read query in read-only mode: ${String(sql).trim().slice(0, 60)}`);
    }
    return queryFn(sql, params);
  };
}

function pgTypes(pg) {
  // same type parsers as drizzle-kit's pg driver setup
  const b = pg.types.builtins;
  return {
    getTypeParser: (id, format) =>
      id === b.TIMESTAMPTZ || id === b.TIMESTAMP || id === b.DATE || id === b.INTERVAL ? (v) => v : pg.types.getTypeParser(id, format),
  };
}

async function connectReadOnly(root, connectionString, { poolSize = 8, statementTimeoutMs = 20000 } = {}) {
  const pg = repoRequire(root)("pg");
  const types = pgTypes(pg);
  const pool = new pg.Pool({
    connectionString,
    max: poolSize,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    statement_timeout: statementTimeoutMs,
    application_name: "cimple-safe-db-push-ro",
    options: "-c default_transaction_read_only=on",
  });
  pool.on("error", () => {});
  const clients = await Promise.all(Array.from({ length: poolSize }, () => pool.connect()));
  try {
    for (const c of clients) {
      const r = await c.query("SHOW transaction_read_only");
      if (r.rows[0].transaction_read_only !== "on") throw new Error("a connection was not read-only; refusing to continue");
    }
  } catch (e) {
    clients.forEach((c) => c.release(true));
    await pool.end().catch(() => {});
    throw e;
  }
  clients.forEach((c) => c.release());
  const query = readOnlyGuard(async (sql, params) => (await pool.query({ text: sql, values: params ?? [], types })).rows);
  return { db: { query }, close: () => pool.end().catch(() => {}) };
}

/**
 * A session advisory lock shared with the additive-ddl tool, held from the first simulation to the
 * verification, so a branch's apply can't slip in between (and two starting containers don't push at
 * once). Works on a read-only connection.
 */
async function acquireLock(root, connectionString, { waitMs = 15000 } = {}) {
  const pg = repoRequire(root)("pg");
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 10000,
    application_name: "cimple-safe-db-push-lock",
    options: "-c default_transaction_read_only=on",
  });
  client.on("error", () => {});
  await client.connect();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const got = (await client.query(`SELECT pg_try_advisory_lock(${LOCK_SQL_KEY}) AS got`)).rows[0].got;
    if (got) return { release: async () => { await client.query(`SELECT pg_advisory_unlock(${LOCK_SQL_KEY})`).catch(() => {}); await client.end().catch(() => {}); } };
    if (Date.now() > deadline) {
      await client.end().catch(() => {});
      return null;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function quietly(fn) {
  // drizzle-kit's introspection draws a progress spinner; keep the start log clean
  const ow = process.stdout.write, ew = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
}

// ---------------------------------------------------------------------------------------------
// The push diff, questions recorded instead of asked
// ---------------------------------------------------------------------------------------------
function makeResolvers(questions) {
  const name = (it) => (it && it.schema && it.schema !== "public" ? `${it.schema}.${it.name}` : it && it.name);
  const ask = (entity, i, extra = {}) => {
    if (i.created.length > 0 && i.deleted.length > 0) {
      questions.push({ kind: "rename-question", entity, ...extra, created: i.created.map(name), deleted: i.deleted.map(name) });
    }
  };
  return {
    schemasResolver: async (i) => (ask("schema", i), { created: i.created, deleted: i.deleted, renamed: [] }),
    enumsResolver: async (i) => (ask("enum", i), { created: i.created, deleted: i.deleted, moved: [], renamed: [] }),
    sequencesResolver: async (i) => (ask("sequence", i), { created: i.created, deleted: i.deleted, moved: [], renamed: [] }),
    policyResolver: async (i) => (ask("policy", i, { table: i.tableName }), { tableName: i.tableName, schema: i.schema, created: i.created, deleted: i.deleted, renamed: [] }),
    indPolicyResolver: async (i) => (ask("policy", i), { created: i.created, deleted: i.deleted, renamed: [] }),
    roleResolver: async (i) => (ask("role", i), { created: i.created, deleted: i.deleted, renamed: [] }),
    tablesResolver: async (i) => (ask("table", i), { created: i.created, deleted: i.deleted, moved: [], renamed: [] }),
    columnsResolver: async (i) => (ask("column", i, { table: i.tableName }), { tableName: i.tableName, schema: i.schema, created: i.created, deleted: i.deleted, renamed: [] }),
    viewsResolver: async (i) => (ask("view", i), { created: i.created, deleted: i.deleted, moved: [], renamed: [] }),
  };
}

// Port of drizzle-kit 0.31 pgSuggestions (src/cli/commands/pgPushUtils.ts): same queries, same order,
// same SQL; questions recorded instead of shown.
async function pushSuggestions(kit, db, statements) {
  const tbl = (s, rs, rt) => kit.tableNameWithSchemaFrom(s.schema, s.tableName, rs, rt);
  const concat = (schema, table) => (schema ? `"${schema}"."${table}"` : `"${table}"`);
  const count = async (sql) => Number((await db.query(sql))[0].count);
  const steps = [], statementsToExecute = [], infoToPrint = [], questions = [], notNull = [];
  const renamedSchemas = {}, renamedTables = {};
  let shouldAskForApprove = false;
  for (const statement of statements) {
    const extra = [];
    if (statement.type === "rename_schema") {
      renamedSchemas[statement.to] = statement.from;
    } else if (statement.type === "rename_table") {
      renamedTables[concat(statement.toSchema, statement.tableNameTo)] = statement.tableNameFrom;
    } else if (statement.type === "drop_table") {
      const n = await count(`select count(*) as count from ${tbl(statement, renamedSchemas, renamedTables)}`);
      if (n > 0) { infoToPrint.push(`You're about to delete ${statement.tableName} table with ${n} items`); shouldAskForApprove = true; }
    } else if (statement.type === "drop_view" && statement.materialized) {
      const n = await count(`select count(*) as count from "${statement.schema ?? "public"}"."${statement.name}"`);
      if (n > 0) { infoToPrint.push(`You're about to delete "${statement.name}" materialized view with ${n} items`); shouldAskForApprove = true; }
    } else if (statement.type === "alter_table_drop_column") {
      const n = await count(`select count(*) as count from ${tbl(statement, renamedSchemas, renamedTables)}`);
      if (n > 0) { infoToPrint.push(`You're about to delete ${statement.columnName} column in ${statement.tableName} table with ${n} items`); shouldAskForApprove = true; }
    } else if (statement.type === "drop_schema") {
      const n = await count(`select count(*) as count from information_schema.tables where table_schema = '${statement.name}';`);
      if (n > 0) { infoToPrint.push(`You're about to delete ${statement.name} schema with ${n} tables`); shouldAskForApprove = true; }
    } else if (statement.type === "alter_table_alter_column_set_type") {
      const n = await count(`select count(*) as count from ${tbl(statement, renamedSchemas, renamedTables)}`);
      if (n > 0) {
        infoToPrint.push(`You're about to change ${statement.columnName} column type with ${n} items`);
        extra.push(`truncate table ${tbl(statement, renamedSchemas, renamedTables)} cascade;`);
        shouldAskForApprove = true;
      }
    } else if (statement.type === "alter_table_alter_column_drop_pk") {
      const n = await count(`select count(*) as count from ${tbl(statement, renamedSchemas, renamedTables)}`);
      if (n > 0) { infoToPrint.push(`You're about to change ${statement.tableName} primary key`); shouldAskForApprove = true; }
      const pk = await db.query(
        `SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_schema = '${typeof statement.schema === "undefined" || statement.schema === "" ? "public" : statement.schema}'
            AND table_name = '${statement.tableName}'
            AND constraint_type = 'PRIMARY KEY';`,
      );
      const sql = `ALTER TABLE ${tbl(statement, renamedSchemas, renamedTables)} DROP CONSTRAINT "${pk[0] && pk[0].constraint_name}"`;
      steps.push({ stmt: statement, sql: [sql] });
      statementsToExecute.push(sql);
      continue;
    } else if (statement.type === "alter_table_add_column") {
      if (statement.column.notNull && typeof statement.column.default === "undefined") {
        const n = await count(`select count(*) as count from ${tbl(statement, renamedSchemas, renamedTables)}`);
        if (n > 0) {
          infoToPrint.push(`You're about to add not-null ${statement.column.name} column without default value, which contains ${n} items`);
          extra.push(`truncate table ${tbl(statement, renamedSchemas, renamedTables)} cascade;`);
          shouldAskForApprove = true;
          notNull.push({ table: statement.tableName, column: statement.column.name, rows: n });
        }
      }
    } else if (statement.type === "create_unique_constraint") {
      const n = await count(`select count(*) as count from ${tbl(statement, renamedSchemas, renamedTables)}`);
      if (n > 0) questions.push({ kind: "unique-truncate-question", table: statement.tableName, constraint: String(statement.data).split(";")[0], rows: n });
    }
    const sql = kit.fromJson([statement], "postgresql", "push") || [];
    steps.push({ stmt: statement, sql: [...extra, ...sql] });
    statementsToExecute.push(...extra, ...sql);
  }
  if (shouldAskForApprove) questions.push({ kind: "data-loss-approval", info: infoToPrint });
  return { steps, statementsToExecute: [...new Set(statementsToExecute)], questions, notNull };
}

/** Which existing tables (touched by a constraint that could fail on rows) have at least one row. */
async function probeRows(db, steps, prevTables) {
  const created = new Set(steps.filter((s) => s.stmt.type === "create_table").map((s) => s.stmt.tableName));
  const wanted = new Set();
  for (const { stmt } of steps) {
    const t = stmt.tableName;
    if (!t || created.has(t) || !prevTables.has(t)) continue;
    if (
      stmt.type === "create_reference" || stmt.type === "create_unique_constraint" || stmt.type === "create_check_constraint" ||
      (stmt.type === "create_index_pg" && stmt.data && stmt.data.isUnique)
    ) wanted.add(stmt);
  }
  const hasRows = {};
  for (const stmt of wanted) {
    const key = stmt.tableName;
    if (key in hasRows) continue;
    const schema = stmt.schema || "public";
    const rows = await db.query(`select 1 as one from "${schema.replace(/"/g, '""')}"."${key.replace(/"/g, '""')}" limit 1`);
    hasRows[key] = rows.length > 0;
  }
  return hasRows;
}

/**
 * Simulate `drizzle-kit push` for the repo at `root` against `connectionString`. Read-only.
 * Returns everything the decision needs.
 */
async function simulate({ root = REPO_ROOT, connectionString }) {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const kit = loadKit(root);
  const config = loadConfig(root, kit);
  const serialized = schemaSnapshot(root, kit, config);
  const conn = await connectReadOnly(root, connectionString);
  try {
    const { schema: prev } = await quietly(() =>
      kit.pgPushIntrospect(conn.db, config.tablesFilter, config.schemasFilter, config.entities, serialized),
    );
    const cur = { id: crypto.randomUUID(), prevId: prev.id, ...serialized };
    const questions = [];
    const r = makeResolvers(questions);
    const vPrev = kit.pgSchema.parse(prev);
    const vCur = kit.pgSchema.parse(cur);
    const { statements } = await kit.applyPgSnapshotsDiff(
      kit.squashPgScheme(vPrev, "push"), kit.squashPgScheme(vCur, "push"),
      r.schemasResolver, r.enumsResolver, r.sequencesResolver, r.policyResolver, r.indPolicyResolver,
      r.roleResolver, r.tablesResolver, r.columnsResolver, r.viewsResolver,
      vPrev, vCur, "push",
    );
    const sugg = await pushSuggestions(kit, conn.db, statements);
    const prevTables = new Set(Object.values(prev.tables).map((t) => t.name));
    const hasRows = await probeRows(conn.db, sugg.steps, prevTables);
    return {
      kitVersion: kit.version,
      binPath: kit.binPath,
      tablesFilter: config.tablesFilter,
      schemaTables: Object.keys(serialized.tables).length,
      dbTables: prevTables.size,
      steps: sugg.steps,
      statementsToExecute: sugg.statementsToExecute,
      questions: [...questions, ...sugg.questions],
      notNull: sugg.notNull,
      hasRows,
    };
  } finally {
    await conn.close();
  }
}

module.exports = { simulate, acquireLock, readOnlyGuard, loadKit, REPO_ROOT, LOCK_SQL_KEY };
