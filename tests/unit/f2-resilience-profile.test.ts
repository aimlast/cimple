/**
 * R2 — a failed seller-profile AI call must never save an invented profile
 * ("Selling reason: Retirement", solo operator) as if the deal's sources said
 * so. generateSellerProfile throws; the no-data profile says "unknown";
 * stand-in profiles already saved are rebuilt and kept out of the prompt;
 * failed builds back off for an hour.
 * No database, no AI (stubbed storage and client).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-resilience-profile.test.ts
 */
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import {
  _setProfilerClientForTests,
  generateSellerProfile,
  profileSafeForInterview,
  isInventedFallbackProfile,
  noteSellerProfileFailure,
  clearSellerProfileFailure,
  sellerProfileNeedsRebuild,
  sellerProfileRetryDue,
  SellerProfileUnavailableError,
  PROFILE_PRIVACY_VERSION,
} from "../../server/interview/eq-profiler";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

const deal: any = { id: "d-prof", businessName: "Clearwater Physio", industry: "Healthcare", description: "Owner is selling because of a health issue; spouse runs the front desk." };
const docs: any[] = [
  { id: "t1", name: "Discovery call", category: "transcripts", sourceKind: "call", visibility: "shared", extractedText: "My wife Anna and I run it together. My back surgery is why I'm selling." },
];
const s = storage as any;
s.getDeal = async (id: string) => (id === deal.id ? { ...deal } : undefined);
s.getDocumentsByDeal = async () => docs;
s.getIntegrationEmailsByDeal = async () => [];

const origError = console.error;
const origWarn = console.warn;
console.error = () => {};
console.warn = () => {};

// An API error (no credits / 529 / timeout): throws, never a stand-in.
{
  _setProfilerClientForTests({ messages: { create: async () => { const e: any = new Error("Your credit balance is too low"); e.status = 400; throw e; } } });
  await assert.rejects(() => generateSellerProfile(deal.id), (e: any) => e instanceof SellerProfileUnavailableError && /current profile was kept/.test(e.message));
  _setProfilerClientForTests({ messages: { create: async () => { const e: any = new Error("overloaded"); e.status = 529; throw e; } } });
  await assert.rejects(() => generateSellerProfile(deal.id), SellerProfileUnavailableError);
  // No structured answer: same.
  _setProfilerClientForTests({ messages: { create: async () => ({ content: [{ type: "text", text: "hi" }] }) } });
  await assert.rejects(() => generateSellerProfile(deal.id), SellerProfileUnavailableError);
  ok("an AI failure throws SellerProfileUnavailableError instead of returning 'retirement / solo operator'");
}

// A real answer still builds the profile from the sources.
{
  _setProfilerClientForTests({ messages: { create: async () => ({ content: [{ type: "tool_use", name: "seller_communication_profile", input: { communicationStyle: "direct", emotionalState: "anxious", sellingReason: "health", familyInvolvement: "spouse_involved", sellerStory: "Selling for health reasons; his wife works in the clinic.", industryContext: "Physio." } }] }) } });
  const p = await generateSellerProfile(deal.id);
  assert.equal(p.sellingReason, "health");
  assert.equal(p.familyInvolvement, "spouse_involved");
  assert.ok(p.dataSources.includes("call_transcripts"));
  // An answer missing the category: "unknown", not a guess.
  _setProfilerClientForTests({ messages: { create: async () => ({ content: [{ type: "tool_use", name: "seller_communication_profile", input: { sellerStory: "x" } }] }) } });
  const q = await generateSellerProfile(deal.id);
  assert.equal(q.sellingReason, "unknown");
  assert.equal(q.familyInvolvement, "unknown");
  ok("a real answer builds the profile; a missing category is 'unknown', never 'retirement'");
}

