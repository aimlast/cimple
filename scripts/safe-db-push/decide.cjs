// safe-db-push: the decision. Pure — no database, no drizzle-kit, no I/O.
//
// Input: what drizzle-kit push would do (its statements with the SQL each one becomes, the questions it
// would stop and ask, and which existing tables have rows). Output:
//   noop : push would change nothing
//   push : every statement is purely additive and cannot fail on existing rows, and push asks nothing
//   skip : anything else — run NOTHING and say exactly what was held back and why
//
// "Additive" is deliberately narrow (conservative):
//   CREATE TABLE · CREATE INDEX (not CONCURRENTLY) · ADD COLUMN that is nullable or has a default (not a
//   primary key, not identity/generated) · CREATE TYPE / ADD VALUE / CREATE SEQUENCE / CREATE SCHEMA ·
//   a UNIQUE index, UNIQUE / CHECK / FOREIGN KEY constraint ONLY on a table this push creates or on an
//   existing table known to be empty (on a table with rows it could fail, or push would ask to truncate).
// Everything else is held back: DROP of any kind, type / default / nullability / primary-key changes,
// renames, truncates, policies / views / roles / RLS, identifiers over 63 bytes, anything naming
// user_sessions, and any question push would ask.
"use strict";

const PG_MAX_IDENT = 63;

function parts(squashed) {
  return String(squashed == null ? "" : squashed).split(";");
}

/** What one drizzle-kit push statement is about. */
function describe(stmt) {
  const t = stmt.tableName;
  switch (stmt.type) {
    case "create_table":
    case "drop_table":
      return { kind: "table", table: t };
    case "alter_table_add_column":
      return { kind: "column", table: t, column: stmt.column && stmt.column.name };
    case "alter_table_drop_column":
      return { kind: "column", table: t, column: stmt.columnName };
    case "create_index_pg": {
      const d = stmt.data || {};
      return { kind: "index", table: t, name: d.name, unique: !!d.isUnique, concurrently: !!d.concurrently };
    }
    case "drop_index":
      return { kind: "index", table: t, name: parts(stmt.data)[0] };
    case "create_reference":
    case "delete_reference":
    case "alter_reference": {
      const p = parts(stmt.data);
      return { kind: "foreign key", table: t, name: p[0], ref: p[3] };
    }
    case "create_unique_constraint":
    case "delete_unique_constraint":
      return { kind: "unique constraint", table: t, name: parts(stmt.data)[0] };
    case "create_check_constraint":
      return { kind: "check constraint", table: t, name: parts(stmt.data)[0] };
    case "delete_check_constraint":
      return { kind: "check constraint", table: t, name: stmt.constraintName };
    case "create_composite_pk":
    case "delete_composite_pk":
    case "alter_composite_pk":
      return { kind: "primary key", table: t, name: stmt.constraintName || parts(stmt.data)[0] };
    case "create_type_enum":
    case "drop_type_enum":
    case "alter_type_add_value":
    case "alter_type_drop_value":
    case "rename_type_enum":
      return { kind: "enum", name: stmt.name || stmt.enumName };
    case "create_sequence":
    case "drop_sequence":
      return { kind: "sequence", name: stmt.name };
    case "create_schema":
    case "drop_schema":
      return { kind: "schema", name: stmt.name };
    case "rename_table":
      return { kind: "table", table: stmt.tableNameFrom, to: stmt.tableNameTo };
    case "alter_table_rename_column":
      return { kind: "column", table: t, column: stmt.oldColumnName, to: stmt.newColumnName };
    default:
      if (stmt.columnName) return { kind: "column", table: t, column: stmt.columnName };
      if (t) return { kind: "table", table: t };
      return { kind: "object", name: stmt.name || stmt.type };
  }
}

function label(d) {
  if (d.kind === "table") return `table ${d.table}`;
  if (d.kind === "column") return `column ${d.table}.${d.column}`;
  if (d.table) return `${d.kind} ${d.name} on ${d.table}`;
  return `${d.kind} ${d.name}`;
}

function typeName(t) {
  if (t && typeof t === "object") return t.name || JSON.stringify(t);
  return String(t);
}

