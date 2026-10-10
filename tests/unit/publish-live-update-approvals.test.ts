/**
 * Release fix F2 (ux-journeys): "Publish update" on a live CIM returned 409
 * needs_design_approvals while the Overview said "Broker approved ✓ · Seller
 * approved ✓ · Ready to publish the update". The client's rule
 * (designApprovalState) counts a live deal as approved; the server's publish
 * gate only read the stored flags. Both now use one rule.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/publish-live-update-approvals.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { designApprovalState, designApprovalsMissing } from "../../shared/deal-progress";

// 1. The Pacific case: live, a regenerated CIM, both stored flags withdrawn (null/false).
const pacific = { designApprovedByBroker: null, designApprovedBySeller: false, isLive: true };
assert.deepEqual(designApprovalsMissing({ isLive: true } as any, pacific), [], "an update of a live CIM publishes with the flags withdrawn");
assert.equal(designApprovalState(pacific, 0).ready, true, "and the Overview says ready");

// 2. Not live yet: the stored flags (or the same request) are still needed.
const fresh = { designApprovedByBroker: null, designApprovedBySeller: null, isLive: false };
assert.deepEqual(designApprovalsMissing({}, fresh), ["broker", "seller"]);
assert.deepEqual(designApprovalsMissing({ designApprovedByBroker: true }, fresh), ["seller"]);
assert.deepEqual(designApprovalsMissing({ designApprovedByBroker: true, designApprovedBySeller: true }, fresh), []);
assert.deepEqual(designApprovalsMissing({}, { ...fresh, designApprovedByBroker: true, designApprovedBySeller: true }), []);
assert.deepEqual(designApprovalsMissing({}, null), ["broker", "seller"], "no deal → nothing approved");

// 3. A request that withdraws an approval never publishes on the live flag.
assert.deepEqual(designApprovalsMissing({ designApprovedBySeller: false }, pacific), ["seller"]);
assert.deepEqual(designApprovalsMissing({ designApprovedByBroker: false }, pacific), ["broker"]);

// 4. Parity with the client for every stored combination (no request flags, no sections awaiting).
for (const b of [null, false, true]) for (const s of [null, false, true]) for (const live of [null, false, true]) {
  const deal = { designApprovedByBroker: b, designApprovedBySeller: s, isLive: live };
  assert.equal(
    designApprovalsMissing({}, deal).length === 0,
    designApprovalState(deal, 0).ready,
    `server and client agree for ${JSON.stringify(deal)}`,
  );
}

// 5. The route uses the shared rule (not its own copy of the flags check),
//    and the per-section check still runs for an update.
const routes = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
const gate = routes.slice(routes.indexOf("if (dealPatch.isLive === true) {\n        const current"), routes.indexOf("code: \"needs_design_approvals\""));
assert.ok(gate.includes("designApprovalsMissing(dealPatch, current)"), "publish gate calls designApprovalsMissing");
assert.ok(routes.includes("sectionsBlockingPublish(req.params.id)"), "changed sections still block publishing");

console.log("publish-live-update-approvals: ok");