// No data at all: the neutral default says "unknown" and never "Retirement".
{
  const bare: any = { id: "d-bare", businessName: "Maple & Main Café", industry: "Food service" };
  s.getDeal = async (id: string) => (id === bare.id ? bare : undefined);
  s.getDocumentsByDeal = async () => [];
  let called = 0;
  _setProfilerClientForTests({ messages: { create: async () => { called++; throw new Error("unused"); } } });
  const p = await generateSellerProfile(bare.id);
  assert.equal(called, 0);
  assert.equal(p.sellingReason, "unknown");
  assert.equal(p.familyInvolvement, "unknown");
  // The interview prompt (the profile's only reader) spells "unknown" out.
  const kb = assembleKnowledgeBase({ ...bare, extractedInfo: {}, sellerProfile: p } as any, [], [], null, []);
  const prompt = renderKnowledgeBaseForPrompt(kb);
  const block = prompt.slice(prompt.indexOf("## Seller Communication Profile"), prompt.indexOf("## Seller Communication Profile") + 2000);
  assert.ok(block.length > 30, "the profile reaches the prompt");
  assert.ok(!/Retirement|Solo operator/i.test(block), block);
  assert.ok(!/: unknown/.test(block), block);
  assert.match(block, /- Selling reason: Not known yet — let the seller say it in their own words; never assume one/);
  assert.match(block, /- Family involvement: Not known yet — don't assume who else is involved/);
  assert.equal(isInventedFallbackProfile(p), false, "the new default is not mistaken for a stand-in");
  assert.equal(sellerProfileNeedsRebuild(p, []), false);
  ok("the no-data profile says 'not known yet' for the selling reason and who decides");
}

// A stand-in profile saved by the old fallback: rebuilt, and its categories are kept out of the interview.
{
  const legacy: any = {
    communicationStyle: "conversational", emotionalState: "neutral", sellingReason: "retirement", sophistication: "first_time_seller",
    businessAttachment: "medium", timeOrientation: "moderate", familyInvolvement: "solo_operator", sensitiveTopics: [], personalInsights: [],
    sellerStory: "The owner of Clearwater Physio is preparing to sell their Healthcare business. Limited information is available about their personal motivations and communication preferences at this time.",
    industryContext: "x", confidenceScore: 0.3, dataSources: ["broker_notes", "call_transcripts"], generatedAt: "2026-09-01T00:00:00Z",
    privacyVersion: PROFILE_PRIVACY_VERSION, sourceDocumentIds: ["t1"],
  };
  assert.equal(isInventedFallbackProfile(legacy), true);
  assert.equal(sellerProfileNeedsRebuild(legacy, docs), true, "rebuilt at the next session start");
  const shown = profileSafeForInterview(legacy, docs) as any;
  assert.equal(shown.sellingReason, undefined, "the interview never hears the invented reason");
  assert.equal(shown.familyInvolvement, undefined);
  // A broker's own correction survives.
  const corrected = profileSafeForInterview({ ...legacy, brokerOverrides: { sellingReason: "health" } }, docs) as any;
  assert.equal(corrected.sellingReason, "health", "the broker's own setting is kept");
  ok("a stand-in profile already saved is rebuilt and its invented categories never reach the interview");
}

// Back-off: after a failure, no retry for an hour.
{
  const t0 = Date.parse("2026-09-28T10:00:00Z");
  assert.equal(sellerProfileRetryDue("d-x", t0), true);
  noteSellerProfileFailure("d-x", t0);
  assert.equal(sellerProfileRetryDue("d-x", t0 + 10 * 60_000), false);
  assert.equal(sellerProfileRetryDue("d-x", t0 + 61 * 60_000), true);
  noteSellerProfileFailure("d-x", t0);
  clearSellerProfileFailure("d-x");
  assert.equal(sellerProfileRetryDue("d-x", t0 + 1), true);
  ok("a failed build is retried at most hourly");
}

console.error = origError;
console.warn = origWarn;
_setProfilerClientForTests(null);
console.log(`f2-resilience-profile: ${passed} passed`);
process.exit(0);
