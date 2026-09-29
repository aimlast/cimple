// Staff-private screen precision (release review F2-STAFF-5): company facts
// the screen held as staff matters — a regulator's written warning, a
// customer's employee "may leave", a turnover rate joined by "and" to a
// departure — and upstream routing that moved a compliance finding into the
// broker's private notes for good. The founder's rule still holds: private
// staff matters stay out; company and regulatory facts stay in.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/staff-private-precision.test.ts
import assert from "node:assert/strict";
import {
  routeStaffPrivate,
  routeStaffPrivateChanges,
  screenStaffPrivatePairs,
  splitStaffPrivate,
  staffContextFrom,
} from "../../server/cim/staff-private";
import { routeStaffPrivateToNotes } from "../../server/documents/extractor";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

// The review's own probe deal (scratchpad/f2review/staff.ts).
const INFO: Record<string, unknown> = {
  businessName: "Pacific Coast Logistics Ltd.",
  ownerName: "Harjit Grewal",
  shareholders: "Harjit Singh Grewal (60.0%); Manpreet Grewal (25.0%); Surinder Kaur Grewal (15.0%)",
  managementTeam: "Harjit Grewal (President), Manpreet Grewal (VP Operations), Diane Tremblay (Controller)",
  keyEmployees: "Diane Tremblay (Controller, since 2019) runs payroll and AR. Dave Kowalczyk, lead dispatcher since 2011, wants to stay on under a new owner and is interested in a rollover of part of his bonus into equity.",
  employeeCount: "42 full-time employees including 31 drivers; turnover among drivers is about 18% a year and two drivers may leave after a sale.",
  customerConcentration: "Alderbrook Foods is 31% of revenue; their buyer, Karen Holt, has said she may leave Alderbrook next year.",
  licensing: "NSC safety certificate in good standing; the safety manager, Paul, was given a written warning by the MTO auditor in 2023 about logbook gaps, since fixed.",
};
const ctx = staffContextFrom(INFO);
const screened = screenStaffPrivatePairs(Object.entries(INFO), { ctx });
const safe = new Map(screened.safe);

console.log("CIM screen");
test("a regulator's written warning is compliance history — kept whole, nothing held", () => {
  assert.equal(safe.get("licensing"), INFO.licensing);
  assert.ok(!screened.items.some((i) => i.key === "licensing"));
});
test("a customer's employee who may leave the customer is not a staff departure", () => {
  assert.equal(safe.get("customerConcentration"), INFO.customerConcentration);
  assert.ok(!screened.items.some((i) => i.key === "customerConcentration"));
});
test("a turnover rate joined by 'and' stays; only the possible departure is held", () => {
  assert.equal(safe.get("employeeCount"), "42 full-time employees including 31 drivers; turnover among drivers is about 18% a year.");
  const item = screened.items.find((i) => i.key === "employeeCount")!;
  assert.equal(item.kind, "departure");
  assert.equal(item.text, "two drivers may leave after a sale");
});
test("the private equity wish is still held; the retention statement before it stays", () => {
  const item = screened.items.find((i) => i.key === "keyEmployees")!;
  assert.equal(item.kind, "equity");
  assert.match(item.text, /rollover of part of his bonus into equity/);
  assert.match(String(safe.get("keyEmployees")), /wants to stay on under a new owner/);
  assert.equal(item.person, "Dave Kowalczyk");
});

