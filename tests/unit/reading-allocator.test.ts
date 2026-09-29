/**
 * The reading allocator (shared/reading-allocator.ts): how each second on
 * screen becomes reading time per page part. Pure, no DOM.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/reading-allocator.test.ts
 */
import assert from "node:assert/strict";
import {
  ReadingAllocator, activityState, exclusiveAreas, readFactor, ACTIVITY_RULES, ALLOCATOR_RULES,
  type Frame, type Rect,
} from "../../shared/reading-allocator";
import { READING_RULES } from "../../shared/analytics-v2";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}
const R = (top: number, bottom: number, left = 0, right = 800): Rect => ({ top, bottom, left, right });
const band = R(60, 720);            // under a 60 px header, to 80% of a 900 px viewport
const frame = (over: Partial<Frame>): Frame => ({ state: "active", band, pages: [], blocks: [], scrollDelta: 0, pointer: null, ...over });
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const invariant = (a: ReadingAllocator) => {
  const c = a.clocks;
  assert.ok(near(a.creditedMs() + c.outsideMs, c.activeMs), `Σ(attention+skim)+outside ${a.creditedMs() + c.outsideMs} ≠ active ${c.activeMs}`);
  assert.ok(c.activeMs <= c.wallMs + 1e-6, "active ≤ wall");
  assert.ok(near(c.activeMs + c.idleMs + c.hiddenMs + c.awayMs, c.wallMs), "wall = active + idle + hidden + away");
};
const at = (a: ReadingAllocator, page: string, key: string) => a.blocks.get(`${page}|${key}`) ?? [0, 0, 0, 0];

console.log("allocator");

test("one part filling the band gets the whole second", () => {
  const a = new ReadingAllocator(["p1"]);
  a.tick(1000, frame({ pages: [{ pageId: "p1", rect: R(0, 2000) }], blocks: [{ pageId: "p1", key: "row:0", rect: R(0, 2000) }] }));
  assert.equal(at(a, "p1", "row:0")[0], 1000);
  assert.equal(at(a, "p1", "")[0], 0, "no page remainder");
  invariant(a);
});

test("a tall block (taller than the screen) gets reading AND visible time", () => {
  const a = new ReadingAllocator(["p1"]);
  for (let i = 0; i < 30; i++) {
    a.tick(1000, frame({ pages: [{ pageId: "p1", rect: R(-3000, 4000) }], blocks: [{ pageId: "p1", key: "row:0", rect: R(-3000, 4000) }], scrollDelta: 40 }));
  }
  assert.ok(at(a, "p1", "row:0")[0] >= 29_000, "credited");
  assert.equal(at(a, "p1", "row:0")[2], 30_000, "visible: it fills the band");
  invariant(a);
});

test("nested parts credit the innermost; the container keeps only its own area; the page keeps the rest", () => {
  const f = frame({
    pages: [{ pageId: "p", rect: R(0, 1000) }],
    blocks: [
      { pageId: "p", key: "left", rect: R(100, 700, 0, 400) },
      { pageId: "p", key: "left/para:0", rect: R(100, 400, 0, 400) },
      { pageId: "p", key: "right", rect: R(100, 700, 400, 800) },
      { pageId: "p", key: "right/chart", rect: R(100, 700, 400, 800) },
    ],
  });
  const areas = exclusiveAreas(f, band);
  assert.equal(areas.get("p|left/para:0"), 300 * 400);
  assert.equal(areas.get("p|left"), 300 * 400, "the left column's own area below its paragraph");
  assert.equal(areas.get("p|right/chart"), 600 * 400);
  assert.equal(areas.get("p|right"), undefined, "fully covered by its chart");
  assert.equal(areas.get("p|"), (660 - 600) * 800, "the page's band area outside every part");
  const a = new ReadingAllocator(["p"]);
  a.tick(1000, f);
  const total = [...a.blocks.values()].reduce((s, c) => s + c[0], 0);
  assert.ok(near(total, 1000));
  assert.ok(at(a, "p", "right/chart")[0] > at(a, "p", "left/para:0")[0], "the taller chart gets more");
  invariant(a);
});

test("side-by-side columns split the second by width", () => {
  const a = new ReadingAllocator(["p"]);
  a.tick(1000, frame({
    pages: [{ pageId: "p", rect: R(0, 1000) }],
    blocks: [{ pageId: "p", key: "left", rect: R(0, 1000, 0, 200) }, { pageId: "p", key: "right", rect: R(0, 1000, 200, 800) }],
  }));
  assert.ok(near(at(a, "p", "left")[0], 250));
  assert.ok(near(at(a, "p", "right")[0], 750));
  invariant(a);
});

