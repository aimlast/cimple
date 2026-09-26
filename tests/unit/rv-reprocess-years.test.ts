// V11-2: a reprocess whose fresh read of a row leaves out a year it gave
// before must not drop that year silently. Before the fix, yielded() asked
// yearSource() for the missing year, which fell back to the map's base
// source (the same row), so FY2022 counted as "yielded", skipped the
// grounded-keep rule and never reached report.dropped.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/rv-reprocess-years.test.ts
import assert from "node:assert/strict";
import { overlayExistingFacts } from "../../server/documents/reprocess";
import { mergeExtractedData } from "../../server/documents/extractor";

const text = `Harbour Freight Ltd. Comparative income statement
                2024        2023        2022
Revenue    3,100,000   2,870,000   2,540,000
Net income   410,000     362,000     301,000`;
const docA = { documentId: "docA", source: "document", kind: "document", period: "2024-12-31", title: "Income statement 2022-2024" } as any;
const rows = () => new Map([["docA", { text, kind: "document" as any, title: "Income statement 2022-2024", period: "2024-12-31" }]]);

// The earlier read gave all three years; today's read of the same row omits 2022.
const before = mergeExtractedData({}, { revenueByYear: { "2024": "$3,100,000", "2023": "$2,870,000", "2022": "$2,540,000" } } as any, docA, {});
const fresh = mergeExtractedData({}, { revenueByYear: { "2024": "$3,100,000", "2023": "$2,870,000" } } as any, docA, {});

{
  const report = { dropped: [] as any[], kept: [] as any[] };
  const out = overlayExistingFacts(fresh, before, { conflicts: [] }, { rows: rows(), report });
  const map = out.revenueByYear as Record<string, string>;
  assert.equal(map["2022"], "$2,540,000", "FY2022 is printed in the row, so it is kept");
  assert.equal(map["2023"], "$2,870,000");
  assert.equal(map["2024"], "$3,100,000");
  assert.ok(report.kept.some((k) => k.key === "revenueByYear.2022"), "the kept year is reported");
  console.log("✓ a year the fresh read omitted is kept when the row still prints it");
}

// A year the row does not print any more is dropped — and reported.
{
  const edited = text.replace("2,540,000", "").replace("2022", "");
  const report = { dropped: [] as any[], kept: [] as any[] };
  const out = overlayExistingFacts(fresh, before, { conflicts: [] }, {
    rows: new Map([["docA", { text: edited, kind: "document" as any, title: "Income statement", period: "2024-12-31" }]]),
    report,
  });
  assert.equal((out.revenueByYear as any)["2022"], undefined);
  assert.ok(report.dropped.some((d) => String(d.key).startsWith("revenueByYear") && String(d.value).includes("2,540,000")), "the loss is reported");
  console.log("✓ a year the row no longer states is dropped and reported");
}

// A year the fresh read DOES give is still replaced by the fresh figure.
{
  const fresh2 = mergeExtractedData({}, { revenueByYear: { "2024": "$3,100,000", "2023": "$2,870,000", "2022": "$2,540,000" } } as any, docA, {});
  const report = { dropped: [] as any[], kept: [] as any[] };
  const out = overlayExistingFacts(fresh2, before, { conflicts: [] }, { rows: rows(), report });
  assert.deepEqual(Object.keys(out.revenueByYear as any).sort(), ["2022", "2023", "2024"]);
  assert.equal(report.kept.length + report.dropped.length, 0, "nothing replayed");
  console.log("✓ yielded years follow the fresh read");
}

console.log("rv-reprocess-years: all passed");
