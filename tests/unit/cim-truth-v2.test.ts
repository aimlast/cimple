/**
 * CIM content truth, QA-harvest round V, second pass (c-truth). The live checker found:
 *  - the earnings canon made the analysis bridge win over the broker's own resolved /
 *    recast figures, and the bridge was the figure in error on all three demo deals
 *    (Pacific $3,596,200 vs the broker's $3,900,000; Beacon $674,752 vs $780,052;
 *    Lakeshore SDE $1,273,000 vs $1,312,000);
 *  - the earnings reader took add-back amounts next to "EBITDA" as EBITDA, and missed
 *    "EBITDA (as reported)";
 *  - false alarms: history ("By 1998 …") as a passed target, a falling out-of-service
 *    rate "improved" called a fall, every he/she flagged, "Service" as a person;
 *  - relative-timeline facts dated from the reprocess, not the source;
 *  - the confidential Harvest Lane RFP got through: the regex missed most phrasings
 *    and the broker's private note ("keep out of CIM") was never used.
 * Figures and wording are the real ones from the demo deals (read-only probes).
 */
import assert from "node:assert/strict";
import { buildCimFinancials, knownBridges, renderCimFinancialsBlock } from "../../server/cim/cim-financials";
import { earningsCanon, earningsMentions, offCanon, screenEarningsFacts, canonLines } from "../../server/cim/earnings-canon";
import { assembleKnowledgeBase } from "../../server/cim/layout-engine";
import { checkSectionFigures, knownFiguresFrom } from "../../server/cim/figure-check";
import { hasConfidentialNote, holdConfidentialFacts, keepOutFromNotes, screenFactsForCim } from "../../server/cim/sensitive-facts";
import { keepOutFor, _setKeepOutModelForTests } from "../../server/cim/keep-out";
import { staleTargets } from "../../server/cim/fact-dates";
import { peopleOnFile } from "../../server/cim/prose-check";
import { buildDdContext } from "../../server/cim/dd-enrichment";

const today = new Date("2026-09-26T12:00:00Z");
const has = (issues: string[], re: RegExp, what: string) => assert.ok(issues.some((m) => re.test(m)), `${what}: ${issues.join(" | ")}`);
const lacks = (issues: string[], re: RegExp, what: string) => assert.ok(!issues.some((m) => re.test(m)), `${what}: ${issues.join(" | ")}`);
const broker = (keys: string[]) => ({ _fieldSources: Object.fromEntries(keys.map((k) => [k, { source: "broker", at: "2026-09-01T00:00:00Z" }])) });

