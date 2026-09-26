/**
 * Buyer matching — exclusions, AI scoring robustness, per-buyer Run Match,
 * and the "already reached" dedupe for Suggested buyers.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/matching-engine.test.ts
 */
import assert from "node:assert/strict";
import {
  criterionBound,
  excludedIndustryMatches,
  finiteScore,
  formatMoney,
  firstJsonObject,
  matchBuyerToDeal,
  scoreAiDimensions,
  setMatchingAiForTests,
} from "../../server/matching/engine";
import { matchBuyerDealRow } from "../../server/matching/match-run";
import { isExcludedBuyer, passesFirstPass, reachedBuyers, suggestionPools } from "../../server/matching/suggested";
import { calculateQualifiedLeadScore } from "../../server/scoring/buyer-score";

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

  // ── 5. Unreadable criteria are not "tested"; "0" is not a limit ──────────
  setMatchingAiForTests(null);
  const pcl = { industry: "Transportation & Logistics", askingPrice: "18000000", extractedInfo: { annualRevenue: "$31,020,000", ebitda: "$3,900,000", employees: "148 (96 drivers + 52 staff)" } };
  const junkRow = await matchBuyerToDeal({ revenueMin: "abc", multipleMax: "0", ebitdaMin: "N/A", minEmployees: "lots" } as any, pcl, { skipAI: true });
  assert.equal(junkRow.criteriaTested, 0, JSON.stringify(junkRow.financialFit.details));
  assert.equal(junkRow.criteriaMatched, 0);
  assert.equal(junkRow.deterministicScore, 0, "nothing tested → no half-credit score");
  assert.deepEqual(Object.keys(junkRow.financialFit.details), []);
  // A readable criterion next to junk still counts, and money reads well.
  const mixed = await matchBuyerToDeal({ revenueMin: "20M", revenueMax: "abc", ebitdaMin: "3,000,000", multipleMax: "0" } as any, pcl, { skipAI: true });
  assert.equal(mixed.criteriaTested, 2);
  assert.equal(mixed.criteriaMatched, 2);
  assert.equal(mixed.financialFit.details.revenue.note, "$31M — Meets minimum");
  assert.equal(mixed.financialFit.details.ebitda.note, "$3.9M — Meets minimum");
  assert.ok(!("askingMultiple" in mixed.financialFit.details));
  const realMultiple = await matchBuyerToDeal({ multipleMax: "4" } as any, pcl, { skipAI: true });
  assert.match(realMultiple.financialFit.details.askingMultiple.note, /4\.6x — exceeds 4x max/);
  assert.equal(formatMoney(31_020_000), "$31M");
  assert.equal(formatMoney(3_900_000), "$3.9M");
  assert.equal(formatMoney(2_450_000), "$2.45M");
  assert.equal(formatMoney(628_000), "$628K");
  assert.equal(formatMoney(18_000_000), "$18M");
  assert.equal(criterionBound("0"), null);
  assert.equal(criterionBound("N/A"), null);
  assert.equal(criterionBound("$2.5M"), 2_500_000);
  // Headcount: a year in the staff list is not the staff count.
  const beaconEmp = { industry: "Pharmacy", extractedInfo: { employees: "Key personnel: Daniel (LTC lead pharmacist, since 2014), Mei-Lin (since 2018). Total headcount 23 (incl. owner)." } };
  const emp = await matchBuyerToDeal({ maxEmployees: "50" } as any, beaconEmp, { skipAI: true });
  assert.match(emp.operationalFit.details.employees.note, /^23 employees/);

  // ── 6. A buyer who excludes the industry is never a warm suggestion ──────
  const excludedMatch = await matchBuyerToDeal({ excludedIndustries: ["Trucking"], revenueMin: "5000000", revenueMax: "50000000", targetLocations: ["British Columbia"] } as any,
    { industry: "Transportation & Logistics", subIndustry: "Regional trucking & warehousing", extractedInfo: { annualRevenue: "$31M", location: "Delta, BC" } }, { skipAI: true });
  assert.equal(excludedMatch.excludedIndustry, true);
  assert.equal(excludedMatch.excludedBy, "Trucking");
  const excludedScore = calculateQualifiedLeadScore({
    buyer: { profileCompletionPct: 100, hasProofOfFunds: true, buyerType: "financial", liquidFunds: null, buyerCriteria: {}, targetIndustries: [] } as any,
    match: excludedMatch,
    engagement: { viewCount: 5, sectionsViewed: 10, totalTimeSeconds: 900, questionCount: 3, ndaSigned: true },
  });
  assert.equal(excludedScore.tier, "cold");
  assert.ok(excludedScore.total <= 20, String(excludedScore.total));
  assert.equal(excludedScore.breakdown.matchFit, 0);
  assert.deepEqual(excludedScore.reasons, ["Rules out “Trucking”"]);
  // …while the same buyer without the exclusion is warm or better.
  const fine = await matchBuyerToDeal({ revenueMin: "5000000", revenueMax: "50000000", targetLocations: ["British Columbia"] } as any,
    { industry: "Transportation & Logistics", extractedInfo: { annualRevenue: "$31M", location: "Delta, BC" } }, { skipAI: true });
  assert.ok(!fine.excludedIndustry);
  assert.ok(["warm", "hot"].includes(calculateQualifiedLeadScore({ buyer: { profileCompletionPct: 100, hasProofOfFunds: true } as any, match: fine }).tier));

  // ── 7. One pool for the list and the deep check ───────────────────────────
  const sb = (id: string, email: string, bd: any, extra: any = {}) => ({ buyer: { id, email, background: "x", buyerCriteria: {}, targetIndustries: [], ...extra }, breakdown: bd, contact: null, lastActivityAt: null, fundsRange: null, score: {} as any });
  const scoredList = [
    sb("strong", "s@x.invalid", { criteriaTested: 3, criteriaMatched: 3 }),
    sb("excluded", "e@x.invalid", { ...excludedMatch }),
    sb("mismatch", "m@x.invalid", { criteriaTested: 3, criteriaMatched: 0 }),
    sb("has-access", "A@X.invalid", { criteriaTested: 2, criteriaMatched: 2 }),
    sb("junk-access", "j@x.invalid", { criteriaTested: 0, criteriaMatched: 0 }),
  ];
  const pools = suggestionPools(scoredList as any, reachedBuyers([], [{ buyerEmail: "a@x.invalid" }, { buyerUserId: "junk-access" }]));
  assert.deepEqual(pools.pool.map((s) => s.buyer.id), ["strong", "mismatch"]);
  assert.deepEqual(pools.candidates.map((s) => s.buyer.id), ["strong"], "deep check = what the button counts");
  assert.deepEqual(pools.excluded.map((s) => s.buyer.id), ["excluded"]);
  assert.deepEqual(pools.withAccess.map((s) => s.buyer.id), ["has-access", "junk-access"]);
  assert.equal(isExcludedBuyer(scoredList[1] as any), true);
  assert.equal(passesFirstPass(scoredList[1] as any), false);

  console.log("matching-engine: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