/** Why a non-additive statement type is held back (plain words, for the warning). */
function heldBackReason(stmt, d) {
  switch (stmt.type) {
    case "drop_table": return `table ${d.table} is in the database but not in this build's schema — push would DROP it`;
    case "alter_table_drop_column": return `column ${d.table}.${d.column} is in the database but not in this build's schema — push would DROP it`;
    case "drop_index": return `index ${d.name} is in the database but not in this build's schema (or its definition changed) — push would DROP it`;
    case "delete_reference": return `foreign key ${d.name} would be DROPPED`;
    case "delete_unique_constraint": return `unique constraint ${d.name} would be DROPPED`;
    case "delete_check_constraint": return `check constraint ${d.name} would be DROPPED`;
    case "delete_composite_pk": return `primary key ${d.name} would be DROPPED`;
    case "drop_type_enum": return `enum ${d.name} would be DROPPED`;
    case "alter_type_drop_value": return `a value of enum ${d.name} would be DROPPED`;
    case "drop_sequence": return `sequence ${d.name} would be DROPPED`;
    case "drop_schema": return `schema ${d.name} would be DROPPED`;
    case "drop_view": return `view ${stmt.name} would be DROPPED`;
    case "pg_alter_table_alter_column_set_type":
    case "alter_table_alter_column_set_type":
      return `type change on existing column ${d.table}.${d.column}: ${typeName(stmt.oldDataType)} -> ${typeName(stmt.newDataType)}`;
    case "alter_table_alter_column_set_default": return `default change on existing column ${d.table}.${d.column}`;
    case "alter_table_alter_column_drop_default": return `default removed from existing column ${d.table}.${d.column}`;
    case "alter_table_alter_column_set_notnull": return `SET NOT NULL on existing column ${d.table}.${d.column} (fails if any row is NULL)`;
    case "alter_table_alter_column_drop_notnull": return `DROP NOT NULL on existing column ${d.table}.${d.column}`;
    case "alter_table_alter_column_set_pk":
    case "alter_table_alter_column_drop_pk":
    case "create_composite_pk":
    case "alter_composite_pk":
      return `primary-key change on ${d.table}`;
    case "rename_table": return `rename of table ${d.table} -> ${d.to}`;
    case "alter_table_rename_column": return `rename of column ${d.table}.${d.column} -> ${d.to}`;
    case "alter_reference": return `foreign key ${d.name} would be changed`;
    default: return `${stmt.type.replace(/_/g, " ")} is not a purely additive change`;
  }
}

const ALWAYS_OK = new Set(["create_table", "create_type_enum", "alter_type_add_value", "create_sequence", "create_schema"]);

/**
 * @param {object} sim
 * @param {{stmt: object, sql: string[]}[]} sim.steps    push statements with their SQL (as push would run them)
 * @param {object[]} [sim.questions]                    questions push would stop and ask
 * @param {{table: string, column: string}[]} [sim.notNull]  NOT NULL columns without default on tables with rows
 * @param {Record<string, boolean>} [sim.hasRows]        existing table -> has at least one row (unknown = treated as yes)
 * @param {string[]} [sim.tablesFilter]                  drizzle.config tablesFilter (must exclude user_sessions)
 * @returns {{action: "noop"|"push"|"skip", additive: object[], blocked: object[], questions: object[], notes: string[]}}
 */
