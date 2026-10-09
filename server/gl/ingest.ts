/**
 * ingest.ts — a general-ledger file becomes ledger entries (gl spec §6.4).
 *
 *   isLedgerDocument(doc)           → "ledger" (read entry by entry), "pdf_ledger"
 *                                     (stored with a note, never read), or null
 *   ingestLedgerFromDocument(doc)   → the hook at the top of ingestDocument
 *   enqueueLedgerRead(ledgerId)     → glQueue: one read at a time per server,
 *                                     one queued entry per ledger
 *   ingestLedger(ledgerId)          → detect → stream → parse → insert in
 *                                     batches → finish under the GL lock
 *                                     (duplicates, summaries, problems) →
 *                                     document summary → checklist row
 *   recoverInterruptedLedgerReads() → startup: a read a restart cut off is
 *                                     re-queued (twice at most), else failed
 *
 * No AI here: the deterministic detector reads common exports for $0; an
 * unusual layout goes to the AI mapper only when one is installed and the
 * day's budget allows (pass 3), else "needs columns" for the broker. A
 * ledger never goes through the generic extractor and never merges facts.
 */
import fs from "node:fs";
import path from "node:path";
import { storage } from "../storage";
import { resolveDocumentPath } from "../documents/document-path";
import { SheetReadError, withHeavySheetSlot } from "../documents/heavy-sheet";
import type { Deal, Document, GlLedger, InsertGlTransaction } from "@shared/schema";
import type { GlLayout, GlParsedEntry, GlProblem, GlSoftware, GlSourceMeta, GlYearSummary } from "@shared/gl-types";
import { fiscalYearKey } from "@shared/fiscal-year";
import { LEDGER_FAILURES, ledgerDocumentSummary, problemMessage } from "@shared/gl-copy";
import { glStore, type GlStore } from "./store";
import { withGlLock } from "./lock";
import { ledgerFileKind, peekRows, readLedgerRows, SNIFF_ROWS, type LedgerFileKind } from "./read-file";
import { detectLayout, headerFingerprint, rowFingerprint, sniffLedger, type DetectResult } from "./detect";
import { LedgerParser, normHeader } from "./parse";
import { fiscalYearEndFor, fiscalYearOf } from "./fiscal";
import { classifyHint } from "./sensitive";
import { emitGlLedgerStatusChanged } from "./events";
import { cellText } from "./text";

// ── Limits ───────────────────────────────────────────────────────────────

export const GL_CSV_MAX_BYTES = 60 * 1024 * 1024;
export const GL_XLSX_MAX_BYTES = 15 * 1024 * 1024;
export const GL_MAX_ROWS_PER_FILE = 300_000;
export const GL_MAX_ROWS_PER_DEAL = 400_000;
const INSERT_BATCH = 1000;
/** A ledger left "reading" this long, by no live read, was interrupted. */
export const GL_STUCK_MS = 5 * 60_000;
export const GL_MAX_ATTEMPTS = 2;

