// SECOND free round, stream "finance-facts" (f2-finance-facts): proved offline
// (no model call).
//  F2-02  EBITDA / SDE / working capital stated scaled ($1.2 million, $400K, in thousands, BAIIA 1 398 000) is kept
//  F2-03  an equipment / vehicle lease never becomes the premises lease; two leases are
//         "two premises" only when their addresses differ; checklist rows by lease kind
//  F2-01  a side with its own figure plus "(name not disclosed)" is compared, not dropped as missing
//  F2-07  a scanned PDF whose text is a watermark / cover page is unreadable (no model read, checklist asks again)
//  F2-08  a year-list resolution of a by-year fact writes each year (others kept), the overlay stays a map
//  r3-*   part labels only strip a noun phrase; row-prose summaries are dropped only beside a headline part
//  F2-09  by-year counts whose key holds a money word's letters ("activeDriversDecember")
//         are kept; a note on the whole year's figure is not a "part of the business"
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-finance-facts.test.ts
import assert from "node:assert/strict";
import { combinePartSummaries, extractDocumentData, isRowRangeDescription, mergeExtractedData, stripPartLabel, MIN_READABLE_CHARS, readFoundNothing, thinTextLayer } from "../../server/documents/extractor";
import { cleanYearMap, isSubsetFigure, settleConflicts, type MergeConflict } from "../../server/documents/merge-policy";
import { isEquipmentLeaseTitle, isPremisesLeaseTitle } from "../../server/documents/lease-kind";
import { findMatchingRequirement } from "../../server/documents/requirements";
import { getFieldSources, sourceRowLookup } from "../../server/interview/info-merger";
import { dropReason, isMissingSide } from "../../server/cim/discrepancy-filter";
import { applyResolutionToInfo } from "../../server/information/facts";
import { overlayWrite } from "../../server/information/resolution-write";
import { resolvedNotes, settleResolvedFacts } from "../../server/cim/resolved-block";
import { groundedInSource, guardExtraction, printedInThousands } from "../../server/documents/extraction-guard";

const ok = (msg: string) => console.log(`✓ ${msg}`);

