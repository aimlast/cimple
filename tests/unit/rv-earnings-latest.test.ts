// V11-3: an old earnings decision must not overrule a newer bridge. Before
// the fix, a resolution made on an earlier bridge ("2024 Adjusted EBITDA" →
// the analysis's own $674,752) stayed rank-1 after the broker approved
// another add-back: the bridge was withheld, SDE vanished ("no confirmed
// figure"), 2023 was dropped and the multiple used the stale figure.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/rv-earnings-latest.test.ts
import assert from "node:assert/strict";
import { earningsCanon, canonLines, earningsWarnings } from "../../server/cim/earnings-canon";
import { buildCimFinancials, earningsChangedAt, stampEarningsChange } from "../../server/cim/cim-financials";

// The analysis after the broker's later add-back edit: 2024 bridges to $700,000, SDE $840,000.
const fin = (bridgeChangedAt?: string): any => ({
  analysisId: "a3", version: 3, reviewed: true, years: ["2023", "2024"],
  pnl: { "2023": { revenue: 5_000_000, ebitda: 520_000 }, "2024": { revenue: 5_400_000, ebitda: 560_000 } },
  lines: [],
  bridge: {
    metric: "ebitda", years: ["2023", "2024"], netIncome: { "2023": 400_000, "2024": 430_000 },
    addbacks: [{ label: "Interest", amounts: { "2023": 60_000, "2024": 70_000 } }],
    adjusted: { "2023": 640_000, "2024": 700_000 }, sdeOnly: [{ label: "Owner salary", amounts: { "2023": 140_000, "2024": 140_000 } }], sde: { "2023": 780_000, "2024": 840_000 },
  },
  workingCapital: null,
  ...(bridgeChangedAt ? { bridgeChangedAt } : {}),
});
const resolution = (resolvedAt: string): any => ({
  id: "d1", field: "2024 Adjusted EBITDA", factKey: "ebitdaByYear", year: "2024",
  resolvedValue: "$674,752", supersededValues: ["$780,052"], resolvedAt, source: "financial_analysis",
});

// 1. Decided on the earlier bridge, add-backs changed after: the bridge stands.
{
  const c = earningsCanon(fin("2026-09-15T12:00:00Z"), "$3,200,000", { extractedInfo: {}, resolved: [resolution("2026-09-10T00:00:00Z")] })!;
  assert.equal(c.override, null, "the stale decision overrules nothing");
  assert.deepEqual(c.unconfirmed, []);
  assert.equal(c.adjustedEbitda["2024"], 700_000);
  assert.equal(c.adjustedEbitda["2023"], 640_000, "earlier years stay");
  assert.equal(c.sde["2024"], 840_000, "SDE stays");
  assert.equal(c.financials!.bridge !== null, true, "the bridge is shown");
  assert.ok(Math.abs(c.multiples.find((m) => m.kind === "adjusted")!.value - 3_200_000 / 700_000) < 1e-9);
  assert.equal(c.staleBrokerFigures?.length, 1);
  const w = earningsWarnings(c, []).join("\n");
  assert.match(w, /\$674,752.*set before the add-backs.*\$700,000/);
  assert.doesNotMatch(canonLines(c).join("\n"), /674,752/);
  console.log("✓ a decision older than the bridge change doesn't overrule it");
}

// 2. The broker's fact the resolution wrote back is just as old: also set aside.
{
  const info = (at: string) => ({
    adjustedEbitdaByYear: { "2024": "$674,752" },
    _fieldSources: { adjustedEbitdaByYear: { source: "broker", at, years: { "2024": { source: "broker", at, note: "Resolved discrepancy" } } } },
  });
  const old = earningsCanon(fin("2026-09-15T12:00:00Z"), "$3,200,000", { extractedInfo: info("2026-09-10T00:00:00Z"), resolved: [] })!;
  assert.equal(old.override, null);
  assert.equal(old.adjustedEbitda["2024"], 700_000);
  const both = earningsCanon(fin("2026-09-15T12:00:00Z"), "$3,200,000", { extractedInfo: info("2026-09-10T00:00:00Z"), resolved: [resolution("2026-09-10T00:00:00Z")] })!;
  assert.equal(both.override, null);
  // Written after the change, the same fact overrules the bridge (the broker's newer word).
  const newer = earningsCanon(fin("2026-09-15T12:00:00Z"), "$3,200,000", { extractedInfo: info("2026-09-16T00:00:00Z"), resolved: [] })!;
  assert.equal(newer.override?.withheld, "bridge");
  assert.equal(newer.adjustedEbitda["2024"], 674_752);
  console.log("✓ the written-back broker fact doesn't overrule the newer bridge either");
}

