/**
 * QA harvest round V — Blind CIM identity guard and chart rendering data.
 * No database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/blind-render-v.test.ts
 *
 * From the live verification of Pacific Coast Logistics (2026-09-26):
 *   1. The blind CIM served "USDOT 9318842" and "NSC BC 20-487-316" — a
 *      regulator's number names the company in one lookup. The guard now
 *      catches any labelled registration/licence/permit number, and the
 *      facts' own numbers in any format.
 *   2. The guard never saw the staff list (deals.employeeChart) or the
 *      customers, landlord and suppliers named in fact values ("Carlos Mendes",
 *      "Alderbrook", "Silvergate", "Doug Fairweather").
 *   3. Codenames "Project Alderbrook" (the largest customer) and "Project
 *      Dhillon" (the dispatch manager) were accepted.
 *   4. A codename rename left the old name after a paragraph break.
 *   5. A person named "Georgia" was no longer an identifier.
 *   6. Bar values written as text ("$13,560,000") drew as zero; a comparison
 *      table packed a 3-year series under a second "Metric" header.
 */
import assert from "node:assert/strict";
import { blindLeakTerms, findBlindLeaks, mapStrings, organisationsIn, registryIdsIn } from "../../shared/blind-guard";
import { buildBuyerCim } from "../../shared/cim-buyer-view";
import { carryCodename, pickCodename, validateCodename, CODENAMES } from "../../server/cim/codenames";
import {
  comparisonAsFinancialTable,
  comparisonPacksSeries,
  comparisonTableView,
  normalizeChartValues,
  parseChartNumber,
  unitScale,
} from "../../shared/cim-chart-values";
import { tidyGeneratedLayout } from "../../shared/cim-layouts";
import { finalizeLayoutData } from "../../server/cim/layout-engine";
import type { CimSection, CimSectionOverride } from "../../shared/schema";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// The Pacific facts that mattered, as they are stored.
const pacific = {
  businessName: "Pacific Coast Logistics Ltd.",
  blindCodename: "Project Coastline",
  industry: "Transportation & Logistics",
  employeeChart: [
    { name: "Harjit Grewal", role: "Founder & President (60% owner)", keyPerson: true },
    { name: "Rajvir Dhillon", role: "Dispatch Manager — 7 in dispatch & load planning", keyPerson: true },
    { name: "Carlos Mendes", role: "Warehouse Manager — 30 in warehouse", keyPerson: true },
    { name: "Tanya Beaulieu", role: "Safety & Compliance Manager — 2 in safety", keyPerson: false },
    { name: "Jason Whitlock", role: "Business Development Manager", keyPerson: false },
    { name: "Company drivers", role: "96 Class 1 drivers", keyPerson: false },
    { name: "Finance & administration", role: "4 staff", keyPerson: false },
  ],
  extractedInfo: {
    location: "Surrey BC",
    contracts: "Master agreement with Alderbrook (3-year term, renewed last year, goes to 2027)",
    keyCustomers: "Alderbrook Grocery Distributors Ltd.",
    customerConcentration: "Largest customer (Alderbrook) 22.0% of FY2024 revenue; top 5 = 47%, top 10 = 63.5%",
    contractRenewalStatus:
      "Alderbrook MSA runs to March 31, 2027 (renewed April 2024); Tidewater Beverage warehousing agreement expires June 30, 2026; Kestrel Building Supply rates reset January 2026",
    keyCustomerDetails: "Alderbrook (grocery distributor): customer since 2009, VP Doug Fairweather (personal relationship), 22.0% of FY2024 revenue",
    leaseDetails: "Warehouse: 110,000 sq ft, Campbell Heights, landlord Silvergate, 15-year term. Leasehold improvements of $64,200.",
    suppliers: "Westline (operating lease for 19 power units); Harmon Bains (accountant FY2022-2024, Ranjit Bains retired); Kaur Whitfield law firm (Amrit Kaur)",
    bankCredit: "Operating line of credit of $3,000,000 with Westshore Commercial Bank at prime + 0.75%",
    financialInstrumentsRisk: "Interest rate risk on operating line (floating rate).",
    safetyCredentials: "NSC BC 20-487-316 Satisfactory rating, Partners in Protection (CBSA) member since 2016, WorkSafeBC COR since 2019",
    businessNumber: "81234 5678 RC0001",
    incorporationNumber: "BC0571234",
    operationalSystems: "Payroll: Ceridian; Samsara (ELD, AI dash cams), Magaya WMS",
    targetMarket: "Food distribution and grocery; primarily Fraser Valley and Greater Vancouver area",
    expansionPlans: "Alberta expansion: small Calgary cross-dock to run own lanes",
    saleAdvisor: "Brassline Advisory Partners (engaged December 2, 2025)",
    referralSource: "Gary Lindqvist (previously sold a food distribution company through Morgan Ellis/Brassline)",
    vehicleFinancing: "13 vans paid off; owner's RAM 1500 and Maria's Lexus excluded from sale",
  },
};
const terms = blindLeakTerms(pacific, { codename: pacific.blindCodename });
const texts = terms.map((t) => t.text);

