/**
 * Outside-buyer research — the brief sent to web search is blind, and the
 * structured list keeps every organisation the research backs.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/external-acquirers.test.ts
 */
import assert from "node:assert/strict";
import {
  blindBrief,
  blindFreeText,
  briefTerms,
  buildAcquirerList,
  clip,
  normaliseUrl,
  urlMatches,
  band,
  buildResearchBrief,
  checkAcquirerClaims,
  scrubProperNames,
  setAcquirerAiForTests,
} from "../../server/matching/external-acquirers";
import { applyClaimChecks, stripTracking } from "../../server/matching/claim-check";
import { regionInText } from "../../server/matching/regions";
import { parseHeadcount } from "../../server/matching/fact-numbers";
import { isBlindSafe } from "../../shared/blind-guard";

// ── 1. The brief is blind ─────────────────────────────────────────────────
const pacific: any = {
  id: "d1",
  businessName: "Pacific Coast Logistics Ltd.",
  industry: "Transportation & Logistics",
  subIndustry: "Regional trucking, port drayage & cross-dock warehousing",
  blindCodename: "Project Coastline",
  extractedInfo: {
    ownerNames: "Harjit Singh Grewal (60%), Surinder Kaur Grewal (15%), Manpreet Grewal (25%)",
    keyEmployees: "Manpreet Grewal (son, 38, runs operations), Diane (controller), Rajvir (dispatch)",
    location: "Delta, British Columbia",
    idealBuyer: "Larger company where son Manpreet stays as GM; Grewal family wants the Pacific Coast Logistics name kept; no earn-outs",
    revenueStreams: "Trucking ~80% of revenue, warehousing ~20%; Delta cross-dock serves Port of Vancouver",
    annualRevenue: "$31,020,000",
    ebitda: "$4.1M",
    employees: "148 (96 drivers + 52 staff)",
  },
};
const { brief, region } = blindBrief(pacific);
const terms = briefTerms(pacific);
assert.ok(!/manpreet/i.test(brief), brief);
assert.ok(!/grewal/i.test(brief), brief);
assert.ok(!/pacific coast/i.test(brief), brief);
assert.ok(!/\bdelta\b/i.test(brief), brief);
assert.ok(isBlindSafe(brief.replace(/British Columbia/g, ""), terms), brief);
assert.equal(region, "British Columbia");
assert.match(brief, /Region: British Columbia, Canada/);
// The preference itself survives (it is binding for the research).
assert.match(brief, /SELLER'S BUYER PREFERENCES \(binding\): Larger company/);
assert.match(brief, /no earn-outs/);
assert.match(brief, /Revenue: \$25M\+/);

// Family names that are not in any people fact are still caught in prose.
const loose: any = {
  businessName: "Maple & Main Café",
  industry: "Food service",
  extractedInfo: { idealBuyer: "An owner-operator; my daughter Priya would like to stay on. Dr. Okafor (landlord) must approve." },
};
const lb = blindBrief(loose).brief;
assert.ok(!/priya|okafor/i.test(lb), lb);

// A first name at the start of a sentence is still caught…
const lead: any = { ...pacific, extractedInfo: { ...pacific.extractedInfo, idealBuyer: "Manpreet stays on as GM. Buyer must keep the drivers." } };
const leadBrief = blindBrief(lead).brief;
assert.ok(!/manpreet/i.test(leadBrief), leadBrief);
// …while an everyday word the facts mis-list as a place ("Buyer") is left alone at a sentence start.
const oddTerm: any = { ...pacific, extractedInfo: { ...pacific.extractedInfo, locationSite: "Delta, British Columbia; Buyer tour booked", idealBuyer: "Buyer who will keep the drivers; no earn-outs" } };
assert.match(blindBrief(oddTerm).brief, /PREFERENCES \(binding\): Buyer who will keep the drivers/);

// A name right after its role is simply dropped.
const cafe: any = { businessName: "Maple & Main Café", industry: "Food service", extractedInfo: { keyEmployees: "Rosa Delgado (head baker, 11 yrs)", idealBuyer: "Someone who will treat head baker Rosa well; keeps from-scratch baking" } };
assert.match(blindBrief(cafe).brief, /treat head baker well; keeps from-scratch baking/);

// Text that can't be made blind is left out, never sent.
assert.equal(blindFreeText("", briefTerms(loose)), null);

// Franchise and brand names that look like people stay — they are the
// research's key signal and identify no single business (checker round 1).
for (const brand of ["Tim Hortons", "Wendy's", "Harvey's", "Mary Brown's Chicken", "Jack Astor's", "Mr. Lube", "Mr. Sub", "Dairy Queen", "Dr. Oetker", "Sally Beauty", "Edward Jones", "Ben Moss"]) {
  const franchise: any = {
    businessName: "Acme Test Co",
    industry: "Franchise",
    subIndustry: `${brand} franchise`,
    extractedInfo: { location: "Halifax, Nova Scotia", revenueStreams: `${brand} franchise sales`, idealBuyer: `Approved ${brand} franchise operator; son Manpreet stays on` },
  };
  const fb = blindBrief(franchise).brief;
  assert.ok(fb.includes(`Industry: Franchise — ${brand} franchise`), fb);
  assert.ok(fb.includes(`Services / revenue streams: ${brand} franchise sales`), fb);
  assert.ok(fb.includes(`PREFERENCES (binding): Approved ${brand} franchise operator; the owner’s son stays on`), fb);
  assert.ok(!/key person/.test(fb), fb);
}
// A brand followed by a franchise word is a brand even when the label doesn't name it,
// and every later mention of it in the same text is too.
const noLabel: any = { businessName: "Acme Test Co", industry: "Automotive", extractedInfo: { idealBuyer: "Mr. Lube franchisee preferred; Mr. Lube must approve the buyer. Dr. Patel (landlord) must consent." } };
const nb = blindBrief(noLabel).brief;
assert.match(nb, /Mr\. Lube franchisee preferred; Mr\. Lube must approve the buyer\. A key person \(landlord\) must consent\./);
// People are still people: with a relation word, without a franchise word, or in a brand deal.
const people: any = { businessName: "Acme Test Co", industry: "Franchise", subIndustry: "Wendy's franchise", extractedInfo: { idealBuyer: "A Wendy's operator who keeps Maria Gonzalez as GM and lets daughter Wendy stay" } };
const pb = blindBrief(people).brief;
assert.ok(!/maria|gonzalez/i.test(pb), pb);
assert.ok(!/daughter Wendy/.test(pb), pb);
assert.match(pb, /A Wendy's operator who keeps a key person as GM/);
const branchMgr: any = { businessName: "Acme Test Co", industry: "Retail", extractedInfo: { idealBuyer: "Buyer who keeps Maria as branch manager and Priya's restaurant staff" } };
const bm = blindBrief(branchMgr).brief;
assert.ok(!/maria|priya/i.test(bm), bm);
// The deal's own terms still win: a business named after its brand keeps it hidden.
const ownBrand: any = { businessName: "Tim Hortons Bedford", industry: "Franchise", subIndustry: "Tim Hortons franchise", extractedInfo: { location: "Bedford, Nova Scotia", idealBuyer: "Approved Tim Hortons franchisee" } };
const ob = blindBrief(ownBrand).brief;
assert.ok(!/tim hortons|bedford/i.test(ob), ob);

// ── 2. URLs compare normalised ────────────────────────────────────────────
assert.equal(normaliseUrl("https://www.mullen-group.com/"), normaliseUrl("http://mullen-group.com"));
assert.equal(normaliseUrl("https://WWW.Mullen-Group.com/news/?utm=1#x"), "mullen-group.com/news");
assert.ok(urlMatches("https://www.mullen-group.com/", ["http://mullen-group.com"]));
assert.ok(urlMatches("mullen-group.com", ["https://www.mullen-group.com/acquisitions/2024"]));
assert.ok(!urlMatches("https://mullen.example.com", ["https://www.mullen-group.com/"]));

// ── 3. Structured list: cited by number, normalised, unverified kept ─────
const sourceList = [
  "https://www.mullen-group.com/acquisitions/",
  "https://canadacartage.com/news/acquires-x?ref=feed",
  "https://www.fastfrate.com/about/",
];
const research =
  "Mullen Group has acquired several BC carriers. Canada Cartage bought a drayage firm in 2024. Fastfrate Group expanded its cross-dock network. TFI International is also active.";
const out = buildAcquirerList(
  {
    acquirers: [
      { name: "Mullen Group", type: "strategic", whyInterested: "Serial acquirer of western carriers.", evidence: ["Bought 3 BC carriers"], sourceRefs: [1] },
      { name: "Canada Cartage", type: "strategic", whyInterested: "Adds drayage.", evidence: [], sourceRefs: [], sources: ["http://canadacartage.com/news/acquires-x"] },
      { name: "Fastfrate Group", type: "strategic", whyInterested: "Cross-dock growth.", evidence: [], sourceRefs: [3] },
      { name: "TFI International", type: "strategic", whyInterested: "Large consolidator.", evidence: [], sourceRefs: [] },
      { name: "Invented Holdings", type: "other", whyInterested: "Made up.", evidence: [], sourceRefs: [9] },
    ],
    note: "Buyers who let Manpreet stay on fit best.",
  },
  { mode: "web", sourceList, researchText: research, citedText: "", terms },
);
const names = out.results.map((r) => r.name);
assert.deepEqual(names.slice(0, 3), ["Mullen Group", "Canada Cartage", "Fastfrate Group"]);
assert.equal(out.results[0].sources[0], sourceList[0]);
assert.equal(out.results[1].sources[0], "http://canadacartage.com/news/acquires-x");
// Named in the research but uncited → kept, flagged.
const tfi = out.results.find((r) => r.name === "TFI International");
assert.ok(tfi && tfi.unverified, "TFI kept as unverified");
assert.ok(!out.results.some((r) => r.name === "Invented Holdings"));
assert.equal(out.droppedCount, 1);
assert.ok(out.note && !/manpreet/i.test(out.note), String(out.note));

// Knowledge mode keeps model-listed organisations without a search.
const km = buildAcquirerList(
  { acquirers: [{ name: "X Corp", type: "strategic", whyInterested: "y", evidence: [], sourceRefs: [], sources: ["https://x.com"] }] },
  { mode: "knowledge", sourceList: [], researchText: "", citedText: "" },
);
assert.equal(km.results.length, 1);

// Entries about OTHER companies are kept as researched (a shared city name
// like "Delta" in an acquirer's history is a fact, not a leak).
const shared = buildAcquirerList(
  { acquirers: [{ name: "Canada Cartage", type: "strategic", whyInterested: "Bought a Delta, BC drayage firm.", evidence: ["Delta terminal, 2024"], sourceRefs: [1] }] },
  { mode: "web", sourceList, researchText: "Canada Cartage", citedText: "", terms },
);
assert.equal(shared.results[0].whyInterested, "Bought a Delta, BC drayage firm.");

// A surname that is also a state (the blind guard's `regionWord` terms, from
// the cimblind stream) stays an identifier in the brief: the person is
// neutralised, the place is kept, and the Region line is not read as a name.
const montana: any = {
  id: "d9",
  businessName: "Big Sky Fencing LLC",
  industry: "Construction",
  subIndustry: "Residential & ranch fencing",
  extractedInfo: {
    ownerNames: "Joe Montana (100%)",
    location: "Bozeman, Montana",
    idealBuyer: "Someone who keeps the crew; Montana stays two years as a consultant; customers in Montana and Wyoming",
    annualRevenue: "$2,400,000",
  },
};
const mTerms = briefTerms(montana);
assert.ok(mTerms.some((t) => t.text === "Montana" && t.regionWord), JSON.stringify(mTerms));
const mb = blindBrief(montana).brief;
assert.match(mb, /Region: Montana, United States/);
assert.match(mb, /customers in Montana and Wyoming/);
assert.ok(!/Montana stays/.test(mb), mb);
assert.ok(!/Joe/.test(mb), mb);

// Clipped at a sentence or word boundary, never mid-word.
assert.equal(clip("Short.", 50), "Short.");
assert.equal(clip("First sentence here. Second sentence that is long.", 30), "First sentence here.");
assert.equal(clip("one two three four five six", 12), "one two…");

// ── 5. Round V: customer names, headcount, region, revenue prose, provenance ──
async function roundV() {
  // Customer names in revenue streams never reach the brief (Beacon, Maple & Main).
  const beacon: any = {
    businessName: "Beacon Specialty Pharmacy Inc.",
    industry: "Pharmacy",
    subIndustry: "Independent community pharmacy with LTC services",
    location: "Ottawa, Ontario",
    extractedInfo: {
      revenueStreams: "Long-term care home dispensing (14 homes, 1,046 beds; Maplecrest 5 homes ~41% of LTC revenue), community/retail dispensing, compounding",
      employees: "Key personnel mentioned: Daniel Okafor (LTC lead pharmacist, since 2014), Mei-Lin (compounding pharmacist, since 2018). Total headcount 23 (incl. owner).",
      annualRevenue: "$9,120,400 (FY2024)",
    },
  };
  const bb = blindBrief(beacon).brief;
  assert.ok(!/maplecrest/i.test(bb), bb);
  assert.match(bb, /14 homes, 1,046 beds; a named client 5 homes ~41% of LTC revenue/);
  assert.match(bb, /Employees: 10–24/, bb);
  assert.ok(!/2014|2,014/.test(bb), bb);
  assert.match(bb, /Region: Ontario, Canada/);
  assert.match(bb, /Revenue: \$5M–\$10M/);
  const maple: any = {
    businessName: "Maple & Main Café", industry: "Food service", location: "Guelph, Ontario",
    extractedInfo: { revenueStreams: "Coffee (~40%); wholesale baking to 3 accounts (Hartwell's grocer, Speedvale Book Nook café, Clair Road co-op); seasonal Christmas pies; Saturday farmers market May-Thanksgiving", employees: "7 employees (not counting owner)" },
  };
  const mbr = blindBrief(maple).brief;
  assert.ok(!/hartwell|speedvale|book nook|clair/i.test(mbr), mbr);
  assert.match(mbr, /Christmas pies; Saturday farmers market May-Thanksgiving/, mbr);
  assert.match(mbr, /Employees: under 10/);

  // Region from the deal's own location, US state codes and known cities.
  const clearwater: any = { businessName: "Clearwater Physiotherapy & Wellness Inc.", industry: "Healthcare", location: "Calgary, Alberta", extractedInfo: { leaseAddress: "Hillhurst: 2217 Wexford Ave NW; Seton: 118 Hollowbrook Gate SE", annualRevenue: "$3,318,600 (FY2024, year ended December 31, 2024); FY2023 $3,082,400", employees: "22 total: 11 physiotherapists, 6 RMTs, 5 admin staff" } };
  const cb = blindBrief(clearwater).brief;
  assert.match(cb, /Region: Alberta, Canada/, cb);
  assert.match(cb, /Employees: 10–24/, cb);
  assert.ok(!/calgary|hillhurst|seton|wexford/i.test(cb), cb);
  const greatLakes: any = { businessName: "Great Lakes Precision Plastics, Inc.", industry: "Manufacturing", extractedInfo: { location: "Toledo, OH", annualRevenue: "2024 net sales: $58,241,630, up approximately 6.5% year-over-year. 2025 budget: $61.5 million", employees: "212 employees plus 12-15 temporary workers depending on week" } };
  const gb = blindBrief(greatLakes).brief;
  assert.match(gb, /Region: Ohio, United States/, gb);
  assert.match(gb, /Revenue: \$25M\+/, gb);
  assert.match(gb, /Employees: 100–249/, gb);
  assert.ok(!/toledo/i.test(gb), gb);
  assert.equal(regionInText("Calgary")?.region, "Alberta");
  assert.equal(regionInText("Toledo")?.region, "Ohio");
  assert.equal(regionInText("Austin, TX 78701")?.country, "United States");
  assert.equal(regionInText("Unit 3, 1742 Merivale Road, Ottawa ON K2G 4A1")?.region, "Ontario");
  assert.equal(regionInText("somewhere nice"), null);
  assert.equal(band("2024 net sales: $58,241,630"), "$25M+");
  assert.equal(band("$1.2 million in 2023"), "$1M–$2M");
  assert.equal(band("about 2019"), null);
  assert.equal(parseHeadcount("148 (96 drivers + 52 staff, Dec 31, 2024)"), 148);
  assert.equal(parseHeadcount("36 employees plus owner (37 total)"), 37);
  assert.equal(parseHeadcount("5 year-round employees plus 14 seasonal employees. Total peak season: 19 employees."), 19);
  assert.equal(parseHeadcount("Owner since 2014"), null);

  // Facts only a broker-only source asserted never shape the brief.
  const crm: any = {
    businessName: "Acme Test Co", industry: "Manufacturing", location: "Hamilton, Ontario",
    extractedInfo: {
      idealBuyer: "Strategic acquirer only — seller hates PE",
      annualRevenue: "$40M",
      revenueStreams: "Contract machining",
      _fieldSources: {
        idealBuyer: { source: "crm", documentId: "doc-crm" },
        annualRevenue: { source: "document", documentId: "doc-private", brokerOnly: true },
        revenueStreams: { source: "interview" },
      },
    },
  };
  const crmBrief = blindBrief(crm).brief;
  assert.ok(!/PREFERENCES|hates PE/.test(crmBrief), crmBrief);
  assert.ok(!/Revenue:/.test(crmBrief), crmBrief);
  assert.match(crmBrief, /Services \/ revenue streams: Contract machining/);

  // The proper-name net keeps ordinary words, acronyms, provinces and brands.
  assert.equal(scrubProperNames("Wholesale to Hartwell's grocer and LTC homes in Ontario", "a named client"), "Wholesale to a named client’s grocer and LTC homes in Ontario");
  assert.equal(scrubProperNames("Compounding (human and veterinary); Maplecrest 5 homes", "a named client"), "Compounding (human and veterinary); a named client 5 homes");
  assert.equal(scrubProperNames("Someone who will treat the head baker well", "a named company"), "Someone who will treat the head baker well");

  // The AI rewrite is used when present; the brief's checks still run on it.
  let seen: any = null;
  setAcquirerAiForTests(async (params: any) => {
    seen = params;
    return { content: [{ type: "tool_use", name: "generic_lines", input: { businessType: null, revenueStreams: "Long-term care dispensing to 14 homes (1,046 beds); the largest client group (5 homes) is ~41% of LTC revenue", idealBuyer: null } }] };
  });
  const rewritten = await buildResearchBrief(beacon);
  assert.match(rewritten.brief, /the largest client group \(5 homes\) is ~41% of LTC revenue/);
  assert.ok(seen && JSON.stringify(seen.messages).includes("Maplecrest"), "the model sees the fact to rewrite");
  // A rewrite that still names the business is caught by the deterministic guard.
  setAcquirerAiForTests(async () => ({ content: [{ type: "tool_use", name: "generic_lines", input: { businessType: null, revenueStreams: "Beacon Specialty Pharmacy's LTC dispensing", idealBuyer: null } }] }));
  const leaky = await buildResearchBrief(beacon);
  assert.ok(!/beacon/i.test(leaky.brief), leaky.brief);
  // AI down → the facts scrubbed deterministically.
  setAcquirerAiForTests(async () => { throw new Error("overloaded"); });
  const down = await buildResearchBrief(beacon);
  assert.ok(!/maplecrest/i.test(down.brief), down.brief);

  // ── 6. Claims are checked against the cited text ─────────────────────────
  const tfi: any = {
    name: "TFI International Inc.", type: "strategic", website: "www.tfiintl.com", sources: ["https://www.freightwaves.com/news/manitoulin-acquires-british-columbia-trucking-firm-courier"],
    whyInterested: "TFI acquired Keystone Western in 2024. Manitoulin Group (a TFI company) acquired Diamond Delivery in 2021.",
    evidence: ["Acquired Keystone Western (Vancouver terminals), 2024", "Manitoulin Group (TFI company) acquired BC carrier Diamond Delivery, 2021"],
  };
  const kriska: any = { name: "Kriska Transportation", type: "strategic", sources: ["https://www.freightwaves.com/tag/kriska?utm_source=x"], whyInterested: "Kriska buys BC reefer carriers.", evidence: ["Acquired a BC reefer carrier in 2023"] };
  const mullen: any = { name: "Mullen Group", type: "strategic", sources: ["https://www.mullen-group.com/news"], whyInterested: "Mullen acquired BC carriers.", evidence: ["Acquired Argus Carriers, 2019"] };
  const channels = [
    { name: "Transportation finance lenders", how: "Speak to transport lenders' acquisition desks (e.g., Element Fleet Management, Northbridge Financial)" },
    { name: "Trucking association", how: "Post in the BC Trucking Association member bulletin (e.g., BC Trucking Association)" },
  ];
  const applied = applyClaimChecks(
    [tfi, kriska, mullen, { ...mullen, name: "Unchecked Co" }],
    [
      { claims: [{ id: "why", supported: false }, { id: "e1", supported: true }, { id: "e2", supported: false }], supportedWhy: "TFI acquired Keystone Western, a carrier with Vancouver terminals, in 2024." },
      { claims: [{ id: "why", supported: false }, { id: "e1", supported: false }], supportedWhy: null },
      { claims: [{ id: "why", supported: true }, { id: "e1", supported: true }] },
      null,
    ],
    channels,
    [{ keep: true, how: "Speak to transport lenders' acquisition desks (e.g., Element Fleet Management, Northbridge Financial)" }, null],
    "Element Fleet Management provides fleet financing … BC Trucking Association",
  );
  const [t, m, u] = applied.results;
  assert.equal(applied.results.length, 3, "Kriska: nothing backed → dropped");
  assert.equal(applied.droppedUnsupported, 1);
  assert.equal(t.name, "TFI International Inc.");
  assert.ok(!/manitoulin/i.test(`${t.whyInterested} ${(t.evidence ?? []).join(" ")}`), JSON.stringify(t));
  assert.deepEqual(t.evidence, ["Acquired Keystone Western (Vancouver terminals), 2024"]);
  assert.equal(t.claimsChecked, true);
  assert.equal(m.whyInterested, "Mullen acquired BC carriers.");
  assert.equal(u.claimsUnchecked, true);
  assert.equal(applied.unchecked, 1);
  assert.equal(applied.removedClaims, 4); // TFI why + e2, Kriska why + e1
  assert.match(applied.channels[0].how, /\(e\.g\. Element Fleet Management\)$/, applied.channels[0].how);
  assert.ok(!/Northbridge/.test(applied.channels[0].how));
  assert.equal(applied.channels[1].how, "Post in the BC Trucking Association member bulletin", "unchecked channel: examples dropped");
  assert.equal(stripTracking("https://www.freightwaves.com/tag/kriska?utm_source=x&utm_medium=y&page=2"), "https://www.freightwaves.com/tag/kriska?page=2");
  assert.equal(stripTracking("https://x.com/a?fbclid=1"), "https://x.com/a");

  // The checker call: excerpts per source, page fetch limited to the entry's own sites,
  // and a batch that fails leaves its entries marked unchecked (never silently trusted).
  const calls: any[] = [];
  setAcquirerAiForTests(async (params: any) => {
    calls.push(params);
    if (params.tools.some((t: any) => t.name === "report_channel_checks")) {
      return { content: [{ type: "tool_use", name: "report_channel_checks", input: { channels: [{ ref: "1", keep: true, how: "Speak to transport lenders' acquisition desks" }] } }] };
    }
    const payload = JSON.parse(params.messages[0].content.replace(/^[^\n]*\n/, ""));
    if (payload.some((e: any) => e.organisation === "Explodes Inc")) throw new Error("boom");
    return {
      content: [{ type: "tool_use", name: "report_claim_checks", input: { entries: payload.map((e: any) => ({ ref: e.ref, claims: e.claims.map((c: any) => ({ id: c.id, supported: !/Manitoulin/.test(c.text), reason: "x" })), supportedWhy: "TFI acquired Keystone Western in 2024." })) } }],
    };
  });
  const excerpts = new Map([["freightwaves.com/news/manitoulin-acquires-british-columbia-trucking-firm-courier", ["Manitoulin Group acquired Diamond Delivery"]]]);
  const five = [tfi, mullen, { ...mullen, name: "M2" }, { ...mullen, name: "M3" }, { ...mullen, name: "Explodes Inc" }];
  const checked = await checkAcquirerClaims(five, [channels[0]], { excerpts, corpus: "research text" });
  const claimCalls = calls.filter((c) => c.tools.some((t: any) => t.name === "report_claim_checks"));
  assert.equal(claimCalls.length, 2, "batches of 4");
  const fetchTool = claimCalls[0].tools.find((t: any) => t.name === "web_fetch");
  assert.ok(fetchTool && fetchTool.allowed_domains.includes("freightwaves.com") && fetchTool.allowed_domains.includes("mullen-group.com"), JSON.stringify(fetchTool));
  assert.ok(claimCalls[0].messages[0].content.includes("Manitoulin Group acquired Diamond Delivery"), "excerpts are sent");
  assert.equal(checked.results[0].whyInterested, "TFI acquired Keystone Western in 2024.");
  assert.deepEqual(checked.results[0].evidence, ["Acquired Keystone Western (Vancouver terminals), 2024"]);
  assert.equal(checked.results.find((r) => r.name === "Explodes Inc")?.claimsUnchecked, true);
  assert.equal(checked.channels[0].how, "Speak to transport lenders' acquisition desks");
  setAcquirerAiForTests(null);
}

roundV().then(
  () => console.log("external-acquirers: all assertions passed"),
  (err) => { console.error(err); process.exit(1); },
);
