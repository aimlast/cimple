// SECOND free round, stream "finance-facts", F2-06: the financial analysis reads a long
// statement pack in parts and spreads a tax pack's text budget across the whole pack.
// Offline (a stubbed part reader; no model call).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-financial-parts.test.ts
import assert from "node:assert/strict";
import {
  combinePartStatements,
  extractFinancialDataInParts,
  unreadFinancialText,
  FIN_PART_CHARS,
  FIN_MAX_PARTS,
  type ExtractedStatement,
} from "../../server/financial/extractor";
import { sliceRelevantText, spreadWindows } from "../../server/financial/analyzer";

const ok = (msg: string) => console.log(`✓ ${msg}`);

const pnl = (years: string[], extra: Partial<ExtractedStatement> = {}): ExtractedStatement => ({
  statementType: "income_statement",
  periods: years,
  lineItems: [
    { label: "Revenue", amounts: Object.fromEntries(years.map((y) => [y, Number(y) * 1000])), category: "revenue" },
    { label: "Cost of sales", amounts: Object.fromEntries(years.map((y) => [y, Number(y) * 400])), category: "cogs" },
    { label: "Wages", amounts: Object.fromEntries(years.map((y) => [y, Number(y) * 200])), category: "operating_expenses" },
    { label: "Net income", amounts: Object.fromEntries(years.map((y) => [y, Number(y) * 50])), category: "net_income" },
  ],
  currency: "CAD",
  sourceDocumentId: "fs",
  confidence: 0.9,
  notes: [],
  ...extra,
});

(async () => {
  // ── A ~150K "Financial statements FY2022-FY2024" pack: every year read ──────
  const page = (y: string, i: number) => `Page ${i} of 60\nStatement of income for the year ended December 31, ${y}\n${"Revenue  Cost of sales  Wages  Net income ".repeat(60)}\n`;
  const years = ["2022", "2023", "2024"];
  const pack = years.flatMap((y, k) => Array.from({ length: 20 }, (_, i) => page(y, k * 20 + i + 1))).join("\f");
  assert.ok(pack.length > FIN_PART_CHARS, `pack ${pack.length}`);
  const seen: string[] = [];
  const read = async (text: string, _id: string, _name: string, label?: string) => {
    seen.push(label ?? "whole");
    const ys = years.filter((y) => text.includes(`December 31, ${y}`));
    return ys.length > 0 ? [pnl(ys)] : [];
  };
  const got = await extractFinancialDataInParts(pack, "fs", "Financial statements FY2022-FY2024.pdf", read);
  assert.ok(seen.length >= 2 && seen.every((l) => /^part \d+ of \d+$/.test(l)), seen.join(","));
  assert.equal(got.length, 1, "one income statement with every year");
  assert.deepEqual([...got[0].periods].sort(), years);
  assert.equal(got[0].lineItems.find((l) => l.label === "Revenue")!.amounts["2024"], 2_024_000);
  assert.equal(got[0].lineItems.length, 4);
  assert.match(got[0].notes.join(" "), /Read in \d+ parts\./);
  assert.equal(unreadFinancialText(pack), "");
  ok("a 3-year statement pack over 80K is read in parts; one income statement with FY2022–FY2024 (was: first 80K only)");

  // Raw vs recast, and two statements one part read, are never folded together.
  const merged = combinePartStatements([
    [pnl(["2023"]), pnl(["2023"], { notes: ["Recast / normalized P&L"] })],
    [pnl(["2024"]), pnl(["2024"], { notes: ["Recast / normalized P&L"] })],
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((s) => [...s.periods].sort().join(",")), ["2023,2024", "2023,2024"]);
  assert.equal(combinePartStatements([[pnl(["2024"]), pnl(["2024"])]]).length, 2);
  // A different statement type is its own statement.
  assert.equal(combinePartStatements([[pnl(["2024"])], [{ ...pnl(["2024"]), statementType: "balance_sheet" }]]).length, 2);
  ok("raw and recast statements stay separate; two statements from one part stay two");

  // A pack longer than the parts read: noted, and the rest is handed on as text.
  const huge = Array.from({ length: FIN_MAX_PARTS + 3 }, (_, i) => `Page ${i} of 99\n${"x".repeat(FIN_PART_CHARS - 100)}\n`).join("\f");
  let calls = 0;
  const hugeGot = await extractFinancialDataInParts(huge, "fs", "Big pack", async () => { calls++; return [pnl([String(2015 + calls)])]; });
  assert.equal(calls, FIN_MAX_PARTS);
  assert.match(hugeGot[0].notes.join(" "), /were not read as statements/);
  assert.ok(unreadFinancialText(huge).length > FIN_PART_CHARS);
  ok("past the part limit: the statements say what wasn't read, and unreadFinancialText hands the rest to the analysis");

  // ── A chronological tax pack: the 25K slice reaches the newest return ───────
  const ret = (y: string) => `T2 CORPORATION INCOME TAX RETURN — tax year ${y}\n` +
    Array.from({ length: 60 }, (_, i) => `Schedule ${i} line ${i}: GIFI ${8000 + i} net income ${y} taxable income ${y} retained earnings ${y} ${"filler ".repeat(300)}`).join("\n");
  const taxPack = ["2022", "2023", "2024"].map(ret).join("\n\n");
  assert.ok(taxPack.length > 300_000);
  const slice = sliceRelevantText(taxPack, 25_000);
  assert.ok(slice.length <= 26_000);
  for (const y of ["2022", "2023", "2024"]) assert.match(slice, new RegExp(`net income ${y}`), `slice reaches ${y}`);
  const offs = Array.from(slice.matchAll(/skipped to offset (\d+)/g)).map((m) => Number(m[1]));
  assert.ok(Math.max(...offs) > taxPack.length * 0.8, "reaches the end of the pack");
  ok("a 3-return tax pack's 25K slice holds passages from 2022, 2023 and 2024 (was: the 2022 return only)");

  // spreadWindows: one window per zone per round, newest zone first; text order out.
  const w = Array.from({ length: 40 }, (_, i) => ({ start: i * 10_000, end: i * 10_000 + 1_000 }));
  const picked = spreadWindows(w, 400_000, 4_000);
  assert.equal(picked.length, 4);
  assert.ok(picked[picked.length - 1].start >= 350_000, "the newest zone is read first");
  assert.ok(picked.every((p, i) => i === 0 || p.start > picked[i - 1].start));
  // A short text is returned whole.
  assert.equal(sliceRelevantText("short", 25_000), "short");
  ok("spreadWindows: budget spread across zones from the newest back, returned in text order");

  console.log("f2-financial-parts: all passed");
})().catch((e) => { console.error(e); process.exit(1); });
