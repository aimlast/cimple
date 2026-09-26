// Fact merge + reprocess, round 2 (QA-harvest round V, stream f-merge) — offline checks, no database, no AI.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/information/f-merge-v-r2.test.ts
import assert from "node:assert/strict";
import { mergeExtractedData, normaliseExtraction } from "../../server/documents/extractor";
import { overlayExistingFacts, type OverlayReport, type RereadRow } from "../../server/documents/reprocess";
import { groundedInSource, groundedValue } from "../../server/documents/extraction-guard";
import { getFieldSources, getFieldAlternates, yearSource } from "../../server/interview/info-merger";
import {
  lastStatementsYear, reconcileHeadlines, settleConflicts, EARLY_YEAR_NOTE, FORECAST_YEAR_NOTE, UNREVIEWED_YEAR_NOTE, type MergeConflict,
} from "../../server/documents/merge-policy";
import { splitFactsForCim } from "../../server/information/cim-facts";
import { conflictsNotYetRaised } from "../../server/documents/merge-conflicts";

type Info = Record<string, unknown>;
let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
const doc = (documentId: string, extra: Record<string, unknown> = {}) => ({ documentId, source: "document" as const, ...extra });
const alts = (info: Info, key: string) => getFieldAlternates(info)[key] ?? [];