console.log("staff, customers, landlord, suppliers");

test("staff on the employee chart are identifiers", () => {
  for (const s of ["Carlos Mendes runs the 30-person warehouse team.", "Dispatch is led by Rajvir Dhillon.", "Mr. Dhillon", "Tanya Beaulieu", "Whitlock leads sales"]) {
    assert.ok(findBlindLeaks(s, terms).length > 0, `not caught: ${s}`);
  }
  // Group rows of the chart are not people.
  for (const g of ["Company drivers", "Finance & administration", "Company", "Finance"]) assert.ok(!texts.includes(g), `group row became a term: ${g}`);
});

test("customers, the landlord, lenders, advisers and suppliers named in facts are identifiers", () => {
  for (const s of [
    "Our largest customer, Alderbrook, renewed in 2024.",
    "Kestrel Building Supply is the second-largest account.",
    "Rates with Kestrel reset each January.",
    "The Tidewater warehousing agreement renews in 2026.",
    "The warehouse is leased from Silvergate.",
    "19 tractors are leased from Westline.",
    "The relationship with Doug Fairweather is personal.",
    "Banking is with Westshore Commercial Bank.",
    "Reviewed by Harmon Bains LLP.",
    "Legal: Kaur Whitfield.",
  ]) assert.ok(findBlindLeaks(s, terms).length > 0, `not caught: ${s}`);
});

test("ordinary capitalised words, national brands, places and the broker are not identifiers", () => {
  for (const w of ["Largest", "Interest", "Leasehold", "Master", "Warehouse", "Ceridian", "Samsara", "Magaya", "Lexus", "RAM", "Fraser Valley", "Alberta", "Greater Vancouver", "Brassline", "Brassline Advisory Partners", "Morgan Ellis", "Ellis", "Partners in Protection", "WorkSafeBC"]) {
    assert.ok(!texts.includes(w), `false identifier: ${w}`);
  }
  const clean =
    "Project Coastline serves grocery customers across the Fraser Valley and Greater Vancouver, with an Alberta expansion planned. " +
    "Largest customer share is 22%. Interest rate risk is limited. Leasehold improvements are modest. Drivers use Samsara ELD dash cams and Magaya WMS; " +
    "payroll runs on Ceridian. The owner's Lexus is excluded. The company holds a National Safety Code certificate with a Satisfactory rating, " +
    "a USDOT number for cross-border lanes, and has been a Partners in Protection member since 2016. Revenue reached $31,020,000 in FY2024; " +
    "adjusted EBITDA was $3,596,200 (11.6%) across 352 active accounts. Prepared with Brassline Advisory Partners; contact Morgan Ellis.";
  assert.deepEqual(findBlindLeaks(clean, terms), []);
});

