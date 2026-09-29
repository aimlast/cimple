/**
 * Integration of free round 2 (journeys / cim / finance-facts continuations)
 * onto the review-round-2 build: the places where the two sides were joined
 * by hand keep BOTH fixes.
 *
 *  - A full regenerate drops the approved (published*) versions in the SAME
 *    transaction that replaces the sections (review-round-2 made the
 *    replacement atomic; the CIM stream dropped the approved versions).
 *  - A background full DD run records the approved sections' DD versions
 *    once it writes (CIM stream), inside the fail-soft run (review round 2).
 *  - The buyer Q&A route: fail-soft answerBuyerQuestion (review round 2)
 *    fed with the buyer's CIM incl. approved versions and the staleness
 *    filter on earlier AI answers (CIM stream); FAQ rows still feed it.
 *  - Sharing an AI answer records the broker's draft only on a published
 *    question (endorsedDraftOnPublish's rule).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
let passed = 0;
const ok = (name: string) => { passed++; console.log(`PASS ${name}`); };

{
  const storage = read("server/storage.ts");
  const at = storage.indexOf("async replaceDealCim(dealId: string");
  const body = storage.slice(at, storage.indexOf("\n  }\n", at));
  assert.ok(at > 0);
  assert.match(body, /db\.transaction/);
  assert.match(body, /\["blind", "dd", \.\.\.PUBLISHED_MODES\]/);
  const jobs = read("server/cim/generation-jobs.ts");
  assert.ok(!jobs.includes("deleteCimSectionsForDeal("), "no piecemeal delete outside the transaction");
  ok("a full regenerate drops the approved versions inside the replacement transaction");
}

{
  const dd = read("server/cim/dd-enrichment.ts");
  const at = dd.indexOf("const dbRunWriter: DdRunWriter");
  const body = dd.slice(at, dd.indexOf("\n};\n", at));
  assert.ok(body.includes("if (written.length > 0) await recordPublishedDd(dealId);"));
  const routes = read("server/routes.ts");
  const start = routes.indexOf('app.post("/api/deals/:dealId/generate-dd"');
  const gen = routes.slice(start, routes.indexOf("app.", start + 10));
  assert.ok(gen.includes("startFullDdGeneration("), "the DD run stays in the background");
  assert.ok(gen.includes("res.status(202)"));
  ok("a full DD run records the approved DD versions when it writes");
}

{
  const routes = read("server/routes.ts");
  const start = routes.indexOf('app.post("/api/deals/:dealId/questions"');
  const body = routes.slice(start, routes.indexOf('app.get("/api/deals/:dealId/questions/published"', start));
  assert.ok(body.includes("answerBuyerQuestion("));
  assert.ok(body.includes("loadPublishedVersions(deal)"), "the buyer's CIM includes the approved versions");
  assert.ok(body.includes("publishedQuestionsFor(deal, reader, { text: cimText, changedAt, held })"), "earlier AI answers checked against the current CIM");
  assert.ok(body.includes("loadCimText: async () => cimText"));
  const ctx = read("server/qa/cim-context.ts");
  const q = ctx.slice(ctx.indexOf("export async function publishedQuestionsFor"));
  assert.ok(q.includes("faqKnowledgeRows(deal.id, faqs)"), "FAQ rows still feed the knowledge base");
  assert.ok(q.includes("answerStillHolds(q, current)"));
  ok("buyer Q&A: fail-soft steps, approved versions, stale AI answers dropped, FAQ kept");
}

{
  const routes = read("server/routes.ts");
  const start = routes.indexOf('app.patch("/api/questions/:questionId"');
  const body = routes.slice(start, start + 4000);
  assert.ok(body.includes('effectiveStatus === "published" && !existingQ.brokerDraft && brokerDraft === undefined'));
  assert.ok(body.includes('updates.answerScope = "all"'));
  ok("sharing records the broker's draft only on a published question");
}

console.log(`integ-free-round-2-complete: ${passed} passed`);
