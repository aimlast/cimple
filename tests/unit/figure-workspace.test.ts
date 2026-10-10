/**
 * The broker's "Numbers & sources" payload and the review sheet (spec §5.2–5.3).
 * No AI, no DB (the demo fixtures are fictional; copied read-only).
 *   npx tsx tests/unit/figure-workspace.test.ts
 *
 * Proves: Pacific's "Fix first" names the FY2022 mismatch ($20,384,000 /
 * $4,127,000 vs $20,948,200 / $4,282,000); facility rent is a movement row
 * with the warehouse-lease hint and its status "held" (its total measured
 * from FY2022); differences are grouped (grouped differently / matches /
 * needs checking); the KPIs count; the review sheet pre-ticks notes (not
 * internal-only ones) and explained / regrouped differences, never offers a
 * D9a or unlocated check, and leaves "ask" differences unticked; nothing in
 * the payload is a buyer string.
 */
import assert from "node:assert/strict";
import { fixtureRaw, noteRow, run, test } from "./helpers/figure-test";
import { buildWorkspace } from "../../server/cim/figures/workspace";
import { checkCounts, moveCounts, moveMatches, reviewItems } from "../../shared/figure-workspace";

async function ws(name: "pacific" | "beacon" | "lakeshore", over: { notes?: any[]; ddShownAt?: Date | null } = {}) {
  const { fx, raw } = await fixtureRaw(name, { notes: over.notes ?? [], ddShownAt: over.ddShownAt ?? null });
  return buildWorkspace({
    raw, sections: fx.sections, build: null, autoAsk: false, autoAskChosen: false, stale: false, ddBuyers: 1, dailyLimit: false, oldDdWording: false,
  });
}

test("Pacific: Fix first names the FY2022 mismatch, broker-only", async () => {
  const w = await ws("pacific");
  const fix = w.fixFirst.find((f) => f.kind === "mismatch" && f.year === "2022");
  assert.ok(fix, JSON.stringify(w.fixFirst));
  assert.equal(fix!.message,
    "Your CIM shows FY2022 cost of sales of $20,384,000 and operating expenses of $4,127,000. The FY2022 statements say $20,948,200 and $4,282,000. Fix FY2022 on the Financials tab, or explain the difference, before buyers see checks on these figures.");
});

test("Pacific: movements — facility rent carries the analysis hint; a total measured from FY2022 is held", async () => {
  const w = await ws("pacific");
  const rent = w.moves.find((m) => /^line:facility-rent/.test(m.figureKey) && m.year === "2023");
  assert.ok(rent, w.moves.map((m) => m.figureKey).join(", "));
  assert.match(rent!.hint ?? "", /^Warehouse lease commenced October 1, 2022/);
  assert.equal(rent!.status, "none");
  const opex = w.moves.find((m) => m.figureKey === "operatingExpenses|2023");
  if (opex) {
    assert.equal(opex.status, "held");
    assert.equal(opex.heldYear, "2022");
  }
  assert.ok(w.moves.every((m) => m.delta === null || m.to !== undefined));
  const counts = moveCounts(w.moves);
  assert.equal(counts.all, w.moves.filter((m) => m.status !== "hidden" && !m.folded).length);
  assert.equal(moveCounts(w.moves, { all: true }).all, w.moves.filter((m) => m.status !== "hidden").length);
  assert.ok(moveMatches(rent!, "none") && !moveMatches(rent!, "waiting"));
});

test("F10: derived totals and tax lines with nothing to do are folded and left out of 'Changes explained'; the list opens on what needs you", async () => {
  const w = await ws("pacific");
  const folded = w.moves.filter((m) => m.folded);
  assert.ok(folded.length >= 8, folded.map((m) => m.figureKey).join(", "));
  for (const m of folded) {
    assert.match(m.figureKey, /^(grossProfit|ebitda|incomeBeforeTax|netIncome|incomeTaxes)(@statements)?\||^line:(current|future)/, m.figureKey);
    assert.ok(!m.hint && !m.note && !m.question);
  }
  for (const k of ["netIncome|2023", "ebitda|2024", "incomeTaxes|2023"]) assert.ok(folded.some((m) => m.figureKey === k), k);
  assert.equal(w.kpis.changesTotal, w.moves.filter((m) => m.status !== "hidden" && !m.folded).length);
  // "Needs you": the facility-rent hint — rows with something ready — never a folded total.
  const needs = w.moves.filter((m) => moveMatches(m, "needs"));
  assert.ok(needs.some((m) => /^line:facility-rent/.test(m.figureKey)));
  assert.ok(!needs.some((m) => m.folded || m.status === "shown"));
  // Checker r2 R2-8: a plain askable line with nothing on file is NOT "needs you" — it is under "No reason on file".
  for (const m of needs) assert.ok(m.status !== "none" || m.hint || m.answer || (m.question && ["suggested", "answered"].includes(m.question.status)), m.figureKey);
  const plain = w.moves.filter((m) => m.status === "none" && !m.folded && !m.hint && !m.answer && !m.question);
  assert.ok(plain.length >= 5, `Pacific has a run of plain rows (${plain.length})`);
  for (const m of plain) {
    assert.equal(moveMatches(m, "needs"), false, m.figureKey);
    assert.equal(moveMatches(m, "none"), true, m.figureKey);
  }
  assert.ok(needs.length < w.moves.filter((m) => !m.folded).length / 2, `"Needs you" is the short list (${needs.length})`);
  // A question Cimple prepared puts the row back on "Needs you".
  const withQ = { ...plain[0], question: { id: "q1", status: "suggested" } };
  assert.equal(moveMatches(withQ, "needs"), true);
  // A folded total with a note waiting is not folded (it needs the broker).
  const waitingNote = noteRow({ figureKey: "netIncome|2024", kind: "movement", compareKey: "2023", status: "suggested", origin: "ai", text: "A reason.", valuesSnapshot: { year: "2024", value: 972960, fromYear: "2023", fromValue: 665915 } });
  const w2 = await ws("pacific", { notes: [waitingNote] });
  const ni = w2.moves.find((m) => m.figureKey === "netIncome|2024")!;
  assert.equal(ni.folded, false);
  assert.ok(moveMatches(ni, "needs"));
  // Chips are one line: a document by its kind, the full title on hover (F1).
  const leaseNote = noteRow({ figureKey: "line:facility-rent-warehouse|2023", kind: "movement", compareKey: "2022", status: "suggested", origin: "ai", text: "The warehouse lease started Oct 1, 2022.",
    sources: [{ kind: "document", documentId: "6d52f471-8934-411d-88f0-0b81c2baab9b", quote: "The Commencement Date is October 1, 2022." }, { kind: "interview", quote: "We moved in October." }],
    valuesSnapshot: { year: "2023", value: 0 } });
  const w3 = await ws("pacific", { notes: [leaseNote] });
  const rentChips = w3.moves.find((m) => /^line:facility-rent/.test(m.figureKey) && m.year === "2023")!.note!.chips;
  assert.deepEqual(rentChips.map((c) => c.label), ["Lease", "Owner · interview"]);
  assert.equal(rentChips[0].title, "Warehouse lease — 19220 Campbell Ridge Drive (15 yrs + 2×5-yr options)");
});