const sizeLabel = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`;

// ── Which documents are ledgers ──────────────────────────────────────────

/** A name that says "general ledger" (or a ledger report's other names). */
export const LEDGER_NAME_RE = /general[\s_-]*ledger|\bg\/l\b|\bgl[\s_-]+(?:export|detail|report)\b|transaction detail by account|account transactions/i;

export type LedgerDocKind = "ledger" | "pdf_ledger";

type DocLike = Pick<Document, "id" | "name" | "originalName" | "fileUrl" | "subcategory" | "sourceKind" | "sourceMeta" | "category">;

function docFileName(doc: Pick<Document, "originalName" | "name" | "fileUrl">): string {
  const byUrl = (doc.fileUrl ?? "").split("/").pop() ?? "";
  // The stored file's extension is what the reader opens.
  return path.extname(byUrl) ? byUrl : doc.originalName || doc.name || byUrl;
}

/** What the ledger branch does with a document, without reading the file (pure). Null = "sniff it" for a spreadsheet, else not a ledger. */
export function ledgerKindWithoutReading(doc: DocLike): LedgerDocKind | "sniff" | null {
  const meta = (doc.sourceMeta as GlSourceMeta | null) ?? null;
  if (meta?.notLedger) return null;
  const kind = ledgerFileKind(docFileName(doc));
  const filedAsLedger = doc.subcategory === "general_ledger";
  const namedLedger = LEDGER_NAME_RE.test(`${doc.name ?? ""} ${doc.originalName ?? ""}`);
  if (kind) {
    if (filedAsLedger) return "ledger";
    // Only an uploaded document is sniffed — never an email, a call or a CRM note.
    if (doc.sourceKind && doc.sourceKind !== "document") return null;
    return "sniff";
  }
  const ext = path.extname(docFileName(doc)).toLowerCase();
  if ((filedAsLedger || namedLedger) && [".pdf", ".docx", ".doc"].includes(ext)) return "pdf_ledger";
  return null;
}

export interface LedgerSniffDeps {
  peek: (filePath: string, kind: LedgerFileKind, n: number, fileName: string) => Promise<import("@shared/gl-types").GlRawRow[]>;
}

/**
 * Is this document a general ledger? Filed as one (subcategory, the GL
 * checklist row, the GL screens) → "ledger"; a PDF/Word file named or filed
 * as one → "pdf_ledger" (stored with a summary only, $0); any other
 * spreadsheet upload is sniffed (detect.ts sniffLedger: a confident layout
 * with ≥3 accounts AND a ledger's title or a chart of accounts — a sales
 * report by customer or an aging is never taken for one). "maybe" = shaped
 * like a ledger without the evidence: read as an ordinary document, and the
 * broker is offered "Read it as a ledger".
 */
export async function ledgerVerdict(doc: DocLike, deps: LedgerSniffDeps = { peek: peekRows }): Promise<LedgerDocKind | "maybe" | null> {
  const k = ledgerKindWithoutReading(doc);
  if (k !== "sniff") return k;
  const filePath = resolveDocumentPath(doc);
  if (!filePath || !fs.existsSync(filePath)) return null;
  const kind = ledgerFileKind(docFileName(doc))!;
  try {
    // The name the uploader gave it counts as a title ("Sales by Customer Detail.xlsx", "GL 2024.csv").
    const names = `${doc.originalName ?? ""} ${doc.name ?? ""}`;
    const sniff = async () => sniffLedger(await deps.peek(filePath, kind, SNIFF_ROWS, docFileName(doc)), { minAccounts: 3, fileName: names });
    const v = kind === "xlsx" ? await withHeavySheetSlot(sniff) : await sniff();
    return v === "ledger" ? "ledger" : v === "maybe" ? "maybe" : null;
  } catch {
    return null;
  }
}

/** ledgerVerdict without the "maybe" (a maybe is read as an ordinary document). */
export async function isLedgerDocument(doc: DocLike, deps: LedgerSniffDeps = { peek: peekRows }): Promise<LedgerDocKind | null> {
  const v = await ledgerVerdict(doc, deps);
  return v === "maybe" ? null : v;
}

// ── Dependencies (tests swap them) ───────────────────────────────────────

export interface GlIngestDeps {
  store: GlStore;
  getDocument(id: string): Promise<Document | undefined>;
  updateDocument(id: string, patch: Partial<Document>): Promise<unknown>;
  getDocumentsByDeal(dealId: string): Promise<Document[]>;
  getDeal(dealId: string): Promise<Deal | undefined>;
  getAnalysisYears(dealId: string): Promise<string[]>;
  syncRequirement(dealId: string): Promise<void>;
  releaseNonGlRequirements(dealId: string, docId: string): Promise<unknown>;
  /** After a ledger is ready or removed: tie-out, trace proposals (pass 2). */
  afterLedgersChanged(dealId: string, info: { ledgerId: string; uploadedBy: string; change: "ready" | "removed" }): Promise<void>;
  /**
   * The AI column mapper (pass 3); null = none installed → "needs columns".
   * Resolves a layout, "not_ledger" (the file isn't a ledger → failed), or
   * null (couldn't map it / no budget / an outage → "needs columns").
   */
  mapColumns: null | ((ledger: GlLedger, sample: import("@shared/gl-types").GlRawRow[]) => Promise<GlLayout | "not_ledger" | null>);
  /**
   * Before a ledger is read: a fiscal-year end the deal's facts have overtaken
   * (and the broker never set) moves, with every entry and link already on
   * file (service.ts followFiscalYearEnd; takes the GL lock). null = none installed.
   */
  followFiscalYearEnd: null | ((dealId: string) => Promise<boolean>);
  now(): Date;
}

let depsOverride: Partial<GlIngestDeps> | null = null;
/** Tests: replace some dependencies (null resets). */
export function _setGlIngestDepsForTests(d: Partial<GlIngestDeps> | null): void {
  depsOverride = d;
}

async function analysisYears(dealId: string): Promise<string[]> {
  try {
    const { pickAnalysisForCim } = await import("../cim/cim-financials");
    const a = pickAnalysisForCim(await storage.getFinancialAnalysesByDeal(dealId));
    const years = ((a?.normalization as { years?: unknown[] } | null)?.years ?? []).map((y) => fiscalYearKey(String(y))).filter((y): y is string => !!y);
    return Array.from(new Set(years)).sort();
  } catch {
    return [];
  }
}

function deps(): GlIngestDeps {
  const base: GlIngestDeps = {
    store: glStore(),
    getDocument: (id) => storage.getDocument(id),
    updateDocument: (id, patch) => storage.updateDocument(id, patch as any),
    getDocumentsByDeal: (id) => storage.getDocumentsByDeal(id),
    getDeal: (id) => storage.getDeal(id),
    getAnalysisYears: analysisYears,
    // (A deal from before the ledger row existed gets it now — then its status.)
    syncRequirement: async (dealId) => {
      const { ensureGlRequirement } = await import("../documents/requirements");
      if (!(await ensureGlRequirement(dealId))) await (await import("./requirement")).syncGlRequirement(dealId);
    },
    releaseNonGlRequirements: async (dealId, docId) => (await import("../documents/requirements")).releaseRequirementsFor(dealId, docId),
    afterLedgersChanged: async () => undefined,
    mapColumns: null,
    followFiscalYearEnd: null,
    now: () => new Date(),
  };
  return depsOverride ? { ...base, ...depsOverride } : base;
}

/** Pass 2 installs the tie-out and proposal runs here (kept out of this file so it stays small). */
let afterChangedHook: GlIngestDeps["afterLedgersChanged"] | null = null;
export function setGlAfterLedgersChanged(fn: GlIngestDeps["afterLedgersChanged"] | null): void {
  afterChangedHook = fn;
}
/** Pass 3 installs the AI column mapper here (null = none). */
let mapColumnsHook: GlIngestDeps["mapColumns"] = null;
export function setGlColumnMapper(fn: GlIngestDeps["mapColumns"]): void {
  mapColumnsHook = fn;
}
/** service.ts installs "the fiscal-year end follows the facts" here (kept out of this file: it moves rows and re-runs everything). */
let followFyeHook: GlIngestDeps["followFiscalYearEnd"] = null;
export function setGlFollowFiscalYearEnd(fn: GlIngestDeps["followFiscalYearEnd"]): void {
  followFyeHook = fn;
}

function effectiveDeps(): GlIngestDeps {
  const d = deps();
  return {
    ...d,
    afterLedgersChanged: depsOverride?.afterLedgersChanged ?? afterChangedHook ?? d.afterLedgersChanged,
    mapColumns: depsOverride && "mapColumns" in depsOverride ? depsOverride.mapColumns! : mapColumnsHook,
    followFiscalYearEnd: depsOverride && "followFiscalYearEnd" in depsOverride ? depsOverride.followFiscalYearEnd! : followFyeHook,
  };
}

// ── The deal's tracing row (fiscal-year end) ─────────────────────────────

/**
 * The deal's fiscal-year end (creating the deal's tracing row the first
 * time). Until the broker sets it, it follows the facts and statements: a row
 * created early on the Dec 31 default moves (with every entry and link on
 * file) once the facts say otherwise — checked here, before every read.
 */
export async function dealFiscalYearEnd(dealId: string, d: GlIngestDeps = effectiveDeps()): Promise<string> {
  const [existing, deal, docs] = await Promise.all([d.store.getTracing(dealId), d.getDeal(dealId), d.getDocumentsByDeal(dealId)]);
  const derived = fiscalYearEndFor(deal, docs);
  if (!existing) return (await d.store.ensureTracing(dealId, derived)).fiscalYearEnd;
  if (existing.fiscalYearEndByBroker || existing.fiscalYearEnd === derived) return existing.fiscalYearEnd;
  if (!d.followFiscalYearEnd) return existing.fiscalYearEnd; // the entries on file can't be moved here — leave it
  await d.followFiscalYearEnd(dealId);
  return (await d.store.getTracing(dealId))?.fiscalYearEnd ?? existing.fiscalYearEnd;
}

// ── The hook ─────────────────────────────────────────────────────────────

/**
 * The top of ingestDocument (INTEGRATION §2.17 step 2): a ledger is read by
 * the ledger reader (queued, returns at once with the document "parsing"),
 * a PDF/Word ledger is stored with a note and never read ($0). Returns null
 * for any other document (the normal path continues).
 */
export async function ingestLedgerFromDocument(
  doc: Document,
  opts: { uploadedBy?: "broker" | "seller"; role?: "ledger" | "adjustments"; sniffDeps?: LedgerSniffDeps } = {},
): Promise<{ status: "extracted" | "failed"; fieldsWritten: string[] } | null> {
  const kind = await ledgerVerdict(doc, opts.sniffDeps);
  if (kind === "maybe") {
    // Read as an ordinary document (the caller continues); the broker's GL panel offers "Read it as a ledger".
    await flagMaybeLedger(doc);
    return null;
  }
  if (!kind) return null;
  const d = effectiveDeps();
  if (kind === "pdf_ledger") {
    const meta: GlSourceMeta = { ...((doc.sourceMeta as GlSourceMeta | null) ?? {}), glNote: LEDGER_FAILURES.pdf };
    await d.updateDocument(doc.id, {
      status: "extracted",
      isProcessed: true,
      subcategory: "general_ledger",
      extractedText: "General ledger (PDF). A PDF ledger can't be matched entry by entry — ask for the Excel or CSV export.",
      extractedData: { summary: "General ledger (PDF) — ask for the Excel or CSV export." },
      sourceMeta: meta,
    } as Partial<Document>);
    return { status: "extracted", fieldsWritten: [] };
  }
  await startLedgerRead(doc, { uploadedBy: opts.uploadedBy, role: opts.role }, d);
  return { status: "extracted", fieldsWritten: [] };
}

/**
 * Marks a ledger-shaped spreadsheet the sniff couldn't confirm. The caller's
 * copy of the row is updated too: the ordinary read that follows writes
 * sourceMeta from it (sourceMetaAfterRead), which would otherwise drop the flag.
 */
async function flagMaybeLedger(doc: Document): Promise<void> {
  const meta = { ...((doc.sourceMeta as GlSourceMeta | null) ?? {}) } as GlSourceMeta;
  if (meta.glMaybeLedger) return;
  meta.glMaybeLedger = true;
  try {
    await effectiveDeps().updateDocument(doc.id, { sourceMeta: meta } as Partial<Document>);
    (doc as { sourceMeta: unknown }).sourceMeta = meta;
  } catch (err) {
    console.warn(`[gl] couldn't mark ${doc.id} as a possible ledger:`, (err as Error).message);
  }
}

