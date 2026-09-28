// ACC2-06 / ACC2-07 (reprocess): the Ridgeline call transcript — the source
// of the $4.2M backlog — failed twice with "APIConnectionError, read
// ETIMEDOUT" (one fixed 3s retry), the job ended "done" with only
// documentsKeptAsBefore: 1, and the call's stored placeholder ("To be
// calculated by accountant Heather…") stayed the working-capital fact.
// Replayed here with the Anthropic Messages API stubbed (no model is called)
// and an in-memory store.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/a-data-reprocess-retry.test.ts
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../../server/storage";
import { classifyExtractionFailure } from "../../server/documents/extractor";
import { extractWithRetries, reprocessDealDocuments, _setReprocessRetryDelaysForTests, foldAliasedFacts } from "../../server/documents/reprocess";
import { startReprocessJob, reprocessJobFor } from "../../server/documents/reprocess-jobs";
import { reconcileHeadlines } from "../../server/documents/merge-policy";

// ── The recorded failure is transient; a refused key is not ──
{
  const etimedout = Object.assign(new Error("Connection error."), { name: "APIConnectionError", cause: Object.assign(new Error("request to https://api.anthropic.com/v1/messages failed, reason: read ETIMEDOUT"), { code: "ETIMEDOUT" }) });
  assert.deepEqual(classifyExtractionFailure(etimedout), { kind: "transient", reason: "the connection to the AI service dropped" });
  assert.equal(classifyExtractionFailure({ status: 529, message: "Overloaded" }).kind, "transient");
  assert.equal(classifyExtractionFailure({ status: 429 }).kind, "transient");
  assert.equal(classifyExtractionFailure({ status: 401, message: "invalid x-api-key" }).kind, "permanent");
  assert.equal(classifyExtractionFailure({ status: 400, message: "Your credit balance is too low" }).reason, "the AI account is out of credits");
  console.log("✓ ETIMEDOUT / overloaded / rate limit are transient; a refused key or no credits are not");
}

// ── Retries with growing waits, only for transient failures ──
{
  const stub = (kind: "transient" | "permanent") => ({ _documentType: "other", _confidence: "low", summary: "Extraction failed", _failure: kind, _failureReason: "x" } as any);
  const waits: number[] = [];
  let calls = 0;
  const ok = await extractWithRetries(async () => (++calls < 3 ? stub("transient") : { summary: "ok", backlog: "$4.2M" } as any), [5000, 20000, 60000], undefined, async (ms) => { waits.push(ms); });
  assert.equal(ok.attempts, 3);
  assert.equal(ok.data.backlog, "$4.2M");
  assert.deepEqual(waits, [5000, 20000], "5s, then 20s — a multi-minute blip is ridden out");
  calls = 0;
  const perm = await extractWithRetries(async () => { calls++; return stub("permanent"); }, [5000, 20000, 60000], undefined, async () => {});
  assert.equal(perm.attempts, 1, "a refused request is not sent again");
  const never = await extractWithRetries(async () => stub("transient"), [1, 2, 3], undefined, async () => {});
  assert.equal(never.attempts, 4, "the first try plus three");
  console.log("✓ transient failures retried with backoff (up to 4 attempts), permanent ones not");
}

// ── End to end through reprocessDealDocuments (store + SDK stubbed) ──
const CALL_TEXT = "Phone call — Morgan Ellis & Gord McAllister. Gord: the backlog is about four point two million as of end of May. Working capital — Heather will calculate it; we haven't drawn the line of credit in years.";
const WIP_TEXT = "WIP & backlog report as of May 31, 2025. Total signed backlog: $3,100,000. Open quotes are not included.";
let deal: any;
let docs: any[];
const rows: any[] = [];
function reset() {
  deal = {
    id: "D", businessName: "Ridgeline Metal Fabrication Inc.", industry: "Manufacturing", askingPrice: null, extractedInfo: {
      backlog: "$3,100,000",
      workingCapital: "To be calculated by accountant Heather. Seller notes line of credit has not been drawn in years.",
      grossMarginPercentByYear: { "2023": "30.0%", "2024": "30.0%" },
      grossMarginByYear: { "2021": "28.7%", "2022": "29.2%", "2023": "30.0%" },
      _fieldSources: {
        backlog: { source: "document", documentId: "wip", specialist: true, period: "2025-05-31" },
        workingCapital: { source: "call", documentId: "call" },
        grossMarginPercentByYear: { source: "document", documentId: "fs24", period: "2024-12-31", years: { "2023": { source: "document", documentId: "fs24", period: "2023-12-31" }, "2024": { source: "document", documentId: "fs24", period: "2024-12-31" } } },
        grossMarginByYear: { source: "document", documentId: "fs23", period: "2023-12-31" },
      },
      _fieldAlternates: { backlog: [{ value: "$4.2M as of end of May 2025", source: "call", documentId: "call" }] },
    },
  };
  docs = [
    { id: "call", dealId: "D", name: "Phone call — Morgan Ellis & Gord McAllister (discovery deep-dive)", category: "other", sourceKind: "call", visibility: "shared", extractedText: CALL_TEXT, extractedData: { backlog: "$4.2M as of end of May 2025", workingCapital: "To be calculated by accountant Heather. Seller notes line of credit has not been drawn in years." }, fileUrl: null, createdAt: new Date(1), sourceMeta: null, isProcessed: true },
    { id: "wip", dealId: "D", name: "WIP & backlog report as of May 31, 2025 (+ open quotes)", category: "financial", sourceKind: "document", visibility: "shared", extractedText: WIP_TEXT, extractedData: { backlog: "$3,100,000" }, fileUrl: null, createdAt: new Date(2), sourceMeta: null, isProcessed: true },
  ];
  rows.length = 0;
}
const s = storage as any;
s.getDeal = async () => JSON.parse(JSON.stringify(deal));
s.updateDeal = async (_id: string, patch: any) => { deal = { ...deal, ...JSON.parse(JSON.stringify(patch)) }; return deal; };
s.getDocumentsByDeal = async () => docs.map((d) => ({ ...d }));
s.getDocument = async (id: string) => docs.find((d) => d.id === id);
s.updateDocument = async (id: string, patch: any) => { Object.assign(docs.find((d) => d.id === id), patch); return docs.find((d) => d.id === id); };
s.getDiscrepanciesByDeal = async () => rows.map((r) => ({ ...r }));
s.createDiscrepancy = async (data: any) => { const r = { id: `r${rows.length + 1}`, createdAt: new Date(), resolvedValue: null, ...data }; rows.push(r); return r; };
s.updateDiscrepancy = async (id: string, u: any) => Object.assign(rows.find((r) => r.id === id), u);

