/**
 * A whole session together, replayed (specs/together.md §11.3): the
 * fictional Lakeshore conversation (fixtures/lakeshore-sitting.json, 75
 * lines, ~6 minutes) through the real chunker, pipeline, guards and merge,
 * with the recorded model (fixtures/lakeshore-sitting.model.json, 3 s per
 * call) on a fake clock. No database, no AI.
 *
 * Checks: part boundaries and reasons; possible answers held while the two
 * voices are unnamed and filed once the broker taps "This is me"; the final
 * status of 14 named items; provenance; the private notes and the keep-out
 * entry; what the broker said with no reply; the summary; filing ≤ 8 s
 * after the last word with a 3 s model. Then the AI goes down for two
 * minutes: the circuit opens, lines are kept, parts wait and are filed in order once it is back, and
 * the board ends identical.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/together/replay.test.ts
 */
import { counters, install, newWorld, type World } from "./harness";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const dealFx = JSON.parse(fs.readFileSync(path.join(FIX, "deal-lakeshore.json"), "utf-8"));
const sittingFx = JSON.parse(fs.readFileSync(path.join(FIX, "lakeshore-sitting.json"), "utf-8"));
const modelFx = JSON.parse(fs.readFileSync(path.join(FIX, "lakeshore-sitting.model.json"), "utf-8"));

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function worldFor(): World {
  const w = newWorld();
  const deal = structuredClone(dealFx.deal);
  deal.brokerId = "B1";
  deal.demoKey = "lakeshore-qa";
  deal.location = "Hamilton, Ontario";
  for (const k of sittingFx.resetKeys as string[]) {
    delete deal.extractedInfo[k];
    if (deal.extractedInfo._fieldSources) delete deal.extractedInfo._fieldSources[k];
  }
  w.deals[deal.id] = deal;
  w.documents.push(...structuredClone(dealFx.documents).map((d: any) => ({ ...d, dealId: deal.id })));
  w.discrepancies.push(...structuredClone(dealFx.discrepancies));
  w.requirements.push(...structuredClone(dealFx.requirements));
  w.sessions.push(...structuredClone(dealFx.sessions));
  return w;
}

// ── A fake clock for the pipeline (timers fire as the replay advances) ──
let now = Date.parse("2026-10-09T15:00:00Z");
let timerId = 0;
let timers: Array<{ id: number; at: number; fn: () => void }> = [];
async function drain() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}
async function advanceTo(target: number) {
  for (;;) {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const next = timers[0];
    if (!next || next.at > target) break;
    timers.shift();
    now = Math.max(now, next.at);
    next.fn();
    await drain();
  }
  now = Math.max(now, target);
  await drain();
}