/** Creates (or resets) the document's ledger row and queues its read. */
export async function startLedgerRead(
  doc: Document,
  opts: { uploadedBy?: "broker" | "seller"; role?: "ledger" | "adjustments"; layout?: GlLayout; layoutBy?: "broker" | "ai" } = {},
  d: GlIngestDeps = effectiveDeps(),
): Promise<GlLedger> {
  const fye = await dealFiscalYearEnd(doc.dealId, d);
  let ledger = await d.store.getLedgerByDocument(doc.id);
  if (!ledger) {
    try {
      ledger = await d.store.createLedger({
        dealId: doc.dealId,
        documentId: doc.id,
        role: opts.role ?? "ledger",
        status: "reading",
        uploadedBy: opts.uploadedBy ?? (doc.uploadedBy === "seller" ? "seller" : "broker"),
        fiscalYearEndUsed: fye,
        ...(opts.layout ? { layout: opts.layout, layoutBy: opts.layoutBy ?? "broker" } : {}),
      } as any);
    } catch {
      ledger = await d.store.getLedgerByDocument(doc.id); // created at the same moment by another request
    }
  } else {
    ledger = await d.store.updateLedger(ledger.id, {
      status: "reading",
      failure: null,
      progress: null,
      ...(opts.role ? { role: opts.role } : {}),
      ...(opts.layout ? { layout: opts.layout, layoutBy: opts.layoutBy ?? "broker" } : {}),
    } as Partial<GlLedger>);
  }
  if (!ledger) throw new Error("couldn't create the ledger row");
  // Filed as a ledger (and as financials when it came in uncategorised).
  await d.updateDocument(doc.id, {
    status: "parsing",
    subcategory: "general_ledger",
    ...(!doc.category || doc.category === "other" ? { category: "financials" } : {}),
  } as Partial<Document>);
  emitGlLedgerStatusChanged(doc.id);
  void enqueueLedgerRead(ledger.id).catch((err) => console.error(`[gl] ledger read ${ledger!.id} failed:`, err));
  return ledger;
}

