/**
 * CIM writer truthfulness (QA harvest 2026-09-26, cimgen stream):
 *  - the financial analysis reaches the writer as computed AUTHORITATIVE FINANCIALS
 *  - the figure check flags untraced figures, unreconciled tables/bridges, invented names
 *  - cover "Prepared by" / date are system-owned; the writer knows TODAY
 *  - personal health details never reach the writer; no raw questionnaire dump
 *  - the scrape block is labelled UNVERIFIED
 *  - planning retries a dropped connection
 */
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import {
  assembleKnowledgeBase,
  buildKnowledgeBase,
  finalizeLayoutData,
  planCimManifest,
  _setAnthropicForTests,
} from "../../server/cim/layout-engine";
import { buildCimFinancials, pickAnalysisForCim, renderCimFinancialsBlock } from "../../server/cim/cim-financials";
import { checkSectionFigures, knownFiguresFrom, parseFigures } from "../../server/cim/figure-check";
import { hasSensitiveDetail, stripSensitiveDetail } from "../../server/cim/sensitive-facts";

const today = new Date("2026-09-25T12:00:00Z");

// ── Fixture: a Pacific-like analysis ──
const analysis = {
  id: "fa1",
  version: 2,
  status: "completed",
  brokerReviewedAt: null,
  reclassifiedPnl: {
    years: ["2023", "2024"],
    rows: [
      { id: "r1", name: "Freight revenue", category: "Revenue", values: { "2023": 29180000, "2024": 31020000 } },
      { id: "r2", name: "Driver wages", category: "COGS", values: { "2023": 20612900, "2024": 21706300 } },
      { id: "r3", name: "Office salaries", category: "Operating Expenses", values: { "2023": 5100500, "2024": 5220500 } },
      { id: "r4", name: "Owner salary (Harjit)", category: "Owner Compensation", values: { "2023": 347000, "2024": 347000 } },
      { id: "r5", name: "Amortization", category: "Depreciation", values: { "2023": 1880000, "2024": 1950000 } },
      { id: "r6", name: "Interest", category: "Interest", values: { "2023": 412000, "2024": 395000 } },
      { id: "r7", name: "Income taxes", category: "Taxes", values: { "2023": 175685, "2024": 293240 } },
    ],
  },
  normalization: {
    metric: "ebitda",
    years: ["2023", "2024"],
    netIncome: { "2023": 665915, "2024": 972960 },
    addbacks: [
      { id: "a1", label: "Interest expense", category: "other", type: "ebitda", approved: true, amounts: { "2023": 412000, "2024": 395000 } },
      { id: "a2", label: "Income taxes", category: "other", type: "ebitda", approved: true, amounts: { "2023": 175685, "2024": 293240 } },
      { id: "a3", label: "Depreciation & amortization", category: "other", type: "ebitda", approved: true, amounts: { "2023": 1880000, "2024": 1950000 } },
      { id: "a4", label: "Below-market yard rent", category: "discretionary", type: "ebitda", approved: true, amounts: { "2023": -78000, "2024": -78000 } },
      { id: "a5", label: "Harjit's salary above replacement cost", category: "owner_comp", type: "sde", approved: true, amounts: { "2023": 165000, "2024": 165000 } },
      { id: "a6", label: "Rejected golf dues", category: "discretionary", type: "ebitda", approved: false, amounts: { "2023": 9800, "2024": 9800 } },
    ],
  },
  workingCapital: {
    currentAssets: [{ name: "Accounts receivable", amount: 4380000 }],
    currentLiabilities: [{ name: "Accounts payable", amount: 2640000 }],
    netWorkingCapital: 1740000,
    pegAmount: 2400000,
  },
};

// pickAnalysisForCim: reviewed wins over a newer unreviewed run; drafts never used.
assert.equal(pickAnalysisForCim([{ ...analysis, id: "new", version: 3 }, { ...analysis, id: "rev", version: 2, status: "reviewed" }] as any)?.id, "rev");
assert.equal(pickAnalysisForCim([{ ...analysis, id: "d", status: "running" }] as any), null);
assert.equal(pickAnalysisForCim([{ ...analysis, id: "c", status: "completed" }, { ...analysis, id: "f", version: 9, status: "failed" }] as any)?.id, "c");