let callFailures = 0;
const extractCalls: string[] = [];
(Anthropic as any).Messages.prototype.create = async function (params: any) {
  const tool = params.tool_choice?.name;
  const content = JSON.stringify(params.messages ?? "");
  if (tool === "record_extraction") {
    const which = content.includes("four point two million") ? "call" : "wip";
    extractCalls.push(which);
    if (which === "call" && callFailures-- > 0) {
      throw Object.assign(new Error("Connection error."), { name: "APIConnectionError", cause: Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }) });
    }
    const input = which === "call" ? { summary: "Discovery call.", backlog: "$4.2M as of end of May 2025" } : { summary: "WIP report.", backlog: "$3,100,000" };
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: tool, input }] };
  }
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: tool, input: { groups: [], notNotes: [] } }] };
};
// Extraction is streamed (f-facts known-5): the stream's final message is the stubbed create's.
(Anthropic as any).Messages.prototype.stream = function (params: any) {
  const p = (Anthropic as any).Messages.prototype.create.call(this, params);
  return { finalMessage: () => p };
};
_setReprocessRetryDelaysForTests([1, 1, 1]);

// 1. The call fails twice, then reads: nothing kept as before, nothing failed.
{
  reset();
  callFailures = 2;
  extractCalls.length = 0;
  const r = await reprocessDealDocuments("D");
  assert.equal(r.failedSources.length, 0);
  assert.equal(r.documentsKeptAsBefore, 0);
  assert.equal(extractCalls.filter((c) => c === "call").length, 3, "read on the third attempt");
  console.log("✓ two ETIMEDOUTs, then a fresh read: the call is re-read");
}