// ── The queue ────────────────────────────────────────────────────────────

const queued = new Map<string, Promise<void>>();
const running = new Set<string>();
let tail: Promise<unknown> = Promise.resolve();

/** True while the ledger is queued or being read on this server. */
export function isLedgerInQueue(ledgerId: string): boolean {
  return queued.has(ledgerId) || running.has(ledgerId);
}

/**
 * Queues a read (FIFO, one at a time on this server). A ledger already
 * waiting is not queued twice; one being read is read again afterwards
 * (its columns may have changed).
 */
export function enqueueLedgerRead(ledgerId: string): Promise<void> {
  const waiting = queued.get(ledgerId);
  if (waiting) return waiting;
  const job = tail
    .catch(() => undefined)
    .then(async () => {
      queued.delete(ledgerId);
      running.add(ledgerId);
      try {
        await ingestLedger(ledgerId);
      } finally {
        running.delete(ledgerId);
      }
    });
  queued.set(ledgerId, job);
  tail = job.catch(() => undefined);
  return job;
}

// ── Reading one ledger ───────────────────────────────────────────────────

interface YearAcc { lines: number; debitCents: number; creditCents: number; accounts: Set<string>; firstDate: string; lastDate: string }

async function failLedger(d: GlIngestDeps, ledger: GlLedger, doc: Document | undefined, reason: string): Promise<void> {
  await d.store.deleteTransactionsOfLedger(ledger.id).catch(() => undefined);
  await d.store.updateLedger(ledger.id, { status: "failed", failure: reason, progress: null } as Partial<GlLedger>);
  if (doc) {
    const meta: GlSourceMeta = { ...((doc.sourceMeta as GlSourceMeta | null) ?? {}), readFailed: { at: d.now().toISOString(), reason, retryable: false } };
    await d.updateDocument(doc.id, { status: "failed", isProcessed: false, sourceMeta: meta } as Partial<Document>);
  }
  await d.syncRequirement(ledger.dealId);
  emitGlLedgerStatusChanged(ledger.documentId);
}

/** The fiscal years the broker needs: the analysis's years, else the three fiscal years before this one. */
export function expectedYears(analysisYears: string[], fye: string, today: Date): string[] {
  if (analysisYears.length > 0) return analysisYears;
  const todayIso = today.toISOString().slice(0, 10);
  const current = Number(fiscalYearOf(todayIso, fye));
  return [current - 3, current - 2, current - 1].map(String);
}

/** The fiscal years to ask the seller for, for this deal (the analysis's, else the three before this one). */
export async function requestedYearsFor(dealId: string, fye: string): Promise<string[]> {
  const d = effectiveDeps();
  return expectedYears(await d.getAnalysisYears(dealId), fye, d.now());
}

/** Plain problems for a read ledger (pure). */
export function ledgerProblems(input: {
  years: Record<string, GlYearSummary>;
  expected: string[];
  otherLedgerYears: string[];
  fye: string;
  basis: "accrual" | "cash" | null;
  duplicates: number;
  skipped: number;
  datesAmbiguous: boolean;
  currencies: number;
  today: Date;
}): GlProblem[] {
  const out: GlProblem[] = [];
  const have = new Set([...Object.keys(input.years), ...input.otherLedgerYears]);
  const missing = input.expected.filter((y) => !have.has(y));
  if (missing.length) out.push({ kind: "missing_years", years: missing, message: problemMessage({ kind: "missing_years", years: missing }) });
  const todayIso = input.today.toISOString().slice(0, 10);
  const currentFy = fiscalYearOf(todayIso, input.fye);
  const partial = Object.entries(input.years)
    .filter(([y, s]) => y !== currentFy && input.expected.includes(y) && monthsCovered(s.firstDate, s.lastDate) < 11)
    .map(([y]) => y);
  if (partial.length) out.push({ kind: "partial_year", years: partial, message: problemMessage({ kind: "partial_year", years: partial }) });
  if (input.basis === "cash") out.push({ kind: "cash_basis", message: problemMessage({ kind: "cash_basis" }) });
  if (input.duplicates > 0) out.push({ kind: "duplicates_skipped", count: input.duplicates, message: problemMessage({ kind: "duplicates_skipped", count: input.duplicates }) });
  if (input.skipped > 0) out.push({ kind: "rows_skipped", count: input.skipped, message: problemMessage({ kind: "rows_skipped", count: input.skipped }) });
  if (input.datesAmbiguous) out.push({ kind: "dates_ambiguous", message: problemMessage({ kind: "dates_ambiguous" }) });
  if (input.currencies > 1) out.push({ kind: "mixed_currencies", message: problemMessage({ kind: "mixed_currencies" }) });
  return out;
}

function monthsCovered(first: string, last: string): number {
  const a = new Date(`${first}T00:00:00Z`).getTime();
  const b = new Date(`${last}T00:00:00Z`).getTime();
  return (b - a) / (86400000 * 30.44);
}

/** A layout reused from another ledger of the deal with the same headings (a re-export). */
async function reusedLayout(d: GlIngestDeps, ledger: GlLedger, sample: import("@shared/gl-types").GlRawRow[]): Promise<{ layout: GlLayout; layoutBy: "detector" | "ai" | "broker"; fingerprint: string } | null> {
  const others = (await d.store.listLedgers(ledger.dealId)).filter((l) => l.id !== ledger.id && l.layout && l.headerFingerprint && (l.status === "ready" || l.layoutBy === "broker"));
  if (others.length === 0) return null;
  const firstSheet = sample[0]?.sheet ?? null;
  const rows = sample.filter((r) => r.sheet === firstSheet).slice(0, 60);
  for (let i = 0; i < rows.length; i++) {
    const fp = rowFingerprint(rows[i].cells);
    const match = others.find((o) => o.headerFingerprint === fp);
    if (match) {
      const layout = { ...(match.layout as GlLayout), headerRow: i, sheet: firstSheet };
      return { layout, layoutBy: (match.layoutBy as "detector" | "ai" | "broker") ?? "detector", fingerprint: fp };
    }
  }
  return null;
}

