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
  assert.equal(formatAxisTick(-250000, "$"), "-$250K");
  assert.equal(formatAxisTick(1200, "patients"), "1.2K");
  assert.equal(formatAxisTick(0, "$"), "$0");
  assert.equal(formatAxisTick(45, "% of Revenue"), "45%");
});

test("ticks never round a gridline to a different number", () => {
  assert.equal(formatAxisTick(1650000), "1.65M");
  assert.equal(formatAxisTick(1050000, "$"), "$1.05M");
  assert.equal(formatAxisTick(1125000, "$"), "$1.125M");
  assert.equal(formatAxisTick(2000000, "$"), "$2M");
  assert.equal(formatAxisTick(2500000, "CAD"), "C$2.5M");
  assert.equal(formatAxisTick(999999.9999, "$"), "$1M");
  assert.equal(formatAxisTick(12.5, "%"), "12.5%");
});

test("values already in thousands or millions keep their real size", () => {
  // Sample template chart: unit "$K", 4640 = $4.64M (never "4.6K").
  assert.equal(formatAxisTick(4640, "$K"), "$4.64M");
  assert.equal(formatAxisTick(8000, "$K"), "$8M");
  assert.equal(formatAxisTick(690, "$K"), "$690K");
  assert.equal(formatAxisTick(1500, "CAD (000s)"), "C$1.5M");
  assert.equal(formatAxisTick(1500, "$000s"), "$1.5M");
  assert.equal(formatAxisTick(250, "thousands"), "250K");
  assert.equal(formatAxisTick(6.85, "USD millions"), "$6.85M");
  assert.equal(formatAxisTick(1.2, "$B"), "$1.2B");
  assert.equal(formatAxisTick(0.5, "$M"), "$500K");
});

test("full tooltip values", () => {
  assert.equal(formatFullValue(2013000, "$"), "$2,013,000");
  assert.equal(formatFullValue(22.2, "%"), "22.2%");
  assert.equal(formatFullValue(22.2, "% of Revenue"), "22.2% of Revenue");
  assert.equal(formatFullValue(1200, "patients"), "1,200 patients");
  assert.equal(formatFullValue(1.85, "$M"), "$1.85M");
  assert.equal(formatFullValue(4640, "$K"), "$4.64M");
  assert.equal(formatFullValue(690, "$K"), "$690K");
  assert.equal(formatFullValue(-120000, "CAD"), "-C$120,000");
});

test("axis width fits the longest tick", () => {
  const w = axisWidthFor([1750000, 1894000, 2013000], "$");
  assert.ok(w >= 48 && w <= 104, String(w));
  assert.ok(axisWidthFor([1, 2, 3]) >= 48);
});

console.log(`\n${passed} checks passed`);
