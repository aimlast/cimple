/**
 * Round F (analysis): what reaches the CIM from the financial analysis.
 *
 *  - F-05: statement figures only the broker's private material states
 *    (a broker-only 2025 interim P&L, a CRM note) went into the CIM.
 *  - F-06: a seller's "2024 P&L.pdf" outside a checklist row stayed
 *    "other" and was never read as a statement.
 *  - F-07: the analysis never went stale when its documents changed.
 *  - F-08: a balance-sheet reclassification didn't recompute working
 *    capital or the peg; an add-back edit left notes stating old figures.
 *  - F-09: add-back verification was seeded with rejected lines, dividends
 *    and the split owner-pay halves; the DD writer listed them as add-backs.
 *  - F-10: an income-tax recovery was subtracted as a tax expense.
 *
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f-analysis-cim.test.ts
 */
import assert from "node:assert/strict";
import { buildFigureIndex, markPrivateStatements } from "../../server/financial/private-figures";
import { buildCimFinancials, cimFinancialsFor, renderCimFinancialsBlock, restatementWarnings, StaleFinancialAnalysisError } from "../../server/cim/cim-financials";
import { analysisSourceStatus, isFinancialStatementDoc, readAnalysisSources } from "../../server/financial/source-status";
import { categoryAfterLink, findMatchingRequirement } from "../../server/documents/requirements";
import { applyBrokerAnalysisEdit } from "../../server/financial/broker-edit";
import { seedAddbacksFromNormalization } from "../../server/financial/addback-seed";
import { buildDdContext } from "../../server/cim/dd-enrichment";
import { applyAddbackRules, applyWorkingCapitalRules, workingCapitalHistory } from "../../server/financial/normalization-rules";
import { computePnlNetIncome, findNetIncomeMismatches } from "../../server/financial/shape";
import { pnlNetIncome, expenseCategorySigns } from "../../shared/pnl-sign";

const row = (id: string, name: string, category: string, values: Record<string, number>) => ({ id, name, category, values });

