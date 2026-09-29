/**
 * R3 — an AI failure in the buyer Q&A must forward the question to the
 * broker, never throw it away with a 500. The route's answering logic is
 * server/buyers/question-answer.ts; the route saves whatever it returns,
 * then counts the analytics event and notifies the broker on escalation.
 * No AI (stubbed model).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-resilience-qa.test.ts
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { answerBuyerQuestion, type AskModel } from "../../server/buyers/question-answer";

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const log = () => {};
const outage: AskModel = async () => { const e: any = new Error("Your credit balance is too low to access the Anthropic API"); e.status = 400; throw e; };
const published = [{ id: "q1", question: "How many trucks?", publishedAnswer: "The fleet has 42 tractors and 60 trailers." }];
const cim = async () => "Facility: leased yard, monthly rent $18,500, lease to 2031.";

// Credits out: both AI steps fail → forwarded to the broker (not a 500).
{
  const r = await answerBuyerQuestion({ question: "What are the lease terms?", published, loadCimText: cim, ask: outage, log });
  assert.deepEqual(r, { kind: "escalate", reason: "ai_unavailable" });
  ok("an AI outage forwards the question to the broker");
}

// The similarity check fails but the CIM answer works.
{
  let n = 0;
  const ask: AskModel = async ({ system }) => {
    n++;
    if (/similarity matcher/.test(system)) { const e: any = new Error("overloaded"); e.status = 529; throw e; }
    return "The yard is leased at $18,500 a month until 2031.";
  };
  const r = await answerBuyerQuestion({ question: "What are the lease terms?", published, loadCimText: cim, ask, log });
  assert.equal(r.kind, "cim");
  assert.equal(n, 2);
  ok("a failed similarity check falls through to the CIM answer");
}

// Normal paths unchanged: KB match, CIM answer, ESCALATE, empty CIM.
{
  const kb = await answerBuyerQuestion({ question: "Fleet size?", published, loadCimText: cim, ask: async () => "MATCH: The fleet has 42 tractors and 60 trailers.", log });
  assert.deepEqual(kb, { kind: "knowledge_base", answer: "The fleet has 42 tractors and 60 trailers.", matchedId: "q1" });
  const esc = await answerBuyerQuestion({ question: "Owner's health?", published: [], loadCimText: cim, ask: async () => "ESCALATE — not in the CIM.", log });
  assert.deepEqual(esc, { kind: "escalate", reason: "not_in_cim" });
  let called = false;
  const none = await answerBuyerQuestion({ question: "x", published: [], loadCimText: async () => "  ", ask: async () => { called = true; return "y"; }, log });
  assert.deepEqual(none, { kind: "escalate", reason: "no_cim" });
  assert.equal(called, false);
  ok("knowledge-base matches, CIM answers and ESCALATE behave as before");
}

// The route: the AI steps are no longer bare awaits, and the analytics event is recorded after the question is saved.
{
  const src = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf8");
  const start = src.indexOf('app.post("/api/deals/:dealId/questions"');
  const body = src.slice(start, src.indexOf('app.get("/api/deals/:dealId/questions/published"', start));
  assert.ok(body.includes("answerBuyerQuestion("));
  assert.ok(!/await anthropic\.messages\.create\(\{\s*model: "claude-sonnet-4-5",\s*max_tokens: 600/.test(body), "no unguarded similarity call left");
  assert.ok(body.indexOf("createBuyerQuestion(") < body.indexOf('eventType: "question_asked"'), "analytics counted after the save");
  assert.ok(body.indexOf('eventType: "question_asked"') < body.indexOf('notify(dealId, "buyer_question"'));
  ok("the route saves the question before counting it, and notifies the broker on escalation");
}

console.log(`f2-resilience-qa: ${passed} passed`);
process.exit(0);
