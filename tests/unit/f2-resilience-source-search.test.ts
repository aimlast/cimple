/**
 * R6 — one very large source (a general-ledger export) must not block the
 * event loop for seconds on the first interview search after a restart, nor
 * pin hundreds of MB in an entry-count-bounded cache.
 *   - only the first CHUNKED_CHARS_PER_SOURCE of a source is chunked and
 *     cached; the rest is searched by keyword windows for the question;
 *   - the cache is bounded by total source text (least recently used first).
 * No database, no AI.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-resilience-source-search.test.ts
 */
import assert from "node:assert/strict";
import {
  searchSourcesFor,
  _chunkCacheStats,
  CHUNKED_CHARS_PER_SOURCE,
  CHUNK_CACHE_CHARS,
} from "../../server/interview/source-context";

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

const accts = ["Office Supplies", "Fuel", "Repairs & Maintenance", "Wages Payable", "Accounts Receivable", "Sales Revenue", "Rent", "Insurance"];
function glText(rows: number, deepNote?: string): string {
  const lines = ["--- Sheet: GL Detail ---", "Date,Entry,Account,Memo,Debit,Credit,Balance"];
  for (let i = 0; i < rows; i++) {
    lines.push(`2023-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")},JE ${10000 + i},${accts[i % accts.length]},Invoice ${i} Vendor ${i % 300},${(i * 7.13 % 5000).toFixed(2)},,${(i * 13.7).toFixed(2)}`);
    if (deepNote && i === Math.floor(rows * 0.8)) lines.push(deepNote);
  }
  return lines.join("\n");
}
const doc = (id: string, text: string) => ({ id, name: `${id}.xlsx`, extractedText: text, extractedData: {}, sourceKind: "document", visibility: "shared", category: "financials", isProcessed: true, updatedAt: "x" } as any);

// A 150,000-row GL: the first search is quick and the cache stays small.
{
  const text = glText(150_000, "Note: the Petro-Canada fleet card program gives a rebate of 4 cents per litre on diesel.");
  assert.ok(text.length > 10_000_000);
  const t0 = Date.now();
  const hit = searchSourcesFor("Which fleet card program do you use for diesel?", [doc("gl", text)]);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `first search took ${ms} ms (was 7–10 s)`);
  assert.ok(_chunkCacheStats().chars <= CHUNKED_CHARS_PER_SOURCE, "only the head of the source is cached");
  // …and a passage deep in the file (past the chunked head) is still found.
  assert.ok(hit && /Petro-Canada fleet card/.test(hit.snippet), JSON.stringify(hit));
  ok(`a GL export's first search: ${ms} ms, ${Math.round(_chunkCacheStats().chars / 1000)}K chars cached, deep passages still found`);
}

// The cache is bounded by total text: many large sources never grow it past the budget.
{
  const docs = Array.from({ length: 20 }, (_, i) => doc(`big${i}`, glText(4_000 + i)));
  for (const d of docs) searchSourcesFor("What do you spend on insurance each year?", [d]);
  const stats = _chunkCacheStats();
  assert.ok(stats.chars <= CHUNK_CACHE_CHARS + CHUNKED_CHARS_PER_SOURCE, JSON.stringify(stats));
  assert.ok(stats.entries < 21, "older entries were evicted");
  ok(`the passage cache stays within its text budget (${stats.entries} sources, ${Math.round(stats.chars / 1000)}K chars)`);
}

// Ordinary sources behave as before.
{
  const small = doc("call", "The fleet is 42 tractors and 60 trailers. We lease the yard on Mitchell Road until 2031.");
  const hit = searchSourcesFor("How many tractors are in the fleet?", [small]);
  assert.ok(hit && /42 tractors/.test(hit.snippet));
  ok("small sources are searched as before");
}

console.log(`f2-resilience-source-search: ${passed} passed`);
process.exit(0);