// ── F-05: private-only statement figures stay out of the CIM until approved ──
{
  // Shared: the FY2023–24 statements. Private: a broker-only 2025 interim P&L and a CRM note.
  const index = buildFigureIndex(
    ["Revenue 2023 9,160,000 2024 9,815,000\nCost of sales 2023 6,412,000 2024 6,870,500\nNet income 2023 779,090 2024 896,410\nAccounts receivable 1,486,000 Accounts payable 842,000"],
    ["2025 interim P&L: Revenue 11,200,000; Cost of sales 7,840,000; Net income 1,020,000", "CRM note: 2025 tracking $11.2M"],
  );
  const pnl = { years: ["2023", "2024", "2025"], rows: [
    row("r", "Revenue", "Revenue", { "2023": 9_160_000, "2024": 9_815_000, "2025": 11_200_000 }),
    row("c", "Cost of sales", "COGS", { "2023": 6_412_000, "2024": 6_870_500, "2025": 7_840_000 }),
  ] };
  const normalization: any = { metric: "sde", years: ["2023", "2024", "2025"], netIncome: { "2023": 779_090, "2024": 896_410, "2025": 1_020_000 }, addbacks: [] };
  const marked = markPrivateStatements({ reclassifiedPnl: pnl, reclassifiedBalanceSheet: null, normalization, workingCapital: null }, index);
  assert.deepEqual(marked.reclassifiedPnl!.privateYears, ["2025"]);
  assert.deepEqual(marked.normalization!.privateYears, ["2025"]);
  assert.ok(marked.reclassifiedPnl!.notes!.some((n) => /2025 income statement column rests only on your private notes/.test(n)));
  // The CIM leaves 2025 out and tells the broker.
  const analysis: any = { id: "a", version: 2, status: "completed", reclassifiedPnl: marked.reclassifiedPnl, normalization: marked.normalization };
  const fin = buildCimFinancials(analysis)!;
  assert.deepEqual(Object.keys(fin.pnl!), ["2023", "2024"]);
  assert.ok(!renderCimFinancialsBlock(fin).includes("11,200,000"), "no private figure in the AUTHORITATIVE FINANCIALS block");
  assert.deepEqual(fin.bridge!.years, ["2023", "2024"]);
  assert.ok(restatementWarnings(fin).some((w) => /2025 income statement column rests only on your private notes/.test(w)));
  // Approved by the broker: it goes in.
  const approved = buildCimFinancials({ ...analysis, reclassifiedPnl: { ...marked.reclassifiedPnl, privateApproved: true }, normalization: { ...marked.normalization, privateApproved: true } })!;
  assert.deepEqual(Object.keys(approved.pnl!), ["2023", "2024", "2025"]);
  // A re-run marking the same years keeps the approval; a new private year needs a new one.
  const again = markPrivateStatements({ reclassifiedPnl: pnl, reclassifiedBalanceSheet: null, normalization, workingCapital: null }, index, { reclassifiedPnl: { ...marked.reclassifiedPnl!, privateApproved: true } });
  assert.equal(again.reclassifiedPnl!.privateApproved, true);
  // Shared figures are never marked (a statement figure the CRM note repeats is still the statements').
  const shared = markPrivateStatements({ reclassifiedPnl: { years: ["2024"], rows: [pnl.rows[0]] }, reclassifiedBalanceSheet: null, normalization: null, workingCapital: null }, buildFigureIndex(["Revenue 2024 9,815,000"], ["CRM: revenue 2024 $9,815,000"]));
  assert.equal(shared.reclassifiedPnl!.privateYears, undefined);
  // Working capital resting on a private figure is held.
  const wc = markPrivateStatements({ reclassifiedPnl: null, reclassifiedBalanceSheet: null, normalization: null, workingCapital: { currentAssets: [{ name: "Accounts receivable", amount: 1_486_000 }, { name: "Inventory", amount: 612_345 }], currentLiabilities: [], netWorkingCapital: 2_098_345 } }, buildFigureIndex(["AR 1,486,000"], ["broker notes: inventory 612,345"]));
  assert.equal(wc.workingCapital!.privateEvidence, true);
  assert.equal(buildCimFinancials({ id: "w", version: 1, status: "completed", workingCapital: wc.workingCapital } as any), null);
  console.log("✓ F-05: a 2025 column only a broker-only file states stays out of the CIM (warning) until the broker includes it");
}

// ── F-06: a P&L dropped outside the checklist is a financial statement ──
{
  const reqs = [{ id: "fs", documentName: "Financial Statements (3 Years)", category: "financial", status: "missing" }, { id: "lease", documentName: "Lease Agreement", category: "legal", status: "missing" }];
  const linked = findMatchingRequirement(reqs, "2024 P&L.pdf", "other");
  assert.equal(linked?.id, "fs");
  assert.equal(categoryAfterLink("other", linked), "financials", "the upload takes the row's category");
  assert.equal(categoryAfterLink("legal", linked), "legal", "an upload already categorised keeps its own");
  assert.equal(categoryAfterLink("other", null), "other");
  // The analysis reads a statement-named upload as a statement even when it stayed "other".
  assert.equal(isFinancialStatementDoc({ name: "Profit and Loss 2024.xlsx", category: "other" }), true);
  assert.equal(isFinancialStatementDoc({ name: "2024 P&L.pdf", category: null }), true);
  assert.equal(isFinancialStatementDoc({ name: "Balance Sheet Dec 2024.pdf", category: "other" }), true);
  assert.equal(isFinancialStatementDoc({ name: "Email thread - P&L questions", category: "other" }), false);
  assert.equal(isFinancialStatementDoc({ name: "Lease.pdf", category: "other" }), false);
  console.log("✓ F-06: '2024 P&L.pdf' matched to Financial Statements becomes 'financials' and is extracted as a statement");
}

