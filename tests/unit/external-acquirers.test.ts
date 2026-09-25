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
} from "../../server/matching/external-acquirers";
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

// Clipped at a sentence or word boundary, never mid-word.
assert.equal(clip("Short.", 50), "Short.");
assert.equal(clip("First sentence here. Second sentence that is long.", 30), "First sentence here.");
assert.equal(clip("one two three four five six", 12), "one two…");

console.log("external-acquirers: all assertions passed");
