/**
 * Live filing after a restart (specs/together.md §5.10, §11.2): exactly
 * once, without the AI, only for this kind of process's sittings, never
 * under another process's lease — and nothing at all where live filing
 * doesn't run.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/together/recovery.test.ts
 */
import { counters, install, lakeshoreDeal, newWorld, statementDoc } from "./harness";
import assert from "node:assert/strict";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const w = newWorld();
  w.deals.D1 = lakeshoreDeal();
  w.documents.push(statementDoc());
  const store = await install(w);
  const { recoverLiveSittings, retryWaitingChunks } = await import("../../server/together/recovery");
  const { _setCaptureEnabledForTests, BOOT_ID } = await import("../../server/together/chunker");
  const { _setCaptureModelForTests } = await import("../../server/together/capture");
  const { _resetPipelineForTests, _setPipelineDepsForTests, waitForIdle } = await import("../../server/together/pipeline");
  _setPipelineDepsForTests({ sleep: async () => undefined });
  const { isApplied, markApplied } = await import("../../server/together/capture-apply");
  // Any extraction call fails the test: recovery files from saved parts only.
  let extractions = 0;
  _setCaptureModelForTests(async () => { extractions++; throw new Error("test: the extraction model was called"); });

  const guardedSeasonality = {
    guarded: {
      spoken: [{ key: "seasonality", itemId: "seasonality:seasonality", value: "Busy June–August", quote: "busy June through August", excerpt: "busy June through August", lines: [1], speaker: "seller", confidence: "confirmed" }],
      typed: [], suggestions: [], brokerUnconfirmed: [], notKnown: [], privateNotes: [], keepOut: [], retractions: [], otherFacts: [], dropped: [], followUp: null, topicSections: [],
    },
    sellerLabel: "Tony Moretti (seller)",
  };
  const mk = async (captureEnv: string, extra: Record<string, unknown> = {}) =>
    store.insertSitting({ dealId: "D1", brokerId: "B1", via: "person", status: "live", startedAt: new Date(), lastLineAt: new Date(), speakers: { "dg:1": { role: "seller", by: "broker" } }, captureEnv, captureState: {}, ...extra } as any);

  console.log("recovery");

  await test("nothing runs where live filing doesn't (the scheduler gate and captureEnabled)", async () => {
    _setCaptureEnabledForTests(false);
    const s = await mk("local");
    await store.insertChunk({ sittingId: s.id, dealId: "D1", seqFrom: 1, seqTo: 1, reason: "pause", status: "running", attempts: 1 });
    const r = await recoverLiveSittings();
    assert.equal(r.sittings, 0);
    assert.equal(await retryWaitingChunks(), 0);
    assert.equal((await store.listChunks(s.id))[0].status, "running", "untouched");
    await store.updateSitting(s.id, { status: "ended" });
    await store.updateChunk((await store.listChunks(s.id))[0].id, { status: "done" });
  });

  _setCaptureEnabledForTests(true);

  await test("a production process never touches a local test server's sitting (and the other way round)", async () => {
    const s = await mk("production");
    const c = await store.insertChunk({ sittingId: s.id, dealId: "D1", seqFrom: 1, seqTo: 1, reason: "pause", status: "running", attempts: 1 });
    await recoverLiveSittings();
    assert.equal((await store.getChunk(c.id))!.status, "running");
    await store.updateSitting(s.id, { status: "ended" });
    await store.updateChunk(c.id, { status: "done" });
  });

  await test("a sitting another live process holds is left alone", async () => {
    const s = await mk("local", { captureOwner: "p-other", captureLeaseUntil: new Date(Date.now() + 60_000) });
    const c = await store.insertChunk({ sittingId: s.id, dealId: "D1", seqFrom: 1, seqTo: 1, reason: "pause", status: "running", attempts: 1 });
    const r = await recoverLiveSittings();
    assert.ok(r.skippedLease >= 1);
    assert.equal((await store.getChunk(c.id))!.status, "running");
    await store.updateSitting(s.id, { status: "ended", captureOwner: null, captureLeaseUntil: null });
    await store.updateChunk(c.id, { status: "done" });
  });

  await test("applying, already applied (marker saved with the facts) → done; applying with its saved delta → filed once, no AI; running without a delta → queued", async () => {
    _resetPipelineForTests();
    const s = await mk("local", { captureOwner: "p-dead", captureLeaseUntil: new Date(Date.now() - 1000) });
    await store.insertLines([{ sittingId: s.id, dealId: "D1", seq: 1, speaker: "dg:1", text: "We're busy June through August.", source: "deepgram", clientId: "x", clientSeq: 1, at: new Date() } as any]);
    await store.updateSitting(s.id, { lineSeq: 1 });
    const applied = await store.insertChunk({ sittingId: s.id, dealId: "D1", seqFrom: 1, seqTo: 1, reason: "pause", status: "applying", attempts: 1, delta: guardedSeasonality as any });
    const info = structuredClone(w.deals.D1.extractedInfo);
    markApplied(info, s.id, applied.chunkNo);
    w.deals.D1.extractedInfo = info;
    const pending = await store.insertChunk({ sittingId: s.id, dealId: "D1", seqFrom: 1, seqTo: 1, reason: "pause", status: "applying", attempts: 1, delta: guardedSeasonality as any });
    const running = await store.insertChunk({ sittingId: s.id, dealId: "D1", seqFrom: 1, seqTo: 1, reason: "manual", status: "running", attempts: 1 });
    const r = await recoverLiveSittings();
    assert.equal(r.markedDone, 1);
    assert.equal(r.reapplied, 1);
    assert.equal(r.requeued, 1);
    assert.equal((await store.getChunk(applied.id))!.status, "done");
    await new Promise((res) => setTimeout(res, 50));
    await waitForIdle(s.id, 500);
    assert.equal((await store.getChunk(pending.id))!.status, "done", "re-applied from its saved delta");
    assert.equal(w.deals.D1.extractedInfo.seasonality, "Busy June–August");
    assert.ok(isApplied(w.deals.D1.extractedInfo, s.id, pending.chunkNo));
    // The re-queued one tried the AI (the throwing seam): it waits, nothing filed twice.
    assert.ok(["failed", "waiting", "queued"].includes((await store.getChunk(running.id))!.status));
    // Recovery again: nothing is applied twice.
    const before = JSON.stringify(w.deals.D1.extractedInfo);
    await store.updateChunk(pending.id, { status: "applying" });
    await store.updateSitting(s.id, { captureOwner: null, captureLeaseUntil: null });
    const r2 = await recoverLiveSittings();
    assert.ok(r2.markedDone >= 1);
    assert.equal(JSON.stringify(w.deals.D1.extractedInfo), before, "applied once, never twice");
    assert.equal((await store.getSitting(s.id))!.captureOwner, BOOT_ID, "this process holds the lease now");
  });

  await test("a live sitting quiet for more than 15 minutes is paused and its backlog filed", async () => {
    _resetPipelineForTests();
    const old = new Date(Date.now() - 20 * 60_000);
    const s = await mk("local", { startedAt: old, lastLineAt: old, lineSeq: 3 });
    const r = await recoverLiveSittings();
    assert.ok(r.paused >= 1);
    assert.equal((await store.getSitting(s.id))!.status, "paused");
    assert.ok((await store.listChunks(s.id)).some((c) => c.reason === "backlog"));
  });

  void extractions;
  assert.equal(counters.modelCalls, 0);
  console.log(`\n${passed} recovery checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