// ── F-07: the analysis goes stale when its documents change ──
{
  const docs = [
    { id: "fs23", name: "FY2023 statements.pdf", category: "financials", isProcessed: true, extractedText: "x".repeat(80) },
    { id: "t2", name: "2023 T2 return.pdf", category: "other", isProcessed: true, extractedText: "tax" },
    { id: "lease", name: "Lease.pdf", category: "legal", isProcessed: true, extractedText: "lease" },
  ];
  const sources = [{ id: "fs23", name: "FY2023 statements.pdf", role: "statements" }, { id: "t2", name: "2023 T2 return.pdf", role: "tax" }, { id: "lease", name: "Lease.pdf", role: "other" }];
  const analysis: any = { id: "a", version: 1, status: "reviewed", sourceDocumentIds: sources, reclassifiedPnl: { years: ["2023"], rows: [row("r", "Revenue", "Revenue", { "2023": 1 })] } };
  assert.equal(analysisSourceStatus(analysis, docs).message, null, "nothing changed");
  // A statement used by the analysis is deleted: blocking.
  const gone = analysisSourceStatus(analysis, docs.filter((d) => d.id !== "fs23"));
  assert.equal(gone.blocking, true);
  assert.match(gone.message!, /deleted \(“FY2023 statements\.pdf”\)/);
  assert.throws(() => cimFinancialsFor([analysis], docs.filter((d) => d.id !== "fs23")), StaleFinancialAnalysisError);
  // A lease (not a financial source) deleted changes nothing (round F-2: no re-run invited).
  const lease = analysisSourceStatus(analysis, docs.filter((d) => d.id !== "lease"));
  assert.equal(lease.blocking, false);
  assert.equal(lease.message, null);
  // FY2024 statements added since: a warning in the CIM generation and the banner.
  const added = [...docs, { id: "fs24", name: "FY2024 statements.pdf", category: "financials", isProcessed: true, extractedText: "y".repeat(80) }];
  const st = analysisSourceStatus(analysis, added);
  assert.equal(st.blocking, false);
  assert.match(st.message!, /added since \(“FY2024 statements\.pdf”\)/);
  const fin = cimFinancialsFor([analysis], added)!;
  assert.ok(restatementWarnings(fin).some((w) => /FY2024 statements\.pdf/.test(w)));
  // A broker-only file added is not the analysis's business; an older row (bare ids) never blocks.
  assert.equal(analysisSourceStatus(analysis, [...docs, { id: "crm", name: "2025 interim P&L", category: "financials", isProcessed: true, extractedText: "z", visibility: "broker_only" }]).message, null);
  const legacy: any = { ...analysis, sourceDocumentIds: ["fs23", "t2"] };
  assert.deepEqual(readAnalysisSources(legacy.sourceDocumentIds), [{ id: "fs23" }, { id: "t2" }]);
  assert.equal(analysisSourceStatus(legacy, docs.filter((d) => d.id !== "fs23")).blocking, false);
  console.log("✓ F-07: a deleted statement stops CIM generation; a new one warns; the Financials tab says re-run");
}

