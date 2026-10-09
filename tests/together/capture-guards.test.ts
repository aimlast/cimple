/**
 * The guards between the extraction call and the facts (specs/together.md
 * §5.6, §11.1). Pure — no model, no database.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/together/capture-guards.test.ts
 */
import assert from "node:assert/strict";
import type { CoverageBoard } from "../../shared/coverage-board";
import { catalogueFromBoard, parseCaptureOutput, type CaptureOutput } from "../../server/together/capture";
import { guardCaptured, promoteHeld, quoteFound, type GuardLine } from "../../server/together/capture-guards";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const item = (sectionKey: string, id: string, label: string, members: Array<[string, string, boolean?]>, extra: Record<string, unknown> = {}) => ({
  id: `${sectionKey}:${id}`,
  sectionKey,
  label,
  members: members.map(([key, l, w]) => ({ key, label: l, writable: w !== false })),
  readKeys: members.map(([k]) => k),
  valueKey: null,
  critical: false,
  origin: "generic",
  status: "missing",
  reason: null,
  value: null,
  source: null,
  ask: `Ask about ${label}?`,
  why: "",
  marks: [],
  ...extra,
});

const board = {
  dealId: "D1",
  audience: "screen",
  sections: [
    { key: "seasonality", title: "Seasonality", items: [item("seasonality", "seasonality", "Busy and slow months", [["seasonality", "seasonality"], ["peakPeriods", "busiest months"], ["slowPeriods", "quietest months"]])] },
    { key: "employees", title: "Employee Overview", items: [item("employees", "employees", "Number of staff", [["employees", "headcount"]]), item("employees", "employeeStructure", "Team and key people", [["employeeStructure", "roles"], ["keyEmployees", "key people"]])] },
    { key: "permits_licenses", title: "Permits & Licenses", items: [item("permits_licenses", "permitsLicenses", "Permits and licences", [["permitsLicenses", "licences"]])] },
    { key: "real_estate", title: "Real Estate", items: [item("real_estate", "leaseDetails", "Premises and lease", [["leaseDetails", "lease"], ["leaseExpiry", "lease end"]])] },
    { key: "overview", title: "Overview", items: [item("overview", "companyHistory", "History", [["companyHistory", "history"]])] },
    {
      key: "financials",
      title: "Financial Summary",
      items: [
        item("financials", "annualRevenue", "Revenue, last full year", [["annualRevenue", "revenue"]], { value: "$4,812,300" }),
        item("financials", "revenueByYear", "Revenue by year and growth", [["revenueByYear", "revenue per year"], ["revenueGrowth", "growth rate"]]),
        item("financials", "ebitda", "Profit", [["ebitda", "EBITDA as the statements show it"], ["sde", "SDE", false], ["netIncome", "net income (after tax)"], ["grossProfit", "gross profit"]]),
        item("financials", "addbacks", "Owner's personal and one-time costs", [["addbacks", "personal or one-time costs"]]),
        item("financials", "reasonRentChange2024", "Why did rent rise in 2024?", [["reasonRentChange2024", "the seller's reason"]], { origin: "figures" }),
      ],
    },
  ],
  routed: [],
  documents: [],
} as unknown as CoverageBoard;
const catalogue = catalogueFromBoard(board);

const out = (o: Partial<CaptureOutput>): CaptureOutput => ({ answers: [], notKnown: [], brokerUnconfirmed: [], private: [], withdrawn: [], otherFacts: [], followUp: null, topicSections: [], ...o });
const ans = (key: string, value: string, quote: string, lines: number[], speaker: "seller" | "broker_confirmed" | "typed" = "seller", confidence: "confirmed" | "approximate" = "confirmed") =>
  ({ key, value, quote, lines, speaker, confidence, basis: "verbatim" as const });

