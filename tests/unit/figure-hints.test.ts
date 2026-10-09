/**
 * D8a hints: what the financial analysis already says about a figure, for
 * the broker only. Internal check lines are never offered.
 *   npx tsx tests/unit/figure-hints.test.ts
 */
import assert from "node:assert/strict";
import { fixtureRaw, run, test } from "./helpers/figure-test";
import { analysisNoteSentences, hintsFor, isRecital } from "../../server/cim/figures/hints";
import { screenCtxFor, holdsText } from "../../server/cim/figures/guards";

test("Pacific facility rent 2023 → the warehouse-lease hint", async () => {
  const { fx, raw } = await fixtureRaw("pacific", { locate: false });
  const sentences = analysisNoteSentences(fx.analyses[0]);
  const key = Object.keys(raw.registry).find((k) => /^line:facility-rent/.test(k) && k.endsWith("|2023"))!;
  assert.ok(key, "the facility rent line exists");
  const hints = hintsFor([key], raw.registry, sentences);
  assert.match(hints[key], /^Warehouse lease commenced October 1, 2022/);
});

test("a recital of figures is never a hint (Beacon income taxes ← 'Reported EBITDA (net income + …)')", async () => {
  const { fx, raw } = await fixtureRaw("beacon", { locate: false });
  const sentences = analysisNoteSentences(fx.analyses[0]);
  const keys = Object.keys(raw.registry).filter((k) => /income-taxes/.test(k));
  assert.ok(keys.length > 0);
  const hints = hintsFor(keys, raw.registry, sentences);
  assert.deepEqual(hints, {});
  assert.equal(isRecital("Reported EBITDA (net income + income taxes + interest + amortization): FY2022 $489,325; FY2023 $550,000."), true);
  assert.equal(isRecital("Dividends ($500K in 2022, $300K in 2023 and 2024) are distributions of after-tax profit and are not addbacks to EBITDA."), true);
  assert.equal(isRecital("EBITDA margin trend: 13.2% (2022) → 11.3% (2023) → 12.6% (2024)."), true);
  assert.equal(isRecital("Warehouse lease commenced October 1, 2022, explaining the increase in facility rent from $1,217,000 to $2,337,500."), false);
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

test("checker r2: a sentence about EBITDA margin is never interest's reason (it only mentions 'interest rates' in passing)", async () => {
  const { fx, raw } = await fixtureRaw("pacific", { locate: false });
  const sentences = analysisNoteSentences(fx.analyses[0]);
  const ebitda = "EBITDA margin declined from 13.2% (2022) to 11.3% (2023) due to full-year impact of Campbell Ridge warehouse rent and higher equipment loan interest rates.";
  const hints = hintsFor(["interest|2023"], raw.registry, [...sentences, ebitda]);
  assert.ok(!hints["interest|2023"] || !/^EBITDA margin|margin compression/i.test(hints["interest|2023"]), hints["interest|2023"]);
  // The fixture's own sentence about the margin compression is not offered either.
  for (const s of Object.values(hintsFor(["interest|2023", "interest|2024"], raw.registry, sentences))) assert.ok(!/margin/i.test(s), s);
  // A sentence whose subject IS interest still is.
  const own = "Interest expense rose in 2023 with higher rates on the new equipment loans (2022 rates were lower).";
  assert.equal(hintsFor(["interest|2023"], raw.registry, [own])["interest|2023"], own);
  // The facility-rent hint (subject: the warehouse lease) is unchanged.
  const rent = Object.keys(raw.registry).find((k) => /^line:facility-rent/.test(k) && k.endsWith("|2023"))!;
  assert.match(hintsFor([rent], raw.registry, sentences)[rent], /^Warehouse lease commenced/);
});

await run("figure-hints");