// ── F-08: a broker edit recomputes what depends on it ──
{
  const bs = { years: ["2023", "2024"], rows: [
    row("ar", "Accounts receivable", "Current Assets", { "2023": 1_000_000, "2024": 1_200_000 }),
    row("inv", "Inventory", "Current Assets", { "2023": 400_000, "2024": 450_000 }),
    row("ap", "Accounts payable", "Current Liabilities", { "2023": 500_000, "2024": 550_000 }),
    row("dep", "Customer deposits", "Other Assets", { "2023": 100_000, "2024": 150_000 }),
  ] };
  const wc = applyWorkingCapitalRules({ currentAssets: [], currentLiabilities: [], netWorkingCapital: 0, asOfPeriod: "2024" }, bs as any)!;
  assert.equal(wc.pegAmount, 1_000_000); // (900,000 + 1,100,000) / 2
  const stored: any = { id: "a", status: "completed", reclassifiedBalanceSheet: bs, workingCapital: wc };
  // The broker moves "Customer deposits" into current liabilities.
  const edited = { ...bs, rows: bs.rows.map((r) => (r.id === "dep" ? { ...r, category: "Current Liabilities" } : r)) };
  const updates = applyBrokerAnalysisEdit(stored, { reclassifiedBalanceSheet: edited });
  const hist = workingCapitalHistory(edited as any);
  assert.deepEqual(hist, { "2023": 800_000, "2024": 950_000 });
  assert.equal(updates.workingCapital.pegAmount, 875_000, "the peg is the average of the new year-end figures");
  assert.equal(updates.workingCapital.netWorkingCapital, 950_000, "as-of NWC = the history's last year");
  assert.deepEqual(updates.workingCapital.history, hist);
  assert.equal(updates.reclassifiedBalanceSheet.rows.find((r: any) => r.id === "dep").categoryOverride, true);
  // Working capital the broker edited in the same save is theirs.
  const own = applyBrokerAnalysisEdit(stored, { reclassifiedBalanceSheet: edited, workingCapital: { ...wc, pegAmount: 123 } });
  assert.equal(own.workingCapital.pegAmount, 123);
  // An add-back edit rewrites a note that states the old figure.
  const norm: any = { metric: "sde", years: ["2024"], netIncome: { "2024": 500_000 }, notes: ["2024 SDE of $600,000."], addbacks: [{ id: "x", label: "Depreciation", category: "other", type: "ebitda", amounts: { "2024": 100_000 }, approved: true }] };
  const n2 = applyBrokerAnalysisEdit({ id: "b", status: "completed", normalization: norm, insights: { positive: [{ id: "i", type: "positive", title: "SDE", detail: "2024 SDE of $600,000." }], negative: [] } }, { normalization: { ...norm, addbacks: [{ ...norm.addbacks[0], approved: false }] } });
  assert.deepEqual(n2.normalization.notes, ["2024 SDE of $500,000."]);
  assert.equal(n2.normalization.adjustedSde, 500_000);
  assert.equal(n2.insights.positive[0].detail, "2024 SDE of $500,000.");
  assert.equal(n2.normalization.addbacks[0].approvedOverride, true);
  console.log("✓ F-08: moving a row into current liabilities recomputes NWC history, as-of NWC and the peg; notes follow add-back edits");
}

// ── F-09: add-back verification seeds only what the analysis adds back ──
{
  const n = applyAddbackRules({
    metric: "sde", years: ["2024"], netIncome: { "2024": 500_000 },
    addbacks: [
      { id: "own", label: "Owner salary", category: "owner_comp", amounts: { "2024": 180_000 }, ownerActualComp: { "2024": 180_000 }, marketSalary: 125_000, approved: true },
      { id: "div", label: "Dividends paid (Class D)", category: "other", amounts: { "2024": 60_000 }, approved: true },
      { id: "rej", label: "Owner's boat", category: "discretionary", amounts: { "2024": 30_000 }, approved: false, approvedOverride: true },
      { id: "priv", label: "Vehicle costs", category: "discretionary", amounts: { "2024": 40_000 }, approved: false, privateEvidence: true },
      { id: "crane", label: "Crane rebuild (one-time)", category: "one_time", amounts: { "2024": 64_000 }, approved: true },
    ] as any,
  })!;
  const seeded = seedAddbacksFromNormalization(n);
  assert.deepEqual(seeded.map((s) => [s.label, s.annualAmount]), [["Owner salary", 180_000], ["Crane rebuild (one-time)", 64_000]]);
  assert.match(seeded[0].description, /SDE adds back the full \$180,000; adjusted EBITDA only the \$55,000 above a \$125,000 market salary/);
  // The DD writer lists only lines the CIM's bridge adds back.
  const fin = buildCimFinancials({ id: "a", version: 1, status: "completed", normalization: n } as any);
  const dd = buildDdContext({
    financials: fin,
    addbackVerification: { status: "verified", addbacks: [
      { label: "Owner salary", verificationStatus: "seller_confirmed", matchedTransactions: [1, 2] },
      { label: "Dividends paid (Class D)", verificationStatus: "seller_confirmed", matchedTransactions: [1, 2] },
      { label: "Owner's boat", verificationStatus: "seller_confirmed", matchedTransactions: [] },
      { label: "Crane rebuild (one-time)", verificationStatus: "document_verified", matchedTransactions: [1] },
    ] },
  });
  const block = dd.context.split("## Add-back verification")[1]?.split("##")[0] ?? "";
  assert.match(block, /Owner salary: confirmed by the seller/);
  assert.match(block, /Crane rebuild \(one-time\): document_verified/);
  assert.ok(!/Dividends|boat/.test(block), block);
  console.log("✓ F-09: verification is seeded with approved lines and one owner-pay line at $180,000; the DD writer never lists a dividend");
}

