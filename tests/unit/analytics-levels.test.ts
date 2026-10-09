/**
 * What the analytics dashboards rely on from the access-level registry
 * (shared/access-levels.ts, the teaser stream's file), and a scan that no
 * analytics file compares an access level to a string literal (the
 * teaser stream's rule, INTEGRATION §2.1).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-levels.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

// No analytics file compares a level to a literal.
const root = fileURLToPath(new URL("../../", import.meta.url));
const files = [
  ...readdirSync(`${root}server/analytics-dashboard`).map((f) => `server/analytics-dashboard/${f}`),
  "server/routes/analytics-dashboard.ts",
  "shared/analytics-dashboard.ts",
  "shared/buyer-next-steps.ts",
].filter((f) => f.endsWith(".ts"));
const FORBIDDEN = [
  /accessLevel\s*[!=]==\s*["']/, /level\s*[!=]==\s*["'](teaser|full|loi|named|blind|due_diligence|teaser_only)["']/,
  /access_level\s*=\s*'/, /access_level\s+IN\s*\(/i, /\[\s*["']loi["']/, /case\s+["']loi["']/, /===\s*["'](teaser|full|loi)["']/,
];
for (const f of files) {
  const src = readFileSync(`${root}${f}`, "utf8");
  for (const re of FORBIDDEN) assert.ok(!re.test(src), `${f}: no access-level literal (${re})`);
}
assert.ok(files.length >= 12, "scanned every analytics file");

console.log("analytics-levels: all assertions passed");
