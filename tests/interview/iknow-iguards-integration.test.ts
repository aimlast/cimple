// Where the iknow (re-ask guard, stream gate, wrap-up blockers, task plan)
// and iguards (output guards, stop semantics, legal-grounding counsel tasks)
// streams meet — offline.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/iknow-iguards-integration.test.ts
import assert from "node:assert/strict";
import { governCompletion } from "../../server/interview/turn-guard";
import { heldForLaterGuards } from "../../server/interview/session-manager";
import { planTaskWrites, COUNSEL_TASK_PREFIX } from "../../server/interview/task-writes";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

// ── 1. Governance continuation: iguards' no-recap wording + iknow's blocking items ──
{
  const blocked = governCompletion({
    shouldEnd: true,
    sellerMessage: "Yes, the lease runs to 2029.",
    userTurnCount: 14,
    sectionCoverage: [{ key: "overview", status: "well_covered" }],
    deferredTopics: [],
    minTurnsBeforeEnd: 10,
    sellerStopDetected: false,
    blockingItems: ["the seller's reason for sale", "the backlog conflict (WIP report vs call)"],
  });
  assert.equal(blocked.allowEnd, false);
  assert.match(blocked.blockReason!, /still not discussed or deferred: the seller's reason for sale/);
  assert.match(blocked.continuationInstruction!, /no acknowledgement, no recap, no praise/);
  assert.match(blocked.continuationInstruction!, /\(start with: the seller's reason for sale\)/);
  assert.match(blocked.continuationInstruction!, /record an explicit deferral with where the answer lives/);
  const stop = governCompletion({
    shouldEnd: true,
    sellerMessage: "Anyway, that's it for me today.",
    userTurnCount: 4,
    sectionCoverage: [{ key: "overview", status: "missing" }],
    deferredTopics: [],
    minTurnsBeforeEnd: 10,
    sellerStopDetected: true,
    blockingItems: ["the seller's reason for sale"],
  });
  assert.equal(stop.allowEnd, true, "blocking items never outrank the seller's stop");
  ok("governance: blocking items hold the end, continuation keeps the no-recap rule, the seller's stop still wins");
}

// ── 2. Stream gate: drafts a later guard will rewrite are held, not shown then swapped ──
{
  const plain = "How many of the 24 technicians are licensed for gas work?";
  assert.equal(heldForLaterGuards(plain, { retractionInMessage: false, valuationLeak: false }), false);
  assert.equal(heldForLaterGuards(plain, { retractionInMessage: true, valuationLeak: false }), true, "retraction turn");
  assert.equal(heldForLaterGuards(plain, { retractionInMessage: false, valuationLeak: true }), true, "valuation leak");
  assert.equal(
    heldForLaterGuards("On the mandatory probes I need to check off: any open claims?", { retractionInMessage: false, valuationLeak: false }),
    true,
    "machinery",
  );
  assert.equal(
    heldForLaterGuards("On the ownership side: Ontario requires that pharmacy owners be licensed pharmacists. Is that a restriction you'd want flagged for buyers?", { retractionInMessage: false, valuationLeak: false }),
    true,
    "legal claim stated as fact",
  );
  ok("stream gate holds drafts the output/valuation/retraction guards would rewrite");
}

// ── 3. Counsel checks survive the interview's task plan ──
{
  const counsel = {
    id: "t1",
    type: "follow_up",
    title: `${COUNSEL_TASK_PREFIX}ownershipRestriction`,
    description: "The interviewer raised a legal point and the seller agreed — confirm with the seller's lawyer.",
    relatedField: "ownershipRestriction",
    status: "pending",
    createdBy: "ai_interview",
  } as const;
  const plan = planTaskWrites({
    newTasks: [
      {
        type: "follow_up",
        title: "Ownership rules follow-up",
        description: "Ask about who may own the pharmacy",
        relatedField: "ownershipRestriction",
        sellerExplanation: "",
      },
    ],
    existing: [counsel as any],
    documents: [],
    answeredKeys: new Set(["ownershipRestriction"]),
    resolvedTopics: ["Verify with counsel: ownershipRestriction"],
    sellerMessage: "Yes, only a pharmacist can own it.",
  });
  assert.ok(!plan.close.includes("t1"), "the seller restating a legal point doesn't close the counsel check");
  assert.ok(!plan.update.some((u) => u.id === "t1"), "the counsel check's wording is never overwritten");
  assert.equal(plan.create.length, 1, "an agent follow-up on the same field is its own task");
  ok("counsel checks are never closed by an answer or merged into");
}

console.log(`${n} groups passed`);
