/**
 * serve — the figure layer's inputs for a request (spec §9.1, §9.6).
 *
 *   loadFigureRaw(dealId)          audience-NEUTRAL raw inputs (registry,
 *                                  sources, checks, every note row, key terms,
 *                                  state), cached 60 s per deal and keyed by
 *                                  when each input last changed.
 *   figureInputsFor(raw, opts)     per request, AFTER the cache: the
 *                                  approved-only, citable and ddShownAt
 *                                  filters, opaque ids and the string screen.
 *   buyerFigureInputs(deal, level) the one helper the view route and
 *                                  servedCimFor both use (via buyerCimExtras).
 *
 * A broker preview followed by a buyer view can never serve a suggested
 * note: nothing audience-specific is cached. Serving reads extracted_data
 * and the stored located results — never a document's text.
 */
import { withGlLines, type BridgeAddback } from "./gl-contract";
import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { documents, financialAnalyses, type CimFigureNote, type CimFigureQuestion, type CimFigureState, type Deal } from "@shared/schema";
import type { FigureRegistry } from "@shared/figure-anchors";
import { basisLabel, type NoteBasis } from "@shared/figure-copy";
import { figureCitableDocument, type FigureDocKind, type FigureDocRef, type FigureInputs, type FigureNoteInput, type KeyTermInput } from "@shared/figure-layer";
import { keyTermsFor, type KeyTermFamily } from "@shared/dd-key-terms";
import { cimModeForAccessLevel, isTeaserOnly } from "@shared/access-levels";
import { cimFinancialsFor } from "../cim-financials";
import { figureRegistry } from "./registry";
import { financialSources, sourceKindOf, statementValuesByYear, sourceRef, sourceFor, type FinancialSource, type SourceDoc } from "./sources";
import { buildChecks, type CheckDecision, type ChecksResult } from "./checks";
import { analysisNoteSentences, hintsFor } from "./hints";
import { getFigureState, listDecisions, listNotes, listQuestions, type FigureDb } from "./store";
import { screenCtxFor, stringScreenFor, holdsText, type FigureScreenCtx } from "./guards";

// ── Document kinds for citations (vdr's docKindFor until vdr merges) ───────

/** The citation kind of a document (= vdr docKindFor's buckets; fallback rules). */
export function docKindOf(doc: Pick<SourceDoc, "name" | "extractedData" | "category">): FigureDocKind {
  const kind = sourceKindOf(doc);
  if (kind === "tax_return") return "tax_return";
  if (kind === "statements" || kind === "management") return "financial_statements";
  const t = `${String((doc.extractedData ?? {})._documentType ?? "")} ${doc.name ?? ""}`;
  if (/general ledger|\bg\/l\b|trial balance/i.test(t)) return "general_ledger";
  if (/bank statement/i.test(t)) return "bank_statement";
  if (/\blease\b/i.test(t)) return "lease";
  if (/licen[cs]|permit|certificat|accreditation|registration/i.test(t)) return "licence";
  if (/insurance/i.test(t)) return "insurance";
  if (/contract|agreement|\bmsa\b/i.test(t)) return "contract";
  if (/minute book|articles|bylaws|corporate record|share register/i.test(t)) return "corporate_record";
  if (/payroll|t4\b|staff list|roster/i.test(t)) return "payroll_report";
  if (/fleet list|asset (?:list|register)|equipment list/i.test(t)) return "asset_list";
  if (/revenue|sales report|customer revenue|payer mix/i.test(t)) return "revenue_report";
  if (/receivable|payable|aging/i.test(t)) return "ar_ap_report";
  if (/report|summary|workbook|schedule/i.test(t)) return "operating_report";
  return "other";
}

/** A short phrase for a document kind ("From the lease"). */
const KIND_PHRASE: Partial<Record<FigureDocKind, string>> = {
  financial_statements: "financial statements", tax_return: "tax return", lease: "lease", contract: "contract",
  licence: "licence", insurance: "insurance documents", revenue_report: "revenue report", payroll_report: "payroll report",
  asset_list: "asset list", operating_report: "company's reports", bank_statement: "bank statements", general_ledger: "general ledger",
};

function periodOf(doc: SourceDoc): string | null {
  const pe = String((doc.extractedData ?? {})._periodEnd ?? "");
  const m = pe.match(/^((?:19|20)\d{2})-\d{2}-\d{2}$/);
  return m ? m[1] : null;
}

export interface DocMeta {
  id: string;
  name: string;
  citable: boolean;
  kind: FigureDocKind;
  period: string | null;
  updatedAt: string;
  sourceKind: string | null;
  visibility: string | null;
  /** The broker's link to the file (/uploads/docs/…, gated by the broker's session) — broker payloads only. */
  fileUrl: string | null;
}

