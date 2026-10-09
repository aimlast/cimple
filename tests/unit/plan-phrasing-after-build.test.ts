/**
 * The checklist's suggested ways to ask are written right after a checklist
 * build succeeds (fix round 1, F4 — before, only a session together started
 * them, so every deal showed "Can you tell me about …?"):
 *  - a successful build → one phrasing call → the plan carries askAs;
 *  - with the key off or schedulers off → no phrasing call at all;
 *  - a plan already phrased is never phrased again.
 * The plan build's model is a stub on the SDK prototype; the phrasing model is
 * the module's test seam; outbound fetch is blocked. No AI, no database.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/plan-phrasing-after-build.test.ts
 */
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

delete process.env.DISABLE_SCHEDULERS;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any) => { throw new Error(`test: blocked outbound fetch to ${String(url)}`); }) as any;
void realFetch;

// The plan build's model: a recorded checklist (tool output) — never the network.
let buildCalls = 0;
const proto = (Anthropic as any).Messages.prototype;
proto.create = async function () {
  buildCalls++;
  return {
    content: [{
      type: "tool_use",
      name: "industry_checklist",
      input: {
        items: [
          { key: "comfortClubTrend", label: "Comfort Club membership trend (last 3 years)", sectionKey: "revenue_sources", critical: false },
          { key: "tssaHolder", label: "TSSA gas license holder and transferability", sectionKey: "permits_licenses", critical: true },
        ],
      },
    }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
};
proto.stream = function () { throw new Error("test: no streaming here"); };

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const { storage } = await import("../../server/storage");
  const deals: Record<string, any> = {};
  Object.assign(storage as any, {
    getDeal: async (id: string) => (deals[id] ? structuredClone(deals[id]) : undefined),
    updateDeal: async (id: string, patch: any) => { deals[id] = { ...deals[id], ...structuredClone(patch) }; return structuredClone(deals[id]); },
  });
  const { computeInterviewPlan } = await import("../../server/interview/interview-plan");
  const { _setPhrasingModelForTests, _resetPhrasingForTests } = await import("../../server/interview/plan-phrasing");
  let phraseCalls = 0;
  _setPhrasingModelForTests(async () => {
    phraseCalls++;
    return {
      items: [
        { key: "comfortClubTrend", askAs: "How has Comfort Club membership moved over the last few years?", whyItMatters: "Members are recurring revenue a buyer can count on." },
        { key: "tssaHolder", askAs: "Who holds the TSSA gas licence, and can it move to a new owner?", whyItMatters: "A licence held personally may not transfer." },
      ],
    };
  });
  const newDeal = (id: string) => ({ id, industry: "HVAC", subIndustry: "Residential HVAC & plumbing", businessName: "Test Heating Ltd", description: null, location: "Hamilton, Ontario", extractedInfo: {}, interviewPlan: null });
  const settle = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  console.log("phrasing after a checklist build");

  await test("a successful build → its suggested ways to ask, in the background (one call)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-not-used";
    _resetPhrasingForTests();
    deals.D1 = newDeal("D1");
    const plan = await computeInterviewPlan(deals.D1);
    assert.ok(plan && plan.status === "ready");
    await settle(() => !!deals.D1.interviewPlan?.phrasedAt);
    assert.equal(phraseCalls, 1);
    const items = deals.D1.interviewPlan.items;
    assert.equal(items.find((i: any) => i.key === "tssaHolder").askAs, "Who holds the TSSA gas licence, and can it move to a new owner?");
    assert.ok(deals.D1.interviewPlan.phrasedAt);
  });

  await test("a plan already phrased is never phrased again", async () => {
    const { phraseAfterPlanBuild } = await import("../../server/interview/plan-phrasing");
    const before = phraseCalls;
    assert.equal(await phraseAfterPlanBuild("D1"), "skipped");
    assert.equal(phraseCalls, before);
  });

  await test("with the key off, or schedulers off: the build may run but nothing is phrased", async () => {
    const before = phraseCalls;
    process.env.ANTHROPIC_API_KEY = "disabled";
    deals.D2 = newDeal("D2");
    await computeInterviewPlan(deals.D2);
    process.env.ANTHROPIC_API_KEY = "sk-test-not-used";
    process.env.DISABLE_SCHEDULERS = "1";
    deals.D3 = newDeal("D3");
    await computeInterviewPlan(deals.D3);
    await new Promise((r) => setTimeout(r, 100));
    delete process.env.DISABLE_SCHEDULERS;
    assert.equal(phraseCalls, before, "no phrasing call");
    assert.equal(deals.D2.interviewPlan.phrasedAt, undefined);
    assert.equal(deals.D3.interviewPlan.phrasedAt, undefined);
    assert.equal(buildCalls, 3);
  });

  _setPhrasingModelForTests(null);
  process.env.ANTHROPIC_API_KEY = "disabled";
  console.log(`\n${passed} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