const ctx = (lines: GuardLine[], extra: Record<string, unknown> = {}) => ({
  newLines: lines,
  catalogue,
  sellerFacts: { annualRevenue: "$4,812,300" },
  keepOut: [],
  today: new Date("2026-10-09T12:00:00Z"),
  ...extra,
});
const S = (seq: number, text: string): GuardLine => ({ seq, role: "seller", typed: false, text });
const B = (seq: number, text: string): GuardLine => ({ seq, role: "broker", typed: false, text });
const U = (seq: number, text: string): GuardLine => ({ seq, role: "unknown", typed: false, text });
const T = (seq: number, text: string): GuardLine => ({ seq, role: "broker", typed: true, text });

console.log("capture guards");

test("the checklist names each member with its own meaning; the broker's computations are never filed from a call", () => {
  assert.ok(catalogue.byKey.has("netIncome") && catalogue.byKey.has("revenueGrowth"));
  assert.ok(!catalogue.byKey.has("sde"));
});

test("shape: unknown keys, aliases' broker work (sde) and bad 'also noted' keys are dropped", () => {
  const g = guardCaptured(out({
    answers: [ans("favouriteColour", "Blue", "blue", [2]), ans("sde", "$600K", "six hundred", [2])],
    otherFacts: [{ key: "_secret", label: "x", sectionKey: "overview", value: "y", quote: "blue", confidence: "confirmed", lines: [2] }, { key: "fleetSize", label: "Fleet", sectionKey: "nowhere", value: "22", quote: "blue", confidence: "confirmed", lines: [2] }],
  }), ctx([B(1, "Tell me more?"), S(2, "Honestly the colour is blue and SDE is six hundred.")]));
  assert.equal(g.spoken.length, 0);
  assert.deepEqual(g.dropped.map((d) => d.code).sort(), ["bad_other_fact", "bad_other_fact", "broker_work", "unknown_key"]);
});

test("quote and speaker: a quote not in the cited lines, a cited line outside the part, a broker's words as the seller's → dropped", () => {
  const lines = [B(1, "So you have thirty-six staff?"), S(2, "We're busy all summer.")];
  const g = guardCaptured(out({
    answers: [
      ans("seasonality", "Busy in winter", "busy all winter long", [2]),
      ans("employees", "36", "thirty-six staff", [1]),
      ans("peakPeriods", "Summer", "busy all summer", [9]),
    ],
  }), ctx(lines));
  assert.equal(g.spoken.length, 0);
  assert.deepEqual(g.dropped.map((d) => d.code), ["quote_not_found", "not_seller", "not_new"]);
  assert.ok(quoteFound("summer and the cold snaps are crazy", ["Summer and the cold snaps are crazy — June through August."]));
});

test("members: 'net income was about 400K' files under netIncome, never EBITDA; growth under revenueGrowth, never revenue", () => {
  const lines = [B(1, "What did it earn last year?"), S(2, "Net income was about 400K, and sales grow about 10% a year.")];
  const g = guardCaptured(out({
    answers: [ans("netIncome", "About $400K", "Net income was about 400K", [2], "seller", "approximate"), ans("revenueGrowth", "About 10% a year", "sales grow about 10% a year", [2], "seller", "approximate")],
  }), ctx(lines));
  assert.deepEqual(g.spoken.map((a) => [a.key, a.itemId]), [["netIncome", "financials:ebitda"], ["revenueGrowth", "financials:revenueByYear"]]);
  assert.ok(!g.spoken.some((a) => a.key === "ebitda" || a.key === "annualRevenue"));
  assert.equal(g.spoken[0].confidence, "approximate");
});