// ── 1. Beacon: the broker's adjusted EBITDA overrules the bridge's subtotal; its SDE agrees ──
const beaconFin = buildCimFinancials({
  id: "b", version: 1, status: "reviewed", brokerReviewedAt: new Date(),
  reclassifiedPnl: {
    years: ["2023", "2024"],
    rows: [
      { id: "r", name: "Sales", category: "Revenue", values: { "2023": 8640200, "2024": 9120400 } },
      { id: "c", name: "Cost of sales", category: "COGS", values: { "2023": 5900000, "2024": 6200000 } },
      { id: "o", name: "Operating expenses", category: "Operating Expenses", values: { "2023": 2189330, "2024": 2260148 } },
    ],
  },
  normalization: {
    metric: "sde",
    years: ["2023", "2024"],
    netIncome: { "2023": 400000, "2024": 496728 },
    addbacks: [
      { id: "1", label: "Income taxes", category: "other", type: "ebitda", approved: true, amounts: { "2023": 70000, "2024": 79423 } },
      { id: "2", label: "Interest", category: "other", type: "ebitda", approved: true, amounts: { "2023": 12000, "2024": 11361 } },
      { id: "3", label: "Amortization", category: "other", type: "ebitda", approved: true, amounts: { "2023": 68870, "2024": 72740 } },
      { id: "4", label: "Pharmacist recruitment fee (one-time)", category: "one_time", type: "ebitda", approved: true, amounts: { "2024": 14500 } },
      { id: "5", label: "Owner, spouse, auto and donations", category: "owner_comp", type: "sde", approved: true, amounts: { "2023": 124750, "2024": 105300 } },
      { id: "6", label: "Market salary for a pharmacist-manager", category: "owner_comp", type: "sde", approved: true, amounts: { "2023": 140000, "2024": 140000 } },
    ],
  },
} as any)!;
assert.equal(beaconFin.bridge!.adjustedEbitda!["2024"], 674752, "the fixture reproduces Beacon's bridge subtotal");
assert.equal(beaconFin.bridge!.adjusted["2024"], 920052, "… and its SDE, which matches the broker's");
const beaconInfo: Record<string, unknown> = {
  sde: "FY2024 $920,052; FY2023 $815,620; FY2022 $720,500 — adjusted EBITDA plus one market-rate pharmacist-manager salary ($140,000)",
  ebitda: "FY2024 reported EBITDA $660,252; adjusted EBITDA $780,052 (8.6% margin) per the accountant's normalization",
  sde2024: "$920,052 (FY2024 adjusted EBITDA $780,052 plus one market-rate pharmacist-manager salary of $140,000)",
  addbacks2024: "Owner salary above market $45,000; spouse on payroll, non-operating $42,000; personal portion of automobile $12,300; charitable donations $6,000; one-time pharmacist recruitment agency fee $14,500. Total $119,800 — reported EBITDA $660,252 → adjusted EBITDA $780,052.",
  ...broker(["sde", "ebitda", "sde2024", "addbacks2024"]),
};
const beaconResolved = [{ field: "2024 Adjusted EBITDA", factKey: null, year: null, resolvedValue: "$780,052", supersededValues: ["$674,752"] }];
const bc = earningsCanon(beaconFin, "$3,200,000", { extractedInfo: beaconInfo, resolved: beaconResolved })!;
assert.equal(bc.adjustedEbitda["2024"], 780052, "the broker's resolved adjusted EBITDA, not the bridge's $674,752");
assert.equal(bc.sde["2024"], 920052);
assert.equal(bc.override?.withheld, "adjustedSubtotal", "only the contradicted subtotal is left out");
assert.equal(bc.financials!.bridge!.adjustedEbitda, null);
assert.equal(bc.financials!.bridge!.adjusted["2024"], 920052, "the SDE bridge (which agrees) stays");
assert.equal(bc.margins.find((m) => m.kind === "adjusted" && m.year === "2024")!.pct.toFixed(1), "8.6");
assert.equal(bc.multiples.find((m) => m.kind === "adjusted")!.value.toFixed(1), "4.1");
const beaconBlock = renderCimFinancialsBlock(bc.financials);
assert.ok(!/= Adjusted EBITDA \(subtotal/.test(beaconBlock), "no subtotal the broker's figure contradicts");
assert.match(beaconBlock, /= SDE \(total\): 2023 \$815,620 · 2024 \$920,052/);
assert.match(beaconBlock, /This bridge ends at SDE and has no adjusted EBITDA subtotal: the broker's Adjusted EBITDA for FY2024 is \$780,052/);
assert.ok(!/674,752/.test(beaconBlock));
// Every broker fact agrees with the canon: nothing held.
const beaconScreen = screenEarningsFacts(Object.entries(beaconInfo).filter(([k]) => !k.startsWith("_")), bc, (k) => k);
assert.equal(beaconScreen.held.length, 0, beaconScreen.held.map((h) => h.text).join(" | "));
const bKb = assembleKnowledgeBase({ dealId: "b", businessName: "Beacon", industry: "Pharmacy", askingPrice: "$3,200,000", extractedInfo: beaconInfo, financials: beaconFin, resolvedDiscrepancies: beaconResolved, today } as any);
assert.match(bKb.text, /Adjusted EBITDA: \$780,052 \(FY2024 — the broker's figure — resolved discrepancy "2024 Adjusted EBITDA"\)/);
assert.match(bKb.text, /SDE: \$920,052 \(FY2024 — the financial analysis bridge; earlier years: 2022 \$720,500 · 2023 \$815,620\)/, "the broker adds the year the analysis lacks");
assert.ok(!/674,752/.test(bKb.text), "the overruled subtotal never reaches the writer");
has(bKb.warnings, /the CIM uses your figures — Adjusted EBITDA FY2024: \$780,052 \(resolved discrepancy "2024 Adjusted EBITDA"\) — the financial analysis add-backs give \$674,752 — so the bridge is shown straight to SDE/, "Beacon warning");
// The figure check holds sections to the broker's figure.
const bKnown = knownFiguresFrom(bKb.sourceText, knownBridges(bKb.financials), { earnings: bKb.canon, growth: bKb.growth, today });
has(checkSectionFigures({ sectionTitle: "Highlights", layoutType: "prose_highlight", layoutData: { body: "Adjusted EBITDA reached $674,752 in FY2024." } }, bKnown), /674,752 is not the CIM's EBITDA — use \$780,052/, "bridge subtotal in prose");
lacks(checkSectionFigures({ sectionTitle: "Highlights", layoutType: "prose_highlight", layoutData: { body: "Adjusted EBITDA was $780,052 in FY2024 (an 8.6% margin); SDE was $920,052." } }, bKnown), /not the CIM's/, "the broker's figures pass");

// ── 2. Lakeshore: the broker's SDE overrules the bridge total → no bridge; adjusted EBITDA unconfirmed ──
const lakeFin = buildCimFinancials({
  id: "l", version: 1, status: "completed", brokerReviewedAt: null,
  reclassifiedPnl: { years: ["2024"], rows: [
    { id: "r", name: "Sales", category: "Revenue", values: { "2024": 7412000 } },
    { id: "c", name: "Cost of sales", category: "COGS", values: { "2024": 4112000 } },
    { id: "o", name: "Operating expenses", category: "Operating Expenses", values: { "2024": 2383000 } },
  ] },
  normalization: { metric: "sde", years: ["2024"], netIncome: { "2024": 563190 }, addbacks: [
    { id: "1", label: "Taxes, interest, amortization", category: "other", type: "ebitda", approved: true, amounts: { "2024": 353810 } },
    { id: "2", label: "Owner vehicles and meals", category: "discretionary", type: "ebitda", approved: true, amounts: { "2024": 93000 } },
    { id: "3", label: "Owner and spouse salaries", category: "owner_comp", type: "sde", approved: true, amounts: { "2024": 263000 } },
  ] },
} as any)!;
assert.equal(lakeFin.bridge!.adjusted["2024"], 1273000);
const lakeInfo: Record<string, unknown> = {
  sde: "$1,312,000 (FY2024: adjusted EBITDA $917,000 + owner add-backs $395,000)",
  ebitda: "$917,000 reported EBITDA (FY2024); FY2023 $793,000; FY2022 $644,000",
  keyFinancialNotes: "FY2024 SDE $1,312,000 per the broker recast (add-backs: owner salary, spouse salary, owner vehicles, owner meals and insurance, one-time legal); Comfort Club generates $801,000 in FY2024 from 2,900 active members",
  sellerClaim: "Owner initially said SDE was about $1.5M",
  ...broker(["sde", "ebitda", "keyFinancialNotes"]),
};
const lakeResolved = [{ field: "Owner's claimed SDE vs calculated SDE", factKey: null, year: null, resolvedValue: "$1,312,000 FY2024 SDE (adjusted EBITDA $917,000 + owner add-backs $395,000)", supersededValues: ["$1.5M"] }];
const lc = earningsCanon(lakeFin, "$4,800,000", { extractedInfo: lakeInfo, resolved: lakeResolved })!;
assert.equal(lc.sde["2024"], 1312000, "the broker recast's SDE");
assert.equal(lc.override?.withheld, "bridge");
assert.equal(lc.financials!.bridge, null, "the bridge that doesn't reach it is left out");
assert.deepEqual(lc.unconfirmed, ["adjusted"], "no adjusted EBITDA is confirmed");
assert.equal(lc.multiples[0].value.toFixed(1), "3.7", "the multiple the broker quoted (~3.7× SDE)");
assert.match(canonLines(lc).join("\n"), /Adjusted EBITDA: no confirmed figure — the CIM states no Adjusted EBITDA at all/);
has(offCanon("Adjusted EBITDA of $1,172,000 (FY2024)", lc).map((x) => x.expected), /no Adjusted EBITDA is confirmed/, "an unconfirmed metric is never stated");
assert.equal(offCanon("SDE of $1,312,000 in FY2024 and EBITDA as reported of $917,000", lc).length, 0);
const lKb = assembleKnowledgeBase({ dealId: "l", businessName: "Lakeshore", industry: "HVAC", askingPrice: "$4,800,000", extractedInfo: lakeInfo, financials: lakeFin, resolvedDiscrepancies: lakeResolved, today } as any);
assert.ok(!/1,273,000|SDE BRIDGE \(/.test(lKb.text), "the overruled bridge never reaches the writer");
assert.match(lKb.text, /Key Financial Notes: FY2024 SDE \$1,312,000 per the broker recast/);
assert.ok(!/1\.5M/.test(lKb.text), "the seller's first claim is held");
has(lKb.warnings, /Earnings figures: the CIM uses SDE \$1,312,000 for FY2024, everywhere\. .*"Owner initially said SDE was about \$1\.5M"/, "Lakeshore: the seller's claim named");

// ── 3. Pacific, broker-written fact without a resolution; and the seller-only case ──
const pacificFacts = { ebitda: "$3,900,000 adjusted EBITDA (FY2024)", ...broker(["ebitda"]) };
const pacFin = buildCimFinancials({
  id: "p", version: 1, status: "completed", brokerReviewedAt: null,
  normalization: { metric: "ebitda", years: ["2024"], netIncome: { "2024": 972960 }, addbacks: [{ id: "1", label: "ITDA", category: "other", type: "ebitda", approved: true, amounts: { "2024": 2623240 } }] },
} as any)!;
assert.equal(earningsCanon(pacFin, "$18,000,000", { extractedInfo: pacificFacts })!.adjustedEbitda["2024"], 3900000, "a broker fact counts like a resolution");
const sellerOnly = { ebitda: "$4,100,000 adjusted EBITDA (FY2024)", _fieldSources: { ebitda: { source: "interview" } } };
const sc = earningsCanon(pacFin, "$18,000,000", { extractedInfo: sellerOnly })!;
assert.equal(sc.adjustedEbitda["2024"], 3596200, "a seller's claim doesn't overrule the analysis");
assert.equal(sc.override, null);
// No analysis: the broker's figure is the canon and a seller's other figure is held.
const noFin = earningsCanon(null, "$18,000,000", { extractedInfo: { ...pacificFacts, claim: "Seller said adjusted EBITDA was $4.1M in 2024" } })!;
assert.equal(noFin.adjustedEbitda["2024"], 3900000);
assert.equal(screenEarningsFacts([["claim", "Seller said adjusted EBITDA was $4.1M in 2024"]], noFin, (k) => k).held.length, 1);
// Two broker figures that disagree: neither is used, the broker is told.
const clash = earningsCanon(pacFin, null, { extractedInfo: { ebitda: "$3,900,000 adjusted EBITDA (FY2024)", adjustedEbitda: "$3,700,000 (FY2024)", ...broker(["ebitda", "adjustedEbitda"]) } })!;
assert.equal(clash.brokerConflicts.length, 1);
assert.equal(clash.adjustedEbitda["2024"], 3596200, "the bridge stands when the broker's own figures disagree");

// ── 4. Reading earnings figures: add-backs are not EBITDA; "EBITDA (as reported)" ──
const pc = earningsCanon(pacFin, "$18,000,000", { extractedInfo: pacificFacts })!;
for (const s of [
  "Adjusted EBITDA already deducts the $78,000 difference between current and market rent.",
  "Adjusted EBITDA adds back $165,000 of above-market owner salary.",
  "The EBITDA bridge adds back $72,000 in one-time TMS consultant fees.",
  "Adjusted EBITDA increased by $300,000 over two years.",
]) assert.deepEqual(earningsMentions(s), [], s);
assert.deepEqual(earningsMentions("EBITDA (as reported): $3,619,200 (FY2024)").map((m) => [m.basis, m.value, m.year]), [["reported", 3619200, "2024"]]);
assert.deepEqual(earningsMentions("EBITDA, as reported, was $3,547,200 in 2024").map((m) => m.basis), ["reported"]);
assert.deepEqual(earningsMentions("Adjusted EBITDA (broker-normalized): $3.9M").map((m) => m.value), [3900000], "a parenthetical between the measure and its figure is fine");
assert.deepEqual(earningsMentions("adjusted EBITDA has strengthened from $3.04 million in 2023 to $3.60 million in 2024").map((m) => m.value), [3040000, 3600000]);

// ── 5. Prose false alarms ──
for (const s of ["By 1998, Harjit had expanded to six trucks and a small yard in Surrey.", "By 2014 the fleet had grown to 40 power units.", "Before 2016, all warehousing was done in leased space."]) {
  assert.deepEqual(staleTargets(s, today), [], s);
}
assert.equal(staleTargets("Harjit wants to complete the sale before his next birthday in fall 2026.", today).length, 1);
assert.equal(staleTargets("Sale timeline: complete transaction within 12 months, before fall 2026", today).length, 1);
const plain = knownFiguresFrom("Safety: CVSA out-of-service rate 15.5% (2022), 9.4% (2024)\nDriver turnover 24% (2022), 18% (2024)\nEBITDA margin 11.9% (2022), 11.7% (2024)", [], { today });
const prose = (body: string) => checkSectionFigures({ sectionTitle: "T", layoutType: "prose_highlight", layoutData: { body } }, plain);
lacks(prose("The CVSA out-of-service rate improved from 15.5 percent in 2022 to 9.4 percent in 2024."), /which is a/, "a falling out-of-service rate is an improvement");
lacks(prose("Driver turnover improved from 24% to 18%."), /which is a/, "falling turnover is an improvement");
has(prose("Overall margin improvement from 11.9 percent in 2022 to 11.7 percent in 2024."), /rose from 11\.9 percent to 11\.7 percent, which is a fall/, "a falling margin is no improvement");

// Gender: a strongly gendered common name resolves the pronoun; a name used for both doesn't.
const staffKb = [
  "Key Employees: Helen Park (designated manager); Manpreet Grewal (VP Operations); Aisha Rahman (CEO); Kyle Brennan (COO); Dana MacLellan (service manager)",
  "Service Notes: service is dispatched from the Halifax office; the service desk runs 7:30-6",
  "Departments: Service (Dana MacLellan, manager), Projects (Rohan)",
].join("\n");
const people = peopleOnFile(staffKb);
assert.ok(!people.has("Service"), "a department word the file also writes in lower case is not a person");
const gk = knownFiguresFrom(staffKb, [], { today });
const g = (body: string) => checkSectionFigures({ sectionTitle: "T", layoutType: "prose_highlight", layoutData: { body } }, gk);
assert.deepEqual(g("Helen Park runs the pharmacy. She will stay for six months."), []);
assert.deepEqual(g("Aisha Rahman founded the firm. Kyle Brennan joined later, and he runs operations while she leads sales."), []);
has(g("Manpreet Grewal runs dispatch. She is open to rolling equity."), /"She" for Manpreet — no gender is on file/, "Manpreet (a name used for both) still needs the file");
has(g("Dana MacLellan leads service. She has been there nine years."), /"She" for Dana — no gender is on file/, "Dana");

// ── 6. Confidential items: every phrasing the checker tried, and what is NOT confidential ──
for (const s of [
  "Harvest Lane Markets RFP (potential $2-2.5M annually starting late 2026, currently on shortlist—confidential)",
  "Harvest Lane Markets RFP (currently on shortlist - confidential)",
  "Harvest Lane Markets RFP — confidential, seller asked it stay out of the CIM",
  "Harvest Lane Markets RFP (confidential; seller asked this not be shared)",
  "Harvest Lane Markets RFP (shortlisted, confidential until awarded)",
  "Harvest Lane Markets RFP (seller asked that this stay out of the CIM)",
  "Harvest Lane Markets RFP (not to be disclosed to buyers)",
  "Harvest Lane Markets RFP (unannounced; seller requested confidentiality)",
  "worth $2-2.5M/year starting late 2026 (RFP shortlist, confidential)",
  "Harvest Lane Markets RFP (RFP shortlist, CONFIDENTIAL)",
]) assert.ok(hasConfidentialNote(s), s);
for (const s of [
  "Confidential Information Memorandum prepared by the broker",
  "Customer contracts include confidentiality clauses",
  "confidential customer data is encrypted at rest",
  "Karen is bound only by confidentiality.",
  "Only Carol Whitfield knows about the sale - strict confidentiality maintained from other staff",
  "Target closing by Christmas 2025; confidential process to begin with document collection",
  "Alderbrook 90-day termination for convenience clause to be disclosed in full CIM version only",
]) assert.ok(!hasConfidentialNote(s), s);
// "Alderbrook pricing is confidential" holds the pricing, not Alderbrook.
const attr = holdConfidentialFacts(
  [["customerBase", "Alderbrook Grocery Distributors is the largest customer (22%); Alderbrook pricing is confidential"], ["history", "Alderbrook has been a customer since 1996"]],
  String,
);
assert.deepEqual(attr.heldNames, []);
assert.deepEqual(attr.safe, [["customerBase", "Alderbrook Grocery Distributors is the largest customer (22%)"], ["history", "Alderbrook has been a customer since 1996"]]);

// The broker's private note holds the party even when the fact has no note of its own.
const pacificNotes: Record<string, unknown> = {
  growthOpportunities: "Cooler expansion by up to 15,000 square feet; potential new contract with Harvest Lane Markets (independent Fraser Valley grocery chain, 26 stores) worth $2-2.5M/year starting late 2026",
  customerBase: "Largest customer Alderbrook Grocery Distributors (22%); Kestrel Building Supply; Tidewater Beverage Co.",
  keyCustomers: "Alderbrook since 1996", customerTerms: "Alderbrook master agreement", history: "Alderbrook first account", risks: "Alderbrook concentration", pricing: "Alderbrook rates",
  _brokerPrivateNotes: [
    { note: "Harvest Lane Markets RFP (26 stores, ~$2-2.5M/yr) marked CONFIDENTIAL — keep out of CIM", brokerOnly: true },
    { note: "Alderbrook 90-day termination for convenience clause to be disclosed in full CIM version only (not in any doc, M disclosed verbally)", brokerOnly: true },
    { note: "Only Carol Whitfield knows about the sale - strict confidentiality maintained from other staff" },
    { note: "Document marked CONFIDENTIAL - do not share with staff" },
  ],
};
const notes = keepOutFromNotes(pacificNotes);
assert.deepEqual(notes.names, ["Harvest Lane Markets"], "only the party the note says to keep out");
const pk = screenFactsForCim(Object.entries(pacificNotes).filter(([k]) => !k.startsWith("_")), notes);
assert.deepEqual(pk.heldNames, ["Harvest Lane Markets"]);
assert.equal(pk.safe.find(([k]) => k === "growthOpportunities")![1], "Cooler expansion by up to 15,000 square feet");
assert.ok(pk.safe.some(([k, v]) => k === "customerBase" && /Alderbrook/.test(String(v))), "Alderbrook stays");
const pKb = assembleKnowledgeBase({ dealId: "p", businessName: "Pacific", industry: "Logistics", extractedInfo: pacificNotes, today } as any);
assert.ok(!/Harvest Lane/.test(pKb.text), "the writer never sees the RFP");
assert.deepEqual(pKb.heldNames, ["Harvest Lane Markets"]);

// ── 7. The AI review adds what the rules can't read; its answers are checked ──
{
  const info: Record<string, unknown> = {
    growthOpportunities: "Cooler expansion planned; talks with Northshore Foods about a dedicated lane next to the Alderbrook lanes (seller would rather buyers not hear about this yet)",
    customerBase: "Alderbrook Grocery Distributors (22%)", a: "Alderbrook", b: "Alderbrook", c: "Alderbrook", d: "Alderbrook",
    staffing: "The sale is kept quiet from the drivers",
  };
  const calls: any[] = [];
  _setKeepOutModelForTests({
    messages: {
      create: async (body: any) => {
        calls.push(body);
        const ref = (name: RegExp) => (body.messages[0].content as string).split("\n").find((l: string) => name.test(l))!.split(":")[0].split(" ")[0];
        return {
          content: [{ type: "tool_use", name: "keep_out_review", input: { holds: [
            { ref: ref(/Northshore/), parties: ["Northshore Foods"], reason: "seller wants it kept from buyers" },
            { ref: ref(/Northshore/), parties: ["Alderbrook"], reason: "the main customer, named across the file" },
            { ref: ref(/Northshore/), parties: ["Imaginary Corp"], reason: "not in the text" },
          ] } }],
        };
      },
    },
  } as any);
  const r = await keepOutFor("deal-1", info);
  assert.equal(r.by, "ai");
  assert.deepEqual(r.names, ["Northshore Foods"], "the business's main customer and a name not in the text are refused");
  assert.ok(r.clauses.some((c) => c.key === "growthOpportunities" && /Northshore/.test(c.text)));
  const again = await keepOutFor("deal-1", info);
  assert.equal(calls.length, 1, "cached for unchanged facts");
  assert.deepEqual(again.names, r.names);
  const kb = assembleKnowledgeBase({ dealId: "x", businessName: "P", industry: "L", extractedInfo: info, keepOut: r, today } as any);
  assert.ok(!/Northshore/.test(kb.text));
  assert.match(kb.text, /Customer Base: Alderbrook Grocery Distributors \(22%\)/);
  // The review failing: the rules still apply and the broker is told.
  _setKeepOutModelForTests({ messages: { create: async () => { throw new Error("credit balance is too low"); } } } as any);
  const failed = await keepOutFor("deal-2", pacificNotes);
  assert.equal(failed.by, "rules");
  assert.deepEqual(failed.names, ["Harvest Lane Markets"], "the private-note rule still holds the RFP");
  assert.match(failed.warning ?? "", /confidentiality review couldn't run/);
  _setKeepOutModelForTests(null);
}

// ── 8. Relative timelines are dated from the source, not the reprocess ──
{
  const kb = assembleKnowledgeBase({
    dealId: "t", businessName: "P", industry: "L", today,
    extractedInfo: {
      idealTimeline: "Owner wants to complete sale within one year",
      targetTimeline: "Closed transaction within roughly 12 months",
      _fieldSources: {
        idealTimeline: { source: "call", at: "2026-09-26T10:00:00Z", dated: "2025-11-12" },
        targetTimeline: { source: "email", at: "2026-09-26T10:00:00Z", dated: "2025-11-18" },
      },
    },
  } as any);
  assert.match(kb.text, /Ideal Timeline: Owner wants to complete sale within one year \[recorded Nov 2025\]/);
  assert.match(kb.text, /Target Timeline: Closed transaction within roughly 12 months \[recorded Nov 2025\]/);
}

// ── 9. No bridge to draw: a planned waterfall becomes a key-figure callout ──
{
  const { generateCimLayout, _setAnthropicForTests } = await import("../../server/cim/layout-engine");
  const bodies: any[] = [];
  _setAnthropicForTests(
    {
      messages: {
        stream: (body: any) => ({
          finalMessage: async () => {
            bodies.push(body);
            if (body.tools[0].name === "cim_manifest") {
              return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_manifest", input: { sections: [
                { sectionKey: "bridge", sectionTitle: "Adjusted EBITDA Analysis", order: 1, layoutType: "waterfall_chart", tags: [], aiLayoutReasoning: "r", contentBrief: "The EBITDA bridge." },
              ] } }] };
            }
            return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_section", input: { layoutData: { primaryLabel: "Adjusted EBITDA (FY2024)", primaryValue: "$3,900,000", secondaryStats: [{ label: "Margin", value: "12.6%" }] } } }] };
          },
        }),
      },
    },
    1,
  );
  const pacRev = buildCimFinancials({
    id: "p2", version: 1, status: "completed", brokerReviewedAt: null,
    reclassifiedPnl: { years: ["2024"], rows: [{ id: "r", name: "Revenue", category: "Revenue", values: { "2024": 31020000 } }, { id: "o", name: "Opex", category: "Operating Expenses", values: { "2024": 27472800 } }] },
    normalization: pacFin && (pacFin as any) ? { metric: "ebitda", years: ["2024"], netIncome: { "2024": 972960 }, addbacks: [{ id: "1", label: "ITDA", category: "other", type: "ebitda", approved: true, amounts: { "2024": 2623240 } }] } : null,
  } as any)!;
  const doc = await generateCimLayout({ dealId: "d", businessName: "Pacific", industry: "Logistics", askingPrice: "$18,000,000", extractedInfo: pacificFacts, financials: pacRev, today } as any);
  _setAnthropicForTests(null);
  assert.equal(doc.sections[0].layoutType, "stat_callout", "the waterfall was re-planned");
  assert.ok(bodies.some((b) => /There is no add-back bridge/.test(JSON.stringify(b.messages))), "the writer is told why");
  assert.deepEqual(doc.sections[0].figureWarnings ?? [], [], "the broker's figure and margin pass the check");
}

// ── 10. DD: the same earnings canon and the same keep-out ──
{
  const dd = buildDdContext({
    extractedInfo: { ...pacificNotes, ...pacificFacts, customerConcentration: "Alderbrook Grocery Distributors 22%; Harvest Lane Markets RFP pending" },
    financials: pacFin,
    resolved: [],
  });
  assert.ok(!/3,596,200/.test(dd.context), "no overruled bridge in DD");
  assert.ok(!/Harvest Lane/.test(dd.context + dd.knownText), "the RFP stays out of DD too");
}

console.log("cim-truth-v2: ok");
