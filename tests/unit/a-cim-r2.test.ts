/**
 * Round A, round 2 (a-cim): what the checker found open after round 1,
 * proved offline (recorded artefacts + a scripted model — no paid call).
 *
 *  - Counts vs rates: a rate whose noun is plural or qualified ("Claims rate
 *    1.2% … 60 claims") took the event count itself as the population and
 *    held four TRUE facts; Pacific's whole inspections fact was held, losing
 *    the true 2022/2023 rates.
 *  - Working capital: any flagged section was rebuilt as the working-capital
 *    table (a Transaction Structure list and a balance sheet lost their
 *    content); a correct balance sheet with a cash-free NWC row was flagged
 *    for listing cash and debt.
 *  - Ridgeline's stored peg ($1,555,000) is its all-in NWC ($1,555,130): it
 *    was handed to the writer as "$318,000 below the peg".
 *  - Pacific's NWC with income taxes payable counted ($2,420,000, the
 *    statements' own figure) was flagged as wrong.
 *  - A title with an abbreviation ("Revenue vs. Adjusted EBITDA") was moved
 *    to the intro as if it were a paragraph.
 *  - "$7,570,000 at December 31, 2023 were reduced to $7,860,000 by year-end
 *    2024" dated $7,860,000 to 2023.
 *  - The $29K of legal fees tied to the $55K settlement add-back.
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { applyWorkingCapitalRules } from "../../server/financial/normalization-rules";
import { buildCimFinancials, cimWorkingCapital, renderCimFinancialsBlock } from "../../server/cim/cim-financials";
import {
  addbackCompanions,
  countRateMismatches,
  factConsistency,
  isWorkingCapitalSection,
  stripMismatchedCounts,
  withoutWorkingCapitalClaims,
  workingCapitalProblems,
  yearOfFigure,
} from "../../server/cim/consistency-check";
import { assembleKnowledgeBase, generateCimLayout, sectionFigureWarnings, _setAnthropicForTests, type CimLayoutParams } from "../../server/cim/layout-engine";
import { resolvedNotes } from "../../server/cim/resolved-block";
import { isParagraphTitle, tidyGeneratedLayout } from "../../shared/cim-layouts";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cim");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const facts: Record<string, unknown> = read("pacific-acc2-facts.json");
const analysis = read("pacific-acc2-analysis.json");
const recorded: Array<{ sectionKey: string; sectionTitle: string; layoutType: string; layoutData: any }> = read("pacific-acc2-sections.json");
const resolved = read("pacific-acc2-resolved.json");
const ridgeline = read("ridgeline-v1-analysis.json");
const today = new Date("2026-09-26T12:00:00Z");
const has = (issues: string[], re: RegExp, what: string) => assert.ok(issues.some((m) => re.test(m)), `${what}: ${issues.join(" | ")}`);
const lacks = (issues: string[], re: RegExp, what: string) => assert.ok(!issues.some((m) => re.test(m)), `${what}: ${issues.join(" | ")}`);

const fin = buildCimFinancials(analysis, [analysis])!;
const params: CimLayoutParams = {
  dealId: "d",
  businessName: "Pacific Coast Logistics Ltd.",
  industry: "Transportation & Logistics",
  askingPrice: "$18,000,000",
  extractedInfo: facts,
  resolvedDiscrepancies: resolvedNotes(resolved),
  financials: fin,
  today,
};

// ── Counts vs rates: true facts pass, misread counts go, rates stay ─────
{
  for (const t of [
    "Claims rate 1.2% on 5,000 shipments, 60 claims",
    "Returns rate 2.1%: 210 returns on 10,000 orders",
    "Warranty rate 1.5% — 45 warranty claims on 3,000 installs",
    "Cargo claims rate 0.12% on 50,000 shipments (60 claims)",
  ]) {
    assert.deepEqual(countRateMismatches(t), [], t);
    const fc = factConsistency([["qualityRecord", t]], null, (k) => k);
    assert.deepEqual([fc.held, fc.rewrites, fc.warnings], [[], {}, []], `${t} is not held`);
  }
  // A wrong one is still caught — including when the rate names the population.
  assert.equal(countRateMismatches("Claims rate 1.2% on 5,000 shipments, 600 claims").length, 1);
  assert.equal(countRateMismatches("Inspection OOS rate 9.4% across 646 inspections, 6 OOS").length, 1);
  assert.deepEqual(countRateMismatches("Inspection OOS rate 9.4% across 64 inspections, 6 OOS"), []);

  const glued = "2022: 589 inspections, 36 out-of-service, 15.5% OOS rate · 2023: 711 inspections, 25 driver OOS, 7 vehicle OOS, 16.9% OOS rate · 2024: 646 inspections, 1 driver OOS, 5 vehicle OOS, 9.4% OOS rate";
  assert.equal(stripMismatchedCounts(glued).text, "2022: 15.5% OOS rate · 2023: 16.9% OOS rate · 2024: 9.4% OOS rate");
  assert.equal(stripMismatchedCounts("646 inspections (1 driver OOS, 5 vehicle OOS), 9.4% OOS rate").text, "9.4% OOS rate");
  const right = "2024: 64 inspections, 6 out-of-service, 9.4% OOS rate";
  assert.equal(stripMismatchedCounts(right).text, right, "true counts stay");
  // Mixed: only the year that doesn't add up loses its counts.
  assert.equal(stripMismatchedCounts(`2023: 71 inspections, 12 out-of-service, 16.9% OOS rate · 2024: 646 inspections, 6 out-of-service, 9.4% OOS rate`).text, "2023: 71 inspections, 12 out-of-service, 16.9% OOS rate · 2024: 9.4% OOS rate");

  // The same misread counts in a counts-only fact: those entries go, the fact is held when nothing is left.
  const fc = factConsistency(
    [
      ["roadsideInspectionsByYear", glued],
      ["cvsaInspectionsByYear", "2022: 589 · 2023: 711 · 2024: 646"],
      ["inspectionStationsByYear", "2023: 711 · 2024: 12 stations"],
    ],
    null,
    (k) => k,
  );
  assert.deepEqual(fc.held, ["cvsaInspectionsByYear"]);
  assert.equal(fc.rewrites.roadsideInspectionsByYear, "2022: 15.5% OOS rate · 2023: 16.9% OOS rate · 2024: 9.4% OOS rate");
  assert.equal(fc.rewrites.inspectionStationsByYear, "2024: 12 stations");
}

// ── Working capital: only a working-capital section is rebuilt ──────────
const wc = fin.workingCapital!;
const strayItem = { icon: "currency", title: "Working Capital", description: "Net working capital of approximately $1.0 million at year end, against a normalized peg of $2.4M, with any shortfall funded by the seller." };
const transaction = {
  sectionTitle: "Transaction Structure",
  layoutType: "callout_list",
  layoutData: {
    items: [
      { icon: "document", title: "Share Sale", description: "A share sale of Pacific Coast Logistics Ltd., on a cash-free, debt-free basis. Asking price $18,000,000." },
      strayItem,
      { icon: "handshake", title: "Vendor Take-Back Financing", description: "Harjit Grewal is willing to provide a vendor take-back loan of approximately 10 percent of the purchase price." },
    ],
  },
};
const bsRows = [
  { label: "Cash", values: ["$959,004", "$1,024,059", "$1,022,999"] },
  { label: "Accounts receivable", values: ["$4,050,000", "$4,210,000", "$4,380,000"] },
  { label: "Property and equipment (net)", values: ["$13,430,000", "$14,510,000", "$15,160,000"] },
  { label: "Accounts payable and accrued liabilities", values: ["$2,310,000", "$2,420,000", "$2,640,000"] },
  { label: "Current portion of long-term debt", values: ["$2,080,000", "$2,210,000", "$2,420,000"] },
  { label: "Long-term debt", values: ["$4,870,000", "$5,360,000", "$5,440,000"] },
  { label: "Retained earnings", values: ["$8,699,274", "$9,065,189", "$9,738,149"] },
];
const balanceAllIn = {
  sectionTitle: "Balance Sheet Summary",
  layoutType: "financial_table",
  layoutData: { headers: ["", "FY2022", "FY2023", "FY2024"], rows: [...bsRows, { label: "Working capital", values: ["$1,164,004", "$926,059", "$1,022,999"] }] },
};
const balanceRight = {
  sectionTitle: "Balance Sheet Summary",
  layoutType: "financial_table",
  layoutData: { headers: ["", "FY2022", "FY2023", "FY2024"], rows: [...bsRows, { label: "Net working capital (cash-free, debt-free)", values: ["$2,410,000", "$2,522,000", "$2,538,000"] }] },
};
{
  // A correct balance sheet is not "listing cash as working capital".
  assert.deepEqual(workingCapitalProblems(balanceRight, wc), [], "cash and debt are a balance sheet's own lines");
  // The all-in row is still named — and only that row goes.
  has(workingCapitalProblems(balanceAllIn, wc), /net working capital given as \$1,022,999/, "all-in row");
  assert.equal(isWorkingCapitalSection(balanceAllIn), false);
  const bsFixed = withoutWorkingCapitalClaims(balanceAllIn, wc)!;
  assert.deepEqual((bsFixed.layoutData as any).rows, bsRows, "every balance-sheet row kept, the all-in row gone");
  assert.deepEqual(workingCapitalProblems({ ...balanceAllIn, layoutData: bsFixed.layoutData }, wc), []);

  assert.equal(isWorkingCapitalSection(transaction), false);
  const txFixed = withoutWorkingCapitalClaims(transaction, wc)!;
  assert.deepEqual((txFixed.layoutData as any).items.map((i: any) => i.title), ["Share Sale", "Vendor Take-Back Financing"]);
  assert.match(txFixed.removed[0], /approximately \$1\.0 million/);

  // A sentence in prose goes; the rest of the paragraph stays.
  const prose = { sectionTitle: "Deal Terms", layoutType: "prose_highlight", layoutData: { body: "The sale is a share sale. Net working capital of $1,022,999 compares with the $2,400,000 peg. The asking price is $18,000,000." } };
  assert.equal((withoutWorkingCapitalClaims(prose, wc)!.layoutData as any).body, "The sale is a share sale. The asking price is $18,000,000.");

  // Working-capital sections are still recognised for the rebuild.
  assert.ok(isWorkingCapitalSection(recorded.find((s) => s.sectionTitle === "Working Capital")!));
  assert.equal(isWorkingCapitalSection({ ...balanceAllIn, sectionTitle: "Balance Sheet & Working Capital" }), false, "a mixed-topic title keeps its content");
  assert.ok(isWorkingCapitalSection({ sectionTitle: "Closing Balance", layoutType: "comparison_table", layoutData: { rows: [{ label: "Accounts receivable", left: "$4,380,000" }, { label: "Cash", left: "$1,022,999" }, { label: "Accounts payable", left: "($2,640,000)" }, { label: "Net working capital", left: "$1,022,999" }] } }));
}

// ── Pacific: NWC with income taxes payable counted is a true figure ─────
{
  assert.deepEqual(wc.withIncomeTaxes, { incomeTaxesPayable: 118000, netWorkingCapital: 2420000, history: { "2022": 2285000, "2023": 2462000, "2024": 2420000 } });
  const block = renderCimFinancialsBlock(fin);
  assert.match(block, /counted as working capital, as some purchase agreements do, net working capital at December 31, 2024 is \$2,420,000 \(year-end: 2022 \$2,285,000 · 2023 \$2,462,000 · 2024 \$2,420,000\)/);
  assert.match(block, /was \$138,000 above the peg \(\$20,000 above the peg with income taxes payable counted as working capital\)/);
  const withTax = { sectionTitle: "Working Capital", layoutType: "prose_highlight", layoutData: { body: "Net working capital, counting income taxes payable, was $2,420,000 at December 31, 2024, against a peg of $2,400,000." } };
  assert.deepEqual(workingCapitalProblems(withTax, wc), [], "the statements' own figure");
  // A shortfall claim is still wrong on either treatment.
  has(workingCapitalProblems({ ...withTax, layoutData: { body: "Net working capital of $2,420,000 leaves a shortfall of $80,000 against the peg." } }, wc), /says working capital is short of the peg/, "shortfall");
}

// ── Ridgeline: a stored peg on the all-in basis is withheld ─────────────
{
  const rfin = buildCimFinancials(ridgeline, [ridgeline])!;
  const rwc = rfin.workingCapital!;
  assert.equal(rwc.netWorkingCapital, 1237000, "AR + contract assets + inventory + prepaids − AP − contract liabilities − remittances");
  assert.equal(rwc.pegAmount, null);
  assert.deepEqual([rwc.pegWithheld?.amount, rwc.pegWithheld?.allIn], [1555000, 1555130]);
  const block = renderCimFinancialsBlock(rfin);
  assert.doesNotMatch(block, /below the peg|above the peg|Working capital peg \(target\)/);
  assert.match(block, /No working capital peg can be stated: the peg on file \(\$1,555,000\) is net working capital counting cash and debt \(\$1,555,130\)/);
  const claim = { sectionTitle: "Working Capital", layoutType: "prose_highlight", layoutData: { body: "Net working capital at December 31, 2024 was $1,237,000, $318,000 below the working capital peg of $1,555,000." } };
  has(workingCapitalProblems(claim, rwc), /^states a working capital peg or a shortfall\/excess against one — the peg on file \(\$1,555,000\) is net working capital counting cash and debt/, "no peg");
  const fine = { sectionTitle: "Working Capital", layoutType: "prose_highlight", layoutData: { body: "Net working capital was $1,237,000 at December 31, 2024, on a cash-free, debt-free basis. A closing adjustment settles any difference from the agreed target." } };
  assert.deepEqual(workingCapitalProblems(fine, rwc), []);
  const kb = assembleKnowledgeBase({ dealId: "r", businessName: "Ridgeline Metal Fabrication Inc.", industry: "Metal fabrication", extractedInfo: { workingCapital: "To be calculated by accountant Heather." }, financials: rfin, today });
  has(kb.warnings, /No working capital peg is stated in the CIM: the peg on file \(\$1,555,000\)[^]*Re-run the financial analysis/, "the broker is told");
  // A re-run analysis (peg = average of the cash-free year-ends) is kept.
  const rerun = applyWorkingCapitalRules(ridgeline.workingCapital, ridgeline.reclassifiedBalanceSheet)!;
  const fresh = cimWorkingCapital(rerun, ridgeline.reclassifiedBalanceSheet)!;
  assert.equal(fresh.pegWithheld, undefined);
  assert.equal(fresh.pegAmount, 1153667);
  // Pacific's $2.4M peg is not on the all-in basis.
  assert.equal(wc.pegAmount, 2400000);
  assert.equal(wc.pegWithheld, undefined);
}

// ── Titles with abbreviations stay titles ───────────────────────────────
{
  for (const t of ["Revenue vs. Adjusted EBITDA", "U.S. vs. Canadian Revenue", "Dr. Smith's Patient Mix", "Revenue by Region (approx. share)", "St. Albert and Edmonton Sites"]) {
    assert.equal(isParagraphTitle(t), false, t);
    assert.equal(tidyGeneratedLayout("bar_chart", { title: t, data: [] }).layoutData.title, t);
  }
  assert.ok(isParagraphTitle("Revenue grew. Margins held."), "two sentences are a paragraph");
  assert.ok(isParagraphTitle("The transaction will be structured on a cash-free, debt-free basis. Working capital is adjusted at closing."));
}

// ── A date belongs to the figure it follows ─────────────────────────────
{
  const t = "Equipment loans of $7,570,000 at December 31, 2023 were reduced to $7,860,000 by year-end 2024.";
  const at = (fig: string) => [t.indexOf(fig), t.indexOf(fig) + fig.length] as const;
  assert.equal(yearOfFigure(t, ...at("$7,570,000")), "2023");
  assert.equal(yearOfFigure(t, ...at("$7,860,000")), "2024");
  const u = "At December 31, 2023, $350,000 was drawn";
  assert.equal(yearOfFigure(u, u.indexOf("$350,000"), u.indexOf("$350,000") + 8), "2023", "a leading date still dates its figure");
  const kb = { ...params };
  const debt = { sectionTitle: "Debt", layoutType: "prose_highlight", layoutData: { body: t } };
  lacks(sectionFigureWarnings(kb, debt), /year-end term debt/, "both figures carry their own years");
}

// ── A cost tied to an add-back that the add-backs leave out ─────────────
{
  const w = addbackCompanions([["legalNotes", "Wrongful dismissal claim - dispatcher fired for cause, settled 2024 for $55K plus ~$29K legal fees"]], fin, (k) => (k === "legalNotes" ? "Legal Notes" : k));
  assert.deepEqual(w, [
    `"Legal Notes" ties $29K of legal costs to "Wrongful dismissal settlement (one-time)" ($55,000 added back for 2024); the add-backs don't include it. If it was expensed that year and won't recur, add it on the Financials tab — the CIM shows the add-backs as approved.`,
  ]);
  const kb = assembleKnowledgeBase(params);
  has(kb.warnings, /"Legal Notes" ties \$29K of legal costs/, "reaches the broker even with the bridge withheld");
  assert.deepEqual(addbackCompanions([["x", "Relocation cost $186K plus $12K consulting fees"]], fin, (k) => k).length, 1);
  assert.deepEqual(addbackCompanions([["x", "Settled for $55K and nothing else"]], fin, (k) => k), []);
}

// ── A whole generation, scripted: nothing but the WC claim is lost ──────
{
  const planned = [
    { ...recorded.find((s) => s.sectionTitle === "Working Capital")! },
    { sectionKey: "transaction_structure", ...transaction },
    { sectionKey: "balance_sheet", ...balanceAllIn },
  ];
  _setAnthropicForTests(
    {
      messages: {
        stream: (body: any) => ({
          finalMessage: async () => {
            if (body.tools[0].name === "cim_manifest") {
              return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_manifest", input: { sections: planned.map((s, i) => ({ sectionKey: s.sectionKey, sectionTitle: s.sectionTitle, order: i + 1, layoutType: s.layoutType, tags: [], aiLayoutReasoning: "r", contentBrief: s.sectionTitle })) } }] };
            }
            // First write and rewrite alike return what was planned.
            const ask = String(body.messages[0].content);
            const s = planned.find((p) => ask.includes(`"${p.sectionTitle}"`))!;
            return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_section", input: { layoutData: s.layoutData } }] };
          },
        }),
      },
    },
    1,
  );
  const doc = await generateCimLayout(params);
  _setAnthropicForTests(null);
  const by = (t: string) => doc.sections.find((s) => s.sectionTitle === t)!;
  const warnings = doc.warnings ?? [];

  assert.equal(by("Working Capital").layoutType, "comparison_table", "the working-capital section is still rebuilt");
  assert.ok(!JSON.stringify(by("Working Capital").layoutData).includes("1,022,999"));

  const tx = by("Transaction Structure");
  assert.equal(tx.layoutType, "callout_list", "not replaced by the working-capital table");
  assert.deepEqual((tx.layoutData as any).items.map((i: any) => i.title), ["Share Sale", "Vendor Take-Back Financing"]);
  assert.match(JSON.stringify(tx.layoutData), /Asking price \$18,000,000/);
  assert.ok(warnings.some((w) => /"Transaction Structure" stated working capital on a different basis from the peg; taken out: "Working Capital: Net working capital of approximately \$1\.0 million/.test(w)), warnings.join("\n"));

  const bs = by("Balance Sheet Summary");
  assert.equal(bs.layoutType, "financial_table");
  assert.deepEqual((bs.layoutData as any).rows.map((r: any) => r.label), bsRows.map((r) => r.label), "the balance sheet keeps its lines");
  assert.ok(!warnings.some((w) => /"Balance Sheet Summary" set net working capital beside the peg on a different basis; it was rebuilt/.test(w)));
}

console.log("a-cim-r2: ok");