// ── F2-03: equipment leases ─────────────────────────────────────────────────────
{
  const conflicts: MergeConflict[] = [];
  let info: Record<string, unknown> = {};
  info = mergeExtractedData(info, { leaseExpiry: "August 31, 2031", monthlyRent: "$9,700 per month" },
    { source: "call", documentId: "call1", title: "Discovery call", dated: "2025-02-01" }, { conflicts });
  info = mergeExtractedData(info, { leaseExpiry: "August 31, 2031", monthlyRent: "$9,700 per month plus TMI", leaseAddress: "240 Bayfront Commerce Dr" },
    { source: "document", documentId: "prem", title: "Shop lease - 240 Bayfront Commerce Drive", dated: "2025-03-01" }, { conflicts });
  info = mergeExtractedData(info, { leaseExpiry: "March 31, 2027", monthlyRent: "$1,150 per month" },
    { source: "document", documentId: "fork", title: "Equipment lease - Toyota forklift", dated: "2025-04-15" }, { conflicts });
  assert.equal(info.leaseExpiry, "August 31, 2031");
  assert.equal(info.monthlyRent, "$9,700 per month plus TMI");
  assert.match(String(info.leaseDetails), /Expires: August 31, 2031/);
  assert.doesNotMatch(String(info.leaseDetails), /2027|1,150/);
  assert.equal(getFieldSources(info).leaseExpiry.documentId, "prem");
  assert.equal(getFieldSources(info).monthlyRent.documentId, "prem");
  assert.match(String(info.equipmentLeases), /^Equipment lease - Toyota forklift: /);
  assert.match(String(info.equipmentLeases), /Payment: \$1,150 per month/);
  assert.match(String(info.equipmentLeases), /Expires: March 31, 2027/);
  assert.equal(getFieldSources(info).equipmentLeases.documentId, "fork");
  assert.deepEqual(conflicts.map((c) => c.factKey), []);
  ok("a forklift lease uploaded after the premises lease leaves the premises expiry and rent alone (equipmentLeases instead)");
}
{
  // Vehicles (Pacific's tractors, Lakeshore's vans) go to vehicleLeases; the model's own summary is kept.
  const info = mergeExtractedData({}, { leaseDetails: "3 Freightliner Cascadia tractors, 60 months", monthlyRent: "$6,450 per month" },
    { source: "document", documentId: "trac", title: "Tractor lease schedule - Volvo Financial" });
  assert.equal(info.vehicleLeases, "Tractor lease schedule - Volvo Financial: 3 Freightliner Cascadia tractors, 60 months; Payment: $6,450 per month");
  assert.equal(info.leaseDetails, undefined);
  assert.equal(info.monthlyRent, undefined);
  // The reader's own type decides too ("Lease.pdf" read as an equipment lease).
  const typed = mergeExtractedData({}, { _documentType: "Equipment lease - copier", leaseExpiry: "2026-06-30" } as never,
    { source: "document", documentId: "cop", title: "Lease.pdf" });
  assert.equal(typed.leaseExpiry, undefined);
  assert.match(String(typed.equipmentLeases), /Expires: 2026-06-30/);
  ok("vehicle leases → vehicleLeases; a source the reader typed as an equipment lease is rerouted too");
}
{
  for (const t of ["Equipment lease - Toyota forklift", "Fleet Financing/Lease Agreements", "Van lease (3 Ford Transit)", "Office equipment lease - Canon copier", "Equipment Lease Agreements"]) {
    assert.ok(isEquipmentLeaseTitle(t), t);
    assert.ok(!isPremisesLeaseTitle(t), t);
  }
  for (const t of ["Shop lease - 240 Bayfront Commerce Drive", "Commercial Lease Agreement", "Warehouse Lease Agreement", "Truck yard lease", "Lease.pdf", "Lease - 45 Industrial Pkwy (forklift bay)"]) {
    assert.ok(isPremisesLeaseTitle(t), t);
    assert.ok(!isEquipmentLeaseTitle(t), t);
  }
  ok("lease kind by title: equipment / vehicle vs premises (a truck yard and an address are premises)");
}
{
  // Two premises leases naming two addresses: two leases, no conflict.
  const conflicts: MergeConflict[] = [];
  let info: Record<string, unknown> = {};
  info = mergeExtractedData(info, { leaseAddress: "240 Bayfront Commerce Dr", leaseExpiry: "August 31, 2031" },
    { source: "document", documentId: "a", title: "Shop lease - Bayfront", dated: "2025-03-01" }, { conflicts });
  info = mergeExtractedData(info, { leaseAddress: "18 Harbour Rd, Unit 4", leaseExpiry: "June 30, 2027" },
    { source: "document", documentId: "b", title: "Warehouse lease - Harbour Rd", dated: "2025-05-01" }, { conflicts });
  assert.deepEqual(conflicts.filter((c) => c.factKey === "leaseExpiry"), []);
  // The same premises (or no address to tell them apart): the broker hears about it.
  const c2: MergeConflict[] = [];
  let same: Record<string, unknown> = {};
  same = mergeExtractedData(same, { leaseAddress: "240 Bayfront Commerce Dr", leaseExpiry: "August 31, 2031" },
    { source: "document", documentId: "a", title: "Shop lease - Bayfront", dated: "2025-03-01" }, { conflicts: c2 });
  same = mergeExtractedData(same, { leaseAddress: "240 Bayfront Commerce Drive, Hamilton", leaseExpiry: "August 31, 2026" },
    { source: "document", documentId: "b", title: "Lease amending agreement", dated: "2025-05-01" }, { conflicts: c2 });
  assert.ok(c2.some((c) => c.factKey === "leaseExpiry"), JSON.stringify(c2));
  const c3: MergeConflict[] = [];
  let noAddr: Record<string, unknown> = {};
  noAddr = mergeExtractedData(noAddr, { leaseExpiry: "August 31, 2031" }, { source: "document", documentId: "a", title: "Premises lease", dated: "2025-03-01" }, { conflicts: c3 });
  noAddr = mergeExtractedData(noAddr, { leaseExpiry: "August 31, 2026" }, { source: "document", documentId: "b", title: "Lease", dated: "2025-05-01" }, { conflicts: c3 });
  assert.ok(c3.some((c) => c.factKey === "leaseExpiry"), JSON.stringify(c3));
  // Clearwater's two clinics: no leaseAddress extracted, the titles name the addresses.
  const c4: MergeConflict[] = [];
  const lookup = sourceRowLookup([
    { id: "hill", name: "Lease - Hillhurst clinic (2217 Wexford Ave NW), expires May 31, 2027" },
    { id: "seton", name: "Lease - Seton clinic (118 Hollowbrook Gate SE), expires Aug 31, 2031" },
  ]);
  let two: Record<string, unknown> = {};
  two = mergeExtractedData(two, { leaseExpiry: "May 31, 2027" }, { source: "document", documentId: "hill", title: "Lease - Hillhurst clinic (2217 Wexford Ave NW), expires May 31, 2027", dated: "2025-03-01" }, { conflicts: c4, lookup });
  two = mergeExtractedData(two, { leaseExpiry: "August 31, 2031" }, { source: "document", documentId: "seton", title: "Lease - Seton clinic (118 Hollowbrook Gate SE), expires Aug 31, 2031", dated: "2025-04-01" }, { conflicts: c4, lookup });
  assert.deepEqual(c4.filter((c) => c.factKey === "leaseExpiry"), []);
  assert.deepEqual(settleConflicts(two, c4, lookup), []);
  ok("two leases are 'two premises' only when both name different addresses (facts or titles); otherwise the change is a conflict");
}
{
  const rows = [
    { id: "prem", documentName: "Commercial Lease Agreement", category: "legal", status: "missing", sortOrder: 1 },
    { id: "eq", documentName: "Equipment Lease Agreements", category: "legal", status: "missing", sortOrder: 2 },
  ];
  assert.equal(findMatchingRequirement(rows, "Equipment lease - Toyota forklift.pdf", "legal")?.id, "eq");
  assert.equal(findMatchingRequirement(rows, "Shop lease - 240 Bayfront.pdf", "legal")?.id, "prem");
  const premOnly = [rows[0]];
  assert.equal(findMatchingRequirement(premOnly, "Equipment lease - Toyota forklift.pdf", "legal"), undefined);
  assert.equal(findMatchingRequirement(premOnly, "Van lease 2024.pdf", "other"), undefined);
  assert.equal(findMatchingRequirement(premOnly, "Lease.pdf", "legal")?.id, "prem");
  ok("an equipment lease never ticks the Commercial Lease row; a premises lease no longer ties with the equipment row");
}

