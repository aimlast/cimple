/**
 * D23: the one privacy pipeline over every buyer-bound string of the figure
 * layer — individual pay merged into "Wages and salaries", a held party's
 * line label dropped, failing parts → "Other costs", failing notes dropped;
 * applied at serve time, so a new keep-out request takes effect at once.
 *   npx tsx tests/unit/figure-strings.test.ts
 */
import assert from "node:assert/strict";
import { isIndividualPayLine, neutralPartLabel, screenBuyerStrings, OTHER_COSTS_LABEL, WAGES_LABEL } from "../../shared/figure-strings";
import type { FigureLayer } from "../../shared/figure-layer";
import { screenCtxFor, stringScreenFor } from "../../server/cim/figures/guards";
import { run, test } from "./helpers/figure-test";

const layer = (): FigureLayer => ({
  mode: "dd", audience: "buyer", anchors: [], ddChecksOn: true,
  figures: {
    f_1: {
      id: "f_1", label: "Operating expenses", year: "2023", display: "$5,505,500",
      parts: [
        { label: "Salary — Daniel Okafor, dispatcher", display: "$61,500" },
        { label: "Management salaries — shareholders", display: "$505,000" },
        { label: "Facility rent", display: "$2,338,000" },
        { label: "Consulting — Karen Holt", display: "$12,000" },
      ],
      checks: [{ id: "c", kindLabel: "Tax return (T2)", value: "$7,797,500", sourceLabel: "Fees paid to Karen Holt", difference: null, differencePct: null, state: "match", size: "match", note: null, citation: null }],
      why: { id: "n1", text: "Mostly the new warehouse lease, negotiated by Karen Holt.", basis: "broker", basisLabel: "From the broker", citations: [] },
    },
  },
  keyTerms: { p1: [{ label: "Lease expires", value: "September 30, 2037", citation: { documentId: "d", kind: "lease" } }, { label: "Guarantor", value: "Karen Holt", citation: { documentId: "d", kind: "lease" } }] },
});

test("pay lines: individual pay is recognised; ordinary wage lines are not", () => {
  assert.ok(isIndividualPayLine("Salary — Daniel Okafor, dispatcher"));
  assert.ok(isIndividualPayLine("Management salaries — shareholders"));
  assert.ok(isIndividualPayLine("Owner compensation"));
  assert.ok(isIndividualPayLine("Related party salary - Maria Moretti (spouse)"));
  assert.ok(!isIndividualPayLine("Driver wages & benefits"));
  assert.ok(!isIndividualPayLine("Office, dispatch & administration salaries"));
});

test("the pipeline merges pay, neutralises failing parts, drops a held party's label, note and key term", () => {
  const screen = { keep: (t: string) => !/Karen Holt/.test(t) };
  const out = screenBuyerStrings(layer(), screen);
  const f = out.figures.f_1;
  const labels = f.parts!.map((p) => p.label);
  assert.ok(labels.includes(WAGES_LABEL));
  assert.ok(labels.includes(OTHER_COSTS_LABEL));
  assert.ok(labels.includes("Facility rent"));
  assert.ok(!labels.some((l) => /Okafor|shareholders|Holt/.test(l)));
  const wages = f.parts!.find((p) => p.label === WAGES_LABEL)!;
  assert.equal(wages.display, "$566,500", "one neutral part, summed");
  assert.equal(f.checks![0].sourceLabel, undefined);
  assert.equal(f.why, null);
  assert.deepEqual(out.keyTerms!.p1.map((t) => t.label), ["Lease expires"]);
  assert.equal(neutralPartLabel("Facility rent", screen), "Facility rent");
});

test("server screen: a seller keep-out request made later holds the text at serve time (no rebuild)", () => {
  const before = stringScreenFor(screenCtxFor({}));
  const text = "Mostly the settlement of the dismissal lawsuit with the former manager.";
  assert.equal(before.keep(text), true);
  const after = stringScreenFor(screenCtxFor({ _sellerKeepOut: [{ detail: "A former manager filed a wrongful dismissal lawsuit", terms: ["dismissal lawsuit"], at: "2026-10-09" }] }));
  assert.equal(after.keep(text), false);
});

test("server screen: a party the broker's private notes keep out of the CIM is held", () => {
  const info = {
    customerPipeline: "Kestrel Systems RFP: shortlisted for a 26-store contract.",
    _brokerPrivateNotes: [{ note: "Kestrel Systems RFP is marked CONFIDENTIAL — keep out of CIM." }],
  };
  const ctx = screenCtxFor(info);
  assert.ok(ctx.heldNames.includes("Kestrel Systems"), JSON.stringify(ctx.heldNames));
  const screen = stringScreenFor(ctx);
  assert.equal(screen.keep("Revenue rose with the Kestrel Systems contract."), false);
  assert.equal(screen.keep("Revenue rose with two new contracts."), true);
});

await run("figure-strings (D23)");