console.log("still held (the founder's rule)");
test("staff conduct not issued by an authority", () => {
  for (const s of [
    "Dave Kowalczyk got a written warning for lateness in March.",
    "Dave Kowalczyk got a written warning after a customer complaint.",
    "Diane Tremblay was disciplined for attendance issues.",
  ]) {
    const r = splitStaffPrivate(s, ctx, { key: "keyEmployees" });
    assert.equal(r.held.length, 1, s);
    assert.equal(r.held[0].kind, "conduct", s);
  }
});
test("a staff member leaving the business — by its own name, 'the company' or 'us'", () => {
  for (const s of [
    "Dave Kowalczyk may leave Pacific next year.",
    "Dave Kowalczyk may leave the company after the sale.",
    "Diane Tremblay is thinking about leaving us.",
  ]) {
    const r = splitStaffPrivate(s, ctx, { key: "keyEmployees" });
    assert.equal(r.held[0]?.kind, "departure", s);
  }
});
test("a person's possessive is not a company's: the owner's right hand is staff", () => {
  const hvac = staffContextFrom({ ownerName: "Linda Moreau", keyEmployees: "Raj Patel (service manager, 12 years)" });
  const r = splitStaffPrivate("Linda's right hand, Raj, may leave after the sale.", hvac, { key: "keyEmployees" });
  assert.equal(r.held[0]?.kind, "departure");
});
test("a customer's person is still held when the business's own staff member is the subject", () => {
  const r = splitStaffPrivate("Dave Kowalczyk handles Alderbrook; he is thinking of leaving us for a competitor.", ctx, { key: "customerConcentration" });
  assert.equal(r.held[0]?.kind, "departure");
});
test("'and' joining two private-free statements changes nothing", () => {
  const s = "Diane Tremblay runs payroll and AR and reports to Manpreet.";
  assert.deepEqual(splitStaffPrivate(s, ctx, { key: "keyEmployees" }), { kept: s, held: [], changed: false });
});
test("'and' cut: the private part after it goes, the statement before stays", () => {
  const r = splitStaffPrivate("Diane Tremblay runs the office and is on stress leave since August.", ctx, { key: "keyEmployees" });
  assert.equal(r.kept, "Diane Tremblay runs the office.");
  assert.equal(r.held[0].kind, "personal");
});

console.log("upstream routing (strict — moves words out of the facts for good)");
test("interview guard: the MTO audit finding stays in the facts", () => {
  const r = routeStaffPrivateChanges(
    [{ fieldName: "safetyCompliance", newValue: "NSC safety certificate in good standing; our safety manager was given a written warning by the MTO auditor in 2023 about logbook gaps, since fixed." }],
    INFO,
  );
  assert.equal(r.notes.length, 0);
  assert.equal(r.changes[0].newValue, "NSC safety certificate in good standing; our safety manager was given a written warning by the MTO auditor in 2023 about logbook gaps, since fixed.");
});
test("document extraction: the audit finding stays a fact", () => {
  const data: Record<string, unknown> = { ...INFO, safetyCompliance: "Our safety manager received a warning letter from the Ministry of Labour inspector in 2022; corrected within 30 days." };
  const notes = routeStaffPrivateToNotes(data, staffContextFrom(data));
  assert.ok(!notes.some((n) => /Ministry of Labour/.test(n)));
  assert.match(String(data.safetyCompliance), /Ministry of Labour/);
});
test("conduct with no named staff member is never routed (the CIM screen still holds it, where Include reaches it)", () => {
  const value = "Our dispatch team is strong; the night supervisor got a written warning for lateness last spring.";
  const routed = routeStaffPrivate("employees", value, ctx);
  assert.deepEqual(routed, { kept: value, notes: [] });
  const cim = splitStaffPrivate(value, ctx, { key: "employees" });
  assert.equal(cim.held[0]?.kind, "conduct");
});
test("conduct of a named staff member is still routed to the broker's notes", () => {
  const routed = routeStaffPrivate("keyEmployees", "Dave Kowalczyk, lead dispatcher since 2011; got a written warning for lateness in March.", ctx);
  assert.equal(routed.notes.length, 1);
  assert.match(routed.notes[0], /written warning for lateness/);
  assert.equal(routed.kept, "Dave Kowalczyk, lead dispatcher since 2011");
});
test("a customer's buyer leaving the customer is never routed", () => {
  const value = "Alderbrook Foods is 31% of revenue; their buyer, Karen Holt, has said she may leave Alderbrook next year.";
  assert.deepEqual(routeStaffPrivate("customerConcentration", value, ctx), { kept: value, notes: [] });
});

console.log(`\n${passed} passed`);
