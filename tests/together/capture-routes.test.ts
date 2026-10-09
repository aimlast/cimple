/**
 * Live filing through the routes (specs/together.md §4.6, §7.2, §11.4): a
 * real Express app, in-memory storage, a recorded model (no AI), blocked
 * outbound fetches.
 *  - lines → filed within the part; the board names the sitting and the part;
 *  - ✓ Answered (auto): a focused capture files the seller's words; nothing
 *    said → 409 no_lines; no answer for that item in the words → 409
 *    no_answer (the editor opens);
 *  - live ✓ Confirmed: the seller's own words when they just said it,
 *    otherwise "confirmed by you" (no AI);
 *  - "Save this answer now"; Undo (once; then 404); ✓ File it on a held
 *    possible answer (no AI); Try now; Re-file the last 10 minutes;
 *  - another brokerage → 404 on every new route; GET board calls no model.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/together/capture-routes.test.ts
 */
import { counters, install, lakeshoreDeal, newWorld, statementDoc, waitFor } from "./harness";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";

async function main() {
  const w = newWorld();
  w.deals.D1 = lakeshoreDeal();
  w.deals.D2 = { ...lakeshoreDeal("D2"), brokerId: "B2", businessName: "Other Brokerage" };
  w.documents.push(statementDoc());
  const store = await install(w);
  const { registerTogetherRoutes } = await import("../../server/routes/together");
  const { _setCaptureEnabledForTests } = await import("../../server/together/chunker");
  const { _setCaptureModelForTests } = await import("../../server/together/capture");
  const { stubModel } = await import("../../server/together/capture-stub");
  const { _setPipelineDepsForTests } = await import("../../server/together/pipeline");
  _setCaptureEnabledForTests(true);
  _setPipelineDepsForTests({ sleep: async () => undefined });
  let stubCalls = 0;
  const base = stubModel({
    entries: [
      { match: "Summer and the cold snaps", output: { answers: [{ key: "peakPeriods", value: "June to August, December to February", quote: "Summer and the cold snaps are crazy", speaker: "seller", confidence: "confirmed", basis: "verbatim" }], topicSections: ["seasonality"] } },
      { match: "in the office three days", focus: "employees:ownerInvolvement", output: { answers: [{ key: "ownerInvolvement", value: "In the office three days a week, four in busy season", quote: "I'm in the office three days, four in busy season", speaker: "seller", confidence: "confirmed", basis: "verbatim" }] } },
      { match: "about 20 percent of sales", focus: "revenue_sources:customerConcentration", output: { answers: [{ key: "customerConcentration", value: "Largest customer (a property group) about 20% of sales", quote: "the property group is about 20 percent of sales", speaker: "seller", confidence: "confirmed", basis: "verbatim" }] } },
      { match: "Denise runs dispatch", output: { answers: [{ key: "employeeStructure", value: "Denise runs dispatch", quote: "Denise runs dispatch", speaker: "seller", confidence: "confirmed", basis: "verbatim" }] } },
    ],
  });
  _setCaptureModelForTests(async (req) => { stubCalls++; return base(req); });

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { brokerId: req.get("x-test-broker") || undefined }; next(); });
  registerTogetherRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown, broker: string | null = "B1") => {
    const r = await fetch(url + p, { method, headers: { "content-type": "application/json", ...(broker ? { "x-test-broker": broker } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, json };
  };
  const PAGE = "33333333-cccc-4ccc-8ccc-000000000003";
  let n = 0;
  const ok = (name: string) => { n++; console.log("✓", name); };
  const items = (board: any) => board.sections.flatMap((s: any) => s.items);

  try {
    const start = await call("POST", "/api/deals/D1/together/sittings", { via: "person" });
    const sid = start.json.sitting.id;
    assert.equal(start.json.sitting.filingOn, true);
    await call("POST", `/api/deals/D1/together/sittings/${sid}/consent`, {});
    await call("PATCH", `/api/deals/D1/together/sittings/${sid}`, { sellerSeesScreen: false });
    await call("POST", `/api/deals/D1/together/sittings/${sid}/lines`, { clientId: PAGE, lines: [
      { clientSeq: 1, speaker: "dg:0", text: "Which months are your busiest, and which are the quietest?", source: "deepgram" },
      { clientSeq: 2, speaker: "dg:1", text: "Summer and the cold snaps are crazy, June through August.", source: "deepgram" },
    ] });
    await call("POST", `/api/deals/D1/together/sittings/${sid}/speakers`, { speaker: "dg:0", role: "broker" });
    const fileNow = await call("POST", `/api/deals/D1/together/sittings/${sid}/file-now`, {});
    assert.equal(fileNow.status, 200);
    await waitFor(() => w.deals.D1.extractedInfo.peakPeriods !== undefined, 4000, "the answer filed");
    const board1 = (await call("GET", `/api/deals/D1/coverage-board?sittingId=${sid}`)).json;
    const season = items(board1).find((i: any) => i.id === "seasonality:seasonality");
    assert.equal(season.filedInSittingId, sid);
    assert.ok(season.filedByChunkId);
    ok("'Save this answer now' files the open part; the board names the session and the part");

    const undo = await call("POST", `/api/deals/D1/together/sittings/${sid}/captures/${season.filedByChunkId}/undo`, { key: "peakPeriods" });
    assert.equal(undo.status, 200);
    assert.equal(w.deals.D1.extractedInfo.peakPeriods, undefined);
    assert.equal((await call("POST", `/api/deals/D1/together/sittings/${sid}/captures/${season.filedByChunkId}/undo`, { key: "peakPeriods" })).status, 404, "once");
    assert.equal((await call("POST", `/api/deals/D2/together/sittings/${sid}/captures/${season.filedByChunkId}/undo`, { key: "peakPeriods" }, "B2")).status, 404, "another brokerage");
    ok("Undo: the value goes back; a second Undo → 404; another brokerage → 404");

    await call("POST", `/api/deals/D1/together/sittings/${sid}/lines`, { clientId: PAGE, lines: [
      { clientSeq: 3, speaker: "dg:0", text: "What do you do yourself in a normal week?", source: "deepgram" },
      { clientSeq: 4, speaker: "dg:1", text: "I'm in the office three days, four in busy season.", source: "deepgram" },
    ] });
    const answered = await call("POST", `/api/deals/D1/coverage-board/items/employees:ownerInvolvement/answer`, { sittingId: sid, mode: "auto" });
    assert.equal(answered.status, 200, JSON.stringify(answered.json));
    assert.equal(answered.json.filed, true);
    assert.equal(w.deals.D1.extractedInfo.ownerInvolvement, "In the office three days a week, four in busy season");
    const noAnswer = await call("POST", `/api/deals/D1/coverage-board/items/overview:brandIdentity/answer`, { sittingId: sid, mode: "auto" });
    assert.equal(noAnswer.status, 409);
    assert.equal(noAnswer.json.code, "no_answer");
    assert.match(noAnswer.json.error, /couldn't find the answer/);
    ok("✓ Answered: a focused capture files the seller's own words; no answer in them → the editor opens");

    // ✓ Confirmed in a live session: a CRM lead the seller has just confirmed out loud is filed as THEIR words…
    await call("POST", `/api/deals/D1/together/sittings/${sid}/lines`, { clientId: PAGE, lines: [
      { clientSeq: 5, speaker: "dg:0", text: "Is your largest customer still around that level?", source: "deepgram" },
      { clientSeq: 6, speaker: "dg:1", text: "Yes, the property group is about 20 percent of sales.", source: "deepgram" },
    ] });
    const leadBefore = items((await call("GET", `/api/deals/D1/coverage-board?sittingId=${sid}`)).json).find((i: any) => i.id === "revenue_sources:customerConcentration");
    assert.equal(leadBefore.status, "verify");
    const confirmed = await call("POST", `/api/deals/D1/coverage-board/items/revenue_sources:customerConcentration/confirm`, { sittingId: sid });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
    assert.equal(confirmed.json.filed, true, "filed from the seller's words");
    assert.equal(w.deals.D1.extractedInfo.customerConcentration, "Largest customer (a property group) about 20% of sales");
    assert.equal(w.deals.D1.extractedInfo._fieldSources.customerConcentration.sittingId, sid);
    // …and with nothing said about it (another brokerage's own deal and session), it is "confirmed by you" with no AI call.
    const s3 = await call("POST", "/api/deals/D2/together/sittings", { via: "person" }, "B2");
    const sid3 = s3.json.sitting.id;
    await call("POST", `/api/deals/D2/together/sittings/${sid3}/consent`, {}, "B2");
    const callsBefore = stubCalls;
    const mine = await call("POST", `/api/deals/D2/coverage-board/items/revenue_sources:customerConcentration/confirm`, { sittingId: sid3 }, "B2");
    assert.equal(mine.status, 200, JSON.stringify(mine.json));
    assert.notEqual(mine.json.filed, true);
    assert.equal(stubCalls, callsBefore, "no lines → no capture");
    assert.equal(mine.json.board, undefined, "no board in the reply");
    assert.equal(items((await call("GET", `/api/deals/D2/coverage-board?sittingId=${sid3}`, undefined, "B2")).json).find((i: any) => i.id === "revenue_sources:customerConcentration").status, "on_file");
    assert.equal((await call("POST", `/api/deals/D1/coverage-board/items/revenue_sources:customerConcentration/confirm`, { sittingId: sid3 }, "B2")).status, 404, "another brokerage");
    await call("POST", `/api/deals/D2/together/sittings/${sid3}/end`, { completeInterview: false, followUps: [], documents: [], addToNextSession: false }, "B2");
    ok("live ✓ Confirmed files the seller's own words when they just said it; otherwise confirmed by you (no AI)");

    // A fresh session (two unnamed voices): the answer is held; ✓ File it files it with no AI call.
    const s2 = await call("POST", "/api/deals/D1/together/sittings", { via: "cimple" });
    const sid2 = s2.json.sitting.id;
    assert.notEqual(sid2, sid);
    await call("POST", `/api/deals/D1/together/sittings/${sid2}/consent`, {});
    const empty = await call("POST", `/api/deals/D1/coverage-board/items/overview:brandIdentity/answer`, { sittingId: sid2, mode: "auto" });
    assert.equal(empty.status, 409);
    assert.equal(empty.json.code, "no_lines", "nothing said yet → type it");
    await call("POST", `/api/deals/D1/together/sittings/${sid2}/lines`, { clientId: PAGE, lines: [
      { clientSeq: 1, speaker: "room", text: "Who keeps dispatch running.", source: "browser" },
      { clientSeq: 2, speaker: "room", text: "Denise runs dispatch on our software.", source: "browser" },
    ] });
    await call("POST", `/api/deals/D1/together/sittings/${sid2}/file-now`, {});
    let held: any = null;
    await waitFor(async () => {
      const b = (await call("GET", `/api/deals/D1/coverage-board?sittingId=${sid2}`)).json;
      held = items(b).find((i: any) => i.suggestion);
      return !!held;
    }, 4000, "a possible answer");
    assert.equal(w.deals.D1.extractedInfo.employeeStructure, undefined, "never filed from an unknown speaker");
    const before = stubCalls;
    const fileIt = await call("POST", `/api/deals/D1/coverage-board/items/${held.id}/file-suggestion`, { sittingId: sid2, chunkId: held.suggestion.chunkId });
    assert.equal(fileIt.status, 200);
    assert.equal(fileIt.json.filed, true);
    assert.equal(stubCalls, before, "✓ File it calls no model");
    assert.equal(w.deals.D1.extractedInfo.employeeStructure, "Denise runs dispatch");
    assert.equal((await call("POST", `/api/deals/D1/coverage-board/items/${held.id}/file-suggestion`, { sittingId: sid2, chunkId: held.suggestion.chunkId })).status, 404);
    ok("an unknown speaker's answer is held; ✓ File it files it (no AI); once");

    const retry = await call("POST", `/api/deals/D1/together/sittings/${sid2}/retry`, {});
    assert.equal(retry.status, 200);
    const refile = await call("POST", `/api/deals/D1/together/sittings/${sid2}/refile`, { minutes: 10 });
    assert.equal(refile.status, 200);
    for (const p of ["file-now", "retry", "refile"]) assert.equal((await call("POST", `/api/deals/D2/together/sittings/${sid2}/${p}`, {}, "B2")).status, 404, p);
    assert.equal((await call("POST", `/api/deals/D2/coverage-board/items/${held.id}/file-suggestion`, { sittingId: sid2, chunkId: "x" }, "B2")).status, 404);
    ok("Try now and Re-file answer; every new route refuses another brokerage");

    const calls0 = stubCalls;
    await call("GET", "/api/deals/D1/coverage-board");
    await call("GET", `/api/deals/D1/coverage-board?sittingId=${sid}`);
    assert.equal(stubCalls, calls0);
    assert.equal(counters.modelCalls, 0);
    ok("GET coverage-board calls no model");
    void store;
  } finally {
    server.close();
  }
  console.log(`\n${n} route checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
