/**
 * INTEGRATION §2.12 (merge step 8): the three blocks the interview prompt
 * gained this release — together's "Data points the broker wants the seller
 * to answer next…", dd's "THE BROKER WOULD LIKE THE STORY BEHIND THESE
 * NUMBERS" and gl's "OPEN REQUEST FROM THE BROKER: COSTS IN THE BOOKS" — are
 * additive, deterministic and never MANDATORY: a prompt built with all three
 * has the same count of "MANDATORY" lines as one built without them, and
 * completionBlockers takes nothing from them. No AI, no DB (gl's memory store).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/interview/prompt-three-blocks.test.ts
 */
import assert from "node:assert/strict";

process.env.ANTHROPIC_API_KEY = "disabled";
process.env.DISABLE_SCHEDULERS = "1";

const { assembleKnowledgeBase } = await import("../../server/interview/knowledge-base");
const { buildInterviewSystemBlocks } = await import("../../server/interview/system-prompt");
const { completionBlockers } = await import("../../server/interview/completion-gaps");
const { memoryStore, _setGlStoreForTests } = await import("../../server/gl/store");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

const baseDeal: any = {
  id: "d-plain", brokerId: "b1", businessName: "Pacific Coast Logistics Ltd.", industry: "Transportation", subIndustry: "Trucking", location: "Delta, BC",
  description: null, questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null, scrapeSource: null,
  sellerProfile: null, sectionImportance: null, interviewOutline: null, interviewPlan: null, askingPrice: null, extractedInfo: {}, interviewSourceReview: null,
};
const withOutline: any = {
  ...baseDeal,
  id: "d-all",
  interviewOutline: {
    updatedAt: "2026-10-09T00:00:00.000Z", customTopics: [], excludedSections: [], emphasis: [], addedItems: [], removedItems: [],
    followUpItems: [
      { itemId: "financials:fleetAge", key: "fleetAgeAverage", sectionKey: "financials", label: "Average age of the fleet", ask: "How old are the trucks, on average?", addedAt: "2026-10-09T00:00:00.000Z", sittingId: "s1" },
    ],
  },
};
const explain = [
  { captureKey: "reasonFuelChange2023", kind: "movement", line: "fuel", year: "2023", fromYear: "2022", from: 5420000, value: 4760000 },
] as any;

// gl: an open request on d-all (sent, not withdrawn, the seller not done, one cost sent to the seller).
const store = memoryStore();
_setGlStoreForTests(store);
await store.ensureTracing("d-all", "12-31");
await store.updateTracing("d-all", { requestedAt: new Date("2026-10-08T00:00:00Z") } as any);
await store.upsertTrace({ dealId: "d-all", addbackKey: "vehicle", sentAt: new Date("2026-10-08T00:00:00Z"), proof: "ledger" } as any);

const mandatoryLines = (text: string) => text.split("\n").filter((l) => /MANDATORY/.test(l)).length;
const promptOf = async (kb: any, dealId: string) => (await buildInterviewSystemBlocks(kb, { dealId })).map((b) => b.text).join("\n");

const kbAll = assembleKnowledgeBase(withOutline, [], [], null, []);
kbAll.explainRequests = explain;
kbAll.conductedBy = "seller";
const kbNone = assembleKnowledgeBase(baseDeal, [], [], null, []);
kbNone.conductedBy = "seller";

console.log("the three prompt blocks (INTEGRATION §2.12)");
const all = await promptOf(kbAll, "d-all");
const none = await promptOf(kbNone, "d-plain");

await test("all three blocks render on a seller session with a follow-up item, an explain question and an open GL request", () => {
  assert.ok(all.includes("Data points the broker wants the seller to answer next"), "together's block");
  assert.ok(all.includes("THE BROKER WOULD LIKE THE STORY BEHIND THESE NUMBERS"), "dd's block");
  assert.ok(all.includes("OPEN REQUEST FROM THE BROKER: COSTS IN THE BOOKS"), "gl's block");
  for (const b of ["Data points the broker wants the seller to answer next", "STORY BEHIND THESE NUMBERS", "COSTS IN THE BOOKS"]) {
    assert.ok(!none.includes(b), `absent without its input: ${b}`);
  }
});

await test("the same count of MANDATORY lines with all three as without them", () => {
  assert.equal(mandatoryLines(all), mandatoryLines(none));
  for (const l of all.split("\n").filter((x) => /MANDATORY/.test(x))) {
    assert.ok(!/follow-?up|STORY BEHIND|COSTS IN THE BOOKS|ledger|books/i.test(l), `no new MANDATORY line: ${l}`);
  }
});

await test("the broker alone never gets gl's block (seller sessions only)", async () => {
  const kbBroker = assembleKnowledgeBase(withOutline, [], [], null, []);
  kbBroker.conductedBy = "broker";
  assert.ok(!(await promptOf(kbBroker, "d-all")).includes("COSTS IN THE BOOKS"));
});

await test("completionBlockers takes nothing from them", () => {
  const inputs = { sectionCoverage: [], criticalSections: new Set<string>(), info: {}, ledger: [], exchanges: [], conflicts: [], risks: [], onFileTopics: [] } as any;
  assert.deepEqual(completionBlockers({ ...inputs, explainRequests: explain, outline: withOutline.interviewOutline } as any), completionBlockers(inputs));
});

_setGlStoreForTests(null);
console.log(`\nprompt-three-blocks: ${passed} passed`);
process.exit(0);
