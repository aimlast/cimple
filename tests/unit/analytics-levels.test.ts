/**
 * What the analytics dashboards rely on from the access-level registry
 * (shared/access-levels.ts, the teaser stream's file), and a scan that no
 * analytics file compares an access level to a string literal (the
 * teaser stream's rule, INTEGRATION §2.1).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-levels.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  accessChangePhrase,
  accessGrantPhrase,
  accessLevelLabel,
  accessLevelRank,
  buyerFacingLevelLabel,
  cimModeForAccessLevel,
  isTeaserOnly,
  normalizeAccessLevel,
  parseAccessLevelInput,
  renditionKindFor,
  sameAccessLevel,
  seesCim,
  seesNamedCim,
} from "../../shared/access-levels";
import { grantNounOf } from "../../server/analytics-dashboard/levels";

// Normalising: new keys, legacy aliases (today's stored values), junk → least access.
const matrix: Array<[unknown, string]> = [
  ["teaser_only", "teaser_only"], ["blind", "blind"], ["named", "named"], ["due_diligence", "due_diligence"],
  ["teaser", "blind"], ["full", "blind"], ["loi", "named"],
  [null, "teaser_only"], ["", "teaser_only"], ["LOI", "teaser_only"], [42, "teaser_only"], [undefined, "teaser_only"],
];
for (const [v, want] of matrix) assert.equal(normalizeAccessLevel(v), want, `normalize ${String(v)}`);
assert.equal(parseAccessLevelInput("loi"), "named");
assert.equal(parseAccessLevelInput("bogus"), null);
assert.ok(sameAccessLevel("loi", "named") && sameAccessLevel("full", "teaser") && !sameAccessLevel("full", "named"));

// Labels and what each level gets (today's numbers don't move: legacy values keep their meaning).
assert.deepEqual(["teaser_only", "teaser", "full", "loi", "due_diligence"].map(accessLevelLabel), ["Teaser", "Blind CIM", "Blind CIM", "Full CIM", "Due diligence"]);
assert.equal(buyerFacingLevelLabel("teaser_only"), "Summary");
assert.deepEqual(["teaser_only", "teaser", "loi", "due_diligence"].map(accessLevelRank), [0, 1, 2, 3]);
assert.deepEqual(["teaser_only", "teaser", "full", "loi", "due_diligence"].map(seesCim), [false, true, true, true, true], "a legacy 'teaser' link opens the Blind CIM");
assert.deepEqual(["blind", "named"].map(seesNamedCim), [false, true]);
assert.equal(isTeaserOnly("teaser"), false, "legacy 'teaser' is NOT the teaser document");
assert.equal(isTeaserOnly("teaser_only"), true);
assert.equal(cimModeForAccessLevel("teaser_only"), "blind", "fail-closed second lock");
assert.equal(cimModeForAccessLevel("loi"), "normal");
assert.equal(cimModeForAccessLevel("due_diligence"), "dd");
assert.deepEqual(renditionKindFor("teaser_only"), { mode: "teaser", variant: "teaser" });
assert.deepEqual(renditionKindFor("full"), { mode: "blind", variant: "full" });
assert.equal(accessGrantPhrase("teaser_only"), "Sent the teaser");
assert.equal(accessGrantPhrase("loi"), "Given the Full CIM");
assert.equal(accessChangePhrase("teaser_only"), "Moved back to the teaser");
assert.equal(accessChangePhrase("due_diligence"), "Moved to due-diligence access");
assert.equal(grantNounOf("full"), "the Blind CIM");
assert.equal(grantNounOf("due_diligence"), "due-diligence access");

// ── No analytics file compares a level to a literal ──────────────────────
// The rules below are the teaser stream's access-level literal scan
// (tests/unit/access-level-literals.test.ts, its RULES and scanSource), copied
// VERBATIM so this branch is held to exactly the rule that runs after the
// merge. When that file is in the tree, the last check below proves the two
// copies are still identical.
// ─── BEGIN copy of teaser's rules ───
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
// ─── END copy of teaser's rules ───

// Self-check: the shapes the merge check reported on this branch are caught,
// and their fixed spellings are not.
assert.ok(scanSource(`    case "teaser": return row.document !== "cim";`).length > 0, "a status key spelled like a level is caught");
assert.ok(scanSource(`    case "teaser": return r.teaser ? r.teaser.sent : -1;`).length > 0, "a sort key spelled like a level is caught");
assert.deepEqual(scanSource(`    case "teaser_links": return row.document !== "cim";`), [], "the renamed status key passes");
assert.deepEqual(scanSource(`if (accessLevelRank(b.accessLevel) === 3) x();`), [], "comparing through the registry passes");
assert.ok(scanSource(`if (b.accessLevel === "due_diligence") x();`).length > 0);

/** Every file this stream owns (INTEGRATION §1.1). BuyerCard.tsx is left to teaser's own scan: teaser rewrites its level line (l.105). */
const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = (d: string, ext = /\.(ts|tsx)$/) => readdirSync(`${root}${d}`).filter((f) => ext.test(f)).map((f) => `${d}/${f}`);
const files = [
  ...dir("server/analytics-dashboard"),
  "server/routes/analytics-dashboard.ts",
  "shared/analytics-dashboard.ts",
  "shared/buyer-next-steps.ts",
  ...dir("client/src/components/analytics"),
  "client/src/pages/Analytics.tsx",
  "client/src/pages/broker/deal/EngagementTab.tsx",
  "client/src/pages/broker/deal/TeamTab.tsx",
  "client/src/hooks/useAnalyticsDashboard.ts",
  "client/src/components/engagement/FilterBar.tsx",
  "client/src/components/engagement/BuyerPulseCard.tsx",
  "client/src/components/engagement/types.ts",
  "client/src/components/engagement/extra-views.tsx",
  "client/src/components/engagement/buyers/BuyersView.tsx",
  "client/src/components/engagement/buyers/BuyerList.tsx",
  "client/src/components/engagement/buyers/useBuyerCardActions.tsx",
];
const breaches: string[] = [];
for (const f of files) {
  for (const h of scanSource(readFileSync(`${root}${f}`, "utf8"))) breaches.push(`${f}:${h.line} — ${h.rule}: ${h.text}`);
}
assert.deepEqual(breaches, [], `Compare access levels through shared/access-levels.ts:\n${breaches.join("\n")}`);
assert.ok(files.length >= 30, `scanned every analytics file (${files.length})`);

// After the teaser merge: the copy above must still be teaser's rules, word for word.
const teaserScan = `${root}tests/unit/access-level-literals.test.ts`;
if (existsSync(teaserScan)) {
  const theirs = readFileSync(teaserScan, "utf8");
  const mine = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const between = (src: string) => src.slice(src.indexOf("const OK_MARKER = "), src.indexOf("export function scanSource(")).replace(/\s+/g, " ").trim();
  assert.equal(between(mine), between(theirs), "analytics-levels' copy of the literal-scan rules matches teaser's");
}

console.log("analytics-levels: all assertions passed");
