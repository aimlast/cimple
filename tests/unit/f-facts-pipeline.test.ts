// FREE round, stream "facts" (f-facts): the source pipeline — reading,
// deleting, editing and sharing sources — proved offline with the model
// stubbed (no Anthropic call is made) and an in-memory store.
//  known-5        extraction is streamed; reprocess progress moves per source
//  known-6        a single-source re-read asks the notes review only about that source
//  F-TRUNC        long sources are read in parts and combined; a part-read is recorded
//  F-UNREADABLE   scanned / too-short / .doc sources fail with a reason and release the checklist row
//  F-NO-RETRY     a first read retries transient failures; a failure says why; interrupted reads are detected
//  F-DEL-RACE     a source deleted while it is read never gets its facts merged (ingest and reprocess)
//  F-DEL-PROMOTE  deleting a source refills by the merge's authority, year by year, and raises the conflict
//  F-DEL-CHECKLIST deleting a source releases its checklist row
//  F-MAPEDIT-PRIVACY editing one year of a by-year fact keeps the other years' sources (a CRM year stays private)
//  F-VIS-SHARED   switching a source to shared reaches the interview's seller view at once
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f-facts-pipeline.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storage } from "../../server/storage";
import {
  combineExtractions,
  extractDocumentData,
  extractWithRetries,
  mergeExtractedData,
  splitSourceText,
  MAX_SOURCE_CHARS,
  MAX_SOURCE_PARTS,
  _setExtractionClientForTests,
  _setExtractionRetryDelaysForTests,
  type ExtractionClient,
} from "../../server/documents/extractor";
import { ingestDocument, isInterruptedRead, sourceMetaAfterRead, STUCK_READ_MS } from "../../server/documents/ingest";
import { reprocessDealDocuments } from "../../server/documents/reprocess";
import { removeSourceFacts } from "../../server/documents/cleanup";
import { removeSourceFromFacts } from "../../server/documents/source-removal";
import { stampNoteSources } from "../../server/documents/source-visibility";
import { wordingsInScope } from "../../server/documents/private-notes-review";
import { stampSourceDetails, type MergeConflict } from "../../server/documents/merge-policy";
import { editFact, setBrokerMapEntry } from "../../server/information/facts";
import { splitFactsForCim } from "../../server/information/cim-facts";
import { sellerInterviewView } from "../../server/interview/seller-view";
import { getFieldAlternates, getFieldSources, removeDocumentFields, resolvedYearSources } from "../../server/interview/info-merger";
import { unsupportedFormatReason } from "../../server/documents/parser";

const ok = (msg: string) => console.log(`✓ ${msg}`);
_setExtractionRetryDelaysForTests([1, 1, 1]);

// ── A stand-in for the Anthropic client: only `stream` exists (a non-streamed create would throw) ──
type Reply = Record<string, unknown> | Error;
let replies: Array<(prompt: string) => Reply> = [];
const prompts: string[] = [];
const fakeClient: ExtractionClient = {
  messages: {
    stream(body) {
      const prompt = String((body.messages[0] as { content: string }).content);
      prompts.push(prompt);
      const next = replies.length > 1 ? replies.shift()! : replies[0];
      const r = next(prompt);
      return {
        finalMessage: async () => {
          if (r instanceof Error) throw r;
          return { stop_reason: "tool_use", content: [{ type: "tool_use", input: r }] };
        },
      };
    },
  },
};
_setExtractionClientForTests(fakeClient);
const overloaded = () => Object.assign(new Error("Overloaded"), { status: 529 });
const refused = () => Object.assign(new Error("invalid x-api-key"), { status: 401 });

