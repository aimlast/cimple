/**
 * Buyer matching — exclusions, AI scoring robustness, per-buyer Run Match,
 * and the "already reached" dedupe for Suggested buyers.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/matching-engine.test.ts
 */
import assert from "node:assert/strict";
import {
  excludedIndustryMatches,
  finiteScore,
  firstJsonObject,
  matchBuyerToDeal,
  scoreAiDimensions,
  setMatchingAiForTests,
} from "../../server/matching/engine";
import { matchBuyerDealRow } from "../../server/matching/match-run";
import { passesFirstPass, reachedBuyers } from "../../server/matching/suggested";

async function main() {
  // ── 1. Exclusions: qualified phrases strict, bare sector names cover the sector ──
  assert.equal(excludedIndustryMatches("HVAC · Residential HVAC service & replacement", ["New-build construction"]), false);
  assert.equal(excludedIndustryMatches("HVAC · Residential HVAC service & replacement", ["New-construction mechanical"]), false);
  assert.equal(excludedIndustryMatches("Construction · General contractor", ["construction"]), true);
  assert.equal(excludedIndustryMatches("Construction · General contractor", ["New-build construction"]), true);
  assert.equal(excludedIndustryMatches("Healthcare · Dental practice", ["Healthcare"]), true);
  assert.equal(excludedIndustryMatches("Retail · Vape shop", ["cannabis", "vape"]), true);
  assert.equal(excludedIndustryMatches("", ["construction"]), false);
  // A buyer who rules out a whole sector rules out its members, even when the
  // deal's label never uses the sector word (Beacon Pharmacy, checker round 1).
  const beacon = "Pharmacy · Independent community pharmacy with LTC/retirement home services (14 homes) and non-sterile compounding";
  assert.equal(excludedIndustryMatches(beacon, ["Restaurants", "Retail", "Construction", "Healthcare"]), true);
  assert.equal(excludedIndustryMatches(beacon, ["Consumer retail", "Restaurants", "Healthcare services", "Software"]), true);
  assert.equal(excludedIndustryMatches(beacon, ["Health care"]), true);
  assert.equal(excludedIndustryMatches(beacon, ["Medical"]), true);
  assert.equal(excludedIndustryMatches("Healthcare · Physiotherapy & massage therapy clinics", ["Healthcare delivery"]), true);
  assert.equal(excludedIndustryMatches("HVAC · Residential HVAC service", ["Home services"]), true);
  assert.equal(excludedIndustryMatches("Manufacturing · Custom metal fabrication", ["Manufacturing"]), true);
  assert.equal(excludedIndustryMatches("Retail · Vape shop", ["Retail"]), true);
  // …but a qualified phrase is not a sector name and stays strict.
  assert.equal(excludedIndustryMatches(beacon, ["Front-store heavy convenience pharmacy"]), false);
  assert.equal(excludedIndustryMatches(beacon, ["Residential renovation", "Home builders"]), false);
  assert.equal(excludedIndustryMatches(beacon, ["Home care"]), false);
  assert.equal(excludedIndustryMatches("Healthcare · Physiotherapy & massage therapy clinics", ["Cosmetic-only clinics", "Massage-only studios"]), false);
  assert.equal(excludedIndustryMatches("Home Services · Residential HVAC installation & service + plumbing", ["Home care"]), false);
  // "Construction" means project-based building, not a plumbing/HVAC service company.
  assert.equal(excludedIndustryMatches("Home Services · Residential HVAC installation & service + plumbing", ["Construction"]), false);
  assert.equal(excludedIndustryMatches("Home Services · Residential HVAC installation & service + plumbing", ["Construction (project-based)"]), false);
  assert.equal(excludedIndustryMatches("Construction · Concrete forming & paving", ["Construction"]), true);
  // A sector the deal isn't in excludes nothing.
  assert.equal(excludedIndustryMatches(beacon, ["Manufacturing", "Food service"]), false);
  assert.equal(excludedIndustryMatches("Transportation & Logistics · Regional trucking", ["Long-haul trucking"]), false);
  assert.equal(excludedIndustryMatches("Transportation & Logistics · Regional trucking", ["Trucking"]), true);

  // End to end: the Lakeshore case keeps its best buyers in the first pass.
  const lakeshore = {
    industry: "HVAC",
    subIndustry: "Residential HVAC service & replacement",
    askingPrice: "4800000",
    extractedInfo: { annualRevenue: "$6,900,000", ebitda: "$1,150,000", locationSite: "Barrie, Ontario" },
  };
  const whitford = await matchBuyerToDeal(
    { targetIndustries: ["HVAC", "home services"], excludedIndustries: ["New-build construction", "New-construction mechanical"], targetLocations: ["Ontario"], revenueMin: "3M", revenueMax: "12M" },
    lakeshore,
    { skipAI: true },
  );
  assert.ok(!whitford.industryFit.details.excluded, "not excluded");
  assert.ok(passesFirstPass({ breakdown: whitford, buyer: {} } as any));
  const gc = await matchBuyerToDeal(
    { excludedIndustries: ["construction"], revenueMin: "1M" },
    { industry: "Construction", subIndustry: "General contractor", extractedInfo: { annualRevenue: "$5M" } },
    { skipAI: true },
  );
  assert.ok(gc.industryFit.details.excluded);
  assert.equal(passesFirstPass({ breakdown: gc, buyer: {} } as any), false);

  // ── 2. AI replies: parse and coerce, never NaN ────────────────────────────
  assert.deepEqual(firstJsonObject('{"a":1,"b":"x}"}\n\nNote: the buyer {maybe} fits.'), { a: 1, b: "x}" });
  assert.deepEqual(firstJsonObject('```json\n{"a":{"b":2}}\n```\nThat is all.'), { a: { b: 2 } });
  assert.throws(() => firstJsonObject("no json here"));

  const partial = scoreAiDimensions({ growthAlignment: "N/A", competitiveMoat: 7, managementDepth: "6", customerHealth: null, strategicFit: 12, reasonForSaleRisk: 5 });
  assert.ok(partial);
  assert.equal(partial!.dims.strategicFit, 10); // clamped
  assert.ok(!("growthAlignment" in partial!.dims));
  assert.equal(partial!.score, Math.round(((7 + 6 + 10 + 5) / 40) * 100));
  assert.equal(scoreAiDimensions({ growthAlignment: "N/A", competitiveMoat: null, managementDepth: 5 }), null);
  assert.equal(finiteScore(NaN), null);
  assert.equal(finiteScore(72.6), 73);
  assert.equal(finiteScore("x"), null);

  // Mocked AI: a sparse buyer (asking price + lookingFor only) and junk dimensions.
  const sparse = { askingPriceMin: "10000000", askingPriceMax: "25000000", lookingFor: "logistics company in BC" } as any;
  const pacific = { industry: "Transportation & Logistics", askingPrice: "18000000", extractedInfo: { annualRevenue: "$31M" } };

  setMatchingAiForTests(async () => ({ content: [{ type: "tool_use", name: "score_match", input: { growthAlignment: "N/A", competitiveMoat: "N/A", managementDepth: null, customerHealth: "unknown", strategicFit: 6, reasonForSaleRisk: 7, overallAssessment: "Thin." } }] }));
  const junk = await matchBuyerToDeal(sparse, pacific);
  assert.ok(Number.isFinite(junk.finalScore), `finalScore ${junk.finalScore}`);
  assert.equal(junk.aiQualitative, undefined);
  assert.match(junk.aiQualitativeUnavailable || "", /unavailable/);

  // Text reply with prose after the JSON (the old parse failure).
  setMatchingAiForTests(async () => ({ content: [{ type: "text", text: '{"growthAlignment":7,"competitiveMoat":6,"managementDepth":5,"customerHealth":6,"strategicFit":8,"reasonForSaleRisk":7,"overallAssessment":"Good."}\n\nNote: limited buyer data.' }] }));
  const prose = await matchBuyerToDeal(sparse, pacific);
  assert.ok(prose.aiQualitative, "AI component applied");
  assert.equal(prose.aiQualitative!.score, Math.round((39 / 60) * 100));
  assert.ok(Number.isFinite(prose.finalScore));
  assert.equal(prose.finalScore, Math.round(prose.deterministicScore * 0.6 + prose.aiScore * 0.4));

  // Tool reply (the normal path).
  setMatchingAiForTests(async () => ({ content: [{ type: "tool_use", name: "score_match", input: { growthAlignment: 8, competitiveMoat: 8, managementDepth: 8, customerHealth: 8, strategicFit: 8, reasonForSaleRisk: 8, overallAssessment: "Strong." } }] }));
  const tool = await matchBuyerToDeal(sparse, pacific);
  assert.equal(tool.aiQualitative!.score, 80);

  // AI call throwing → deterministic only, flagged.
  setMatchingAiForTests(async () => { throw new Error("overloaded"); });
  const down = await matchBuyerToDeal(sparse, pacific);
  assert.ok(Number.isFinite(down.finalScore));
  assert.match(down.aiQualitativeUnavailable || "", /didn't answer/);
  setMatchingAiForTests(null);

  // ── 3. Run Match: one bad buyer never fails the batch ─────────────────────
  const saved: Record<string, any> = {};
  const persist = async (id: string, patch: any) => {
    if (id === "b-write-fails") throw new Error("db down");
    if (patch.matchScore !== null) assert.ok(Number.isInteger(patch.matchScore), "only integers are written");
    saved[id] = patch;
  };
  const rows = [
    { id: "b-ok", buyerName: "Good Buyer", buyerCriteria: { revenueMin: "1M" } },
    { id: "b-throws", buyerName: "Bad Buyer", buyerCriteria: { revenueMin: "1M" } },
    { id: "b-nan", buyerName: "NaN Buyer", buyerCriteria: { revenueMin: "1M" } },
    { id: "b-write-fails", buyerName: "Write Fails", buyerCriteria: { revenueMin: "1M" } },
    { id: "b-none", buyerName: "No Criteria", buyerCriteria: {} },
  ];
  const fakeMatch: any = async (_c: any, _d: any) => {
    const which = (_c as any).__id;
    if (which === "b-throws") throw new Error("boom");
    return { finalScore: which === "b-nan" ? NaN : 64.4, deterministicScore: 64, criteriaMatched: 1, criteriaTested: 1 };
  };
  const results = await Promise.all(rows.map((r) =>
    matchBuyerDealRow({ ...r, buyerCriteria: Object.keys(r.buyerCriteria).length ? { ...r.buyerCriteria, __id: r.id } : {} }, pacific as any, { persist, match: fakeMatch }),
  ));
  const byId = Object.fromEntries(results.map((r) => [r.buyerId, r]));
  assert.equal(byId["b-ok"].matchScore, 64);
  assert.equal(saved["b-ok"].matchScore, 64);
  assert.ok(byId["b-throws"].error && byId["b-throws"].matchScore === null);
  assert.equal(byId["b-nan"].matchScore, null);
  assert.equal(saved["b-nan"].matchScore, null);
  assert.ok(byId["b-write-fails"].error);
  assert.equal(byId["b-none"].noCriteria, true);

  // ── 4. Suggested buyers: dedupe on id AND email ───────────────────────────
  const reached = reachedBuyers(
    [{ buyerUserId: "u-contacted", buyerEmail: "someone@x.invalid" }],
    [{ buyerUserId: null, buyerEmail: "Wei@X.invalid" }, { buyerUserId: "u-linked", buyerEmail: "linked@x.invalid" }],
  );
  assert.deepEqual(reached({ id: "u-wei", email: "wei@x.invalid" }), { alreadyHasAccess: true, alreadyContacted: false });
  assert.deepEqual(reached({ id: "u-linked", email: "other@x.invalid" }), { alreadyHasAccess: true, alreadyContacted: false });
  assert.deepEqual(reached({ id: "u-contacted", email: "c@x.invalid" }), { alreadyHasAccess: false, alreadyContacted: true });
  assert.deepEqual(reached({ id: "u-new", email: "SOMEONE@x.invalid" }), { alreadyHasAccess: false, alreadyContacted: true });
  assert.deepEqual(reached({ id: "u-fresh", email: "" }), { alreadyHasAccess: false, alreadyContacted: false });

  console.log("matching-engine: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
