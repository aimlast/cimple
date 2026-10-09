/**
 * The AI pass's guards (spec §9.5) and the broker-text guards. No AI.
 *   npx tsx tests/unit/figure-guards.test.ts
 *
 * Proves: a quote not in its source → dropped; a figure not known → dropped;
 * a held name, a keep-out term, a staff departure, a health detail, an
 * employee's name, "the interview" → dropped; three sentences → dropped; a
 * blind leak ("Ottawa", the business name, an analysis line label) → only the
 * blind wording goes (the named note stays). Broker text: privacy blocks with
 * plain messages; an unknown figure only warns ("Your figure").
 */
import assert from "node:assert/strict";
import { run, test } from "./helpers/figure-test";
import {
  guardBrokerText, guardFigureNote, normalizeQuote, screenCtxFor, sentenceCount, type FigureGuardCtx, type RawFigureNote,
} from "../../server/cim/figures/guards";
import { blindLeakTerms } from "../../shared/blind-guard";
import { FIGURE_LINES } from "../../shared/figure-lines";

const info: Record<string, unknown> = {
  businessName: "Pacific Coast Logistics Ltd.",
  ownerName: "Harjit Grewal",
  city: "Ottawa",
  location: "Ottawa, Ontario",
  keyEmployees: "Daniel Okafor (dispatcher) runs the night shift. Priya Shah (controller).",
  _sellerKeepOut: [{ detail: "The pending lawsuit with Westbrook Freight", terms: ["Westbrook Freight"], at: "2026-10-01", turn: 3 }],
  _brokerPrivateNotes: [{ text: "Keep Karen Holt (their buyer at Alderbrook) out of the CIM.", at: "2026-10-01" }],
};
const deal = { businessName: "Pacific Coast Logistics Ltd.", extractedInfo: info, employeeChart: null, blindCodename: "Project Coastline" };

const ctx: FigureGuardCtx = {
  screen: screenCtxFor(info, { names: ["Karen Holt"] }),
  blindTerms: blindLeakTerms(deal as any, { codename: "Project Coastline" }),
  lineLabels: ["Facility rent — warehouse", "Fuel", "Comfort Club memberships"],
  blindWords: FIGURE_LINES.map((l) => l.blindWord),
};

const evidence = {
  refs: new Map<string, { text: string }>([
    ["D1", { text: "The Commencement Date is October 1, 2022. Base rent is $93,375 per month for the warehouse at 4400 Production Way." }],
    ["I1", { text: "We moved into the new warehouse in October 2022, so rent went way up the next year." }],
  ]),
};
const candidate = { id: "C1", value: 1_120_500 + 300_000, fromValue: 300_000 };

const note = (over: Partial<RawFigureNote> = {}): RawFigureNote => ({
  candidateId: "C1",
  status: "explained",
  text: "The new warehouse lease started on October 1, 2022, so FY2023 carried a full year of rent.",
  blindText: "A new premises lease started late in the prior year, so this year carried a full year of rent.",
  sources: [{ ref: "D1", quote: "The Commencement Date is October 1, 2022." }],
  ...over,
});

test("a well-grounded note passes (named and blind wording)", () => {
  const r = guardFigureNote(note(), candidate, evidence, ctx);
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) {
    assert.match(r.text, /October 1, 2022/);
    assert.ok(r.blindText);
  }
});

test("no_reason_on_file and a reason without a source are dropped", () => {
  assert.equal(guardFigureNote(note({ status: "no_reason_on_file" }), candidate, evidence, ctx).ok, false);
  assert.equal(guardFigureNote(note({ sources: [] }), candidate, evidence, ctx).ok, false);
  assert.equal(guardFigureNote(note({ text: "" }), candidate, evidence, ctx).ok, false);
});

test("a ref Cimple didn't give, or a quote not in its source → dropped", () => {
  const a = guardFigureNote(note({ sources: [{ ref: "D9", quote: "The Commencement Date is October 1, 2022." }] }), candidate, evidence, ctx);
  assert.equal(a.ok, false);
  const b = guardFigureNote(note({ sources: [{ ref: "D1", quote: "The lease started in January 2022 at a lower rent." }] }), candidate, evidence, ctx);
  assert.equal(b.ok, false);
  if (!b.ok) assert.match(b.why, /quote isn't in D1/);
});

test("quotes match through curly quotes, dashes, case and spacing", () => {
  assert.equal(normalizeQuote("The  “Commencement Date” is October 1 — 2022"), normalizeQuote("the \"commencement date\" is october 1 - 2022"));
  const r = guardFigureNote(note({ sources: [{ ref: "I1", quote: "We moved into the new warehouse in October   2022" }] }), candidate, evidence, ctx);
  assert.ok(r.ok);
});

test("a figure that is neither the candidate's nor in a quote → dropped; the quote's figures and the change are fine", () => {
  const bad = guardFigureNote(note({ text: "Rent rose because the new warehouse costs $61,500 a month more." }), candidate, evidence, ctx);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.why, /61,500/);
  const fromQuote = guardFigureNote(note({
    text: "The new warehouse's base rent is $93,375 a month, from October 1, 2022.",
    sources: [{ ref: "D1", quote: "Base rent is $93,375 per month for the warehouse" }, { ref: "D1", quote: "The Commencement Date is October 1, 2022." }],
  }), candidate, evidence, ctx);
  assert.ok(fromQuote.ok, JSON.stringify(fromQuote));
  const change = guardFigureNote(note({ text: "Up $1,120,500 because the new warehouse lease started on October 1, 2022." }), candidate, evidence, ctx);
  assert.ok(change.ok, JSON.stringify(change));
});