// ── known-5: streamed extraction ───────────────────────────────────────────────
{
  replies = [() => ({ summary: "Lease.", leaseExpiry: "December 31, 2026" })];
  prompts.length = 0;
  const r = await extractDocumentData("Industrial lease between Holdco and Opco. Term ends December 31, 2026. Rent $28,000 monthly.", "legal");
  assert.equal(r.leaseExpiry, "December 31, 2026");
  assert.equal(prompts.length, 1, "one streamed read (the stand-in has no create at all)");
  ok("known-5: extraction runs as a streamed request (a long read keeps its connection alive)");
}

// ── F-TRUNC: long sources in parts ─────────────────────────────────────────────
{
  // Three years of returns, ~70K characters each (well past one read).
  const filler = (y: number) => Array.from({ length: 1400 }, (_, i) => `Schedule line ${i} for tax year ${y}: nothing to report here.`).join("\n");
  const ret = (y: number, rev: string) => `T2 CORPORATION INCOME TAX RETURN\nTax year ending December 31, ${y}\nTotal revenue ${rev}\n${filler(y)}\nPage 1 of 1\n\n`;
  const text = ret(2022, "$1,610,000") + ret(2023, "$1,702,000") + ret(2024, "$1,845,000");
  assert.ok(text.length > 3 * MAX_SOURCE_CHARS);
  const parts = splitSourceText(text);
  assert.ok(parts.length >= 4 && parts.length <= MAX_SOURCE_PARTS, `${parts.length} parts`);
  assert.ok(parts.every((p) => p.length <= MAX_SOURCE_CHARS));
  // Every character is in some part (parts overlap, nothing is skipped).
  let covered = 0;
  for (const p of parts) { const at = text.indexOf(p, Math.max(0, covered - 5000)); assert.ok(at >= 0 && at <= covered, "no gap between parts"); covered = at + p.length; }
  assert.equal(covered, text.length);
  // Each part's reader sees only its part; the stub answers with the year that part is about.
  replies = [(prompt) => {
    const years = Array.from(prompt.matchAll(/Tax year ending December 31, (\d{4})\nTotal revenue (\$[\d,]+)/g));
    const byYear: Record<string, string> = {};
    for (const m of years) byYear[m[1]] = m[2];
    const latest = Object.keys(byYear).sort().pop();
    return latest ? { summary: `Return for ${latest}.`, revenue: byYear[latest], byYear: { revenue: byYear }, periodEnd: `${latest}-12-31` } : { summary: "Schedules only." };
  }];
  prompts.length = 0;
  const r = await extractDocumentData(text, "financial", null, "document");
  assert.equal(prompts.length, parts.length, "every part read");
  assert.ok(prompts.every((p) => /THIS IS PART \d+ OF \d+/.test(p)));
  assert.deepEqual(r.revenueByYear, { "2022": "$1,610,000", "2023": "$1,702,000", "2024": "$1,845,000" }, "all three years read (the 2023 and 2024 returns were cut off before)");
  assert.equal(r.revenue, "$1,845,000", "the headline is the newest year's");
  assert.equal(r._periodEnd, "2024-12-31");
  assert.equal(r._partialRead, undefined, "read in full");
  assert.match(String(r.summary), /Return for 2022\..*Return for 2024\./);

  // A part that stays down (an outage) → the rest is kept, and the source says it was read in part.
  let calls = 0;
  replies = [(prompt) => { calls++; return /Tax year ending December 31, 2022/.test(prompt) ? overloaded() : { summary: "part", ...( /Total revenue \$1,845,000/.test(prompt) ? { revenue: "$1,845,000", periodEnd: "2024-12-31" } : {}) }; }];
  const partial = await extractDocumentData(text, "financial", null, "document");
  const pr = partial._partialRead as any;
  assert.ok(pr, "recorded as read in part");
  assert.equal(pr.parts, parts.length);
  assert.equal(pr.readParts, parts.length - 1);
  assert.equal(pr.retryable, true);
  assert.match(pr.reason, /1 of its \d+ parts couldn't be read \(the AI service was overloaded\)/);
  assert.equal(partial.revenue, "$1,845,000");
  assert.ok(calls >= parts.length + 3, "the failing part was tried again (and only it)");
  // The row says so; a later full read clears it.
  const meta = sourceMetaAfterRead({ sourceMeta: { periodEnd: "2023-12-31" } } as any, partial, false, "2026-09-26T00:00:00Z");
  assert.equal(meta?.partialRead?.readParts, parts.length - 1);
  assert.equal(meta?.periodEnd, "2024-12-31");
  assert.equal(sourceMetaAfterRead({ sourceMeta: meta } as any, r, false)?.partialRead, undefined);
  // Longer than Cimple reads at all: the rest is named as not read.
  const huge = "x".repeat(MAX_SOURCE_CHARS * (MAX_SOURCE_PARTS + 2));
  replies = [() => ({ summary: "part" })];
  const capped = await extractDocumentData(huge, "other");
  assert.match(String((capped._partialRead as any)?.reason), new RegExp(`only the first ${MAX_SOURCE_PARTS} of \\d+ parts are read`));
  // Every part down → one failure, not retried again as a whole.
  replies = [() => overloaded()];
  let outer = 0;
  const down = await extractWithRetries(async () => { outer++; return extractDocumentData(text, "financial"); }, [1, 1, 1]);
  assert.equal(down.data.summary, "Extraction failed");
  assert.equal(outer, 1, "the parts were each retried already");
  // combineExtractions on its own: newest period wins a figure, prose joins, notes union.
  const c = combineExtractions([
    { revenue: "$1,700,000", _periodEnd: "2023-12-31", summary: "2023 return.", _privateNotes: "Owner's divorce" } as any,
    { revenue: "$1,845,000", _periodEnd: "2024-12-31", summary: "2024 return.", _privateNotes: "Owner's divorce\nFloor is $4M" } as any,
    { revenue: "$1,610,000", _periodEnd: "2022-12-31", summary: "2022 return." } as any,
  ]);
  assert.equal(c.revenue, "$1,845,000");
  assert.equal(c.summary, "2022 return. 2023 return. 2024 return.");
  assert.equal(c._privateNotes, "Owner's divorce\nFloor is $4M");
  ok(`F-TRUNC: a ${Math.round(text.length / 1000)}K-character source is read in ${parts.length} parts and combined (every year kept, newest headline); a part that stays down or a source past ${MAX_SOURCE_PARTS} parts is recorded as read in part`);
}

// ── F-UNREADABLE: nothing to read ───────────────────────────────────────────────
{
  prompts.length = 0;
  const scanned = await extractDocumentData("25 King William\n\f", "legal", null, "document");
  assert.equal(scanned.summary, "Extraction failed");
  assert.equal(scanned._failure, "unreadable");
  assert.match(String(scanned._failureReason), /scanned image or photo/);
  assert.equal(prompts.length, 0, "no model call for 18 characters");
  const retried = await extractWithRetries(async () => scanned, [1, 1]);
  assert.equal(retried.attempts, 1, "never retried");
  assert.match(String(unsupportedFormatReason("Lease.doc")), /\.docx/);
  assert.match(String(unsupportedFormatReason("Deck.PPT")), /\.pptx/);
  assert.equal(unsupportedFormatReason("Lease.docx"), null);
  ok("F-UNREADABLE: a scanned / near-empty source fails with a plain reason (no model call, no retry); .doc and .ppt are named with what to do");
}

// ── In-memory store for the pipeline ────────────────────────────────────────────
let deal: any;
let docs: any[];
let reqs: any[];
let rows: any[];
const s = storage as any;
s.getDeal = async () => (deal ? JSON.parse(JSON.stringify(deal)) : undefined);
s.updateDeal = async (_id: string, patch: any) => { deal = { ...deal, ...JSON.parse(JSON.stringify(patch)) }; return deal; };
s.getDocumentsByDeal = async () => docs.map((d) => ({ ...d }));
s.getDocument = async (id: string) => { const d = docs.find((x) => x.id === id); return d ? { ...d } : undefined; };
s.updateDocument = async (id: string, patch: any) => { const d = docs.find((x) => x.id === id); if (!d) return undefined; Object.assign(d, JSON.parse(JSON.stringify(patch)), { updatedAt: new Date() }); return { ...d }; };
s.deleteDocument = async (id: string) => { docs = docs.filter((d) => d.id !== id); };
s.getDiscrepanciesByDeal = async () => rows.map((r) => ({ ...r }));
s.createDiscrepancy = async (data: any) => { const r = { id: `r${rows.length + 1}`, createdAt: new Date(), resolvedValue: null, status: "open", ...data }; rows.push(r); return r; };
s.updateDiscrepancy = async (id: string, u: any) => Object.assign(rows.find((r) => r.id === id), u);
s.getDocumentRequirementsByDeal = async () => reqs.map((r) => ({ ...r }));
s.updateDocumentRequirement = async (id: string, u: any) => Object.assign(reqs.find((r) => r.id === id), u);
const doc = (id: string, over: any = {}) => ({ id, dealId: "D", name: id, category: "financial", subcategory: null, sourceKind: "document", visibility: "shared", extractedText: null, extractedData: null, fileUrl: null, mimeType: null, status: "pending", sourceMeta: null, isProcessed: false, uploadedBy: "seller", createdAt: new Date(1), updatedAt: new Date(), ...over });
const reset = () => {
  deal = { id: "D", businessName: "Harbourline Dental", industry: "Dental", askingPrice: null, extractedInfo: {} };
  docs = [];
  reqs = [{ id: "q1", dealId: "D", documentName: "Lease agreement", category: "legal", status: "uploaded", uploadedFileId: "lease", uploadedBy: "seller", uploadedAt: new Date() }];
  rows = [];
};

// ── F-UNREADABLE / F-NO-RETRY through ingestDocument ────────────────────────────
{
  reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f-facts-"));
  process.env.UPLOADS_DIR = dir;
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "docs", "lease.doc"), "binary word 97 file");
  docs = [doc("lease", { fileUrl: "/uploads/docs/lease.doc", category: "legal" })];
  const res = await ingestDocument("lease");
  assert.equal(res.status, "failed");
  assert.equal(docs[0].status, "failed");
  assert.match(docs[0].sourceMeta.readFailed.reason, /can't read old Word \(\.doc\) files — save it as \.docx/);
  assert.equal(docs[0].sourceMeta.readFailed.retryable, undefined);
  assert.deepEqual([reqs[0].status, reqs[0].uploadedFileId], ["missing", null], "the checklist row is missing again — the seller is asked for a readable copy");

  // A scanned PDF's stored text (18 characters): the same.
  reset();
  docs = [doc("lease", { extractedText: "25 King William  ", category: "legal" })];
  await ingestDocument("lease");
  assert.match(docs[0].sourceMeta.readFailed.reason, /scanned image/);
  assert.equal(reqs[0].status, "missing");

  // An overload on the first read: tried again, then read — nothing flagged.
  reset();
  docs = [doc("stmts", { extractedText: "Compiled financial statements FY2024. Revenue 9,815,000. Net income 896,410. Prepared by Kwan & Brodeur LLP." })];
  let tries = 0;
  replies = [() => (++tries < 3 ? overloaded() : { summary: "FY2024 statements.", revenue: "$9,815,000", periodEnd: "2024-12-31" })];
  const ok1 = await ingestDocument("stmts");
  assert.equal(ok1.status, "extracted");
  assert.equal(tries, 3, "two overloads ridden out");
  assert.equal(deal.extractedInfo.annualRevenue, "$9,815,000");
  assert.equal(docs[0].sourceMeta?.readFailed, undefined);

  // A refused key: not retried, the row says why and that reading it again may not help.
  reset();
  docs = [doc("stmts", { extractedText: "Compiled financial statements FY2024. Revenue 9,815,000. Net income 896,410. Prepared by Kwan & Brodeur LLP." })];
  tries = 0;
  replies = [() => { tries++; return refused(); }];
  await ingestDocument("stmts");
  assert.equal(tries, 1);
  assert.equal(docs[0].status, "failed");
  assert.equal(docs[0].sourceMeta.readFailed.reason, "the AI service refused the key");
  assert.equal(reqs[0].status, "uploaded", "an outage is not the file's fault — the checklist row stays");

  // A row left "parsing" by a restart is recognised as interrupted; a live or fresh one is not.
  const now = Date.now();
  assert.ok(isInterruptedRead({ id: "a", status: "parsing", updatedAt: new Date(now - STUCK_READ_MS - 1000) } as any, now, new Set()));
  assert.ok(!isInterruptedRead({ id: "a", status: "parsing", updatedAt: new Date(now - STUCK_READ_MS - 1000) } as any, now, new Set(["a"])));
  assert.ok(!isInterruptedRead({ id: "a", status: "parsing", updatedAt: new Date(now - 60_000) } as any, now, new Set()));
  assert.ok(!isInterruptedRead({ id: "a", status: "extracted", updatedAt: new Date(0) } as any, now, new Set()));
  ok("F-UNREADABLE + F-NO-RETRY: .doc / scanned sources fail with a reason and release the checklist row; a first read rides out overloads; a refused read says why; a read stuck by a restart is recognised");
}