test("organisationsIn reads the organisation, not the sentence around it", () => {
  assert.deepEqual(organisationsIn("Master agreement with Alderbrook (3-year term)"), ["Alderbrook"]);
  const k = organisationsIn("Kestrel Building Supply rates reset January 2026; Alderbrook VP Doug Fairweather");
  assert.ok(k.includes("Kestrel Building Supply") && k.includes("Kestrel") && k.includes("Alderbrook"), k.join(" | "));
  assert.ok(!k.some((x) => /January|VP|Doug/.test(x)), k.join(" | "));
  assert.deepEqual(organisationsIn("Primary equipment: Lennox (premium installs, authorized dealer), Mitsubishi (cold-climate heat pumps, HVAC Elite dealer)"), []);
  assert.deepEqual(organisationsIn("Customers in Calgary and Edmonton"), []);
});

console.log("registration, licence and permit numbers");

test("labelled public identifiers are caught in any text", () => {
  const hits = registryIdsIn(
    "USDOT 9318842 for Washington lanes. NSC BC 20-487-316, Satisfactory. MC-123456. CVOR 123-456-789. Business Number 81234 5678 RC0001. Licence No. 44721. Safety Certificate BC 20-487-316.",
  );
  for (const h of ["USDOT 9318842", "NSC BC 20-487-316", "MC-123456", "CVOR 123-456-789", "Business Number 81234 5678 RC0001", "Licence No. 44721"]) {
    assert.ok(hits.includes(h), `missed ${h}: ${hits.join(" | ")}`);
  }
  // Credentials without numbers, years, money and counts are fine.
  assert.deepEqual(
    registryIdsIn("Holds a USDOT number and an NSC certificate (Satisfactory). Licence 2019-2024 renewals. COR since 2019. Revenue $31,020,000; 22 FAST cards; Class 1 licence."),
    [],
  );
});

test("the guard catches identifiers from the text and the facts' own numbers in any format", () => {
  assert.deepEqual(findBlindLeaks('{"label":"U.S. DOT Number","value":"USDOT 9318842"}', terms), ["USDOT 9318842"]);
  assert.ok(findBlindLeaks("holds a National Safety Code certificate (NSC BC 20-487-316)", terms).length > 0);
  assert.ok(findBlindLeaks("Certificate 20 487 316 on file", terms).length > 0, "reformatted fact number");
  assert.ok(findBlindLeaks("Incorporated as BC0571234", terms).length > 0);
  assert.ok(findBlindLeaks("CRA 812345678", terms).length > 0);
  assert.ok(terms.some((t) => t.kind === "registry" && t.digits === "20487316"));
});

console.log("codenames");

test("codename validation rejects a customer, a staff surname and a landlord", () => {
  const none = new Set<string>();
  for (const bad of ["Project Alderbrook", "Project Dhillon", "Project Silvergate", "Project Mendes", "Project Kestrel"]) {
    const v = validateCodename(pacific, bad, none);
    assert.equal(v.ok, false, `accepted ${bad}`);
  }
  assert.equal(validateCodename(pacific, "Project Kingsway Harbour", none).ok, true);
  assert.equal(validateCodename(pacific, "Project Coastline", none).ok, true);
});

test("an automatic codename never names the deal's customers", () => {
  // Every name taken except two: Kestrel (a customer) must never be chosen.
  const taken = new Set(CODENAMES.map((c) => c.toLowerCase()).filter((c) => c !== "project kestrel" && c !== "project mosaic"));
  for (let i = 0; i < 20; i++) assert.equal(pickCodename(taken, pacific), "Project Mosaic");
});

test("a term that is also a codename word counts everywhere except the codename itself", () => {
  const t = blindLeakTerms(pacific, { codename: "Project Kestrel" });
  assert.deepEqual(findBlindLeaks("Project Kestrel is a regional carrier.", t), []);
  assert.ok(findBlindLeaks("Project Kestrel hauls for Kestrel Building Supply.", t).length > 0);
  assert.ok(findBlindLeaks("Rates with Kestrel reset each January.", t).length > 0);
});

