// Release review round 2, F2-STAFF-5: the precision fixes (an authority's
// warning, a customer's person, leaving another organisation, customer facts
// holding only known staff) must not let staff-private matters through that
// the screen held before. The checker's recall regressions, each proved here
// alongside the precision cases they were written for:
//   (a) "leave <Capitalised>" read as another organisation — a place is not
//       one ("Mei-Lin may leave Ontario", "leaving Toronto", "leave Calgary");
//   (b) customer/client facts held only people listed in the staff facts —
//       a person the fact itself marks as ours counts ("Mike Chen, who
//       manages the account for us", "held by Tom Reyes");
//   (c) any warning next to "after/in/at the <generic word>" was cleared as
//       an authority's — "after the (internal) audit", "in the commission
//       review", "at college" are not authorities;
//   (d) "their <role> Name" made anyone an outsider — "their pharmacist
//       Daniel Okafor" is the business's own (third person).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/staff-private-recall.test.ts
import assert from "node:assert/strict";
import { routeStaffPrivateChanges, screenStaffPrivatePairs, staffContextFrom } from "../../server/cim/staff-private";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

const PRAIRIE: Record<string, unknown> = {
  ownerName: "Harjit Grewal",
  businessName: "Prairie Line Freight Ltd.",
  shareholders: "Harjit Singh Grewal (60.0%); Manpreet Grewal (25.0%); Surinder Kaur Grewal (15.0%)",
  managementTeam: "Harjit Grewal (President), Manpreet Grewal (VP Operations), Diane Tremblay (Controller)",
  keyEmployees: "Diane Tremblay (Controller, since 2019) runs payroll and AR. Dave Kowalczyk, lead dispatcher since 2011.",
};
const BEACON: Record<string, unknown> = {
  ownerName: "Helen Park",
  businessName: "Beacon Specialty Pharmacy Inc.",
  keyEmployees: "Daniel Okafor: LTC lead pharmacist since 2014 (11 years). Mei-Lin: compounding pharmacist since 2018.",
};

function screen(info: Record<string, unknown>, key: string, value: string) {
  const ctx = staffContextFrom({ ...info, [key]: value });
  const r = screenStaffPrivatePairs([[key, value]], { ctx });
  const strict = routeStaffPrivateChanges([{ fieldName: key, newValue: value }], info);
  return { held: r.items.map((i) => i.text), kept: r.safe[0]?.[1] as string | undefined, routed: strict.notes.map((n) => n.note) };
}
const held = (info: Record<string, unknown>, key: string, value: string, part?: RegExp) => {
  const r = screen(info, key, value);
  assert.ok(r.held.length > 0, `held: ${value}`);
  if (part) assert.ok(r.held.some((h) => part.test(h)), `held part ${part}: got ${JSON.stringify(r.held)}`);
  return r;
};
const kept = (info: Record<string, unknown>, key: string, value: string) => {
  const r = screen(info, key, value);
  assert.deepEqual(r.held, [], `kept: ${value}`);
  assert.equal(r.kept, value);
  assert.deepEqual(r.routed, [], "never routed to the private notes");
};

console.log("(a) moving away from a place is the person's own departure");
test("leaving a province, a city: held", () => {
  held(BEACON, "keyEmployees", "Mei-Lin may leave Ontario when her husband's posting ends next year.");
  held(PRAIRIE, "employeeNotes", "Diane Tremblay is thinking of leaving Toronto to be near her parents.");
  held(PRAIRIE, "keyEmployees", "Dave Kowalczyk may leave Calgary next year to be closer to family.");
  held(BEACON, "keyEmployees", "Mei-Lin might leave BC in the spring.");
});
test("our own staff leaving a customer's account, or leaving to join the customer: held", () => {
  held(PRAIRIE, "keyEmployees", "Dave Kowalczyk is thinking of leaving Alderbrook's account to someone else and may quit next year.");
  held(PRAIRIE, "keyEmployees", "Dave Kowalczyk may leave Prairie Line to join Alderbrook next year.");
  held(PRAIRIE, "keyEmployees", "Alderbrook Foods is our biggest customer. Dave Kowalczyk may leave Alderbrook next year.", /Dave/);
});
test("a customer's person leaving the customer: kept (the precision case)", () => {
  kept(PRAIRIE, "customerConcentration", "Alderbrook Foods is 31% of revenue; their buyer, Karen Holt, has said she may leave Alderbrook next year.");
  kept(PRAIRIE, "keySuppliers", "Main supplier is Volvo Trucks; their rep, Karen Holt, might retire next year.");
  kept(PRAIRIE, "customerConcentration", "Alderbrook's buyer Karen Holt handles our account and may leave Alderbrook next year.");
  kept(PRAIRIE, "customerConcentration", "Karen Holt, our main contact at Alderbrook, may retire next year.");
});

