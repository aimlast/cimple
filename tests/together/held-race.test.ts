/**
 * A role choice that lands while a part is with the model (specs/together.md
 * D6, §5.6): the part was read with both voices unnamed, so its answers come
 * back as "possible answers"; the broker has meanwhile said who's who — the
 * answers are filed at once (no AI), never left held. Also: a promotion asked
 * for twice at once files an answer once.
 * A real Express app, in-memory storage, a recorded model held at a gate,
 * blocked outbound fetches.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/together/held-race.test.ts
 */
import { counters, install, lakeshoreDeal, newWorld, statementDoc, waitFor } from "./harness";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";

async function main() {
  const w = newWorld();
  w.deals.D1 = lakeshoreDeal();
  w.documents.push(statementDoc());
  const store = await install(w);
  const { registerTogetherRoutes } = await import("../../server/routes/together");
  const { _setCaptureEnabledForTests } = await import("../../server/together/chunker");
  const { _setCaptureModelForTests } = await import("../../server/together/capture");
  const { stubModel } = await import("../../server/together/capture-stub");
  const { _setPipelineDepsForTests, promoteHeldAnswers } = await import("../../server/together/pipeline");
  _setCaptureEnabledForTests(true);
  _setPipelineDepsForTests({ sleep: async () => undefined });

  // The model answers only when the test opens the gate.
  let openGate: () => void = () => undefined;
  let gate = new Promise<void>((r) => { openGate = r; });
  let inModel = false;
  let modelCalls = 0;
  const base = stubModel({
    entries: [
      { match: "April and October are dead", output: { answers: [{ key: "slowPeriods", value: "April and October are the quiet months", quote: "April and October are dead", speaker: "seller", confidence: "confirmed", basis: "verbatim" }], topicSections: ["seasonality"] } },
      { match: "Denise runs dispatch", output: { answers: [{ key: "employeeStructure", value: "Denise runs dispatch", quote: "Denise runs dispatch", speaker: "seller", confidence: "confirmed", basis: "verbatim" }] } },
    ],
  });
  _setCaptureModelForTests(async (req) => {
    modelCalls++;
    if (req.lines.some((l: any) => /April|dispatch/.test(l.text))) {
      inModel = true;
      await gate;
      inModel = false;
    }
    return base(req);
  });

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { brokerId: req.get("x-test-broker") || undefined }; next(); });
  registerTogetherRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(url + p, { method, headers: { "content-type": "application/json", "x-test-broker": "B1" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, json, text };
  };
  const PAGE = "44444444-dddd-4ddd-8ddd-000000000004";
  let n = 0;
  const ok = (name: string) => { n++; console.log("✓", name); };
  const held = async (sid: string) => (((await store.getSitting(sid))!.captureState ?? {}) as any).held ?? [];

  try {
    const start = await call("POST", "/api/deals/D1/together/sittings", { via: "person" });
    const sid = start.json.sitting.id;
    await call("POST", `/api/deals/D1/together/sittings/${sid}/consent`, {});
    // An earlier part already went to the model (one voice so far — nothing waits for names).
    await call("POST", `/api/deals/D1/together/sittings/${sid}/lines`, { clientId: PAGE, lines: [
      { clientSeq: 1, speaker: "dg:1", text: "We started out of my garage in 1998.", source: "deepgram" },
    ] });
    await call("POST", `/api/deals/D1/together/sittings/${sid}/file-now`, {});
    await waitFor(async () => (await store.listChunks(sid)).every((c: any) => c.status === "done" || c.status === "skipped"), 4000, "the first part");
    assert.equal(modelCalls, 1);
    // Two voices now, neither named yet (one question isn't enough to tell who's asking).
    await call("POST", `/api/deals/D1/together/sittings/${sid}/lines`, { clientId: PAGE, lines: [
      { clientSeq: 2, speaker: "dg:0", text: "And the slow part of the year?", source: "deepgram" },
      { clientSeq: 3, speaker: "dg:1", text: "April and October are dead, honestly.", source: "deepgram" },
    ] });
    const roles0 = (await store.getSitting(sid))!.speakers as any;
    assert.ok(!roles0?.["dg:1"] || roles0["dg:1"].role !== "seller", "the seller isn't known yet");
    // The part goes to the model…
    const fileNow = await call("POST", `/api/deals/D1/together/sittings/${sid}/file-now`, {});
    assert.equal(fileNow.status, 200, fileNow.text);
    await waitFor(() => inModel, 4000, "the part to reach the model");
    // …and while it's there, the broker says "this is me".
    const me = await call("POST", `/api/deals/D1/together/sittings/${sid}/speakers`, { speaker: "dg:0", role: "broker" });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.sitting.speakers["dg:1"].role, "seller", "the other voice is the seller");
    // The model answers (read with the voices unnamed → held), then the re-check files it.
    openGate();
    await waitFor(() => w.deals.D1.extractedInfo.slowPeriods !== undefined, 4000, "the seller's answer to be filed");
    assert.equal(w.deals.D1.extractedInfo.slowPeriods, "April and October are the quiet months");
    assert.equal(w.deals.D1.extractedInfo._fieldSources.slowPeriods.sittingId, sid);
    await waitFor(async () => (await held(sid)).length === 0, 4000, "nothing left held");
    assert.equal(modelCalls, 2, "promoting calls no model");
    ok("a role choice made while the part was with the model → its answers are filed, not left as possible answers");

    // Twice at once (a role choice and a finished part both ask): filed once.
    gate = new Promise<void>((r) => { openGate = r; });
    const s2 = await call("POST", "/api/deals/D1/together/sittings", { via: "cimple" });
    const sid2 = s2.json.sitting.id;
    assert.notEqual(sid2, sid);
    await call("POST", `/api/deals/D1/together/sittings/${sid2}/consent`, {});
    await call("POST", `/api/deals/D1/together/sittings/${sid2}/lines`, { clientId: PAGE, lines: [
      { clientSeq: 1, speaker: "room", text: "Who keeps dispatch running.", source: "browser" },
      { clientSeq: 2, speaker: "room", text: "Denise runs dispatch on our software.", source: "browser" },
    ] });
    await call("POST", `/api/deals/D1/together/sittings/${sid2}/file-now`, {});
    openGate();
    await waitFor(async () => (await held(sid2)).length === 1, 4000, "a possible answer (one shared microphone)");
    assert.equal(w.deals.D1.extractedInfo.employeeStructure, undefined);
    const lineSeqs: number[] = (await held(sid2))[0].lines;
    await store.attestLines(sid2, lineSeqs, new Date());
    const sit2 = (await store.getSitting(sid2))!;
    const chunksBefore = (await store.listChunks(sid2)).length;
    const [a, b] = await Promise.all([promoteHeldAnswers(sit2), promoteHeldAnswers(sit2)]);
    assert.equal(a.filed + b.filed, 1, "filed once");
    assert.equal((await store.listChunks(sid2)).length, chunksBefore + 1, "one promoted part");
    assert.equal(w.deals.D1.extractedInfo.employeeStructure, "Denise runs dispatch");
    ok("two promotions at once file a held answer once");

    assert.equal(counters.modelCalls, 0, "no real model");
  } finally {
    server.close();
  }
  console.log(`\n${n} held-answer checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
