/**
 * The teaser's checks (shared/teaser-guard.ts, server/teaser/figures.ts):
 *  - stripFigures leaves no figure in the AI's input ("$18.2M in 2024",
 *    "112 trucks", "22%", "since 1987", "one hundred and twelve tractors"),
 *    keeping short durations ("a 6-month handover");
 *  - figuresOutsideAllowed refuses an output repeating any of them, and lets
 *    the allowed phrases ("20+ years") and short durations through;
 *  - guardTeaserText catches the business name, its distinctive word, a
 *    staff name, the town, a USDOT number, an email, and leftover stand-ins;
 *  - pinpointWarnings flags "the only…", "established 1987", "112 trucks",
 *    "largest independent pharmacy", and not "one of several", "20+ years",
 *    "a regional carrier".
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/teaser-guard.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { figuresOutsideAllowed, guardTeaserText, pinpointWarnings, processWordsIn, heldReason } from "../../shared/teaser-guard";
import { teaserTerms } from "../../shared/teaser-view";
import { stripFigures, spelledFigureAtLeast } from "../../server/teaser/figures";
import { spelledNumbers } from "../../server/cim/spoken-figures";

const deal = JSON.parse(readFileSync(new URL("../fixtures/teaser/pacific-deal.json", import.meta.url), "utf8"));
let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const NARRATIVE = "Revenue reached $18.2M in 2024 with 112 trucks; the top customer is 22% of sales. Founded since 1987, it runs one hundred and twelve tractors. A 6-month handover is offered and the team grew 15 percent.";

check("stripFigures leaves no figure, keeps short durations", () => {
  const out = stripFigures(NARRATIVE);
  for (const f of ["18.2", "2024", "112", "22", "1987", "one hundred", "15 percent"]) assert.ok(!out.includes(f), `${f} left in: ${out}`);
  assert.ok(out.includes("[amount]") && out.includes("[year]") && out.includes("[number] trucks") && out.includes("[share]"), out);
  assert.ok(out.includes("A 6-month handover"), out);
  assert.ok(!/\d/.test(out.replace("6-month", "")), `no digits except the duration: ${out}`);
  assert.equal(spelledFigureAtLeast("one hundred and twelve tractors"), true);
  assert.equal(spelledFigureAtLeast("two sites"), false);
});

check("figuresOutsideAllowed refuses every figure the input had; allowed phrases and short durations pass", () => {
  const allowed = ["Transportation & Logistics", "British Columbia", "Established 30+ years", "30+ years"];
  for (const bad of ["Revenue of $18.2M.", "Since 2024 it grew.", "Runs 112 trucks.", "Top customer is 22%.", "Founded in 1987.", "It runs one hundred and twelve tractors.", "Up 15 percent."]) {
    assert.ok(figuresOutsideAllowed(bad, allowed, spelledNumbers).length > 0, bad);
  }
  assert.deepEqual(figuresOutsideAllowed("A carrier established 30+ years ago in British Columbia.", allowed, spelledNumbers), []);
  assert.deepEqual(figuresOutsideAllowed("The owner offers a 6-month handover and 12 weeks of support.", allowed, spelledNumbers), []);
  assert.ok(figuresOutsideAllowed("A 36-month earn-out.", allowed, spelledNumbers).length > 0, "a long duration is a figure");
  assert.ok(figuresOutsideAllowed("Twenty drivers.", allowed).length > 0, "fallback word list catches 13+");
});

const terms = teaserTerms(deal, "Project Coastline");
check("guardTeaserText flags the name, a staff name, the town, a registry number, an email, and stand-ins", () => {
  const leaks = (t: string) => guardTeaserText(t, terms);
  assert.ok(!leaks("Pacific Coast Logistics Ltd. is a carrier.").ok, "full name");
  assert.ok(!leaks("The team is led by Manpreet Grewal.").ok, "staff name");
  assert.ok(!leaks("Based in Surrey with a modern terminal.").ok, "the town");
  assert.ok(!leaks("Holds USDOT 2847193 for cross-border lanes.").ok, "registry number");
  assert.ok(!leaks("Write to harjit@pacificcoastlogistics.invalid.").ok, "email");
  assert.ok(!leaks("Revenue of [amount] last year.").ok, "a figure stand-in");
  const clean = leaks("Project Coastline is an established regional carrier in British Columbia with cross-border refrigerated authority.");
  assert.ok(clean.ok, JSON.stringify(clean));
  const why = heldReason(leaks("Based in Surrey."), terms)!;
  assert.match(why, /Surrey/);
});

check("pinpointWarnings flags unique claims, exact years and counts — and not ordinary wording", () => {
  const flagged = (t: string) => pinpointWarnings(t).length > 0;
  assert.ok(flagged("It is the only cross-border reefer carrier in the valley."));
  assert.ok(flagged("A carrier established 1987."));
  assert.ok(flagged("The fleet has 112 trucks."));
  assert.ok(flagged("The largest independent pharmacy in the area."));
  assert.ok(!flagged("One of several carriers serving the region."));
  assert.ok(!flagged("In business 20+ years."));
  assert.ok(!flagged("A regional carrier with steady customers."));
});

check("process words fail a field", () => {
  assert.ok(processWordsIn("The seller said margins are improving."));
  assert.ok(processWordsIn("Per the interview, demand is strong."));
  assert.ok(processWordsIn("This teaser describes a carrier."));
  assert.equal(processWordsIn("Demand is strong and margins are improving."), null);
});

console.log(`\n${passed} checks passed`);
