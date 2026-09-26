// Fact merge + reprocess correctness (QA-harvest round V, stream f-merge) — offline checks, no database, no AI.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/information/f-merge-v.test.ts
import assert from "node:assert/strict";
import { mergeExtractedData, normaliseExtraction } from "../../server/documents/extractor";
import { overlayExistingFacts, type OverlayReport, type RereadRow } from "../../server/documents/reprocess";
import { startReprocessJob, reprocessJobFor } from "../../server/documents/reprocess-jobs";
import { groundedInSource, guardExtraction, STATED_METRIC_NOTE } from "../../server/documents/extraction-guard";
import { getFieldSources, getFieldAlternates, yearSource, canonicalFieldName } from "../../server/interview/info-merger";
import {
  isBrokerProcessKey, outranksFor, receivablesMeasureKey, reconcileHeadlines, relocateInterimYears, settleConflicts,
  UNREVIEWED_YEAR_NOTE, type MergeConflict,
} from "../../server/documents/merge-policy";
import { reconcileMirroredFacts } from "../../server/information/deal-mirror";
import { setBrokerFact } from "../../server/information/facts";
import { splitFactsForCim } from "../../server/information/cim-facts";

type Info = Record<string, unknown>;
let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
const doc = (documentId: string, extra: Record<string, unknown> = {}) => ({ documentId, source: "document" as const, ...extra });
const rowsOf = (entries: Array<[string, RereadRow]>) => new Map(entries);

