/**
 * The checklist phrasing pass (specs/together.md §3.5, §11.1): the guard,
 * the fallback, compare-and-set, the hourly retry, and never with the key
 * off or schedulers off. A stubbed model — no AI.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/plan-phrasing.test.ts
 */
import assert from "node:assert/strict";
import {
  _resetPhrasingForTests,
  _setPhrasingModelForTests,
  allowedNames,
  ensurePlanPhrasing,
  phrasingIsSafe,
  phrasingUser,
} from "../../server/interview/plan-phrasing";
import { planItemAsk, templateAsk } from "../../server/interview/coverage-asks";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const deal: any = {
  id: "D1",
  industry: "HVAC",
  subIndustry: "Residential HVAC & plumbing",
  location: "Hamilton, Ontario",
  interviewPlan: {
    industry: "HVAC",
    subIndustry: "Residential HVAC & plumbing",
    computedAt: "2026-10-01T00:00:00.000Z",
    status: "ready",
    items: [
      { key: "tsaaLicenseStatus", label: "TSSA registration holder", sectionKey: "permits_licenses", critical: true },
      { key: "comfortClubRenewalRate", label: "Comfort Club renewal rate", sectionKey: "revenue_sources", critical: false },
      { key: "emrRating", label: "WSIB EMR rating", sectionKey: "employees", critical: true },
    ],
  },
};

async function main() {
  console.log("plan phrasing");
  const allowed = allowedNames(deal);

  await test("the guard accepts the deal's province and the playbook's regulators and acronyms", () => {
    assert.ok(phrasingIsSafe(deal.interviewPlan.items[0], { askAs: "Is your TSSA registration held by the company or by you?", whyItMatters: "A registration held personally may not transfer to a buyer." }, allowed));
    assert.ok(phrasingIsSafe(deal.interviewPlan.items[2], { askAs: "Do you know your current WSIB EMR rating, or who keeps it?", whyItMatters: "Buyers check safety history and premiums." }, allowed));
    assert.ok(allowed.has("Ontario") && allowed.has("TSSA"));
  });

  await test("the guard rejects figures, unknown names, legal rules stated as fact and add-back talk", () => {
    const item = deal.interviewPlan.items[1];
    const why = "Recurring members are steady revenue for a buyer.";
    assert.equal(phrasingIsSafe(item, { askAs: "Do more than 85 percent of members renew each year?", whyItMatters: why }, allowed), false, "a figure");
    assert.equal(phrasingIsSafe(item, { askAs: "Does Dave still look after the Comfort Club renewals?", whyItMatters: why }, allowed), false, "a name not in the label");
    assert.equal(phrasingIsSafe(item, { askAs: "Since the law requires the company to hold the licence, is it in the company's name?", whyItMatters: why }, allowed), false, "a legal rule as fact");
    assert.equal(phrasingIsSafe(item, { askAs: "Which Comfort Club costs would you add back to earnings?", whyItMatters: why }, allowed), false, "add-back talk");
    assert.equal(phrasingIsSafe(item, { askAs: "Tell me about renewals", whyItMatters: why }, allowed), false, "not a question");
    assert.ok(phrasingIsSafe(item, { askAs: "How many Comfort Club members renew each year, roughly?", whyItMatters: why }, allowed), "the label's own name is fine");
  });

  await test("the model sees the business in one line and the items — never a fact or a value", () => {
    const u = phrasingUser(deal, [{ key: "emrRating", label: "WSIB EMR rating", section: "Employee Overview" }]);
    assert.match(u, /^The business: HVAC — Residential HVAC & plumbing, Hamilton, Ontario\./);
    assert.match(u, /emrRating \| WSIB EMR rating \| Employee Overview/);
  });

  await test("the fallback until it runs: the template ask", () => {
    assert.equal(planItemAsk(deal.interviewPlan, "comfortClubRenewalRate", "Comfort Club renewal rate", "").ask, templateAsk("Comfort Club renewal rate"));
    assert.equal(templateAsk("WSIB EMR rating"), "What's your WSIB EMR rating?");
  });

  await test("never with the key off, or schedulers off (local servers)", async () => {
    let calls = 0;
    _setPhrasingModelForTests(async () => { calls++; return { items: [] }; });
    process.env.ANTHROPIC_API_KEY = "disabled";
    assert.equal(await ensurePlanPhrasing(deal, { readDeal: async () => deal, writePlan: async () => true }), "skipped");
    process.env.ANTHROPIC_API_KEY = "sk-test-not-used";
    process.env.DISABLE_SCHEDULERS = "1";
    assert.equal(await ensurePlanPhrasing(deal, { readDeal: async () => deal, writePlan: async () => true }), "skipped");
    delete process.env.DISABLE_SCHEDULERS;
    assert.equal(calls, 0);
  });

  await test("writes only safe phrasings, under a compare-and-set on the plan (a rebuild wins); retries hourly after a failure", async () => {
    _resetPhrasingForTests();
    let written: any = null;
    _setPhrasingModelForTests(async () => ({
      items: [
        { key: "tsaaLicenseStatus", askAs: "Is your TSSA registration held by the company or by you?", whyItMatters: "A registration held personally may not transfer." },
        { key: "comfortClubRenewalRate", askAs: "Do 85 percent of members renew?", whyItMatters: "Steady revenue." },
      ],
    }));
    const r = await ensurePlanPhrasing(deal, {
      readDeal: async () => deal,
      writePlan: async (_id, plan, expected) => { written = { plan, expected }; return true; },
    });
    assert.equal(r, "done");
    assert.equal(written.expected, "2026-10-01T00:00:00.000Z");
    const items = written.plan.items;
    assert.equal(items[0].askAs, "Is your TSSA registration held by the company or by you?");
    assert.equal(items[1].askAs, undefined, "the unsafe one keeps the template");
    assert.ok(written.plan.phrasedAt);
    const lost = await ensurePlanPhrasing(deal, { readDeal: async () => deal, writePlan: async () => false });
    assert.equal(lost, "lost_race");
    // A failure: not again within the hour.
    _resetPhrasingForTests();
    let calls = 0;
    _setPhrasingModelForTests(async () => { calls++; throw new Error("overloaded"); });
    const t = Date.parse("2026-10-09T12:00:00Z");
    assert.equal(await ensurePlanPhrasing(deal, { readDeal: async () => deal, writePlan: async () => true }, { now: t }), "failed");
    assert.equal(await ensurePlanPhrasing(deal, { readDeal: async () => deal, writePlan: async () => true }, { now: t + 30 * 60_000 }), "skipped");
    assert.equal(await ensurePlanPhrasing(deal, { readDeal: async () => deal, writePlan: async () => true }, { now: t + 61 * 60_000 }), "failed");
    assert.equal(calls, 2);
  });

  _setPhrasingModelForTests(null);
  console.log(`\n${passed} phrasing checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