// 2. The call keeps failing: named in the result, the job says "partial", the row says so, the placeholder goes.
{
  reset();
  callFailures = 99;
  extractCalls.length = 0;
  const { job } = startReprocessJob("D");
  for (let i = 0; i < 200 && reprocessJobFor("D")?.status === "running"; i++) await new Promise((r) => setTimeout(r, 5));
  const done = reprocessJobFor("D")!;
  assert.equal(done.status, "partial", "never 'done' when a source couldn't be read");
  assert.match(done.message ?? "", /couldn't re-read "Phone call — Morgan Ellis & Gord McAllister \(discovery deep-dive\)" \(the connection to the AI service dropped\)/);
  assert.deepEqual(done.result!.failedSources.map((f) => [f.documentId, f.attempts]), [["call", 4]]);
  assert.ok(docs[0].sourceMeta?.rereadFailed?.reason, "the source's row says its re-read failed");
  assert.equal(docs[1].sourceMeta?.rereadFailed, undefined);
  assert.equal(deal.extractedInfo.workingCapital, undefined, "the stored placeholder is not kept as the working-capital fact");
  assert.equal(deal.extractedInfo.backlog, "$3,100,000");
  assert.ok(job);
  console.log("✓ a source that keeps failing is named (status partial + message), flagged on its row, and its placeholder dropped");
}

// 3. Read just that source again: only it is re-read; the flag clears.
{
  callFailures = 0;
  extractCalls.length = 0;
  const { started } = startReprocessJob("D", undefined, undefined, { onlyDocumentIds: ["call"] });
  assert.ok(started);
  for (let i = 0; i < 200 && reprocessJobFor("D")?.status === "running"; i++) await new Promise((r) => setTimeout(r, 5));
  const done = reprocessJobFor("D")!;
  assert.equal(done.status, "done");
  assert.deepEqual(done.onlyDocumentIds, ["call"]);
  assert.deepEqual(extractCalls, ["call"], "the WIP report is not read again");
  assert.equal(done.result!.documentsSkipped, 1);
  assert.equal(docs[0].sourceMeta?.rereadFailed, undefined, "the flag clears on a fresh read");
  assert.equal(deal.extractedInfo.backlog, "$3,100,000", "the WIP report's facts stay");
  console.log("✓ 'Read it again' re-reads one source; the others keep what they had");
}

// 4. ACC2-07: facts under older spellings join their canonical fact.
{
  reset();
  const info = JSON.parse(JSON.stringify(deal.extractedInfo));
  info.earningsBeforeInterestAmortizationAndIncomeTaxesByYear = { "2022": "$1,038,000", "2023": "$1,282,000", "2024": "$1,398,000" };
  info._fieldSources.earningsBeforeInterestAmortizationAndIncomeTaxesByYear = { source: "document", documentId: "fs24", period: "2024-12-31" };
  info.ebitdaByYear = { "2024": "$1,398,000" };
  info._fieldSources.ebitdaByYear = { source: "call", documentId: "call", period: "2024-12-31" };
  info.retainedEarningsEndByYear = { "2024": "$2,410,000" };
  info.retainedEarningsEndingByYear = { "2023": "$1,573,590" };
  info.retainedEarningsBeginningByYear = { "2024": "$1,573,590" };
  info.dividends = "$40,000 declared and paid on Class D shares in both 2022 and 2021";
  info._fieldSources.dividends = { source: "document", documentId: "fs22", period: "2022-12-31" };
  info.dividendsPaid = "$60,000";
  info._fieldSources.dividendsPaid = { source: "document", documentId: "fs24", period: "2024-12-31" };
  const folded = foldAliasedFacts(info);
  assert.deepEqual(folded.sort(), ["dividends", "earningsBeforeInterestAmortizationAndIncomeTaxesByYear", "grossMarginPercentByYear", "retainedEarningsEndByYear", "retainedEarningsEndingByYear"]);
  assert.deepEqual(Object.keys(info.grossMarginByYear).sort(), ["2021", "2022", "2023", "2024"]);
  assert.deepEqual(Object.keys(info.ebitdaByYear).sort(), ["2022", "2023", "2024"], "the statements' EBITDA line is the EBITDA map");
  assert.equal(info._fieldSources.ebitdaByYear.years?.["2022"]?.documentId, "fs24");
  assert.deepEqual(info.retainedEarningsByYear, { "2023": "$1,573,590", "2024": "$2,410,000" });
  assert.ok(info.retainedEarningsBeginningByYear, "opening retained earnings is another measure: kept apart");
  assert.equal(info.dividendsPaid, "$60,000", "the FY2024 figure stays; the FY2022 line is another period's");
  assert.ok((info._fieldAlternates.dividendsPaid ?? []).some((a: any) => /\$40,000/.test(a.value)));
  for (const k of folded) assert.equal(info[k], undefined);
  assert.deepEqual(foldAliasedFacts(info), [], "idempotent");
  console.log("✓ grossMarginPercentByYear, the statements' EBITDA line, retained-earnings variants and dividends fold into canonical facts");
}

// 5. …and the EBITDA headline then follows the statements: the right figure, credited to them, no "after adjustments" label.
{
  const info: any = {
    ebitda: "$1,398,000 (2024, after adjustments per compiled statements)",
    ebitdaByYear: { "2024": "$1,398,000" },
    earningsBeforeInterestAmortizationAndIncomeTaxesByYear: { "2022": "$1,038,000", "2023": "$1,282,000", "2024": "$1,398,000" },
    _fieldSources: {
      ebitda: { source: "call", documentId: "call", period: "2024-12-31", note: "Stated in the source (not calculated)" },
      ebitdaByYear: { source: "call", documentId: "call", period: "2024-12-31", years: { "2024": { source: "call", documentId: "call", period: "2024-12-31" } } },
      earningsBeforeInterestAmortizationAndIncomeTaxesByYear: { source: "document", documentId: "fs24", period: "2024-12-31", specialist: true, years: {
        "2022": { source: "document", documentId: "fs22", period: "2022-12-31", specialist: true },
        "2023": { source: "document", documentId: "fs23", period: "2023-12-31", specialist: true },
        "2024": { source: "document", documentId: "fs24", period: "2024-12-31", specialist: true } } },
    },
  };
  const conflicts: any[] = [];
  foldAliasedFacts(info);
  reconcileHeadlines(info, { conflicts });
  assert.equal(info.ebitda, "$1,398,000");
  assert.equal(info._fieldSources.ebitda.documentId, "fs24", "credited to the FY2024 statements");
  assert.ok(info._fieldAlternates.ebitda.some((a: any) => /after adjustments/.test(a.value)), "the call's mislabelled words are kept as another value");
  assert.equal(conflicts.length, 0, "the same figure: no dispute");
  console.log("✓ the reported EBITDA headline comes from the statements' line, without the 'after adjustments' label");
}

_setReprocessRetryDelaysForTests(null);
console.log("a-data-reprocess-retry: all passed");