// ── Raw inputs (audience-neutral, cached) ──────────────────────────────────

export interface FigureRaw {
  dealId: string;
  stamp: string;
  loadedAt: number;
  info: Record<string, unknown>;
  registry: FigureRegistry;
  sources: FinancialSource[];
  checks: ChecksResult;
  /** The broker's check decisions as read (the refresh locates their corrected figures too). */
  decisions: CheckDecision[];
  notes: CimFigureNote[];
  questions: CimFigureQuestion[];
  state: CimFigureState | null;
  docs: Map<string, DocMeta>;
  keyTerms: KeyTermInput[];
  statementsByYear: Record<string, FigureDocRef>;
  hintSentences: string[];
  screen: FigureScreenCtx;
  analysisId: string | null;
  /** Why there is no registry (no analysis / out of date), for the workspace. */
  noFigures: "no_analysis" | "analysis_out_of_date" | null;
  /** gl contract: the CIM bridge's add-backs (with gl's addbackId once gl is merged). */
  bridgeLines: BridgeAddback[];
}

const CACHE_MS = 60_000;
const cache = new Map<string, FigureRaw>();

/** Drop a deal's cached inputs (any document, note, decision or state write). */
export function invalidateFigureRaw(dealId: string): void {
  cache.delete(dealId);
}

/** Test hook. */
export function _clearFigureRawCache(): void {
  cache.clear();
}