// ── F2-09: by-year keys and notes ──────────────────────────────────────────────
{
  assert.deepEqual(cleanYearMap("activeDriversDecember", { "2024": "96" }).map, { "2024": "96" });
  assert.deepEqual(cleanYearMap("currentStaff", { "2023": "41" }).map, { "2023": "41" });
  assert.deepEqual(cleanYearMap("costumeRentals", { "2023": "12" }).map, { "2023": "12" });
  // Real money metrics still need an amount.
  assert.deepEqual(cleanYearMap("revenue", { "2024": "trending up 2-3%" }).map, {});
  assert.deepEqual(cleanYearMap("operatingExpenses", { "2024": "about the same" }).map, {});
  assert.deepEqual(cleanYearMap("rent", { "2024": "went up" }).map, {});
  assert.deepEqual(cleanYearMap("grossprofit", { "2024": "higher" }).map, {});
  assert.deepEqual(cleanYearMap("sde", { "2024": "$412,000" }).map, { "2024": "$412,000" });
  // A count named with "sDe" is not an SDE figure; a revenue map still refuses an SDE value.
  assert.deepEqual(cleanYearMap("revenue", { "2024": "SDE ~$380K" }).map, {});
  ok("money metrics judged by the key's words (activeDriversDecember is a count, rent/revenue still need amounts)");
}
{
  const kept = (v: string) => cleanYearMap("revenue", { "2024": v }).map["2024"];
  assert.equal(kept("$9,815,000 (net of customer rebates)"), "$9,815,000 (net of customer rebates)");
  assert.equal(kept("$10,420,000 (audited; only full year on file)"), "$10,420,000 (audited; only full year on file)");
  assert.equal(kept("$10,420,000 (compiled, per client statements)"), "$10,420,000 (compiled, per client statements)");
  assert.deepEqual(cleanYearMap("revenue", { "FYE Jun 2024": "$10,420,000" }).map, { "2024": "$10,420,000" });
  for (const v of ["$6.8M (Alderbrook only)", "$2.1M from our largest customer", "$900K (retail segment)", "$1.2M (Surrey location alone)", "$3M for one client", "$4M only the Burnaby clinic"]) {
    assert.ok(isSubsetFigure(v), v);
    assert.equal(kept(v), undefined, v);
  }
  for (const v of ["$9,815,000 (net of customer rebates)", "$10,420,000 (audited; only full year on file)", "$4.1M (all segments combined)", "$5M (customer deposits excluded)"]) {
    assert.ok(!isSubsetFigure(v), v);
  }
  ok("a note about the whole year's figure is kept; a part of the business is still not the year's total");
}

