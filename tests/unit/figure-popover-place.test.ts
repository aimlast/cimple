/**
 * The figure popover never opens under the view room's sticky bars (checker
 * r2 R2-6): its top collision padding clears every [data-reading-chrome] bar
 * pinned at the top of the window (header + section strip), and it scrolls
 * inside the room Radix finds rather than clipping its title. Pure (a stub
 * document); the screenshots check the real thing.
 *   npx tsx tests/unit/figure-popover-place.test.ts
 */
import "./react-global";
import assert from "node:assert/strict";
import { run, test } from "./helpers/figure-test";
import { FIGURE_POPOVER_FIT, figurePopoverPadding } from "../../client/src/components/cim/figures/figurePaint";

function withBars(bars: Array<{ top: number; bottom: number }>, fn: () => void) {
  const prev = (globalThis as any).document;
  (globalThis as any).document = {
    querySelectorAll: (sel: string) => (sel === "[data-reading-chrome]" ? bars.map((b) => ({ getBoundingClientRect: () => ({ top: b.top, bottom: b.bottom, height: b.bottom - b.top }) })) : []),
  };
  try { fn(); } finally { (globalThis as any).document = prev; }
}

test("no sticky bars (the broker's builder): 12 px all round", () => {
  withBars([], () => assert.deepEqual(figurePopoverPadding(), { top: 12, right: 12, bottom: 12, left: 12 }));
});

test("the view room: below the 60 px header and the 31 px section strip", () => {
  withBars([{ top: 0, bottom: 60 }, { top: 60, bottom: 91 }], () => assert.equal(figurePopoverPadding().top, 99));
  withBars([{ top: 0, bottom: 60 }], () => assert.equal(figurePopoverPadding().top, 68));
});

test("a bar scrolled away or not shown yet doesn't count", () => {
  withBars([{ top: -60, bottom: 0 }, { top: 400, bottom: 400 }], () => assert.equal(figurePopoverPadding().top, 12));
});

test("the popover scrolls inside the room it has (its title never clipped)", () => {
  assert.match(FIGURE_POPOVER_FIT, /max-h-\[var\(--radix-popover-content-available-height\)\]/);
  assert.match(FIGURE_POPOVER_FIT, /overflow-y-auto/);
});

await run("figure-popover-place");
