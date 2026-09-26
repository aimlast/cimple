/**
 * Round A (a-cim): the CIM defects the live acceptance run found on the
 * Pacific clone, replayed from the recorded artefacts (facts after the
 * reprocess, the stored financial analysis, the generated sections) — no
 * model calls.
 *
 *  ACC2-01  Working Capital set all-in NWC ($1,022,999, cash and the current
 *           portion of LTD included) beside the cash-free, debt-free $2.4M peg
 *           and promised buyers a seller-funded shortfall.
 *  ACC2-09  "646 inspections, 1 driver OOS, 5 vehicle OOS" beside a 9.4% rate
 *           (a glued table); "Coquihalla Highway was cut at Sumas"; the 2023
 *           debt ($7,570,000) "as of December 31, 2024"; "$350,000 drawn";
 *           Kestrel on "evergreen terms".
 *  ACC2-10  True ranks (largest = Alderbrook, second = Kestrel) flagged.
 *  ACC2-11  A paragraph in a table's title drawn in tracked capitals.
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildCimFinancials, cimWorkingCapital, renderCimFinancialsBlock } from "../../server/cim/cim-financials";
import {
  countRateMismatches,
  debtProblems,
  factConsistency,
  mixesWorkingCapitalDefinitions,
  workingCapitalProblems,
  workingCapitalSectionData,
  yearOfFigure,
} from "../../server/cim/consistency-check";
import { assembleKnowledgeBase, sectionFigureWarnings, type CimLayoutParams } from "../../server/cim/layout-engine";
import { resolvedNotes } from "../../server/cim/resolved-block";
import { checkSectionFigures, knownFiguresFrom } from "../../server/cim/figure-check";
import { isParagraphTitle, tidyGeneratedLayout } from "../../shared/cim-layouts";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cim");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const facts: Record<string, unknown> = read("pacific-acc2-facts.json");
const analysis = read("pacific-acc2-analysis.json");
const sections: Array<{ sectionTitle: string; layoutType: string; layoutData: any }> = read("pacific-acc2-sections.json");
const resolved = read("pacific-acc2-resolved.json");
const today = new Date("2026-09-26T12:00:00Z");
const section = (title: string) => sections.find((s) => s.sectionTitle === title)!;
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
const kb = assembleKnowledgeBase(params);

// ── ACC2-01: working capital on the peg's basis ─────────────────────────
{
  const wc = fin.workingCapital!;
  assert.equal(wc.netWorkingCapital, 2538000, "AR + inventory + prepaids − AP, cash and debt out");
  assert.equal(wc.allInNetWorkingCapital, 1022999, "the stored all-in figure is kept only to recognise it");
  assert.deepEqual(wc.excluded.map((i) => i.name).sort(), ["Bank indebtedness (operating line)", "Cash", "Current portion of long-term debt", "Income taxes payable"]);
  assert.deepEqual(wc.history, { "2022": 2410000, "2023": 2522000, "2024": 2538000 }, "year-end NWC from the balance sheet, same basis");
  assert.equal(wc.pegAmount, 2400000, "the analysis's peg is kept");
  // Idempotent on a run already on the cash-free basis.
  const again = cimWorkingCapital({ ...analysis.workingCapital, currentAssets: wc.currentAssets, currentLiabilities: wc.currentLiabilities, netWorkingCapital: wc.netWorkingCapital });
  assert.equal(again!.netWorkingCapital, 2538000);
  assert.equal(again!.allInNetWorkingCapital, null);

  const block = renderCimFinancialsBlock(fin);
  assert.match(block, /Net working capital \(cash-free, debt-free\): \$2,538,000/);
  assert.match(block, /Not part of net working capital[^\n]*Cash \$1,022,999[^\n]*Current portion of long-term debt \$2,420,000/);
  assert.match(block, /was \$138,000 above the peg/, "the difference from the peg is computed in code");
  assert.doesNotMatch(block, /Net working capital: \$1,022,999/);
  assert.match(block, /Term debt incl\. current portion: 2022 \$6,950,000 · 2023 \$7,570,000 · 2024 \$7,860,000/);
  assert.match(block, /Drawn on the operating line \/ bank indebtedness: 2022 \$0 · 2023 \$350,000 · 2024 \$0/);

  // The stale all-in fact never reaches the writer; the peg fact does.
  assert.doesNotMatch(kb.text, /Working Capital: \$1,022,999 net working capital/);
  assert.match(kb.text, /Normalized Working Capital: \$2\.4M/);
  has(kb.warnings, /Left out of the CIM: "Working Capital" \(\$1,022,999\) is total current assets less total current liabilities/, "the broker is told");

  // The recorded section is rejected: cash/debt lines, $1,022,999 and "$1.0 million" as NWC.
  const recorded = section("Working Capital");
  const issues = sectionFigureWarnings(params, recorded);
  has(issues, /"Cash", "Bank indebtedness", "Income taxes payable", "Current portion of long-term debt" are listed as working capital/, "mixed lines");
  has(issues, /net working capital given as \$1,022,999 — on the cash-free, debt-free basis \(the peg's\) it is \$2,538,000/, "table NWC");
  has(issues, /net working capital given as \$1\.0 million/, "prose NWC");
  assert.ok(mixesWorkingCapitalDefinitions(workingCapitalProblems(recorded, fin.workingCapital)));

  // Without an analysis the mixed table is still rejected (no peg basis to compare, but cash beside a target).
  has(workingCapitalProblems(recorded, null), /are listed as working capital/, "no analysis");

  // The code-built replacement passes every check.
  const rebuilt = workingCapitalSectionData(wc);
  const candidate = { sectionTitle: "Working Capital", layoutType: rebuilt.layoutType, layoutData: rebuilt.layoutData };
  assert.deepEqual(sectionFigureWarnings(params, candidate), [], "rebuilt section is clean");
  const rows = (rebuilt.layoutData.rows as any[]).map((r) => r.label);
  assert.ok(!rows.some((l) => /cash|current portion|income tax|bank/i.test(l)), rows.join(", "));
  assert.deepEqual((rebuilt.layoutData.rows as any[]).at(-1), { label: "Net working capital", left: "$2,538,000", right: "$2,400,000", highlight: true });

  // A section that states the right figure passes; a claimed shortfall does not.
  const good = { sectionTitle: "Working Capital", layoutType: "prose_highlight", layoutData: { body: "The sale is cash-free and debt-free. Net working capital was $2,538,000 at December 31, 2024, against a peg of $2,400,000." } };
  assert.deepEqual(workingCapitalProblems(good, wc), []);
  const shortfall = { sectionTitle: "Working Capital", layoutType: "prose_highlight", layoutData: { body: "Net working capital of $2,538,000 is below the target of $2,400,000." } };
  has(workingCapitalProblems(shortfall, wc), /says working capital is short of the peg/, "shortfall claim");
  // A balance-sheet table that isn't about working capital is left alone.
  const bs = { sectionTitle: "Balance Sheet", layoutType: "financial_table", layoutData: { headers: ["", "2024"], rows: [{ label: "Cash", values: ["$1,022,999"] }, { label: "Current portion of long-term debt", values: ["$2,420,000"] }] } };
  assert.deepEqual(workingCapitalProblems(bs, wc), []);
}

// ── ACC2-09: counts vs rates ────────────────────────────────────────────
{
  const glued = countRateMismatches("2022: 589 inspections, 36 out-of-service, 15.5% OOS rate · 2023: 711 inspections, 25 driver OOS, 7 vehicle OOS, 16.9% OOS rate · 2024: 646 inspections, 1 driver OOS, 5 vehicle OOS, 9.4% OOS rate");
  assert.equal(glued.length, 3, JSON.stringify(glued));
  assert.deepEqual([glued[2].parts, glued[2].total, glued[2].rate, glued[2].computed], [6, 646, 9.4, 0.9]);
  assert.deepEqual(countRateMismatches("2024: 64 inspections, 6 out-of-service (1 driver OOS, 5 vehicle OOS), 9.4% OOS rate"), [], "true figures pass");
  assert.deepEqual(countRateMismatches("Driver turnover 18% in 2024; 96 drivers, 24 with 10+ years"), [], "no rate/count pair");
  assert.deepEqual(countRateMismatches("On-time delivery rate of 98.5% across 12,000 deliveries"), [], "no counts of the event");

  // The facts: the misread counts left out, every year's rate kept (round 2:
  // holding the whole fact lost the true 2022/2023 rates); the counts-only
  // fact held; the broker told.
  assert.match(kb.text, /Roadside Inspections By Year: 2022: 15\.5% OOS rate · 2023: 16\.9% OOS rate · 2024: 9\.4% OOS rate\n/);
  assert.doesNotMatch(kb.text, /\b(?:589|711|646)\b/, "no misread count reaches the writer");
  assert.doesNotMatch(kb.text, /Cvsa Inspections By Year/);
  assert.match(kb.text, /Cvsa O O S Rate2024: 9\.4%|OOS Rate2024: 9\.4%|Rate2024: 9\.4%/);
  has(kb.warnings, /Counts that don't add up were left out of the CIM \(the rates stated with them are kept\): "Roadside Inspections By Year" \(36 of 589 inspections is 6\.1%/, "warning");
  // A section with the true rate trend passes (it used to be "no source for 15.5%").
  const trend = { sectionTitle: "Safety & Compliance", layoutType: "prose_highlight", layoutData: { body: "The out-of-service rate fell from 15.5% in 2022 and 16.9% in 2023 to 9.4% in 2024." } };
  lacks(sectionFigureWarnings(params, trend), /15\.5|16\.9|9\.4/, "the true rates are on file");
  // The recorded Safety section is rejected for the counts.
  const safety = sectionFigureWarnings(params, section("Safety & Compliance"));
  has(safety, /the counts don't match the rate: 6 of 646 inspections is 0\.9%, not the 9\.4% stated/, "section counts");
}

// ── ACC2-09: debt by year ───────────────────────────────────────────────
{
  assert.equal(yearOfFigure("($7,570,000 total as of December 31, 2024)", 1, 11), "2024");
  assert.equal(yearOfFigure("Total $7,570,000 (2022: $6,950,000)", 6, 16), null, "the 2022 belongs to the next figure");
  assert.equal(yearOfFigure("At December 31, 2023, $350,000 drawn", 22, 30), "2023");

  const ts = sectionFigureWarnings(params, section("Transaction Structure"));
  has(ts, /\$7,570,000 is the 2023 year-end term debt, not 2024's; at 2024 year-end the term debt was \$7,860,000/, "wrong-year debt");
  const right = { sectionTitle: "Transaction Structure", layoutType: "callout_list", layoutData: { items: [{ title: "Debt", description: "Equipment loans ($7,860,000 as of December 31, 2024) are repaid at closing; the operating line was undrawn at year end." }] } };
  assert.deepEqual(debtProblems(right, fin.debt), []);
  const table = { sectionTitle: "Debt", layoutType: "financial_table", layoutData: { headers: ["", "FY2022", "FY2023", "FY2024"], rows: [{ label: "Term debt", values: ["$6,950,000", "$7,570,000", "$7,860,000"] }] } };
  assert.deepEqual(debtProblems(table, fin.debt), [], "a year column dates each figure");
  const undated = { sectionTitle: "Debt", layoutType: "prose_highlight", layoutData: { body: "The company has $350,000 drawn on its operating line." } };
  has(debtProblems(undated, fin.debt), /\$350,000 is the 2023 year-end operating-line draw — state it with its year; at 2024 year-end the operating-line draw was nil/, "undated draw");

  // The facts carrying 2023 balances are marked for the writer, and the broker is told.
  assert.match(kb.text, /Debt Details: [^\n]*\[balance sheet: \$350,000 is the 2023 year-end operating-line draw \(2024: nil\); \$7,570,000 is the 2023 year-end term debt \(2024: \$7,860,000\)/);
  assert.doesNotMatch(kb.text, /Bank Facility: [^\n]*\[balance sheet/, "a figure the fact dates itself is fine");
  has(kb.warnings, /Debt figures on file are from an earlier year than the latest statements/, "debt warning");
}

// ── ACC2-10: true ranks pass, invented ones don't ───────────────────────
{
  const kc = sectionFigureWarnings(params, section("Key Customer Relationships"));
  lacks(kc, /no such ranking/, "Alderbrook largest / Kestrel second-largest are on file");
  has(kc, /"evergreen" for "Kestrel Building Supply" — no fact ties those terms to it/, "evergreen is the rest of the top 10's");
  const wrong = (title: string, badge: string) => ({ sectionTitle: "Key Customers", layoutType: "callout_list", layoutData: { items: [{ title, badge, description: "A customer." }] } });
  has(sectionFigureWarnings(params, wrong("Kestrel Building Supply", "Largest customer")), /"Largest" for "Kestrel Building Supply" — no such ranking/, "Kestrel isn't the largest");
  has(sectionFigureWarnings(params, wrong("Tidewater Beverage", "Top 2")), /"Top 2" for "Tidewater Beverage"/, "Tidewater isn't top 2");
  // Found only by description, in a clause naming someone else: not a rank for it.
  const other = knownFiguresFrom("Customer Base: largest is Alderbrook (grocery distributor, 22.0% of FY2024 revenue)", undefined, {});
  has(checkSectionFigures(wrong("Fraser Grocery Distributors", "Largest customer"), other), /no such ranking/, "another grocery distributor");
  // An ordered list gives positions.
  const list = knownFiguresFrom("Customer Revenue: Top 10 customers FY2024: 1. Alderbrook Grocery Distributors Ltd. $6,824,400 (grocery); 2. Kestrel Building Supply Inc. $2,480,000 (building materials); 3. Tidewater Beverage Co. $1,990,000", undefined, {});
  lacks(checkSectionFigures(wrong("Kestrel Building Supply", "#2 customer"), list), /no such ranking/, "list position 2");
  lacks(checkSectionFigures(wrong("Tidewater Beverage Co.", "Top 3"), list), /no such ranking/, "list position within top 3");
  has(checkSectionFigures(wrong("Tidewater Beverage Co.", "Second-largest"), list), /no such ranking/, "list position 3 is not second");
}

// ── ACC2-09: places and periods ─────────────────────────────────────────
{
  const ca = sectionFigureWarnings(params, section("Competitive Advantages"));
  has(ca, /"Coquihalla Highway" is on file only for something else/, "Coquihalla is the winter-closures highway");
  const seasonal = { sectionTitle: "Seasonality", layoutType: "prose_highlight", layoutData: { body: "Winter weather closures on the Coquihalla Highway add cost in the first quarter." } };
  lacks(sectionFigureWarnings(params, seasonal), /Coquihalla/, "the Coquihalla in its own context");
  const floods = { sectionTitle: "Resilience", layoutType: "prose_highlight", layoutData: { body: "During the 2021 floods, when the highway was cut at Sumas, the company kept stores fully stocked." } };
  lacks(sectionFigureWarnings(params, floods), /highway|Sumas/i, "the facts' own wording");

  // "$347,000 annually": the analysis gives it for every year — fine; a one-year fact isn't.
  const fs2 = sectionFigureWarnings(params, section("Financial Summary"));
  lacks(fs2, /every year's/, "owner compensation is $347,000 in each year on file");
  const one = knownFiguresFrom("Owner Pay: $412,000 (2024)", undefined, {});
  has(checkSectionFigures({ sectionTitle: "Owner", layoutType: "prose_highlight", layoutData: { body: "The owner draws $412,000 annually." } }, one), /"\$412,000" is given as every year's, but on file it is the 2024 figure only/, "one year's figure");
}

// ── ACC2-11: body text out of titles ────────────────────────────────────
{
  const wcData = section("Working Capital").layoutData;
  assert.ok(isParagraphTitle(wcData.title));
  assert.ok(!isParagraphTitle("FY2022–FY2024, CAD"));
  assert.ok(!isParagraphTitle("Share of 2024 revenue"));
  const tidy = tidyGeneratedLayout("comparison_table", wcData);
  assert.equal(tidy.layoutData.title, undefined);
  assert.match(String(tidy.layoutData.intro), /^The transaction will be structured on a cash-free, debt-free basis/);
  assert.equal(tidyGeneratedLayout("comparison_table", { title: "As of December 31, 2024", rows: [] }).layoutData.title, "As of December 31, 2024");
  const ft = tidyGeneratedLayout("financial_table", { caption: "Figures are from the reviewed statements. Owner pay is shown before add-backs.", headers: [], rows: [] });
  assert.match(String(ft.layoutData.intro), /^Figures are from the reviewed statements/);
}

// ── Nothing new on the other recorded sections ──────────────────────────
{
  for (const s of sections) {
    if (["Working Capital", "Safety & Compliance", "Transaction Structure", "Key Customer Relationships", "Competitive Advantages", "Business Overview", "Customer Base & Diversification"].includes(s.sectionTitle)) continue;
    assert.deepEqual(sectionFigureWarnings(params, s), [], `${s.sectionTitle} stays clean`);
  }
}

console.log("a-cim-consistency: ok");
