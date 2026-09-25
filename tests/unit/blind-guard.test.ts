/**
 * The Blind-CIM identity guard (shared/blind-guard.ts) — no database, no AI.
 *   npx tsx tests/unit/blind-guard.test.ts
 *
 * From the 2026-09-25 round-3 review:
 *   1. Role and profession phrases in staff facts ("Licensed Plumbers: 4",
 *      "Registered Massage Therapists (6)", "Certified Welders") are never
 *      forbidden identifiers — a Blind CIM must be able to say what the team
 *      does. Real names next to them are still caught.
 *   2. Names and places match in any case ("KITCHENER", "kitchener"), across
 *      accents, punctuation, line breaks and invisible characters — in every
 *      place the guard is used (it is one function: findBlindLeaks).
 *   3. A person/place that is also an everyday word ("Market" Street, "Bill")
 *      is caught when capitalised or in capitals, not as the lowercase word.
 */
import assert from "node:assert/strict";
import { blindLeakTerms, findBlindLeaks, foldForMatch } from "../../shared/blind-guard";
import { qaTextIsBlindSafe } from "../../shared/buyer-qa-scope";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const texts = (deal: Parameters<typeof blindLeakTerms>[0]) => blindLeakTerms(deal, { codename: "Project Keystone" }).map((t) => t.text);

// ── 1. Roles are not people ──────────────────────────────────────────────
console.log("roles and professions");

const plumbing = {
  businessName: "Grand River Plumbing & Heating Ltd.",
  extractedInfo: {
    employees: "Licensed Plumbers: 4\nApprentice Plumbers: 2\nOffice Manager Sandra Lee (since 2014)",
    staffBreakdown: "Registered Massage Therapists (6), Certified Welders, Red Seal Electricians, 4 Journeyman Pipefitters",
    teamComposition: "Early Childhood Educators (5); Customer Service Representatives; Heavy Equipment Operators x3; Line Cooks: 3; Tradesmen",
    keyEmployees: "Lead Plumber Tom Baker (12 years), Master Electrician Priya Natarajan, Service Technicians",
    ownerNames: "Owners: Anita Patel 51%, Marcus Rogers 49%",
    city: "KITCHENER",
    address: "45 Market Street, Guelph, ON N1H 2X4",
    staffNotes: "Bill (driver, 5 years)",
  },
};
const terms = blindLeakTerms(plumbing, { codename: "Project Keystone" });
const termText = terms.map((t) => t.text);

test("role phrases in staff facts never become identifiers", () => {
  const roles = [
    "Licensed Plumbers", "Plumbers", "Apprentice Plumbers", "Registered Massage Therapists", "Massage Therapists", "Therapists",
    "Certified Welders", "Welders", "Red Seal Electricians", "Red Seal", "Seal", "Electricians", "Journeyman Pipefitters",
    "Pipefitters", "Early Childhood Educators", "Early Childhood", "Childhood", "Customer Service Representatives",
    "Heavy Equipment Operators", "Heavy Equipment", "Equipment", "Line Cooks", "Tradesmen", "Service Technicians",
    "Lead Plumber", "Master Electrician", "Office Manager",
  ];
  for (const r of roles) assert.ok(!termText.includes(r), `role became a term: ${r} — ${termText.join(" | ")}`);
});

test("the people next to those roles are still identifiers", () => {
  for (const p of ["Sandra Lee", "Tom Baker", "Priya Natarajan", "Natarajan", "Anita Patel", "Patel", "Marcus Rogers", "Rogers", "Bill"]) {
    assert.ok(termText.includes(p), `missing person ${p}: ${termText.join(" | ")}`);
  }
});

test("surnames that look like roles are still people", () => {
  const t = texts({
    businessName: "X Corp",
    extractedInfo: { keyEmployees: "Karin Lindqvist (controller), Dr. Erik Holmquist, John Baker, Sarah Mason, Office Manager Émilie Tremblay" },
  });
  for (const p of ["Karin Lindqvist", "Lindqvist", "Erik Holmquist", "Holmquist", "John Baker", "Sarah Mason", "Émilie Tremblay", "Tremblay"]) {
    assert.ok(t.includes(p), `missing ${p}: ${t.join(" | ")}`);
  }
});

test("a blind team section can say what the team does", () => {
  const blindCopy =
    "Our Team of Licensed Plumbers: four licensed plumbers and two apprentice plumbers, led by the Lead Plumber. " +
    "Six Registered Massage Therapists, CERTIFIED WELDERS and Red Seal Electricians round out the crew; the Office Manager " +
    "has 10+ years' tenure. The business serves a mid-sized city in Ontario.";
  assert.deepEqual(findBlindLeaks(blindCopy, terms), []);
});

