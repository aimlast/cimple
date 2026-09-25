/**
 * CIM chart axis/tooltip formatting — no database, no AI.
 *   npx tsx tests/unit/chart-format.test.ts
 * Ticks must be short enough for the axis column ("$2.2M", never ",200,000").
 */
import assert from "node:assert/strict";
import { axisWidthFor, formatAxisTick, formatFullValue } from "../../client/src/components/cim/renderers/chartFormat";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

test("compact ticks per unit", () => {
  assert.equal(formatAxisTick(2200000, "$"), "$2.2M");
  assert.equal(formatAxisTick(800000, "CAD"), "C$800K");
  assert.equal(formatAxisTick(38000, "currency"), "$38K");
  assert.equal(formatAxisTick(64, "%"), "64%");
  assert.equal(formatAxisTick(6.85, "$M"), "$6.85M");
  assert.equal(formatAxisTick(1650000), "1.7M");
  assert.equal(formatAxisTick(-250000, "$"), "-$250K");
  assert.equal(formatAxisTick(1200, "patients"), "1.2K");
});

test("full tooltip values", () => {
  assert.equal(formatFullValue(2013000, "$"), "$2,013,000");
  assert.equal(formatFullValue(22.2, "%"), "22.2%");
  assert.equal(formatFullValue(1200, "patients"), "1,200 patients");
});

test("axis width fits the longest tick", () => {
  const w = axisWidthFor([1750000, 1894000, 2013000], "$");
  assert.ok(w >= 48 && w <= 104, String(w));
  assert.ok(axisWidthFor([1, 2, 3]) >= 48);
});

console.log(`\n${passed} checks passed`);
