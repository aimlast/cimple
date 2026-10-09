/**
 * Contract with stream "together" (INTEGRATION §2.5, dd §11.5): questions
 * about the numbers as board items under Financials, keyed by capture key.
 *   npx tsx tests/unit/figure-explain-board.test.ts
 * (The refresh offering a filed `call` fact under the key as the note's
 * source is pass 2 — evidence.ts — and gets its own assertion there.)
 */
import assert from "node:assert/strict";
import { captureKeyFor, explainBoardItems, isCaptureKey, EXPLAIN_WHY } from "../../shared/figure-explain";
import { run, test } from "./helpers/figure-test";

test("capture keys", () => {
  assert.equal(captureKeyFor("Fuel", "movement", "2023"), "reasonFuelChange2023");
  assert.equal(captureKeyFor("Bad debts", "movement", "2023"), "reasonBadDebtsChange2023");
  assert.equal(captureKeyFor("Interest", "difference", "2022"), "reasonInterestDifference2022");
  assert.equal(captureKeyFor("Facility rent — warehouse", "movement", "2023"), "reasonFacilityRentWarehouseChange2023");
  assert.ok(isCaptureKey("reasonFuelChange2023"));
  assert.ok(!isCaptureKey("revenueByYear"));
});

test("items from three questions; status mapping; one per capture key", () => {
  const items = explainBoardItems([
    { status: "suggested", captureKey: "reasonFuelChange2023", question: "What was behind the drop in fuel costs in 2023?" },
    { status: "ask_seller", captureKey: "reasonBadDebtsChange2023", question: "What drove the rise in bad debts in 2023?" },
    { status: "answered", captureKey: "reasonInterestDifference2022", question: "Why does interest for 2022 differ?" },
    { status: "asked", captureKey: "reasonFuelChange2023", question: "dup" },
  ]);
  assert.deepEqual(items.map((i) => i.id), ["reasonFuelChange2023", "reasonBadDebtsChange2023"]);
  for (const i of items) {
    assert.equal(i.sectionKey, "financials");
    assert.equal(i.writeKey, i.id);
    assert.deepEqual(i.memberKeys, [i.id]);
    assert.equal(i.critical, false);
    assert.equal(i.origin, "figures");
    assert.equal(i.why, EXPLAIN_WHY);
    assert.equal(i.ask, i.label);
  }
  assert.equal(items[0].label, "What was behind the drop in fuel costs in 2023?");
});

await run("figure-explain-board (together contract)");
