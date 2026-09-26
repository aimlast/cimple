/**
 * QA harvest round V (r2) — the blind guard must not hold back what a Blind
 * CIM is allowed to say. No database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/blind-guard-precision-v.test.ts
 *
 * From the live check of the round-1 guard (2026-09-26):
 *   1. "Alberta" became a person on both Alberta demo deals (an accountant's
 *      address "…Leduc, Alberta T9E 6W3"; Alberta is also a given name), so
 *      "An Alberta-based fabricator" and "Alberta's energy sector" were held
 *      back, the outside-buyer brief read "a key person-based buyer", and
 *      "Alberta College of Physiotherapists" became a person.
 *   2. Counterparty names turned ordinary words into identifiers: "Midwest"
 *      (supplier "Midwest Polymer"), "Maritime" (client "Maritime Smiles"),
 *      the MSP's tools (NinjaOne RMM, SentinelOne EDR, Datto, Fortinet, IT
 *      Glue), "WCB-Alberta", "Target" (→ a "Target Market" heading), a
 *      brand's dealer programme ("Northaire Premier Dealer").
 *   3. Prose reading made "Jan-May YTD" a person (Jan and May are given
 *      names), so "YTD" held back any financial section; a chart row named
 *      "Shop supervision & QC" became "Ms. QC".
 *   4. registryIdsIn read dates as numbers: "Registration on 2019-05-12",
 *      "Permit on 2021-03-01", "PST 2023 2024".
 *   5. Found while re-checking every stored blind CIM: "Warehouse" and
 *      "Truck" (the site labels in "Warehouse and cross-dock facility: 19220
 *      Campbell Ridge Drive") and "Landlord" (from "Landlord (Merivale
 *      Crossing Holdings) consent…") held back ordinary sections.
 * Every real identifier the round-1 guard caught must still be caught.
 */
import assert from "node:assert/strict";
import { blindLeakTerms, findBlindLeaks, maskRegionNames, organisationsIn, peopleInFact, registryIdsIn } from "../../shared/blind-guard";
import { dealBlindRegion } from "../../shared/cim-media";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const leaks = (s: string, terms: ReturnType<typeof blindLeakTerms>) => findBlindLeaks(s, terms);

// ── 1. Provinces and states that are also given names ──────────────────────
console.log("provinces and states that are also given names");

// Ridgeline's facts as stored (abridged).
const ridgeline = {
  businessName: "Ridgeline Metal Fabrication Inc.",
  industry: "Manufacturing",
  extractedInfo: {
    businessAddress: "2207 8 Street, Nisku, Alberta T9E 7Y9",
    accountantDetails:
      "Kwan & Brodeur LLP, Chartered Professional Accountants, 5012 - 50 Avenue, Suite 210, Leduc, Alberta T9E 6W3, phone 780-555-0177. Compilation engagement report dated March 24, 2023",
    shareholders: "Gord McAllister (85% voting common shares), Luis Ortega (15% voting common shares)",
    revenueByYear: { "2024": "$9,815,000", "2025": "$4,180,000 (Jan-May YTD, +8% vs prior year)" },
    keyFinancialNotes: "YTD 2025 (Jan-May) revenue $4.18M vs $3.8M+ same period 2024. Receivables: Larkspur pays at 45 days.",
  },
  employeeChart: [
    { name: "Mark Sokolowski", role: "QC manager & CWB welding supervisor" },
    { name: "Shop supervision & QC", role: "3 staff" },
    { name: "Estimating & detailing", role: "2 staff" },
  ],
};
const rt = blindLeakTerms(ridgeline);

test("the province in an address is never a person", () => {
  assert.ok(!rt.some((t) => /alberta/i.test(t.text)), rt.map((t) => t.text).join(" | "));
  assert.deepEqual(peopleInFact("Leduc, Alberta T9E 6W3", "people"), []);
  assert.deepEqual(peopleInFact("Calgary, Alberta T2P 0R4", "people"), []);
  assert.equal(maskRegionNames("in Georgia"), "in ~~~~~~~");
  assert.equal(maskRegionNames("Georgia-based"), "~~~~~~~-based");
  assert.equal(maskRegionNames("Atlanta, Georgia 30301"), "Atlanta, ~~~~~~~ 30301");
});

test("Blind CIMs may name the province however they phrase it", () => {
  for (const s of [
    "The Company is an Alberta-based structural steel fabricator.",
    "Alberta's energy sector drives roughly half of demand.",
    "Alberta: 78% of revenue",
    "Alberta Energy Exposure",
    "A 24,000 sq ft shop in Alberta serving customers across Alberta and Saskatchewan.",
  ]) assert.deepEqual(leaks(s, rt), [], s);
});