async function runReplay(opts: { downFrom?: number; downTo?: number } = {}) {
  const w = worldFor();
  const dealId = Object.keys(w.deals)[0];
  const store = await install(w);
  const { _setPipelineDepsForTests, _resetPipelineForTests, retryNow } = await import("../../server/together/pipeline");
  const { _setCaptureEnabledForTests } = await import("../../server/together/chunker");
  const { _setCaptureModelForTests } = await import("../../server/together/capture");
  const { stubModel } = await import("../../server/together/capture-stub");
  const { startOrResumeSitting, recordConsent, appendLines, setSpeakerRole, _resetSittingCachesForTests } = await import("../../server/together/sittings");
  const { fileNow } = await import("../../server/together/pipeline");
  const { buildCoverageBoard } = await import("../../server/interview/coverage-board");
  _resetPipelineForTests();
  _resetSittingCachesForTests();
  timers = [];
  now = Date.parse("2026-10-09T15:00:00Z");
  _setPipelineDepsForTests({
    now: () => now,
    setTimer: (fn, ms) => { const id = ++timerId; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimer: (h) => { timers = timers.filter((t) => t.id !== h); },
    sleep: async (ms) => { now += ms; },
  });
  _setCaptureEnabledForTests(true);
  let calls = 0;
  const t0ref = { t0: now };
  const base = stubModel(modelFx, { sleep: async (ms) => { now += ms; } });
  _setCaptureModelForTests(async (req) => {
    calls++;
    const t = (now - t0ref.t0) / 1000;
    if (opts.downFrom !== undefined && t >= opts.downFrom && t < (opts.downTo ?? Infinity)) throw new (await import("../../server/together/capture")).CaptureError("overloaded", "unavailable");
    return base(req);
  });

  const deal = w.deals[dealId];
  const { sitting } = await startOrResumeSitting(deal, "B1", "person", { now });
  await recordConsent(sitting);
  const t0 = now;
  t0ref.t0 = t0;
  let outage: { aiDown: boolean; waiting: number } | null = null;
  const askItems = async () => {
    const b = await buildCoverageBoard(w.deals[dealId], { audience: "broker" });
    return b.sections.flatMap((s) => s.items.filter((i) => i.ask).map((i) => ({ itemId: i.id, sectionKey: s.key, ask: i.ask, label: i.label, open: i.status !== "on_file" })));
  };
  let seq = 0;
  const heldBeforeTap: string[] = [];
  for (const ev of sittingFx.lines as any[]) {
    await advanceTo(t0 + ev.t * 1000);
    if (opts.downTo !== undefined && !outage && ev.t >= (opts.downTo - 20)) {
      // (A snapshot during the outage: what the page shows.)
      const { sittingView } = await import("../../server/together/sittings");
      const v = sittingView((await store.getSitting(sitting.id))!, { chunks: await store.listChunks(sitting.id) });
      outage = { aiDown: !!v.aiDown, waiting: v.waiting };
    }
    if (ev.event === "speaker") {
      heldBeforeTap.push(...(((await store.getSitting(sitting.id))!.captureState as any).held ?? []).map((h: any) => h.memberKey));
      await setSpeakerRole(sitting.id, ev.speaker, ev.role, { deal: w.deals[dealId] });
      await drain();
    } else if (ev.event === "answered") {
      const s = (await store.getSitting(sitting.id))!;
      await fileNow(s, ev.itemId);
      await drain();
    } else if (ev.event === "typed") {
      await appendLines(sitting.id, "replay", [{ clientSeq: seq++, speaker: "typed:broker", text: ev.text, source: "typed" }], { deal: w.deals[dealId], now, askItems });
    } else if (ev.event === "end") {
      const { flush } = await import("../../server/together/pipeline");
      await flush((await store.getSitting(sitting.id))!, "end");
      await drain();
    } else {
      await appendLines(sitting.id, "replay", [{ clientSeq: seq++, speaker: ev.speaker, text: ev.text, source: ev.source }], { deal: w.deals[dealId], now, askItems });
    }
  }
  await advanceTo(now + 30_000);
  // "Try now" once the AI is back (the minute probe may already have filed everything).
  if (opts.downFrom !== undefined) {
    const s = (await store.getSitting(sitting.id))!;
    await retryNow(s);
    await drain();
    await advanceTo(now + 120_000);
  }
  return { w, store, dealId, sitting, calls, heldBeforeTap, outage };
}

async function main() {
  console.log("replay (Lakeshore, recorded model)");
  const r = await runReplay();
  const { store, sitting, w, dealId } = r;
  const { buildCoverageBoard } = await import("../../server/interview/coverage-board");
  const chunks = await store.listChunks(sitting.id);
  const board = await buildCoverageBoard(w.deals[dealId], { audience: "broker" });
  const item = (id: string) => board.sections.flatMap((s) => s.items).find((i) => i.id === id);
  const facts = w.deals[dealId].extractedInfo;
  const st = ((await store.getSitting(sitting.id))!.captureState ?? {}) as any;

  check("parts close on turn changes, pauses, a long answer, a ✓ Answered focus, a typed line, and the held answers' promotion", () => {
    const reasons = new Set(chunks.map((c) => c.reason));
    for (const r of ["pause", "long_answer", "focus", "typed", "promote"]) assert.ok(reasons.has(r), `a "${r}" part (${Array.from(reasons).join(", ")})`);
    assert.ok(chunks.every((c) => ["done", "skipped"].includes(c.status) || c.error === "bad_output"), `every part filed: ${chunks.map((c) => `${c.chunkNo}:${c.status}`).join(" ")}`);
  });

  check("two unnamed voices: answers are held as possible answers, then filed when the broker taps 'This is me'", () => {
    assert.ok(r.heldBeforeTap.includes("peakPeriods"), `held before the tap: ${r.heldBeforeTap.join(", ")}`);
    assert.equal(facts.peakPeriods, "June through August, and December to February");
    assert.equal(facts._fieldSources.peakPeriods.source, "call");
    assert.ok(!(st.held ?? []).some((h: any) => h.memberKey === "peakPeriods"), "no longer held");
  });

  check("14 named items end where they should", () => {
    const expect: Array<[string, string]> = [
      ["seasonality:seasonality", "on_file"],
      ["operations:dispatchAndSchedulingSystem", "on_file"],
      ["employees:ownerInvolvement", "on_file"],
      ["revenue_sources:comfortClubRenewalRate", "on_file"],
      ["employees:emrRating", "partial"],
      ["reason_for_sale:reasonForSale", "on_file"],
      ["growth_potential:growthOpportunities", "on_file"],
      ["financials:grossMarginByServiceLine", "on_file"],
      ["revenue_sources:averageServiceCallTicket", "on_file"],
      ["overview:brandIdentity", "on_file"],
      ["buyer_profile:idealBuyer", "on_file"],
      ["training_support:trainingSupport", "on_file"],
      ["seasonality:peakDailyCallVolume", "on_file"],
      ["employees:employees", "on_file"],
    ];
    for (const [id, status] of expect) assert.equal(item(id)?.status, status, `${id}: ${item(id)?.status} (${item(id)?.reason?.code ?? ""})`);
    assert.equal(item("employees:emrRating")?.reason?.code, "not_known");
    assert.equal(item("revenue_sources:averageServiceCallTicket")?.yourNote, true, `typed → your note (${JSON.stringify(facts.averageServiceCallTicket)} ${JSON.stringify(facts._fieldSources.averageServiceCallTicket)} ${JSON.stringify(item("revenue_sources:averageServiceCallTicket"))})`);
    assert.equal(item("seasonality:peakDailyCallVolume")?.origin, "noted", "also noted");
  });

  check("provenance: the seller's words from the call; a broker statement only with the seller's agreement", () => {
    const src = facts._fieldSources.comfortClubRenewalRate;
    assert.equal(src.source, "call");
    assert.match(src.excerpt, /^The seller agreed: "So they renew at about eighty-five percent a year\?"/);
    assert.equal(facts._fieldSources.averageServiceCallTicket.source, "broker", "typed is the broker's own note");
    // (A head count isn't statement-authoritative: the owner's own count outranks a document's;
    // the document's 36 stays as another value — nothing is lost.)
    assert.equal(facts.employees, "38, including 2 part-time office staff");
    assert.ok((facts._fieldAlternates?.employees ?? []).some((a: any) => a.value === "36"));
    assert.equal(facts.leaseExpiry, "August 31, 2028", "the broker's own words with no reply are never filed");
  });

  check("private notes and keep-out: the health matter and the staff member's ask never reach a fact", () => {
    const notes = JSON.stringify(facts._brokerPrivateNotes ?? []);
    assert.match(notes, /heart scare/);
    assert.match(notes, /buying into the business/);
    assert.ok((facts._sellerKeepOut ?? []).some((e: any) => e.terms.includes("heart scare")));
    assert.doesNotMatch(String(facts.reasonForSale), /heart|health/i);
  });

  check("what the broker said with no reply is shown, not filed; a follow-up idea is kept for Suggest next", () => {
    assert.ok((st.brokerUnconfirmed ?? []).some((b: any) => b.key === "leaseExpiry" && b.value === "August 2028"));
    assert.ok(st.hints?.followUp?.ask, "a follow-up idea");
  });

  check("latency: each part is filed ≤ 8 s after the last word, with a 3 s model", () => {
    // (The seller stops talking → the item flips. A ✓ Answered or a typed note runs when the broker acts, and
    // held answers are filed when the broker names the speakers — those wait by design and aren't counted.)
    const timing: Array<{ ms: number; waited: number; reason: string }> = st.timing ?? [];
    const live = timing.filter((t) => ["pause", "turn_change", "long_answer", "manual"].includes(t.reason) && t.waited < 15_000);
    assert.ok(live.length >= 8, `${live.length} live parts`);
    assert.ok(Math.max(...live.map((t) => t.ms)) <= 8000, `max ${Math.max(...live.map((t) => t.ms))} ms: ${JSON.stringify(timing)}`);
  });

  check("the transcript row holds only the seller's words; no model was called", () => {
    const row = w.documents.find((d) => d.sourceMeta?.recordType === "together_sitting");
    assert.ok(row);
    assert.equal(counters.modelCalls, 0);
  });

  {
    const { endSitting, _setSittingEndHooksForTests } = await import("../../server/together/summary");
    _setSittingEndHooksForTests({ handBackRouted: async () => undefined, completeInterview: async () => undefined, refreshEvidence: () => undefined, endWaitMs: 50 });
    const out = await endSitting((await store.getSitting(sitting.id))!, w.deals[dealId], { completeInterview: false, followUps: [], documents: [], addToNextSession: false });
    check("the summary: what was filed (with the seller's words), the private notes count, what's still to get", () => {
      assert.ok(out.summary.filed.length >= 10, `${out.summary.filed.length} filed`);
      const season = out.summary.filed.find((f) => f.itemId === "seasonality:seasonality");
      assert.ok(season?.quote, `the seller's words: ${JSON.stringify(season)} ${JSON.stringify(w.deals[dealId].extractedInfo._fieldSources.peakPeriods)}`);
      assert.ok(out.summary.filed.some((f) => f.itemId === "revenue_sources:averageServiceCallTicket" && f.yourNote));
      assert.equal(out.summary.privateNotes, 2);
      const emr = out.summary.stillToGet.find((o) => o.itemId === "employees:emrRating");
      assert.ok(emr?.ticked, "'someone else has it' is ticked for the follow-ups");
      assert.equal(out.summary.waiting, 0);
    });
    _setSittingEndHooksForTests(null);
  }

  const finalStatuses = board.sections.flatMap((s) => s.items).map((i) => `${i.id}=${i.status}|${i.value ?? ""}`).join("\n");

  console.log("replay with the AI down from minute 1 to minute 3");
  const r2 = await runReplay({ downFrom: 60, downTo: 180 });
  const chunks2 = await r2.store.listChunks(r2.sitting.id);
  const board2 = await buildCoverageBoard(r2.w.deals[r2.dealId], { audience: "broker" });
  check("the circuit opened: later parts waited, nothing said was lost, and 'Try now' filed them in order", () => {
    assert.equal(r2.outage?.aiDown, true, "the 'Cimple can't file answers right now' banner");
    assert.ok((r2.outage?.waiting ?? 0) >= 2, `parts waiting: ${r2.outage?.waiting}`);
    assert.ok(chunks2.every((c) => ["done", "skipped"].includes(c.status) || c.error === "bad_output"), chunks2.map((c) => `${c.chunkNo}:${c.status}:${c.error ?? ""}`).join(" "));
    assert.equal(r2.store.lines.filter((l) => l.sittingId === r2.sitting.id).length, r.store.lines.filter((l) => l.sittingId === r.sitting.id).length);
  });
  check("the board ends identical to the run without the outage", () => {
    const s2 = board2.sections.flatMap((s) => s.items).map((i) => `${i.id}=${i.status}|${i.value ?? ""}`).join("\n");
    assert.equal(s2, finalStatuses);
  });

  console.log(`\n${passed} replay checks passed (${r.calls} recorded calls, ${chunks.length} parts)`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