let appDb: FigureDb | null = null;
async function dbOf(d?: FigureDb): Promise<FigureDb> {
  if (d) return d;
  if (!appDb) appDb = (await import("../../db")).db;
  return appDb;
}
function rowsOf(r: unknown): any[] {
  if (Array.isArray(r)) return r;
  const rows = (r as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? rows : [];
}

/** When each input last changed (one round trip). */
export async function figureInputsStamp(dealId: string, d?: FigureDb): Promise<string> {
  const db = await dbOf(d);
  const rows = rowsOf(await db.execute(sql`
    SELECT
      (SELECT updated_at::text FROM deals WHERE id = ${dealId}) AS deal_at,
      (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM documents WHERE deal_id = ${dealId}) AS docs,
      (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM financial_analyses WHERE deal_id = ${dealId}) AS analyses,
      (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM cim_figure_notes WHERE deal_id = ${dealId}) AS notes,
      (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM cim_figure_questions WHERE deal_id = ${dealId}) AS questions,
      (SELECT count(*)::text || ':' || coalesce(max(decided_at)::text, '') FROM dd_check_decisions WHERE deal_id = ${dealId}) AS decisions,
      (SELECT updated_at::text FROM cim_figure_state WHERE deal_id = ${dealId}) AS state`));
  const r = rows[0] ?? {};
  return [r.deal_at, r.docs, r.analyses, r.notes, r.questions, r.decisions, r.state].map((x) => x ?? "-").join("|");
}

export interface RawSourceRows {
  info: Record<string, unknown>;
  docs: SourceDoc[];
  analyses: any[];
  notes: CimFigureNote[];
  questions: CimFigureQuestion[];
  decisions: Array<{ checkKey: string; state: string; correctedValue: string | number | null; valuesSnapshot: { base: number; other: number } }>;
  state: CimFigureState | null;
}

/** Pure: the raw inputs from the rows (shared by loadFigureRaw and the tests). */
export function assembleFigureRaw(dealId: string, rows: RawSourceRows, stamp = ""): FigureRaw {
  const info = rows.info ?? {};
  const docs = new Map<string, DocMeta>();
  for (const d of rows.docs) {
    docs.set(d.id, {
      id: d.id, name: d.name ?? "", citable: figureCitableDocument(d), kind: docKindOf(d), period: periodOf(d),
      updatedAt: d.updatedAt ? new Date(d.updatedAt as any).toISOString() : "", sourceKind: d.sourceKind, visibility: d.visibility,
      fileUrl: d.fileUrl ?? null,
    });
  }
  let fin = null;
  let noFigures: FigureRaw["noFigures"] = null;
  try {
    fin = cimFinancialsFor(rows.analyses as any, rows.docs.map((d) => ({ ...d, name: d.name ?? "", extractedText: null })) as any);
    if (!fin) noFigures = "no_analysis";
  } catch {
    noFigures = "analysis_out_of_date";
  }
  const sources = financialSources(rows.docs);
  const registry = fin ? figureRegistry(fin, info, statementValuesByYear(sources)) : {};
  const decisions = rows.decisions.map((d) => ({
    checkKey: d.checkKey,
    state: d.state as "shown" | "left_out" | "corrected",
    correctedValue: d.correctedValue === null || d.correctedValue === undefined ? null : Number(d.correctedValue),
    valuesSnapshot: d.valuesSnapshot,
  }));
  const checks = buildChecks({ registry, sources, located: (rows.state?.located ?? {}) as any, decisions });
  const screen = screenCtxFor(info, rows.state?.keepOut ?? null);
  const statementsByYear: Record<string, FigureDocRef> = {};
  for (const y of Array.from(new Set(sources.filter((s) => s.kind === "statements").map((s) => s.year)))) {
    const st = sourceFor(sources, "statements", y);
    if (st) statementsByYear[y] = sourceRef(st);
  }
  const analysis = fin ? (rows.analyses as any[]).find((a) => String(a.id) === fin!.analysisId) : null;
  return {
    dealId, stamp, loadedAt: Date.now(), info, registry, sources, checks, decisions,
    notes: rows.notes, questions: rows.questions, state: rows.state, docs,
    keyTerms: keyTermsFromFacts(info, docs, screen),
    statementsByYear,
    hintSentences: analysisNoteSentences(analysis),
    screen,
    analysisId: fin?.analysisId ?? null,
    noFigures,
    bridgeLines: fin?.bridge ? [...(fin.bridge.addbacks ?? []), ...(fin.bridge.sdeOnly ?? [])].map((b) => ({
      label: b.label, amounts: b.amounts, addbackId: (b as { addbackId?: string | null }).addbackId ?? null,
    })) : [],
  };
}

/** D20 key terms from the screened facts, each from a citable document. */
function keyTermsFromFacts(info: Record<string, unknown>, docs: Map<string, DocMeta>, screen: FigureScreenCtx): KeyTermInput[] {
  const sources = ((info as any)._fieldSources ?? {}) as Record<string, any>;
  const citable = (id: string) => !!docs.get(id)?.citable;
  const keep = (t: string) => holdsText(t, screen, { owners: true }) === null;
  const out: KeyTermInput[] = [];
  for (const family of ["location", "customers", "permits"] as KeyTermFamily[]) {
    for (const term of keyTermsFor(family, info, sources, citable, keep)) {
      const doc = docs.get(term.documentId)!;
      out.push({ family, label: term.label, value: term.value, citation: { documentId: doc.id, kind: doc.kind, period: doc.period, page: null, needle: term.needle } });
    }
  }
  return out;
}

export async function loadFigureRaw(dealId: string, d?: FigureDb): Promise<FigureRaw> {
  const stamp = await figureInputsStamp(dealId, d);
  const hit = cache.get(dealId);
  if (hit && hit.stamp === stamp && Date.now() - hit.loadedAt < CACHE_MS) return hit;
  const db = await dbOf(d);
  const [dealRows, docRows, analyses, notes, questions, decisions, state] = await Promise.all([
    db.execute(sql`SELECT extracted_info FROM deals WHERE id = ${dealId}`),
    db.select({
      id: documents.id, name: documents.name, category: documents.category, subcategory: documents.subcategory,
      visibility: documents.visibility, sourceKind: documents.sourceKind, fileUrl: documents.fileUrl, updatedAt: documents.updatedAt,
      extractedData: documents.extractedData,
    }).from(documents).where(eq(documents.dealId, dealId)),
    db.select().from(financialAnalyses).where(eq(financialAnalyses.dealId, dealId)),
    listNotes(dealId, d),
    listQuestions(dealId, d),
    listDecisions(dealId, d),
    getFigureState(dealId, d),
  ]);
  const info = (rowsOf(dealRows)[0]?.extracted_info ?? {}) as Record<string, unknown>;
  const raw = assembleFigureRaw(dealId, { info, docs: docRows as SourceDoc[], analyses, notes, questions, decisions: decisions as any, state }, stamp);
  cache.set(dealId, raw);
  return raw;
}

// ── Per request ──────────────────────────────────────────────────────────

/** Opaque buyer figure id: f_ + HMAC(SESSION_SECRET, dealId|figureKey), 10 hex. */
export function figureIdFor(dealId: string, figureKey: string): string {
  const secret = process.env.SESSION_SECRET || "cimple-dev-figure-ids";
  return `f_${createHmac("sha256", secret).update(`${dealId}|${figureKey}`).digest("hex").slice(0, 10)}`;
}

/** What a note rests on, for the basis line. */
function basisOf(n: CimFigureNote): NoteBasis {
  if (n.origin === "computed") return "computed";
  if (n.origin === "broker") return "broker";
  const kinds = new Set((n.sources ?? []).map((s) => s.kind));
  if (kinds.has("interview")) return "owner";
  if (kinds.has("transcript")) return "conversation";
  if (kinds.has("document")) return "document";
  if (kinds.has("discrepancy")) return "broker";
  if (kinds.has("fact")) return "owner";
  return "computed";
}

/** A note row as the layer reads it (citations filtered to documents that may still be cited). */
export function noteInputOf(n: CimFigureNote, docs: Map<string, DocMeta>): FigureNoteInput {
  const sources = n.sources ?? [];
  const citations: FigureDocRef[] = [];
  let docSources = 0;
  for (const s of sources) {
    if (s.kind !== "document" || !s.documentId) continue;
    docSources++;
    const doc = docs.get(s.documentId);
    if (!doc || !doc.citable) continue;
    if (citations.some((c) => c.documentId === doc.id)) continue;
    citations.push({ documentId: doc.id, kind: doc.kind, period: doc.period, page: s.page ?? null, needle: s.quote ? s.quote.slice(0, 80) : null });
  }
  const nonDocument = sources.filter((s) => s.kind !== "document").length;
  const basis = basisOf(n);
  const firstDoc = citations[0] ? docs.get(citations[0].documentId) : undefined;
  const internal = sources.length > 0 && sources.every((s) => s.internal === true);
  return {
    id: n.id,
    figureKey: n.figureKey,
    kind: n.kind as FigureNoteInput["kind"],
    compareKey: n.compareKey,
    origin: n.origin as FigureNoteInput["origin"],
    status: n.status as FigureNoteInput["status"],
    text: n.text,
    blindText: n.blindText,
    basis,
    basisLabel: basisLabel(basis, { twoDocuments: n.kind === "difference", documentPhrase: firstDoc ? KIND_PHRASE[firstDoc.kind] ?? null : null }),
    citations,
    valuesSnapshot: n.valuesSnapshot as FigureNoteInput["valuesSnapshot"],
    staleReason: n.staleReason,
    groundless: n.origin === "ai" && docSources > 0 && citations.length === 0 && nonDocument === 0,
    ...(internal ? { internalOnly: true } : {}),
  };
}

export interface FigureInputsOptions {
  audience: "buyer" | "broker";
  mode: "blind" | "normal" | "dd";
}

export function figureInputsFor(raw: FigureRaw, opts: FigureInputsOptions): FigureInputs | null {
  if (Object.keys(raw.registry).length === 0) return null;
  const buyer = opts.audience === "buyer";
  const notes = raw.notes
    .filter((n) => (buyer ? n.status === "approved" && !n.staleReason : n.status !== "hidden"))
    .map((n) => noteInputOf(n, raw.docs));
  // Citable at serve time too: a check against a document that has since gone private or been deleted is dropped.
  const citableRef = (r: FigureDocRef | null) => !r || !!raw.docs.get(r.documentId)?.citable;
  const checks = raw.checks.checks.filter((c) => !buyer || (citableRef(c.baseCitation) && citableRef(c.otherCitation)));
  return {
    audience: opts.audience,
    registry: raw.registry,
    notes,
    checks,
    keyTerms: opts.mode === "dd" ? raw.keyTerms.filter((t) => !!raw.docs.get(t.citation.documentId)?.citable) : [],
    ddShownAt: raw.state?.ddShownAt ? new Date(raw.state.ddShownAt as any).toISOString() : null,
    statementsByYear: raw.statementsByYear,
    ...(buyer
      ? { idFor: (k: string) => figureIdFor(raw.dealId, k), screen: stringScreenFor(raw.screen, { owners: opts.mode !== "blind" }) }
      : { hints: hintsFor(Object.keys(raw.registry), raw.registry, raw.hintSentences) }),
  };
}

/**
 * The figure inputs for a buyer at this access level (null for a teaser
 * link, or when anything fails — the CIM then renders as today).
 */
export async function buyerFigureInputs(deal: Pick<Deal, "id">, accessLevel: string | null | undefined): Promise<FigureInputs | null> {
  if (isTeaserOnly(accessLevel)) return null;
  try {
    const raw = await loadFigureRaw(deal.id);
    const mode = cimModeForAccessLevel(accessLevel);
    const inputs = figureInputsFor(raw, { audience: "buyer", mode });
    // gl contract: bridge rows found in the books (DD and Full; empty until gl is merged).
    return mode === "blind" ? inputs : withGlLines(inputs, deal.id, raw.bridgeLines);
  } catch (err) {
    console.warn(`[figures] buyer inputs failed for deal ${deal.id}:`, (err as Error)?.message);
    return null;
  }
}
