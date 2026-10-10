/**
 * Questions about the numbers for the seller (spec D13, §6). No AI, no DB.
 *   npx tsx tests/unit/explain-questions.test.ts
 *
 * Proves, on the Pacific / Lakeshore demo fixtures (fictional): fuel 2022 →
 * 2023 becomes a question with the statements' own figures; facility rent
 * (an analysis hint matches) gets none; caps (3 routed automatically, 6 open);
 * never EBITDA / SDE / margins / taxes / pay or a D9a cell; values only from
 * shared statements (a broker-only statement → no numbers); a figure with a
 * note, a recorded reason or a conflict about the same line and year gets
 * none; auto-ask is off for a deal from before the release and needs a
 * seller session; the hand-back (answered / asked / an auto-routed question
 * never raised goes back to suggested); nothing is ever written to
 * `discrepancies`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixtureRaw, run, test } from "./helpers/figure-test";
import { anchorFigures } from "../../shared/figure-anchors";
import { hintsFor } from "../../server/cim/figures/hints";
import {
  AUTO_ASK_SINCE, autoAskSince, MAX_AUTO_ROUTED, MAX_OPEN_QUESTIONS, autoAskEffective, explainQuestionDiscussed, explainRequestsOf, handBackPlan, planQuestions,
  questionDisplay, valuesSentence, type PlanInput,
} from "../../server/cim/figures/requests";
import { askableLine, discrepancyAbout } from "../../server/cim/figures/candidates";
import { captureKeyFor, isCaptureKey } from "../../shared/figure-explain";

async function planFor(name: "pacific" | "lakeshore", over: Partial<PlanInput> = {}) {
  const { fx, raw } = await fixtureRaw(name);
  const anchored = fx.sections.flatMap((s: any) => anchorFigures(s, raw.registry)).map((a) => a.figureKey);
  const statements = raw.sources.filter((s) => s.kind === "statements")
    .map((source) => ({ source, text: fx.documents.find((d: any) => d.id === source.documentId)?.extractedText ?? null }));
  const input: PlanInput = {
    registry: raw.registry, anchoredKeys: anchored, checks: raw.checks.checks, notes: [], facts: raw.info,
    hints: hintsFor(Object.keys(raw.registry), raw.registry, raw.hintSentences), discrepancies: [], questions: [], statements, autoRoute: true,
    ...over,
  };
  return { fx, raw, input, plan: planQuestions(input) };
}

test("Pacific: fuel 2022 → 2023 is asked with the statements' figures; facility rent (a hint matches) is not", async () => {
  const { plan } = await planFor("pacific");
  const fuel = plan.inserts.find((q) => q.figureKey === "line:fuel|2023");
  assert.ok(fuel, "fuel is a question");
  assert.equal(fuel!.question, "What was behind the drop in fuel in 2023?");
  assert.deepEqual(fuel!.valuesShown, { line: "fuel", fromYear: "2022", from: 5420000, year: "2023", value: 4760000 });
  assert.equal(fuel!.captureKey, "reasonFuelChange2023");
  assert.ok(isCaptureKey(fuel!.captureKey));
  assert.equal(questionDisplay({ question: fuel!.question, valuesShown: fuel!.valuesShown }),
    "What was behind the drop in fuel in 2023? (Your statements show $5,420,000 in 2022 and $4,760,000 in 2023.)");
  assert.ok(!plan.inserts.some((q) => /facility-rent/.test(q.figureKey)), "the warehouse-lease hint covers facility rent");
});

test("caps: at most 3 routed automatically and 6 open, largest changes first", async () => {
  for (const name of ["pacific", "lakeshore"] as const) {
    const { plan } = await planFor(name);
    assert.ok(plan.inserts.length <= MAX_OPEN_QUESTIONS);
    assert.ok(plan.inserts.filter((q) => q.status === "ask_seller").length <= MAX_AUTO_ROUTED);
    assert.ok(plan.inserts.filter((q) => q.status === "ask_seller").every((q) => q.routedBy === "auto"));
  }
  // Existing open questions count against the caps.
  const open = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, figureKey: `line:x${i}|2023`, kind: "movement", compareKey: "2022", captureKey: `reasonX${i}Change2023`, status: "ask_seller", routedBy: "broker" }));
  const { plan: full } = await planFor("pacific", { questions: open as any });
  assert.equal(full.inserts.length, 0);
  const routed = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, figureKey: `line:y${i}|2023`, kind: "movement", compareKey: "2022", captureKey: `reasonY${i}Change2023`, status: "ask_seller", routedBy: "auto" }));
  const { plan: some } = await planFor("pacific", { questions: routed as any });
  assert.ok(some.inserts.length > 0 && some.inserts.every((q) => q.status === "suggested"), "auto-routing stops at 3");
});

test("no auto-route without a seller session / auto-ask (everything waits for the broker)", async () => {
  const { plan } = await planFor("pacific", { autoRoute: false });
  assert.ok(plan.inserts.length > 0 && plan.inserts.every((q) => q.status === "suggested" && q.routedBy === null));
});

test("never EBITDA, SDE, margins, net income, taxes, pay or one-time items; never a D9a cell", async () => {
  const { raw, plan } = await planFor("pacific");
  for (const q of plan.inserts) {
    assert.ok(!/^(?:ebitda|sde|grossProfit|netIncome|incomeBeforeTax|incomeTaxes|grossMargin)/.test(q.figureKey), q.figureKey);
    assert.ok(askableLine(raw.registry[q.figureKey]), q.figureKey);
    const cat = raw.registry[q.figureKey].category;
    assert.ok(!["Owner Compensation", "Non-Recurring", "Taxes"].includes(String(cat)), q.figureKey);
  }
  const held = new Set(raw.checks.checks.filter((c) => c.kind === "cim_statements" && c.cimMismatch).map((c) => c.figureKey));
  assert.ok(held.size > 0, "Pacific FY2022 is held");
  assert.ok(!plan.inserts.some((q) => held.has(q.figureKey)), "no question on a D9a figure");
  assert.ok(!plan.inserts.some((q) => q.figureKey === "costOfSales|2023" || q.figureKey === "operatingExpenses|2023"), "nor on a total measured from one");
});

test("values only from shared statements: none on file → the question carries no numbers", async () => {
  const { plan } = await planFor("pacific", { statements: [] });
  const fuel = plan.inserts.find((q) => q.figureKey === "line:fuel|2023")!;
  assert.deepEqual(fuel.valuesShown, { line: "fuel" });
  assert.equal(valuesSentence(fuel.valuesShown), null);
  assert.equal(questionDisplay({ question: fuel.question, valuesShown: fuel.valuesShown }), "What was behind the drop in fuel in 2023?");
});

test("a note, a recorded reason or a conflict about the same line and year → no question", async () => {
  const base = await planFor("pacific");
  const fuel = base.plan.inserts.find((q) => q.figureKey === "line:fuel|2023")!;
  const withNote = await planFor("pacific", { notes: [{ figureKey: "line:fuel|2023", kind: "movement", compareKey: "2022", status: "suggested", origin: "ai", inputFingerprint: "x" }] });
  assert.ok(!withNote.plan.inserts.some((q) => q.figureKey === fuel.figureKey));
  const withReason = await planFor("pacific", { facts: { ...base.raw.info, reasonFuelChange2023: "A fixed-price diesel contract." } });
  assert.ok(!withReason.plan.inserts.some((q) => q.figureKey === fuel.figureKey));
  const withConflict = await planFor("pacific", { discrepancies: [{ field: "Fuel expense 2023", factKey: null, factYear: "2023", status: "resolved" }] });
  assert.ok(!withConflict.plan.inserts.some((q) => q.figureKey === fuel.figureKey));
  assert.ok(discrepancyAbout({ field: "Revenue", factKey: "revenueByYear", factYear: "2023" }, "revenue", "Revenue", "2023"));
  assert.ok(!discrepancyAbout({ field: "Revenue", factKey: "revenueByYear", factYear: "2022" }, "revenue", "Revenue", "2023"));
});

test("answered (a fact under the capture key) and closed (the note was approved)", async () => {
  const q = { id: "q1", figureKey: "line:fuel|2023", kind: "movement", compareKey: "2022", captureKey: "reasonFuelChange2023", status: "ask_seller", routedBy: "auto" };
  const base = await planFor("pacific");
  const answered = await planFor("pacific", { questions: [q] as any, facts: { ...base.raw.info, reasonFuelChange2023: "A fixed-price diesel contract from March 2023." } });
  assert.deepEqual(answered.plan.answered, ["q1"]);
  const closed = await planFor("pacific", { questions: [q] as any, notes: [{ id: "n1", figureKey: "line:fuel|2023", kind: "movement", compareKey: "2022", status: "approved", origin: "broker", inputFingerprint: "broker" }] });
  assert.deepEqual(closed.plan.closed, [{ id: "q1", reason: "note_approved" }]);
});

test("auto-ask: the broker's choice wins; otherwise only deals created since the release", () => {
  const before = new Date(Date.parse(AUTO_ASK_SINCE) - 86_400_000);
  const after = new Date(Date.parse(AUTO_ASK_SINCE) + 86_400_000);
  assert.equal(autoAskEffective(null, before), false);
  assert.equal(autoAskEffective(null, after), true);
  assert.equal(autoAskEffective(true, before), true);
  assert.equal(autoAskEffective(false, after), false);
  assert.equal(autoAskEffective(null, null), false);
});

test("SEC-F3: the threshold is the ship day (not a placeholder); FIGURES_AUTO_ASK_SINCE moves it without a code change", () => {
  assert.equal(AUTO_ASK_SINCE, "2026-10-11T00:00:00.000Z");
  assert.equal(autoAskSince({}), Date.parse(AUTO_ASK_SINCE));
  assert.equal(autoAskSince({ FIGURES_AUTO_ASK_SINCE: "2026-10-14T09:30:00Z" }), Date.parse("2026-10-14T09:30:00Z"));
  assert.equal(autoAskSince({ FIGURES_AUTO_ASK_SINCE: "not a date" }), Date.parse(AUTO_ASK_SINCE), "a bad value is ignored");
  assert.equal(autoAskSince({ FIGURES_AUTO_ASK_SINCE: "  " }), Date.parse(AUTO_ASK_SINCE));
  // A deal created before a later deploy keeps auto-ask off when the variable says so.
  const prev = process.env.FIGURES_AUTO_ASK_SINCE;
  process.env.FIGURES_AUTO_ASK_SINCE = "2026-10-14T00:00:00Z";
  try {
    assert.equal(autoAskEffective(null, new Date("2026-10-12T00:00:00Z")), false);
    assert.equal(autoAskEffective(null, new Date("2026-10-15T00:00:00Z")), true);
  } finally {
    if (prev === undefined) delete process.env.FIGURES_AUTO_ASK_SINCE; else process.env.FIGURES_AUTO_ASK_SINCE = prev;
  }
});

test("hand-back: answered this session / asked / an auto-routed one never raised returns to suggested", () => {
  const qs = [
    { id: "a", status: "ask_seller", routedBy: "auto", captureKey: "reasonFuelChange2023", figureKey: "line:fuel|2023", valuesShown: { line: "fuel" }, question: "What was behind the drop in fuel in 2023?" },
    { id: "b", status: "ask_seller", routedBy: "auto", captureKey: "reasonPortVancouverContainerDrayageChange2024", figureKey: "line:port-of-vancouver-container-drayage|2024", valuesShown: { line: "Port of Vancouver container drayage" }, question: "q" },
    { id: "c", status: "ask_seller", routedBy: "auto", captureKey: "reasonWarehouseLabourBenefitsChange2023", figureKey: "line:warehouse-labour-and-benefits|2023", valuesShown: { line: "warehouse labour & benefits" }, question: "q" },
    { id: "d", status: "ask_seller", routedBy: "broker", captureKey: "reasonAmortizationChange2023", figureKey: "line:amortization|2023", valuesShown: { line: "amortization" }, question: "q" },
  ] as any[];
  const facts = { reasonFuelChange2023: "Fixed-price diesel.", _fieldSources: { reasonFuelChange2023: { source: "interview", sessionId: "s1" } } };
  const messages = [{ role: "ai", content: "Your drayage revenue from the Port of Vancouver dipped in 2024 — what happened there?" }, { role: "user", content: "Not sure." }];
  const steps = handBackPlan(qs, facts, "s1", messages, true);
  assert.deepEqual(steps, [{ id: "a", to: "answered" }, { id: "b", to: "asked" }, { id: "c", to: "suggested" }]);
  // While the interview isn't completed, an unraised question stays with the seller.
  assert.deepEqual(handBackPlan(qs, facts, "s1", messages, false).map((x) => x.id), ["a", "b"]);
  assert.equal(explainQuestionDiscussed(qs[1], messages), true);
  assert.equal(explainQuestionDiscussed(qs[2], messages), false);
});

test("the interview reads only routed questions; capture keys are stable", () => {
  const reqs = explainRequestsOf([
    { status: "ask_seller", captureKey: "reasonFuelChange2023", kind: "movement", figureKey: "line:fuel|2023", valuesShown: { line: "fuel", fromYear: "2022", from: 5420000, year: "2023", value: 4760000 } },
    { status: "suggested", captureKey: "reasonXChange2023", kind: "movement", figureKey: "line:x|2023", valuesShown: { line: "x" } },
  ] as any);
  assert.deepEqual(reqs, [{ captureKey: "reasonFuelChange2023", kind: "movement", line: "fuel", year: "2023", fromYear: "2022", from: 5420000, value: 4760000 }]);
  assert.equal(captureKeyFor("Bad debts", "movement", "2023"), "reasonBadDebtsChange2023");
  assert.equal(captureKeyFor("Interest", "difference", "2022"), "reasonInterestDifference2022");
});

test("nothing is ever written to `discrepancies` (source)", () => {
  for (const f of ["server/cim/figures/requests.ts", "server/cim/figures/candidates.ts", "server/cim/figures/build.ts", "server/routes/figures.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/createDiscrepancy|updateDiscrepancy|insert\(discrepancies\)|update\(discrepancies\)|INSERT INTO discrepancies|UPDATE discrepancies/i.test(src), f);
  }
});

await run("explain-questions");