test("held names, keep-out topics, staff departures, health, employee names and process words → dropped", () => {
  const ev = { refs: new Map([...Array.from(evidence.refs.entries()), ["I2", { text: "Karen Holt at Alderbrook pushed us on rates; Daniel Okafor may leave after his surgery; the Westbrook Freight lawsuit cost us." }]]) };
  const src = [{ ref: "I2", quote: "Karen Holt at Alderbrook pushed us on rates" }];
  const cases: Array<[string, RegExp]> = [
    ["Rates were renegotiated with Karen Holt at Alderbrook.", /kept out/],
    ["Legal costs rose with the Westbrook Freight lawsuit.", /keep out/],
    ["Daniel Okafor, the dispatcher, may leave after his surgery.", /staff|personal|health|private/],
    ["Priya Shah renegotiated the fuel contract.", /staff member/],
    ["As the owner said in the interview, the new warehouse lease started on October 1, 2022.", /internal wording/],
  ];
  for (const [text, why] of cases) {
    const r = guardFigureNote(note({ text, sources: src }), candidate, ev, ctx);
    assert.equal(r.ok, false, text);
    if (!r.ok) assert.match(r.why, why, `${text} → ${r.why}`);
  }
  // The owner may be named in the named wording.
  const owner = guardFigureNote(note({ text: "Harjit Grewal moved the business into the new warehouse; its lease started on October 1, 2022." }), candidate, evidence, ctx);
  assert.ok(owner.ok, JSON.stringify(owner));
});

test("more than two sentences, or over 320 characters → dropped", () => {
  assert.equal(sentenceCount("One. Two. Three."), 3);
  assert.equal(sentenceCount("Revenue was $1.2M. Costs rose 3.5% in FY2023."), 2);
  const r = guardFigureNote(note({ text: "The lease started on October 1, 2022. Rent rose. It was a full year." }), candidate, evidence, ctx);
  assert.equal(r.ok, false);
  const long = guardFigureNote(note({ text: `The new warehouse lease started on October 1, 2022${", and the business moved in".repeat(12)}.` }), candidate, evidence, ctx);
  assert.equal(long.ok, false);
});

test("a blind wording that leaks keeps the named note and drops only the blind one", () => {
  for (const blindText of [
    "The Ottawa warehouse lease started late in the prior year.",
    "Pacific Coast Logistics moved to a new warehouse.",
    "Facility rent — warehouse rose with the new lease.",
  ]) {
    const r = guardFigureNote(note({ blindText }), candidate, evidence, ctx);
    assert.ok(r.ok, blindText);
    if (r.ok) {
      assert.equal(r.blindText, null, blindText);
      assert.ok(r.blindDropped);
      assert.match(r.text, /October 1, 2022/);
    }
  }
});

test("broker text: privacy blocks with the spec's plain messages", () => {
  const staff = guardBrokerText("Daniel Okafor renegotiated the fuel contract.", null, ctx);
  assert.equal(staff.ok, false);
  if (!staff.ok) assert.equal(staff.message, "This names Daniel Okafor, a staff member. Notes never name staff. Use the role instead.");
  const held = guardBrokerText("Rates were renegotiated with Karen Holt.", null, ctx);
  assert.equal(held.ok, false);
  if (!held.ok) assert.equal(held.message, "This names someone the seller asked to keep out of the CIM.");
  const blind = guardBrokerText("The new warehouse lease started in October 2022.", "The Ottawa warehouse lease started in October 2022.", ctx);
  assert.equal(blind.ok, false);
  if (!blind.ok) {
    assert.equal(blind.field, "blindText");
    assert.equal(blind.message, "This would show “Ottawa” in the Blind CIM. Change the blind wording or turn it off for the Blind CIM.");
  }
  // "Maria Moretti (spouse)" on staff is blocked; the owner is allowed.
  const spouse = screenCtxFor({ ownerName: "Tony Moretti", keyEmployees: "Maria Moretti (spouse) keeps the books." });
  const c2 = { ...ctx, screen: spouse };
  assert.equal(guardBrokerText("Tony Moretti renewed the lease in 2023.", null, c2).ok, true);
  assert.equal(guardBrokerText("Maria Moretti cut the bookkeeping costs.", null, c2).ok, false);
});

test("broker text: an unknown figure only warns (\"Your figure\")", () => {
  const r = guardBrokerText("The new lease added about $61,500 a month.", null, ctx, { candidate });
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.warnings[0]?.message ?? "", /^Your figure: \$61,500/);
  const fine = guardBrokerText("Up $1,120,500 with the new warehouse lease.", null, ctx, { candidate });
  assert.ok(fine.ok && fine.warnings.length === 0);
});

await run("figure-guards");