test("the business's own province is never a person, even without an address", () => {
  const t = blindLeakTerms({ businessName: "Acme Ltd", extractedInfo: { province: "Alberta", accountant: "Hollis LLP (contact: Alberta)" } });
  assert.ok(!t.some((x) => x.text === "Alberta"), t.map((x) => x.text).join(" | "));
});

test("a person named Georgia still counts; the state still doesn't", () => {
  const office = blindLeakTerms({ businessName: "Acme Ltd", extractedInfo: { officeManager: "Georgia" } });
  assert.deepEqual(leaks("Georgia runs the front office.", office), ["Georgia"]);
  assert.deepEqual(leaks("Occasional lanes into Georgia and Florida.", office), []);
  assert.deepEqual(leaks("A Georgia-based carrier bought a competitor.", office), []);
  // "officeManager" is a person's fact, never the business's premises.
  assert.equal(dealBlindRegion({ officeManager: "Georgia" }), null);
  // A surname that is a state is kept even where the business is (Joe Montana of Bozeman, Montana).
  const mt = blindLeakTerms({ businessName: "Big Sky Fencing LLC", extractedInfo: { ownerNames: "Joe Montana (100%)", location: "Bozeman, Montana" } });
  assert.ok(mt.some((x) => x.text === "Montana" && x.regionWord));
  assert.deepEqual(leaks("Montana stays two years as a consultant.", mt), ["Montana"]);
});

test("an institution named after a province is not a person", () => {
  assert.deepEqual(peopleInFact("All 11 physios hold Alberta College practice permits (verified annually by Dana).", "prose"), ["Dana"]);
  assert.deepEqual(peopleInFact("Victoria Hospital referrals", "prose"), []);
  assert.ok(peopleInFact("Georgia Wells (office manager)", "people").includes("Georgia Wells"));
});

// ── 2. Organisations ──────────────────────────────────────────────────────
console.log("organisations the business deals with");

const harborview = {
  businessName: "Harborview Managed IT Solutions Inc.",
  industry: "IT / Managed Services",
  extractedInfo: {
    keyClients:
      "Maritime Smiles Dental Group (14 clinics, $30,600 MRR), Harbour & Keel LLP ($14,200 MRR), Tallwood Mercer CPA LLP ($11,800 MRR)",
    contracts:
      "Maritime Smiles: 14-clinic dental group, $30,600/month, 3-year renewal sent March 2025; Nightwatch SOC (MDR partner): contract renews March 2026; ConnectWise PSA, NinjaOne RMM (since 2021), IT Glue, SentinelOne EDR, Nightwatch MDR, Datto backup, Fortinet firewalls",
    suppliers:
      "Kyle Brennan: NinjaOne (RMM - annual, renews July), Kyle Brennan: IT Glue (documentation - annual), Kyle Brennan: Datto (on-site backup appliances at 23 largest server sites), Kyle Brennan: Fortinet (standard firewall for every client site), Kyle Brennan: Microsoft CSP licensing via Atlantic Channel Distribution",
  },
};
const ht = blindLeakTerms(harborview);

test("the tools the business runs on and broad regions are not identifiers", () => {
  for (const s of [
    "The Company is a managed IT provider serving dental, legal and accounting offices across the Maritime provinces.",
    "The Company's service stack is built on NinjaOne RMM, SentinelOne EDR, Datto backup and Fortinet firewalls.",
    "Documentation lives in IT Glue; 24/7 MDR is subcontracted to a security operations centre.",
    "A leading MSP in the Maritimes, serving Atlantic Canada.",
  ]) assert.deepEqual(leaks(s, ht), [], s);
});

test("the clients are still identifiers", () => {
  for (const s of ["Maritime Smiles Dental Group is the largest client.", "Maritime Smiles renews in June.", "Harbour & Keel LLP is renewing early.", "Tallwood Mercer pays $11,800 a month."]) {
    assert.ok(leaks(s, ht).length > 0, s);
  }
});

test("a customer is never read as a tool", () => {
  // "backup" after a client's name in a customer fact describes what the business sells it.
  const t = blindLeakTerms({ businessName: "Acme IT Inc", extractedInfo: { keyClients: "Sandhu Orthodontics (backup and helpdesk, $7,400 MRR)" } });
  assert.ok(leaks("Sandhu Orthodontics is a top-10 client.", t).length > 0);
  assert.deepEqual(organisationsIn("Nightwatch SOC Inc. (MDR partner), Kestrel (backup appliances)", undefined, { tools: true }), []);
  assert.ok(organisationsIn("Kestrel (backup appliances)", undefined, { tools: false }).includes("Kestrel"));
});

test("a supplier named after a broad region counts by its full name only", () => {
  const t = blindLeakTerms({ businessName: "Great Lakes Precision Plastics, Inc.", extractedInfo: { resinSupplierConcentration: "Midwest Polymer ~38%, Keystone ~27%" } });
  assert.deepEqual(leaks("A Midwest injection molder serving customers across the Midwest.", t), []);
  assert.ok(leaks("Midwest Polymer supplies 38% of resin.", t).length > 0);
});

