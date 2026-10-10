/**
 * A buyer's question about a figure goes straight to the broker (spec D18).
 * No DB, no AI.
 *   npx tsx tests/unit/figure-question.test.ts
 *
 *   - a figure id this buyer was served → "About Revenue, FY2023: …" (no AI;
 *     the route saves it pending_broker);
 *   - a Blind buyer: "About a figure on page N: …", and a named (Full CIM) id
 *     doesn't resolve in their layer (they can't probe named figures);
 *   - an unknown or malformed id → the normal question flow (null);
 *   - the prefilled prefix is never written twice.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureRaw, noteRow, run, test } from "./helpers/figure-test";
import { figureInputsFor } from "../../server/cim/figures/serve";
import { figureIdOf, figureQuestionText } from "../../server/cim/figures/ask";
import { buildFigureLayer } from "../../shared/figure-layer";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const NOTE = noteRow({
  id: "n-rev", figureKey: "revenue|2023", kind: "movement", compareKey: "2022", status: "approved",
  text: "Up $660,000 (11%) from FY2022, mostly HVAC equipment replacement & installation (+$290,000).",
  blindText: "Up $660,000 (11%) from FY2022, mostly from three revenue streams.",
  valuesSnapshot: { year: "2023", value: 6840000, fromYear: "2022", fromValue: 6180000 },
});

async function layers() {
  const { fx, raw } = await fixtureRaw("lakeshore", { notes: [NOTE] });
  const named = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "normal" }), "normal")!;
  const blind = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "blind" }), "blind")!;
  return { fx, named, blind };
}

test("figure ids: only f_ + 10 hex", () => {
  assert.equal(figureIdOf({ figureId: "f_0123456789" }), "f_0123456789");
  for (const bad of ["revenue|2023", "f_123", "F_0123456789", 12, null, "f_0123456789x"]) assert.equal(figureIdOf({ figureId: bad }), null, String(bad));
  assert.equal(figureIdOf(null), null);
});

test("a figure this buyer was served → 'About Revenue, FY2023: …' (prefix never doubled)", async () => {
  const { fx, named } = await layers();
  const id = Object.entries(named.figures).find(([, f]) => f.label === "Revenue" && f.year === "2023")![0];
  assert.match(id, /^f_[0-9a-f]{10}$/);
  assert.equal(figureQuestionText(named, fx.sections, id, "What drove the growth?", 1000), "About Revenue, FY2023: What drove the growth?");
  assert.equal(figureQuestionText(named, fx.sections, id, "About Revenue, FY2023: What drove the growth?", 1000), "About Revenue, FY2023: What drove the growth?");
  assert.equal(figureQuestionText(named, fx.sections, id, "x".repeat(2000), 1000)!.length, 1000);
});

test("Blind: 'About a figure on page N'; named labels never appear", async () => {
  const { fx, blind } = await layers();
  const [id] = Object.keys(blind.figures);
  assert.ok(id);
  const text = figureQuestionText(blind, fx.sections, id, "Why the jump?", 1000)!;
  assert.match(text, /^About a figure on page \d+: Why the jump\?$/);
  assert.ok(!/Revenue/.test(text));
});

test("ids are opaque per deal and figure; an unknown id falls back to the normal flow", async () => {
  const { fx, named, blind } = await layers();
  // The same figure has the same opaque id in both versions (HMAC of deal + figure)…
  const namedId = Object.entries(named.figures).find(([, f]) => f.label === "Revenue" && f.year === "2023")![0];
  // …so a Blind buyer resolving it gets only their own blind wording and page number, never the label.
  const viaBlind = figureQuestionText(blind, fx.sections, namedId, "Hi", 1000);
  if (viaBlind) assert.match(viaBlind, /^About a figure on page/);
  assert.equal(figureQuestionText(named, fx.sections, "f_0000000000", "Hi", 1000), null);
  assert.equal(figureQuestionText(null, fx.sections, namedId, "Hi", 1000), null);
  assert.equal(figureQuestionText(named, fx.sections, null, "Hi", 1000), null);
});

test("the route: resolved → pending_broker with no AI; teaser-only links refused before it (integrator: teaser's 403 first)", () => {
  const routes = readFileSync(join(ROOT, "server/routes.ts"), "utf8");
  const start = routes.indexOf('app.post("/api/deals/:dealId/questions"');
  const body = routes.slice(start, start + 12000);
  const at = body.indexOf("figureQuestionText(");
  assert.ok(at > 0);
  const branch = body.slice(at, at + 1500);
  assert.match(branch, /status: "pending_broker"/);
  assert.ok(!/anthropic|answerBuyerQuestion/.test(branch), "no AI on the figure path");
  assert.ok(body.indexOf("figureQuestionText(") < body.indexOf("answerBuyerQuestion("), "before the AI steps");
});

await run("figure-question (D18)");