(async () => {
  // ── 1. Reprocess replaces a row's contribution; stale values go ──────────
  {
    const FS22 = "FINANCIAL STATEMENTS December 31, 2022 (Review engagement)\nCash 959,004 1,102,094\nNet income 1,115,900 1,204,374\n" +
      "Revenue 28,640,000 25,480,000\nThe company serves the oil & gas, agricultural and commercial construction sectors.";
    const FS23 = "FINANCIAL STATEMENTS December 31, 2023\nTotal debt 540,000\nShareholders' equity 867,100\nRevenue 29,180,000";
    const T2 = "T2 CORPORATION INCOME TAX RETURN 2024\nNAICS 456110 Pharmacies and drug stores\nGross revenue 3,240,000";
    const existing: Info = {
      cash2021: "$1,102,094",                       // printed in FS22 (a comparative) → back, on cashByYear
      badDebts2021: "$29,500",                      // not printed anywhere → gone
      netIncome2022: "$1,115,900",                  // the fresh read files 2022 on netIncomeByYear → replaced
      debtToEquityRatio: "Total debt $540,000 / Equity $867,100 = 0.62 (2023)", // worked out → gone
      revenueGrowthRate: "13.2% year-over-year (2024 vs 2023)",                  // worked out → gone
      industry: "456110 — Pharmacies and drug stores (NAICS)",                   // NAICS text → gone
      businessDescription: "Custom fabricator serving the oil & gas, ebitda agricultural and commercial construction sectors", // garbled → gone
      legalName: "Ridgeline Metal Fabrication Inc.",  // from a row whose read FAILED → kept as it was
      ownerNotes: "Owner coaches hockey",           // the seller's own words (interview) → kept
      _fieldSources: {
        cash2021: doc("FS22"), badDebts2021: doc("FS22"), netIncome2022: doc("FS22"),
        debtToEquityRatio: doc("FS23"), revenueGrowthRate: doc("FS23"), industry: doc("T2"), businessDescription: doc("FS22"),
        legalName: doc("MINUTES"), ownerNotes: { source: "interview" },
      },
    };
    let fresh: Info = {};
    fresh = mergeExtractedData(fresh, normaliseExtraction({ revenueByYear: { "2022": "$28,640,000", "2021": "$25,480,000" }, byYear: { netIncome: { "2022": "$1,115,900" } }, periodEnd: "2022-12-31" }, FS22), doc("FS22", { title: "Financial statements FY2022" }));
    fresh = mergeExtractedData(fresh, normaliseExtraction({ revenue: "$29,180,000", periodEnd: "2023-12-31" }, FS23), doc("FS23", { title: "Financial statements FY2023" }));
    fresh = mergeExtractedData(fresh, normaliseExtraction({ grossReceipts: "$3,240,000", industry: "456110 — Pharmacies and drug stores (NAICS)" }, T2), doc("T2", { title: "T2 return 2024" }));
    const rows = rowsOf([
      ["FS22", { text: FS22, kind: "document", title: "Financial statements FY2022" }],
      ["FS23", { text: FS23, kind: "document", title: "Financial statements FY2023" }],
      ["T2", { text: T2, kind: "document", title: "T2 return 2024" }],
      // MINUTES is not listed: its re-read failed.
    ]);
    const report: OverlayReport = { dropped: [], kept: [] };
    const rebuilt = overlayExistingFacts(fresh, existing, {}, { rows, report });
    assert.equal(rebuilt.cash2021, undefined, "no suffixed key survives");
    assert.equal((rebuilt.cashByYear as Record<string, string>)?.["2021"], "$1,102,094", "…but the printed comparative is kept, on its map");
    assert.equal(yearSource(getFieldSources(rebuilt).cashByYear, "2021")?.documentId, "FS22");
    assert.equal(rebuilt.badDebts2021, undefined, "a figure the source doesn't print goes");
    assert.equal(rebuilt.netIncome2022, undefined);
    assert.equal((rebuilt.netIncomeByYear as Record<string, string>)["2022"], "$1,115,900");
    assert.equal(rebuilt.debtToEquityRatio, undefined, "a computed ratio goes");
    assert.equal(rebuilt.revenueGrowthRate, undefined, "a computed growth rate goes");
    assert.notEqual(rebuilt.industry, "456110 — Pharmacies and drug stores (NAICS)", "NAICS text is not the industry");
    assert.equal(rebuilt.businessDescription, undefined, "a garbled line the source doesn't say goes");
    assert.equal(rebuilt.legalName, "Ridgeline Metal Fabrication Inc.", "a row whose read failed keeps what it had");
    assert.equal(getFieldSources(rebuilt).legalName.documentId, "MINUTES");
    assert.equal(rebuilt.ownerNotes, "Owner coaches hockey", "the seller's own words stay");
    // The broker's year-suffixed figure moves onto its map as the broker's year (value kept).
    const brokerSuffixed: Info = { revenue2021: "$25,500,000", sde2024: "$1,720,000 (reported EBITDA $1,199,100 + shareholder compensation $452,000)", _fieldSources: { revenue2021: { source: "broker" }, sde2024: { source: "broker" } } };
    const b = overlayExistingFacts(fresh, brokerSuffixed, {}, { rows });
    assert.equal(b.revenue2021, undefined);
    assert.equal((b.revenueByYear as Record<string, string>)["2021"], "$25,500,000", "the broker's figure wins its year");
    assert.equal(yearSource(getFieldSources(b).revenueByYear, "2021")?.source, "broker");
    assert.ok((getFieldAlternates(b)["revenueByYear.2021"] ?? []).some((a) => a.value === "$25,480,000"), "the statement's figure is another value");
    assert.equal(b.sde2024, undefined);
    assert.match(String((b.sdeByYear as Record<string, string>)["2024"]), /^\$1,720,000 \(reported EBITDA/, "the broker's words are the year's value");
    const droppedKeys = report.dropped.map((d) => d.key).sort();
    assert.deepEqual(droppedKeys, ["badDebts2021", "businessDescription", "debtToEquityRatio", "industry", "revenueGrowthRate"].sort(), "replaced values aren't reported as removed");
    assert.ok(report.kept.some((k) => k.key === "cashByYear.2021"));
    // A printed sentence the fresh read didn't repeat stays (word for word).
    const said: Info = { businessDescription: "serves the oil & gas, agricultural and commercial construction sectors", _fieldSources: { businessDescription: doc("FS22") } };
    assert.equal(overlayExistingFacts(fresh, said, {}, { rows }).businessDescription, said.businessDescription);
  }
  ok("reprocess: a row's stale keys, computed ratios, NAICS industry and garbled text go; printed facts stay; a failed read keeps all");

  // ── 2. Stated derived metrics are not lost to model variance ─────────────
  {
    const STATEMENTS = "STATEMENT OF EARNINGS\nRevenue 6,212,400 5,487,300\nGross margin 41.2%\nEBITDA 1,199,100 920,600\n";
    const first = mergeExtractedData({}, normaliseExtraction({ revenue: "$6,212,400", ebitda: "$1,199,100", grossMargin: "41.2%", byYear: { ebitda: { "2024": "$1,199,100", "2023": "$920,600" } }, periodEnd: "2024-12-31" }, STATEMENTS),
      doc("FS24", { title: "Financial statements FY2024" }));
    assert.equal(getFieldSources(first).ebitda.note, STATED_METRIC_NOTE);
    // The fresh read returns only revenue this time.
    const freshOnly = mergeExtractedData({}, normaliseExtraction({ revenue: "$6,212,400", periodEnd: "2024-12-31" }, STATEMENTS), doc("FS24", { title: "Financial statements FY2024" }));
    const rebuilt = overlayExistingFacts(freshOnly, first, {}, { rows: rowsOf([["FS24", { text: STATEMENTS, kind: "document" }]]) });
    reconcileHeadlines(rebuilt);
    assert.equal(rebuilt.ebitda, "$1,199,100", "printed EBITDA kept");
    assert.equal(rebuilt.grossMargin, "41.2%", "printed margin kept");
    assert.deepEqual(rebuilt.ebitdaByYear, { "2024": "$1,199,100", "2023": "$920,600" }, "printed EBITDA history kept");
    // …while an EBITDA the statements never print still goes.
    const computed: Info = { ebitda: "$1,450,000", _fieldSources: { ebitda: doc("FS24") } };
    assert.equal(overlayExistingFacts(freshOnly, computed, {}, { rows: rowsOf([["FS24", { text: STATEMENTS, kind: "document" }]]) }).ebitda, undefined);
  }
  ok("reprocess: EBITDA, margins and by-year history the statements print survive a fresh read that omits them");

  // ── 3. Spelled-out EBITDA on a call; a CRM placeholder is never the headline ──
  {
    const CALL = "Gord: Last year we did about nine point eight million in sales, and earnings before interest, amortization and tax of $1,398,000 after the adjustments in the compiled statements.";
    const g = guardExtraction({ ebitda: "$1,398,000 (2024, after adjustments per compiled statements)" }, CALL, { spoken: true });
    assert.equal(g.data.ebitda, "$1,398,000 (2024, after adjustments per compiled statements)", "a spelled-out EBITDA names the metric");
    assert.ok(g.stated.includes("ebitda"));
    // "1,398K" is the printed 1,398,000; two figures side by side are two columns, not one number.
    assert.equal(guardExtraction({ ebitda: "1,398K reported FY24" }, "EBITDA (reported) $1,398,000").data.ebitda, "1,398K reported FY24");
    assert.equal(guardExtraction({ ebitda: "$1,199,100" }, "EBITDA 1,199,100 920,600").data.ebitda, "$1,199,100");
    const CRM = "Referral & first call. Seller says EBITDA — call it a million and a half (TBC). Adjusted close to 1.8.";
    let info: Info = {};
    info = mergeExtractedData(info, normaliseExtraction({ ebitda: "call it a million and a half (TBC)", adjustedEbitda: "close to 1.8" }, CRM, "crm"), { documentId: "CRM", source: "crm", brokerOnly: true });
    assert.equal(info.ebitda, undefined, "a remark with no amount is never the headline");
    assert.equal(info.adjustedEbitda, undefined, "nor 'close to 1.8'");
    assert.ok((getFieldAlternates(info).ebitda ?? []).some((a) => /million and a half/.test(String(a.value))), "kept as another value");
    info = mergeExtractedData(info, normaliseExtraction({ ebitda: "$1,398,000 (2024, after adjustments per compiled statements)" }, CALL, "call"), { documentId: "CALL", source: "call" });
    assert.match(String(info.ebitda), /1,398,000/, "the call's EBITDA is the headline");
  }
  ok("guard: a spelled-out EBITDA is kept; a CRM placeholder never becomes the headline EBITDA");

  // ── 4. Statements beat emails and calls for owner salary and backlog ─────
  {
    const conflicts: MergeConflict[] = [];
    let info: Info = {};
    info = mergeExtractedData(info, { ownerSalary: "$260,000", ownerSalaryByYear: { "2024": "$260,000" } } as any, { documentId: "EMAIL", source: "email", dated: "2025-06-03" }, { conflicts });
    info = mergeExtractedData(info, { ownerSalary: "$180,000", ownerSalaryByYear: { "2024": "$180,000", "2023": "$180,000" }, periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Compiled financial statements FY2024" }), { conflicts });
    assert.equal(info.ownerSalary, "$180,000");
    assert.equal((info.ownerSalaryByYear as Record<string, string>)["2024"], "$180,000");
    assert.ok(settleConflicts(info, conflicts).some((c) => c.factKey === "ownerSalary" || c.factKey === "ownerSalaryByYear"), "the difference is raised");
    // Backlog: the WIP report over the seller on a call and a video call, in any order.
    for (const order of [["CALL", "WIP", "MEET"], ["WIP", "CALL", "MEET"]]) {
      let b: Info = {};
      for (const id of order) {
        if (id === "CALL") b = mergeExtractedData(b, { backlog: "$4.2M as of end of May 2025 (best level since 2014)" } as any, { documentId: "CALL", source: "call" });
        if (id === "MEET") b = mergeExtractedData(b, { backlogValue: "$4.2M" } as any, { documentId: "MEET", source: "video_call" });
        if (id === "WIP") b = mergeExtractedData(b, { backlog: "$3,100,000 signed backlog", periodEnd: "2025-05-31" } as any, doc("WIP", { title: "WIP & backlog report as of May 31, 2025" }));
      }
      assert.equal(b.backlog, "$3,100,000 signed backlog", `WIP report wins (${order.join(" → ")})`);
      assert.equal(b.backlogValue, undefined, "one backlog fact, whoever names it");
    }
    assert.equal(canonicalFieldName("backlogValue"), "backlog");
  }
  ok("authority: statements beat the owner's email for salary; the WIP report beats the seller for backlog");

  // ── 5. Customer concentration: the analysis beats an A/R aging's receivables share ──
  {
    assert.equal(receivablesMeasureKey("customerConcentration", "Larkspur Midstream represents $461,000 of $1,530,400 total AR", "AR aging as of May 31, 2025"), "receivablesConcentration");
    assert.equal(receivablesMeasureKey("customerCount", "51 total customer accounts", "AR aging as of May 31, 2025"), "receivablesAccountCount");
    assert.equal(receivablesMeasureKey("customerConcentration", "Top 3 customers 41% of revenue", "Customer concentration FY2022-FY2024"), "customerConcentration");
    assert.equal(receivablesMeasureKey("customerConcentration", "Largest customer is 38% of receivables", "Email from Gord"), "receivablesConcentration");
    const orders = [["AR", "CONC", "FS"], ["CONC", "FS", "AR"], ["FS", "AR", "CONC"]];
    for (const order of orders) {
      let info: Info = {};
      for (const id of order) {
        if (id === "AR") info = mergeExtractedData(info, { customerConcentration: "Larkspur Midstream Services Ltd. represents $461,000 of $1,530,400 total AR", customerCount: "51 total customer accounts", periodEnd: "2025-05-31" } as any, doc("AR", { title: "AR aging as of May 31, 2025" }));
        if (id === "CONC") info = mergeExtractedData(info, { customerConcentration: "Top 3 customers FY2024 41.0% of revenue; top 10 68.3%", periodEnd: "2024-12-31" } as any, doc("CONC", { title: "Customer concentration FY2022-FY2024" }));
        if (id === "FS") info = mergeExtractedData(info, { customerConcentration: "Approximately 18% of revenue from one customer", periodEnd: "2024-12-31" } as any, doc("FS", { title: "Compiled financial statements FY2024" }));
      }
      assert.match(String(info.customerConcentration), /41\.0%/, `the concentration analysis wins (${order.join(" → ")})`);
      assert.match(String(info.receivablesConcentration), /\$461,000/, "the aging's figure is its own measure");
      assert.equal(info.customerCount, undefined, "accounts with a balance are not the customer count");
      assert.match(String(info.receivablesAccountCount), /51/);
    }
  }
  ok("concentration: the dedicated analysis wins; an A/R aging's receivables share is a different measure");

  // ── 6. A newer balance beats an older statement, with no conflict ───────
  {
    for (const order of [["FS23", "LOAN"], ["LOAN", "FS23"]]) {
      const conflicts: MergeConflict[] = [];
      let info: Info = {};
      for (const id of order) {
        if (id === "FS23") info = mergeExtractedData(info, { longTermDebt: "$450,000", cash: "$310,000", periodEnd: "2023-12-31" } as any, doc("FS23", { title: "FY2023 Financial Statements" }), { conflicts });
        else info = mergeExtractedData(info, { longTermDebt: "$210,000", periodEnd: "2025-06-30" } as any, doc("LOAN", { title: "BDC term loan statement June 2025" }), { conflicts });
      }
      assert.equal(info.longTermDebt, "$210,000", `the June 2025 balance (${order.join(" → ")})`);
      assert.ok((getFieldAlternates(info).longTermDebt ?? []).some((a) => a.value === "$450,000"), "the older balance stays as another value");
      assert.ok(!settleConflicts(info, conflicts).some((c) => c.factKey === "longTermDebt"), "two dates, not a dispute");
    }
    // A call about today's debt still doesn't beat the statements (rank, not date, between different kinds).
    assert.equal(outranksFor("longTermDebt", { source: "call", period: "2025-06-30" }, { source: "document", period: "2023-12-31" }), false);
  }
  ok("point-in-time balances: the newer document's balance wins in either order, no discrepancy");

  // ── 7. Interim / run-rate / unreviewed years never enter the maps ────────
  {
    const harborview: Info = {
      revenueByYear: {
        "2022": "$4,812,600", "2023": "$5,487,300", "2024": "$6,212,400",
        "2025": "$4,711,680 ARR (annualized from March 31, 2025 MRR)", "Q1 2025": "$1,628,000", "Q1 2025 recurring": "$1,160,000+",
      },
      _fieldSources: { revenueByYear: { source: "broker", at: "2026-09-25T15:36:52.423Z" } },
    };
    const h = mergeExtractedData(harborview, { employees: "38" } as any, doc("ROSTER"));
    assert.deepEqual(Object.keys(h.revenueByYear as object).sort(), ["2022", "2023", "2024"], "fiscal years only");
    assert.deepEqual(h.interimRevenue, { "2025": "$4,711,680 ARR (annualized from March 31, 2025 MRR)", "Q1 2025": "$1,628,000", "Q1 2025 recurring": "$1,160,000+" }, "kept, labelled as interim");
    assert.equal(getFieldSources(h).interimRevenue.source, "broker", "with the broker's source");
    assert.equal(h.annualRevenue, "$6,212,400");
    const ridge: Info = {
      revenueByYear: { "2024": "$9,815,000", "2025": "$4,180,000 (Jan-May YTD, +8% vs prior year)" },
      _fieldSources: { revenueByYear: { source: "broker" } },
    };
    relocateInterimYears(ridge);
    assert.deepEqual(ridge.revenueByYear, { "2024": "$9,815,000" });
    assert.match(String((ridge.interimRevenue as Record<string, string>)["2025"]), /YTD/);
    // Pacific: the seller's unreviewed FY2025 management number.
    const pac: Info = {
      revenueByYear: { "2024": "$31,020,000", "2025": "about $31.8 million (management numbers, not reviewed)" },
      _fieldSources: { revenueByYear: { source: "document", documentId: "FS24", years: { "2024": doc("FS24", { period: "2024-12-31" }), "2025": { source: "video_call", documentId: "MEET" } } } },
    };
    reconcileHeadlines(pac);
    assert.deepEqual(pac.revenueByYear, { "2024": "$31,020,000" });
    assert.equal(pac.annualRevenue, "$31,020,000");
    assert.ok((getFieldAlternates(pac)["revenueByYear.2025"] ?? []).some((a) => a.note === UNREVIEWED_YEAR_NOTE && a.source === "video_call"));
    assert.equal(pac.interimRevenue, undefined, "an unreviewed figure is not stated as interim either");
    // Said on a Zoom call three weeks after year-end, with the statements only through 2024: unreviewed.
    let zoom: Info = mergeExtractedData({}, { revenue: "$31,020,000", revenueByYear: { "2024": "$31,020,000", "2023": "$29,180,000" }, periodEnd: "2024-12-31" } as any,
      doc("FS24", { title: "Reviewed financial statements FY2024" }));
    zoom = mergeExtractedData(zoom, { revenueByYear: { "2025": "~$31.8 million" }, adjustedEbitda: "~$4 million (2025, management numbers not reviewed)" } as any,
      { documentId: "ZOOM", source: "video_call", dated: "2026-01-21" });
    assert.equal((zoom.revenueByYear as any)["2025"], undefined, "not on the map");
    assert.ok((getFieldAlternates(zoom)["revenueByYear.2025"] ?? []).some((a) => a.value === "~$31.8 million" && a.note === UNREVIEWED_YEAR_NOTE), "kept as the year's other value");
    assert.equal(zoom.annualRevenue, "$31,020,000");
    assert.equal(zoom.adjustedEbitda, undefined, "an unreviewed figure is never the headline");
    assert.ok((getFieldAlternates(zoom).adjustedEbitda ?? []).some((a) => /not reviewed/.test(String(a.value))));
    // …the same words a year later (statements long out, just not uploaded) are that year's figure.
    const later = mergeExtractedData(mergeExtractedData({}, { revenueByYear: { "2023": "$29,180,000" }, periodEnd: "2023-12-31" } as any, doc("FS23", { title: "Financial statements FY2023" })),
      { revenueByYear: { "2024": "$31M" } } as any, { documentId: "CALL", source: "call", dated: "2025-11-03" });
    assert.equal((later.revenueByYear as any)["2024"], "$31M");
    // Two sources' figures glued into one year: one figure per year, the other kept as another value.
    const glued: Info = {
      adjustedEbitdaByYear: { "2024": "just under $4.1 million (per seller email); $3.9 million (per broker normalization)" },
      _fieldSources: { adjustedEbitdaByYear: { source: "broker" } },
    };
    const gluedBefore = JSON.stringify(glued.adjustedEbitdaByYear);
    const g2 = { ...glued };
    relocateInterimYears(g2);
    assert.deepEqual(g2.adjustedEbitdaByYear, { "2024": "just under $4.1 million (per seller email)" });
    assert.ok((getFieldAlternates(g2)["adjustedEbitdaByYear.2024"] ?? []).some((a) => /\$3\.9 million/.test(String(a.value))));
    assert.equal(JSON.stringify(glued.adjustedEbitdaByYear), gluedBefore, "the caller's object is not mutated");
    // A fresh read never files it either.
    const n2 = normaliseExtraction({ revenueByYear: { "2024": "$31M", "2025": "about $31.8 million (management numbers, not reviewed)" } });
    assert.deepEqual(n2.revenueByYear, { "2024": "$31M" });
    // Multi-source glued text for a year is not a year's figure… and a video call dated in 2025 doesn't file FY2024 under 2025.
    const meet = normaliseExtraction({ adjustedEbitda: "$1.35 million", byYear: { adjustedEbitda: { "2024": "$1.35 million" } }, periodEnd: "2025-03-31" });
    assert.deepEqual(meet.adjustedEbitdaByYear, { "2024": "$1.35 million" }, "one figure, one year");
    // The CIM input never sees an interim year even if one slipped onto a map elsewhere.
    const slipped: Info = { revenueByYear: { "2024": "$1M", "Q1 2025": "$300K" }, _fieldSources: { revenueByYear: { source: "interview" } } };
    const cim = splitFactsForCim(slipped).confirmed.find(([k]) => k === "revenueByYear")?.[1] as Record<string, string>;
    assert.ok(cim && cim["Q1 2025"] === undefined, "no interim period in the CIM's revenue by year");
  }
  ok("interim: ARR / Q1 / YTD move to interimRevenue, unreviewed years to other values; never a year, never the headline");

  // ── 8. Line items: a figure agrees with the latest year of its own map ──
  {
    let p: Info = {};
    p = mergeExtractedData(p, { interestExpense: "$433,000", periodEnd: "2024-12-31" } as any, doc("T2", { title: "T2 corporate income tax return 2024" }));
    p = mergeExtractedData(p, { interestExpense: "$395,000", byYear: { interestExpense: { "2024": "$395,000", "2023": "$412,000" } }, periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Financial statements FY2024 (review engagement)" }));
    assert.equal(p.interestExpense, "$395,000", "the statements' book figure, same as its 2024");
    assert.equal((p.interestExpenseByYear as Record<string, string>)["2024"], "$395,000");
    const opex: Info = {
      operatingExpenses: "$5,766,500",
      operatingExpensesByYear: { "2023": "$7,797,500", "2024": "$8,111,500" },
      _fieldSources: {
        operatingExpenses: doc("OLD", { period: "2022-12-31" }),
        operatingExpensesByYear: { source: "document", documentId: "FS24", years: { "2023": doc("FS24", { period: "2023-12-31" }), "2024": doc("FS24", { period: "2024-12-31" }) } },
      },
    };
    reconcileHeadlines(opex);
    assert.equal(opex.operatingExpenses, "$8,111,500", "the line item follows its latest year");
    assert.ok((getFieldAlternates(opex).operatingExpenses ?? []).some((a) => a.value === "$5,766,500"));
    // A map with no stand-alone figure gets none invented.
    const only: Info = { fuelCostsByYear: { "2024": "$5,420,000" }, _fieldSources: { fuelCostsByYear: doc("FS24", { years: { "2024": doc("FS24") } }) } };
    reconcileHeadlines(only);
    assert.equal(only.fuelCosts, undefined);
  }
  ok("line items: the stand-alone figure matches the latest year of its own by-year map");

  // ── 9. Broker process data by meaning ────────────────────────────────────
  {
    for (const k of ["acquisitionInterest", "impliedMultiple", "engagementSigned", "priorApproachDetails", "unsolicitedOffers", "referralSource",
      "leadSource", "brokerFee", "listingAgreementDate", "competitorApproached", "walkAwayPrice", "successFee", "askingMultiple"]) {
      assert.ok(isBrokerProcessKey(k), `${k} is broker process`);
    }
    for (const k of ["customerEngagementRate", "acquisitionHistory", "insuranceBroker", "customsBroker", "salesCommissionStructure", "bidPipeline",
      "productOfferings", "priceIncreases", "customerBase", "annualRevenue", "backlog", "buyerInterests", "patientReferrals",
      "referralSources", "physicianReferralNetwork", "interestExpense", "customerInquiries", "bidPipeline"]) {
      assert.ok(!isBrokerProcessKey(k), `${k} is a business fact`);
    }
    const info: Info = {
      acquisitionInterest: "Jackpine approached seller 2 years ago with offer around 3x earnings",
      impliedMultiple: "6.88x",
      employees: "58",
      _fieldSources: { acquisitionInterest: { source: "call", documentId: "C" }, impliedMultiple: { source: "crm", documentId: "R", brokerOnly: true }, employees: { source: "call", documentId: "C" } },
    };
    const keys = splitFactsForCim(info).confirmed.map(([k]) => k);
    assert.deepEqual(keys, ["employees"], "never CIM input");
    const s = normaliseExtraction({ acquisitionInterest: "Jackpine offered ~3x two years ago", employees: "58" });
    assert.equal(s.acquisitionInterest, undefined);
    assert.match(String(s._privateNotes), /Jackpine/, "a broker-private note instead");
  }
  ok("broker process data recognised by meaning (acquisitionInterest, impliedMultiple, engagementSigned…), never a CIM fact");

  // ── 10. The industry fact stored follows the deal's industry ─────────────
  {
    const info: Info = {
      industry: "456110 — Pharmacies and drug stores (NAICS)",
      _fieldSources: { industry: doc("T2") },
    };
    const { columnPatch, infoChanged } = reconcileMirroredFacts({ industry: "Pharmacy", businessName: "Beacon Pharmacy" }, info, setBrokerFact);
    assert.ok(infoChanged);
    assert.deepEqual(columnPatch, {});
    assert.equal(info.industry, "Pharmacy");
    assert.equal(getFieldSources(info).industry.source, "broker");
    assert.ok((getFieldAlternates(info).industry ?? []).some((a) => /NAICS/.test(String(a.value))), "the tax return's wording is another value");
  }
  ok("industry: the stored fact is the broker's deal industry; NAICS / CRM wording stays another value");

  // ── 11. Grounding ─────────────────────────────────────────────────────────
  {
    const T = "Revenue $9,815,000. Backlog four point two million as of May. Larkspur represents 461,000 of 1,530,400 total A/R.";
    assert.ok(groundedInSource("annualRevenue", "$9,815,000", T));
    assert.ok(groundedInSource("annualRevenue", "$9.815M", T), "a scaled figure matches its printed digits");
    assert.ok(!groundedInSource("annualRevenue", "$9,900,000", T));
    assert.ok(groundedInSource("backlog", "$4.2M", T, { spoken: true }), "said in words on a call");
    assert.ok(!groundedInSource("backlog", "$4.2M", T), "…not printed in a document");
    assert.ok(!groundedInSource("customerCount", "41 accounts plus 10 named = 51 total", T), "a worked-out total");
    assert.ok(!groundedInSource("x", "anything", null), "no text, nothing to check");
    // Growth rates and ratios are worked out unless the source prints them — at extraction and on reprocess.
    const FS24 = "Revenue 58,241,630 54,708,210. Total debt 540,000. Equity 867,100. Revenue grew 13.2% year over year.";
    assert.equal(guardExtraction({ growthRate: "Net sales grew 6.5% from 2023 to 2024" }, FS24).data.growthRate, undefined);
    assert.equal(guardExtraction({ debtToEquityRatio: "Total debt $540,000 / Equity $867,100 = 0.62" }, FS24).data.debtToEquityRatio, undefined);
    assert.equal(guardExtraction({ revenueGrowthRate: "13.2% year-over-year" }, FS24).data.revenueGrowthRate, "13.2% year-over-year", "printed → kept");
    assert.equal(guardExtraction({ growthOpportunities: "Grow medical 20% by adding two presses" }, FS24).data.growthOpportunities, "Grow medical 20% by adding two presses", "a narrative is not a ratio");
    // Prose: the source's own words (a faithful summary), never a word slipped in where the source doesn't put it.
    const FS = "EBITDA 1,199,100. The Company is a custom structural and miscellaneous steel fabricator serving the oil & gas, agricultural and commercial construction sectors.";
    assert.ok(groundedInSource("businessDescription", "Custom structural and miscellaneous steel fabricator serving oil & gas, agricultural and commercial construction", FS));
    assert.ok(!groundedInSource("businessDescription", "Custom steel fabricator serving the oil & gas, ebitda agricultural and commercial construction sectors", FS),
      "a stray 'ebitda' is a glitch even when the source says EBITDA elsewhere");
    assert.ok(!groundedInSource("keyRisks", "Customer consolidation risk, succession gaps, working capital squeeze and pricing pressure from overseas mills", FS));
  }
  ok("grounding: figures must be stated (printed, or said on a call), prose word for word");

  // ── 12. Reprocess runs as a background job ──────────────────────────────
  {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fakeRun = async (_id: string, onProgress?: (p: any) => void) => {
      onProgress?.({ phase: "reading", done: 2, total: 5 });
      await gate;
      return { documentsReprocessed: 5, fieldsAfter: 80, documentsKeptAsBefore: 0, removed: [], keptFromText: [] };
    };
    const first = startReprocessJob("deal-x", undefined, fakeRun as any);
    assert.ok(first.started);
    assert.equal(first.job.status, "running");
    assert.deepEqual(reprocessJobFor("deal-x")?.progress, { phase: "reading", done: 2, total: 5 }, "progress is visible while it runs");
    const second = startReprocessJob("deal-x", undefined, fakeRun as any);
    assert.equal(second.started, false, "one job per deal");
    release();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(reprocessJobFor("deal-x")?.status, "done");
    assert.equal(reprocessJobFor("deal-x")?.result?.documentsReprocessed, 5);
    const failing = startReprocessJob("deal-y", undefined, (async () => { throw new Error("boom"); }) as any);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(failing.job.status, "failed");
    assert.equal(reprocessJobFor("deal-y")?.error, "boom");
  }
  ok("reprocess: a background job with progress, one per deal, failures reported");

  console.log(`\n${n} f-merge checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