test("agencies, national retailers and dealer programmes are not counterparties", () => {
  const cw = blindLeakTerms({ businessName: "Clearwater Physiotherapy Inc.", extractedInfo: { customerPaymentSources: "Revenue collected from insurers, WCB-Alberta (Workers Compensation Board), and direct patient payments" } });
  assert.deepEqual(leaks("Revenue is collected from insurers and WCB-Alberta.", cw), []);
  const tg = blindLeakTerms({ businessName: "Sample Co Ltd", extractedInfo: { topCustomers: "Target (18% of revenue), Walmart (12%), Costco (9%)" } });
  assert.deepEqual(leaks("Target Market", tg), []);
  const nd = blindLeakTerms({ businessName: "Lakeshore Home Comfort Ltd.", extractedInfo: { supplierRebatePrograms: "Kestrel Bay HVAC Supply volume rebate ~$60K/year; Northaire Premier Dealer status (tied to company)" } });
  assert.deepEqual(leaks("The Company is a Northaire Premier Dealer.", nd), []);
  assert.ok(leaks("Kestrel Bay HVAC Supply is the main distributor.", nd).length > 0);
});

test("what a site or a counterparty IS is not an identifier; its name is", () => {
  const pac = blindLeakTerms({ businessName: "Pacific Coast Logistics Ltd.", extractedInfo: {
    facilityAddress: "Warehouse and cross-dock facility: 19220 Campbell Ridge Drive, Surrey; Truck yard and maintenance shop: 17865 Barnston Road, Surrey",
    locations: "Hillhurst clinic: 1402 Kensington Road NW",
  } });
  assert.deepEqual(leaks("Warehouse & Cross-Dock Facility", pac), []);
  assert.deepEqual(leaks("Truck Yard & Maintenance Shop", pac), []);
  for (const s of ["19220 Campbell Ridge Drive", "Barnston Road", "The Hillhurst clinic opened in 2009.", "Surrey"]) assert.ok(leaks(s, pac).length > 0, s);
  const bea = blindLeakTerms({ businessName: "Beacon Specialty Pharmacy Inc.", extractedInfo: {
    landlordChangeOfOwnershipApproval: "Landlord (Merivale Crossing Holdings) consent required under section 12.3",
    ltcContractTerms: "Master agreement with Maplecrest (multi-home operator). 11 of 14 homes use CareMAR electronic MAR; 3 small homes still use paper.",
  } });
  assert.deepEqual(leaks("Landlord consent is required for an assignment of the lease.", bea), []);
  assert.deepEqual(leaks("11 of 14 homes use CareMAR electronic MAR.", bea), []);
  assert.ok(leaks("Merivale Crossing Holdings is the landlord.", bea).length > 0);
  assert.ok(leaks("A master agreement with Maplecrest covers 14 homes.", bea).length > 0);
});

// ── 3. People read from prose ──────────────────────────────────────────────
console.log("people read from prose and staff lists");

test("a month range is a period, not a person", () => {
  assert.ok(!rt.some((t) => /YTD|Jan-May/.test(t.text)), rt.map((t) => t.text).join(" | "));
  assert.deepEqual(leaks("Revenue YTD 2025 (Jan-May) was $4.18M.", rt), []);
  assert.deepEqual(peopleInFact("April-May is the busiest period", "prose"), []);
  // A person named April or June is still a person.
  assert.ok(peopleInFact("April Nguyen (dispatcher)", "people").includes("April Nguyen"));
  assert.ok(peopleInFact("Staff: May Chen, June Park", "people").includes("June Park"));
});

test("a duty in a staff list's name slot is not a person", () => {
  assert.ok(!rt.some((t) => /QC|supervision|Estimating/.test(t.text)), rt.map((t) => t.text).join(" | "));
  assert.ok(leaks("Mark Sokolowski leads QC.", rt).length > 0);
  assert.ok(leaks("Gord McAllister founded the business; Larkspur pays at 45 days.", rt).length > 0);
});

// ── 4. Registration numbers ────────────────────────────────────────────────
console.log("registration numbers");

test("dates and years after a label are not identifiers", () => {
  for (const s of ["Registration on 2019-05-12 with the province.", "Permit on 2021-03-01 renewed.", "Licence to 2027-03-31.", "PST 2023 2024 remittances current.", "certificate on 2024-11-30", "GST 2022, 2023 and 2024 filed"]) {
    assert.deepEqual(registryIdsIn(s), [], s);
  }
  for (const s of ["Safety Certificate BC 20-487-316", "safety certificate 20-487-316", "USDOT 9318842", "Policy no. 7788123", "Licence No. 44721"]) {
    assert.ok(registryIdsIn(s).length > 0, s);
  }
});

console.log(`\nblind-guard-precision-v: ${passed} passed`);
