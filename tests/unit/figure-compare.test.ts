/**
 * figure-compare + figure-states: sizes, D6 reconciliations (uniqueness),
 * D7 decomposition, D11 located-in-text boundaries, page marks, D5 states.
 *   npx tsx tests/unit/figure-compare.test.ts
 */
import assert from "node:assert/strict";
import { decomposeMovement, locatedIn, pageAt, percentOf, reconcileByComponents, sizeOf, sourceLabelAt } from "../../shared/figure-compare";
import { checkState, preTicked, STATE_PAINT, STATE_WORDS } from "../../shared/figure-states";
import { run, test } from "./helpers/figure-test";

test("sizes: match / rounding / minor / material (D5)", () => {
  assert.equal(sizeOf(268000, 268000), "match");
  assert.equal(sizeOf(268000, 268001), "match");
  assert.equal(sizeOf(268000, 268080), "match", "within 0.05%");
  assert.equal(sizeOf(268000, 268200), "rounding");
  assert.equal(sizeOf(268000, 270400), "minor"); // < $2,500
  assert.equal(sizeOf(268000, 301000), "material");
  assert.equal(sizeOf(20000000, 20015000), "rounding"); // 0.075%
  assert.equal(sizeOf(1000000, 1004000, 50000000), "minor"); // ≥ $2,500 but < 1% and < 0.5% of revenue
  assert.equal(sizeOf(-155000, 155000), "match", "signs don't matter");
});

test("D6: §1.1 reconciliations are exact; families are tried first", () => {
  // Pacific interest 2022: +$33,000 = bank charges.
  const pool = [{ id: "a", label: "Bank charges", value: 33000 }, { id: "b", label: "Office", value: 12000 }, { id: "c", label: "Telephone", value: 21000 }];
  const r = reconcileByComponents(301000 - 268000, pool, [{ id: "a", label: "Bank charges", value: 33000 }]);
  assert.ok(r && r.family);
  assert.deepEqual(r!.components.map((c) => c.id), ["a"]);
  // Pacific opex 2023 vs T2: +$2,292,000 = amortization + interest.
  const fam = [{ id: "amortization", label: "amortization", value: 1880000 }, { id: "interest", label: "interest", value: 412000 }];
  const r2 = reconcileByComponents(7797500 - 5505500, [], fam);
  assert.deepEqual(r2!.components.map((c) => c.id).sort(), ["amortization", "interest"]);
  // Beacon opex 2023: +$80,191 = 67,000 + 13,191.
  assert.ok(reconcileByComponents(80191, [], [{ id: "amortization", label: "a", value: 67000 }, { id: "interest", label: "i", value: 13191 }]));
});

test("D6 uniqueness: two subsets of the same size that both work → no claim", () => {
  const pool = [{ id: "a", label: "A", value: 10000 }, { id: "b", label: "B", value: 10000 }];
  assert.equal(reconcileByComponents(10000, pool), null);
  const pool2 = [{ id: "a", label: "A", value: 6000 }, { id: "b", label: "B", value: 4000 }, { id: "c", label: "C", value: 7000 }, { id: "d", label: "D", value: 3000 }];
  assert.equal(reconcileByComponents(10000, pool2), null, "6+4 and 7+3");
});

test("D6: three lines only inside a known family", () => {
  const pool = [{ id: "a", label: "A", value: 1000 }, { id: "b", label: "B", value: 2000 }, { id: "c", label: "C", value: 4000 }];
  assert.equal(reconcileByComponents(7000, pool), null, "a 3-line combination outside the families is rejected");
  assert.ok(reconcileByComponents(7000, [], pool), "inside the family it is accepted");
});

test("D7: ≤ 3 parts covering ≥ 70%, largest first, same direction", () => {
  // Lakeshore revenue FY2023: +$660,000.
  const r = decomposeMovement({ from: 6180000, to: 6840000 }, [
    { id: "hvacSvc", label: "HVAC service & repair", from: 1500000, to: 1605000 },
    { id: "hvacEq", label: "HVAC equipment replacement & installation", from: 2500000, to: 2790000 },
    { id: "plumb", label: "Plumbing service", from: 900000, to: 1025000 },
    { id: "iaq", label: "Indoor air quality", from: 300000, to: 340000 },
    { id: "club", label: "Comfort Club", from: 980000, to: 1080000 },
  ]);
  assert.ok(r);
  assert.deepEqual(r!.parts.map((p) => p.id), ["hvacEq", "plumb", "hvacSvc"]);
  assert.ok(r!.covered >= 0.7);
  assert.equal(decomposeMovement({ from: 100, to: 100 }, []), null);
  // Spread over many small lines: no 3 cover 70% → null.
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `l${i}`, label: `L${i}`, from: 1000, to: 1100 }));
  assert.equal(decomposeMovement({ from: 10000, to: 11000 }, many), null);
});