// ── F-DEL-RACE: deleted while being read ────────────────────────────────────────
{
  reset();
  docs = [doc("wrong", { extractedText: "Email from Gord: revenue last year was about $2.3M and we have 41 staff. Signed, Gord." , sourceKind: "email" })];
  replies = [() => {
    // The broker deletes it while the model is reading.
    docs = [];
    return { summary: "Email.", revenue: "$2,300,000", employees: "41" };
  }];
  const r = await ingestDocument("wrong");
  assert.equal(r.status, "missing");
  assert.deepEqual(deal.extractedInfo, {}, "nothing from the deleted source landed");

  // Reprocess: a source deleted while the job reads the others.
  reset();
  deal.extractedInfo = mergeExtractedData({}, { backlog: "$3,100,000" } as any, { documentId: "wip", source: "document", title: "WIP report" });
  docs = [
    doc("wip", { extractedText: "WIP & backlog report as of May 31, 2025. Total signed backlog: $3,100,000.", status: "extracted", extractedData: { backlog: "$3,100,000" } }),
    doc("dup", { extractedText: "Duplicate P&L uploaded by mistake. Revenue 2024: $4,000,000. Staff: 55 people.", status: "extracted", extractedData: {}, createdAt: new Date(2) }),
  ];
  replies = [(prompt) => {
    if (/Duplicate P&L/.test(prompt)) { docs = docs.filter((d) => d.id !== "dup"); return { summary: "P&L.", revenue: "$4,000,000", employees: "55" }; }
    return { summary: "WIP.", backlog: "$3,100,000" };
  }];
  const progress: number[] = [];
  await reprocessDealDocuments("D", (p) => { if (p.phase === "reading") progress.push(p.done); });
  assert.equal(deal.extractedInfo.annualRevenue, undefined, "the deleted source's revenue is not written back");
  assert.equal(deal.extractedInfo.employees, undefined);
  assert.equal(deal.extractedInfo.backlog, "$3,100,000");
  assert.ok(!JSON.stringify(deal.extractedInfo).includes('"dup"'), "no trace of the deleted source");
  assert.deepEqual(progress, [0, 1, 2], "progress moves as each source finishes");
  ok("F-DEL-RACE: a source deleted mid-read never has its facts merged — by ingestion or by a running reprocess (known-5: progress per source)");
}

