/**
 * D8a hints: what the financial analysis already says about a figure, for
 * the broker only. Internal check lines are never offered.
 *   npx tsx tests/unit/figure-hints.test.ts
 */
import assert from "node:assert/strict";
import { fixtureRaw, run, test } from "./helpers/figure-test";
import { analysisNoteSentences, hintsFor } from "../../server/cim/figures/hints";
import { screenCtxFor, holdsText } from "../../server/cim/figures/guards";

test("Pacific facility rent 2023 → the warehouse-lease hint", async () => {
  const { fx, raw } = await fixtureRaw("pacific", { locate: false });
  const sentences = analysisNoteSentences(fx.analyses[0]);
  const key = Object.keys(raw.registry).find((k) => /^line:facility-rent/.test(k) && k.endsWith("|2023"))!;
  assert.ok(key, "the facility rent line exists");
  const hints = hintsFor([key], raw.registry, sentences);
  assert.match(hints[key], /^Warehouse lease commenced October 1, 2022/);
});

test("internal check lines are never offered", async () => {
  const { fx } = await fixtureRaw("pacific", { locate: false });
  const sentences = analysisNoteSentences(fx.analyses[0]);
  assert.ok(sentences.length > 5);
  for (const s of sentences) assert.ok(!/^Check:|does not tie|Net income computed|reported net income/i.test(s), s);
});

test("a hint used as a note is screened like broker text: staff named in it are held, owners allowed", async () => {
  const info = {
    ownerName: "Tony Moretti",
    keyEmployees: "Daniel Okafor (dispatcher) runs the night shift.",
  };
  const ctx = screenCtxFor(info);
  assert.equal(holdsText("The owner, Tony Moretti, renewed the lease.", ctx, { owners: true }), null);
  assert.match(holdsText("Daniel Okafor negotiated the fuel contract.", ctx, { owners: true }) ?? "", /staff member/);
});

await run("figure-hints");