test("hidden, idle and away seconds credit nothing", () => {
  const a = new ReadingAllocator(["p"]);
  const f = { pages: [{ pageId: "p", rect: R(0, 1000) }], blocks: [{ pageId: "p", key: "para:0", rect: R(0, 1000) }] };
  a.tick(1000, frame({ ...f, state: "hidden" }));
  a.tick(1000, frame({ ...f, state: "idle" }));
  a.tick(1000, frame({ ...f, state: "away" }));
  assert.equal(a.creditedMs(), 0);
  assert.deepEqual([a.clocks.hiddenMs, a.clocks.idleMs, a.clocks.awayMs, a.clocks.activeMs, a.clocks.wallMs], [1000, 1000, 1000, 0, 3000]);
  invariant(a);
});

test("no band, a short band or a band with little CIM is 'outside'", () => {
  const a = new ReadingAllocator(["p"]);
  a.tick(1000, frame({ band: null }));
  a.tick(1000, frame({ band: R(600, 650) }));
  a.tick(1000, frame({ pages: [{ pageId: "p", rect: R(640, 720) }] })); // the last sliver of the CIM above the decision panel
  assert.equal(a.clocks.outsideMs, 3000);
  assert.equal(a.creditedMs(), 0);
  invariant(a);
});

test("skim maths: fast scrolling is mostly skim", () => {
  const h = 660;
  assert.equal(readFactor(0, h, 1000), 1);
  assert.equal(readFactor(h * 0.59, h, 1000), 1);
  assert.equal(readFactor(h, h, 1000), 0.6);
  assert.equal(readFactor(h * 2, h, 1000), 0.25);
  const a = new ReadingAllocator(["p"]);
  const f = { pages: [{ pageId: "p", rect: R(0, 1000) }], blocks: [{ pageId: "p", key: "para:0", rect: R(0, 1000) }] };
  a.tick(1000, frame({ ...f, scrollDelta: h * 2 }));
  const c = at(a, "p", "para:0");
  assert.ok(near(c[0], 250) && near(c[1], 750), JSON.stringify(c));
  invariant(a);
});

test("the pointer pulls 30% onto its part and its hover time is kept (chart points too)", () => {
  const a = new ReadingAllocator(["p"]);
  a.tick(1000, frame({
    pages: [{ pageId: "p", rect: R(0, 1000) }],
    blocks: [{ pageId: "p", key: "para:0", rect: R(0, 390) }, { pageId: "p", key: "chart", rect: R(390, 1000) }],
    pointer: { pageId: "p", key: "chart", pointKey: "chart/point:2" },
  }));
  const para = at(a, "p", "para:0")[0];
  const chart = at(a, "p", "chart")[0];
  assert.ok(near(para + chart, 1000));
  assert.ok(near(para, 0.7 * 1000 * (330 / 660)), `para ${para}`);
  assert.equal(at(a, "p", "chart/point:2")[3], 1000, "pointer time on the datum");
  assert.equal(at(a, "p", "chart/point:2")[0], 0, "no attention on a virtual point");
  invariant(a);
});

test("path: the dominant page enters after holding 2 s; the furthest page is kept", () => {
  const a = new ReadingAllocator(["cover", "p1", "p2", "p3"]);
  const on = (id: string) => frame({ pages: [{ pageId: id, rect: R(0, 1000) }] });
  a.tick(1000, on("cover"));
  a.tick(1000, on("cover"));
  a.tick(1000, on("p1"));            // held 1 s only
  a.tick(1000, on("p3"));
  a.tick(1000, on("p3"));
  a.tick(1000, on("p3"));
  assert.deepEqual(a.path, [[0, "cover"], [3, "p3"]]);
  assert.equal(a.maxPageIndex, 3);
  assert.equal(a.currentPageId(), "p3");
  invariant(a);
});