test("D11: digit boundaries — never inside a longer number; glued text and glued columns are fine", () => {
  assert.equal(locatedIn("Net income 1,398,000 for the year", 98000), null);
  assert.equal(locatedIn("1398000", 98000), null);
  assert.equal(locatedIn("Total 98,0001 units", 98000), null);
  assert.equal(locatedIn("Total 98,000,000", 98000), null);
  assert.ok(locatedIn("8710Interest and bank charges86,000\n", 86000));
  const both = "$341,010$297,642";
  assert.ok(locatedIn(both, 341010));
  assert.ok(locatedIn(both, 297642));
  // A statement's two columns glued together: current then prior year.
  const glued = "Interest on long-term debt41,00029,000\nOperating expenses (Schedule 2)2,225,0002,048,000\n";
  assert.ok(locatedIn(glued, 41000));
  assert.ok(locatedIn(glued, 29000));
  assert.ok(locatedIn(glued, 2225000));
  assert.ok(locatedIn(glued, 2048000));
  assert.equal(locatedIn(glued, 25000), null, "not inside 2,225,000");
  assert.equal(locatedIn("", 1), null);
});

test("D11: the document's own line label beside the figure (GIFI code dropped)", () => {
  const t = "Schedule 125\n8710Interest and bank charges86,000\n8520Advertising and promotion196,000\n";
  const hit = locatedIn(t, 86000)!;
  assert.equal(hit.sourceLabel, "Interest and bank charges");
  assert.equal(sourceLabelAt("Total operating expenses 7,797,500", 25), "Total operating expenses");
});

test("pages from 'Page N of M' footers, form feeds, or none", () => {
  const t = "a\nPage 1 of 4\nb 301,000\nPage 2 of 4\nc";
  assert.equal(pageAt(t, t.indexOf("301,000")), 2);
  assert.equal(pageAt("x\fy\fz", 4), 3);
  assert.equal(pageAt("no marks here", 3), null);
  assert.equal(locatedIn(t, 301000)!.page, 2);
});

test("percent styles: differences one decimal, changes whole", () => {
  assert.equal(percentOf(33000, 268000), "12.3%");
  assert.equal(percentOf(1378500, 4127000, "change"), "33%");
  assert.equal(percentOf(105000, 585000, "change"), "18%");
  assert.equal(percentOf(1, 0), null);
});

test("D5 states: explanation decides the colour, never the size", () => {
  assert.equal(checkState({ size: "match", regrouped: false, approvedReason: false }), "match");
  assert.equal(checkState({ size: "rounding", regrouped: false, approvedReason: false }), "match");
  assert.equal(checkState({ size: "material", regrouped: true, approvedReason: false }), "regrouped");
  assert.equal(checkState({ size: "minor", regrouped: false, approvedReason: true }), "explained");
  assert.equal(checkState({ size: "minor", regrouped: false, approvedReason: false }), "ask");
  assert.equal(checkState({ size: "material", regrouped: false, approvedReason: false }), "ask");
});

test("D9 pre-ticking and paint: every state has an icon and words", () => {
  assert.equal(preTicked("match"), true);
  assert.equal(preTicked("regrouped"), true);
  assert.equal(preTicked("explained"), true);
  assert.equal(preTicked("ask"), false);
  assert.equal(preTicked("match", { cimMismatch: true }), false);
  assert.equal(preTicked("regrouped", { located: false }), false);
  for (const s of ["match", "regrouped", "explained", "ask"] as const) {
    assert.ok(STATE_PAINT[s].icon && STATE_PAINT[s].words, s);
    assert.ok(STATE_WORDS[s].length > 4, s);
  }
  assert.equal(STATE_PAINT.ask.tint, "#F3E3C3");
  assert.equal(STATE_PAINT.explained.tint, "#E4E8EC");
  assert.equal(STATE_PAINT.match.ink, "#2F6B4F");
  assert.match(STATE_WORDS.ask, /ask the broker/i);
});

await run("figure-compare + states");
