// A stated count must match the list that follows it (Lakeshore rebuild
// 2026-09-28: "Only two technicians have been lost in the last three years:
// one retired, one moved to Alberta, and one was terminated").
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/prose-count-list.test.ts
import assert from "node:assert/strict";
import { countListMismatches, proseProblems, proseKnowledge } from "../../server/cim/prose-check";
import { knownFiguresFrom } from "../../server/cim/figure-check";

const flagged = (t: string) => countListMismatches(t);

// The rebuild's sentence, as written.
{
  const t = "The company has experienced very low turnover. Only two technicians have been lost in the last three years: one retired, one moved to Alberta, and one was terminated. The business has never laid off staff.";
  const f = flagged(t);
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.match(f[0], /says "two technicians" but lists three/);
}
// The fact's own shape: a parenthesised list.
assert.equal(flagged("Luis 16 years, Paulo 14 years, only 2 techs lost in last 3 years (one retired, one moved to Alberta, one terminated).").length, 1);
// A count that matches is fine, counted items or plain ones.
assert.deepEqual(flagged("Three technicians have left in the last three years: one retired, one moved to Alberta, and one was terminated."), []);
assert.deepEqual(flagged("The business operates from three locations: Hamilton, Burlington and Oakville."), []);
assert.deepEqual(flagged("The fleet has 5 vans (3 owned, 2 leased)."), []);
assert.deepEqual(flagged("94 dry van trailers, 46 refrigerated trailers (14 units from 2011–2014 vintage requiring replacement), and 20 container chassis."), [], "a bracket's list ends at the bracket");
// A plain list that doesn't match the count directly before it.
assert.equal(flagged("The business operates from two locations: Hamilton, Burlington, and Oakville.").length, 1);
// Without an Oxford comma the last "and" may join one item: not flagged either way.
assert.deepEqual(flagged("Customers in four Atlantic provinces: Nova Scotia, New Brunswick, Prince Edward Island, Newfoundland and Labrador."), []);
// A numbered list counts its numbers; an aside in brackets is not a list.
assert.deepEqual(flagged("Diligence runs in four workstreams: (1) financial, (2) legal, (3) operations, (4) people."), []);
assert.equal(flagged("Diligence runs in three workstreams: (1) financial, (2) legal, (3) operations, (4) people.").length, 1);
assert.deepEqual(flagged("There are 5 identified growth levers (tap to see all opportunities and investment profile)."), []);
assert.deepEqual(flagged("The owner works 20 hrs a week on three things: finances, purchasing, menu development."), []);
// Never a mismatch: subsets, shares, durations, long clauses.
assert.deepEqual(flagged("24 technicians, including Luis, Paulo and Sal."), []);
assert.deepEqual(flagged("Revenue comes from three segments: residential (60%), commercial (30%) and property management (10%)."), []);
assert.deepEqual(flagged("Key technicians including Luis Fernandes (16 years), Paulo Fernandes (14 years), and Sal Ferraro (16 years) provide continuity."), []);
assert.deepEqual(flagged("Two senior technicians — Luis and Paulo — lead the commercial work."), []);
assert.deepEqual(flagged("The owner has worked 12 hours a day for 20 years: first in service, then in sales and finally in management."), []);
assert.deepEqual(flagged("Revenue grew 8.4% in 2024 (up from 6.1% in 2023)."), []);

// Reported with the section's other prose problems (the section is rewritten once with the list).
{
  const kb = "Technician Tenure: Luis 16 years, Paulo 14 years, only 2 techs lost in last 3 years (one retired, one moved to Alberta, one terminated)";
  const known = knownFiguresFrom(kb);
  known.prose = proseKnowledge(kb, {} as any);
  const issues = proseProblems(
    { sectionTitle: "Workforce", layoutType: "prose_highlight", layoutData: { body: "Only two technicians have been lost in the last three years: one retired, one moved to Alberta, and one was terminated." } },
    known,
  );
  assert.ok(issues.some((i) => /says "two technicians" but lists three/.test(i)), JSON.stringify(issues));
}

console.log("prose-count-list: all passed");