/** The layout's own heading texts in column order (its fingerprint is the heading row's). */
function layoutFingerprint(layout: GlLayout): string {
  const width = Math.max(0, ...layout.columns.map((c) => c.index + 1));
  return headerFingerprint(Array.from({ length: width }, (_, i) => layout.columns.find((c) => c.index === i)?.header ?? ""));
}

/** Re-counts each ready ledger's duplicates after the deal's marks changed (a file read or deleted). */
async function refreshDuplicateCounts(d: GlIngestDeps, dealId: string): Promise<void> {
  for (const l of await d.store.listLedgers(dealId)) {
    if (l.status !== "ready") continue;
    const n = await d.store.countDuplicates(l.id);
    if (n === l.duplicateCount) continue;
    const problems = ((l.problems as GlProblem[] | null) ?? []).filter((p) => p.kind !== "duplicates_skipped");
    if (n > 0) problems.push({ kind: "duplicates_skipped", count: n, message: problemMessage({ kind: "duplicates_skipped", count: n }) });
    await d.store.updateLedger(l.id, { duplicateCount: n, problems } as Partial<GlLedger>);
  }
}

/**
 * Reads one ledger: the steps of gl spec §6.4. Never throws; a failure is
 * recorded on the ledger and its document with a plain reason.
 */
