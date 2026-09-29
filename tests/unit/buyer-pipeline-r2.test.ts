/**
 * Buyers pipeline, round 2: criteria saved on a deal's access row (the old
 * per-deal editor) are visible and can be copied into the broker's private
 * profile edits (gap-fill only), and revoked buyers stay findable.
 * No database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/buyer-pipeline-r2.test.ts
 */
import assert from "node:assert/strict";
import {
  criteriaForAccess, dealCriteriaGaps, overlayWithDealCriteria, toAccessFit,
} from "../../server/matching/access-fit";
import { revokedWithoutNewLink } from "../../client/src/lib/buyer-pipeline";

function main() {
  // ── 1. Gap-fill: only what the profile doesn't already say ──────────────
  const legacy = {
    revenueMin: "1000000",
    revenueMax: 5_000_000,
    sellerFinancingRequired: true,
    managementTeamRequired: false,          // an explicit "no" is still a value
    assetVsSharePref: "not-an-option",      // an old value the form no longer accepts
    madeUpKey: 12,                          // not a criterion at all
    lookingFor: "An HVAC business in Ontario",
    targetIndustries: ["HVAC"],
    targetLocations: ["Ontario"],
    _internal: "x",
    ebitdaMin: "",
  };
  const profile = {
    buyerCriteria: { revenueMin: 2_000_000, sellerFinancingRequired: false },
    targetIndustries: ["Home services"],
    targetLocations: [],
  };
  const gaps = dealCriteriaGaps(legacy, profile as any);
  assert.deepEqual(gaps.keys, ["revenueMax", "managementTeamRequired", "lookingFor", "targetLocations"]);
  assert.equal(gaps.criteria.revenueMin, undefined, "the profile's own revenue floor stays");
  assert.equal(gaps.criteria.sellerFinancingRequired, undefined, "the profile's explicit 'no' stays");
  assert.equal(gaps.criteria.revenueMax, 5_000_000);
  assert.equal(gaps.targetIndustries, undefined, "the profile already has target industries");
  assert.deepEqual(gaps.targetLocations, ["Ontario"]);
  assert.ok(!("assetVsSharePref" in gaps.criteria), "an invalid old value is skipped, not fatal");
  assert.ok(!("madeUpKey" in gaps.criteria));
  // Nothing on the profile → every valid per-deal criterion is copied.
  assert.deepEqual(dealCriteriaGaps(legacy, null).keys, [
    "revenueMin", "revenueMax", "sellerFinancingRequired", "managementTeamRequired", "lookingFor", "targetIndustries", "targetLocations",
  ]);
  assert.deepEqual(dealCriteriaGaps(null, null).keys, []);

  // ── 2. Writing into the broker's private edits never overwrites ─────────
  const now = "2026-09-28T12:00:00.000Z";
  const { overlay, meta } = overlayWithDealCriteria(
    { buyerCriteria: { revenueMax: 9_000_000 }, targetLocations: [] as string[], company: "Kept Co" },
    { "criteria.revenueMax": { at: "2026-01-01T00:00:00.000Z" } },
    { criteria: { revenueMax: 5_000_000, ebitdaMin: 400_000 }, targetLocations: ["Ontario"], keys: ["revenueMax", "ebitdaMin", "targetLocations"] },
    now,
  );
  assert.equal(overlay.buyerCriteria!.revenueMax, 9_000_000, "an edit the broker already made wins");
  assert.equal(overlay.buyerCriteria!.ebitdaMin, 400_000);
  assert.deepEqual(overlay.targetLocations, ["Ontario"]);
  assert.equal(overlay.company, "Kept Co", "unrelated edits untouched");
  assert.equal(meta["criteria.revenueMax"].at, "2026-01-01T00:00:00.000Z");
  assert.equal(meta["criteria.ebitdaMin"].at, now, "copied values show as the broker's edit");
  assert.equal(meta.targetLocations.at, now);
  const noop = overlayWithDealCriteria(null, null, { criteria: {}, keys: [] }, now);
  assert.deepEqual(noop, { overlay: {}, meta: {} });

  // ── 3. The fit carries the per-deal criteria so the dialog can show them ──
  const legacyRow = { buyerCriteria: { revenueMax: 500_000, lookingFor: "a clinic" } };
  const onList = { buyerId: "U1", profile: { buyerCriteria: { revenueMin: 1_000_000 }, targetIndustries: ["Dental"], targetLocations: [] } };
  let c = criteriaForAccess(legacyRow as any, onList as any);
  assert.equal(c.from, "profile");
  assert.deepEqual(c.dealCriteria, legacyRow.buyerCriteria);
  assert.deepEqual(c.dealCriteriaToCopy, ["revenueMax", "lookingFor"], "the per-deal ones the profile lacks — not silently ignored");
  let fit = toAccessFit("A1", null, c);
  assert.deepEqual(fit.dealCriteriaToCopy, ["revenueMax", "lookingFor"]);
  assert.deepEqual(fit.dealCriteria, legacyRow.buyerCriteria);
  // Scored on the per-deal criteria (empty profile): all of them are copyable.
  c = criteriaForAccess(legacyRow as any, { buyerId: "U2", profile: { buyerCriteria: {}, targetIndustries: [], targetLocations: [] } } as any);
  assert.equal(c.from, "deal");
  assert.deepEqual(c.dealCriteriaToCopy, ["revenueMax", "lookingFor"]);
  // Not on the list: still shown, copyable once added.
  c = criteriaForAccess(legacyRow as any, null);
  assert.equal(c.from, "deal");
  assert.equal(c.profileBuyerId, null);
  assert.deepEqual(c.dealCriteriaToCopy, ["revenueMax", "lookingFor"]);
  // After copying, the profile has them → nothing left to copy, fit unchanged in origin.
  c = criteriaForAccess(legacyRow as any, { buyerId: "U1", profile: { buyerCriteria: { revenueMin: 1_000_000, revenueMax: 500_000, lookingFor: "a clinic" }, targetIndustries: ["Dental"], targetLocations: [] } } as any);
  assert.deepEqual(c.dealCriteriaToCopy, []);
  // No per-deal criteria at all.
  fit = toAccessFit("A2", null, criteriaForAccess({ buyerCriteria: null } as any, onList as any));
  assert.equal(fit.dealCriteria, null);
  assert.deepEqual(fit.dealCriteriaToCopy, []);

  // ── 4. Revoked buyers stay findable unless they got a new link ─────────
  const rows = [
    { id: "a1", buyerEmail: "Rory@x.invalid", revokedAt: "2026-09-20T00:00:00Z" },
    { id: "a2", buyerEmail: "rory@x.invalid", revokedAt: "2026-09-25T00:00:00Z" },
    { id: "b1", buyerEmail: "sam@x.invalid", revokedAt: "2026-09-21T00:00:00Z" },
    { id: "b2", buyerEmail: "SAM@x.invalid", revokedAt: null },
    { id: "c1", buyerEmail: "kim@x.invalid", revokedAt: null },
  ];
  assert.deepEqual(revokedWithoutNewLink(rows).map((r) => r.id), ["a2"], "newest revoked row per email; a re-granted buyer is not listed");
  assert.deepEqual(revokedWithoutNewLink([]), []);

  console.log("buyer-pipeline-r2: all assertions passed");
}

main();