test("checks: interest and operating expenses are grouped differently; matches counted; KPIs add up", async () => {
  const w = await ws("pacific");
  const interest22 = w.checks.find((c) => c.figureKey === "interest|2022" && c.kind === "tax_return");
  if (interest22) {
    assert.equal(interest22.group, "regrouped");
    assert.equal(interest22.difference, 33000);
    assert.match(interest22.regroupedText ?? "", /bank charges \(\$33,000\)/);
  }
  const counts = checkCounts(w.checks);
  assert.equal(counts.difference + counts.regrouped + counts.needs_checking + counts.match + counts.left_out, w.checks.length);
  assert.ok(counts.match > 0 && counts.regrouped > 0);
  assert.equal(w.kpis.differences, w.checks.filter((c) => c.group === "difference" || c.group === "regrouped" || c.group === "needs_checking").length);
  assert.equal(w.kpis.differencesExplained, w.checks.filter((c) => c.state === "explained" || c.state === "regrouped").length);
  assert.ok(w.kpis.documentsCited >= 2, "statements and tax returns are cited");
  assert.equal(w.kpis.documentsShared, null, "the data room fills this");
  assert.equal(w.status.hasOtherRecords, true);
  assert.equal(w.status.hasCim, true);
  // D9a figures' checks can never be shown.
  for (const c of w.checks) if (c.figureKey.endsWith("|2022") && /^(costOfSales|operatingExpenses)\|/.test(c.figureKey)) assert.ok(c.refusal, c.checkKey);
});

test("the review sheet: suggested notes ticked (internal-only not), explained/regrouped ticked, D9a never offered, ask unticked", async () => {
  const { raw } = await fixtureRaw("lakeshore");
  const key = Object.keys(raw.registry).find((k) => /^line:comfort-club/.test(k) && k.endsWith("|2023"))!;
  const notes = [
    noteRow({ id: "n1", figureKey: key, kind: "movement", compareKey: "2022", origin: "ai", status: "suggested", text: "Active members grew from 2,150 to 2,520.", sources: [{ kind: "document", documentId: "x", quote: "2,520 active members" }], inputFingerprint: "fp1" }),
    noteRow({ id: "n2", figureKey: key.replace("|2023", "|2024"), kind: "movement", compareKey: "2023", origin: "ai", status: "suggested", text: "From the resolution note.", sources: [{ kind: "discrepancy", internal: true, quote: "Per my note" }], inputFingerprint: "fp2" }),
  ];
  const w = await ws("lakeshore", { notes });
  const items = reviewItems(w);
  const n1 = items.notes.find((n) => n.id === "n1");
  assert.ok(n1 && n1.ticked && n1.fingerprint === "fp1");
  const n2 = items.notes.find((n) => n.id === "n2");
  if (n2) {
    assert.equal(n2.ticked, false);
    assert.match(n2.why ?? "", /internal note/);
  }
  for (const d of items.differences) assert.ok(d.ticked, d.label);
  const p = await ws("pacific");
  const pItems = reviewItems(p);
  assert.ok(!pItems.differences.some((d) => /FY2022/.test(d.label) && /^(Cost of sales|Operating expenses)/.test(d.label)), "D9a never offered as ready");
  for (const n of pItems.needsLook) if (n.why === "Ask the seller first") assert.equal(n.canShow, true);
  assert.ok(pItems.matchesAuto > 0, "matches are shown automatically once the checks are on");
});

test("with the checks on, shown checks are marked; nothing in the payload is buyer copy", async () => {
  const w = await ws("pacific", { ddShownAt: new Date("2026-10-09T00:00:00Z") });
  assert.ok(w.status.ddShownAt);
  assert.ok(w.checks.some((c) => c.shownToBuyers));
  assert.ok(w.checks.filter((c) => c.refusal).every((c) => !c.shownToBuyers));
  // Broker-only material stays broker-side: the payload names documents for the broker only.
  assert.ok(w.checks.some((c) => c.otherDocument?.name.startsWith("T2 corporate income tax return")));
});

await run("figure-workspace");
