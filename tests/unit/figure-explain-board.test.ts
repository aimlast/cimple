/**
 * Contract with stream "together" (INTEGRATION §2.5, dd §11.5): questions
 * about the numbers as board items under Financials, keyed by capture key.
 *   npx tsx tests/unit/figure-explain-board.test.ts
 * Round trip: the seller's spoken answer filed under the capture key (a
 * `call` fact, as together's note-taker writes it) becomes an I-ref the AI
 * pass may cite, and a note citing it reads "From a conversation with the
 * owner"; a broker's "Mark answered" (broker provenance) never becomes
 * the owner's words.
 */
import assert from "node:assert/strict";
import { captureKeyFor, explainBoardItems, isCaptureKey, EXPLAIN_WHY } from "../../shared/figure-explain";
import { noteRow, run, test } from "./helpers/figure-test";
import { buildFigureEvidence } from "../../server/cim/figures/evidence";
import { noteSourceOf } from "../../server/cim/figures/build";
import { noteInputOf } from "../../server/cim/figures/serve";
import { screenCtxFor } from "../../server/cim/figures/guards";

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

test("together files the seller's spoken answer under the key → cited as 'a conversation with the owner'", () => {
  const key = captureKeyFor("Fuel", "movement", "2023");
  const facts: Record<string, unknown> = {
    [key]: "We locked in a fixed diesel price in March 2023, so fuel came down.",
    _fieldSources: { [key]: { source: "video_call", sessionId: "sit-1", speaker: "seller", excerpt: "fixed diesel price in March 2023" } },
  };
  const ev = buildFigureEvidence({
    targets: [{ line: "line:fuel" as any, lineLabel: "Fuel", year: "2023", fromYear: "2022" }],
    facts, sessions: [], documents: [], discrepancies: [], screen: screenCtxFor(facts), hints: [],
  });
  const ref = Array.from(ev.refs.values()).find((r) => r.meta.factKey === key);
  assert.ok(ref, "the filed answer is evidence");
  assert.equal(ref!.kind, "transcript");
  const source = noteSourceOf(ref!, "fixed diesel price in March 2023");
  const note = noteInputOf(noteRow({ figureKey: "line:fuel|2023", origin: "ai", sources: [source] }), new Map());
  assert.equal(note.basis, "conversation");
  assert.equal(note.basisLabel, "From a conversation with the owner");
  // The broker's "Mark answered" (broker provenance) is the broker's, not the owner's.
  const byBroker = { ...facts, _fieldSources: { [key]: { source: "broker" } } };
  const ev2 = buildFigureEvidence({
    targets: [{ line: "line:fuel" as any, lineLabel: "Fuel", year: "2023", fromYear: "2022" }],
    facts: byBroker, sessions: [], documents: [], discrepancies: [], screen: screenCtxFor(byBroker), hints: [],
  });
  assert.ok(!Array.from(ev2.refs.values()).some((r) => r.meta.factKey === key && (r.kind === "transcript" || r.kind === "fact")), "never quoted as the owner");
});

await run("figure-explain-board (together contract)");
