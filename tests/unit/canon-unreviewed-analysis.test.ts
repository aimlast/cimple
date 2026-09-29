// A newer financial analysis the broker hasn't reviewed never overrules the
// broker's own or resolved adjusted EBITDA (Pacific rebuild 2026-09-28: the
// unreviewed v2's $4,222,200 would have replaced the broker's resolved
// $3,900,000 everywhere, with a 4.3× multiple instead of 4.6×).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/canon-unreviewed-analysis.test.ts
import assert from "node:assert/strict";
import { earningsCanon, earningsWarnings, canonLines } from "../../server/cim/earnings-canon";
import { buildCimFinancials, stampEarningsChange } from "../../server/cim/cim-financials";

const norm = (owner: number): any => ({
  metric: "ebitda", years: ["2024"], netIncome: { "2024": 972_960 },
  addbacks: [
    { id: "a1", label: "Interest, taxes, D&A", amounts: { "2024": 2_638_240 }, approved: true, type: "ebitda" },
    { id: "a2", label: "Owner compensation above market", amounts: { "2024": owner }, approved: true, type: "ebitda" },
    { id: "a3", label: "Other add-backs", amounts: { "2024": 209_000 }, approved: true, type: "ebitda" },
  ],
});
const analysis = (o: { version: number; createdAt: string; reviewedAt?: string | null; normalization: any }): any => ({
  id: `v${o.version}`, version: o.version, status: "completed", brokerReviewedAt: o.reviewedAt ? new Date(o.reviewedAt) : null,
  createdAt: new Date(o.createdAt), reclassifiedPnl: null, normalization: o.normalization,
});
// The broker resolved 2024 adjusted EBITDA at $3,900,000 on 2026-02-01.
const resolved: any[] = [{ id: "d1", field: "2024 Adjusted EBITDA", factKey: "ebitdaByYear", year: "2024", resolvedValue: "$3,900,000", supersededValues: ["$4,100,000"], resolvedAt: "2026-02-01T00:00:00Z", source: "financial_analysis" }];
// v2, re-run on 2026-09-29, bridges to $4,222,200 ($402K owner add-back).
const v2 = analysis({ version: 2, createdAt: "2026-09-29T01:16:40Z", normalization: norm(402_000) });

// 1. Unreviewed and newer: the broker's figure stands, and the broker is told.
{
  const fin = buildCimFinancials(v2, [v2])!;
  assert.equal(fin.reviewed, false);
  const c = earningsCanon(fin, "$18,000,000", { extractedInfo: {}, resolved })!;
  assert.equal(c.adjustedEbitda["2024"], 3_900_000, "the broker's resolved figure is the CIM's");
  assert.equal(c.override?.withheld, "bridge", "the disagreeing bridge is left out");
  assert.equal(c.staleBrokerFigures, undefined);
  assert.ok(Math.abs(c.multiples.find((m) => m.kind === "adjusted")!.value - 18_000_000 / 3_900_000) < 1e-9, "4.6×, not 4.3×");
  const w = earningsWarnings(c, []).join("\n");
  assert.match(w, /analysis v2 gives \$4,222,200 .* you haven't reviewed it, so the CIM keeps your \$3,900,000/);
  assert.doesNotMatch(canonLines(c).join("\n"), /4,222,200/);
  console.log("✓ an unreviewed newer analysis doesn't overrule the broker's figure");
}

// 2. The same analysis once the broker reviewed it: the newer, approved bridge wins.
{
  const reviewed = { ...v2, brokerReviewedAt: new Date("2026-09-30T00:00:00Z") };
  const c = earningsCanon(buildCimFinancials(reviewed, [reviewed])!, "$18,000,000", { extractedInfo: {}, resolved })!;
  assert.equal(c.adjustedEbitda["2024"], 4_222_200);
  assert.equal(c.staleBrokerFigures?.length, 1, "the broker is told which one is used");
  assert.match(earningsWarnings(c, []).join("\n"), /\$3,900,000 .* was set before the add-backs .* uses the analysis's \$4,222,200/);
  console.log("✓ a reviewed newer analysis that differs is used, with a warning");
}

// 3. The broker's own add-back edit after the decision: their newer word wins, reviewed or not.
{
  const edited = { ...v2, normalization: stampEarningsChange(norm(402_000), norm(165_000), new Date("2026-09-30T00:00:00Z")) };
  const fin = buildCimFinancials(edited, [edited])!;
  assert.equal(fin.bridgeChangedByBroker?.["adjusted|2024"], true);
  const c = earningsCanon(fin, "$18,000,000", { extractedInfo: {}, resolved })!;
  assert.equal(c.adjustedEbitda["2024"], 3_985_200);
  assert.equal(c.staleBrokerFigures?.length, 1);
  console.log("✓ the broker's own later add-back edit outranks their older figure");
}

// 4. Beacon: the reviewed analysis is OLDER than the broker's figure — the figure stands.
{
  const v1 = analysis({ version: 1, createdAt: "2026-01-01T00:00:00Z", reviewedAt: "2026-09-17T00:00:00Z", normalization: norm(0) });
  const c = earningsCanon(buildCimFinancials(v1, [v1])!, "$18,000,000", { extractedInfo: {}, resolved })!;
  assert.equal(c.adjustedEbitda["2024"], 3_900_000);
  assert.equal(c.unreviewedNewer, undefined);
  assert.equal(c.staleBrokerFigures, undefined);
  console.log("✓ an older reviewed analysis still yields to the broker's figure");
}

// 5. The broker's own fact works the same way as a resolution.
{
  const extractedInfo = { ebitda: "$3,900,000 adjusted EBITDA (FY2024)", _fieldSources: { ebitda: { source: "broker", at: "2026-02-01T00:00:00Z" } } };
  const c = earningsCanon(buildCimFinancials(v2, [v2])!, "$18,000,000", { extractedInfo, resolved: [] })!;
  assert.equal(c.adjustedEbitda["2024"], 3_900_000);
  assert.equal(earningsWarnings(c, []).filter((w) => /haven't reviewed/.test(w)).length, 1, "one warning per figure");
  console.log("✓ a broker fact stands against an unreviewed run too");
}

console.log("canon-unreviewed-analysis: all passed");
