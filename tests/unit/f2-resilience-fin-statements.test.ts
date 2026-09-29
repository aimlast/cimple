/**
 * R8 — financial analysis must not burst every statement read at once, nor
 * silently drop a statement a 429/529 hit and still report a clean run.
 *   - at most STATEMENT_READS_AT_ONCE statement reads in flight;
 *   - transient failures are retried with back-off;
 *   - a statement still unreadable is recorded (unread) — the analysis's
 *     notes name it and its source status tells the broker to re-run.
 * No database, no AI (stubbed extractor).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-resilience-fin-statements.test.ts
 */
import assert from "node:assert/strict";
import {
  _setStatementExtractorForTests,
  isTransientAiError,
  readStatementDocs,
  STATEMENT_READS_AT_ONCE,
  withUnreadNote,
} from "../../server/financial/analyzer";
import { analysisSourceStatus } from "../../server/financial/source-status";

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const origWarn = console.warn;
const origErr = console.error;
console.warn = () => {};
console.error = () => {};

const docs = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, name: `${2015 + i} Financial Statements.pdf`, extractedText: "Revenue 1,000,000 ..." }));
const stmt = (id: string) => [{ statementType: "income_statement", periods: ["2024"], lineItems: [{ label: "Revenue", amounts: { "2024": 1 } }], currency: "CAD", sourceDocumentId: id, confidence: 1, notes: [] }] as any;

// Ten statement packs: never more than the limit in flight; a 529 then success is retried.
{
  let inFlight = 0;
  let peak = 0;
  const tries = new Map<string, number>();
  _setStatementExtractorForTests(async (_t, id) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    const n = (tries.get(id) ?? 0) + 1;
    tries.set(id, n);
    if ((id === "s3" || id === "s7") && n === 1) { const e: any = new Error("overloaded_error"); e.status = 529; throw e; }
    return stmt(id);
  }, [1, 1]);
  const r = await readStatementDocs(docs);
  assert.ok(peak <= STATEMENT_READS_AT_ONCE, `peak ${peak}`);
  assert.equal(r.unread.length, 0);
  assert.equal(r.statementArrays.flat().length, 10, "every statement read, the retried ones included");
  assert.deepEqual(r.statementArrays.map((a) => a[0].sourceDocumentId), docs.map((d) => d.id), "order kept");
  assert.equal(tries.get("s3"), 2);
  ok(`statement reads are limited to ${STATEMENT_READS_AT_ONCE} at once and a 529 is retried`);
}

// Still failing after the retries: recorded, named in the notes, flagged in the source status.
{
  _setStatementExtractorForTests(async (_t, id) => {
    if (id === "s2") { const e: any = new Error("rate_limit_error"); e.status = 429; throw e; }
    return stmt(id);
  }, [1, 1]);
  const r = await readStatementDocs(docs.slice(0, 4));
  assert.deepEqual(r.unread.map((u) => u.id), ["s2"]);
  assert.match(r.unread[0].reason, /rate limit/);
  const refs = docs.slice(0, 4).map((d) => ({ id: d.id, name: d.name, role: "statements" as const, ...(d.id === "s2" ? { unread: r.unread[0].reason } : {}) }));
  const note = withUnreadNote("Used the 2024 statements.", refs);
  assert.match(note, /^Couldn't read “2017 Financial Statements\.pdf” \(the AI service's rate limit was reached\).*Re-run the analysis/);
  assert.match(note, /Used the 2024 statements\.$/);
  const status = analysisSourceStatus({ sourceDocumentIds: refs }, docs.slice(0, 4).map((d) => ({ ...d, category: "financials", isProcessed: true })));
  assert.deepEqual(status.unread.map((u) => u.id), ["s2"]);
  assert.equal(status.blocking, false, "a warning, not a block (its raw text still reached the analysis)");
  assert.match(status.message!, /couldn't read a statement .*2017 Financial Statements\.pdf.*Re-run it/);
  // A non-transient error is not retried.
  let calls = 0;
  _setStatementExtractorForTests(async () => { calls++; const e: any = new Error("invalid_request_error"); e.status = 400; throw e; }, [1, 1]);
  const r2 = await readStatementDocs(docs.slice(0, 1));
  assert.equal(calls, 1);
  assert.equal(r2.unread.length, 1);
  ok("a statement that stays unreadable is named in the analysis notes and flags the analysis for a re-run");
}

// Unchanged when nothing failed.
{
  assert.equal(withUnreadNote("x", [{ id: "a", role: "statements" }]), "x");
  assert.equal(analysisSourceStatus({ sourceDocumentIds: [{ id: "a", name: "A", role: "statements" }] }, [{ id: "a", name: "A", category: "financials" }]).message, null);
  assert.ok(isTransientAiError({ status: 529 }) && isTransientAiError({ status: 429 }) && isTransientAiError({ name: "APIConnectionTimeoutError" }));
  assert.ok(!isTransientAiError({ status: 400 }));
  ok("clean runs and statuses are unchanged");
}

console.warn = origWarn;
console.error = origErr;
_setStatementExtractorForTests(null);
console.log(`f2-resilience-fin-statements: ${passed} passed`);
process.exit(0);
