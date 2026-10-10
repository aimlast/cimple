/**
 * Client pieces of the October 2026 access levels: the CIM builder's
 * ?preview= values (blind | full-cim | due-diligence; older teaser | full |
 * loi links keep working and never open a named preview by mistake) and the
 * Buyers tab's next-step words ("Next: wants to make an offer (LOI)" — the
 * buyer's own step, never the raw "loi"). No DOM needed.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/access-level-client.test.ts
 */
import assert from "node:assert/strict";
import "./react-global";
import { PREVIEW_PARAM, previewFromParam } from "../../client/src/components/cim-builder/CimCanvas";
import { nextStepWords } from "../../client/src/components/deal/buyers/HaveCimStage";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

console.log("builder preview links");

test("the new ?preview= values", () => {
  assert.deepEqual(PREVIEW_PARAM, { blind: "blind", named: "full-cim", due_diligence: "due-diligence" });
  assert.equal(previewFromParam("blind"), "blind");
  assert.equal(previewFromParam("full-cim"), "named");
  assert.equal(previewFromParam("due-diligence"), "due_diligence");
  for (const [k, v] of Object.entries(PREVIEW_PARAM)) assert.equal(previewFromParam(v), k, "round trip");
});

test("older links keep working with their old meaning: teaser/full → Blind CIM, loi → Full CIM", () => {
  assert.equal(previewFromParam("teaser"), "blind");
  assert.equal(previewFromParam("full"), "blind", "an old 'full' link never opens the named preview");
  assert.equal(previewFromParam("loi"), "named");
  assert.equal(previewFromParam("named"), "named");
  assert.equal(previewFromParam("due_diligence"), "due_diligence");
});

test("anything else opens the editor (the teaser has its own preview)", () => {
  for (const p of [null, undefined, "", "editor", "teaser_only", "junk"]) assert.equal(previewFromParam(p as any), "editor", String(p));
});

console.log("next-step words");

test("the buyer's next step in words, never the raw value", () => {
  assert.equal(nextStepWords("loi"), "wants to make an offer (LOI)");
  assert.equal(nextStepWords("seller_call"), "wants a call with the seller");
  assert.equal(nextStepWords("site_visit"), "wants a site visit");
  assert.equal(nextStepWords("something_new"), "something new");
});

console.log(`\n${passed} passed`);
