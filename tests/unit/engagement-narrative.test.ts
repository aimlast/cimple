/**
 * The optional AI brief on a buyer (server/engagement/narrative.ts), with a
 * STUBBED Anthropic client — the API is never called. Proves: supporting
 * model + forced tool; grounded on the deterministic facts only; cached;
 * a blind buyer's brief is built from the codename and the titles that
 * buyer saw, and anything the blind check catches is replaced by a safe
 * summary; no AI configured → a clear "unavailable"; nothing read → nothing
 * to summarise.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/engagement-narrative.test.ts
 */
import assert from "node:assert/strict";
import { DEFAULT_ENGAGEMENT_FILTERS, viewerPageKey, type BuyerReadingFacts, type DealReadingFacts, type FactPage } from "../../shared/analytics-v2";
import {
  BriefNothingToSayError, BriefUnavailableError, briefFacts, buyerBrief, clearBriefCache, setBriefClient, type BriefClient,
} from "../../server/engagement/narrative";
import { agentConfig } from "../../server/interview/config/load-config";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

const NOW = new Date("2026-09-28T16:00:00Z");
const deal = {
  id: "deal-1",
  businessName: "Harbourline Dental Group",
  blindCodename: "Project Atlas",
  industry: "Healthcare",
  extractedInfo: { businessName: "Harbourline Dental Group", ownerName: "Dr. Amelia Harbour", city: "Kitchener" },
  employeeChart: [],
};
const page = (pageId: string, i: number, title: string, servedTitle: string | null, role: FactPage["role"], expectedMs: number): FactPage => ({
  pageId, part: 0, index: i, label: String(i + 1), lineageId: pageId, title, servedTitle, layoutType: "prose_highlight",
  role, locked: false, expectedMs, blocks: [],
});
const pages = [
  page("cover", 0, "Harbourline Dental Group", "Project Atlas", "front_matter", 5_000),
  page("inc", 1, "Harbourline Income Statement", "Income Statement", "financials", 40_000),
  page("team", 2, "Dr. Harbour's Kitchener Team", "The Clinical Team", "employees", 30_000),
];
function buyer(accessId: string, accessLevel: string, mode: "blind" | "normal", withReading = true): BuyerReadingFacts {
  return {
    accessId, buyerUserId: null, name: "Jordan Lee", company: "Harbor Capital", email: "j@x.invalid", buyerType: "financial",
    accessLevel, mode, grantedAt: "2026-09-20T12:00:00Z", firstViewedAt: "2026-09-25T12:00:00Z", ndaSignedAt: "2026-09-25T12:00:00Z",
    decision: "under_review", decisionAt: null, contactedAt: null, fit: null,
    visits: withReading ? [{
      id: `${accessId}-v`, renditionId: "r".repeat(32), startedAt: "2026-09-27T14:00:00Z", lastSeenAt: "2026-09-27T14:25:00Z",
      wallMs: 1_500_000, activeMs: 1_200_000, device: "desktop", uaFamily: "Chrome/Mac", maxPageIndex: 2,
      path: [[0, "cover"], [10, "inc"], [400, "team"]], legacy: false, networkKey: null,
    }] : [],
    pages: withReading ? {
      [viewerPageKey("inc", 0)]: { attentionMs: 130_000, skimMs: 0, visibleMs: 130_000, firstAt: null, lastAt: null, visits: 1 },
      [viewerPageKey("team", 0)]: { attentionMs: 70_000, skimMs: 0, visibleMs: 70_000, firstAt: null, lastAt: null, visits: 1 },
    } : {},
    blocks: {}, events: [], questions: [],
  };
}
const facts = (b: BuyerReadingFacts[]): DealReadingFacts => ({
  dealId: deal.id, dealName: deal.businessName, rendition: null, renditions: [], now: NOW.toISOString(),
  filters: DEFAULT_ENGAGEMENT_FILTERS, pages, buyers: b, legacyOnly: false, lastWriteAt: null,
});

