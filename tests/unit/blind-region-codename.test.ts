/**
 * Blind CIM location, placeholders, org chart ids and codenames — no database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/blind-region-codename.test.ts
 *
 * From the 2026-09-26 QA harvest:
 *   1. The redactor copied "[Province/State]" from its own prompt and moved a
 *      Hamilton business to the "Greater Toronto Area". The region is now
 *      computed from the premises facts and written into the prompt; a reply
 *      with a template placeholder is retried, and never served.
 *   2. Pacific's blind map was held back forever: "British Columbia (100%)"
 *      under provinceOfOperation ("ceO" inside the key) made "Columbia" a
 *      person, and province words in a street fact became street terms.
 *   3. Org charts with first names as node ids ("dave") always failed the
 *      guard — ids are now neutral (n1, n2…).
 *   4. The codename can be chosen, and must be blind-safe and unique.
 */
import assert from "node:assert/strict";
import { blindLeakTerms, blindPlaceholders, findBlindLeaks, maskRegionNames } from "../../shared/blind-guard";
import { buildBuyerCim } from "../../shared/cim-buyer-view";
import { addressFragments, dealBlindRegion } from "../../shared/cim-media";
import { layoutDataProblems, neutralOrgChartIds, resolveTwoColumnColumn, tidyGeneratedLayout } from "../../shared/cim-layouts";
import { normalizeFinancialTable } from "../../shared/financial-table";
import { redactOneSection, setRedactionModelForTests, type RedactionModel } from "../../server/cim/redaction-engine";
import { validateCodename } from "../../server/cim/codenames";
import type { CimSection, CimSectionOverride } from "../../shared/schema";