test("a rename replaces the codename after a paragraph break, in data and text", () => {
  const r = {
    sectionTitle: "About Project Coastline",
    layoutData: { body: "…most profitable lanes.\n\nProject Coastline has built a strong position.", items: [{ title: "Project Coastline\nfleet", n: 3 }] },
    contentOverride: "Intro.\n\nProject Coastline grew.",
  };
  const c = carryCodename(r, "Project Coastline", "Project Kingsway Harbour");
  const all = JSON.stringify(c);
  assert.ok(!all.includes("Coastline"), all);
  assert.equal((c.layoutData as any).body, "…most profitable lanes.\n\nProject Kingsway Harbour has built a strong position.");
  assert.equal((c.layoutData as any).items[0].n, 3);
  // mapStrings keeps structure, numbers and keys.
  assert.deepEqual(mapStrings({ a: ["x", 1, null, { b: "y" }] }, (s) => s.toUpperCase()), { a: ["X", 1, null, { b: "Y" }] });
});

console.log("given names that are places");

test("a person named Georgia is an identifier where the text means the person", () => {
  const office = blindLeakTerms({ businessName: "Acme Ltd", extractedInfo: { officeManager: "Georgia" } });
  assert.ok(office.some((t) => t.text === "Georgia"), office.map((t) => t.text).join(" | "));
  assert.deepEqual(findBlindLeaks("Georgia runs the front office.", office), ["Georgia"]);
  assert.deepEqual(findBlindLeaks("Georgia (office manager, 12 years) runs the office.", office), ["Georgia"]);
  assert.deepEqual(findBlindLeaks("Occasional lanes into Georgia and Florida.", office), []);
  const staff = blindLeakTerms({ businessName: "Acme Ltd", extractedInfo: { keyEmployees: "Georgia (office manager, 12 years); Luis Ortega (foreman)" } });
  assert.deepEqual(findBlindLeaks("Georgia manages scheduling.", staff), ["Georgia"]);
  // A US state as the business's location is still not an identifier.
  const place = blindLeakTerms({ businessName: "Acme Ltd", extractedInfo: { state: "Georgia", city: "Macon" } });
  assert.ok(!place.some((t) => t.text === "Georgia"));
});

test("a blind section naming staff from the employee chart is held back", () => {
  const section = (id: string, body: string): CimSection => ({
    id, dealId: "d1", sectionKey: id, sectionTitle: "Team", order: 1, layoutType: "prose_highlight",
    layoutData: { body }, aiDraftContent: body, brokerEditedContent: null, isVisible: true, blindStaleAt: null,
  } as unknown as CimSection);
  const ov = (sid: string, body: string): CimSectionOverride => ({
    id: `o-${sid}`, dealId: "d1", cimSectionId: sid, mode: "blind", layoutData: { body }, contentOverride: body,
  } as unknown as CimSectionOverride);
  const cim = buildBuyerCim({
    deal: { id: "d1", ...pacific },
    accessLevel: "full",
    sections: [section("s1", "x"), section("s2", "y"), section("s3", "z")],
    overrides: [
      ov("s1", "Carlos Mendes runs the 30-person warehouse team."),
      ov("s2", "The Permits section: USDOT 9318842."),
      ov("s3", "A 30-person warehouse team is led by the Warehouse Manager."),
    ],
  });
  assert.deepEqual(cim.leaked.sort(), ["s1", "s2"]);
  assert.deepEqual(cim.sections.map((s) => s.id), ["s3"]);
});

console.log("chart values");

test("text chart values become numbers", () => {
  assert.equal(parseChartNumber("$13,560,000"), 13_560_000);
  assert.equal(parseChartNumber("C$6.21M"), 6_210_000);
  assert.equal(parseChartNumber("-$78K"), -78_000);
  assert.equal(parseChartNumber("−C$78,000"), -78_000);
  assert.equal(parseChartNumber("($78,000)"), -78_000);
  assert.equal(parseChartNumber("22%"), 22);
  assert.equal(parseChartNumber("4.6x"), 4.6);
  assert.equal(parseChartNumber("1,250 CAD"), 1250);
  assert.equal(parseChartNumber("$13.56M", unitScale("$M")), 13.56);
  for (const bad of ["4 → 5 → 3", "$1.1–1.2M", "1 minor", "FY2024", "n/a", ""]) assert.equal(parseChartNumber(bad), null, bad);
});

