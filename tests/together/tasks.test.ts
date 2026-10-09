/**
 * The seller's look-up to-dos after a session together (checker r2 R2-7) —
 * real routes and pipeline, a stubbed model, in memory (no database, no AI):
 *  - an answer the seller gives aloud closes the interview's open follow-up
 *    for that data point (or another member of the same item);
 *  - a DOCUMENT request stays open (only the document closes it), the
 *    broker's own follow-ups and counsel checks are never closed by it;
 *  - the broker's typed note never closes one;
 *  - Undo of the filing reopens what it closed.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/together/tasks.test.ts
 */
import { counters, install, lakeshoreDeal, newWorld, statementDoc, waitFor } from "./harness";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";

async function main() {
  const w = newWorld();
  w.deals.D1 = lakeshoreDeal();
  w.documents.push(statementDoc());
  const task = (id: string, over: Record<string, unknown>) => ({ id, dealId: "D1", type: "follow_up", title: id, description: "", status: "pending", createdBy: "ai_interview", createdAt: new Date(), ...over });
  w.tasks.push(
    task("T-owner", { title: "Ask Denise what the owner does each week", relatedField: "ownerInvolvement" }),
    task("T-peak", { title: "Get the busy months from Denise", relatedField: "peakPeriods" }),
    task("T-doc", { type: "document_request", title: "Upload the seasonality report", relatedField: "seasonality" }),
    task("T-broker", { title: "Check the owner's week myself", relatedField: "ownerInvolvement", createdBy: "B1" }),
    task("T-counsel", { title: "Verify with counsel: owner's non-compete", relatedField: "ownerInvolvement" }),
    task("T-typed", { title: "Get the brand story from Denise", relatedField: "brandIdentity" }),
  );
  const store: any = await install(w);
  const { registerTogetherRoutes } = await import("../../server/routes/together");
  const { _setCaptureEnabledForTests } = await import("../../server/together/chunker");
  const { _setCaptureModelForTests } = await import("../../server/together/capture");
  const { stubModel } = await import("../../server/together/capture-stub");
  const { _setPipelineDepsForTests } = await import("../../server/together/pipeline");
  _setCaptureEnabledForTests(true);
  _setPipelineDepsForTests({ sleep: async () => undefined });
  _setCaptureModelForTests(stubModel({ entries: [
    { match: "three days a week", output: { answers: [{ key: "ownerInvolvement", value: "In the office three days a week", quote: "I'm in three days a week", speaker: "seller", confidence: "confirmed", basis: "verbatim" }] } },
    { match: "Summer is crazy", output: { answers: [{ key: "seasonality", value: "Busiest in summer", quote: "Summer is crazy", speaker: "seller", confidence: "confirmed", basis: "verbatim" }] } },
  ] }) as any);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, next: any) => { req.session = { brokerId: "B1" }; next(); });
  registerTogetherRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (m: string, p: string, b?: unknown) => {
    const r = await fetch(url + p, { method: m, headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const status = (id: string) => w.tasks.find((t) => t.id === id)!.status;
  let n = 0;
  const ok = (name: string) => { n++; console.log("  ✓", name); };
  try {
    const PAGE = "55555555-eeee-4eee-8eee-000000000005";
    const sid = (await call("POST", "/api/deals/D1/together/sittings", { via: "person" })).json.sitting.id;
    await call("POST", `/api/deals/D1/together/sittings/${sid}/consent`, {});
    await call("POST", `/api/deals/D1/together/sittings/${sid}/lines`, { clientId: PAGE, lines: [
      { clientSeq: 1, speaker: "dg:0", text: "What do you do yourself in a normal week?", source: "deepgram" },
      { clientSeq: 2, speaker: "dg:1", text: "I'm in three days a week, mostly quoting.", source: "deepgram" },
    ] });
    await call("POST", `/api/deals/D1/together/sittings/${sid}/speakers`, { speaker: "dg:0", role: "broker" });
    await call("POST", `/api/deals/D1/together/sittings/${sid}/file-now`, {});
    await waitFor(() => w.deals.D1.extractedInfo.ownerInvolvement !== undefined, 4000, "owner involvement filed");
    await waitFor(() => status("T-owner") === "completed", 4000, "the follow-up closed");
    assert.equal(status("T-broker"), "pending", "the broker's own follow-up stays");
    assert.equal(status("T-counsel"), "pending", "a counsel check is never closed by an answer");
    ok("an answer said aloud closes the interview's follow-up for it — never the broker's own, never a counsel check");

    await call("POST", `/api/deals/D1/together/sittings/${sid}/lines`, { clientId: PAGE, lines: [
      { clientSeq: 3, speaker: "dg:0", text: "Which months are your busiest?", source: "deepgram" },
      { clientSeq: 4, speaker: "dg:1", text: "Summer is crazy, June through August.", source: "deepgram" },
    ] });
    await call("POST", `/api/deals/D1/together/sittings/${sid}/file-now`, {});
    await waitFor(() => w.deals.D1.extractedInfo.seasonality !== undefined, 4000, "seasonality filed");
    await waitFor(() => status("T-peak") === "completed", 4000, "the same item's follow-up closed");
    assert.equal(status("T-doc"), "pending", "a document request stays open until the document is on file");
    ok("another member of the same item closes its follow-up; a document request stays open");

    const typed = await call("POST", "/api/deals/D1/coverage-board/items/overview:brandIdentity/answer", { sittingId: sid, mode: "note", memberKey: "brandIdentity", value: "Known locally for same-day emergency service" });
    assert.equal(typed.status, 200, JSON.stringify(typed.json));
    assert.equal(w.deals.D1.extractedInfo.brandIdentity, "Known locally for same-day emergency service");
    assert.equal(status("T-typed"), "pending", "the broker's typed note never closes the seller's to-do");
    ok("the broker's typed note never closes one");

    const part = (await store.listChunks(sid)).find((c: any) => (c.result?.filed ?? []).some((f: any) => f.key === "ownerInvolvement"));
    assert.deepEqual(part.result.tasksClosed, [{ key: "ownerInvolvement", taskId: "T-owner" }]);
    const undo = await call("POST", `/api/deals/D1/together/sittings/${sid}/captures/${part.id}/undo`, { key: "ownerInvolvement" });
    assert.equal(undo.status, 200);
    assert.equal(status("T-owner"), "pending", "Undo reopens it");
    ok("Undo of the filing reopens the to-do it closed");
    assert.equal(counters.modelCalls, 0);
  } finally {
    server.close();
  }
  console.log(`\n${n} to-do checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
