/**
 * Buyers tab as one pipeline: the automatic Fit of buyers who have the CIM
 * (server/matching/access-fit.ts + shared/buyer-fit.ts), the stage helpers,
 * and "a buyer further along the pipeline is never suggested again".
 * No database, no AI (the AI client is stubbed).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/buyer-pipeline-fit.test.ts
 */
import assert from "node:assert/strict";
import { fitLabel, fitReasons, hasAnyCriteria } from "../../shared/buyer-fit";
import {
  criteriaForAccess, dealForFit, ensureAccessFit, fitKey, listEntryFinder, toAccessFit, type StoredFitBreakdown,
} from "../../server/matching/access-fit";
import { matchBuyerToDeal, setMatchingAiForTests } from "../../server/matching/engine";
import { reachedBuyers, suggestionPools } from "../../server/matching/suggested";
import {
  BUYER_STAGES, WAITING_APPROVAL_STATUSES, defaultBuyerStage, isBuyerStage,
} from "../../client/src/lib/buyer-pipeline";

let aiCalls = 0;
setMatchingAiForTests(async () => {
  aiCalls++;
  return { content: [{ type: "tool_use", name: "score_match", input: { growthAlignment: 9, competitiveMoat: 9, managementDepth: 9, customerHealth: 9, strategicFit: 9, reasonForSaleRisk: 9, overallAssessment: "Owner-dentist buyer, clean handover." } }] } as any;
});

const cat = (details: Record<string, [number, string]>) => {
  const d = Object.fromEntries(Object.entries(details).map(([k, [score, note]]) => [k, { score, max: 100, note }]));
  const vals = Object.values(d);
  return { score: vals.reduce((s, v) => s + v.score, 0), max: vals.length * 100, details: d };
};