test("the dental deal's own roles stay allowed (no regression)", () => {
  const dental = {
    businessName: "Harbourline Dental",
    extractedInfo: {
      keyEmployees: "Dr. Anita Patel (principal dentist), Dr. Marcus Lee (associate dentist, 6 years), Sandra (office manager, since 2013)",
      hygienistDetails: "Two hygienists: Priya (7 years tenure), Sam (2 years tenure).",
      staffBreakdown: "Registered Dental Hygienists: 2, Certified Dental Assistants: 3, Office Manager",
    },
  };
  const t = texts(dental);
  for (const p of ["Anita Patel", "Patel", "Marcus Lee", "Sandra", "Priya", "Sam"]) assert.ok(t.includes(p), `missing ${p}`);
  for (const r of ["Registered Dental Hygienists", "Dental Hygienists", "Hygienists", "Certified Dental Assistants", "Assistants"]) {
    assert.ok(!t.includes(r), `role became a term: ${r}`);
  }
});

// ── 2. Any case, any spelling ────────────────────────────────────────────
console.log("case, accents and spacing");

test("KITCHENER / kitchener / Kitchener are all the city", () => {
  for (const s of ["Our clinic in KITCHENER", "based in kitchener, ontario", "Kitchener-Waterloo region", "KITCHENER'S busiest plaza"]) {
    assert.ok(findBlindLeaks(s, terms).includes("KITCHENER"), s);
  }
});

test("people match in any case", () => {
  assert.ok(findBlindLeaks("MEET ANITA PATEL", terms).includes("Anita Patel"));
  assert.ok(findBlindLeaks("owner anita patel", terms).includes("Anita Patel"));
  assert.ok(findBlindLeaks("PATEL FAMILY PRACTICE", terms).includes("Patel"));
  assert.ok(findBlindLeaks("natarajan", terms).includes("Natarajan"));
});

test("accents, punctuation, line breaks and invisible characters don't hide a name", () => {
  const quebec = { businessName: "Boulangerie Ste-Foy", extractedInfo: { city: "Montréal", ownerName: "Zoë Brodeur-Lefèvre", staff: "Søren Åberg (baker, 3 years)" } };
  const q = blindLeakTerms(quebec);
  assert.ok(findBlindLeaks("a bakery in MONTREAL", q).length > 0, "accent-free capitals");
  assert.ok(findBlindLeaks("a bakery in montréal", q).length > 0, "lowercase with accent");
  assert.ok(findBlindLeaks("founded by zoe brodeur lefevre", q).length > 0, "no accents, no hyphen");
  assert.ok(findBlindLeaks("SOREN ABERG runs the ovens", q).length > 0, "ø and å folded");
  assert.ok(findBlindLeaks("Kitch­ener​ clinic", terms).includes("KITCHENER"), "soft hyphen / zero-width space");
  assert.ok(findBlindLeaks("Anita\n  Patel", terms).includes("Anita Patel"), "a line break inside a name");
  assert.ok(findBlindLeaks({ cards: [{ label: "SANDRA   LEE" }] }, terms).includes("Sandra Lee"), "walks layoutData");
  assert.equal(foldForMatch("Zoë  Brodeur-Lefèvre"), "zoe brodeur lefevre");
});

test("a lowercase city fact is still a place", () => {
  const t = blindLeakTerms({ businessName: "X Corp", extractedInfo: { city: "guelph" } });
  assert.ok(findBlindLeaks("Located in GUELPH", t).length > 0);
});

// ── 3. Everyday-word names ───────────────────────────────────────────────
console.log("everyday words");

test("a street or first name that is an everyday word is caught capitalised, not as the word", () => {
  assert.ok(findBlindLeaks("on Market Street", terms).includes("Market"));
  assert.ok(findBlindLeaks("ON MARKET STREET", terms).includes("Market"));
  assert.deepEqual(findBlindLeaks("a strong local market for plumbing services", terms), []);
  assert.ok(findBlindLeaks("Bill runs dispatch", terms).includes("Bill"));
  assert.ok(findBlindLeaks("BILL RUNS DISPATCH", terms).includes("Bill"));
  assert.deepEqual(findBlindLeaks("customers pay the bill within 30 days", terms), []);
  // Not an everyday word: lowercase counts.
  assert.ok(findBlindLeaks("the guelph location", terms).includes("Guelph"));
});

// ── 4. Every consumer uses the same matcher ─────────────────────────────
console.log("Q&A sharing");

test("a Q&A row naming the city in capitals is kept from Blind readers; a role word isn't a leak", () => {
  const leak = { question: "WHERE IS THE SHOP?", aiAnswer: "It is in KITCHENER.", publishedAnswer: null };
  const roles = { question: "How many licensed plumbers are on staff?", aiAnswer: "Four Licensed Plumbers and two Apprentice Plumbers.", publishedAnswer: null };
  assert.equal(qaTextIsBlindSafe(leak, terms), false);
  assert.equal(qaTextIsBlindSafe({ ...leak, aiAnswer: "It is in kitchener." }, terms), false);
  assert.equal(qaTextIsBlindSafe(roles, terms), true);
});

console.log(`\n${passed} checks passed`);
