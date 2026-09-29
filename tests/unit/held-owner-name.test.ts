/**
 * F2-CIMTRUTH-1 (final review): a confidential clause about the owner holds
 * that clause only — never the owner's name, which took their role,
 * transition plan and key-person facts out of the named CIM and DD. A held
 * person's given name alone is matched only when nobody else on file
 * shares it.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/held-owner-name.test.ts
 */
import assert from "node:assert/strict";
import { screenFactsForCim, mentionsHeldPerson, screenConfidentialText } from "../../server/cim/sensitive-facts";

// ── The owner is the subject of a confidential clause ──────────────────
{
  const info: Record<string, unknown> = {
    ownerName: "Harjit Grewal",
    ownerInvolvement: "Harjit works about 50 hours a week and holds the Alderbrook and co-op customer relationships.",
    transitionPlan: "Harjit will stay 6 months after closing to introduce the buyer to key customers.",
    reasonForSale: "Retirement. Harjit Grewal was approached by Kinder Freight last year about a sale (confidential).",
    keyPersonRisk: "Customer relationships sit with Harjit; Manpreet has been introduced to the top 5 accounts.",
    yearFounded: "1994",
  };
  const r = screenFactsForCim(Object.entries(info));
  assert.deepEqual(r.heldNames, ["Kinder Freight"], "the other party is held, the owner is not");
  const safe = new Map(r.safe);
  for (const k of ["ownerName", "ownerInvolvement", "transitionPlan", "keyPersonRisk", "yearFounded"]) {
    assert.deepEqual(safe.get(k), info[k], `${k} reaches the writer unchanged`);
  }
  assert.equal(safe.get("reasonForSale"), "Retirement.", "the confidential clause itself is held");
  assert.ok(r.confidential.some((h) => h.key === "reasonForSale"));
  // The DD check / scrub no longer treat "Harjit" as a held party.
  assert.equal(mentionsHeldPerson("Harjit will stay six months to introduce the buyer.", r.heldNames), null);
  assert.equal(mentionsHeldPerson("Kinder Freight approached the owner.", r.heldNames), "Kinder Freight");
}

// ── Shareholders / management are the deal's own people too ────────────
{
  const info: Record<string, unknown> = {
    shareholders: "Harjit Grewal (60%), Manpreet Grewal (25%), Daljit Sandhu (15%)",
    managementTeam: "Manpreet Grewal runs operations; Daljit Sandhu is the controller.",
    notes: "Daljit Sandhu has had informal talks with a competitor about a buyout (confidential).",
    financeLead: "Daljit prepares the monthly statements.",
  };
  const r = screenFactsForCim(Object.entries(info));
  assert.ok(!r.heldNames.includes("Daljit Sandhu"), "a shareholder is not held as a party");
  assert.equal(new Map(r.safe).get("financeLead"), info.financeLead);
}

// ── A held outsider is still matched by their given name alone… ────────
{
  const info: Record<string, unknown> = {
    ownerName: "Tom Becker",
    payroll: "Wages paid to Maria Chen, the owner's spouse, are confidential.",
    officeNotes: "Maria (owner's spouse) keeps the books two days a week.",
  };
  const r = screenFactsForCim(Object.entries(info));
  assert.ok(r.heldNames.includes("Maria Chen"), `held: ${JSON.stringify(r.heldNames)}`);
  assert.equal(mentionsHeldPerson("Maria keeps the books.", r.heldNames), "Maria Chen", "given name alone, nobody else is a Maria");
  assert.ok(!new Map(r.safe).has("officeNotes"), "the sentence naming her goes");
}

// ── …but not when someone else on file has the same given name ─────────
{
  const info: Record<string, unknown> = {
    ownerName: "Tom Becker",
    payroll: "Wages paid to Maria Chen, the owner's spouse, are confidential.",
    staff: "Maria Lopez manages the front desk and scheduling.",
    frontDesk: "Maria trains every new receptionist.",
  };
  const r = screenFactsForCim(Object.entries(info));
  assert.ok(r.heldNames.includes("Maria Chen"));
  assert.equal(mentionsHeldPerson("Maria trains every new receptionist.", r.heldNames), null, "ambiguous given name: not matched alone");
  assert.equal(mentionsHeldPerson("Maria Chen keeps the books.", r.heldNames), "Maria Chen", "the full name still is");
  assert.equal(new Map(r.safe).get("frontDesk"), info.frontDesk);
  assert.equal(screenConfidentialText("Maria trains every new receptionist.", r.heldNames), "Maria trains every new receptionist.");
}

console.log("held-owner-name: all assertions passed");