function decide(sim) {
  const steps = sim.steps || [];
  const questions = sim.questions || [];
  const hasRows = sim.hasRows || {};
  const notes = [];
  if (steps.length === 0 && questions.length === 0) return { action: "noop", additive: [], blocked: [], questions: [], notes };

  const created = new Set(steps.filter((s) => s.stmt.type === "create_table").map((s) => s.stmt.tableName));
  const emptyOrNew = (table) => created.has(table) || hasRows[table] === false;
  const additive = [];
  const blocked = [];

  for (const step of steps) {
    const stmt = step.stmt;
    const d = describe(stmt);
    const sql = step.sql || [];
    const item = { type: stmt.type, label: label(d), sql };
    let reason = null;

    if (sql.some((s) => /^\s*truncate\b/i.test(s))) {
      reason = `push would TRUNCATE ${d.table} (it has rows)`;
    } else if (sql.some((s) => /\buser_sessions\b/i.test(s)) || d.table === "user_sessions") {
      reason = "touches user_sessions (owned by the running app, never by db:push)";
    } else if (ALWAYS_OK.has(stmt.type)) {
      // ok
    } else if (stmt.type === "alter_table_add_column") {
      const c = stmt.column || {};
      if (c.primaryKey) reason = `new column ${d.table}.${d.column} is a primary key`;
      else if (c.generated) reason = `new column ${d.table}.${d.column} is a generated column`;
      else if (c.identity) reason = `new column ${d.table}.${d.column} is an identity column`;
      else if (c.notNull && c.default === undefined) reason = `new column ${d.table}.${d.column} is NOT NULL without a default`;
    } else if (stmt.type === "create_index_pg") {
      if (d.concurrently) reason = `index ${d.name} is CONCURRENTLY`;
      else if (d.unique && !emptyOrNew(d.table)) reason = `unique index ${d.name} on ${d.table}, which has rows (or may have): it could fail on duplicates`;
    } else if (stmt.type === "create_reference" || stmt.type === "create_unique_constraint" || stmt.type === "create_check_constraint") {
      if (!emptyOrNew(d.table)) reason = `${d.kind} ${d.name} on ${d.table}, which has rows (or may have): existing rows could violate it`;
    } else {
      reason = heldBackReason(stmt, d);
    }

    if (!reason) {
      const names = [d.table, d.column, d.name];
      if (stmt.type === "create_table") for (const c of Object.values(stmt.columns || {})) names.push(c.name);
      const long = names.filter((n) => n && Buffer.byteLength(String(n)) > PG_MAX_IDENT);
      if (long.length) reason = `identifier longer than 63 bytes (${long.join(", ")}): Postgres would shorten it and every later push would retry it`;
    }

    if (reason) blocked.push({ ...item, reason });
    else additive.push(item);
  }

  for (const n of sim.notNull || []) {
    if (!blocked.some((b) => b.label === `column ${n.table}.${n.column}`)) {
      blocked.push({ type: "alter_table_add_column", label: `column ${n.table}.${n.column}`, sql: [], reason: `NOT NULL without a default on a table with ${n.rows} rows` });
    }
  }

  const filter = sim.tablesFilter;
  if (Array.isArray(filter) && !filter.includes("!user_sessions")) {
    notes.push('drizzle.config.ts tablesFilter does not exclude "!user_sessions"');
    blocked.push({ type: "config", label: "drizzle.config.ts", sql: [], reason: 'tablesFilter must exclude "!user_sessions"' });
  }

  const action = blocked.length || questions.length ? "skip" : additive.length ? "push" : "noop";
  return { action, additive, blocked, questions, notes };
}

function describeQuestion(q) {
  switch (q.kind) {
    case "rename-question":
      return `"is ${q.created.join(", ")} new, or a rename of ${q.deleted.join(", ")}?" (${q.entity}${q.table ? ` in ${q.table}` : ""})`;
    case "unique-truncate-question":
      return `"truncate ${q.table}?" — unique constraint ${q.constraint} on a table with ${q.rows} rows`;
    case "data-loss-approval":
      return `"Do you still want to push changes?" — ${(q.info || []).join("; ")}`;
    default:
      return JSON.stringify(q);
  }
}

const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();
const clip = (s, n = 220) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The loud warning block printed when push is held back. */
function formatSkip(result) {
  const bar = "=".repeat(78);
  const L = [];
  L.push(bar);
  L.push("db:push SKIPPED — NOTHING was changed in the database. The app starts normally.");
  L.push("drizzle-kit push would have done something that is not purely additive:");
  for (const b of result.blocked) {
    L.push(`  ✗ ${b.label}: ${b.reason}`);
    for (const s of b.sql) L.push(`      ${clip(oneLine(s))}`);
  }
  if (result.questions.length) {
    L.push("It would also have stopped to ask (in this non-interactive start, a question is a crash):");
    for (const q of result.questions) L.push(`  ? ${clip(describeQuestion(q), 400)}`);
  }
  if (result.additive.length) {
    L.push("Held back with them (additive, but push runs all or nothing):");
    for (const a of result.additive) L.push(`  + ${a.label}`);
  }
  L.push("Usual cause: the database has objects this build's schema doesn't (another branch's new tables),");
  L.push("or this build changes an existing column. Fix the schema or the database, then redeploy.");
  L.push("To force drizzle's own behaviour deliberately: `npm run db:push:raw` (can DROP data).");
  L.push(bar);
  return L.join("\n");
}

function formatPush(result) {
  const L = [`db:push: ${result.additive.length} additive change(s), nothing else, no questions:`];
  for (const a of result.additive) L.push(`  + ${a.label}`);
  return L.join("\n");
}

module.exports = { decide, describe, label, formatSkip, formatPush, describeQuestion, PG_MAX_IDENT };
