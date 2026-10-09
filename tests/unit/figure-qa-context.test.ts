/**
 * P2: the buyer Q&A reads the approved figure notes the buyer reads (dd spec
 * §9.3) — their version's wording, never a suggested note, a hint or "no
 * reason on file"; Blind: no line labels. Both answer paths use it.
 *   npx tsx tests/unit/figure-qa-context.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, fixtureRaw, noteRow, run, test } from "./helpers/figure-test";
import { figureInputsFor } from "../../server/cim/figures/serve";
import { buildFigureLayer } from "../../shared/figure-layer";
import { figureNotesContext } from "../../server/cim/figures/qa-context";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLUB_DOC = fixture("lakeshore").documents.find((d) => /^Comfort Club membership report/.test(d.name))!.id;
const APPROVED = noteRow({
  id: "n-club", figureKey: "line:comfort-club-maintenance-plan-memberships|2023", kind: "movement", compareKey: "2022", origin: "ai", status: "approved",
  text: "Active members grew from 2,150 to 2,520 during FY2023.", blindText: "Members grew from 2,150 to 2,520 during FY2023.",
  sources: [{ kind: "document", documentId: CLUB_DOC, quote: "2150 / 2520" }],
  valuesSnapshot: { year: "2023", value: 690000, fromYear: "2022", fromValue: 585000 },
});
const SUGGESTED = noteRow({
  id: "n-cos", figureKey: "costOfSales|2023", kind: "movement", compareKey: "2022", status: "suggested",
  text: "SUGGESTED ONLY", blindText: "SUGGESTED ONLY", valuesSnapshot: { year: "2023", value: 3822000, fromYear: "2022", fromValue: 3488000 },
});

async function ctx(mode: "normal" | "blind" | "dd") {
  const { fx, raw } = await fixtureRaw("lakeshore", { notes: [APPROVED, SUGGESTED], ddShownAt: new Date() });
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode }), mode);
  return figureNotesContext(layer, fx.sections);
}

test("Full CIM: the approved note with its figure and basis; never a suggested note or 'no reason'", async () => {
  const t = await ctx("normal");
  assert.match(t, /## Notes on the figures/);
  assert.match(t, /Comfort Club maintenance-plan memberships, FY2023 \(\$690,000\): Up \$105,000 \(18%\) from FY2022\. Active members grew from 2,150 to 2,520 during FY2023\./);
  assert.ok(!t.includes("SUGGESTED ONLY"));
  assert.ok(!/no reason/i.test(t));
});

test("Blind CIM: the blind wording, no line labels", async () => {
  const t = await ctx("blind");
  assert.match(t, /Members grew from 2,150 to 2,520 during FY2023\./);
  assert.ok(!t.includes("Comfort Club"));
  assert.ok(!t.includes("Active members"));
});

test("DD: the checks in words (and their worked-out reasons)", async () => {
  const t = await ctx("dd");
  assert.match(t, /Interest, FY2022 \(\$29,000\) vs Tax return \(T2\) \$86,000: Same amounts, grouped differently\. The tax return's interest line includes bank charges/);
});

test("both answer paths read it (the questions route and readerCim)", () => {
  const routes = readFileSync(join(ROOT, "server/routes.ts"), "utf8");
  assert.match(routes, /buildAnswerContext\(answerSections\)\) \+ figureNotesContext\(chatLayer, chatSections\)/);
  const qa = readFileSync(join(ROOT, "server/qa/cim-context.ts"), "utf8");
  assert.match(qa, /figureNotesContext\(cim\.figureLayer, cim\.sections\)/);
  assert.match(qa, /buyerCimExtras\(readerDeal as any, reader\.accessLevel, null\)/);
  assert.equal(figureNotesContext(null, []), "");
});

await run("figure-qa-context (P2)");
