// R1: scrubbing a held name out of a section must never move a table's
// figures into another year. Before the fix, scrubHeldNames dropped every ""
// entry of every array, so headers ["", FY2022, FY2023, FY2024] and a row
// ["", "$3.1M", "$3.4M"] collapsed and $3.1M (FY2023) showed under FY2022 —
// even when the held name was only in a footnote or in the draft text.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/rv-scrub-columns.test.ts
import assert from "node:assert/strict";
import { scrubHeldNames } from "../../server/cim/layout-engine";
import { normalizeFinancialTable } from "../../shared/financial-table";

const HELD = ["Westlock Energy"];
const table = (extra: Record<string, unknown> = {}) => ({
  headers: ["", "FY2022", "FY2023", "FY2024"],
  rows: [
    { label: "Revenue", values: ["", "$3.1M", "$3.4M"] },
    { label: "Gross profit", values: ["$1.0M", "", "$1.2M"] },
    { label: "Backlog", values: ["", "", "$2.0M"] },
    { label: "Westlock Energy RFP (pending)", values: ["", "", "$1.1M"] },
  ],
  ...extra,
});

const cellsOf = (ld: any) => Object.fromEntries(normalizeFinancialTable(ld).rows.map((r: any) => [r.label, r.cells]));

// 1. The held name in a row and a footnote: the row goes, every other figure stays in its year.
{
  const before = cellsOf(table());
  const r = scrubHeldNames({ layoutData: table({ footnotes: ["FY2024 backlog excludes the Westlock Energy RFP.", "Figures unaudited."] }) }, HELD)!;
  assert.ok(r, "something was scrubbed");
  const ld = r.layoutData as any;
  assert.deepEqual(ld.headers, ["", "FY2022", "FY2023", "FY2024"], "headers keep their positions");
  assert.equal(ld.rows.length, 3, "the row naming the party is gone");
  assert.deepEqual(ld.rows[0].values, ["", "$3.1M", "$3.4M"]);
  assert.deepEqual(ld.rows[1].values, ["$1.0M", "", "$1.2M"]);
  const after = cellsOf(ld);
  for (const label of ["Revenue", "Gross profit", "Backlog"]) assert.deepEqual(after[label], before[label], `${label} keeps its columns`);
  assert.deepEqual(ld.footnotes, ["Figures unaudited."], "a list item naming the party goes");
  assert.doesNotMatch(JSON.stringify(ld), /Westlock/);
  console.log("✓ table columns keep their years when a held name is scrubbed");
}

// 2. The name only in the draft text: the table is untouched.
{
  const r = scrubHeldNames({ layoutData: { headers: ["", "FY2023", "FY2024"], rows: [{ label: "Revenue", values: ["", "$3.4M"] }] }, aiDraftContent: "Backlog excludes Westlock Energy." }, HELD)!;
  assert.deepEqual((r.layoutData as any).rows[0].values, ["", "$3.4M"]);
  assert.deepEqual((r.layoutData as any).headers, ["", "FY2023", "FY2024"]);
  assert.doesNotMatch(r.aiDraftContent ?? "", /Westlock/);
  console.log("✓ a draft-only mention leaves the table as it was");
}

// 3. A cell naming the party is blanked in place, not removed.
{
  const r = scrubHeldNames({ layoutData: { headers: ["Line item", "FY2024", "Westlock Energy pilot."], rows: [{ label: "Revenue", values: ["$3.4M", "$0.2M"] }] } }, HELD)!;
  const h = (r.layoutData as any).headers;
  assert.equal(h.length, 3);
  assert.deepEqual(h.slice(0, 2), ["Line item", "FY2024"]);
  assert.doesNotMatch(h[2], /Westlock/);
  assert.deepEqual((r.layoutData as any).rows[0].values, ["$3.4M", "$0.2M"]);
  console.log("✓ a cell is scrubbed in place");
}

// 4. Lists still lose the items that name the party.
{
  const r = scrubHeldNames({ layoutData: { highlights: ["Strong backlog.", "Shortlisted for the Westlock Energy RFP."] } }, HELD)!;
  assert.deepEqual((r.layoutData as any).highlights, ["Strong backlog."]);
  console.log("✓ list items naming the party are removed");
}

console.log("rv-scrub-columns: all passed");
