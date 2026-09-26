/**
 * CIM content truth, QA-harvest round V (c-truth stream). Every case is from the live
 * Pacific Coast Logistics generation of 2026-09-26 (fixtures: its real financial analysis,
 * its knowledge base and its 26 generated sections):
 *  - one adjusted EBITDA across the CIM: the approved bridge wins; off-bridge earnings
 *    figures (facts, resolved discrepancies, margins, multiples) are held out and named
 *    in one broker warning, and the check flags any that are written
 *  - the statement block ties EBITDA → income before taxes → net income (other income
 *    included); a year whose rows don't reach reported net income is restated from it
 *  - prose is checked: invented industry figures, coincidental matches, "improved" falls,
 *    growth with the wrong period, past targets, guessed gender, invented customer ranks
 *    and descriptors, the seller's casual wording, confidential names
 *  - facts marked confidential never reach the writer; a surviving mention is scrubbed
 *  - a section PATCH returns the stale stamps it wrote
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCimFinancials, cimGrowth, knownBridges, renderCimFinancialsBlock, restatementWarnings } from "../../server/cim/cim-financials";
import { canonLines, earningsCanon, earningsMentions, offCanon, screenEarningsFacts } from "../../server/cim/earnings-canon";
import { checkSectionFigures, knownFiguresFrom, parseFigures } from "../../server/cim/figure-check";
import { assembleKnowledgeBase, scrubHeldNames } from "../../server/cim/layout-engine";
import { hasConfidentialNote, holdConfidentialFacts, screenFactsForCim } from "../../server/cim/sensitive-facts";
import { hasRelativeTime, staleTargets } from "../../server/cim/fact-dates";
import { normalizeSpokenFigures, spelledNumbers } from "../../server/cim/spoken-figures";
import { peopleOnFile } from "../../server/cim/prose-check";
import { withStaleStamps } from "../../server/cim/section-ops";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cim");
const analysis = JSON.parse(fs.readFileSync(path.join(FIX, "pacific-v-analysis.json"), "utf-8"));
const sections: any[] = JSON.parse(fs.readFileSync(path.join(FIX, "pacific-v-sections.json"), "utf-8"));
const kbText = fs.readFileSync(path.join(FIX, "pacific-v-kb.txt"), "utf-8");
const today = new Date("2026-09-26T12:00:00Z");
const byTitle = (t: string) => {
  const s = sections.find((x) => x.sectionTitle === t);
  assert.ok(s, `fixture section ${t}`);
  return s;
};
const has = (issues: string[], re: RegExp, what: string) => assert.ok(issues.some((m) => re.test(m)), `${what}: ${issues.join(" | ")}`);
const lacks = (issues: string[], re: RegExp, what: string) => assert.ok(!issues.some((m) => re.test(m)), `${what}: ${issues.join(" | ")}`);

// ── 1. Statement block: FY2024 restated from reported net income; the chain ties ──
const fin = buildCimFinancials({ id: "fa", version: 1, status: "completed", brokerReviewedAt: null, ...analysis } as any)!;
const p24 = fin.pnl!["2024"];
assert.equal(p24.ebitda, 3547200, "FY2024 EBITDA = the statements' income from operations ($3,547,200), not the rows' $3,619,200");
assert.equal(p24.restated?.gap, 72000);
assert.match(p24.restated?.likelyCause ?? "", /TMS migration consultants/);
for (const y of ["2022", "2023", "2024"]) {
  const p = fin.pnl![y];
  assert.equal(p.incomeBeforeTaxes, p.ebitda + p.otherIncome - p.otherExpense - p.depreciation - p.interest);
  assert.equal(Math.round(p.incomeBeforeTaxes - p.taxes), p.netIncomeReported, `${y}: EBITDA → IBT → net income ties`);
}
assert.equal(fin.pnl!["2022"].restated, undefined, "a year that ties is left alone");
const block = renderCimFinancialsBlock(fin);
assert.match(block, /Income before income taxes .*2022 \$1,539,800 · 2023 \$841,600 · 2024 \$1,266,200/);
assert.match(block, /Other income: 2022 \$118,000 · 2023 \$72,000 · 2024 \$64,000/);
assert.match(block, /EBITDA before other income .*2024 \$3,547,200 \(11\.4% margin\)/);
assert.match(block, /prints EVERY row between them .*Never leave out the other-income row/);
assert.match(block, /for 2024 the operating expenses and EBITDA above are stated from the reported net income/);
assert.ok(!/\[Operating Expenses\][^\n]*2024/.test(block), "FY2024 expense lines (which don't add up to the restated total) are not listed");
assert.match(block, /\[Operating Expenses\] Office, dispatch & administration salaries: 2022 \$1,090,000 · 2023 \$1,150,000\n/);
assert.match(block, /3PL warehousing, cross-dock & handling: 2022→2023 \+21\.4% · 2023→2024 \+11\.6% · 2022→2024 \+35\.5%/);
assert.match(restatementWarnings(fin)[0], /2024: .*\$3,619,200.*\$3,547,200.*\$72,000.*TMS migration consultants/);

// A gap no one-time item explains (Lakeshore: the rows' EBITDA IS the statements'):
// the rows stay, and the year is shown only down to EBITDA.
const untiedFin = buildCimFinancials({
  id: "u", version: 1, status: "completed", brokerReviewedAt: null,
  reclassifiedPnl: {
    years: ["2024"],
    rows: [
      { id: "1", name: "Sales", category: "Revenue", values: { "2024": 7412000 } },
      { id: "2", name: "Direct costs", category: "COGS", values: { "2024": 4200000 } },
      { id: "3", name: "Opex", category: "Operating Expenses", values: { "2024": 2295000 } },
      { id: "4", name: "Amortization", category: "Depreciation", values: { "2024": 120000 } },
      { id: "5", name: "Taxes", category: "Taxes", values: { "2024": 304810 } },
    ],
  },
  normalization: { metric: "sde", years: ["2024"], netIncome: { "2024": 563190 }, addbacks: [{ id: "a", label: "Owner salary", type: "sde", approved: true, amounts: { "2024": 300000 } }] },
} as any)!;
assert.equal(untiedFin.pnl!["2024"].restated, undefined);
assert.equal(untiedFin.pnl!["2024"].ebitda, 917000, "the statements' EBITDA is kept");
const untiedBlock = renderCimFinancialsBlock(untiedFin);
assert.match(untiedBlock, /leave every 2024 cell below EBITDA empty \(net income included\)/);
assert.ok(!/Income before income taxes[^\n]*2024/.test(untiedBlock), "no income-before-taxes figure for a year that doesn't tie");
assert.match(restatementWarnings(untiedFin)[0], /2024: the Income Statement lines give net income of \$492,190, but the reported net income is \$563,190 \(\$71,000 apart\)/);

// ── 2. One adjusted EBITDA: the canon ──
const canon = earningsCanon(fin, "$18,000,000")!;
assert.equal(canon.adjustedEbitda["2024"], 3596200);
assert.equal(canon.sde["2024"], 3823200);
const lines = canonLines(canon).join("\n");
assert.match(lines, /Adjusted EBITDA: \$3,596,200 \(FY2024 — the financial analysis bridge; earlier years: 2022 \$3,517,800 · 2023 \$3,041,600\)/);
assert.match(lines, /Adjusted EBITDA margin: 11\.6% \(FY2024\)/);
assert.match(lines, /Asking price multiple: 5\.0× FY2024 Adjusted EBITDA/);
assert.equal(earningsCanon({ ...fin, bridge: null } as any, "$1"), null, "no bridge → the facts' figures stand");

// Reading earnings figures in text: labelled by the measure that governs them.
const m1 = earningsMentions("Revenue has grown 8.3 percent over the past two years, adjusted EBITDA has strengthened from $3.04 million in 2023 to $3.60 million in 2024");
assert.deepEqual(m1.map((m) => [m.kind, m.value, m.year]), [["ebitda", 3040000, "2023"], ["ebitda", 3600000, "2024"]], "revenue growth is not a margin; each EBITDA figure has its year");
assert.deepEqual(offCanon("adjusted EBITDA has strengthened from $3.04 million in 2023 to $3.60 million in 2024", canon), [], "the bridge's figures pass, rounded");
assert.equal(offCanon("Asking Price: $18,000,000 (4.6× FY2024 adjusted EBITDA)", canon)[0]?.expected, "5.0× (multiple of FY2024 Adjusted EBITDA)");
assert.equal(offCanon("overall margin held (12.6% adj. EBITDA in 2024 vs 11.3% in 2023)", canon).length, 1, "'12.6% adj. EBITDA' is a margin, and not the bridge's");
assert.equal(offCanon("Adjusted EBITDA: $3,596,200 (FY2024); EBITDA margin 11.6%", canon).length, 0);

// Facts screen: the clause with an off-bridge figure goes, the rest of the fact stays.
const facts: Array<[string, unknown]> = [
  ["ebitda", "$3,900,000 adjusted EBITDA (FY2024)"],
  ["ratePassThroughAbility", "Rate increases of 3–5% pushed through on annual renewals (Kestrel, dairy co-op); Alderbrook took 2.5% in April 2024 plus fuel surcharge; some compression absorbed on spot market and smaller accounts but overall margin held (12.6% adj. EBITDA in 2024 vs 11.3% in 2023)"],
  ["adjustedEbitdaByYear", { "2022": "$3.78M", "2023": "$3.31M", "2024": "$3.90M" }],
  ["netIncome", "$972,960 (FY2024, after tax)"],
  ["businessDescription", "Regional dry van and reefer trucking"],
];
const scr = screenEarningsFacts(facts, canon, (k) => k);
assert.deepEqual(scr.safe.map(([k]) => k), ["ratePassThroughAbility", "netIncome", "businessDescription"]);
assert.match(String(scr.safe[0][1]), /^Rate increases of 3–5% pushed through .*fuel surcharge$/, "the rest of the fact is kept");
assert.equal(scr.held.length, 5, scr.held.map((h) => h.text).join(" | "));

// ── 3. The writer's knowledge base (assembleKnowledgeBase) ──
const extractedInfo: Record<string, unknown> = {
  annualRevenue: "$31,020,000",
  ebitda: "$3,900,000 adjusted EBITDA (FY2024)",
  marginTrend: "EBITDA margin 13.2% (2022) → 11.3% (2023) → 12.6% (2024); 2023 dip from full Campbell Ridge rent and higher equipment loan rates; 2024 recovery from 35% warehouse revenue growth (higher-margin than trucking)",
  growthOpportunities:
    "Cooler expansion by up to 15,000 square feet (landlord pre-approved in principle), budgeted at $1.1-1.2 million with under-three-year payback; potential new contract with Harvest Lane Markets (independent Fraser Valley grocery chain, 26 stores) worth $2-2.5M/year starting late 2026 (RFP shortlist, confidential)",
  marketNotes: "Harvest Lane Markets RFP expected to be decided in Q4",
  customerBase: "Over 300 customers; largest is Alderbrook (grocery distributor, 22.0% of FY2024 revenue); other sectors include beverage, pet food, furniture, dairy co-op; food is about half the business; Fraser Valley produce lanes",
  serviceArea: "Lower Mainland and Fraser Valley",
  deliveryArea: "Fraser Valley and Interior BC",
  idealTimeline: "Owner wants to complete sale within one year, before next birthday (fall 2026); realistic 6-9 month process from launch",
  averageDriverTenure: "Six-point-something years; twenty-four drivers over ten years",
  _fieldSources: {
    idealTimeline: { source: "call", at: "2025-11-12T21:20:00Z" },
    averageDriverTenure: { source: "document", at: "2025-12-11T17:40:00Z" },
  },
};
const kb = assembleKnowledgeBase({
  dealId: "d",
  businessName: "Pacific Coast Logistics Ltd.",
  industry: "Transportation & Logistics",
  askingPrice: "$18,000,000",
  extractedInfo,
  financials: fin,
  resolvedDiscrepancies: [
    { field: "2024 Adjusted EBITDA", factKey: null, year: null, resolvedValue: "$3,900,000", supersededValues: ["$3,596,200"] },
    { field: "Alderbrook revenue percentage", factKey: null, year: null, resolvedValue: "22.0% of FY2024 revenue", supersededValues: [] },
  ],
  cimContent: { growth: "Harvest Lane Markets could add $2.5M. The cooler expansion is budgeted at $1.1-1.2 million." },
  today,
} as any);
assert.ok(!/3,900,000|3\.9M|12\.6%/.test(kb.text), "no off-bridge earnings figure reaches the writer");
assert.match(kb.text, /CANONICAL FIGURES[\s\S]*Adjusted EBITDA: \$3,596,200 \(FY2024/);
assert.ok(!/^EBITDA: /m.test(kb.text), "the fact's EBITDA is not a canonical figure");
assert.match(kb.text, /Alderbrook revenue percentage: 22\.0% of FY2024 revenue/, "other resolved values stay");
assert.match(kb.text, /Margin Trend: 2023 dip from full Campbell Ridge rent/, "the rest of a narrative fact stays");
assert.ok(!/Harvest Lane/i.test(kb.text), "the confidential RFP and every mention of it are held out (facts, notes and drafts)");
assert.match(kb.text, /Growth Opportunities: Cooler expansion by up to 15,000 square feet/);
assert.match(kb.text, /The cooler expansion is budgeted/, "the rest of an earlier draft stays");
assert.match(kb.text, /Fraser Valley/, "a region the confidential clause mentions isn't itself confidential");
assert.deepEqual(kb.heldNames, ["Harvest Lane Markets"]);
assert.match(kb.text, /Average Driver Tenure: just over 6 years; 24 drivers over 10 years/, "spoken figures, clean");
assert.match(kb.text, /Ideal Timeline: .*\[recorded Nov 2025\] \[date has arrived: fall 2026 is not in the future any more/, "relative wording dated; the passed target marked");
assert.match(kb.text, /GROWTH \(computed/);
const w = kb.warnings.join("\n");
assert.match(w, /Earnings figures: the CIM uses Adjusted EBITDA \$3,596,200 and SDE \$3,823,200 for FY2024 .*"\$3,900,000 adjusted EBITDA \(FY2024\)" \(Ebitda\).*resolved discrepancy "2024 Adjusted EBITDA"/);
assert.match(w, /Kept out of the CIM because the facts mark it confidential: "Growth Opportunities" \(potential new contract with Harvest Lane Markets/);
assert.match(w, /Timeline to confirm with the seller: "Ideal Timeline" says "before next birthday fall 2026"/);
assert.match(w, /Financial analysis, 2024: .*TMS migration consultants/);
assert.ok(!/Figures disagree: EBITDA/.test(w), "the old two-number note is gone");

// ── 4. The figure check over the real generation ──
const known = knownFiguresFrom(kbText, knownBridges(fin), { earnings: canon, growth: cimGrowth(fin), today, heldNames: ["Harvest Lane Markets"] });
const check = (t: string) => checkSectionFigures(byTitle(t), known);

has(check("Pacific Coast Logistics Ltd."), /\$3,900,000 is not the CIM's EBITDA — use \$3,596,200 \(Adjusted EBITDA, FY2024\)/, "cover");
const hi = check("Investment Highlights");
has(hi, /\$3,900,000 is not the CIM's EBITDA/, "highlights EBITDA");
has(hi, /12\.6% is not the CIM's earnings margin — use 11\.6%/, "highlights margin");
has(check("Transaction Overview"), /4\.6× is not the CIM's multiple — use 5\.0×/, "multiple");

const table = check("Historical Financial Performance");
has(table, /FY2022: EBITDA 3,409,800 and the rows below it come to 1,421,800, not Income before taxes 1,539,800 — is the other-income row missing\?/, "chain 2022");
has(table, /FY2024: EBITDA 3,619,200 and the rows below it come to 980,960, not Net income 972,960/, "chain 2024");

const cust = check("Customer Concentration & Relationships");
has(cust, /"Top 5" for "Dairy Co-op" — no such ranking/, "dairy rank");
has(cust, /"Top 10" for "Regional Pet Food Distributor"/, "pet food rank");
has(cust, /"Fraser Valley Produce Importer" isn't how the facts name or describe/, "descriptor");
has(cust, /"Regional Pet Food Distributor" isn't how the facts name or describe/, "descriptor 2");
lacks(cust, /Alderbrook Grocery Distributors|Kestrel Building Supply/, "customers on file pass");
has(cust, /no source for "342"/, "a computed count");

has(check("Competitive Strengths"), /"six-point-something" is the seller's spoken wording/, "casual wording");
has(check("Workforce & Culture"), /"Six-point-something" is the seller's spoken wording/, "casual wording in a metric");
has(check("Warehousing & 3PL Services"), /35 percent is the FY2022→FY2024 change in 3PL warehousing, cross-dock & handling, not a one-year figure/, "growth period");

const market = check("Market Position & Industry Dynamics");
has(market, /no source for "three million"/, "general-knowledge TEU figure (it only matches an unrelated \$3,000,000 credit line)");
has(market, /no source for "\$180,000 to \$200,000"/, "equipment prices");
has(market, /"\$18 million" is on file only for something else/, "a coincidental match (the asking price)");
has(market, /says it rose from 11\.9 percent to 11\.7 percent, which is a fall/, "direction");

const reason = check("Reason for Sale");
has(reason, /"before his next birthday in fall 2026" is not in the future any more — today is September 2026/, "stale target");
has(reason, /"before fall 2026" is not in the future any more/, "stale target in highlights");
lacks(reason, /for Harjit/, "the file gives Harjit's gender (\"Harjit and wife\")");
lacks(reason, /8\.3/, "revenue growth 'over the past two years' is correctly labelled");

const transition = check("Transition & Continuity");
has(transition, /"She" for Manpreet — no gender is on file; use the name or role/, "gender");

has(check("Growth Initiatives"), /mentions "Harvest Lane Markets", which the facts mark confidential/, "confidential name");

// Rewritten the right way, the same sections pass those checks.
const fixedCover = { ...byTitle("Pacific Coast Logistics Ltd."), layoutData: { ...byTitle("Pacific Coast Logistics Ltd.").layoutData, ebitda: "$3,596,200" } };
lacks(checkSectionFigures(fixedCover, known), /EBITDA/, "the bridge's figure on the cover");
const fixedTable = {
  sectionTitle: "Historical Financial Performance",
  layoutType: "financial_table",
  layoutData: {
    headers: ["", "FY2022", "FY2023", "FY2024"],
    rows: [
      { label: "EBITDA (as reported)", values: ["$3,409,800", "$3,061,600", "$3,547,200"] },
      { label: "Other income", values: ["$118,000", "$72,000", "$64,000"] },
      { label: "Depreciation & amortization", values: ["($1,720,000)", "($1,880,000)", "($1,950,000)"] },
      { label: "Interest expense", values: ["($268,000)", "($412,000)", "($395,000)"] },
      { label: "Income before income taxes", values: ["$1,539,800", "$841,600", "$1,266,200"] },
      { label: "Income taxes", values: ["($423,900)", "($175,685)", "($293,240)"] },
      { label: "Net income", values: ["$1,115,900", "$665,915", "$972,960"] },
    ],
  },
};
lacks(checkSectionFigures(fixedTable, knownFiguresFrom(`${kbText}\n${block}`, knownBridges(fin), { earnings: canon, growth: cimGrowth(fin), today })), /rows below it|not the CIM/, "a complete chain ties");
const okProse = {
  sectionTitle: "Transition",
  layoutType: "prose_highlight",
  layoutData: {
    body: "Manpreet Grewal will stay two to three years as General Manager. Manpreet is open to rolling part of the proceeds into the buyer's entity. Average driver tenure is just over six years. Warehousing revenue grew 35.5 percent from FY2022 to FY2024 and 11.6 percent in FY2024.",
  },
};
assert.deepEqual(checkSectionFigures(okProse, known).filter((m) => !/no source/.test(m)), [], "names, clean wording, correct periods");

// ── 5. Confidential facts and the fail-closed scrub ──
assert.ok(hasConfidentialNote("worth $2-2.5M/year starting late 2026 (RFP shortlist, confidential)"));
assert.ok(hasConfidentialNote("FY25 mgmt numbers — broker instructed not to put in writing until reviewed"));
assert.ok(hasConfidentialNote("Owner mentioned this off the record"));
assert.ok(!hasConfidentialNote("Confidential Information Memorandum prepared by the broker"));
assert.ok(!hasConfidentialNote("Customer contracts include confidentiality clauses"));
assert.ok(!hasConfidentialNote("confidential customer data is encrypted at rest"));
const held = holdConfidentialFacts([["a", "Cooler expansion planned; new contract with Harvest Lane Markets (RFP shortlist, confidential)"]], String);
assert.deepEqual(held.safe, [["a", "Cooler expansion planned"]]);
assert.equal(screenFactsForCim([["x", "Harvest Lane Markets RFP (confidential)"]]).confidential[0].key, "x");
const growth = byTitle("Growth Initiatives");
const scrubbed = scrubHeldNames(growth, ["Harvest Lane Markets"])!;
assert.ok(scrubbed && !/Harvest Lane/.test(JSON.stringify(scrubbed.layoutData)), "the item naming the confidential party is removed");
assert.equal((scrubbed.layoutData.items as unknown[]).length, (growth.layoutData.items as unknown[]).length - 1, "only that item");
const marketScrub = scrubHeldNames(byTitle("Market Position & Industry Dynamics"), ["Harvest Lane Markets"])!;
assert.ok(marketScrub && !/Harvest Lane/.test(JSON.stringify(marketScrub.layoutData)) && /Port of Vancouver/.test(String(marketScrub.layoutData.body)), "prose: just the sentence goes");
assert.equal(scrubHeldNames(byTitle("Reason for Sale"), ["Harvest Lane Markets"]), null);

// End to end with a fake model that keeps writing the confidential RFP and a second
// EBITDA: the rewrite is asked to fix both; the RFP never survives; the rest is reported.
{
  const { generateCimLayout, _setAnthropicForTests } = await import("../../server/cim/layout-engine");
  const bodies: any[] = [];
  const growthReply = {
    type: "tool_use",
    name: "cim_section",
    input: { layoutData: { items: [
      { title: "Cooler expansion", description: "Up to 15,000 square feet, budgeted at $1.1-1.2 million." },
      { title: "Harvest Lane Markets contract", description: "A shortlisted RFP worth $2-2.5M a year." },
    ] } },
  };
  const coverReply = { type: "tool_use", name: "cim_section", input: { layoutData: { businessName: "Pacific", ebitda: "$3,900,000", earningsLabel: "Adjusted EBITDA" } } };
  _setAnthropicForTests(
    {
      messages: {
        stream: (body: any) => ({
          finalMessage: async () => {
            bodies.push(body);
            if (body.tools[0].name === "cim_manifest") {
              return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_manifest", input: { sections: [
                { sectionKey: "cover", sectionTitle: "Cover", order: 1, layoutType: "cover_page", tags: [], aiLayoutReasoning: "r", contentBrief: "b" },
                { sectionKey: "growth", sectionTitle: "Growth Initiatives", order: 2, layoutType: "numbered_list", tags: [], aiLayoutReasoning: "r", contentBrief: "b" },
              ] } }] };
            }
            return { stop_reason: "tool_use", content: [body.messages[0].content.includes('"Cover"') ? coverReply : growthReply] };
          },
        }),
      },
    },
    1,
  );
  const doc = await generateCimLayout({
    dealId: "d", businessName: "Pacific Coast Logistics Ltd.", industry: "Transportation", askingPrice: "$18,000,000",
    extractedInfo, financials: fin, today,
  } as any);
  _setAnthropicForTests(null);
  const g = doc.sections.find((s) => s.sectionKey === "growth")!;
  assert.ok(!/Harvest Lane/.test(JSON.stringify(g)), "the confidential RFP never reaches the stored section");
  assert.equal((g.layoutData as any).items.length, 1);
  assert.ok(!(g.figureWarnings ?? []).some((x) => /Harvest Lane/.test(x)), "no stale warning about the removed item");
  assert.ok(doc.warnings!.some((x) => /Removed from "Growth Initiatives": "Harvest Lane Markets"/.test(x)));
  const repair = bodies.find((b) => /failed the figure check/.test(b.messages?.[0]?.content ?? "") && /Cover/.test(b.messages[0].content));
  assert.ok(repair && /\$3,900,000 is not the CIM's EBITDA — use \$3,596,200/.test(repair.messages[0].content), "the rewrite is told the bridge's figure");
  const cover = doc.sections.find((s) => s.layoutType === "cover_page")!;
  assert.ok((cover.figureWarnings ?? []).some((x) => /3,900,000/.test(x)), "a figure the rewrite didn't fix is shown to the broker");
  assert.ok(doc.warnings!.some((x) => /Earnings figures: the CIM uses Adjusted EBITDA \$3,596,200/.test(x)));
  assert.ok(!/Harvest Lane/.test(bodies[0].system[0].text), "the writer's knowledge base never had it");
}

// ── 6. Dates, spoken figures, people, parsing ──
assert.ok(hasRelativeTime("Owner wants to complete sale within one year, before next birthday (fall 2026)"));
assert.ok(hasRelativeTime("Closed transaction within roughly 12 months"));
assert.ok(!hasRelativeTime("Founded in 1991 in Surrey"));
assert.deepEqual(staleTargets("Harjit wants to complete the sale within roughly 12 months, before his next birthday in fall 2026.", today).map((s) => s.period), ["fall 2026"]);
assert.deepEqual(staleTargets("The company expects to close by Q1 2027.", today), []);
assert.deepEqual(staleTargets("Kevin was promoted in May 2025.", today), [], "a past report is not a target");
assert.equal(staleTargets("Targeting a close by March 2026.", today).length, 1);
assert.equal(normalizeSpokenFigures("Six-point-something years; twenty-four drivers over ten years"), "just over 6 years; 24 drivers over 10 years");
assert.equal(normalizeSpokenFigures("one of the two largest"), "one of the two largest");
assert.equal(normalizeSpokenFigures("a million-dollar contract"), "a million-dollar contract");
assert.equal(normalizeSpokenFigures("Yard on Twenty Mile Road. Twenty-four drivers."), "Yard on Twenty Mile Road. 24 drivers.", "a number in a name stays");
// An analysis with no SDE line has no SDE to disagree with: a fact's SDE stands.
const noSde = earningsCanon({ ...fin, bridge: { ...fin.bridge!, sdeOnly: [], sde: null } } as any, "$18,000,000")!;
assert.deepEqual(offCanon("SDE of $3,900,000 (FY2024)", noSde), []);
assert.deepEqual(spelledNumbers("over three million TEUs").map((s) => s.value), [3000000]);
const people = peopleOnFile(kbText);
assert.equal(people.get("Harjit"), "m", "Harjit and wife");
assert.equal(people.get("Kevin"), "m", "\"promoting him\"");
assert.equal(people.get("Manpreet"), null, "no gender on file for Manpreet");
assert.ok(!people.has("Alderbrook") && !people.has("Grewal"), "companies and surnames aren't first names");
// Several people named before a pronoun: one the file gives that gender is its antecedent.
const famKb = "Key Employees: Anthony (owner, president); Maria (office manager, his wife); Dave (service manager)\nOwner Notes: Anthony and wife Maria plan to retire.";
const famKnown = knownFiguresFrom(famKb, [], { today });
const fam = (body: string) => checkSectionFigures({ sectionTitle: "T", layoutType: "prose_highlight", layoutData: { body } }, famKnown);
assert.deepEqual(fam("Anthony and Maria plan to retire. He will stay on for a year."), [], "Anthony is 'he' on file");
has(fam("Dave runs service. His team is strong."), /"His" for Dave — no gender is on file/, "Dave");
has(fam("Maria keeps the books. He will stay on."), /"He" for Maria contradicts the file/, "Maria");
assert.deepEqual(
  parseFigures("margin improvement from 11.9 percent in 2022 to 11.7 percent in 2024").map((f) => [f.value, f.kind]),
  [[11.9, "percent"], [2022, "plain"], [11.7, "percent"], [2024, "plain"]],
  "a year then 'to <figure>' is not a range",
);
assert.deepEqual(parseFigures("$1.1 to $1.2 million").map((f) => f.value), [1100000, 1200000], "real ranges still parse");

// ── 7. PATCH returns the stamps it wrote ──
const at = new Date("2026-09-26T10:00:00Z");
assert.deepEqual(withStaleStamps({ id: "s", ddStaleAt: null, blindStaleAt: null } as any, at), { id: "s", ddStaleAt: at, blindStaleAt: at });

console.log("cim-truth-v: ok");