test("finalizeLayoutData coerces chart values (and keeps the unit)", () => {
  const today = new Date("2026-09-26T00:00:00Z");
  const hbar = finalizeLayoutData("horizontal_bar_chart", {
    data: [{ name: "Dry Van", value: "$13,560,000" }, { name: "Reefer", value: "$8,410,000" }],
    showPercentages: true,
  }, today) as any;
  assert.deepEqual(hbar.data.map((d: any) => d.value), [13_560_000, 8_410_000]);
  assert.equal(hbar.unit, "$");
  const line = normalizeChartValues("line_chart", { series: [{ key: "revenue", label: "Revenue" }], data: [{ name: "2024", revenue: "$31,020,000" }], unit: "$" }) as any;
  assert.equal(line.data[0].revenue, 31_020_000);
  const wf = normalizeChartValues("waterfall_chart", { items: [{ label: "Yard rent", value: "-$78,000", type: "subtract" }] }) as any;
  assert.equal(wf.items[0].value, -78_000);
  const two = normalizeChartValues("two_column", { left: { layoutType: "bar_chart", content: { data: [{ name: "a", value: "22%" }] } }, right: { layoutType: "prose", content: "x" } }) as any;
  assert.equal(two.left.content.data[0].value, 22);
});

console.log("comparison tables");

const safety = {
  title: "Three-Year Safety Metrics",
  leftLabel: "Metric",
  rightLabel: "2022 → 2023 → 2024",
  rows: [
    { label: "Reportable collisions", left: "Total incidents", right: "4 → 5 → 3" },
    { label: "Out-of-service rate", left: "Percent OOS", right: "15.5% → 16.9% → 9.4%", highlight: true },
    { label: "Injuries from collisions", left: "Time-loss claims", right: "0 → 1 minor → 0" },
  ],
};

test("a packed series becomes one column per year, with no duplicate 'Metric' header", () => {
  const v = comparisonTableView(safety);
  assert.equal(v.labelHeader, "Metric");
  assert.deepEqual(v.columns, ["2022", "2023", "2024"]);
  assert.deepEqual(v.rows[0], { label: "Reportable collisions", note: "Total incidents", cells: ["4", "5", "3"], highlight: false });
  assert.deepEqual(v.rows[1].cells, ["15.5%", "16.9%", "9.4%"]);
  // A normal comparison stays as it was.
  const n = comparisonTableView({ leftLabel: "This business", rightLabel: "Industry", rows: [{ label: "Margin", left: "12.6%", right: "8%" }] });
  assert.deepEqual(n.columns, ["This business", "Industry"]);
  assert.deepEqual(n.rows[0], { label: "Margin", cells: ["12.6%", "8%"], highlight: false });
});

test("a generated packed comparison table is saved as a financial table", () => {
  assert.equal(comparisonPacksSeries(safety), true);
  const t = tidyGeneratedLayout("comparison_table", safety);
  assert.equal(t.layoutType, "financial_table");
  assert.deepEqual(t.layoutData.headers, ["", "2022", "2023", "2024"]);
  assert.deepEqual((t.layoutData.rows as any[])[0], { label: "Reportable collisions — total incidents", values: ["4", "5", "3"] });
  const two = tidyGeneratedLayout("two_column", { left: { layoutType: "prose", content: "Some words about safety here." }, right: { title: "Trends", layoutType: "comparison_table", content: safety } });
  assert.equal((two.layoutData.right as any).layoutType, "financial_table");
  assert.deepEqual(comparisonAsFinancialTable(safety).headers, ["", "2022", "2023", "2024"]);
});

console.log(`\nblind-render-v: ${passed} passed`);
