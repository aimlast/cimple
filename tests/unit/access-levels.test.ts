/**
 * The access-level registry (shared/access-levels.ts): Teaser · Blind CIM ·
 * Full CIM · Due diligence, the legacy values that alias them forever, and
 * every helper other streams compare levels through. Pure — no DB, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/access-levels.test.ts
 */
import assert from "node:assert/strict";
import {
  ACCESS_LEVELS, ACCESS_LEVEL_INPUT_ERROR, BLIND_ACCESS_LEVEL, DD_ACCESS_LEVEL, LEGACY_ACCESS_LEVELS, NAMED_ACCESS_LEVEL, TEASER_ACCESS_LEVEL,
  accessChangePhrase, accessGrantPhrase, accessLevelLabel, accessLevelRank, buyerFacingLevelLabel, cimModeForAccessLevel, isAccessLevel,
  isTeaserOnly, mapLegacyLevelValue, normalizeAccessLevel, parseAccessLevelInput, renditionKindFor, sameAccessLevel, seesCim, seesNamedCim,
} from "../../shared/access-levels";
import * as layouts from "../../shared/cim-layouts";

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

console.log("access levels");

test("the four keys, constants and order", () => {
  assert.deepEqual(ACCESS_LEVELS.map((l) => l.key), ["teaser_only", "blind", "named", "due_diligence"]);
  assert.equal(TEASER_ACCESS_LEVEL, "teaser_only");
  assert.equal(BLIND_ACCESS_LEVEL, "blind");
  assert.equal(NAMED_ACCESS_LEVEL, "named");
  assert.equal(DD_ACCESS_LEVEL, "due_diligence");
  assert.deepEqual(ACCESS_LEVELS.map((l) => l.rank), [0, 1, 2, 3]);
  assert.deepEqual(ACCESS_LEVELS.map((l) => l.document), ["teaser", "cim", "cim", "cim"]);
  assert.deepEqual(ACCESS_LEVELS.map((l) => l.cimMode), [null, "blind", "normal", "dd"]);
  assert.deepEqual(LEGACY_ACCESS_LEVELS, { teaser: "blind", full: "blind", loi: "named" });
});

test("normalise: new keys → themselves; legacy → alias; unknown / empty / null → teaser_only (least access)", () => {
  const cases: Array<[unknown, string]> = [
    ["teaser_only", "teaser_only"], ["blind", "blind"], ["named", "named"], ["due_diligence", "due_diligence"],
    ["teaser", "blind"], ["full", "blind"], ["loi", "named"],
    [null, "teaser_only"], [undefined, "teaser_only"], ["", "teaser_only"], ["admin", "teaser_only"],
    ["LOI", "teaser_only"], [" blind", "teaser_only"], [3, "teaser_only"], [{}, "teaser_only"], ["__proto__", "teaser_only"],
    ["constructor", "teaser_only"], ["toString", "teaser_only"],
  ];
  for (const [v, want] of cases) assert.equal(normalizeAccessLevel(v), want, String(v));
});

test("parse input: new or legacy → normalised; anything else → null (a 400)", () => {
  assert.equal(parseAccessLevelInput("named"), "named");
  assert.equal(parseAccessLevelInput("loi"), "named", "a stale tab's LOI is the Full CIM");
  assert.equal(parseAccessLevelInput("full"), "blind", "a stale tab's Full is the Blind CIM — never named");
  assert.equal(parseAccessLevelInput("teaser"), "blind");
  assert.equal(parseAccessLevelInput("teaser_only"), "teaser_only");
  for (const v of [null, undefined, "", "admin", "Named", 1, "hasOwnProperty", "__proto__"]) assert.equal(parseAccessLevelInput(v), null, String(v));
  assert.match(ACCESS_LEVEL_INPUT_ERROR, /Teaser, Blind CIM, Full CIM or Due diligence/);
});

test("isAccessLevel: new keys only (legacy values are not stored any more)", () => {
  for (const k of ["teaser_only", "blind", "named", "due_diligence"]) assert.ok(isAccessLevel(k), k);
  for (const k of ["teaser", "full", "loi", null, "", "x"]) assert.ok(!isAccessLevel(k), String(k));
});

test("sameAccessLevel matches legacy rows to their level; junk never matches", () => {
  assert.ok(sameAccessLevel("loi", "named"));
  assert.ok(sameAccessLevel("named", "loi"));
  assert.ok(sameAccessLevel("full", "blind"));
  assert.ok(sameAccessLevel("teaser", "full"));
  assert.ok(sameAccessLevel("due_diligence", "due_diligence"));
  assert.ok(!sameAccessLevel("loi", "blind"));
  assert.ok(!sameAccessLevel("teaser", "teaser_only"), "legacy teaser is the Blind CIM, not the Teaser");
  assert.ok(!sameAccessLevel(null, null), "unknown is not a level");
  assert.ok(!sameAccessLevel("junk", "junk"));
  assert.ok(!sameAccessLevel(null, "teaser_only"));
});

test("ranks and what each level opens", () => {
  const rows: Array<[unknown, number, boolean, boolean, boolean]> = [
    // level, rank, seesCim, seesNamedCim, isTeaserOnly
    ["teaser_only", 0, false, false, true],
    ["teaser", 1, true, false, false],
    ["full", 1, true, false, false],
    ["blind", 1, true, false, false],
    ["loi", 2, true, true, false],
    ["named", 2, true, true, false],
    ["due_diligence", 3, true, true, false],
    [null, 0, false, false, true],
    ["junk", 0, false, false, true],
  ];
  for (const [l, rank, cim, named, teaser] of rows) {
    assert.equal(accessLevelRank(l), rank, `rank ${l}`);
    assert.equal(seesCim(l), cim, `seesCim ${l}`);
    assert.equal(seesNamedCim(l), named, `seesNamedCim ${l}`);
    assert.equal(isTeaserOnly(l), teaser, `isTeaserOnly ${l}`);
  }
});

