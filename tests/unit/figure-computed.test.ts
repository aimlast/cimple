/**
 * Worked-out notes (D6 / D7): the fixed templates, named and blind, and the
 * notes the refresh writes on the demo copies. No DB, no AI.
 *   npx tsx tests/unit/figure-computed.test.ts
 */
import assert from "node:assert/strict";
import { fixtureRaw, run, test } from "./helpers/figure-test";
import {
  changeLine, cimVsStatementsText, differenceComponentsBlindText, differenceComponentsText, groupingOpexText, lowerFirst,
  movementBlindText, movementText, restatedText, shortLabel, sourceCheckSummary,
} from "../../shared/figure-copy";
import { computedNotes, movedEnough } from "../../server/cim/figures/computed";
import { anchorFigures } from "../../shared/figure-anchors";
import { findBlindLeaks, blindLeakTerms } from "../../shared/blind-guard";

test("templates (§4.6), named", () => {
  assert.equal(
    differenceComponentsText({ lineWord: "interest", components: [{ label: "Bank charges", value: 33000 }] }),
    "The tax return's interest line includes bank charges ($33,000), which the financial statements show on their own line.",
  );
  assert.equal(
    groupingOpexText({ amortization: 1880000, interest: 412000 }),
    "The tax return's operating expenses also include amortization ($1,880,000) and interest ($412,000); the financial statements show them below operating expenses.",
  );
  assert.equal(
    cimVsStatementsText({ asIssued: 5766500, items: null, total: 127000, count: 2 }),
    "Financial statements as issued: $5,766,500. This CIM shows 2 one-time costs ($127,000) on their own line.",
  );
  assert.equal(
    restatedText({ year: "2022", lineWord: "revenue", earlier: 100000, later: 101000 }),
    "The FY2023 statements show FY2022 revenue as $101,000; the FY2022 statements showed $100,000.",
  );
  assert.equal(
    movementText({ from: 4127000, to: 5505500, fromYear: "2022", parts: [{ label: "Facility rent (warehouse)", delta: 1120500 }] }),
    "Up $1,378,500 (33%) from FY2022, mostly facility rent (+$1,120,500).",
  );
  assert.equal(changeLine(585000, 690000, "2022"), "Up $105,000 (18%) from FY2022");
  assert.equal(lowerFirst("Comfort Club memberships"), "Comfort Club memberships");
  assert.equal(lowerFirst("Dry van truckload"), "dry van truckload");
  assert.equal(shortLabel("Direct labour - technicians (incl. benefits & payroll burden)"), "Direct labour - technicians");
  assert.equal(sourceCheckSummary({ checked: 27, matching: 24, regrouped: 2, differing: 1, explained: 1 }), "27 figures checked · 24 match · 2 grouped differently · 1 differs (with a reason)");
});

test("templates, blind: category words only, never a line label", () => {
  const blind = [
    differenceComponentsBlindText({ lineWord: "interest", total: 57000 }),
    movementBlindText({ from: 6180000, to: 6840000, fromYear: "2022", partCount: 3, blindWord: "revenue" }),
  ];
  assert.equal(blind[1], "Up $660,000 (11%) from FY2022, mostly from three revenue streams.");
  for (const t of blind) assert.ok(!/HVAC|Comfort Club|merchant|Bank charges/i.test(t), t);
});

test("Lakeshore: revenue FY2023 note names the three lines that moved it (D7)", async () => {
  const { fx, raw } = await fixtureRaw("lakeshore");
  const anchored = new Set(fx.sections.flatMap((s) => anchorFigures(s as any, raw.registry)).map((a) => a.figureKey));
  const notes = computedNotes({ registry: raw.registry, checks: raw.checks.checks, anchoredKeys: anchored });
  const rev = notes.find((n) => n.figureKey === "revenue|2023" && n.kind === "movement")!;
  assert.equal(rev.text, "Up $660,000 (11%) from FY2022, mostly HVAC equipment replacement & installation (+$290,000), plumbing service, drains & water heaters (+$125,000) and HVAC service & repair (+$105,000).");
  assert.equal(rev.blindText, "Up $660,000 (11%) from FY2022, mostly from three revenue streams.");
  assert.deepEqual(rev.valuesSnapshot.fromYear, "2022");
  assert.equal(rev.compareKey, "2022");
  // Mixed-sign totals (gross profit, EBITDA, net income) get no worked-out note.
  assert.ok(!notes.some((n) => n.kind === "movement" && /^(grossProfit|ebitda|netIncome|incomeBeforeTax)\|/.test(n.figureKey)));
  // Differences: one per worked-out check.
  assert.ok(notes.some((n) => n.kind === "difference" && n.figureKey === "interest|2022"));
  // Blind text never names the business.
  const terms = blindLeakTerms({ businessName: fx.deal.businessName, extractedInfo: fx.facts } as any, { codename: "Project Ember" });
  for (const n of notes) if (n.blindText) assert.deepEqual(findBlindLeaks(n.blindText, terms), [], n.blindText);
});

test("changes under 8% (or $2,500) get no suggested note", () => {
  assert.equal(movedEnough(1000000, 1070000), false);
  assert.equal(movedEnough(1000000, 1090000), true);
  assert.equal(movedEnough(10000, 12000), false);
});

test("fingerprints are stable for the same inputs", async () => {
  const { fx, raw } = await fixtureRaw("lakeshore");
  const anchored = new Set(fx.sections.flatMap((s) => anchorFigures(s as any, raw.registry)).map((a) => a.figureKey));
  const a = computedNotes({ registry: raw.registry, checks: raw.checks.checks, anchoredKeys: anchored });
  const b = computedNotes({ registry: raw.registry, checks: raw.checks.checks, anchoredKeys: anchored });
  assert.deepEqual(a.map((n) => n.inputFingerprint), b.map((n) => n.inputFingerprint));
});

await run("figure-computed");