console.log("(b) customer facts: a person the fact marks as ours is staff");
test("marked ours in the fact: held", () => {
  held(PRAIRIE, "customerConcentration", "Alderbrook Foods is 31% of revenue; Mike Chen, who manages the account for us, has been approached by a competitor.", /approached/);
  held({ ...PRAIRIE, ownerName: "Gord Miller" }, "customerRelationships", "Relationships with the top clients are held by Tom Reyes; Tom has told Gord he may retire next year.", /retire/);
  held(PRAIRIE, "customerConcentration", "Alderbrook Foods is 31% of revenue; Mike Chen, our account manager for Alderbrook, has been approached by a competitor.", /approached/);
  held(PRAIRIE, "customerConcentration", "Alderbrook Foods is 31% of revenue; Dave Kowalczyk handles the account and is thinking of leaving us.", /leaving us/);
});
test("the business part of the fact stays", () => {
  const r = held(PRAIRIE, "customerConcentration", "Alderbrook Foods is 31% of revenue; Mike Chen, who manages the account for us, has been approached by a competitor.");
  assert.match(r.kept ?? "", /Alderbrook Foods is 31% of revenue/);
  assert.match(r.kept ?? "", /Mike Chen, who manages the account for us/);
});

console.log("(c) only a real authority clears a warning");
test("the business's own process: held", () => {
  held(PRAIRIE, "keyEmployees", "Dave Kowalczyk was given a written warning after the audit for skipping cycle counts.");
  held(PRAIRIE, "keyEmployees", "Dave Kowalczyk got a final warning after the internal audit found he falsified logbooks.");
  held(PRAIRIE, "keyEmployees", "Dave Kowalczyk got a written warning in the commission review for padding his numbers.");
  held(PRAIRIE, "keyEmployees", "Jess, our apprentice who is still at college, got a written warning in May for missing shifts.", /written warning/);
  held(PRAIRIE, "keyEmployees", "Diane got a written warning from Harjit last spring.");
  // After an authority's audit, but the business disciplined its own person.
  held(PRAIRIE, "keyEmployees", "Dave Kowalczyk got a written warning after the CVOR audit found his logbooks incomplete.");
});
test("an authority's warning or finding: kept (the precision case)", () => {
  kept(PRAIRIE, "licensing", "NSC safety certificate in good standing; the safety manager, Paul, was given a written warning by the MTO auditor in 2023 about logbook gaps, since fixed.");
  kept(PRAIRIE, "safetyCompliance", "Operating licence renewed 2025; the Ministry of Labour inspector issued a written warning in 2024 about guarding on the press line.");
  kept(PRAIRIE, "safetyCompliance", "The company was reprimanded during the 2023 CVOR audit for hours-of-service gaps; a corrective plan is in place.");
  kept(PRAIRIE, "safetyCompliance", "The company was reprimanded after the 2022 MTO audit; a corrective plan was filed.");
  kept(BEACON, "regulatoryHistory", "Daniel Okafor was reprimanded by the College of Pharmacists in 2022 for a dispensing error; no further action.");
  kept(PRAIRIE, "compliance", "A warning letter from the Ministry of Environment in 2022 about spill reporting was closed with no fine.");
});

console.log("(d) 'their' is the business's own people unless the role is an outside one");
test("their pharmacist asked about a stake: held and routed", () => {
  const r = held(BEACON, "keyEmployees", "Working alongside Helen is their pharmacist Daniel Okafor; asked Helen about buying a stake last year.", /stake/);
  assert.ok(r.routed.some((n) => /Daniel Okafor/.test(n) && /stake/.test(n)));
  held(BEACON, "keyEmployees", "Helen relies on their right hand, Daniel Okafor, who privately asked about buying a stake last year.", /stake/);
});
test("the Karen Holt case still reads as the customer's person", () => {
  const ctx = staffContextFrom({ ...PRAIRIE, keyEmployees: "Dave Kowalczyk handles Alderbrook; their buyer, Karen Holt, is new." });
  assert.ok(!ctx.staffNames.some((n) => /Karen/.test(n)), "a customer's person mentioned in a staff fact is not staff");
  assert.ok(ctx.staffNames.some((n) => /Dave Kowalczyk/.test(n)));
});

console.log("the review's original cases still hold");
test("turnover kept, departure held", () => {
  const r = held(PRAIRIE, "employeeCount", "42 full-time employees including 31 drivers; turnover among drivers is about 18% a year and two drivers may leave after a sale.", /two drivers may leave/);
  assert.match(r.kept ?? "", /18% a year/);
});

console.log(`\n${passed} passed`);
