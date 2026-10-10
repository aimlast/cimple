/**
 * The chunker (specs/together.md §5.3, §11.1): when a part of the
 * conversation is closed and filed. Pure, with a fake clock.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/together/chunker.test.ts
 */
import assert from "node:assert/strict";
import {
  answerWordsOf,
  budgetState,
  captureEnabled,
  decideChunk,
  focusRange,
  initialChunkerState,
  isTurnChange,
  type ChunkerLine,
  type ChunkerState,
  type ChunkClose,
} from "../../server/together/chunker";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

let seq = 0;
const L = (role: ChunkerLine["role"], text: string, at: number, typed = false): ChunkerLine => ({ seq: ++seq, role, typed, text, at });

/** Feeds events; returns the closes and the final state. */
function run(events: Array<{ at: number; line?: ChunkerLine; timer?: true; manual?: true; end?: true; focus?: string }>, start: ChunkerState = initialChunkerState()) {
  let state = start;
  const closes: ChunkClose[] = [];
  let lastTimer: number | null = null;
  let reread: string | null = null;
  for (const e of events) {
    const d = e.line ? decideChunk(state, { type: "line", line: e.line }, e.at)
      : e.timer ? decideChunk(state, { type: "timer" }, e.at)
        : e.manual ? decideChunk(state, { type: "manual" }, e.at)
          : e.end ? decideChunk(state, { type: "end" }, e.at)
            : decideChunk(state, { type: "focus", itemId: e.focus! }, e.at);
    state = d.state;
    closes.push(...d.close);
    lastTimer = d.armTimerMs;
    if (d.reread) reread = d.reread.focusItemId;
  }
  return { state, closes, lastTimer, reread };
}

console.log("chunker");

test("a turn change closes BEFORE the broker's next question; the next part starts with it", () => {
  seq = 0;
  const q1 = L("broker", "So what are the busy times of year for you?", 0);
  const a1 = L("seller", "Summer and the cold snaps are crazy, June through August.", 1000);
  const q2 = L("broker", "And how many trucks are in the fleet?", 3000);
  const r = run([{ at: 0, line: q1 }, { at: 1000, line: a1 }, { at: 3000, line: q2 }]);
  assert.equal(r.closes.length, 1);
  assert.deepEqual([r.closes[0].fromSeq, r.closes[0].toSeq, r.closes[0].reason], [q1.seq, a1.seq, "turn_change"]);
  assert.equal(r.state.open?.fromSeq, q2.seq);
});

test("back-channels never close a part", () => {
  seq = 0;
  const r = run([
    { at: 0, line: L("broker", "What's prompting the sale now?", 0) },
    { at: 500, line: L("seller", "I'm sixty-four and my knees are done with attics.", 500) },
    { at: 900, line: L("broker", "Mm-hmm.", 900) },
    { at: 1200, line: L("broker", "Right.", 1200) },
    { at: 1500, line: L("seller", "And my kids don't want it.", 1500) },
  ]);
  assert.equal(r.closes.length, 0);
  assert.ok(!isTurnChange("okay") && !isTurnChange("got it") && isTurnChange("And the lease?"));
});

test("a 2.5 s pause after a seller line closes; a bare 'Yes.' after a question counts", () => {
  seq = 0;
  const r = run([
    { at: 0, line: L("broker", "Do you own the building?", 0) },
    { at: 800, line: L("seller", "Yes.", 800) },
    { at: 3299, timer: true },
  ]);
  assert.equal(r.closes.length, 0, "not before 2.5 s");
  const r2 = decideChunk(r.state, { type: "timer" }, 3300);
  assert.equal(r2.close.length, 1);
  assert.equal(r2.close[0].reason, "pause");
});

test("no pause close while the broker is the last to speak (waiting for an answer)", () => {
  seq = 0;
  const r = run([
    { at: 0, line: L("seller", "We do about four hundred service calls a month in winter.", 0) },
    { at: 500, line: L("broker", "uh", 500) },
    { at: 10_000, timer: true },
  ]);
  assert.equal(r.closes.length, 0);
});

test("thinking aloud is not an answer word", () => {
  assert.equal(answerWordsOf({ role: "seller", typed: false, text: "Hmm, let me think." }), 0);
  assert.ok(answerWordsOf({ role: "seller", typed: false, text: "About forty customers." }) > 0);
  assert.equal(answerWordsOf({ role: "broker", typed: false, text: "About forty customers." }), 0);
  assert.ok(answerWordsOf({ role: "unknown", typed: false, text: "About forty customers." }) > 0);
});

test("a long answer splits at 60 s, and at 350 answer words", () => {
  seq = 0;
  const ev: Array<{ at: number; line: ChunkerLine }> = [];
  for (let i = 0; i < 7; i++) ev.push({ at: i * 10_000, line: L("seller", "We started in a garage and grew it slowly with referrals from contractors.", i * 10_000) });
  const r = run(ev);
  assert.equal(r.closes.length, 1);
  assert.equal(r.closes[0].reason, "long_answer");
  seq = 0;
  const long = "word ".repeat(360).trim();
  const r2 = run([{ at: 0, line: L("seller", long, 0) }]);
  assert.equal(r2.closes[0]?.reason, "long_answer");
});

