// V11-5: the keep-out AI review must read every private note, however many
// facts a deal has. Before the fix, keepOutCandidates listed fact clauses
// first and cut the list at 120, so on a rich deal the broker's notes (where
// "keep this out" lives) were never sent, the result still said by:"ai" with
// no warning, and it was cached under the truncated list's fingerprint.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/rv-keep-out-batches.test.ts
import assert from "node:assert/strict";
import { keepOutFor, keepOutCandidates, _setKeepOutModelForTests } from "../../server/cim/keep-out";

const NOTE = "Seller asked that we not discuss the Harvest Lane bid with anyone yet";
function richDeal(factCount: number): Record<string, unknown> {
  const info: Record<string, unknown> = {
    businessName: "Ridgeline Metal Fabrication",
    growthOpportunities: "Submitted a bid to Harvest Lane Distribution for a 3-year fabrication contract.",
    _brokerPrivateNotes: [{ note: NOTE }],
  };
  for (let i = 0; i < factCount; i++) info[`fact${i}`] = `Item ${i}: the shop will keep its public safety record on file`;
  return info;
}

let calls: string[] = [];
_setKeepOutModelForTests({
  messages: {
    create: async (req: any) => {
      const prompt = req.messages[0].content as string;
      calls.push(prompt);
      const holds: any[] = [];
      for (const line of prompt.split("\n")) {
        const m = /^(N\d+) \[private note\]: (.*)$/.exec(line);
        if (m && /Harvest Lane/.test(m[2])) holds.push({ ref: m[1], parties: ["Harvest Lane"], reason: "the seller asked to keep the bid quiet" });
      }
      return { content: [{ type: "tool_use", id: "x", name: "keep_out_review", input: { holds } }] };
    },
  },
} as any);

// 1. A deal whose fact clauses alone pass the old 120 cap: the note is still reviewed.
{
  const info = richDeal(200);
  const cands = keepOutCandidates(info);
  assert.equal(cands[0].kind, "note", "notes come first");
  assert.ok(cands.length > 200, "nothing is truncated");
  calls = [];
  const r = await keepOutFor("rich", info);
  assert.equal(r.by, "ai");
  assert.equal(r.warning, undefined);
  assert.deepEqual(r.names, ["Harvest Lane"], "the note's party is held");
  assert.equal(calls.length, 2, "reviewed in two batches");
  assert.ok(calls[0].includes(NOTE));
  console.log("✓ private notes are reviewed on a deal with 200+ fact clauses");
}

// 2. A note added later changes the cache key: the review runs again.
{
  const info = richDeal(200);
  await keepOutFor("cache", info);
  calls = [];
  (info._brokerPrivateNotes as any[]).push({ note: "Coldbrook settlement terms are private — never share with buyers" });
  await keepOutFor("cache", info);
  assert.ok(calls.length > 0, "not answered from the old cache");
  console.log("✓ a new note is never hidden by the cache");
}

// 3. Past the batch ceiling, what was read still holds and the broker is told.
{
  const info = richDeal(900);
  calls = [];
  const r = await keepOutFor("huge", info);
  assert.equal(calls.length, 6);
  assert.deepEqual(r.names, ["Harvest Lane"]);
  assert.equal(r.by, "rules");
  assert.match(r.warning ?? "", /read the first 720 of 90\d facts and private notes/);
  console.log("✓ a review that can't read everything says so");
}

_setKeepOutModelForTests(null);
console.log("rv-keep-out-batches: all passed");