// ── F-DEL-PROMOTE: deleting a draft P&L ─────────────────────────────────────────
{
  let info: Record<string, unknown> = {};
  const conflicts: MergeConflict[] = [];
  info = mergeExtractedData(info, { revenue: "$2,300,000" } as any, { documentId: "call", source: "call", dated: "2025-03-01" });
  info = mergeExtractedData(info, { revenue: "$1,820,000", revenueByYear: { "2023": "$1,700,000", "2024": "$1,820,000" }, _periodEnd: "2024-12-31" } as any, { documentId: "draft", source: "document", title: "Draft financial statements FY2024", dated: "2025-02-10" });
  info = mergeExtractedData(info, { revenue: "$1,835,000", revenueByYear: { "2023": "$1,700,000", "2024": "$1,835,000" }, _periodEnd: "2024-12-31" } as any, { documentId: "final", source: "document", title: "Final financial statements FY2024", dated: "2025-01-15" });
  assert.equal(info.annualRevenue, "$1,820,000", "setup: the draft is on file");
  // What the old promotion did: the call's figure by raw rank, and 2024 gone.
  const old = removeDocumentFields(info, "draft").info;
  assert.equal(old.annualRevenue, "$2,300,000", "(before: the call's figure stepped in)");
  assert.deepEqual(old.revenueByYear, { "2023": "$1,700,000" }, "(before: FY2024 fell off the map)");
  // Now.
  const after = removeSourceFromFacts(info, "draft", { conflicts });
  assert.equal(after.info.annualRevenue, "$1,835,000", "the final statements' figure steps in (decision A)");
  assert.deepEqual(after.info.revenueByYear, { "2023": "$1,700,000", "2024": "$1,835,000" });
  const ys = resolvedYearSources(getFieldSources(after.info).revenueByYear, after.info.revenueByYear as any);
  assert.equal(ys["2024"].documentId, "final");
  assert.equal(getFieldSources(after.info).annualRevenue.documentId, "final");
  assert.ok((getFieldAlternates(after.info).annualRevenue ?? []).some((a) => a.value === "$2,300,000" && a.documentId === "call"), "the call's figure is kept as another value");
  assert.ok(!JSON.stringify(after.info).includes('"draft"'), "nothing of the draft left");
  const standing = conflicts.filter((c) => c.factKey === "annualRevenue" || c.factKey === "revenueByYear");
  assert.ok(standing.some((c) => c.winner.value === "$1,835,000" && c.loser.value === "$2,300,000"), `the call vs the final statements is a conflict: ${JSON.stringify(conflicts)}`);

  // Through the store: the conflict becomes a merge discrepancy (the gate sees it), the old row is superseded.
  reset();
  deal.extractedInfo = info;
  docs = [doc("call", { sourceKind: "call", status: "extracted" }), doc("draft", { status: "extracted", name: "Draft financial statements FY2024" }), doc("final", { status: "extracted", name: "Final financial statements FY2024" })];
  reqs = [{ id: "q1", dealId: "D", documentName: "Financial statements", category: "financial", status: "verified", uploadedFileId: "draft", uploadedBy: "seller", uploadedAt: new Date() }];
  rows = [{ id: "old", dealId: "D", source: "merge", status: "open", factKey: "annualRevenue", factYear: null, interviewValue: "$2,300,000", documentValue: "$1,820,000", sideSources: { interview: { kind: "call", documentId: "call" }, document: { kind: "document", documentId: "draft" } }, createdAt: new Date() }];
  docs = docs.filter((d) => d.id !== "draft");
  await removeSourceFacts("D", "draft");
  assert.equal(deal.extractedInfo.annualRevenue, "$1,835,000");
  const open = rows.filter((r) => r.status === "open");
  assert.ok(open.some((r) => r.factKey === "annualRevenue" && /2,300,000/.test(`${r.interviewValue} ${r.documentValue}`) && /1,835,000/.test(`${r.interviewValue} ${r.documentValue}`)), `a merge row stands for call vs final: ${JSON.stringify(rows.map((r) => [r.id, r.status, r.factKey, r.interviewValue, r.documentValue]))}`);
  assert.equal(rows.find((r) => r.id === "old")!.status, "superseded");
  // F-DEL-CHECKLIST: the verified row the draft was uploaded for is missing again.
  assert.deepEqual([reqs[0].status, reqs[0].uploadedFileId, reqs[0].uploadedBy], ["missing", null, null]);
  ok("F-DEL-PROMOTE + F-DEL-CHECKLIST: deleting a draft P&L refills revenue and FY2024 from the final statements (not the call), raises call-vs-final as a merge row, and releases its checklist row");
}