test("CIM mode: teaser_only reads blind only as a fail-closed second lock", () => {
  assert.equal(cimModeForAccessLevel("teaser_only"), "blind");
  assert.equal(cimModeForAccessLevel("teaser"), "blind");
  assert.equal(cimModeForAccessLevel("full"), "blind");
  assert.equal(cimModeForAccessLevel("blind"), "blind");
  assert.equal(cimModeForAccessLevel("loi"), "normal");
  assert.equal(cimModeForAccessLevel("named"), "normal");
  assert.equal(cimModeForAccessLevel("due_diligence"), "dd");
  assert.equal(cimModeForAccessLevel(undefined), "blind");
  assert.equal(cimModeForAccessLevel("junk"), "blind", "anything unknown is never named");
});

test("rendition kinds: the Teaser document is its own; every CIM level is the full variant of its mode", () => {
  assert.deepEqual(renditionKindFor("teaser_only"), { mode: "teaser", variant: "teaser" });
  assert.deepEqual(renditionKindFor("teaser"), { mode: "blind", variant: "full" });
  assert.deepEqual(renditionKindFor("full"), { mode: "blind", variant: "full" });
  assert.deepEqual(renditionKindFor("blind"), { mode: "blind", variant: "full" });
  assert.deepEqual(renditionKindFor("loi"), { mode: "normal", variant: "full" });
  assert.deepEqual(renditionKindFor("named"), { mode: "normal", variant: "full" });
  assert.deepEqual(renditionKindFor("due_diligence"), { mode: "dd", variant: "full" });
  assert.deepEqual(renditionKindFor(null), { mode: "teaser", variant: "teaser" });
});

test("labels: brokers see Teaser · Blind CIM · Full CIM · Due diligence; buyers see Summary for the teaser; never LOI", () => {
  assert.deepEqual(ACCESS_LEVELS.map((l) => accessLevelLabel(l.key)), ["Teaser", "Blind CIM", "Full CIM", "Due diligence"]);
  assert.equal(accessLevelLabel("loi"), "Full CIM");
  assert.equal(accessLevelLabel("full"), "Blind CIM");
  assert.equal(accessLevelLabel("teaser"), "Blind CIM");
  assert.deepEqual(ACCESS_LEVELS.map((l) => buyerFacingLevelLabel(l.key)), ["Summary", "Blind CIM", "Full CIM", "Due diligence"]);
  assert.equal(buyerFacingLevelLabel("loi"), "Full CIM");
  for (const l of ACCESS_LEVELS) {
    assert.ok(!/\bLOI\b/.test(`${l.label} ${l.description} ${l.buyerLabel} ${l.grantNoun}`), `${l.key}: no LOI anywhere`);
    assert.ok(l.description.length > 20 && l.description.length < 120, `${l.key}: one plain line`);
  }
});

test("phrases for the buyer timeline", () => {
  assert.equal(accessGrantPhrase("teaser_only"), "Sent the teaser");
  assert.equal(accessGrantPhrase("full"), "Given the Blind CIM");
  assert.equal(accessGrantPhrase("loi"), "Given the Full CIM");
  assert.equal(accessGrantPhrase("due_diligence"), "Given due-diligence access");
  assert.equal(accessChangePhrase("named"), "Moved to the Full CIM");
  assert.equal(accessChangePhrase("blind"), "Moved to the Blind CIM");
  assert.equal(accessChangePhrase("teaser_only"), "Moved back to the teaser");
  assert.equal(accessChangePhrase("due_diligence"), "Moved to due-diligence access");
});

test("the tidy-up mapping: legacy → new, everything else unchanged", () => {
  assert.equal(mapLegacyLevelValue("teaser"), "blind");
  assert.equal(mapLegacyLevelValue("full"), "blind");
  assert.equal(mapLegacyLevelValue("loi"), "named");
  for (const v of ["teaser_only", "blind", "named", "due_diligence", "weird", ""]) assert.equal(mapLegacyLevelValue(v), v);
});

test("cim-layouts re-exports keep older imports compiling, with the new meaning", () => {
  assert.equal(layouts.BUYER_ACCESS_LEVELS, ACCESS_LEVELS);
  assert.equal(layouts.NAMED_ACCESS_LEVEL, "named", "heatmap's NAMED_ACCESS_LEVEL is teaser's (INTEGRATION C6)");
  assert.equal(layouts.BLIND_ACCESS_LEVEL, "blind");
  assert.equal(layouts.TEASER_ACCESS_LEVEL, "teaser_only");
  assert.equal(layouts.DD_ACCESS_LEVEL, "due_diligence");
  assert.equal(layouts.cimModeForAccessLevel("loi"), "normal");
  assert.equal(layouts.buyerAccessLabel("loi"), "Full CIM");
  assert.ok(layouts.isBuyerAccessLevel("named"));
  assert.ok(!layouts.isBuyerAccessLevel("loi"));
  assert.equal(layouts.buyerAccessPhrase("full"), "the Blind CIM");
});

console.log(`\n${passed} passed`);