(async () => {
  // ── 1. A statement's figure competes with a weaker source's same-year map entry ──
  {
    const email = { ownerSalaryByYear: { "2024": "$260,000" } } as any;
    const t2 = { ownerSalary: "$180,000 paid to majority shareholder (Gord McAllister)", periodEnd: "2024-12-31" } as any;
    const fs22 = { ownerSalaryByYear: { "2021": "$180,000", "2022": "$180,000" }, periodEnd: "2022-12-31" } as any;
    for (const order of [["EMAIL", "FS22", "T2"], ["T2", "EMAIL", "FS22"], ["FS22", "T2", "EMAIL"]]) {
      const conflicts: MergeConflict[] = [];
      let info: Info = {};
      for (const id of order) {
        if (id === "EMAIL") info = mergeExtractedData(info, email, { documentId: "EMAIL", source: "email", dated: "2025-06-03" }, { conflicts });
        if (id === "T2") info = mergeExtractedData(info, t2, doc("T2", { title: "T2 corporate tax return 2024" }), { conflicts });
        if (id === "FS22") info = mergeExtractedData(info, fs22, doc("FS22", { title: "Compiled financial statements FY2022" }), { conflicts });
      }
      const map = info.ownerSalaryByYear as Record<string, string>;
      assert.equal(map["2024"], "$180,000", `the tax return's FY2024 figure is the map's 2024 (${order.join(" → ")})`);
      assert.equal(yearSource(getFieldSources(info).ownerSalaryByYear, "2024")?.documentId, "T2");
      assert.ok(alts(info, "ownerSalaryByYear.2024").some((a) => a.value === "$260,000" && a.source === "email"), "the email's figure is that year's other value");
      assert.match(String(info.ownerSalary), /^\$180,000/);
      assert.ok(settleConflicts(info, conflicts).some((c) => /ownerSalary/.test(c.factKey) && [c.winner.value, c.loser.value].some((v) => /260,000/.test(v))), "the difference is raised");
    }
  }
  ok("a document's dated figure is weighed against an email's entry for the same year on its map (any order)");

  // ── 2. The line item follows its map: owner salary, donations, community prescriptions ──
  {
    // Harborview: FY2023 statements' owner salary; the owner's email gives 2024; the FY2024 statements are on file (other lines).
    let h: Info = {};
    h = mergeExtractedData(h, { ownerSalary: "$436,000", revenueByYear: { "2023": "$5,487,300" }, periodEnd: "2023-12-31" } as any, doc("FS23", { title: "Financial statements FY2023" }));
    h = mergeExtractedData(h, { revenueByYear: { "2024": "$6,212,400" }, periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Financial statements FY2024" }));
    h = mergeExtractedData(h, { ownerSalaryByYear: { "2024": "$452,000" } } as any, { documentId: "EMAIL", source: "email", dated: "2025-04-16" });
    assert.equal(lastStatementsYear(h), "2024");
    assert.deepEqual(h.ownerSalaryByYear, { "2023": "$436,000", "2024": "$452,000" }, "the FY2023 figure is 2023's on the map");
    assert.equal(h.ownerSalary, "$452,000", "the latest year the statements cover is the headline, even said in an email");
    assert.ok(alts(h, "ownerSalary").some((a) => a.value === "$436,000"));
    // A tax return's bare number next to a map of dollar figures.
    const d: Info = mergeExtractedData(
      mergeExtractedData({}, { donations: "10,000", periodEnd: "2023-12-31" } as any, doc("T223", { title: "T2 return 2023" })),
      { donationsByYear: { "2024": "$12,500" }, periodEnd: "2024-12-31" } as any, doc("T224", { title: "T2 return 2024" }));
    assert.equal(d.donations, "$12,500");
    assert.deepEqual(d.donationsByYear, { "2023": "$10,000", "2024": "$12,500" });
    // A pair named by nothing but its money history (community prescriptions).
    const b: Info = {
      communityPrescriptions: "$4,406,500",
      communityPrescriptionsByYear: { "2022": "$4,215,000", "2023": "$4,406,500", "2024": "$4,560,200" },
      _fieldSources: {
        communityPrescriptions: doc("FS23", { period: "2023-12-31" }),
        communityPrescriptionsByYear: { source: "document", documentId: "FS24", years: { "2022": doc("FS23", { period: "2022-12-31" }), "2023": doc("FS23", { period: "2023-12-31" }), "2024": doc("FS24", { period: "2024-12-31" }) } },
      },
    };
    reconcileHeadlines(b);
    assert.equal(b.communityPrescriptions, "$4,560,200");
    // A figure that lists its years puts each on the map; the headline is the latest.
    const f: Info = {
      fuelCosts: "$4,760,000 (2023); $5,420,000 (2022) - direct fuel costs",
      fuelCostsByYear: { "2021": "$3,760,000", "2022": "$5,420,000" },
      _fieldSources: {
        fuelCosts: doc("FS23", { period: "2023-12-31" }),
        fuelCostsByYear: { source: "document", documentId: "FS22", years: { "2021": doc("FS22", { period: "2021-12-31" }), "2022": doc("FS22", { period: "2022-12-31" }) } },
      },
    };
    reconcileHeadlines(f);
    assert.deepEqual(f.fuelCostsByYear, { "2021": "$3,760,000", "2022": "$5,420,000", "2023": "$4,760,000" });
    assert.equal(f.fuelCosts, "$4,760,000");
    // A balance as at May 31 is not a fiscal year's figure: never "2025" on the map.
    const ar: Info = {
      accountsReceivable: "$1,530,400",
      accountsReceivableByYear: { "2023": "$1,392,000", "2024": "$1,486,000" },
      _fieldSources: {
        accountsReceivable: doc("AR", { period: "2025-05-31", specialist: true }),
        accountsReceivableByYear: { source: "document", documentId: "FS24", years: { "2023": doc("FS24", { period: "2023-12-31" }), "2024": doc("FS24", { period: "2024-12-31" }) } },
      },
    };
    reconcileHeadlines(ar);
    assert.deepEqual(Object.keys(ar.accountsReceivableByYear as object), ["2023", "2024"]);
    assert.equal(ar.accountsReceivable, "$1,530,400", "the newer balance stays the figure");
  }
  ok("line items: a figure and its own map agree (owner salary, donations, money-history pairs, multi-year text); a mid-year balance is not a year");

  // ── 3. Round remarks about the year after the statements are the management number ──
  {
    let p: Info = mergeExtractedData({}, { revenue: "$31,020,000", revenueByYear: { "2024": "$31,020,000", "2023": "$29,180,000" }, periodEnd: "2024-12-31" } as any,
      doc("FS24", { title: "Financial statements FY2024 (review engagement)" }));
    // A broker-only CRM note eight months after year-end, in round numbers.
    p = mergeExtractedData(p, { revenueByYear: { "2025": "~$31.8M" }, adjustedEbitdaByYear: { "2025": "~$4.0M" } } as any,
      { documentId: "CRM", source: "crm", brokerOnly: true, dated: "2026-09-15" });
    assert.deepEqual(Object.keys(p.revenueByYear as object).sort(), ["2023", "2024"], "not a year of the map");
    assert.ok(alts(p, "revenueByYear.2025").some((a) => a.value === "~$31.8M" && a.note === UNREVIEWED_YEAR_NOTE), "the year's other value, labelled");
    assert.equal(p.adjustedEbitdaByYear, undefined);
    assert.equal(p.annualRevenue, "$31,020,000");
    // An exact figure for that year (the statements are out, just not uploaded) is that year's figure.
    const exact = mergeExtractedData(p, { revenueByYear: { "2025": "$31,812,400" } } as any, { documentId: "EM", source: "email", dated: "2026-09-20" });
    assert.equal((exact.revenueByYear as any)["2025"], "$31,812,400");
    // Order: the owner's "just under $4.1M" for 2024 arrives before the FY2024 statements — it was set aside
    // as said-before-the-statements; once the FY2024 statements are merged it is a closed year's figure again.
    let o: Info = mergeExtractedData({}, { revenueByYear: { "2023": "$29,180,000" }, periodEnd: "2023-12-31" } as any, doc("FS23", { title: "Financial statements FY2023" }));
    o = mergeExtractedData(o, { adjustedEbitdaByYear: { "2024": "just under $4.1M" } } as any, { documentId: "EM", source: "email", dated: "2025-12-10" });
    assert.equal(o.adjustedEbitdaByYear, undefined, "set aside while the statements stop at 2023");
    o = mergeExtractedData(o, { revenueByYear: { "2024": "$31,020,000" }, periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Financial statements FY2024" }));
    assert.deepEqual(o.adjustedEbitdaByYear, { "2024": "just under $4.1M" }, "back on its map once FY2024 is covered");
    assert.ok(!alts(o, "adjustedEbitdaByYear.2024").some((a) => a.note === UNREVIEWED_YEAR_NOTE));
  }
  // A figure a call gave for the year it was held in (May 2025, "2025: $1,628,000") is part of that year, never the year —
  // even once nothing else holds that year on the map (a second reprocess).
  {
    let q: Info = mergeExtractedData({}, { revenueByYear: { "2024": "$6,212,400", "2023": "$5,487,300" }, periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Financial statements FY2024" }));
    q = mergeExtractedData(q, { revenueByYear: { "2025": "$1,628,000" } } as any, { documentId: "MEET", source: "video_call", dated: "2025-05-06" });
    assert.deepEqual(Object.keys(q.revenueByYear as object).sort(), ["2023", "2024"]);
    assert.ok(alts(q, "revenueByYear.2025").some((a) => a.value === "$1,628,000" && a.note === EARLY_YEAR_NOTE));
    // With no written records at all, the seller's figure for the year stands.
    const only = mergeExtractedData({}, { revenueByYear: { "2025": "about $520,000" } } as any, { documentId: "CALL", source: "call", dated: "2025-09-10" });
    assert.equal(only.annualRevenue, "about $520,000");
  }
  ok("unreviewed years: a round remark about the year after the statements is set aside (CRM, any date); a figure given before its year ended too; order doesn't matter");

  // ── 4. A fresh read sets aside interim / forecast / unreviewed years as what they are (never a CIM note) ──
  {
    const x = normaliseExtraction({
      revenueByYear: {
        "2024": "$31,020,000", "2025": "about $31.8 million (management numbers, not reviewed)", "Q1 2025": "$7,900,000",
        "2026 (budget)": "$33,000,000", "Last year": "$31M",
      },
    });
    assert.deepEqual(x.revenueByYear, { "2024": "$31,020,000" });
    assert.doesNotMatch(String(x.keyFinancialNotes), /31\.8|7,900,000|33,000,000/, "none of them in the notes");
    assert.match(String(x.keyFinancialNotes), /Last year/, "a relative period is still a note");
    const m = mergeExtractedData({}, x, { documentId: "MEET", source: "video_call", dated: "2026-01-14" });
    assert.ok(alts(m, "revenueByYear.2025").some((a) => /31\.8/.test(String(a.value)) && a.note === UNREVIEWED_YEAR_NOTE));
    assert.ok(alts(m, "revenueByYear.2026").some((a) => a.value === "$33,000,000" && a.note === FORECAST_YEAR_NOTE));
    assert.deepEqual(m.interimRevenue, { "Q1 2025": "$7,900,000" });
    assert.equal(yearSource(getFieldSources(m).interimRevenue, "Q1 2025")?.documentId, "MEET");
    // Idempotent: normalising the stored extraction again keeps the set-aside years.
    assert.deepEqual(normaliseExtraction(x as any)._yearsSetAside, x._yearsSetAside);
  }
  ok("extraction: quarters go to interimRevenue, budgets and unreviewed years to that year's other values — never keyFinancialNotes");

  // ── 5. CIM input: older reads' notes and older-year figures ──
  {
    const info: Info = {
      keyFinancialNotes: "Rent is paid monthly.\nNot recorded as yearly figures — revenue: 2025: about $31.8 million (management numbers, not reviewed); capex: 2022: higher after the move",
      totalOperatingExpenses: "$7,797,500",
      annualRent: "$322,000 (2023 and 2022)",
      revenueByYear: { "2023": "$29,180,000", "2024": "$31,020,000" },
      _fieldSources: {
        keyFinancialNotes: { source: "video_call", documentId: "MEET" },
        totalOperatingExpenses: doc("T223", { period: "2023-12-31" }),
        annualRent: doc("FS23", { period: "2023-12-31" }),
        revenueByYear: { source: "document", documentId: "FS24", years: { "2023": doc("FS23", { period: "2023-12-31" }), "2024": doc("FS24", { period: "2024-12-31" }) } },
      },
    };
    const cim = Object.fromEntries(splitFactsForCim(info).confirmed);
    assert.doesNotMatch(String(cim.keyFinancialNotes), /31\.8/, "an unreviewed year never reaches the writer");
    assert.match(String(cim.keyFinancialNotes), /capex: 2022: higher after the move/);
    assert.equal(cim.totalOperatingExpenses, "$7,797,500 (FY2023)", "an older year's figure says so");
    assert.equal(cim.annualRent, "$322,000 (2023 and 2022)", "a value naming its own years is left alone");
  }
  ok("CIM input: no unreviewed year from an older note; a figure from an older year than the statements is dated");

  // ── 6. Grounding: faithful summaries stay, worked-out figures go ──
  {
    const CALL = "Helen Park: A big chain opened about a kilometre away in October 2023, the other side of the Hunt Club intersection. " +
      "It's large, open till midnight. It hurt our front store — the OTC stuff — but our prescriptions stayed stable. " +
      "People stay with us because we know them; it's a relationship service.";
    const summary = "Chain pharmacy opened October 2023 approximately 1+ km away (other side of Hunt Club intersection); large format, open until midnight; negatively impacted front store sales (OTC products) but prescription volume stable; owner attributes retention to relationship-based service model";
    assert.ok(groundedInSource("competitorEnvironment", summary, CALL, { spoken: true }), "a faithful summary of what was said");
    assert.ok(!groundedInSource("competitorEnvironment", summary, CALL, { spoken: true, close: true }), "…though not in the speaker's own words");
    assert.ok(!groundedInSource("keyRisks", "Customer consolidation risk, succession gaps and pricing pressure from overseas mills", CALL, { spoken: true }), "a claim the source never makes");
    // Dates and labels a reader adds.
    assert.ok(groundedInSource("loiDate", "Aug 12, 2025 (Tuesday)", "LOI signed with Northgate on August 12, 2025."));
    assert.ok(groundedInSource("phone", "902-555-0100 (main), 902-555-0101 (support)", "Call us: 902-555-0100 · Support line 902-555-0101"));
    // A list of figures: the worked-out one goes, the printed ones stay.
    const WIP = "Job #,Customer,Contract value,Est. total cost,Cost to date,Revenue earned to date,Billed to date,Over/(under) billed\nTOTAL,,5243000,3962100,1628173,2143000,2183400,40400";
    const wip = "Total WIP contracts: $5,243,000 | Estimated total cost: $3,962,100 | Weighted average margin: 24.4% | Cost incurred to date: $1,628,173 | Billed to date: $2,183,400 | Net over-billed position: $40,400";
    assert.equal(groundedValue("workInProgressDetails", wip, WIP),
      "Total WIP contracts: $5,243,000 | Estimated total cost: $3,962,100 | Cost incurred to date: $1,628,173 | Billed to date: $2,183,400 | Net over-billed position: $40,400");
    assert.equal(groundedValue("workInProgressDetails", wip, WIP, { whole: true }), null);
    // A clause the source doesn't say in words isn't trimmed away — the summary isn't the source's.
    assert.equal(groundedValue("staffing", "Pharmacists hard to recruit; owner plans to franchise nationally", "Pharmacists are hard to recruit in Ottawa."), null);
    // Glued PDF columns ("336,616197,819") are no source for an exact "$617,819".
    const CF = "Cash provided by operating activities975,216728,019 Purchase of property and equipment(118,600)(110,200) Increase in cash336,616197,819";
    assert.ok(!groundedInSource("freeCashFlowByYear", "$617,819 (operating cash flow $728,019 - capex $110,200)", CF));
    assert.ok(groundedInSource("operatingCashFlow", "$728,019", CF));
    // A table row whose columns were glued together.
    assert.ok(groundedInSource("roadsideInspectionsByYear", "589 inspections, 36 out-of-service, 15.5% OOS rate", "Roadside inspections YearInspectionsOut-of-service (OOS) Driver OOSVehicle OOSOOS rate 20225893615.5%8,420,000"));
    // Money said the way people say it.
    assert.ok(groundedInSource("keyRisks", "110-ton brake replacement ~$180k", "the old 110-ton brake — replace in a year or two, maybe one-eighty", { spoken: true }));
    assert.ok(groundedInSource("revenueByYear", "$61,500,000 (budget)", "Tom: Sixty-one and a half million of revenue is the budget.", { spoken: true }));
  }
  ok("grounding: faithful summaries and reader-added labels pass; invented claims, computed figures and glued-column near misses don't");

  // ── 7. Reprocess keeps what the source said, unless the fresh read re-filed it ──
  {
    const CALL = "Helen Park: A big chain store went up 1 km from us in October 2023, past the Hunt Club intersection. It hurt our front store, but prescriptions stayed stable.";
    const said = "Chain pharmacy opened October 2023 about 1 km away (other side of Hunt Club intersection); hurt front-store sales, prescriptions stable";
    const existing: Info = { competitorEnvironment: said, _fieldSources: { competitorEnvironment: { source: "call", documentId: "CALL" } } };
    const rows = new Map<string, RereadRow>([["CALL", { text: CALL, kind: "call", title: "Intro call" }]]);
    assert.ok(!groundedInSource("competitorEnvironment", said, CALL, { spoken: true, close: true }) && groundedInSource("competitorEnvironment", said, CALL, { spoken: true }),
      "(a summary, not the speaker's words)");
    // The fresh read no longer gives it at all: kept.
    const report: OverlayReport = { dropped: [], kept: [] };
    const kept = overlayExistingFacts(mergeExtractedData({}, { employees: "12" } as any, { documentId: "CALL", source: "call" }), existing, {}, { rows, report });
    assert.equal(kept.competitorEnvironment, said);
    assert.equal(getFieldSources(kept).competitorEnvironment.documentId, "CALL");
    assert.deepEqual(report.dropped, []);
    // The fresh read gives the same thing under another name: one copy.
    const refiledFresh = mergeExtractedData({}, { competition: "Chain pharmacy opened in October 2023 about 1 km away, other side of the Hunt Club intersection; hurt front-store sales, prescriptions stable" } as any, { documentId: "CALL", source: "call" });
    const once = overlayExistingFacts(refiledFresh, existing, {}, { rows });
    assert.equal(once.competitorEnvironment, undefined);
    assert.match(String(once.competition), /Chain pharmacy/);
  }
  ok("reprocess: a seller-stated fact the fresh read didn't repeat stays; one it re-filed under another name isn't duplicated");

  // ── 8. A conflict already raised is never raised again on reprocess ──────
  {
    const c = (factKey: string, w: string, l: string, factYear?: string, period = "2024-12-31"): MergeConflict => ({
      factKey, ...(factYear ? { factYear } : {}),
      winner: { value: w, src: { source: "document", documentId: "T2", period } },
      loser: { value: l, src: { source: "email", documentId: "EM", period } },
    });
    // Stored rows: a stand-alone figure's row has no year; a map year's row has one.
    const rows = [
      { factKey: "ownerSalary", factYear: null, interviewValue: "$260,000", documentValue: "$180,000 paid to majority shareholder" },
      { factKey: "revenueByYear", factYear: "2024", interviewValue: "$31M", documentValue: "$31,020,000" },
    ];
    assert.deepEqual(conflictsNotYetRaised(rows, [c("ownerSalary", "$180,000 paid to majority shareholder", "$260,000")]), [], "the same stand-alone dispute on a second reprocess");
    assert.deepEqual(conflictsNotYetRaised(rows, [c("ownerSalaryByYear", "$180,000", "$260,000", "2024")]), [], "…or its map year, same two values");
    assert.deepEqual(conflictsNotYetRaised(rows, [c("annualRevenue", "$31,020,000", "$31M")]), [], "a headline and its map year are one dispute");
    assert.equal(conflictsNotYetRaised(rows, [c("revenueByYear", "$29,180,000", "$29.9M", "2023")]).length, 1, "a different year's dispute is new");
    assert.equal(conflictsNotYetRaised([], [c("backlog", "$3,100,000", "$4.2M"), c("backlog", "$3,100,000", "$4.2M")]).length, 1, "duplicates in one batch collapse");
  }
  ok("discrepancies: a dispute already raised (any status) isn't raised again by a later reprocess");

  console.log(`\n${n} f-merge round-2 checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
