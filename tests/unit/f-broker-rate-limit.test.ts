/**
 * F-B4 — the notetaker's transcript poll no longer uses up the AI limit.
 * Replays the finding's reproduction (harvest/f-broker/rl.mjs): a 2-second
 * poll for ~2.5 minutes of a Zoom call, then an interview turn.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f-broker-rate-limit.test.ts
 */
import assert from "node:assert/strict";
import express from "express";
import rateLimit from "express-rate-limit";
import { AI_LIMIT, applyInterviewRateLimits } from "../../server/rate-limit-scope";

const aiLimiterFor = () => rateLimit({ ...AI_LIMIT, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests." } });

function appWith(wire: (app: express.Express) => void) {
  const app = express();
  app.set("trust proxy", 1);
  wire(app);
  app.get("/api/interview/:d/call/bot/lines", (_q, r) => r.json({ lines: [] }));
  app.post("/api/interview/:d/message/stream", (_q, r) => r.json({ ok: true }));
  app.post("/api/interview/:d/message", (_q, r) => r.json({ ok: true }));
  app.get("/api/deals/:d/questions/published", (_q, r) => r.json([]));
  app.post("/api/deals/:d/questions", (_q, r) => r.json({ ok: true }));
  return app;
}

async function replay(app: express.Express) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  let first429: number | null = null;
  for (let i = 1; i <= 75; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/api/interview/x/call/bot/lines?after=0`);
    if (r.status === 429 && first429 === null) first429 = i;
  }
  const turn = await fetch(`http://127.0.0.1:${port}/api/interview/x/message/stream`, { method: "POST" });
  // The buyer chat's feed poll must not eat the ask budget either.
  for (let i = 0; i < 70; i++) await fetch(`http://127.0.0.1:${port}/api/deals/x/questions/published`);
  const ask = await fetch(`http://127.0.0.1:${port}/api/deals/x/questions`, { method: "POST" });
  // …while the model-running turns still hit the AI limit.
  let turns429: number | null = null;
  for (let i = 1; i <= 70; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/api/interview/x/message`, { method: "POST" });
    if (r.status === 429 && turns429 === null) turns429 = i;
  }
  server.close();
  return { first429, turnStatus: turn.status, askStatus: ask.status, turns429 };
}

// Before: the AI limiter on the whole prefix (the old server/index.ts).
const before = await replay(appWith((app) => {
  const ai = aiLimiterFor();
  app.use("/api/interview", ai);
  app.use("/api/deals/:dealId/questions", ai);
}));
assert.equal(before.first429, 61, "old wiring: the 61st poll (~122s) is refused");
assert.equal(before.turnStatus, 429, "old wiring: the next interview turn is refused");

// After: the real wiring from server/index.ts.
const after = await replay(appWith((app) => applyInterviewRateLimits(app, aiLimiterFor())));
assert.equal(after.first429, null, "75 polls (2.5 minutes) all served");
assert.equal(after.turnStatus, 200, "the interview turn goes through");
assert.equal(after.askStatus, 200, "a buyer can still ask after the chat polled");
// 2 AI requests so far (turn + ask) → the 59th more is the 61st in the window.
assert.equal(after.turns429, 59, "model-running requests are still capped at 60 per 5 minutes");

// Case variants reach the same model handler (Express routing ignores case),
// so they must meet the same cap — the checker's probe ran /MESSAGE 120/120
// times under the poll limit. The Deepgram key mint is capped the same way.
async function hammer(url: string, n: number) {
  const app = express();
  app.set("trust proxy", 1);
  applyInterviewRateLimits(app, aiLimiterFor());
  let runs = 0;
  for (const p of ["start", "message", "message/stream", "end", "transcription-token"]) {
    app.post(`/api/interview/:d/${p}`, (_q, r) => { runs++; r.json({ ok: true }); });
  }
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  let first429: number | null = null;
  let limitHeader: string | null = null;
  for (let i = 1; i <= n; i++) {
    const r = await fetch(`http://127.0.0.1:${port}${url}`, { method: "POST" });
    if (i === 1) limitHeader = r.headers.get("ratelimit-limit");
    if (r.status === 429 && first429 === null) first429 = i;
  }
  server.close();
  return { url, runs, first429, limitHeader };
}
const variants = [];
for (const url of [
  "/api/interview/d1/message",
  "/api/interview/d1/MESSAGE",
  "/API/Interview/d1/Message/Stream",
  "/api/interview/d1/Start/",
  "/api/interview/d1/End",
  "/api/interview/d1/transcription-token",
]) {
  const v = await hammer(url, 120);
  assert.equal(v.runs, 60, `${url}: the handler runs at most 60 times in the window`);
  assert.equal(v.first429, 61, `${url}: the 61st request is refused`);
  assert.equal(v.limitHeader, "60", `${url}: served under the AI limit`);
  variants.push(v);
}

console.log("f-broker-rate-limit: ok", { before, after, variants });