// ── F2-01: a side with its own figure plus a "not stated" qualifier is comparable ──
{
  const cases = [
    { field: "Customer concentration", interviewValue: "No customer is more than 15% of sales", documentValue: "Largest customer 31% of 2024 revenue (customer name not disclosed)", severity: "critical" },
    { field: "Lease expiry", interviewValue: "Lease runs to 2034", documentValue: "Lease expires August 31, 2029; renewal options not stated", severity: "critical" },
    { field: "Employees", interviewValue: "22 full-time staff", documentValue: "31 employees on the 2024 T4 summary; part-time split not provided", severity: "significant" },
    { field: "Revenue 2024", interviewValue: "$4.2M", documentValue: "$3,450,000 per the 2024 T2 (GIFI line 8299); cannot be verified against bank statements", severity: "critical" },
  ];
  for (const c of cases) {
    assert.equal(isMissingSide(c.documentValue), false, c.field);
    assert.equal(dropReason(c as never), null, c.field);
  }
  // Recorded fact wordings on the demo deals.
  for (const v of [
    "Helen Park is designated manager and owner-operator. Specific hours/week not stated. Uses company vehicle ~25% for business (home visits).",
    "Equipment loans with Tallwood Credit Union (specific amounts not stated), operating line of credit used in spring before maintenance revenue arrives",
    "Owner works full time in the business; exact hours not stated",
    "Not stated in the documents, but the P&L shows $1.2M",
  ]) assert.equal(isMissingSide(v), false, v);
  // A side that says only that the source is absent is still missing.
  for (const v of [
    "No Larkspur MSA document provided in uploaded documents to verify this claim",
    "Not provided", "N/A - document not uploaded", "Unknown (not in the uploaded documents)",
    "Specific hours/week not stated", "specific amounts not stated", "The contract is not among the uploaded documents",
    "Cannot be confirmed from the documents provided", "No supporting documentation on file.",
  ]) assert.equal(isMissingSide(v), true, v);
  ok("F2-01: a figure + a 'not disclosed' qualifier is a real side (the 31% vs 15% conflict survives); a bare 'not provided' is still missing");
}

// ── F2-02: a stated EBITDA / SDE / working capital in scaled form is kept ─────
{
  const email = "Hi Morgan, as discussed, our EBITDA last year was $1.2 million and SDE about $1.45M. Working capital normally sits at $400K.";
  const r = guardExtraction({ ebitda: "$1,200,000", sde: "$1,450,000", workingCapital: "$400,000" }, email, {});
  assert.deepEqual(r.dropped, []);
  assert.equal(r.data.ebitda, "$1,200,000");
  assert.equal(r.data.sde, "$1,450,000");
  assert.equal(r.data.workingCapital, "$400,000");
  // More precision than the source gives is still not printed.
  assert.equal(guardExtraction({ ebitda: "$1,234,000" }, email, {}).data.ebitda, undefined);
  const stmt = `Great Lakes Plastics Inc.
Summary of Earnings (in thousands of US dollars)
                     2024     2023
Revenue            42,118   38,904
EBITDA              6,412    5,870
Adjusted EBITDA     7,005    6,340
Working capital     5,210    4,880`;
  const g = guardExtraction({ revenue: "$42,118,000", ebitda: "$6,412,000", adjustedEbitda: "$7,005,000", workingCapital: "$5,210,000",
    byYear: { ebitda: { "2024": "$6,412,000", "2023": "$5,870,000" } } }, stmt, { document: true });
  assert.deepEqual(g.dropped, []);
  assert.deepEqual((g.data.byYear as Record<string, Record<string, string>>).ebitda, { "2024": "$6,412,000", "2023": "$5,870,000" });
  // Without the "in thousands" header, 6,412 is not $6,412,000.
  const noHeader = stmt.replace(" (in thousands of US dollars)", "");
  assert.equal(guardExtraction({ ebitda: "$6,412,000" }, noHeader, { document: true }).data.ebitda, undefined);
  // French statements: BAIIA, thousands grouped with plain spaces.
  const fr = "États financiers — exercice terminé le 31 décembre 2024\nBAIIA  1 398 000  1 282 000\nFonds de roulement  402 100";
  const f = guardExtraction({ ebitda: "$1,398,000", byYear: { ebitda: { "2023": "$1,282,000" } } }, fr, { document: true });
  assert.deepEqual(f.dropped, []);
  // Glued statement columns (the known leftover) still read.
  const glued = "Earnings before interest, amortization and income taxes1,398,0001,282,000";
  assert.equal(guardExtraction({ ebitda: "$1,398,000" }, glued, { document: true }).data.ebitda, "$1,398,000");
  assert.ok(printedInThousands("(in thousands of Canadian dollars)") && printedInThousands("($000s)") && printedInThousands("en milliers de dollars"));
  assert.ok(!printedInThousands("Revenue grew to $4.1M"));
  // Reprocess grounding keeps the same values.
  assert.ok(groundedInSource("ebitda", "$6,412,000", stmt));
  assert.ok(groundedInSource("ebitda", "$1,398,000", fr));
  assert.ok(groundedInSource("sde", "$1,450,000", email));
  assert.ok(!groundedInSource("ebitda", "$6,412,000", noHeader));
  ok("F2-02: EBITDA/SDE/working capital stated as $1.2 million / $400K / in thousands / BAIIA 1 398 000 are kept; unstated precision is not");
}

