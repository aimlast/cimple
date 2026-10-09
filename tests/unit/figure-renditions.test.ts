/**
 * One path for the figure layer to every buyer surface (INTEGRATION §2.2):
 * the view route's content branch and servedCimFor both take their extras
 * from buyerCimExtras(), so the heat map draws the same DD pages (the check
 * page included) the view room recorded; the layer is never on the NDA,
 * holding or "updating" branches; a dropped blind layer is logged, never
 * passed to the re-redaction.
 *   npx tsx tests/unit/figure-renditions.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, test } from "./helpers/figure-test";
import { buyerCimExtras } from "../../server/cim/buyer-extras";
import { TEASER_ACCESS_LEVEL } from "../../shared/access-levels";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

test("the view route and servedCimFor both build with buyerCimExtras", () => {
  const routes = src("server/routes.ts");
  const view = routes.slice(routes.indexOf('app.get("/api/view/:token"'), routes.indexOf('app.get("/api/view/:token/buyer-profile"'));
  assert.match(view, /buyerCimExtras\(servedDeal, access\.accessLevel, access\.id\)/);
  // Both extras (gl's evidence, dd's figures) reach buildBuyerCim — spread whole (INTEGRATION §2.2).
  assert.match(view, /buildBuyerCim\(\{[^}]*\.\.\.extras \}\)/);
  assert.match(view, /figureLayer: buyerCim\.figureLayer/);
  // figureLayer only on the content branch (the last res.json of the route).
  assert.equal((view.match(/figureLayer:/g) ?? []).length, 1);
  assert.ok(!/redoLeakedBlind\([^)]*figureLayerDropped/.test(view));
  const renditions = src("server/analytics/renditions.ts");
  assert.match(renditions, /buyerCimExtras\(servedDeal, accessLevel, opts\.accessId \?\? null\)/);
  assert.match(renditions, /buildBuyerCim\(\{[^}]*\.\.\.extras \}\)/);
});

test("a teaser link gets no extras", async () => {
  const extras = await buyerCimExtras({ id: "d" } as any, TEASER_ACCESS_LEVEL, null);
  assert.deepEqual(extras, { glEvidence: null, figures: null });
});

await run("figure-renditions");