const fin = buildCimFinancials(analysis as any)!;
assert.ok(fin, "financials built");
assert.equal(fin.pnl!["2024"].grossProfit, 31020000 - 21706300);
// This fixture's rows don't reach the reported net income ($972,960) and no one-time
// item explains the gap: the rows are kept, the year is flagged untied (c-truth round V).
assert.equal(fin.pnl!["2024"].restated, undefined);
assert.equal(fin.pnl!["2024"].operatingExpenses, 5220500 + 347000);
assert.equal(fin.bridge!.adjusted["2024"], 972960 + 395000 + 293240 + 1950000 - 78000, "EBITDA-mode total excludes the SDE-only and the unapproved add-backs");
assert.equal(fin.bridge!.sde!["2024"], 972960 + 395000 + 293240 + 1950000 - 78000 + 165000);

// buildKnowledgeBase with a financial analysis carries the add-back amounts and the per-year P&L.
const params = {
  dealId: "d",
  businessName: "Pacific Coast Logistics Ltd.",
  industry: "Transportation",
  askingPrice: "$18,000,000",
  extractedInfo: {
    annualRevenue: "$31,020,000 (FY2024)",
    ebitda: "$3,900,000 adjusted EBITDA (FY2024)",
    customerConcentration: "Alderbrook Grocery Distributors Ltd. 22.0% of FY2024 revenue; Kestrel Building Supply 8%",
  },
  financials: fin,
  today,
} as any;
const kb = buildKnowledgeBase(params);
assert.match(kb, /AUTHORITATIVE FINANCIALS/);
assert.match(kb, /Below-market yard rent: 2023 \(\$78,000\) · 2024 \(\$78,000\)/, "deductions shown with amounts");
assert.match(kb, /Harjit's salary above replacement cost: 2023 \$165,000/);
assert.match(kb, /Revenue: 2023 \$29,180,000 · 2024 \$31,020,000/);
assert.match(kb, /= Adjusted EBITDA \(total\): 2023 \$3,055,600 · 2024 \$3,533,200/);
assert.ok(!/Rejected golf dues/.test(kb), "unapproved add-backs never reach the writer");
assert.match(kb, /Working capital peg \(target\): \$2,400,000/);
assert.match(kb, /^TODAY: September 25, 2026/m, "the writer knows today's date");
// The headline fact and the analysis disagree → flagged for the broker, not plugged.
const assembled = assembleKnowledgeBase(params);
// (c-truth round V: the approved bridge is THE adjusted EBITDA — the fact is held out, named in the warning.)
assert.ok(assembled.warnings.some((w) => /the CIM uses Adjusted EBITDA \$3,533,200.*\$3,900,000/.test(w)), `EBITDA conflict surfaced: ${assembled.warnings.join(" | ")}`);
assert.ok(!/3,900,000/.test(assembled.text), "the off-bridge EBITDA never reaches the writer");

// Long canonical values: the first currency figure, never skipped.
const longEbitda = buildKnowledgeBase({
  ...params,
  financials: null,
  extractedInfo: { ebitda: "Adjusted EBITDA of $3,900,000 in FY2024 per the broker's normalization (Harjit replacement cost, below-market yard rent, one-time legal and systems costs)" },
});
assert.match(longEbitda, /CANONICAL FIGURES[\s\S]*EBITDA: \$3,900,000\n/);

// ── Figure check ──
const known = knownFiguresFrom(kb);
const table = (rows: Array<[string, string[]]>) => ({
  sectionTitle: "Historical Financial Performance",
  layoutType: "financial_table",
  layoutData: { headers: ["", "FY2023", "FY2024"], rows: rows.map(([label, values]) => ({ label, values })) },
});
const invented = checkSectionFigures(table([["Revenue", ["$29,180,000", "$31,020,000"]], ["Operating expenses", ["$25,100,000", "$26,480,000"]]]), known);
assert.ok(invented.some((m) => /26,480,000/.test(m) && /Operating expenses/.test(m) && /FY2024/.test(m)), `names the cell: ${invented.join(" | ")}`);
assert.ok(invented.some((m) => /operating expenses exceed revenue/.test(m) === false), "only real problems");

// Rounded figures written from the knowledge base pass.
assert.deepEqual(checkSectionFigures(table([["Revenue", ["$29.2M", "$31.0M"]], ["Gross profit", ["$8,567,100", "$9.31M"]]]), known), []);

// A row set that doesn't reconcile is flagged even when each figure is on file.
const unreconciled = checkSectionFigures(
  table([
    ["Revenue", ["$29,180,000", "$31,020,000"]],
    ["Cost of sales", ["$20,612,900", "$21,706,300"]],
    ["Gross profit", ["$8,567,100", "$9,313,700"]],
    ["Operating expenses", ["$5,447,500", "$5,567,500"]],
    ["EBITDA", ["$3,055,600", "$3,533,200"]],
  ]),
  known,
);
assert.ok(unreconciled.some((m) => /gross profit − operating expenses/.test(m)), `reconciliation: ${unreconciled.join(" | ")}`);
const reconciled = checkSectionFigures(
  table([
    ["Revenue", ["$29,180,000", "$31,020,000"]],
    ["Cost of sales", ["$20,612,900", "$21,706,300"]],
    ["Gross profit", ["$8,567,100", "$9,313,700"]],
    ["Operating expenses (incl. owner compensation)", ["$5,447,500", "$5,567,500"]],
  ]),
  known,
);
assert.deepEqual(reconciled, []);

// A bridge forced to a headline figure is flagged; the real bridge passes.
const bridge = (items: Array<[string, string, string]>) => ({
  sectionTitle: "EBITDA Bridge",
  layoutType: "waterfall_chart",
  layoutData: { items: items.map(([label, value, type]) => ({ label, value, type })) },
});
const forced = checkSectionFigures(bridge([["Net income", "$972,960", "start"], ["Interest", "$433,000", "add"], ["D&A", "$1,950,000", "add"], ["Adjusted EBITDA", "$3,900,000", "total"]]), known);
assert.ok(forced.some((m) => /433,000/.test(m)), "invented add-back amount flagged");
assert.ok(forced.some((m) => /steps add up to/.test(m)), "bridge that doesn't reach its total flagged");
const honest = checkSectionFigures(
  bridge([
    ["Net income", "$972,960", "start"],
    ["Interest", "$395,000", "add"],
    ["Income taxes", "$293,240", "add"],
    ["D&A", "$1,950,000", "add"],
    ["Below-market yard rent", "($78,000)", "subtract"],
    ["Adjusted EBITDA", "$3,533,200", "total"],
  ]),
  known,
);
assert.deepEqual(honest, []);

// Customer chart: only names on file.
const customers = checkSectionFigures(
  {
    sectionTitle: "Customer Diversification",
    layoutType: "horizontal_bar_chart",
    layoutData: { unit: "%", data: [{ name: "Alderbrook Grocery Distributors", value: 22 }, { name: "Fraser Valley Dairy Co-op", value: 5.2 }, { name: "Kestrel Building Supply", value: 8 }, { name: "All other customers", value: 64.8 }] },
  },
  known,
);
assert.ok(customers.some((m) => /Fraser Valley Dairy Co-op" is not a name on file/.test(m)), customers.join(" | "));
assert.ok(!customers.some((m) => /Alderbrook|Kestrel/.test(m) && /not a name/.test(m)), "names on file pass");
assert.ok(customers.some((m) => /5\.2%/.test(m)), "invented share flagged");

// An earlier AI draft is never a source: its invented EBITDA can't "trace".
const withDrafts = assembleKnowledgeBase({ ...params, cimContent: { financials: "Revenue reached $4,780,000 in the new division. EBITDA reached $4,780,000 in FY2024." } });
assert.match(withDrafts.text, /EARLIER DRAFTS[\s\S]*Revenue reached \$4,780,000/, "drafts still shown to the writer as wording");
// c-truth round V: a draft's off-bridge EBITDA sentence is dropped before the writer sees it.
assert.ok(!/EBITDA reached/.test(withDrafts.text), "an off-bridge earnings sentence in a draft is removed");
assert.ok(!/4,780,000/.test(withDrafts.sourceText));
assert.ok(
  checkSectionFigures(table([["EBITDA", ["", "$4,780,000"]]]), knownFiguresFrom(withDrafts.sourceText)).some((m) => /4,780,000/.test(m)),
  "a figure only an earlier draft had is flagged",
);

// parseFigures basics
assert.deepEqual(parseFigures("EBITDA margin 13.2% (2022)").map((f) => [f.value, f.kind]), [[13.2, "percent"], [2022, "plain"]]);
assert.equal(parseFigures("$1.1-1.2M")[0].value, 1_100_000);
assert.equal(parseFigures("in Q4 2024").length, 1, "Q4 is not a figure");

// ── Cover: system-owned fields ──
const cover = finalizeLayoutData("cover_page", { businessName: "X", preparedBy: "Bellamy & Rao LLP, Chartered Professional Accountants", date: "May 2025" }, today);
assert.equal((cover as any).preparedBy, undefined);
assert.equal((cover as any).date, "September 2026");
assert.deepEqual(finalizeLayoutData("prose_highlight", { body: "x", date: "May 2025" }, today), { body: "x", date: "May 2025" });

// ── Personal health details ──
const reason = "Founder (67) retiring after 34 years following a 2024 heart procedure; son (VP Ops) prefers to partner with a larger platform rather than carry fleet capex and personal guarantees alone.";
assert.ok(hasSensitiveDetail(reason));
const stripped = stripSensitiveDetail(reason)!;
assert.ok(!/heart|procedure/i.test(stripped), stripped);
assert.match(stripped, /retiring after 34 years/);
assert.match(stripped, /larger platform/);
for (const ok of [
  "Group benefits (extended health & dental), RRSP match 3%",
  "Health Canada licence for the pharmacy",
  "Occupational health and safety program; WorkSafeBC rating",
  "Services include oral surgery and implants",
  "Warehouse at the heart of the Lower Mainland",
]) assert.ok(!hasSensitiveDetail(ok), `business wording passes: ${ok}`);
for (const bad of ["Owner had a stroke last spring", "His recent cancer diagnosis", "Selling due to health reasons", "Retiring after her surgery in March", "Owner going through a divorce"]) {
  assert.ok(hasSensitiveDetail(bad), `caught: ${bad}`);
}

const healthKb = assembleKnowledgeBase({
  dealId: "d",
  businessName: "Pacific",
  industry: "Logistics",
  extractedInfo: { reasonForSale: reason, ownerNotes: "Owner had a health event in 2024." },
  questionnaireData: { reasonForSelling: "Retiring after my 2024 heart procedure" },
  cimContent: { executive_summary: "Harjit is retiring after 34 years following a 2024 heart procedure. The business is strong." },
  scrapedData: { description: "Family trucking firm" },
  today,
} as any);
assert.ok(!/heart|health event|procedure/i.test(healthKb.text), healthKb.text);
assert.match(healthKb.text, /retiring after 34 years/);
assert.ok(!/SELLER QUESTIONNAIRE/.test(healthKb.text), "no raw questionnaire dump");
assert.ok(healthKb.warnings.some((w) => /Held back from the CIM for your review/.test(w) && /Reason For Sale/.test(w)), healthKb.warnings.join(" | "));
assert.match(healthKb.text, /UNVERIFIED PUBLIC DATA \(website\/search — never state as fact without a confirmed fact agreeing\)/);

// Relative dates carry the date they were recorded.
const rel = buildKnowledgeBase({
  dealId: "d",
  businessName: "B",
  industry: "I",
  extractedInfo: {
    successionPlan: "Promoting Manpreet to GM in May",
    founded: "Founded in May 1990",
    _fieldSources: { successionPlan: { source: "interview", at: "2026-01-14T10:00:00Z" }, founded: { source: "interview", at: "2026-01-14T10:00:00Z" } },
  },
  today,
} as any);
assert.match(rel, /Promoting Manpreet to GM in May \[recorded Jan 2026\]/);
assert.match(rel, /Founded in May 1990\n|Founded in May 1990$/m, "an absolute date is left alone");

// The rendered financial block is stable text.
assert.match(renderCimFinancialsBlock(fin), /STATEMENT LINE ITEMS/);
assert.equal(renderCimFinancialsBlock(null), "");

// ── Planning survives a dropped connection ──
let calls = 0;
const manifestTool = {
  type: "tool_use",
  name: "cim_manifest",
  input: { sections: [{ sectionKey: "cover", sectionTitle: "Cover", order: 1, layoutType: "cover_page", tags: [], aiLayoutReasoning: "r", contentBrief: "b" }] },
};
_setAnthropicForTests(
  {
    messages: {
      stream: () => ({
        finalMessage: async () => {
          calls++;
          if (calls === 1) throw new Anthropic.APIConnectionError({ message: "Connection error." });
          return { stop_reason: "tool_use", content: [manifestTool], usage: { output_tokens: 10 } };
        },
      }),
    },
  },
  1,
);
const plan = await planCimManifest({ dealId: "d", businessName: "B", industry: "I", extractedInfo: {}, today } as any);
assert.equal(calls, 2, "retried once after the connection error");
assert.equal(plan[0].sectionTitle, "Cover");

// A non-transport error is not retried.
calls = 0;
_setAnthropicForTests(
  { messages: { stream: () => ({ finalMessage: async () => { calls++; throw Object.assign(new Error("invalid request"), { status: 400 }); } }) } },
  1,
);
await assert.rejects(planCimManifest({ dealId: "d", businessName: "B", industry: "I", extractedInfo: {}, today } as any));
assert.equal(calls, 1, "a 400 is not retried");
// ── A section with an invented figure is rewritten once with the problems ──
const tableTool = (rows: Array<[string, string[]]>) => ({
  type: "tool_use",
  name: "cim_section",
  input: { layoutData: { headers: ["", "FY2023", "FY2024"], rows: rows.map(([label, values]) => ({ label, values })) } },
});
const runWith = async (sectionReplies: any[]) => {
  const bodies: any[] = [];
  let n = 0;
  _setAnthropicForTests(
    {
      messages: {
        stream: (body: any) => ({
          finalMessage: async () => {
            bodies.push(body);
            if (body.tools[0].name === "cim_manifest") {
              return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_manifest", input: { sections: [
                { sectionKey: "cover", sectionTitle: "Cover", order: 1, layoutType: "cover_page", tags: [], aiLayoutReasoning: "r", contentBrief: "b" },
                { sectionKey: "fin", sectionTitle: "Historical Financial Performance", order: 2, layoutType: "financial_table", tags: [], aiLayoutReasoning: "r", contentBrief: "b" },
              ] } }] };
            }
            if (body.messages[0].content.includes('"Cover"')) {
              return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_section", input: { layoutData: { businessName: "Pacific", preparedBy: "Harmon Bains LLP", date: "May 2025", revenue: "$31,020,000" } } }] };
            }
            return { stop_reason: "tool_use", content: [sectionReplies[Math.min(n++, sectionReplies.length - 1)]] };
          },
        }),
      },
    },
    1,
  );
  const { generateCimLayout } = await import("../../server/cim/layout-engine");
  const doc = await generateCimLayout(params);
  return { doc, bodies };
};
const repaired = await runWith([
  tableTool([["Revenue", ["$29,180,000", "$31,020,000"]], ["Operating expenses", ["$25,100,000", "$26,480,000"]]]),
  tableTool([["Revenue", ["$29,180,000", "$31,020,000"]], ["Gross profit", ["$8,567,100", "$9,313,700"]]]),
]);
const fin2 = repaired.doc.sections.find((s) => s.sectionKey === "fin")!;
assert.ok(!JSON.stringify(fin2.layoutData).includes("26,480,000"), "the repaired version replaced the invented figures");
assert.equal(fin2.figureWarnings, undefined);
const repairCall = repaired.bodies.find((b) => /failed the figure check/.test(b.messages?.[0]?.content ?? ""));
assert.ok(repairCall && /26,480,000/.test(repairCall.messages[0].content), "the rewrite was told exactly which figure");
const coverOut = repaired.doc.sections.find((s) => s.layoutType === "cover_page")!;
assert.equal((coverOut.layoutData as any).preparedBy, undefined, "AI preparedBy stripped");
assert.equal((coverOut.layoutData as any).date, "September 2026", "cover dated the month it was written");
assert.ok(!(repaired.doc.warnings ?? []).some((w) => /Check the figures/.test(w)));

const stillBad = await runWith([
  tableTool([["Operating expenses", ["$25,100,000", "$26,480,000"]]]),
  tableTool([["Operating expenses", ["$25,100,000", "$26,480,000"]]]),
]);
const fin3 = stillBad.doc.sections.find((s) => s.sectionKey === "fin")!;
assert.ok(fin3.figureWarnings?.some((w) => /26,480,000/.test(w)), "unresolved figures stay flagged on the section");
assert.ok(stillBad.doc.warnings?.some((w) => /Check the figures in "Historical Financial Performance"/.test(w) && /26,480,000/.test(w)), "and named in document.warnings");
_setAnthropicForTests(null);

console.log("cim-truth: ok");