// ── F-MAPEDIT-PRIVACY: a typo fixed in one year ─────────────────────────────────
{
  let info: Record<string, unknown> = {};
  info = mergeExtractedData(info, { revenueByYear: { "2023": "$1,70,000", "2024": "$1,835,000" }, _periodEnd: "2024-12-31" } as any, { documentId: "fs", source: "document", title: "Financial statements FY2024" });
  info = mergeExtractedData(info, { revenueByYear: { "2025": "$3,600,000" } } as any, { documentId: "crm", source: "crm", brokerOnly: true, title: "Pipedrive note" });
  const documents = [{ id: "fs", visibility: "shared", sourceKind: "document" }, { id: "crm", visibility: "broker_only", sourceKind: "crm" }] as any[];
  info = stampSourceDetails(info, documents);
  const cimYears = (i: Record<string, unknown>) => Object.keys((splitFactsForCim(i).confirmed.find(([k]) => k === "revenueByYear")?.[1] ?? {}) as object).sort();
  const sellerYears = (i: Record<string, unknown>) => Object.keys((sellerInterviewView(i, documents).revenueByYear ?? {}) as object).sort();
  assert.deepEqual(cimYears(info), ["2023", "2024"], "before: the CRM year is out of the CIM");
  assert.deepEqual(sellerYears(info), ["2023", "2024"], "before: and out of the interview");
  // The broker fixes the 2023 typo in the edit box (which shows every year, the CRM one included).
  editFact(info, "revenueByYear", "2025: $3,600,000\n2024: $1,835,000\n2023: $1,700,000");
  assert.deepEqual(info.revenueByYear, { "2023": "$1,700,000", "2024": "$1,835,000", "2025": "$3,600,000" });
  assert.deepEqual(cimYears(info), ["2023", "2024"], "the CRM year still never reaches the CIM");
  assert.deepEqual(sellerYears(info), ["2023", "2024"], "…nor the seller's interview");
  const ys = resolvedYearSources(getFieldSources(info).revenueByYear, info.revenueByYear as any);
  assert.equal(ys["2023"].source, "broker", "only the edited year is the broker's");
  assert.equal(ys["2024"].documentId, "fs", "an untouched statement year keeps its source");
  assert.equal(ys["2025"].source, "crm");
  assert.equal(ys["2025"].brokerOnly, true);
  assert.ok((getFieldAlternates(info)["revenueByYear.2023"] ?? []).some((a) => a.value === "$1,70,000"), "the typo is kept as that year's other value");
  // Taking a year out removes only that year, and that source's figure stays out on a re-read.
  editFact(info, "revenueByYear", "2024: $1,835,000\n2023: $1,700,000");
  assert.deepEqual(Object.keys(info.revenueByYear as object).sort(), ["2023", "2024"]);
  assert.ok((info._brokerSuppressed as string[]).includes("revenueByYear.2025@crm"));
  info = mergeExtractedData(info, { revenueByYear: { "2025": "$3,600,000" } } as any, { documentId: "crm", source: "crm", brokerOnly: true });
  assert.equal((info.revenueByYear as any)["2025"], undefined);
  // A plain fact is still edited whole.
  const plain: Record<string, unknown> = { employees: "41", _fieldSources: { employees: { source: "document", documentId: "fs" } } };
  editFact(plain, "employees", "42");
  assert.equal(getFieldSources(plain).employees.source, "broker");
  void setBrokerMapEntry;
  ok("F-MAPEDIT-PRIVACY: fixing one year of revenue by year leaves the other years' sources as they were — the broker-only CRM year stays out of the CIM and the interview");
}

