/**
 * Interview together — the notetaker's state on the board (§4.5): the
 * server asks Recall (a stub here — no Recall call) and pushes `listen`
 * events when it changes: joining → waiting room → in the call; a minute
 * of silence while recording; removed from the meeting; stops for an ended
 * sitting or another bot.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/together/notetaker.test.ts
 */
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

async function main() {
  const { _setTogetherStoreForTests, memoryTogetherStore } = await import("../../server/together/store");
  const { _setRecallForTests, watchNotetaker, pollNotetaker, notetakerStateOf, notetakerHeard, NOTETAKER_POLL_RECORDING_MS } = await import("../../server/together/notetaker");
  const hub = await import("../../server/together/hub");
  const mem = memoryTogetherStore();
  _setTogetherStoreForTests(mem);
  const s = await mem.insertSitting({ dealId: "D", brokerId: "B", via: "zoom", captureEnv: "local", botId: "bot-1", consentAt: new Date() });
  let code = "joining_call";
  let sub: string | null = null;
  let calls = 0;
  _setRecallForTests({ getBot: async () => { calls++; return { status_changes: [{ code, sub_code: sub }] }; } });

  const t0 = Date.now();
  watchNotetaker(s.id, "bot-1");
  assert.equal(notetakerStateOf(s.id), "notetaker_joining");
  code = "in_waiting_room";
  assert.equal(await pollNotetaker(s.id, t0 + 6_000), "notetaker_waiting_room");
  const st = hub.stateSince(s.id, 0);
  assert.ok(st.events.some((e) => e.type === "listen" && (e as any).state === "notetaker_waiting_room"), "pushed to every tab");
  code = "in_call_recording";
  assert.equal(await pollNotetaker(s.id, t0 + 12_000), "notetaker_live");
  const before = calls;
  await pollNotetaker(s.id, t0 + 13_000);
  assert.equal(calls, before, "while recording, Recall is asked every 30 s, not every 5 s");
  // A minute without a line while recording.
  await mem.updateSitting(s.id, { lastLineAt: new Date(t0 + 12_000) });
  assert.equal(await pollNotetaker(s.id, t0 + 12_000 + 61_000), "notetaker_silent");
  notetakerHeard(s.id, "bot-1");
  assert.equal(notetakerStateOf(s.id), "notetaker_live", "a line brings it back");
  notetakerHeard(s.id, "bot-other");
  assert.equal(notetakerStateOf(s.id), "notetaker_live", "another bot changes nothing");
  code = "call_ended";
  sub = "bot_kicked_from_call";
  assert.equal(await pollNotetaker(s.id, t0 + 12_000 + 61_000 + NOTETAKER_POLL_RECORDING_MS), "notetaker_removed");
  assert.equal(notetakerStateOf(s.id), null, "a final state stops the watch");
  // An ended sitting stops it at once.
  watchNotetaker(s.id, "bot-1");
  await mem.updateSitting(s.id, { status: "ended" });
  assert.equal(await pollNotetaker(s.id, Date.now() + 10_000), null);
  console.log("✓ notetaker: joining → waiting room → in the call; silence after a minute; removed; stops when the sitting ends");
  console.log("\n1 checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