test("broker statement + 'yeah' → filed with 'The seller agreed'; + silence → shown as unconfirmed, never filed", () => {
  const g = guardCaptured(out({ answers: [ans("employees", "36", "so 36 staff", [1], "broker_confirmed")] }), ctx([B(1, "So 36 staff?"), S(2, "Yeah, that's right.")]));
  assert.equal(g.spoken.length, 1);
  assert.equal(g.spoken[0].speaker, "broker_confirmed");
  assert.match(g.spoken[0].excerpt, /^The seller agreed: "So 36 staff\?" — "Yeah, that's right\."/);
  const g2 = guardCaptured(out({ answers: [ans("leaseExpiry", "2029", "your lease runs to 2029", [1], "broker_confirmed")] }), ctx([B(1, "And your lease runs to 2029."), B(2, "Let's talk about trucks.")]));
  assert.equal(g2.spoken.length, 0);
  assert.equal(g2.brokerUnconfirmed[0].key, "leaseExpiry");
});

test("unknown speakers → held possible answers; promoted once roles are known; a broker reading a CRM figure aloud is never filed", () => {
  const lines = [U(1, "So it says here 400 thousand from the notes."), U(2, "Summer and the cold snaps are crazy.")];
  const g = guardCaptured(out({ answers: [ans("netIncome", "$400K", "400 thousand", [1]), ans("seasonality", "Summer and cold snaps", "Summer and the cold snaps are crazy", [2])] }), ctx(lines));
  assert.equal(g.spoken.length, 0);
  assert.equal(g.suggestions.length, 2);
  const roles = new Map([[1, "broker" as const], [2, "seller" as const]]);
  const p = promoteHeld(g.suggestions, (seq) => roles.get(seq)!);
  assert.deepEqual(p.file.map((h) => h.memberKey), ["seasonality"]);
  assert.deepEqual(p.brokerUnconfirmed.map((h) => h.memberKey), ["netIncome"]);
  assert.equal(p.stillHeld.length, 0);
});

test("typed lines → the broker's own note, never the seller's words", () => {
  const g = guardCaptured(out({ answers: [ans("employees", "22 trucks, 36 staff", "36 staff", [1], "typed")] }), ctx([T(1, "22 trucks, 36 staff")]));
  assert.equal(g.spoken.length, 0);
  assert.deepEqual(g.typed.map((t) => t.key), ["employees"]);
  const g2 = guardCaptured(out({ answers: [ans("employees", "36", "36 staff", [1], "typed")] }), ctx([S(1, "36 staff")]));
  assert.equal(g2.typed.length, 0, "a seller line can't be filed as typed");
});

test("normalisation: an add-back item keeps its fact under a neutral key; the treatment goes to a private note", () => {
  const g = guardCaptured(out({ answers: [ans("wifeSalaryAddback", "Wife's $60K salary — add-back", "my wife's 60K salary is an add-back", [1])] }), ctx([S(1, "My wife's 60K salary is an add-back, she doesn't work there.")]));
  assert.ok(g.privateNotes.some((n) => /add-back/i.test(n.note)));
  assert.ok(!g.spoken.some((a) => /addback/i.test(a.key)));
});

test("numeric fidelity: 'six to fourteen thousand' filed as $4,000–$18,000 → to verify (number)", () => {
  const g = guardCaptured(out({ answers: [ans("seasonality", "Slow months run $4,000–$18,000 a month", "six to fourteen thousand", [1])] }), ctx([S(1, "In the slow months it's anywhere from six to fourteen thousand.")]));
  assert.equal(g.spoken[0]?.verify, "number");
});

test("grounding: spelled-out figures are the seller's words; a figure they never said is never 'confirmed'", () => {
  const g = guardCaptured(out({ answers: [ans("annualRevenue", "$4.8M", "about four point eight", [1])] }), ctx([S(1, "Revenue was about four point eight.")]));
  assert.equal(g.spoken[0]?.key, "annualRevenue");
  assert.equal(g.spoken[0]?.verify, undefined);
  const g2 = guardCaptured(out({ answers: [ans("annualRevenue", "$6.1M", "around 5 million", [1])] }), ctx([S(1, "Revenue was around 5 million last year.")]));
  assert.equal(g2.spoken[0]?.verify, "number");
  assert.equal(g2.spoken[0]?.confidence, "approximate");
});