test("'Save this answer now' and the end close whatever is open (≥ 1 answer word)", () => {
  seq = 0;
  const r = run([{ at: 0, line: L("broker", "What's your busiest month?", 0) }, { at: 100, manual: true }]);
  assert.equal(r.closes.length, 0, "a question alone is not filed");
  const r2 = run([{ at: 0, line: L("seller", "July for sure.", 0) }, { at: 100, manual: true }]);
  assert.equal(r2.closes[0].reason, "manual");
  const r3 = run([{ at: 0, line: L("seller", "July for sure.", 0) }, { at: 100, end: true }]);
  assert.equal(r3.closes[0].reason, "end");
});

test("✓ Answered closes the open part for that item; with nothing open it asks for a re-read", () => {
  seq = 0;
  const r = run([{ at: 0, line: L("seller", "Gross margin is about forty percent on service.", 0) }, { at: 100, focus: "financials:grossProfit" }]);
  assert.equal(r.closes[0].reason, "focus");
  assert.equal(r.closes[0].focusItemId, "financials:grossProfit");
  const r2 = run([{ at: 0, focus: "financials:grossProfit" }]);
  assert.equal(r2.closes.length, 0);
  assert.equal(r2.reread, "financials:grossProfit");
});

test("focus re-read: the seller's lines since the item was asked, ≤ 3 minutes and 400 words", () => {
  seq = 0;
  const lines = [
    L("seller", "Old answer about something else entirely.", 0),
    L("broker", "And the gross margin?", 200_000),
    L("seller", "Around forty percent on service, less on installs.", 205_000),
  ];
  const r = focusRange(lines, { now: 210_000, askedSeq: lines[1].seq });
  // (From the broker's question on — the question gives the answer its meaning.)
  assert.deepEqual(r, { fromSeq: lines[1].seq, toSeq: lines[2].seq });
  assert.equal(focusRange([L("broker", "Anything?", 0)], { now: 1000 }), null, "no seller words → nothing to file");
  const old = focusRange([L("seller", "Way back answer.", 0)], { now: 400_000 });
  assert.equal(old, null, "older than 3 minutes");
});

test("typed lines are their own part; the open part is untouched", () => {
  seq = 0;
  const a = L("seller", "We have twenty-two trucks.", 0);
  const t = L("broker", "22 trucks in the fleet", 500, true);
  const r = run([{ at: 0, line: a }, { at: 500, line: t }]);
  assert.equal(r.closes.length, 1);
  assert.deepEqual([r.closes[0].fromSeq, r.closes[0].toSeq, r.closes[0].reason], [t.seq, t.seq, "typed"]);
  assert.equal(r.state.open?.fromSeq, a.seq);
});

test("a broker talking on keeps only the last 12 lines in the part", () => {
  seq = 0;
  const ev = Array.from({ length: 20 }, (_, i) => ({ at: i * 100, line: L("broker", `Line ${i} of my long preamble here.`, i * 100) }));
  const r = run(ev);
  assert.equal(r.closes.length, 0);
  assert.equal(r.state.open!.toSeq - r.state.open!.fromSeq + 1, 12);
});

test("a long session (soft cap) closes only every 2 minutes; past the hard cap nothing closes live", () => {
  seq = 0;
  const start: ChunkerState = { ...initialChunkerState(), throttleMs: 120_000, lastCloseAt: 0 };
  const r = run([
    { at: 1_000, line: L("broker", "What do you do day to day?", 1_000) },
    { at: 2_000, line: L("seller", "I run the dispatch board and do quotes.", 2_000) },
    { at: 5_000, timer: true },
    { at: 6_000, line: L("broker", "And how many hours a week is that?", 6_000) },
  ], start);
  assert.equal(r.closes.length, 0, "throttled");
  assert.ok((r.lastTimer ?? 0) >= 100_000, "next look is at the throttle's end");
  const later = decideChunk(r.state, { type: "timer" }, 121_000);
  assert.equal(later.close.length, 1, "at the 2-minute mark the part is filed");
  const held: ChunkerState = { ...initialChunkerState(), held: true };
  const r2 = run([{ at: 0, line: L("seller", "Lots of answer words here for sure.", 0) }, { at: 70_000, timer: true }], held);
  assert.equal(r2.closes.length, 0);
  const end = decideChunk(r2.state, { type: "end" }, 80_000);
  assert.equal(end.close[0].reason, "end", "the rest is filed at the end");
  assert.deepEqual(budgetState(90, 90), { throttleMs: 120_000, held: false });
  assert.deepEqual(budgetState(10, 400), { throttleMs: 0, held: true });
});

test("captureEnabled: production only, or a local replay with the key off and a stub", () => {
  assert.equal(captureEnabled({ NODE_ENV: "production" } as any).ok, true);
  assert.equal(captureEnabled({ NODE_ENV: "development" } as any).ok, false);
  assert.equal(captureEnabled({ NODE_ENV: "development", TOGETHER_CAPTURE: "on", ANTHROPIC_API_KEY: "sk-real" } as any).ok, false);
  assert.equal(captureEnabled({ NODE_ENV: "development", TOGETHER_CAPTURE: "on", ANTHROPIC_API_KEY: "disabled" } as any).ok, false);
  assert.equal(captureEnabled({ NODE_ENV: "development", TOGETHER_CAPTURE: "on", ANTHROPIC_API_KEY: "disabled", TOGETHER_CAPTURE_STUB: "/x.json" } as any).ok, true);
});

console.log(`\n${passed} chunker checks passed`);