test("snapshot → restore continues the visit exactly", () => {
  const a = new ReadingAllocator(["p"]);
  const f = frame({ pages: [{ pageId: "p", rect: R(0, 1000) }], blocks: [{ pageId: "p", key: "row:1", rect: R(0, 1000) }] });
  for (let i = 0; i < 5; i++) a.tick(1000, f);
  const b = new ReadingAllocator(["p"], JSON.parse(JSON.stringify(a.snapshot())));
  b.tick(1000, f);
  assert.equal(at(b, "p", "row:1")[0], 6000);
  assert.equal(b.clocks.activeMs, 6000);
  invariant(b);
});

test("a tick never credits more than 2 s; a visit stops after 6 h", () => {
  const a = new ReadingAllocator(["p"]);
  a.tick(60_000, frame({ pages: [{ pageId: "p", rect: R(0, 1000) }] }));
  assert.equal(a.clocks.activeMs, ALLOCATOR_RULES.maxTickMs);
  a.clocks.wallMs = READING_RULES.visitMaxMs;
  a.tick(1000, frame({ pages: [{ pageId: "p", rect: R(0, 1000) }] }));
  assert.equal(a.clocks.activeMs, ALLOCATOR_RULES.maxTickMs);
});

test("random frames keep the invariant", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const a = new ReadingAllocator(["a", "b", "c"]);
  const states = ["active", "active", "active", "idle", "hidden", "away"] as const;
  for (let i = 0; i < 2000; i++) {
    const top = rnd() * 2000 - 1000;
    a.tick(rnd() * 2500, frame({
      state: states[Math.floor(rnd() * states.length)],
      band: rnd() < 0.1 ? null : R(rnd() * 100, 500 + rnd() * 300),
      pages: [{ pageId: "a", rect: R(top, top + 900) }, { pageId: "b", rect: R(top + 900, top + 2500) }],
      blocks: [
        { pageId: "a", key: "row:0", rect: R(top + 10, top + 300) },
        { pageId: "a", key: "left", rect: R(top + 300, top + 800, 0, 400) },
        { pageId: "a", key: "left/para:0", rect: R(top + 300, top + 500, 0, 400) },
        { pageId: "b", key: "chart", rect: R(top + 950, top + 1400) },
      ],
      scrollDelta: rnd() * 2000,
      pointer: rnd() < 0.3 ? { pageId: "a", key: "row:0" } : null,
    }));
  }
  invariant(a);
  for (const c of a.blocks.values()) for (const x of c) assert.ok(x >= 0);
});

console.log("activity + tab election");
const base = { now: 100_000, visible: true, focused: true, lastInputAt: 99_000, lastPointerAt: 99_000, idleLimitMs: ACTIVITY_RULES.idleMs, peers: [] };
test("hidden, idle and active", () => {
  assert.equal(activityState({ ...base, visible: false }), "hidden");
  assert.equal(activityState({ ...base, lastInputAt: 100_000 - 61_000 }), "idle");
  assert.equal(activityState({ ...base, lastInputAt: 100_000 - 61_000, idleLimitMs: ACTIVITY_RULES.idleLongMs }), "active", "a long table earns 90 s");
  assert.equal(activityState(base), "active");
});
test("an unfocused window counts only while the pointer moves over it", () => {
  assert.equal(activityState({ ...base, focused: false, lastPointerAt: 100_000 - 11_000 }), "away");
  assert.equal(activityState({ ...base, focused: false, lastPointerAt: 99_500 }), "active");
});
test("two tabs never both count", () => {
  // Tab A focused, tab B (another window) being pointed at right now.
  const aSees = activityState({ ...base, focused: true, lastPointerAt: 90_000, peers: [{ at: 99_900, focused: false, pointerAt: 99_800 }] });
  const bSees = activityState({ ...base, focused: false, lastPointerAt: 99_800, peers: [{ at: 99_900, focused: true, pointerAt: 90_000 }] });
  assert.deepEqual([aSees, bSees], ["away", "active"]);
  // Tab A focused and in use; tab B visible but untouched.
  const a2 = activityState({ ...base, focused: true, lastPointerAt: 99_900, peers: [{ at: 99_900, focused: false, pointerAt: 50_000 }] });
  const b2 = activityState({ ...base, focused: false, lastPointerAt: 50_000, peers: [{ at: 99_900, focused: true, pointerAt: 99_900 }] });
  assert.deepEqual([a2, b2], ["active", "away"]);
  // A stale peer is ignored.
  assert.equal(activityState({ ...base, lastPointerAt: 90_000, peers: [{ at: 90_000, focused: false, pointerAt: 90_000 }] }), "active");
});

console.log(`\n${passed} passed`);