// 3. Decided after the bridge last changed (Pacific): the broker's figure wins, as before.
{
  const c = earningsCanon(fin("2026-09-15T12:00:00Z"), "$3,200,000", { extractedInfo: {}, resolved: [resolution("2026-09-20T00:00:00Z")] })!;
  assert.equal(c.override?.withheld, "bridge");
  assert.equal(c.adjustedEbitda["2024"], 674_752);
  assert.equal(c.staleBrokerFigures, undefined);
  console.log("✓ a decision newer than the bridge still overrules it");
}

// 4. Unknown bridge date (older analyses): unchanged behaviour.
{
  const c = earningsCanon(fin(), "$3,200,000", { extractedInfo: {}, resolved: [resolution("2026-09-10T00:00:00Z")] })!;
  assert.equal(c.override?.withheld, "bridge");
  console.log("✓ no bridge date: the broker's figure still wins");
}

// 5. The stamp moves only when the bridge's figures move.
const norm = (approved: boolean, notes?: string[]): any => ({
  metric: "ebitda", years: ["2024"], netIncome: { "2024": 430_000 },
  addbacks: [
    { id: "a1", label: "Interest", amounts: { "2024": 70_000 }, approved: true, type: "ebitda" },
    { id: "a2", label: "One-time legal", amounts: { "2024": 25_248 }, approved, type: "ebitda" },
  ],
  ...(notes ? { notes } : {}),
});
{
  const t1 = new Date("2026-09-15T12:00:00Z");
  const edited = stampEarningsChange(norm(false), norm(true), t1) as any;
  assert.equal(edited.earningsChangedAt, t1.toISOString(), "approving an add-back dates the change");
  const noted = stampEarningsChange(edited, { ...norm(true, ["checked with CPA"]) }, new Date("2026-09-18T00:00:00Z")) as any;
  assert.equal(noted.earningsChangedAt, t1.toISOString(), "a note keeps the earlier date");
  const fresh = stampEarningsChange(norm(false), norm(false, ["n"]), t1) as any;
  assert.equal(fresh.earningsChangedAt, undefined, "nothing moved, nothing stamped");
  console.log("✓ the bridge date moves only with its figures");
}

// 6. Across runs: a re-run bridging to the same figures keeps the earlier date.
{
  const v2 = { id: "v2", version: 2, status: "completed", brokerReviewedAt: null, createdAt: new Date("2026-09-01T00:00:00Z"), normalization: norm(true) } as any;
  const v3same = { id: "v3", version: 3, status: "completed", brokerReviewedAt: null, createdAt: new Date("2026-09-20T00:00:00Z"), normalization: norm(true) } as any;
  const v3diff = { ...v3same, normalization: norm(false) };
  assert.equal(earningsChangedAt(v3same, [v2, v3same]), "2026-09-01T00:00:00.000Z");
  assert.equal(earningsChangedAt(v3diff, [v2, v3diff]), "2026-09-20T00:00:00.000Z");
  assert.equal(buildCimFinancials(v3diff, [v2, v3diff])!.bridgeChangedAt, "2026-09-20T00:00:00.000Z");
  assert.equal(buildCimFinancials({ ...v3same, createdAt: undefined } as any)!.bridgeChangedAt, undefined, "unknown stays absent");
  console.log("✓ re-runs keep the date of the last real change");
}

console.log("rv-earnings-latest: all passed");
