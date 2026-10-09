/**
 * Source scan: access levels are compared ONLY through shared/access-levels.ts.
 *
 * Fails when any file under server/, shared/, client/src/ or scripts/ (other
 * than the registry and the one tidy-up migration) compares, stores, defaults
 * or matches an access level with a string literal — e.g. `accessLevel === "teaser"`,
 * `level === "full"`, `["loi", "due_diligence"].includes(...)`, `case "loi":`,
 * `access_level = 'loi'`, `access_level IN (`, `accessLevel || "teaser"`,
 * `{ teaser: 0, full: 1, loi: 2 }`. Legacy values ("teaser", "full", "loi")
 * keep their old meaning forever, so a literal is either a leak waiting to
 * happen (old "full" ≠ new Full CIM) or a missed legacy alias.
 *
 * It protects the other October streams' code too: the integrator runs it after
 * every merge (INTEGRATION §2.1, §6). A line that must keep a literal for a
 * non-level reason carries `access-level-literal-ok: <why>` in a comment.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/access-level-literals.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN_DIRS = ["server", "shared", "client/src", "scripts"];
const EXTENSIONS = /\.(ts|tsx|js|mjs|cjs)$/;
/** The registry and the one access-level data migration own the literals. */
const EXEMPT = new Set([
  "shared/access-levels.ts",
  "server/migrations/access-levels-2026-10.ts",
  "scripts/migrate-access-levels.ts",
  "scripts/rollback-access-levels.ts",
]);
const OK_MARKER = "access-level-literal-ok:";

const LEVEL = `(?:teaser_only|teaser|full|loi|named|blind|due_diligence)`;
const Q = `["'\`]`;
/** Identifiers that hold an access level. */
const LEVEL_ID = `(?:access_?[lL]evel|[a-zA-Z]*Level|level|previewAs)`;

export const RULES: Array<{ name: string; re: RegExp }> = [
  { name: "compares a level to a literal", re: new RegExp(`\\b${LEVEL_ID}\\s*(?:===|!==|==|!=)\\s*${Q}${LEVEL}${Q}`) },
  { name: "compares a literal to a level", re: new RegExp(`${Q}${LEVEL}${Q}\\s*(?:===|!==|==|!=)\\s*(?:[\\w$]+\\.)*${LEVEL_ID}\\b`) },
  { name: "switch case on a level value", re: new RegExp(`\\bcase\\s+${Q}(?:teaser_only|teaser|loi|named|due_diligence)${Q}\\s*:`) },
  { name: "a list of level literals", re: new RegExp(`\\[\\s*${Q}${LEVEL}${Q}\\s*,\\s*${Q}${LEVEL}${Q}`) },
  { name: "a list starting with \"loi\"", re: /\[\s*["'`]loi["'`]/ },
  { name: "SQL compares access_level to a literal", re: /access_level\s*(?:=|<>|!=)\s*'/i },
  { name: "SQL access_level IN (…)", re: /access_level\s+(?:NOT\s+)?IN\s*\(/i },
  { name: "drizzle compares accessLevel to a literal", re: new RegExp(`\\b(?:eq|ne)\\(\\s*[\\w$.]*accessLevel\\s*,\\s*${Q}`) },
  { name: "drizzle inArray on accessLevel", re: /\binArray\(\s*[\w$.]*accessLevel\b/ },
  { name: "stores a literal level", re: new RegExp(`\\b${LEVEL_ID}\\s*(?::|=)\\s*${Q}${LEVEL}${Q}(?!\\s*\\|)`) },
  { name: "defaults a level to a literal", re: new RegExp(`\\b${LEVEL_ID}\\s*(?:\\?\\?|\\|\\|)\\s*${Q}${LEVEL}${Q}`) },
  { name: "a rank map keyed by level", re: /(?:\bloi|["'`]loi["'`])\s*:\s*\d/ },
];

/** Code only: line and block comments are blanked (string contents are left alone). */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let str: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (str) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === str) str = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { str = c; out += c; i++; continue; }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") out += "\n"; i++; }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function scanSource(src: string): Array<{ line: number; rule: string; text: string }> {
  const raw = src.split("\n");
  const code = stripComments(src).split("\n");
  const hits: Array<{ line: number; rule: string; text: string }> = [];
  code.forEach((line, i) => {
    if (raw[i]?.includes(OK_MARKER)) return;
    for (const r of RULES) if (r.re.test(line)) hits.push({ line: i + 1, rule: r.name, text: line.trim().slice(0, 160) });
  });
  return hits;
}

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTENSIONS.test(name)) out.push(p);
  }
}

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

console.log("access-level literals");

test("the rules catch every shape of level literal (self-check, so the scan is never vacuous)", () => {
  const bad = [
    `if (access.accessLevel === "teaser") x();`,
    `if (level !== 'full') x();`,
    `const named = "loi" === access.accessLevel;`,
    `const blind = !["loi", "due_diligence"].includes(String(level));`,
    `switch (a.accessLevel) { case "loi": return "normal"; }`,
    `db.execute(sql\`SELECT * FROM buyer_access WHERE access_level = 'loi'\`);`,
    `sql\`... WHERE access_level IN ('teaser','full')\``,
    `.where(eq(buyerAccess.accessLevel, "loi"))`,
    `.where(inArray(buyerAccess.accessLevel, levels))`,
    `const grantedLevel = "full"; createBuyerAccess({ accessLevel: "full" });`,
    `byLevel[b.accessLevel || "teaser"]`,
    `const rank = LEVEL_RANK[level ?? "teaser"];`,
    `const LEVEL_RANK = { teaser: 0, full: 1, loi: 2, due_diligence: 3 };`,
    `if (previewAs === "due_diligence") x();`,
    `if (grantLevel === "named") x();`,
    `const grantedLevel = "full";`,
  ];
  for (const line of bad) assert.ok(scanSource(line).length > 0, `not caught: ${line}`);
  const fine = [
    `if (isTeaserOnly(access.accessLevel)) x();`,
    `if (sameAccessLevel(row.accessLevel, NAMED_ACCESS_LEVEL)) x();`,
    `// a comment: accessLevel === "teaser" was the old way`,
    `/* level === "full" */ const x = 1;`,
    `const NEXT = [{ value: "loi", label: "Submit a Letter of Intent (LOI)" }];`,
    `if (mode === "blind") x();`,
    `if (r.variant === "teaser") x();`,
    `accessLevel: text("access_level").notNull().default("teaser"),`,
    `type X = { accessLevel: "teaser" | "full" };`,
    `const url = "https://example.com/a//b"; // level === 'full' (a comment after a URL)`,
    `INSERT INTO buyer_visits (id, deal_id, mode, access_level, device_class)`,
    `accessLevel: normalizeAccessLevel(a.accessLevel),`,
    `const tier = "full"; // access-level-literal-ok: section tier, not a level`,
  ];
  for (const line of fine) assert.deepEqual(scanSource(line), [], `false positive: ${line}`);
});

test("no file compares, stores, defaults or matches an access level with a literal", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
  assert.ok(files.length > 500, `scanned ${files.length} files — the walk found the tree`);
  const breaches: string[] = [];
  for (const f of files) {
    const rel = relative(ROOT, f).split("\\").join("/");
    if (EXEMPT.has(rel)) continue;
    for (const h of scanSource(readFileSync(f, "utf8"))) breaches.push(`${rel}:${h.line} — ${h.rule}: ${h.text}`);
  }
  assert.deepEqual(breaches, [], `Compare access levels through shared/access-levels.ts:\n${breaches.join("\n")}`);
});

console.log(`\n${passed} passed`);
