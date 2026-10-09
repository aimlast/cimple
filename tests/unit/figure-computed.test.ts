/**
 * Worked-out notes (D6 / D7): the fixed templates, named and blind, and the
 * notes the refresh writes on the demo copies. No DB, no AI.
 *   npx tsx tests/unit/figure-computed.test.ts
 */
import assert from "node:assert/strict";
import { fixtureRaw, run, test } from "./helpers/figure-test";
import {
  changeLine, cimVsStatementsText, differenceComponentsBlindText, differenceComponentsText, groupingOpexText, lowerFirst,
  blindCostCategory, movementBlindText, movementText, restatedText, shortLabel, sourceCheckSummary,
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

test("blind wording names generic categories, never 'mostly from two lines' (checker r1 F2)", async () => {
  const { fx, raw } = await fixtureRaw("pacific");
  const anchored = new Set(fx.sections.flatMap((s) => anchorFigures(s as any, raw.registry)).map((a) => a.figureKey));
  const notes = computedNotes({ registry: raw.registry, checks: raw.checks.checks, anchoredKeys: anchored });
  const tax23 = notes.find((n) => n.figureKey === "incomeTaxes|2023" && n.kind === "movement")!;
  assert.equal(tax23.blindText, "Down $248,215 (59%) from FY2022, mostly current income taxes (−$152,095) and deferred income taxes (−$96,120).");
  for (const n of notes) if (n.blindText) assert.doesNotMatch(n.blindText, /\bfrom (?:one|two|three|\d+) lines?\b/, n.blindText);
  // Lakeshore cost of sales: the parts' categories, not their labels.
  const { fx: lfx, raw: lraw } = await fixtureRaw("lakeshore");
  const lanch = new Set(lfx.sections.flatMap((s) => anchorFigures(s as any, lraw.registry)).map((a) => a.figureKey));
  const cos = computedNotes({ registry: lraw.registry, checks: lraw.checks.checks, anchoredKeys: lanch }).find((n) => n.figureKey === "costOfSales|2023" && n.kind === "movement")!;
  assert.equal(cos.blindText, "Up $334,000 (10%) from FY2022, mostly materials and supplies (+$168,000) and wages and benefits (+$155,000).");
  // No category tells the parts apart and the total has no part noun → no blind wording at all.
  assert.equal(movementBlindText({ from: 100000, to: 150000, fromYear: "2022", partCount: 2, blindWord: "income taxes", parts: [{ word: "income taxes", delta: 30000 }, { word: "income taxes", delta: 20000 }] }), null);
  assert.equal(movementBlindText({ from: 100000, to: 150000, fromYear: "2022", partCount: 1, blindWord: "income taxes", parts: [{ word: null, delta: 50000 }] }), null);
  // A revenue line never gets a cost category; the count of streams stays.
  assert.equal(blindCostCategory("Plumbing service, drains & water heaters", { expense: false, category: "Revenue" }), null);
  assert.equal(blindCostCategory("Owner salary", { expense: true, category: "Owner Compensation" }), null);
  assert.equal(blindCostCategory("Facility rent — 19220 Campbell Ridge Drive", { expense: true, category: "Operating Expenses" }), "occupancy costs");
});

test("checker r2: Blind categories never misfile a line (interest ≠ bank charges, tolls & fuel tax ≠ fuel, dues ≠ technology)", () => {
  const cat = (label: string) => blindCostCategory(label, { expense: true, category: "Operating Expenses" });
  assert.equal(cat("Interest on long-term debt and bank indebtedness"), "interest");
  assert.equal(cat("Licences, permits, tolls & fuel tax"), "licences and fees");
  assert.equal(cat("Dues, memberships & subscriptions"), "licences and fees");
  // The rules round 1 meant to have (word boundaries, which had been written as control characters):
  assert.equal(cat("Rent — warehouse"), "occupancy costs");
  assert.equal(cat("Warehouse lease"), "occupancy costs");
  assert.equal(cat("Tractor leases & equipment rentals"), "equipment leases");
  assert.equal(cat("Auto expenses"), "vehicle and travel costs");
  assert.equal(cat("Automation software"), "technology and communications");
  assert.equal(cat("Bank charges & merchant fees"), "bank charges");
  assert.equal(cat("Fuel"), "fuel");
  assert.equal(cat("Software licences"), "technology and communications");
  assert.equal(cat("Telephone & internet"), "technology and communications");
  assert.equal(cat("Interest and bank charges"), "interest");
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
