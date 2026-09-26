// V11-1: a check row gives way to another engine's row only when that row
// records the SAME dispute (both values), and never to a row of lower
// severity. Before the fix, a critical "seller $2.3M vs P&L $1.82M" check row
// was superseded by any merge / analysis row on revenueByYear 2024 (a minor
// T2-vs-FS row, a resolved one, one with no fact key sharing $1.82M) and the
// CIM generation gate opened.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/rv-dispute-dedupe.test.ts
import assert from "node:assert/strict";
import { supersedeCheckDuplicates, blockingCritical, recordsSameDispute } from "../../server/cim/discrepancy-check";
import { discrepancyForConflict } from "../../server/documents/merge-conflicts";

const names: Record<string, string> = { fs: "FY2024 Financial Statements", t2: "2024 T2 Corporate Tax Return" };
const draft = discrepancyForConflict({
  factKey: "revenueByYear", factYear: "2024",
  winner: { value: "$1,820,000", src: { source: "document", documentId: "fs", specialist: true } as any },
  loser: { value: "$1,700,000", src: { source: "document", documentId: "t2" } as any },
} as any, (id) => names[id]);

async function run(check: any, other: any) {
  const rows: any[] = [
    { id: "c1", dealId: "d", source: "interview", status: "open", resolvedValue: null, createdAt: new Date("2026-09-20"), ...check },
    { id: "o1", dealId: "d", resolvedValue: null, createdAt: new Date("2026-09-22"), ...other },
  ];
  const store = {
    getDiscrepanciesByDeal: async () => rows.map((r) => ({ ...r })),
    updateDiscrepancy: async (id: string, patch: any) => Object.assign(rows.find((r) => r.id === id), patch),
  };
  const n = await supersedeCheckDuplicates("d", store as any);
  return { n, c1: rows[0], o1: rows[1], blocks: blockingCritical(rows) };
}

const c1 = {
  severity: "critical", field: "FY2024 revenue", factKey: "revenueByYear", factYear: "2024",
  interviewValue: "$2.3 million (seller, interview)", documentValue: "$1,820,000 — FY2024 Financial Statements",
};

// A different dispute on the same fact/year never supersedes the critical row.
for (const [label, other] of [
  ["merge T2-vs-FS open minor", { ...draft, source: "merge", status: "open" }],
  ["merge T2-vs-FS resolved", { ...draft, source: "merge", status: "resolved", resolvedValue: "$1,820,000" }],
  ["analysis T2-vs-FS significant", { source: "financial_analysis", status: "open", severity: "significant", field: "Revenue 2024 (T2 vs financial statements)", factKey: "revenueByYear", factYear: "2024", interviewValue: "$1,700,000 — 2024 T2 Corporate Tax Return", documentValue: "$1,820,000 — FY2024 Financial Statements" }],
  ["analysis without fact key", { source: "financial_analysis", status: "open", severity: "minor", field: "Revenue — tax return vs statements (2024)", factKey: null, factYear: null, interviewValue: "$1,700,000 — T2", documentValue: "$1,820,000 — FS" }],
  ["merge, dismissed-like settled minor", { source: "merge", status: "accepted", severity: "minor", field: "Revenue (2024)", factKey: "revenueByYear", factYear: "2024", interviewValue: "$1,790,000", documentValue: "$1,820,000", resolvedValue: "$1,820,000" }],
] as const) {
  const r = await run(c1, other);
  assert.equal(r.n, 0, `${label}: nothing superseded`);
  assert.equal(r.c1.status, "open", `${label}: the critical check row stays open`);
  assert.equal(r.blocks, true, `${label}: the generation gate still blocks`);
  assert.equal(recordsSameDispute(c1, other as any), false, `${label}: not the same dispute`);
}
console.log("✓ a different dispute on the same fact never supersedes a check row");

// Employees: 36 vs 28 (check) is not 30 vs 28 (merge).
{
  const r = await run(
    { severity: "critical", field: "Total employees", factKey: "employees", factYear: null, interviewValue: "36 employees", documentValue: "28 employees on payroll" },
    { source: "merge", status: "open", severity: "minor", field: "Employees", factKey: "employees", factYear: null, interviewValue: "30 employees (org chart)", documentValue: "28 employees on payroll" },
  );
  assert.equal(r.c1.status, "open");
  console.log("✓ a shared figure on one side is not the same dispute");
}

// The same dispute, lower severity, live: the survivor takes the critical severity.
{
  const r = await run(c1, { source: "merge", status: "open", severity: "minor", field: "Revenue (2024)", factKey: "revenueByYear", factYear: "2024", interviewValue: "$2,300,000 (call)", documentValue: "$1,820,000" });
  assert.equal(r.c1.status, "superseded", "one conflict, one row");
  assert.equal(r.o1.severity, "critical", "the surviving row carries the higher severity");
  assert.equal(r.blocks, true, "the gate still blocks");
  console.log("✓ same dispute, lower-severity live row: severity carried over");
}

// The same dispute, settled at lower severity: the critical row stays open.
{
  const r = await run(c1, { source: "merge", status: "resolved", severity: "minor", field: "Revenue (2024)", factKey: "revenueByYear", factYear: "2024", interviewValue: "$2,300,000", documentValue: "$1,820,000", resolvedValue: "$1,820,000" });
  assert.equal(r.c1.status, "open", "never in favour of a lower-severity settled row");
  assert.equal(r.blocks, true);
  console.log("✓ same dispute settled at lower severity leaves the critical open");
}

// The same dispute, equal severity, settled: superseded (the broker already decided it).
{
  const r = await run(c1, { source: "financial_analysis", status: "resolved", severity: "critical", field: "Revenue (2024)", factKey: "revenueByYear", factYear: "2024", interviewValue: "$2.3M", documentValue: "$1,820,000", resolvedValue: "$1,820,000" });
  assert.equal(r.c1.status, "superseded");
  assert.equal(r.blocks, false);
  console.log("✓ same dispute settled at equal severity supersedes");
}

console.log("rv-dispute-dedupe: all passed");