// ── F-10: an income-tax recovery adds to net income ──
{
  const pnl: any = { years: ["2023", "2024"], rows: [
    row("r", "Revenue", "Revenue", { "2023": 2_000_000, "2024": 1_800_000 }),
    row("c", "Cost of sales", "COGS", { "2023": 1_200_000, "2024": 1_150_000 }),
    row("o", "Operating expenses", "Operating Expenses", { "2023": 600_000, "2024": 700_000 }),
    row("t", "Income taxes (recovery)", "Taxes", { "2023": 40_000, "2024": -12_000 }),
  ] };
  const ni = computePnlNetIncome(pnl);
  assert.equal(ni["2023"], 160_000);
  assert.equal(ni["2024"], -38_000, "−50,000 before tax + a 12,000 recovery (was −62,000)");
  assert.deepEqual(findNetIncomeMismatches(pnl, { metric: "sde", years: ["2023", "2024"], netIncome: { "2023": 160_000, "2024": -38_000 }, addbacks: [] }), [], "ties to the reported figure");
  // A one-year loss with only a recovery line — named as one.
  const oneYear: any = { years: ["2024"], rows: [row("r", "Revenue", "Revenue", { "2024": 100 }), row("t", "Future income taxes (recovery)", "Taxes", { "2024": -10 })] };
  assert.equal(computePnlNetIncome(oneYear)["2024"], 110);
  // A statement written with negative expenses throughout is still read the other way round.
  const negative: any = { years: ["2024"], rows: [row("r", "Revenue", "Revenue", { "2024": 1_000 }), row("c", "COGS", "COGS", { "2024": -600 }), row("o", "Rent", "Operating Expenses", { "2024": -100 })] };
  assert.equal(computePnlNetIncome(negative)["2024"], 300);
  assert.deepEqual(expenseCategorySigns(negative.rows), { COGS: -1, "Operating Expenses": -1 });
  // One category written negative (no recovery named): as before.
  const oneCat: any = { years: ["2024"], rows: [row("r", "Revenue", "Revenue", { "2024": 1_000 }), row("c", "COGS", "COGS", { "2024": 600 }), row("d", "Depreciation", "Depreciation", { "2024": -50 })] };
  assert.equal(pnlNetIncome(oneCat.rows, ["2024"])["2024"], 350);
  // The CIM's P&L shows the recovery as a recovery.
  const fin = buildCimFinancials({ id: "a", version: 1, status: "completed", reclassifiedPnl: pnl, normalization: { metric: "sde", years: ["2023", "2024"], netIncome: { "2023": 160_000, "2024": -38_000 }, addbacks: [] } } as any)!;
  assert.equal(fin.pnl!["2024"].taxes, -12_000);
  assert.equal(fin.pnl!["2024"].incomeBeforeTaxes, -50_000);
  const text = renderCimFinancialsBlock(fin);
  assert.match(text, /Income taxes \(a recovery — money back from taxes — is shown in parentheses and adds to net income\): 2023 \$40,000 · 2024 \(\$12,000\)/);
  assert.ok(!/restated|do not tie|don't tie/.test(restatementWarnings(fin).join(" ")), "2024 ties");
  console.log("✓ F-10: 'Income taxes (recovery) −12,000' adds $12,000 to net income; the CIM shows ($12,000)");
}

console.log("f-analysis-cim: all passed");