async function main() {
  // ── 1. Labels ──────────────────────────────────────────────────────────
  const bd = (finalScore: number, extra: any = {}) => ({ finalScore, criteriaTested: 4, criteriaMatched: 3, ...extra });
  assert.deepEqual(fitLabel(bd(90), true), { label: "Strong fit", tone: "strong", score: 90 });
  assert.deepEqual(fitLabel(bd(75), true), { label: "Strong fit", tone: "strong", score: 75 });
  assert.deepEqual(fitLabel(bd(60), true), { label: "Good fit", tone: "good", score: 60 });
  assert.deepEqual(fitLabel(bd(40), true), { label: "Partial fit", tone: "partial", score: 40 });
  assert.deepEqual(fitLabel(bd(10), true), { label: "Weak fit", tone: "weak", score: 10 });
  assert.equal(fitLabel(bd(90), false).label, "No criteria yet");
  assert.equal(fitLabel(null, true).label, "No criteria yet");
  assert.equal(fitLabel(bd(0, { criteriaTested: 0 }), true).label, "Not enough to compare");
  assert.equal(fitLabel(bd(80, { excludedIndustry: true, excludedBy: "Healthcare" }), true).tone, "excluded");
  assert.equal(fitLabel(bd(80, { excludedIndustry: true }), true).score, null, "an excluded buyer never shows a score");

  // ── 2. Why: met / partly / unmet, in the engine's own words ─────────────
  const why = fitReasons({
    industryFit: cat({ industry: [100, "Dental practice — in their target industries"] }),
    financialFit: cat({ revenue: [100, "$2.1M — within range"], askingPrice: [50, "$3.2M — slightly above range"] }),
    locationFit: cat({ location: [0, "Ontario — outside their target locations"] }),
  });
  assert.deepEqual(why.met.map((r) => r.category), ["Industry", "Financials"]);
  assert.equal(why.partly[0].note, "$3.2M — slightly above range");
  assert.equal(why.unmet[0].category, "Location");

  // ── 3. What counts as criteria ──────────────────────────────────────────
  assert.equal(hasAnyCriteria({ targetIndustries: [], targetLocations: [] }), false);
  assert.equal(hasAnyCriteria({ targetIndustries: ["any"] }), false);
  assert.equal(hasAnyCriteria({ lookingFor: "a dental practice" }), false, "free text alone can't be tested");
  assert.equal(hasAnyCriteria({ revenueMin: "" , managementTeamRequired: false }), false);
  assert.equal(hasAnyCriteria({ revenueMin: 1000000 }), true);
  assert.equal(hasAnyCriteria({ targetLocations: ["Ontario"] }), true);

  // ── 4. Which criteria: the buyer's profile, else criteria saved on the access row ──
  const profileEntry = { buyerId: "U1", profile: { buyerCriteria: { revenueMin: 1_000_000 }, targetIndustries: ["Dental"], targetLocations: [] } };
  const legacyRow = { buyerCriteria: { revenueMax: 500_000 } };
  let c = criteriaForAccess(legacyRow as any, profileEntry as any);
  assert.equal(c.from, "profile");
  assert.equal(c.profileBuyerId, "U1");
  assert.deepEqual(c.criteria.targetIndustries, ["Dental"]);
  assert.equal(c.criteria.revenueMax, undefined, "profile criteria are not mixed with the old per-deal ones");
  c = criteriaForAccess(legacyRow as any, { buyerId: "U2", profile: { buyerCriteria: {}, targetIndustries: [], targetLocations: [] } } as any);
  assert.equal(c.from, "deal");
  assert.equal(c.profileBuyerId, "U2", "still links to the profile so the broker can move criteria there");
  c = criteriaForAccess({ buyerCriteria: {} } as any, null);
  assert.deepEqual([c.from, c.profileBuyerId], [null, null]);

  // ── 5. Access rows find their buyer by account id, else by email ─────────
  const find = listEntryFinder([
    { buyerUser: { id: "U1", email: "Dr.Lee@Clinic.invalid" } },
    { buyerUser: { id: "U2", email: "pat@fund.invalid" } },
  ]);
  assert.equal(find({ buyerUserId: "U2", buyerEmail: "someone@else.invalid" })?.buyerUser.id, "U2");
  assert.equal(find({ buyerUserId: null, buyerEmail: " dr.lee@clinic.invalid " })?.buyerUser.id, "U1");
  assert.equal(find({ buyerUserId: null, buyerEmail: "nobody@x.invalid" }), null);

  // ── 6. Automatic, persisted, stale-aware ─────────────────────────────────
  const deal = dealForFit({
    industry: "Healthcare",
    subIndustry: "Dental practice",
    askingPrice: "$3,200,000",
    description: "Dental practice in Ontario",
    extractedInfo: { annualRevenue: "$2,100,000", locationSite: "Hamilton, Ontario", _fieldSources: { annualRevenue: { at: "2026-09-01" } } },
  } as any);
  assert.equal((deal.extractedInfo as any)._fieldSources, undefined, "bookkeeping keys never feed (or unsettle) the fit");
  const sameDealNewStamp = dealForFit({ industry: "Healthcare", subIndustry: "Dental practice", askingPrice: "$3,200,000", description: "Dental practice in Ontario", extractedInfo: { annualRevenue: "$2,100,000", locationSite: "Hamilton, Ontario", _fieldSources: { annualRevenue: { at: "2026-09-28" } } } } as any);
  const crit = { revenueMin: 1_000_000, revenueMax: 5_000_000, targetIndustries: ["Dental"], targetLocations: ["Ontario"] };
  assert.equal(fitKey(crit, deal), fitKey({ ...crit }, sameDealNewStamp), "a provenance timestamp is not a change");
  assert.equal(fitKey({ targetLocations: ["Ontario"], targetIndustries: ["Dental"], revenueMax: 5_000_000, revenueMin: 1_000_000 }, deal), fitKey(crit, deal), "key order doesn't matter");
  assert.notEqual(fitKey({ ...crit, revenueMin: 3_000_000 }, deal), fitKey(crit, deal));

  const writes: Array<{ id: string; patch: any }> = [];
  let matchCalls = 0;
  const deps = {
    persist: async (id: string, patch: any) => { writes.push({ id, patch }); },
    match: (async (...args: Parameters<typeof matchBuyerToDeal>) => { matchCalls++; return matchBuyerToDeal(...args); }) as typeof matchBuyerToDeal,
    now: () => new Date("2026-09-28T12:00:00Z"),
  };
  const cf = { criteria: crit, from: "profile" as const, profileBuyerId: "U1" };
  const row: any = { id: "A1", buyerCriteria: {}, matchScore: null, matchBreakdown: null };

  // First load: scored by rules (no AI), saved with its fingerprint.
  let r = await ensureAccessFit(row, cf, deal, deps);
  assert.equal(r.recomputed, true);
  assert.equal(aiCalls, 0, "the automatic fit never calls the AI");
  assert.equal(writes.length, 1);
  const saved = writes[0].patch.matchBreakdown as StoredFitBreakdown;
  assert.equal(saved._fit?.key, fitKey(crit, deal));
  assert.equal(saved._fit?.ai, false);
  assert.equal(writes[0].patch.matchScore, r.fit.score);
  assert.ok(r.fit.score != null && r.fit.criteriaTested >= 3, JSON.stringify(r.fit));
  assert.equal(r.fit.tone, "strong", `dental buyer, Ontario, revenue in range → ${r.fit.label} ${r.fit.score}`);
  assert.equal(r.fit.profileBuyerId, "U1");
  assert.equal((r.fit.breakdown as any)._fit, undefined, "bookkeeping never reaches the browser");

  // Second load, nothing changed: reused, not re-scored, not re-saved.
  Object.assign(row, writes[0].patch);
  matchCalls = 0;
  r = await ensureAccessFit(row, cf, sameDealNewStamp, deps);
  assert.equal(r.recomputed, false);
  assert.equal(matchCalls, 0);
  assert.equal(writes.length, 1);

  // The buyer's criteria changed on their profile → re-scored on the next load.
  const narrower = { criteria: { ...crit, targetLocations: ["British Columbia"] }, from: "profile" as const, profileBuyerId: "U1" };
  r = await ensureAccessFit(row, narrower, deal, deps);
  assert.equal(r.recomputed, true);
  assert.ok((r.fit.score ?? 100) < (toAccessFit("A1", row.matchBreakdown, cf).score ?? 0), "outside their locations now → lower fit");
  Object.assign(row, writes[writes.length - 1].patch);

  // "Check fit with AI": uses the (stubbed) AI and is kept while fresh…
  r = await ensureAccessFit(row, cf, deal, deps, { withAI: true });
  assert.equal(aiCalls, 1);
  assert.equal(r.fit.ai, true);
  assert.equal(r.fit.aiAssessment, "Owner-dentist buyer, clean handover.");
  Object.assign(row, writes[writes.length - 1].patch);
  const before = writes.length;
  r = await ensureAccessFit(row, cf, deal, deps);
  assert.equal(r.recomputed, false);
  assert.equal(r.fit.ai, true, "a fresh AI-inclusive score is kept");
  assert.equal(writes.length, before);
  assert.equal(aiCalls, 1);
  // …until the deal's facts change: then it's re-scored by rules only.
  const newFacts = dealForFit({ industry: "Healthcare", subIndustry: "Dental practice", askingPrice: "$3,400,000", description: "Dental practice in Ontario", extractedInfo: { annualRevenue: "$2,100,000", locationSite: "Hamilton, Ontario" } } as any);
  r = await ensureAccessFit(row, cf, newFacts, deps);
  assert.equal(r.recomputed, true);
  assert.equal(r.fit.ai, false);
  assert.equal(aiCalls, 1, "stale → rules only, never the AI on its own");

  // Criteria removed → nothing to compare, the old score is cleared.
  Object.assign(row, writes[writes.length - 1].patch);
  r = await ensureAccessFit(row, { criteria: {}, from: null, profileBuyerId: "U1" }, deal, deps);
  assert.equal(r.fit.label, "No criteria yet");
  assert.deepEqual(writes[writes.length - 1].patch, { matchScore: null, matchBreakdown: null });

  // A scoring failure never throws.
  r = await ensureAccessFit({ id: "A9", buyerCriteria: {}, matchScore: null, matchBreakdown: null } as any, cf, deal, {
    persist: async () => { throw new Error("db down"); },
    match: (async () => { throw new Error("boom"); }) as any,
  });
  assert.equal(r.fit.score, null);

  // AI unavailable is reported, the rule-based score still stands.
  setMatchingAiForTests(async () => { throw new Error("overloaded"); });
  r = await ensureAccessFit({ id: "A2", buyerCriteria: {}, matchScore: null, matchBreakdown: null } as any, cf, deal, deps, { withAI: true });
  assert.ok(r.aiUnavailable && /unavailable/i.test(r.aiUnavailable), r.aiUnavailable);
  assert.equal(r.fit.ai, false);
  assert.ok(r.fit.score != null);

  // ── 7. Further along the pipeline → never suggested ──────────────────────
  const reached = reachedBuyers(
    [{ buyerUserId: "U3", buyerEmail: "c@x.invalid" }],
    [{ buyerUserId: null, buyerEmail: "a@x.invalid" }],
    [{ buyerEmail: "B@X.invalid", status: "pending_seller_review" }, { buyerEmail: "d@x.invalid", status: "rejected" }],
  );
  assert.deepEqual(reached({ id: "U1", email: "a@x.invalid" }), { alreadyHasAccess: true, alreadyContacted: false, inApproval: false });
  assert.equal(reached({ id: "U2", email: "b@x.invalid" }).inApproval, true);
  assert.equal(reached({ id: "U4", email: "d@x.invalid" }).inApproval, true, "a buyer the seller turned down isn't suggested again");
  assert.equal(reached({ id: "U3", email: "c@x.invalid" }).alreadyContacted, true);
  const mk = (id: string, email: string) => ({ buyer: { id, email, buyerCriteria: {} } as any, breakdown: { criteriaTested: 1, criteriaMatched: 1 } as any } as any);
  const pools = suggestionPools([mk("U1", "a@x.invalid"), mk("U2", "b@x.invalid"), mk("U3", "c@x.invalid"), mk("U5", "e@x.invalid")], reached);
  assert.deepEqual(pools.pool.map((s: any) => s.buyer.id), ["U3", "U5"], "has-access and in-approval buyers leave the suggestions");
  assert.deepEqual(pools.withAccess.map((s: any) => s.buyer.id), ["U1", "U2"]);
  // Callers that pass no approvals behave as before.
  assert.equal(reachedBuyers([], [])({ id: "U1", email: "a@x.invalid" }).inApproval, false);

  // ── 8. Stages ────────────────────────────────────────────────────────────
  assert.deepEqual(BUYER_STAGES.map((s) => s.label), ["Find new buyers", "Send it to next", "Waiting for approval", "Have the CIM"]);
  assert.equal(defaultBuyerStage(true, 3), "have");
  assert.equal(defaultBuyerStage(true, 0), "send");
  assert.equal(defaultBuyerStage(false, 3), "send");
  assert.equal(isBuyerStage("approval"), true);
  assert.equal(isBuyerStage("matching"), false);
  assert.equal(isBuyerStage(null), false);
  assert.equal(WAITING_APPROVAL_STATUSES.has("access_granted"), false, "approved-and-granted buyers are in 'Have the CIM'");
  assert.equal(WAITING_APPROVAL_STATUSES.has("pending_broker_review"), true);

  setMatchingAiForTests(null);
  console.log("buyer-pipeline-fit: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