// ── F-VIS-SHARED: a broker-only email made shared ───────────────────────────────
{
  let info: Record<string, unknown> = {};
  info = mergeExtractedData(info, { leaseExpiry: "June 30, 2029", employees: "18" } as any, { documentId: "mail", source: "email", brokerOnly: true, title: "Email from Dr. Patel" });
  info = { ...info, _brokerPrivateNotes: [{ note: "Owner's wife is unwell", documentId: "mail", brokerOnly: true, reason: "From Email from Dr. Patel" }] };
  const privateRow = [{ id: "mail", visibility: "broker_only", sourceKind: "email" }] as any[];
  const sharedRow = [{ id: "mail", visibility: "shared", sourceKind: "email" }] as any[];
  const view = (i: Record<string, unknown>, rows: any[]) => sellerInterviewView(i, rows);
  assert.equal(view(info, privateRow).leaseExpiry, undefined, "broker-only: hidden from the interview");
  // The broker switches the row to shared: the seller view goes by the row now…
  assert.equal(view(info, sharedRow).leaseExpiry, "June 30, 2029", "shared: the interview can confirm it (never re-asks)");
  assert.equal(view(info, sharedRow).employees, "18");
  // …and the facts are re-stamped (what the CIM and every other reader go by).
  const restamped = stampNoteSources(stampSourceDetails(info, sharedRow), "mail", false);
  assert.equal(getFieldSources(restamped).leaseExpiry.brokerOnly, false);
  assert.equal((restamped._brokerPrivateNotes as any[])[0].brokerOnly, undefined);
  assert.deepEqual(splitFactsForCim(restamped).confirmed.map(([k]) => k).sort(), ["employees", "leaseDetails", "leaseExpiry"]);
  // And back to broker-only: hidden again at once.
  const back = stampNoteSources(stampSourceDetails(restamped, privateRow), "mail", true);
  assert.equal(view(back, privateRow).leaseExpiry, undefined);
  assert.equal(getFieldSources(back).leaseExpiry.brokerOnly, true);
  assert.equal((back._brokerPrivateNotes as any[])[0].brokerOnly, true);
  assert.deepEqual(splitFactsForCim(back).confirmed, []);
  ok("F-VIS-SHARED: a source switched to shared reaches the interview's seller view at once (and is re-stamped for the CIM); switched back, it is hidden again");
}

// ── known-6: a single-source re-read asks only about that source's wordings ─────
{
  const items = [
    { key: "a", text: "Owner's heart episode", sources: [{ documentId: "call" }], shared: true },
    { key: "b", text: "Seller floor $4M", sources: [{ documentId: "crm", brokerOnly: true }], shared: false },
    { key: "c", text: "Wife wants to move", sources: [{ questionnaire: true }], shared: true },
    { key: "d", text: "Heart episode, stent", sources: [{ documentId: "safety" }, { documentId: "call" }], shared: true },
  ] as any[];
  assert.deepEqual(wordingsInScope(items, { onlyDocumentIds: ["call"] }).map((i) => i.key), ["a", "d"]);
  assert.deepEqual(wordingsInScope(items, {}).map((i) => i.key), ["a", "b", "c", "d"]);
  assert.deepEqual(wordingsInScope(items, { onlyDocumentIds: ["nothing"] }), []);
  ok("known-6: a one-source re-read sends only that source's new wordings to the notes review (and skips the deal-wide fold)");
}

_setExtractionClientForTests(null);
console.log("f-facts-pipeline: all passed");