export async function ingestLedger(ledgerId: string): Promise<void> {
  const d = effectiveDeps();
  let ledger = await d.store.getLedger(ledgerId);
  if (!ledger) return;
  const doc = await d.getDocument(ledger.documentId);
  if (!doc) {
    await d.store.deleteTransactionsOfLedger(ledger.id).catch(() => undefined);
    await d.store.deleteLedger(ledger.id).catch(() => undefined);
    return;
  }
  const heartbeat = setInterval(() => {
    void d.store.updateLedger(ledgerId, {} as Partial<GlLedger>).catch(() => undefined);
  }, 60_000);
  heartbeat.unref?.();
  try {
    const fileName = docFileName(doc);
    const kind = ledgerFileKind(fileName);
    if (!kind) return await failLedger(d, ledger, doc, LEDGER_FAILURES.unsupported);
    const filePath = resolveDocumentPath(doc);
    if (!filePath || !fs.existsSync(filePath)) return await failLedger(d, ledger, doc, LEDGER_FAILURES.noCopy);
    const size = fs.statSync(filePath).size;
    if (kind === "xlsx" && size > GL_XLSX_MAX_BYTES) return await failLedger(d, ledger, doc, LEDGER_FAILURES.tooBigXlsx(sizeLabel(size)));
    if (kind === "csv" && size > GL_CSV_MAX_BYTES) return await failLedger(d, ledger, doc, LEDGER_FAILURES.tooBigCsv(sizeLabel(size)));

    const fye = await dealFiscalYearEnd(ledger.dealId, d);
    // Rows already on file are replaced by this read.
    await d.store.deleteTransactionsOfLedger(ledger.id);
    ledger = (await d.store.updateLedger(ledger.id, { status: "reading", failure: null, fiscalYearEndUsed: fye, progress: { rowsRead: 0, rowsSaved: 0, at: d.now().toISOString() } } as Partial<GlLedger>)) ?? ledger;
    await d.updateDocument(doc.id, { status: "parsing" } as Partial<Document>);

    const run = async () => {
      // 1. The layout: the broker's (or a reused one), else the detector's, else the AI mapper, else "needs columns".
      let layout: GlLayout | null = null;
      let layoutBy: "detector" | "ai" | "broker" = "detector";
      let detected: DetectResult | null = null;
      let fingerprint: string | null = ledger!.headerFingerprint ?? null;
      const minAccounts = 1;
      if (ledger!.layout && (ledger!.layoutBy === "broker" || ledger!.layoutBy === "ai")) {
        layout = ledger!.layout as GlLayout;
        layoutBy = ledger!.layoutBy as "broker" | "ai";
        fingerprint = layoutFingerprint(layout);
      } else {
        const sample = await peekRows(filePath, kind, undefined, fileName);
        detected = detectLayout(sample);
        if (detected && detected.confidence >= 0.6 && detected.accounts >= minAccounts) {
          layout = detected.layout;
          fingerprint = detected.headerFingerprint;
        } else {
          const reused = await reusedLayout(d, ledger!, sample);
          if (reused) {
            layout = reused.layout;
            layoutBy = reused.layoutBy;
            fingerprint = reused.fingerprint;
          } else if (d.mapColumns) {
            const mapped = await d.mapColumns(ledger!, sample).catch(() => null);
            if (mapped === "not_ledger") return await failLedger(d, ledger!, doc, LEDGER_FAILURES.notLedger);
            if (mapped) {
              layout = mapped;
              layoutBy = "ai";
              fingerprint = layoutFingerprint(mapped);
            }
          }
        }
        if (!layout) {
          // Waits for its columns: the broker sets them (or asks for the standard export).
          await d.store.updateLedger(ledger!.id, { status: "needs_columns", failure: null, progress: null, headerFingerprint: fingerprint, software: detected?.software ?? null } as Partial<GlLedger>);
          await d.updateDocument(doc.id, {
            status: "extracted",
            isProcessed: false,
            subcategory: "general_ledger",
            extractedText: "General ledger export — Cimple needs to know which column is which before it can read the entries.",
          } as Partial<Document>);
          await d.syncRequirement(ledger!.dealId);
          emitGlLedgerStatusChanged(doc.id);
          // A seller's upload: the broker hears it needs a quick check (gl spec §6.12); they see it on the panel anyway.
          if (ledger!.uploadedBy === "seller") {
            void import("./notify").then((m) => m.notifyBroker(ledger!.dealId, "needs_columns")).catch(() => undefined);
          }
          return;
        }
      }

      // 2. Stream every row → entries → batches of 1,000.
      const dealRowsBefore = (await d.store.listLedgers(ledger!.dealId)).filter((l) => l.id !== ledger!.id && l.status === "ready").reduce((s, l) => s + l.rowCount, 0);
      const parser = new LedgerParser(layout);
      const years: Record<string, YearAcc> = {};
      const accounts = new Set<string>();
      let saved = 0;
      let rowsRead = 0;
      let firstDate = "";
      let lastDate = "";
      let capped: string | null = null;
      const pending: InsertGlTransaction[] = [];
      const flush = async (force = false) => {
        while (pending.length >= INSERT_BATCH || (force && pending.length > 0)) {
          const batch = pending.splice(0, INSERT_BATCH);
          await d.store.insertTransactions(batch);
          saved += batch.length;
          await d.store.updateLedger(ledger!.id, { progress: { rowsRead, rowsSaved: saved, at: d.now().toISOString() } } as Partial<GlLedger>);
        }
      };
      const take = (entries: GlParsedEntry[]) => {
        for (const e of entries) {
          if (saved + pending.length >= GL_MAX_ROWS_PER_FILE) { capped = LEDGER_FAILURES.rowsCap; return; }
          if (dealRowsBefore + saved + pending.length >= GL_MAX_ROWS_PER_DEAL) { capped = LEDGER_FAILURES.dealRowsCap; return; }
          const fy = fiscalYearOf(e.txnDate, fye);
          const y = (years[fy] ??= { lines: 0, debitCents: 0, creditCents: 0, accounts: new Set(), firstDate: e.txnDate, lastDate: e.txnDate });
          y.lines++;
          y.debitCents += e.debitCents ?? 0;
          y.creditCents += e.creditCents ?? 0;
          y.accounts.add(e.accountKey);
          if (e.txnDate < y.firstDate) y.firstDate = e.txnDate;
          if (e.txnDate > y.lastDate) y.lastDate = e.txnDate;
          if (!firstDate || e.txnDate < firstDate) firstDate = e.txnDate;
          if (!lastDate || e.txnDate > lastDate) lastDate = e.txnDate;
          accounts.add(e.accountKey);
          pending.push({
            ledgerId: ledger!.id,
            dealId: ledger!.dealId,
            rowNo: e.rowNo,
            sheet: e.sheet,
            txnDate: e.txnDate,
            fiscalYear: fy,
            account: e.account,
            accountKey: e.accountKey,
            accountNumber: e.accountNumber,
            accountType: e.accountType,
            name: e.name,
            memo: e.memo,
            txnType: e.txnType,
            txnNumber: e.txnNumber,
            debitCents: e.debitCents,
            creditCents: e.creditCents,
            amountCents: e.amountCents,
            sensitiveHint: classifyHint(e),
          });
        }
      };
      await readLedgerRows(filePath, kind, async (rows) => {
        if (capped) return;
        rowsRead += rows.length;
        for (const r of rows) parser.push(r);
        take(parser.take());
        await flush();
      }, { fileName });
      if (!capped) take(parser.take(true));
      if (capped) return await failLedger(d, ledger!, doc, capped);
      await flush(true);
      if (saved === 0) {
        return await failLedger(d, ledger!, doc, LEDGER_FAILURES.notLedger);
      }

      // 3. Finish under the deal's GL lock: duplicates, summaries, problems, ready.
      const [analysisYrs, others] = await Promise.all([d.getAnalysisYears(ledger!.dealId), d.store.listLedgers(ledger!.dealId)]);
      const summaries: Record<string, GlYearSummary> = {};
      for (const [y, a] of Object.entries(years)) {
        summaries[y] = { lines: a.lines, debitCents: a.debitCents, creditCents: a.creditCents, accounts: a.accounts.size, firstDate: a.firstDate, lastDate: a.lastDate };
      }
      const otherYears = others
        .filter((l) => l.id !== ledger!.id && l.status === "ready")
        .flatMap((l) => Object.keys((l.years as Record<string, GlYearSummary> | null) ?? {}));
      let fyeMoved: string | null = null;
      await withGlLock(ledger!.dealId, async () => {
        // The fiscal-year end moved while this file was read (the facts changed): its entries follow.
        const fyeNow = (await d.store.getTracing(ledger!.dealId))?.fiscalYearEnd ?? fye;
        if (fyeNow !== fye) {
          await d.store.changeFiscalYearEnd(ledger!.dealId, fyeNow);
          fyeMoved = fyeNow;
        }
        // This file's copies of entries already in an earlier ready file are marked first…
        await d.store.recomputeDuplicates(ledger!.dealId);
        const duplicates = await d.store.countDuplicates(ledger!.id);
        const problems = ledgerProblems({
          years: summaries,
          // An accountant's adjustments file covers what it covers: no "missing years" for it.
          expected: ledger!.role === "adjustments" ? [] : expectedYears(analysisYrs, fye, d.now()),
          otherLedgerYears: otherYears,
          fye,
          basis: detected?.basis ?? parser.stats.basis,
          duplicates,
          skipped: parser.stats.skipped,
          datesAmbiguous: !!detected?.datesAmbiguous,
          currencies: parser.stats.currencies.size,
          today: d.now(),
        });
        await d.store.updateLedger(ledger!.id, {
          status: "ready",
          failure: null,
          software: (detected?.software ?? ledger!.software ?? "other") as GlSoftware,
          basis: detected?.basis ?? parser.stats.basis ?? null,
          layout,
          layoutBy,
          headerFingerprint: fingerprint,
          periodStart: firstDate || null,
          periodEnd: lastDate || null,
          years: summaries,
          rowCount: saved,
          accountCount: accounts.size,
          duplicateCount: duplicates,
          skippedCount: parser.stats.skipped,
          problems,
          progress: { rowsRead, rowsSaved: saved, at: d.now().toISOString() },
          attempts: 0,
        } as Partial<GlLedger>);
        // …then, with this one ready, a later-created file read before it is marked against it too.
        await d.store.recomputeDuplicates(ledger!.dealId);
        await refreshDuplicateCounts(d, ledger!.dealId);
        if (fyeMoved) await (await import("./ledger-years")).recomputeLedgerYears(ledger!.dealId, fyeMoved);
      });
      const fresh = (await d.store.getLedger(ledger!.id))!;

      // 4. The document: a summary only (no figures, no names), never the generic extractor.
      await d.updateDocument(doc.id, {
        status: "extracted",
        isProcessed: true,
        subcategory: "general_ledger",
        extractedText: ledgerDocumentSummary({ software: fresh.software, rowCount: fresh.rowCount, periodStart: fresh.periodStart, periodEnd: fresh.periodEnd, accountCount: fresh.accountCount }),
        extractedData: { summary: ledgerDocumentSummary({ software: fresh.software, rowCount: fresh.rowCount, periodStart: fresh.periodStart, periodEnd: fresh.periodEnd, accountCount: fresh.accountCount }), _glLedgerId: fresh.id },
        sourceMeta: (() => {
          const meta: GlSourceMeta = { ...((doc.sourceMeta as GlSourceMeta | null) ?? {}) };
          delete meta.readFailed;
          return Object.keys(meta).length ? meta : null;
        })(),
      } as Partial<Document>);
      // Credited by name to another checklist row before it was read as a ledger: released (without the "unreadable" note).
      await d.releaseNonGlRequirements(fresh.dealId, doc.id);
      await d.syncRequirement(fresh.dealId);
      await d.store.reattachOrphans(fresh.dealId, fresh.id).catch(() => 0);
      emitGlLedgerStatusChanged(doc.id);
      await d.afterLedgersChanged(fresh.dealId, { ledgerId: fresh.id, uploadedBy: fresh.uploadedBy, change: "ready" }).catch((err) =>
        console.warn(`[gl] follow-up after ledger ${fresh.id} failed:`, err));
    };

    if (kind === "xlsx") await withHeavySheetSlot(run);
    else await run();
  } catch (err) {
    const reason = err instanceof SheetReadError ? err.message : LEDGER_FAILURES.unreadable;
    if (!(err instanceof SheetReadError)) console.error(`[gl] reading ledger ${ledgerId} failed:`, err);
    const current = (await d.store.getLedger(ledgerId).catch(() => undefined)) ?? ledger;
    if (current) await failLedger(d, current, doc, reason).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
  }
}