// ── F2-07: a scanned PDF with a thin text layer is not "read" ─────────────────
await (async () => {
  const watermark = Array.from({ length: 30 }, (_, i) => `Scanned with CamScanner\n${i + 1}`).join("\n\n");
  assert.ok(watermark.length > MIN_READABLE_CHARS);
  assert.ok(thinTextLayer(watermark), "30 pages of a watermark");
  const cover = `T2 Corporation Income Tax Returns 2022 to 2024 — Harbourline Dental Group Inc. Prepared for the sale file.\n\n${watermark}`;
  assert.ok(thinTextLayer(cover), "a typed cover page over 30 scanned pages");
  assert.ok(thinTextLayer("Harbourline Dental — tax returns", 30), "the PDF's own page count");
  const read = await extractDocumentData(watermark, "tax_returns", null, "document");
  assert.equal(read._failure, "unreadable");
  assert.match(String(read._failureReason), /scanned document/);
  // A readable document with a running header on every page is not thin.
  const readable = Array.from({ length: 30 }, (_, i) => `Harbourline Dental — Confidential\nPage ${i + 1} of 30\n${"Revenue from hygiene services was $412,300 in 2024, up from $388,100. ".repeat(8)}`).join("\n\n");
  assert.ok(!thinTextLayer(readable));
  assert.ok(!thinTextLayer(readable, 30));
  // One or two short pages are judged by the old minimum alone.
  assert.ok(!thinTextLayer("Lease renewal confirmed to August 2031 at $9,700 a month.", 1));
  // A ledger's rows are not a watermark.
  const csv = ["Date,Description,Amount", ...Array.from({ length: 400 }, (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, "0")},POS PURCHASE,${(i * 1.37).toFixed(2)}`)].join("\n");
  assert.ok(!thinTextLayer(csv));
  // Read, but nothing about the business came out of a thin text: the checklist row asks again.
  assert.ok(readFoundNothing({ _documentType: "tax return", summary: "Scanned pages." }, cover, 30));
  assert.ok(!readFoundNothing({ summary: "x", annualRevenue: "$4.1M" } as never, cover, 30));
  assert.ok(!readFoundNothing({ summary: "x" }, readable, 30));
  ok("F2-07: 30 pages of 'Scanned with CamScanner' (or a cover page over scans) is unreadable, not 'read'; readable pages and ledgers are not");
})();

// ── F2-08: resolving a by-year fact with a year list writes those years only ──
{
  const mkInfo = () => ({
    revenueByYear: { "2021": "$8,200,000", "2022": "$8,640,000", "2023": "$9,050,000", "2024": "$9,700,000" },
    annualRevenue: "$9,700,000",
    _fieldSources: {
      revenueByYear: { source: "document", documentId: "fs", years: {
        "2021": { source: "document", documentId: "fs21", period: "2021-12-31" },
        "2022": { source: "document", documentId: "fs22", period: "2022-12-31" },
        "2023": { source: "document", documentId: "fs23", period: "2023-12-31" },
        "2024": { source: "document", documentId: "fs24", period: "2024-12-31" } } },
      annualRevenue: { source: "document", documentId: "fs24", period: "2024-12-31" },
    },
  } as Record<string, unknown>);
  const row: any = {
    id: "d1", dealId: "x", field: "Revenue (2023-2024)", factKey: "revenueByYear", factYear: null, source: "interview",
    interviewValue: "2023: $9,100,000; 2024: $9,815,000", documentValue: "2023: $9,050,000; 2024: $9,700,000",
    resolvedValue: "2023: $9,100,000; 2024: $9,815,000", status: "resolved", resolvedAt: new Date().toISOString(), documentId: "fs24",
  };
  const info = mkInfo();
  assert.equal(applyResolutionToInfo(info, row), "revenueByYear");
  assert.deepEqual(info.revenueByYear, { "2021": "$8,200,000", "2022": "$8,640,000", "2023": "$9,100,000", "2024": "$9,815,000" });
  const ys = (getFieldSources(info).revenueByYear as any).years;
  assert.equal(ys["2021"].documentId, "fs21");
  assert.equal(ys["2022"].documentId, "fs22");
  assert.equal(ys["2024"].source, "broker");
  assert.equal(info.annualRevenue, "$9,815,000", "the headline follows its own year");
  const alts = (info._fieldAlternates ?? {}) as Record<string, Array<{ value: string }>>;
  assert.ok((alts["revenueByYear.2024"] ?? []).some((a) => a.value === "$9,700,000"), JSON.stringify(Object.keys(alts)));
  // The CIM input keeps the map a map.
  const { facts } = settleResolvedFacts(mkInfo(), resolvedNotes([row]));
  assert.deepEqual(facts.revenueByYear, { "2021": "$8,200,000", "2022": "$8,640,000", "2023": "$9,100,000", "2024": "$9,815,000" });
  assert.equal(facts.annualRevenue, "$9,815,000");
  // overlayWrite never puts a string over a map.
  const o = mkInfo();
  overlayWrite(o, { key: "revenueByYear", value: "$10M" }, { source: "broker" } as never);
  assert.deepEqual(o.revenueByYear, mkInfo().revenueByYear);
  ok("F2-08: '2023: …; 2024: …' resolves year by year (2021/2022 and their sources kept; headline paired); the CIM overlay stays a map");
}

// ── Known leftovers r3-part-label-of-the / r3-summary-row-parts ───────────────
{
  // "of the <noun phrase>" only — a verb before the document word keeps the fact whole.
  assert.equal(stripPartLabel("Part 2 of 5 of the lease requires the tenant to file returns quarterly.", { total: 5 }),
    "Part 2 of 5 of the lease requires the tenant to file returns quarterly.");
  assert.equal(stripPartLabel("Part 2 of 5 of a customer membership database showing member IDs CC-10620 through CC-11280", { total: 5 }),
    "Customer membership database showing member IDs CC-10620 through CC-11280");
  assert.equal(stripPartLabel("Part 3 of 5 of the T2 returns covering FY2023", { total: 5 }), "T2 returns covering FY2023");
  assert.equal(stripPartLabel("Part 1 of 5 of the file", { total: 5 }), "File");
  // A real sentence about records is a finding, not row prose.
  assert.ok(!isRowRangeDescription("Payroll records from 2020 to 2024 reconcile to the T4 slips."));
  assert.ok(!isRowRangeDescription("Bank records from January 2023 through December 2024 match the deposits."));
  assert.ok(isRowRangeDescription("Customer records from February 2023 through November 2023"));
  // With no part stating the headline, no part's summary is left out.
  const combined = combinePartSummaries(["Vendor ledger for the shop.", "Customer records from February 2023 through November 2023"], { total: 2 });
  assert.match(combined, /Vendor ledger/);
  assert.match(combined, /Customer records from February 2023/);
  // With a headline part, pure row prose still gives way.
  const withHead = combinePartSummaries(["Customer records from February 2023 through November 2023", "2,900 active members; $75,835 MRR as of June 2025."], { total: 2 });
  assert.equal(withHead, "2,900 active members; $75,835 MRR as of June 2025.");
  ok("leftovers: 'Part 2 of 5 of the lease requires…' kept whole; 'records … reconcile' is a finding; row prose is dropped only beside a headline");
}

console.log("f2-finance-facts: all passed");
