/**
 * The Buyers tab's five stages (spec test 19): Find · Send it to next · Have
 * the teaser · Waiting for approval · Have the CIM. The old four ?stage= keys
 * keep working, "teaser" is new; the default stage; broker-given access
 * waiting for the CIM to go live counts as waiting; the strip's sub-lines.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/buyer-pipeline-stages.test.ts
 */
import assert from "node:assert/strict";
import {
  BUYER_STAGES, WAITING_APPROVAL_STATUSES, approvalStageSubline, defaultBuyerStage, isBuyerStage, teaserStageSubline,
} from "../../client/src/lib/buyer-pipeline";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

console.log("buyer pipeline stages");

test("five stages, in order, numbered 1–5", () => {
  assert.deepEqual(BUYER_STAGES.map((s) => s.key), ["find", "send", "teaser", "approval", "have"]);
  assert.deepEqual(BUYER_STAGES.map((s) => s.step), [1, 2, 3, 4, 5]);
  assert.equal(BUYER_STAGES[2].label, "Have the teaser");
  assert.match(BUYER_STAGES[2].explain, /anonymous summary/);
  assert.match(BUYER_STAGES[3].explain, /asking for the CIM/);
});

test("old ?stage= keys stay valid; teaser is new; junk isn't a stage", () => {
  for (const k of ["find", "send", "approval", "have", "teaser"]) assert.equal(isBuyerStage(k), true, k);
  for (const k of ["", null, undefined, "loi", "list", "Teaser"]) assert.equal(isBuyerStage(k as string), false, String(k));
});

test("default: Have the CIM when live with CIM buyers; else Have the teaser when anyone has it; else Send it to next", () => {
  assert.equal(defaultBuyerStage(true, 3, 5), "have");
  assert.equal(defaultBuyerStage(true, 0, 2), "teaser");
  assert.equal(defaultBuyerStage(false, 4, 1), "teaser");
  assert.equal(defaultBuyerStage(false, 4, 0), "send");
  assert.equal(defaultBuyerStage(false, 0), "send");
  assert.equal(defaultBuyerStage(true, 2), "have");
});

test("waiting statuses include access the broker gave before the CIM is live", () => {
  assert.ok(WAITING_APPROVAL_STATUSES.has("approved_waiting_publish"));
  for (const s of ["pending_broker_review", "approved_by_broker", "pending_seller_review", "approved_by_seller"]) assert.ok(WAITING_APPROVAL_STATUSES.has(s), s);
  for (const s of ["access_granted", "rejected"]) assert.ok(!WAITING_APPROVAL_STATUSES.has(s), s);
});

test("the teaser tile's sub-line is the most urgent one", () => {
  assert.equal(teaserStageSubline(null), null);
  assert.equal(teaserStageSubline({ openedToday: 0, worthACall: 0, freshLinkRequests: 0 }), null);
  assert.equal(teaserStageSubline({ openedToday: 2, worthACall: 0, freshLinkRequests: 0 }), "2 opened today");
  assert.equal(teaserStageSubline({ openedToday: 2, worthACall: 1, freshLinkRequests: 0 }), "1 worth a call");
  assert.equal(teaserStageSubline({ openedToday: 2, worthACall: 1, freshLinkRequests: 1 }), "1 asked for a new link");
});

test("the approval tile counts requests from the teaser still in flight", () => {
  assert.equal(approvalStageSubline([]), null);
  assert.equal(approvalStageSubline([
    { status: "pending_broker_review", source: "teaser_request" },
    { status: "approved_waiting_publish", source: "teaser_request" },
    { status: "access_granted", source: "teaser_request" },
    { status: "pending_broker_review", source: null },
  ]), "2 asked from the teaser");
});

console.log(`\n${passed} passed`);