const calls: any[] = [];
let reply = "Jordan spent 2 min 10 s on the Income Statement and 1 min 10 s on The Clinical Team. They may want to walk through the numbers. Open with: \"What stood out in the financials?\"";
const stub: BriefClient = {
  messages: {
    async create(args: any) {
      calls.push(args);
      return { content: [{ type: "tool_use", input: { brief: reply } }] };
    },
  },
};

await test("the supporting model with the brief tool forced; the facts are the deterministic insight", async () => {
  setBriefClient(stub);
  clearBriefCache();
  const res = await buyerBrief(deal, facts([buyer("acc-loi", "loi", "normal")]), "acc-loi");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, agentConfig.models.supportingAgents);
  assert.deepEqual(calls[0].tool_choice, { type: "tool", name: "buyer_brief" });
  assert.equal(res.cached, false);
  assert.equal(res.text, reply);
  const user = calls[0].messages[0].content as string;
  assert.match(user, /CIM: Harbourline Dental Group/, "a named (LOI) buyer's brief may name the business");
  assert.match(user, /page 2 "Harbourline Income Statement": 2 min 10 s \(Studied\)/);
  assert.match(calls[0].system, /never "they are worried/);
});
await test("cached per buyer and reading state — a second ask costs nothing", async () => {
  const again = await buyerBrief(deal, facts([buyer("acc-loi", "loi", "normal")]), "acc-loi");
  assert.equal(calls.length, 1);
  assert.equal(again.cached, true);
  const more = buyer("acc-loi", "loi", "normal");
  more.pages[viewerPageKey("inc", 0)].attentionMs = 200_000;
  await buyerBrief(deal, facts([more]), "acc-loi");
  assert.equal(calls.length, 2, "new reading → a new brief");
});
await test("blind buyer: codename and the titles that buyer saw — never the real name, owner, city or real titles", async () => {
  calls.length = 0;
  clearBriefCache();
  await buyerBrief(deal, facts([buyer("acc-blind", "full", "blind")]), "acc-blind");
  const sent = `${calls[0].system}\n${calls[0].messages[0].content}`;
  for (const leak of ["Harbourline", "Harbour", "Kitchener", "Amelia"]) assert.ok(!sent.includes(leak), `sent "${leak}" to the model`);
  assert.match(sent, /Project Atlas/);
  assert.match(sent, /"Income Statement"/);
  assert.match(sent, /"The Clinical Team"/);
});
await test("blind buyer: a reply that names the business is replaced by the safe summary", async () => {
  clearBriefCache();
  reply = "Jordan read Harbourline Dental Group's income statement closely — ask how Dr. Harbour plans the transition in Kitchener.";
  const res = await buyerBrief(deal, facts([buyer("acc-blind", "full", "blind")]), "acc-blind");
  assert.ok(!/Harbour|Kitchener/.test(res.text), res.text);
  assert.ok(res.text.length > 20);
  assert.match(res.text, /Income Statement|financials/);
});
await test("a thin or empty reply falls back to the deterministic summary", async () => {
  clearBriefCache();
  reply = "";
  const res = await buyerBrief(deal, facts([buyer("acc-loi2", "loi", "normal")]), "acc-loi2");
  const expected = briefFacts(deal, facts([buyer("acc-loi2", "loi", "normal")]), "acc-loi2")!.fallback;
  assert.equal(res.text, expected);
});
await test("nothing read → nothing to summarise; no AI configured → unavailable (never a network call)", async () => {
  await assert.rejects(buyerBrief(deal, facts([buyer("acc-none", "full", "blind", false)]), "acc-none"), BriefNothingToSayError);
  setBriefClient(null);
  clearBriefCache();
  await assert.rejects(buyerBrief(deal, facts([buyer("acc-loi3", "loi", "normal")]), "acc-loi3"), BriefUnavailableError);
});

console.log(`\n${passed} passed`);
process.exit(0);
