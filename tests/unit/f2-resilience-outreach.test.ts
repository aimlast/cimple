/**
 * R9 — drafting outreach to many buyers must not fire one parallel AI call
 * per buyer, and a draft that fell back to the generic template must say so.
 *   - mapWithLimit keeps at most N calls in flight, results in order;
 *   - withAiRetry retries 429/529/timeouts, not other errors;
 *   - the route drafts OUTREACH_DRAFTS_AT_ONCE at a time with retries,
 *     returns personalised/templateReason per draft, sits behind the AI rate
 *     limit, and the draft card shows the reason.
 * No AI.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-resilience-outreach.test.ts
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { isTransientAiError, mapWithLimit, withAiRetry } from "../../server/ai-retry";

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

// 81 buyers, 5 at a time; order kept.
{
  let inFlight = 0;
  let peak = 0;
  const ids = Array.from({ length: 81 }, (_, i) => `b${i}`);
  const out = await mapWithLimit(ids, 5, async (id) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return id.toUpperCase();
  });
  assert.equal(peak, 5);
  assert.deepEqual(out, ids.map((x) => x.toUpperCase()));
  assert.deepEqual(await mapWithLimit([], 5, async (x) => x), []);
  ok("81 drafts run 5 at a time, in order");
}

// Retries: a 429 then success; a 400 is not retried; the last failure is thrown.
{
  let n = 0;
  const r = await withAiRetry(async () => { n++; if (n < 3) { const e: any = new Error("rate_limit_error"); e.status = 429; throw e; } return "draft"; }, [1, 1]);
  assert.equal(r, "draft");
  assert.equal(n, 3);
  let m = 0;
  await assert.rejects(() => withAiRetry(async () => { m++; const e: any = new Error("bad"); e.status = 400; throw e; }, [1, 1]));
  assert.equal(m, 1);
  let k = 0;
  await assert.rejects(() => withAiRetry(async () => { k++; const e: any = new Error("overloaded"); e.status = 529; throw e; }, [1, 1]), /overloaded/);
  assert.equal(k, 3);
  assert.ok(isTransientAiError({ name: "APIConnectionTimeoutError" }) && !isTransientAiError(null));
  ok("rate limits and overloads are retried; other errors are not");
}

// The route and the card.
{
  const routes = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf8");
  const start = routes.indexOf('app.post("/api/deals/:dealId/draft-outreach"');
  const body = routes.slice(start, routes.indexOf('app.post("/api/deals/:dealId/send-outreach"', start));
  assert.ok(body.includes("mapWithLimit(buyerUserIds, OUTREACH_DRAFTS_AT_ONCE"));
  assert.ok(!body.includes("Promise.all(buyerUserIds.map"), "no burst of one call per buyer");
  assert.ok(body.includes("withAiRetry(() => anthropic.messages.create("));
  assert.ok(body.includes("personalised: templateReason === null") && body.includes('templateReason = "ai_unavailable"') && body.includes('templateReason = "identifying_details"'));
  const index = fs.readFileSync(path.join(process.cwd(), "server", "index.ts"), "utf8");
  assert.ok(index.includes('app.use("/api/deals/:dealId/draft-outreach", aiLimiter);'));
  const panel = fs.readFileSync(path.join(process.cwd(), "client", "src", "components", "deal", "SuggestedBuyersPanel.tsx"), "utf8");
  assert.ok(panel.includes("d.personalised === false") && panel.includes("draft-template-"));
  ok("the route drafts in small batches with retries, flags template drafts, and the card shows why");
}

console.log(`f2-resilience-outreach: ${passed} passed`);
process.exit(0);
