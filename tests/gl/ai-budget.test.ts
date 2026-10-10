/**
 * gl spec §12.1 test 13 (§7.4, D9): the assistant's daily budgets — every
 * call reserved before it is made, atomically: 20 reservations at once give
 * exactly the cap; the seller's and the broker's counters are separate; a
 * new UTC day resets them; no key → nothing reserved, nothing called.
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { memoryStore, _setGlStoreForTests } from "../../server/gl/store";
import { GL_AI_CAPS, glAiClient, glAiDay, reserveGlAi, _setGlAiClientForTests } from "../../server/gl/ai";

const store = memoryStore();
_setGlStoreForTests(store);
await store.ensureTracing("deal-a", "12-31");
await store.ensureTracing("deal-b", "12-31");
const day1 = new Date("2026-10-09T23:59:00Z");
const day2 = new Date("2026-10-10T00:01:00Z");

await test("20 at once → exactly the cap (broker ranking: 12)", async () => {
  const r = await Promise.all(Array.from({ length: 20 }, () => reserveGlAi("deal-a", "broker", "ranking", day1)));
  assert.equal(r.filter(Boolean).length, GL_AI_CAPS.broker_ranking);
  assert.equal(await reserveGlAi("deal-a", "broker", "ranking", day1), false);
});

await test("the seller's budget is its own; mappings are counted apart from rankings", async () => {
  const s = await Promise.all(Array.from({ length: 20 }, () => reserveGlAi("deal-a", "seller", "ranking", day1)));
  assert.equal(s.filter(Boolean).length, GL_AI_CAPS.seller_ranking);
  const m = await Promise.all(Array.from({ length: 5 }, () => reserveGlAi("deal-a", "broker", "mapping", day1)));
  assert.equal(m.filter(Boolean).length, GL_AI_CAPS.broker_mapping);
  const sm = await Promise.all(Array.from({ length: 5 }, () => reserveGlAi("deal-a", "seller", "mapping", day1)));
  assert.equal(sm.filter(Boolean).length, GL_AI_CAPS.seller_mapping);
});

await test("another deal has its own counters", async () => {
  assert.equal(await reserveGlAi("deal-b", "broker", "ranking", day1), true);
});

await test("a new UTC day resets every counter", async () => {
  assert.equal(glAiDay(day1), "2026-10-09");
  assert.equal(glAiDay(day2), "2026-10-10");
  assert.equal(await reserveGlAi("deal-a", "broker", "ranking", day2), true);
  assert.equal(await reserveGlAi("deal-a", "seller", "ranking", day2), true);
  const t = (await store.getTracing("deal-a")) as any;
  assert.equal(t.aiDay, "2026-10-10");
  assert.equal(t.aiBrokerRanking, 1);
  assert.equal(t.aiSellerRanking, 1);
  assert.equal(t.aiBrokerMapping, 0);
});

await test("no tracing row → nothing reserved", async () => {
  assert.equal(await reserveGlAi("no-deal", "broker", "ranking", day1), false);
});

await test("the key disabled or missing → no client (nothing is ever called)", () => {
  _setGlAiClientForTests(undefined);
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "disabled";
  assert.equal(glAiClient(), null);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(glAiClient(), null);
  process.env.ANTHROPIC_API_KEY = before;
});

_setGlStoreForTests(null);
done("AI budgets");