// ── Startup recovery ─────────────────────────────────────────────────────

/** Reads a restart cut off: rows deleted; re-queued (at most twice), else failed with "Read it again". */
export async function recoverInterruptedLedgerReads(now: Date = new Date()): Promise<{ requeued: number; failed: number }> {
  const d = effectiveDeps();
  let requeued = 0;
  let failed = 0;
  for (const l of await d.store.listReadingLedgers()) {
    if (isLedgerInQueue(l.id)) continue;
    if (now.getTime() - new Date(l.updatedAt).getTime() < GL_STUCK_MS) continue;
    await d.store.deleteTransactionsOfLedger(l.id).catch(() => undefined);
    if ((l.attempts ?? 0) < GL_MAX_ATTEMPTS) {
      await d.store.updateLedger(l.id, { attempts: (l.attempts ?? 0) + 1, progress: null } as Partial<GlLedger>);
      void enqueueLedgerRead(l.id).catch(() => undefined);
      requeued++;
    } else {
      const doc = await d.getDocument(l.documentId);
      await failLedger(d, l, doc, LEDGER_FAILURES.restarted);
      failed++;
    }
  }
  if (requeued) console.warn(`[gl] ${requeued} ledger read(s) a restart cut off were queued again`);
  if (failed) console.warn(`[gl] ${failed} ledger read(s) cut off by restarts too often were marked "Read it again"`);
  return { requeued, failed };
}

/** Runs the recovery at startup and once more when a read cut off just before the restart counts as stuck. */
export function startLedgerReadRecovery(): void {
  const run = () => recoverInterruptedLedgerReads().catch((err) => console.error("[gl] interrupted-read recovery failed:", err));
  void run();
  const later = setTimeout(run, GL_STUCK_MS + 30_000);
  later.unref?.();
}

// ── Removing and re-routing ──────────────────────────────────────────────

/**
 * A ledger's document was deleted (cleanup.ts, INTEGRATION §2.17 step 2):
 * under the GL lock, its entries and its ledger row go, links to its entries
 * keep their snapshot as "orphaned" (a re-upload re-attaches them),
 * duplicates are recomputed (a later file's copies are no longer copies),
 * and the checklist row follows. Never throws.
 */
export async function onLedgerDocumentDeleted(doc: Pick<Document, "id" | "dealId">): Promise<void> {
  const d = effectiveDeps();
  try {
    const ledger = await d.store.getLedgerByDocument(doc.id);
    if (!ledger) return;
    await withGlLock(doc.dealId, async () => {
      await d.store.orphanLinksOfLedger(ledger.id);
      await d.store.deleteTransactionsOfLedger(ledger.id);
      await d.store.deleteLedger(ledger.id);
      await d.store.recomputeDuplicates(doc.dealId);
      // A later file's copies of this one's entries are no longer copies.
      await refreshDuplicateCounts(d, doc.dealId);
    });
    await d.syncRequirement(doc.dealId);
    emitGlLedgerStatusChanged(doc.id);
    await d.afterLedgersChanged(doc.dealId, { ledgerId: ledger.id, uploadedBy: ledger.uploadedBy, change: "removed" }).catch(() => undefined);
  } catch (err) {
    console.warn(`[gl] cleaning up the ledger of deleted document ${doc.id} failed:`, err);
  }
}