test("date fidelity: a year the seller never said → to verify (date)", () => {
  const g = guardCaptured(out({ answers: [ans("companyHistory", "Opened the second shop in 2019", "we opened the second shop", [1])] }), ctx([S(1, "We opened the second shop a few years back.")]));
  assert.equal(g.spoken[0]?.verify, "date");
});

test("legal: the broker's legal premise + the seller's 'yes' → inferred, to check with a lawyer", () => {
  const lines = [B(1, "Ontario law requires the company to hold the TSSA licence for gas work."), S(2, "Yes, the company must hold the TSSA licence.")];
  const g = guardCaptured(out({ answers: [ans("permitsLicenses", "The company must hold the TSSA licence for gas work", "the company must hold the TSSA licence", [2])] }), ctx(lines));
  assert.equal(g.spoken[0]?.verify, "legal");
  assert.equal(g.spoken[0]?.confidence, "inferred");
});

test("keep-out: 'don't put Dave's divorce in the book' → held, a private note and a keep-out entry", () => {
  const lines = [S(1, "Dave is going through a divorce right now and might need time off, but don't put that in the book.")];
  const g = guardCaptured(out({
    answers: [ans("employeeStructure", "Dave is going through a divorce right now and might need time off this year", "Dave is going through a divorce", [1])],
    private: [{ note: "Dave (technician) is going through a divorce", reason: "seller_asked", keepOutTerms: ["divorce"] }],
  }), ctx(lines));
  assert.equal(g.spoken.length, 0);
  assert.ok(g.dropped.some((d) => d.code === "keep_out"));
  assert.equal(g.keepOut[0].terms[0], "divorce");
  assert.ok(g.privateNotes.length >= 1);
});

test("staff-private: an equity ask goes to the private notes, never to the facts", () => {
  const g = guardCaptured(out({ private: [{ note: "Dave asked about buying into the business", reason: "staff_private" }] }), ctx([S(1, "Dave asked me about buying in.")]));
  assert.equal(g.spoken.length, 0);
  assert.equal(g.privateNotes[0].note, "Dave asked about buying into the business");
});

test("withdrawals, 'doesn't know' and a question about the numbers", () => {
  const g = guardCaptured(out({
    withdrawn: [{ key: "employees", quote: "scratch that number" }],
    notKnown: [{ key: "leaseExpiry", whoHasIt: "Denise", quote: "my bookkeeper Denise has the lease" }],
    answers: [ans("reasonRentChange2024", "The landlord passed on a property-tax increase", "the landlord passed on the tax increase", [1])],
  }), ctx([S(1, "Scratch that number. My bookkeeper Denise has the lease. The rent went up because the landlord passed on the tax increase.")]));
  assert.deepEqual(g.retractions.map((r) => r.field), ["employees"]);
  assert.deepEqual(g.notKnown.map((n) => [n.key, n.whoHasIt]), [["leaseExpiry", "Denise"]]);
  assert.deepEqual(g.spoken.map((a) => a.key), ["reasonRentChange2024"]);
});

test("the tool's output is validated: an unusable shape is null; bad entries are skipped", () => {
  assert.equal(parseCaptureOutput(null), null);
  assert.equal(parseCaptureOutput({ answers: "nope" }), null);
  const p = parseCaptureOutput({ answers: [{ key: "", value: "x" }, { key: "seasonality", value: "Summer", quote: "summer", lines: [1, "2"], speaker: "weird" }], otherFacts: [1, 2, 3, 4].map((i) => ({ key: `fact${i}`, value: "v", label: "l", sectionKey: "overview", quote: "q", confidence: "confirmed" })) });
  assert.equal(p!.answers.length, 1);
  assert.deepEqual(p!.answers[0].lines, [1]);
  assert.equal(p!.answers[0].speaker, "seller");
  assert.equal(p!.otherFacts.length, 3, "at most 3 'also noted'");
});

console.log(`\n${passed} guard checks passed`);