let passed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  const run = async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}`, err);
      throw err;
    }
  };
  pending.push(pending.length ? pending[pending.length - 1].then(run) : run());
}

// Pacific Coast Logistics' facts, as recorded on the demo deal.
const pacific = {
  id: "pac",
  businessName: "Pacific Coast Logistics Ltd.",
  industry: "Transportation & Logistics",
  blindCodename: "Project Coastline",
  extractedInfo: {
    location: "Surrey BC",
    headOffice: "19220 Campbell Ridge Drive, Surrey, BC V3Z 1K4",
    locationSite: "Surrey, British Columbia (head office … 19220 Campbell Ridge Drive; …)",
    locationProvince: "British Columbia",
    provinceOfOperation: "British Columbia (100%)",
    jurisdiction: "British Columbia",
    serviceArea: "Regional transportation from Surrey, British Columbia facility; Washington State lanes (Seattle, Spokane)",
    provincialTaxPayable: "$33,380 (British Columbia: 2% lower rate on $376,000)",
    ownerName: "Harjit S. Grewal",
    keyEmployees: "Manpreet Grewal (VP Operations), Diane Tremblay (Controller), Dave Kowalczyk (Shop Foreman)",
  },
};
const lakeshore = {
  businessName: "Lakeshore Home Comfort Ltd.",
  extractedInfo: {
    address: "240 Bayfront Commerce Drive, Hamilton ON L8H 0A7",
    location: "240 Bayfront Commerce Drive, Hamilton, Ontario",
    province: "Ontario",
    serviceArea: "Hamilton, Burlington, Stoney Creek and the Greater Toronto Area",
  },
};

function section(p: Partial<CimSection>): CimSection {
  return {
    id: "s1", dealId: "pac", sectionKey: "k", sectionTitle: "Title", order: 1, layoutType: "prose_highlight",
    layoutData: {}, aiDraftContent: null, aiLayoutReasoning: null, brokerEditedContent: null, sellerEditedContent: null,
    finalContent: null, brokerApproved: false, sellerApproved: false, isVisible: true, layoutOverride: null, charts: null,
    images: null, accessTier: "teaser", blindStaleAt: null, blindTitle: null, aiTask: null, contentHistory: null,
    createdAt: new Date(), updatedAt: new Date(), ...p,
  } as CimSection;
}
function override(p: Partial<CimSectionOverride>): CimSectionOverride {
  return { id: "o1", dealId: "pac", cimSectionId: "s1", mode: "blind", layoutData: {}, contentOverride: "", createdAt: new Date(), ...p } as CimSectionOverride;
}
const reply = (obj: unknown) => ({ text: JSON.stringify(obj), stopReason: "end_turn" });
function scripted(...replies: Array<ReturnType<typeof reply>>) {
  const calls: string[] = [];
  let i = 0;
  const model: RedactionModel = async (prompt) => {
    calls.push(prompt);
    return replies[Math.min(i++, replies.length - 1)];
  };
  return { calls, model };
}

console.log("region");
test("the blind region comes from the premises, not markets served", () => {
  assert.equal(dealBlindRegion(pacific.extractedInfo), "British Columbia, Canada");
  assert.equal(dealBlindRegion(lakeshore.extractedInfo), "Ontario, Canada");
  assert.equal(dealBlindRegion({ plantAddress: "4410 Commerce Pkwy, Toledo, OH 43612", serviceArea: "Michigan and Indiana OEMs" }), "Ohio, USA");
  assert.equal(dealBlindRegion({ serviceArea: "Surrey BC" }), null);
  assert.equal(dealBlindRegion({}), null);
});
test("an address's region segments are not identifying fragments", () => {
  const f = addressFragments("Surrey, BC, Canada");
  assert.deepEqual(f, ["surrey"]);
  assert.ok(addressFragments("1450 Lakeshore Rd E, Oakville, ON L6J 1L6").includes("oakville"));
});

console.log("identity guard and provinces");
test("a province in a location fact is never a leak term (acceptance)", () => {
  const terms = blindLeakTerms({ businessName: "Pacific Coast Logistics Ltd.", extractedInfo: { locationSite: pacific.extractedInfo.locationSite } });
  const texts = terms.map((t) => t.text);
  assert.ok(!texts.some((t) => /\b(?:British|Columbia)\b/.test(t)), texts.join(" | "));
  assert.ok(texts.includes("Surrey"), "the city is still caught");
  assert.ok(texts.includes("19220 Campbell Ridge Drive"), "the street is still caught");
  assert.deepEqual(findBlindLeaks("British Columbia, Canada", terms), []);
});
test("the whole Pacific fact base leaves the province alone and still catches city, street and people", () => {
  const terms = blindLeakTerms(pacific, { codename: pacific.blindCodename });
  assert.deepEqual(findBlindLeaks("Based in British Columbia, Canada, with Washington State lanes (Seattle, Spokane).", terms), []);
  const leaks = findBlindLeaks("Surrey head office on Campbell Ridge; Manpreet Grewal runs operations.", terms);
  assert.ok(leaks.includes("Surrey") && leaks.some((l) => /Campbell/.test(l)) && leaks.some((l) => /Grewal/.test(l)), leaks.join(","));
});
test("'provinceOfOperation' is not a people fact ('ceO' inside a key is not a CEO)", () => {
  const terms = blindLeakTerms({ businessName: "X Co", extractedInfo: { provinceOfOperation: "Ontario (100%)", ceoName: "Priya Raman" } });
  assert.ok(!terms.some((t) => /Ontario/.test(t.text)));
  assert.ok(terms.some((t) => t.text === "Priya Raman"), "a real CEO key still counts");
});
test("province names are masked only when they stand alone", () => {
  assert.equal(maskRegionNames("British Columbia (100%)"), "~~~~~~~~~~~~~~~~ (100%)");
  assert.equal(maskRegionNames("Ontario Plumbing Services"), "Ontario Plumbing Services");
  assert.equal(maskRegionNames("works in Saskatchewan now"), "works in ~~~~~~~~~~~~ now");
});

console.log("placeholders");
test("template placeholders are found; sanctioned ones and the section's own brackets are not", () => {
  assert.deepEqual(blindPlaceholders("Major Metropolitan Area, [Province/State], Canada"), ["[Province/State]"]);
  assert.deepEqual(blindPlaceholders({ note: "NSC [Province] certificate", a: "[Address Withheld] · [Contact Info Withheld]" }), ["[Province]"]);
  assert.deepEqual(blindPlaceholders("See note [A] below", "See note [A] below"), []);
  assert.deepEqual(blindPlaceholders("rates [sic] and [1]"), []);
});

console.log("redactor");
test("the prompt carries the computed region and no '[Province/State]' example", async () => {
  const run = scripted(reply({ sectionTitle: "Overview", layoutData: {}, contentOverride: "Project Coastline is based in British Columbia, Canada." }));
  setRedactionModelForTests(run.model);
  const s = section({ aiDraftContent: "Pacific Coast Logistics is based in Surrey, BC and runs Washington State lanes (Seattle, Spokane)." });
  await redactOneSection(s, pacific, "Project Coastline");
  assert.equal(run.calls.length, 1);
  assert.match(run.calls[0], /"British Columbia, Canada"/);
  assert.doesNotMatch(run.calls[0], /\[Province\/State\]|Major Metropolitan Area/);
  assert.match(run.calls[0], /Washington State lanes \(Seattle, Spokane\)/, "markets served are named as staying");
});
test("a redaction with '[Province]' is a failure and is retried with the region", async () => {
  const run = scripted(
    reply({ sectionTitle: "Compliance", layoutData: { note: "NSC [Province] certificate" }, contentOverride: "Operates under an NSC [Province] certificate." }),
    reply({ sectionTitle: "Compliance", layoutData: { note: "NSC British Columbia certificate" }, contentOverride: "Operates under an NSC British Columbia certificate." }),
  );
  setRedactionModelForTests(run.model);
  const r = await redactOneSection(section({ layoutType: "callout_list", layoutData: { note: "NSC BC 20-487-316" }, aiDraftContent: "Operates under NSC BC 20-487-316." }), pacific, "Project Coastline");
  assert.equal(run.calls.length, 2);
  assert.match(run.calls[1], /unfilled placeholders: \[Province\][\s\S]*"British Columbia, Canada"/);
  assert.equal(r.contentOverride, "Operates under an NSC British Columbia certificate.");
});
test("placeholders that never go away fail the section (held back, never served)", async () => {
  const bad = reply({ sectionTitle: "Cover", layoutData: {}, contentOverride: "Located in [City], [Province/State]." });
  const run = scripted(bad, bad, bad);
  setRedactionModelForTests(run.model);
  await assert.rejects(redactOneSection(section({ aiDraftContent: "Located in Surrey, BC." }), pacific, "Project Coastline"), /placeholders/);
  assert.equal(run.calls.length, 3, "one corrective retry plus one for placeholders");
});
test("the blind cover's name and place are set deterministically", async () => {
  const run = scripted(reply({ sectionTitle: "Cover", layoutData: { businessName: "Project Coastline", location: "Major Metropolitan Area, Canada", revenue: "$31,020,000" }, contentOverride: "" }));
  setRedactionModelForTests(run.model);
  const r = await redactOneSection(section({ layoutType: "cover_page", layoutData: { businessName: "Pacific Coast Logistics Ltd.", location: "Surrey, British Columbia", revenue: "$31,020,000" } }), pacific, "Project Coastline");
  assert.equal(r.layoutData.location, "British Columbia, Canada");
  assert.equal(r.layoutData.businessName, "Project Coastline");
  assert.equal(r.layoutData.revenue, "$31,020,000");
});
test("org chart ids are neutral before the AI sees them, and the result passes the guard", async () => {
  const orgData = {
    nodes: [
      { id: "tony", name: "Tony Moretti", role: "Owner" },
      { id: "dave", name: "Dave Kowalczyk", role: "Service Manager", reportsTo: "tony" },
      { id: "kevin", name: "Kevin O'Brien", role: "Installation Manager", reportsTo: "tony" },
    ],
  };
  const deal = { businessName: "Lakeshore Home Comfort Ltd.", extractedInfo: { owner: "Tony Moretti", keyEmployees: "Dave Kowalczyk (service), Kevin O'Brien (installs), Steve Marchetti" } };
  // The model keeps the ids it is sent and turns names into roles.
  const run = scripted(reply({
    sectionTitle: "Team",
    layoutData: { nodes: [
      { id: "n1", name: "The Owner", role: "Owner" },
      { id: "n2", name: "Service Manager", role: "Service Manager", reportsTo: "n1" },
      { id: "n3", name: "Installation Manager", role: "Installation Manager", reportsTo: "n1" },
    ] },
    contentOverride: "",
  }));
  setRedactionModelForTests(run.model);
  const r = await redactOneSection(section({ layoutType: "org_chart", layoutData: orgData }), deal, "Project Ember");
  assert.doesNotMatch(run.calls[0], /"(?:dave|kevin|tony)"/);
  assert.deepEqual(r.layoutData.nodes.map((n: any) => [n.id, n.reportsTo ?? null]), [["n1", null], ["n2", "n1"], ["n3", "n1"]]);
  assert.deepEqual(findBlindLeaks(r.layoutData, blindLeakTerms(deal as any, { codename: "Project Ember" })), []);
});

console.log("view room");
test("the blind map is served region-only for Pacific (never held back for 'Columbia')", () => {
  const map = section({
    id: "map", layoutType: "location_map", sectionTitle: "Locations",
    layoutData: { caption: "Both sites are in Surrey, BC.", blindMap: "region", locations: [{ label: "Head office", address: "Surrey, BC, Canada", note: "Campbell Heights industrial area" }] },
  });
  const o = override({ cimSectionId: "map", layoutData: { caption: "Both sites are in western Canada.", locations: [{ label: "Head office, cross-dock & truck yard", note: "Industrial area near the US border" }] } });
  const r = buildBuyerCim({ deal: pacific, accessLevel: "full", sections: [map], overrides: [o], media: [] });
  assert.equal(r.heldBack, 0, JSON.stringify(r.leakReasons));
  assert.equal(r.sections.length, 1);
  const data = r.sections[0].layoutData as any;
  assert.equal(data.locations[0].region, "British Columbia, Canada");
  assert.equal(data.regionOnly, true);
  assert.equal(data.caption, "Both sites are in western Canada.");
});
test("a blind section with a leftover placeholder is held back and reported with why", () => {
  const s = section({ id: "cov", layoutType: "cover_page", layoutData: { businessName: "Pacific Coast Logistics Ltd.", location: "Surrey, British Columbia" } });
  const o = override({ cimSectionId: "cov", layoutData: { businessName: "Project Coastline", location: "Major Metropolitan Area, [Province/State], Canada" } });
  const r = buildBuyerCim({ deal: pacific, accessLevel: "full", sections: [s], overrides: [o], media: [] });
  assert.equal(r.sections.length, 0);
  assert.deepEqual(r.leaked, ["cov"]);
  assert.match(r.leakReasons.cov, /\[Province\/State\]/);
});

console.log("codenames");
test("a codename must be blind-safe, name-like and unique", () => {
  const none = new Set<string>();
  assert.deepEqual(validateCodename(pacific, "  Project   Coastline ", none), { ok: true, codename: "Project Coastline" });
  const biz = validateCodename(pacific, "Pacific Coast Logistics", none);
  assert.equal(biz.ok, false);
  const city = validateCodename(pacific, "Project Surrey", none);
  assert.equal(city.ok, false);
  const owner = validateCodename(pacific, "Project Grewal", none);
  assert.equal(owner.ok, false);
  assert.equal(validateCodename(pacific, "[Project]", none).ok, false);
  assert.equal(validateCodename(pacific, "ab", none).ok, false);
  assert.equal(validateCodename(pacific, "Project Mosaic", new Set(["project mosaic"])).ok, false);
});

console.log("generated layout hygiene");
test("org chart ids become n1… with reportsTo following", () => {
  const d = neutralOrgChartIds({ nodes: [{ id: "dave", name: "A", role: "x" }, { id: "kevin", name: "B", role: "y", reportsTo: "dave" }, { id: "z", name: "C", role: "z", reportsTo: "ghost" }] });
  assert.deepEqual(d.nodes.map((n: any) => [n.id, n.reportsTo]), [["n1", undefined], ["n2", "n1"], ["n3", undefined]]);
});
test("a header row with figures keeps them (normaliser and generator)", () => {
  const t = normalizeFinancialTable({ headers: ["", "2024", "2025"], rows: [{ label: "Revenue", isSectionHeader: true, values: ["$5.9M", "$6.2M"] }, { label: "Operating expenses", isSectionHeader: true, values: [] }] });
  assert.equal(t.rows[0].isSectionHeader, false);
  assert.equal(t.rows[0].bold, true);
  assert.deepEqual(t.rows[0].cells, ["$5.9M", "$6.2M"]);
  assert.equal(t.rows[1].isSectionHeader, true, "a true header (no figures) stays a header");
  const g = tidyGeneratedLayout("financial_table", { rows: [{ label: "Revenue", isSectionHeader: true, values: ["$5.9M", "$6.2M"] }] });
  assert.equal((g.layoutData.rows as any[])[0].isSectionHeader, undefined);
  assert.equal((g.layoutData.rows as any[])[0].bold, true);
});
test("a scorecard of words is flagged and becomes highlight cards", () => {
  const data = { title: "Safety", items: [{ label: "NSC Safety Rating", score: "Satisfactory", description: "No open audits" }, { label: "OOS rate", score: "9.4%", benchmark: "Below national average" }] };
  assert.equal(layoutDataProblems("scorecard", data).length, 1);
  assert.deepEqual(layoutDataProblems("scorecard", { items: [{ label: "A", score: 80 }, { label: "B", score: "65" }] }), []);
  const t = tidyGeneratedLayout("scorecard", data);
  assert.equal(t.layoutType, "callout_list");
  assert.deepEqual((t.layoutData.items as any[])[1], { title: "OOS rate", badge: "9.4%", description: "Benchmark: Below national average." });
});
test("two-column placeholders are flagged and never printed", () => {
  const bad = { left: { content: "Long-term care is the backbone of the business with 14 homes." }, right: { content: "stats", layoutType: "icon_stat_row" } };
  assert.ok(layoutDataProblems("two_column", bad).some((p) => /right column/.test(p)));
  assert.equal(resolveTwoColumnColumn(bad.right), null);
  const t = tidyGeneratedLayout("two_column", bad);
  assert.deepEqual(t.layoutData.right, { content: "", layoutType: "prose" });
  const items = { title: "At a glance", content: [{ title: "Veterinary", description: "6 clinics" }] };
  assert.equal(resolveTwoColumnColumn(items)?.layoutType, "callout_list");
  const stats = { layoutType: "icon_stat_row", content: { stats: [{ label: "Homes", value: "14" }] } };
  assert.deepEqual(layoutDataProblems("two_column", { left: { content: "Some prose here for the left column." }, right: stats }), []);
});

Promise.all(pending).then(() => {
  setRedactionModelForTests(null);
  console.log(`\n${passed} checks passed`);
}).catch(() => process.exit(1));