/** A ledger's (or support document's) audience changed (the Information tab's switch): the checklist row and, later, traces follow. */
export async function onGlSourceAudienceChanged(documentId: string): Promise<void> {
  const d = effectiveDeps();
  try {
    const doc = await d.getDocument(documentId);
    if (!doc || (doc.subcategory !== "general_ledger" && doc.subcategory !== "addback_support")) return;
    await d.syncRequirement(doc.dealId);
    emitGlLedgerStatusChanged(documentId);
    const ledger = await d.store.getLedgerByDocument(documentId);
    await d.afterLedgersChanged(doc.dealId, { ledgerId: ledger?.id ?? "", uploadedBy: ledger?.uploadedBy ?? "broker", change: "ready" }).catch(() => undefined);
  } catch (err) {
    console.warn(`[gl] audience change for ${documentId} failed:`, err);
  }
}

/** "Read it as a normal document instead": the ledger and its entries go, the file is read like any document. */
export async function readAsNormalDocument(documentId: string): Promise<void> {
  const d = effectiveDeps();
  const doc = await d.getDocument(documentId);
  if (!doc) return;
  await onLedgerDocumentDeleted(doc);
  const meta: GlSourceMeta = { ...((doc.sourceMeta as GlSourceMeta | null) ?? {}), notLedger: true };
  delete meta.glMaybeLedger;
  await d.updateDocument(doc.id, { subcategory: null, sourceMeta: meta, status: "pending" } as Partial<Document>);
  const { ingestDocument } = await import("../documents/ingest");
  void ingestDocument(doc.id).catch((err) => console.error(`[gl] re-reading ${doc.id} as a document failed:`, err));
}

/** The broker says a possible ledger isn't one ("It isn't a ledger"): never offered or sniffed again; its ordinary read stays. */
export async function dismissMaybeLedger(documentId: string): Promise<boolean> {
  const d = effectiveDeps();
  const doc = await d.getDocument(documentId);
  if (!doc) return false;
  const meta: GlSourceMeta = { ...((doc.sourceMeta as GlSourceMeta | null) ?? {}), notLedger: true };
  delete meta.glMaybeLedger;
  await d.updateDocument(doc.id, { sourceMeta: meta } as Partial<Document>);
  return true;
}

/** A document the broker is offered "Read it as a ledger" for (pure): ledger-shaped, not confirmed, not dismissed, not read as one. */
export function isMaybeLedger(doc: Pick<Document, "sourceMeta" | "subcategory" | "fileUrl">): boolean {
  const meta = (doc.sourceMeta as GlSourceMeta | null) ?? null;
  return !!meta?.glMaybeLedger && !meta.notLedger && doc.subcategory !== "general_ledger" && !!ledgerFileKind(doc.fileUrl ?? "");
}

/** "Read as a ledger" (a general-ledger document with no ledger row yet — legacy uploads, a sniff that said no). */
export async function readAsLedger(documentId: string, uploadedBy?: "broker" | "seller"): Promise<GlLedger | null> {
  const d = effectiveDeps();
  const doc = await d.getDocument(documentId);
  if (!doc || !ledgerFileKind(docFileName(doc))) return null;
  const meta: GlSourceMeta = { ...((doc.sourceMeta as GlSourceMeta | null) ?? {}) };
  const wasReadAsDocument = !!meta.glMaybeLedger;
  delete meta.notLedger;
  delete meta.glMaybeLedger;
  await d.updateDocument(doc.id, { subcategory: "general_ledger", sourceMeta: Object.keys(meta).length ? meta : null } as Partial<Document>);
  // A possible ledger was read as an ordinary document first: a ledger is never facts, so what that read merged goes.
  if (wasReadAsDocument) {
    try {
      const { removeSourceFacts } = await import("../documents/cleanup");
      await removeSourceFacts(doc.dealId, doc.id);
    } catch (err) {
      console.warn(`[gl] taking ${doc.id}'s document facts off failed:`, (err as Error).message);
    }
  }
  return startLedgerRead({ ...doc, subcategory: "general_ledger" }, { uploadedBy }, d);
}

/** Re-reads a ledger with the broker's columns ("Read the ledger with these columns"). */
export async function rereadWithLayout(ledger: GlLedger, layout: GlLayout | null, layoutBy: "broker" | "ai" = "broker"): Promise<void> {
  const d = effectiveDeps();
  const doc = await d.getDocument(ledger.documentId);
  if (!doc) return;
  await d.store.updateLedger(ledger.id, {
    status: "reading",
    failure: null,
    ...(layout ? { layout, layoutBy, headerFingerprint: layoutFingerprint(layout) } : { layout: null, layoutBy: null }),
  } as Partial<GlLedger>);
  await d.updateDocument(doc.id, { status: "parsing" } as Partial<Document>);
  emitGlLedgerStatusChanged(doc.id);
  void enqueueLedgerRead(ledger.id).catch(() => undefined);
}

export { normHeader };

/** "Read it again" on a ledger's document: the ledger reader runs again (the layout it had is kept unless the detector's). */
export async function rereadLedgerDocument(documentId: string): Promise<void> {
  const d = effectiveDeps();
  const doc = await d.getDocument(documentId);
  if (!doc) return;
  const ledger = await d.store.getLedgerByDocument(documentId);
  if (!ledger) {
    await readAsLedger(documentId);
    return;
  }
  const keep = ledger.layoutBy === "broker" || ledger.layoutBy === "ai";
  await rereadWithLayout(ledger, keep ? (ledger.layout as GlLayout) : null, (ledger.layoutBy as "broker" | "ai") ?? "broker");
}

/** Resolves when every queued ledger read has finished (tests, scripts). */
export async function glQueueIdle(): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const before = tail;
    await before;
    if (before === tail && queued.size === 0 && running.size === 0) return;
  }
}
