/**
 * Drawing a CIM held from buyers (heat-map spec §5.3): servedCimFor returns
 * nothing for buyers while an update waits with nothing served, and only
 * broker-side code passing { ignoreHold: true } reads the CIM as buyers will
 * get it. The view room never passes it. No DB (reads past the hold fail on
 * the dummy database and are caught), no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled node_modules/.bin/tsx tests/unit/engagement-ignore-hold.test.ts
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { servedCimFor } from "../../server/analytics/renditions";
import { liveRendition, _resetLiveRenditionMemo } from "../../server/engagement/legacy";
import { storage } from "../../server/storage";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

const held = {
  id: "deal-held", businessName: "Beacon", isLive: false, brokerId: null, cimLayoutVersion: 3,
  cimGeneration: { buyerHold: { since: "2026-09-28T00:00:00Z", wasLive: true, buyers: 12, ddCleared: false } },
} as any;
let reads = 0;
(storage as any).getCimSectionsByDeal = async () => { reads++; return []; };
(storage as any).getCimSectionOverrides = async () => { reads++; return []; };

(async () => {
  console.log("ignoreHold");
  await test("held from buyers: nothing is served, and the CIM isn't even read", async () => {
    reads = 0;
    assert.equal(await servedCimFor(held, "full"), null);
    assert.equal(reads, 0);
  });
  await test("broker side with ignoreHold: the CIM is read as buyers will get it", async () => {
    reads = 0;
    await servedCimFor(held, "full", { ignoreHold: true }).catch(() => null);
    assert.ok(reads > 0, "it went past the hold");
  });
  await test("liveRendition passes it through, and a failed build is not remembered", async () => {
    _resetLiveRenditionMemo();
    reads = 0;
    assert.equal(await liveRendition(held, "full", new Date(), { ignoreHold: false }), null);
    assert.equal(reads, 0);
    await liveRendition(held, "full", new Date(), { ignoreHold: true });
    const first = reads;
    assert.ok(first > 0);
    await liveRendition(held, "full", new Date(), { ignoreHold: true });
    assert.ok(reads > first, "an empty result is rebuilt next time, not cached");
  });
  await test("only broker-side code and scripts pass ignoreHold (never the view room)", () => {
    const routes = fs.readFileSync(path.join(ROOT, "server/routes.ts"), "utf8");
    assert.doesNotMatch(routes, /ignoreHold/);
    const callers = ["server/engagement/facts.ts", "server/routes/engagement.ts"];
    for (const f of callers) assert.match(fs.readFileSync(path.join(ROOT, f), "utf8"), /ignoreHold: true/, f);
  });
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
