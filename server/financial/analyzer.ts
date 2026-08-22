/**
 * Financial Analysis Engine
 *
 * Orchestrates the full financial analysis pipeline for a deal:
 *  1. Gather EVERY knowledge source on the deal:
 *     - financial-category documents (full extracted text -> structured statements)
 *     - tax returns and all other documents (extracted key-value data + relevant text)
 *     - deal.extractedInfo (the merged knowledge base: interview, docs, emails, scrape)
 *     - questionnaireData (seller intake answers)
 *  2. Extract line-item statements from financial documents via the extractor
 *  3. One comprehensive AI pass (claude-sonnet-4-5): reclassify into M&A categories,
 *     identify SDE/EBITDA addbacks, calculate working capital, generate clarifying
 *     questions + insights — AND cross-check values across sources to produce a
 *     discrepancy list (revenue on tax return vs workbook vs email, etc.)
 *  4. Persist results in the UI-native canonical shape (see shape.ts)
 *  5. Route discrepancies into the shared `discrepancies` table
 *     (source = "financial_analysis") so the broker can resolve them inline or
 *     send them to the AI seller interview ("ask_seller").
 */

import Anthropic from "@anthropic-ai/sdk";
import type { IStorage } from "../storage";
import type { Discrepancy, FinancialAnalysis } from "@shared/schema";
import { extractFinancialData, type ExtractedStatement } from "./extractor";
import { getComparables, type CompsResult } from "./comps";
import {
  coerceReclassifiedTable,
  coerceNormalization,
  coerceWorkingCapital,
  coerceClarifyingQuestions,
  coerceInsights,
  computePnlNetIncome,
  findNetIncomeMismatches,
  normalizeFinancialAnalysisRow,
  parseJsonLoose,
  type UiAddback,
  type UiClarifyingQuestion,
  type UiNormalization,
  type UiReclassifiedTable,
} from "./shape";

const anthropic = new Anthropic({ timeout: 600_000 });

// ── Source assembly ──

interface SourceBundle {
  /** Structured statements extracted from financial-category documents */
  statements: ExtractedStatement[];
  /** IDs of every document that contributed */
  sourceDocumentIds: string[];
  /** Rendered text context for tax + other documents */
  otherDocsContext: string;
  /** Rendered knowledge-base (extractedInfo) context */
  knowledgeBaseContext: string;
  /** Rendered questionnaire context */
  questionnaireContext: string;
  /**
   * Authoritative facts: fields the seller confirmed in the interview plus
   * values the broker settled by resolving a discrepancy. Rendered as JSON;
   * empty string when there are none.
   */
  confirmedFactsContext: string;
  /** Discrepancies already on the deal — rendered so the model never re-raises settled ones */
  existingDiscrepanciesContext: string;
  /** Name lookup used when wiring discrepancies to documents */
  docNamesById: Record<string, string>;
}

/**
 * Per-field confidence is written by the interview agent onto the latest
 * interview session (`extractedInfo._confidenceLevels`), not onto the deal.
 * Read it directly; any failure (no DATABASE_URL in tests, no session yet)
 * degrades to "nothing confirmed" rather than failing the run.
 */
async function loadInterviewConfidenceLevels(dealId: string): Promise<Record<string, string>> {
  try {
    const [{ db }, { interviewSessions }, { eq, desc }] = await Promise.all([
      import("../db"),
      import("@shared/schema"),
      import("drizzle-orm"),
    ]);
    const rows = await db
      .select({ extractedInfo: interviewSessions.extractedInfo })
      .from(interviewSessions)
      .where(eq(interviewSessions.dealId, dealId))
      .orderBy(desc(interviewSessions.lastActivityAt))
      .limit(1);
    const meta = (rows[0]?.extractedInfo as Record<string, unknown> | null) || {};
    const levels = meta._confidenceLevels;
    return levels && typeof levels === "object" ? (levels as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Short, stable description of a discrepancy row for the prompt. */
function renderExistingDiscrepancy(d: Discrepancy): string {
  const a = d.interviewValue ? `A: ${d.interviewValue}` : "";
  const b = d.documentValue ? `B: ${d.documentValue}` : "";
  const values = [a, b].filter(Boolean).join(" | ");
  const resolved = d.resolvedValue ? ` → resolved value: ${d.resolvedValue}` : "";
  return `- [${d.id}] ${d.field} (${d.severity}${d.category ? `, ${d.category}` : ""})${values ? ` — ${values}` : ""}${resolved}`;
}

const FINANCIAL_KEYWORDS = [
  "total revenue", "gross revenue", "net income", "gross profit", "net profit",
  "total income", "total expenses", "cost of goods", "cost of sales",
  "salaries", "wages", "retained earnings", "total assets", "total liabilities",
  "shareholder", "ebitda", "sde", "cash flow", "depreciation", "amortization",
  "gifi", "taxable income", "net sales", "inventory", "accounts payable",
  "accounts receivable", "asking price", "addback", "add-back", "working capital",
];

/**
 * Budget-aware text slicing: keep the head of the document, then windows
 * around financial keywords deeper in the text (tax returns bury the GIFI
 * statements hundreds of pages in).
 */
export function sliceRelevantText(text: string, budget: number): string {
  if (text.length <= budget) return text;

  const headBudget = Math.floor(budget * 0.45);
  const head = text.slice(0, headBudget);
  const rest = text.slice(headBudget);
  const restLower = rest.toLowerCase();

  const windows: Array<{ start: number; end: number }> = [];
  const windowSize = 1500;
  for (const kw of FINANCIAL_KEYWORDS) {
    let idx = restLower.indexOf(kw);
    let guard = 0;
    while (idx !== -1 && guard < 20) {
      windows.push({ start: Math.max(0, idx - 200), end: idx + windowSize });
      idx = restLower.indexOf(kw, idx + windowSize);
      guard++;
    }
  }

  if (windows.length === 0) {
    return head + "\n[... truncated ...]\n" + rest.slice(-Math.floor(budget * 0.2));
  }

  // Merge overlapping windows, keep within remaining budget
  windows.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }

  let remaining = budget - headBudget;
  const chunks: string[] = [head];
  for (const w of merged) {
    if (remaining <= 0) break;
    const len = Math.min(w.end - w.start, remaining);
    chunks.push(`\n[... skipped to offset ${headBudget + w.start} ...]\n` + rest.slice(w.start, w.start + len));
    remaining -= len;
  }
  return chunks.join("");
}

function isTaxDocument(doc: { name: string; category: string | null; subcategory?: string | null }): boolean {
  const s = `${doc.name} ${doc.category ?? ""} ${doc.subcategory ?? ""}`.toLowerCase();
  return /\btax\b|t2\b|t1\b|1120|1065|1040|notice of assessment|gifi/.test(s);
}

async function assembleSources(
  dealId: string,
  storage: IStorage,
  deal: { extractedInfo: unknown; questionnaireData: unknown },
  existingDiscrepancies: Discrepancy[],
): Promise<SourceBundle> {
  const allDocs = await storage.getDocumentsByDeal(dealId);
  const processedDocs = allDocs.filter(
    (d) => d.isProcessed && ((d.extractedText && d.extractedText.trim().length > 0) || d.extractedData),
  );

  const docNamesById: Record<string, string> = {};
  for (const d of processedDocs) docNamesById[d.id] = d.name;

  // 1. Financial-category docs -> full structured extraction
  const financialDocs = processedDocs.filter(
    (d) => d.category === "financials" && d.extractedText && d.extractedText.trim().length >= 50,
  );
  // Per-doc failures (network blips, malformed output) must not kill the run —
  // the comprehensive pass still has the other docs + raw context to work with.
  const statementArrays = await Promise.all(
    financialDocs.map(async (doc) => {
      try {
        return await extractFinancialData(doc.extractedText!, doc.id, doc.name);
      } catch (err: any) {
        console.error(`Statement extraction failed for "${doc.name}" — continuing without it:`, err.message);
        return [] as ExtractedStatement[];
      }
    }),
  );
  const statements = statementArrays.flat();

  // Financial docs whose structured extraction produced nothing still carry
  // signal — pass their raw text to the comprehensive pass instead.
  const unparsedFinancialDocs = financialDocs.filter(
    (_, i) => statementArrays[i].length === 0,
  );

  // 2. Tax + other docs -> key-value data + relevant text slices
  const nonFinancialDocs = processedDocs.filter((d) => d.category !== "financials");
  const taxDocs = nonFinancialDocs.filter(isTaxDocument);
  const otherDocs = nonFinancialDocs.filter((d) => !isTaxDocument(d));

  const renderDoc = (
    doc: { id: string; name: string; category: string | null; extractedText: string | null; extractedData: unknown },
    textBudget: number,
  ): string => {
    const parts: string[] = [`### ${doc.name} (category: ${doc.category ?? "other"}, ID: ${doc.id})`];
    if (doc.extractedData) {
      const dataStr = JSON.stringify(doc.extractedData);
      if (dataStr.length > 20 && !dataStr.includes("Extraction failed")) {
        parts.push(`Extracted data: ${dataStr.slice(0, 4000)}`);
      }
    }
    if (doc.extractedText && doc.extractedText.trim().length > 0 && textBudget > 0) {
      parts.push(`Text:\n${sliceRelevantText(doc.extractedText, textBudget)}`);
    }
    return parts.join("\n");
  };

  const otherDocsContext = [
    ...unparsedFinancialDocs.map((d) => renderDoc(d, 25000)),
    ...taxDocs.map((d) => renderDoc(d, 25000)),
    ...otherDocs.map((d) => renderDoc(d, 4000)),
  ].join("\n\n---\n\n");

  // 3. Knowledge base (extractedInfo) — the merged view of interview, docs,
  //    emails, and scrape. Numbers stated in emails/calls land here.
  const extractedInfo = Object.fromEntries(
    Object.entries((deal.extractedInfo as Record<string, unknown>) || {}).filter(
      // "_"-prefixed keys are broker-private / session-meta — not analysis input
      ([k]) => !k.startsWith("_"),
    ),
  );

  // 3b. Confirmed facts — the subset of the knowledge base the seller confirmed
  //     in the interview, plus values the broker settled by resolving a
  //     discrepancy. Rendered separately and marked authoritative so insights
  //     and the normalization never cite a scraped/inferred figure over a
  //     confirmed one (e.g. an owner name or revenue split the seller corrected).
  const confidenceLevels = await loadInterviewConfidenceLevels(dealId);
  const confirmedFacts: Record<string, unknown> = {};
  for (const [field, level] of Object.entries(confidenceLevels)) {
    if (level !== "confirmed") continue;
    const value = extractedInfo[field];
    if (value !== undefined && value !== null && value !== "") confirmedFacts[field] = value;
  }
  for (const d of existingDiscrepancies) {
    if ((d.status === "resolved" || d.status === "accepted") && d.resolvedValue && d.field) {
      confirmedFacts[d.field] = d.resolvedValue;
      // The resolved value also replaces the stale figure in the knowledge-base view
      if (hasOwn(extractedInfo, d.field)) extractedInfo[d.field] = d.resolvedValue;
    }
  }
  let confirmedFactsContext = "";
  if (Object.keys(confirmedFacts).length > 0) {
    const json = JSON.stringify(confirmedFacts, null, 1);
    confirmedFactsContext = json.length > 12000 ? json.slice(0, 12000) + "\n... [truncated]" : json;
  }

  let knowledgeBaseContext = "";
  if (Object.keys(extractedInfo).length > 0) {
    const json = JSON.stringify(extractedInfo, null, 1);
    knowledgeBaseContext = json.length > 20000 ? json.slice(0, 20000) + "\n... [truncated]" : json;
  }

  // 3c. Discrepancies already raised on this deal. Resolved ones must not be
  //     re-raised under a new name; open ones must be re-evaluated by id so a
  //     still-valid conflict is refreshed in place instead of dropped.
  const liveExisting = existingDiscrepancies.filter((d) => d.status !== "superseded");
  const settled = liveExisting.filter((d) => d.status === "resolved" || d.status === "accepted");
  const unsettled = liveExisting.filter((d) => d.status !== "resolved" && d.status !== "accepted");
  const existingDiscrepanciesContext = liveExisting.length === 0
    ? ""
    : [
        settled.length > 0
          ? `RESOLVED BY THE BROKER (settled — never raise these again, under this name or any other; the resolved value is authoritative):\n${settled.map(renderExistingDiscrepancy).join("\n")}`
          : "",
        unsettled.length > 0
          ? `STILL OPEN OR WITH THE SELLER (re-evaluate each one against the sources; if it still conflicts, return it in "discrepancies" with its "existingId"; if the sources now agree, list its id in "clearedDiscrepancyIds"):\n${unsettled.map(renderExistingDiscrepancy).join("\n")}`
          : "",
      ].filter(Boolean).join("\n\n");

  // 4. Questionnaire
  const questionnaireData = (deal.questionnaireData as Record<string, unknown>) || null;
  let questionnaireContext = "";
  if (questionnaireData && Object.keys(questionnaireData).length > 0) {
    const json = JSON.stringify(questionnaireData, null, 1);
    questionnaireContext = json.length > 8000 ? json.slice(0, 8000) + "\n... [truncated]" : json;
  }

  const contributingDocIds = [
    ...financialDocs.map((d) => d.id),
    ...taxDocs.map((d) => d.id),
    ...otherDocs.filter((d) => d.extractedData || d.extractedText).map((d) => d.id),
  ];

  return {
    statements,
    sourceDocumentIds: contributingDocIds,
    otherDocsContext,
    knowledgeBaseContext,
    questionnaireContext,
    confirmedFactsContext,
    existingDiscrepanciesContext,
    docNamesById,
  };
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ── Public entry point ──

/**
 * Create the "running" placeholder row for a new analysis version.
 *
 * Routes call this synchronously BEFORE responding so the client's first
 * refetch is guaranteed to see status "running" (and start polling). The
 * placeholder id is then handed to runFinancialAnalysis in the background.
 */
export async function createAnalysisPlaceholder(
  dealId: string,
  storage: IStorage,
): Promise<{ id: string; version: number }> {
  const existing = await storage.getFinancialAnalysesByDeal(dealId);
  const nextVersion = existing.length > 0 ? (existing[0].version ?? 0) + 1 : 1;
  const analysis = await storage.createFinancialAnalysis({
    dealId,
    version: nextVersion,
    status: "running",
  });
  return { id: analysis.id, version: nextVersion };
}

export async function runFinancialAnalysis(
  dealId: string,
  storage: IStorage,
  opts: { analysisId?: string } = {},
): Promise<string> {
  // Use the pre-created placeholder when the route made one; otherwise create
  // it here. This is the only work outside the try: if there is no row yet,
  // there is nothing to mark failed.
  const analysis = opts.analysisId
    ? { id: opts.analysisId }
    : await createAnalysisPlaceholder(dealId, storage);

  // Everything from here on — including loading the deal — runs inside the
  // try so EVERY failure path marks the placeholder failed. Previously a
  // throw before the try left the row "running" forever and the UI polling.
  try {
    // 1. Load deal
    const deal = await storage.getDeal(dealId);
    if (!deal) throw new Error(`Deal ${dealId} not found`);

    // 2. Gather every source on the deal — including what earlier runs and the
    //    broker already settled (resolved discrepancies, confirmed facts).
    const existingDiscrepancies = await storage.getDiscrepanciesByDeal(dealId);
    const sources = await assembleSources(dealId, storage, deal, existingDiscrepancies);

    const hasAnyData =
      sources.statements.length > 0 ||
      sources.otherDocsContext.length > 0 ||
      sources.knowledgeBaseContext.length > 0 ||
      sources.questionnaireContext.length > 0;

    if (!hasAnyData) {
      await storage.updateFinancialAnalysis(analysis.id, {
        status: "failed",
        aiReasoning:
          "No usable data found for this deal — no processed documents, knowledge base entries, or questionnaire answers. Upload and process financial documents first.",
      });
      return analysis.id;
    }

    // The most recent finished version before this one: its broker edits
    // (custom addbacks, reclassifications, approval toggles, answered /
    // dismissed / routed questions) are carried into the new version below.
    const previous = (await storage.getFinancialAnalysesByDeal(dealId)).find(
      (fa) => fa.id !== analysis.id && (fa.status === "completed" || fa.status === "reviewed"),
    );

    // 3. Comprehensive AI analysis across all sources
    const freshResult = await runComprehensiveAnalysis(deal, sources);

    // 3b. Deterministic post-passes: tie the reclassified P&L to reported net
    //     income, then re-apply the broker's decisions from the previous version.
    const reconciled = reconcileNetIncome(freshResult.reclassifiedPnl, freshResult.normalization);
    const analysisResult: AnalysisOutput = previous
      ? carryForwardBrokerEdits(normalizeFinancialAnalysisRow(previous), {
          ...freshResult,
          reclassifiedPnl: reconciled.pnl,
          normalization: reconciled.normalization,
        })
      : { ...freshResult, reclassifiedPnl: reconciled.pnl, normalization: reconciled.normalization };

    // 4. Pull comps (stub for now)
    const latestRevenue = deriveLatestRevenue(analysisResult.reclassifiedPnl);
    const latestSde = deriveLatestAdjusted(analysisResult.normalization);
    const comps: CompsResult = await getComparables(deal.industry, latestRevenue, latestSde);

    // 5. Save everything (canonical shape — renders directly in the UI)
    await storage.updateFinancialAnalysis(analysis.id, {
      status: "completed",
      reclassifiedPnl: analysisResult.reclassifiedPnl,
      reclassifiedBalanceSheet: analysisResult.reclassifiedBalanceSheet,
      reclassifiedCashFlow: analysisResult.reclassifiedCashFlow,
      arAging: sources.statements.find((s) => s.statementType === "ar_aging") ?? null,
      normalization: analysisResult.normalization,
      workingCapital: analysisResult.workingCapital,
      comps,
      insights: analysisResult.insights,
      clarifyingQuestions: analysisResult.clarifyingQuestions,
      sourceDocumentIds: sources.sourceDocumentIds,
      aiReasoning: analysisResult.aiReasoning,
    });

    // 6. Route cross-source discrepancies into the shared discrepancies table
    await persistFinancialDiscrepancies(
      dealId,
      storage,
      analysisResult.discrepancies,
      analysisResult.clearedDiscrepancyIds,
      sources.docNamesById,
      existingDiscrepancies,
    );

    return analysis.id;
  } catch (err: any) {
    console.error("Financial analysis failed:", err);
    // If even the failure write throws (DB down), log it rather than rejecting
    // into the route's fire-and-forget .catch — the GET handler's 15-minute
    // stale-running reconciliation is the backstop for that case.
    await storage
      .updateFinancialAnalysis(analysis.id, {
        status: "failed",
        aiReasoning: `Analysis failed: ${err?.message ?? String(err)}`,
      })
      .catch((writeErr: any) => {
        console.error("Could not mark financial analysis as failed:", writeErr);
      });
    return analysis.id;
  }
}

// ── Derivations for comps ──

function deriveLatestRevenue(pnl: any): number | null {
  if (!pnl?.years?.length || !Array.isArray(pnl.rows)) return null;
  const latest = pnl.years[pnl.years.length - 1];
  const total = pnl.rows
    .filter((r: any) => r.category === "Revenue")
    .reduce((sum: number, r: any) => sum + (Number(r.values?.[latest]) || 0), 0);
  return total !== 0 ? total : null;
}

function deriveLatestAdjusted(norm: any): number | null {
  if (!norm?.years?.length) return null;
  const latest = norm.years[norm.years.length - 1];
  let total = Number(norm.netIncome?.[latest]) || 0;
  for (const ab of norm.addbacks ?? []) {
    if (ab.approved) total += Number(ab.amounts?.[latest]) || 0;
  }
  return total !== 0 ? total : null;
}

// ── Net income reconciliation ──

/**
 * The Income Statement tab computes net income from the reclassified rows;
 * the Normalization tab starts from the reported net income the model put in
 * normalization.netIncome. They must agree. The usual way they diverge is a
 * carve-out: the model adds "Renovation (one-time)" as a Non-Recurring row
 * but leaves the full amount inside its parent line, double-counting it.
 *
 * When the delta for every mismatched year equals that year's Non-Recurring
 * total, the carve-outs are double counted and are moved to "Excluded"
 * (still visible, no longer deducted — the parent already carries them, and
 * the addback in the normalization still adds them back). Any other delta is
 * flagged in the notes of both panels so the broker sees it instead of
 * trusting two different net-income figures.
 */
export function reconcileNetIncome(
  pnl: UiReclassifiedTable | null,
  normalization: UiNormalization | null,
): { pnl: UiReclassifiedTable | null; normalization: UiNormalization | null } {
  const mismatches = findNetIncomeMismatches(pnl, normalization);
  if (mismatches.length === 0 || !pnl || !normalization) return { pnl, normalization };

  const fmt = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
  const nonRecurringRows = pnl.rows.filter((r) => r.category === "Non-Recurring");
  const nonRecurringTotal = (year: string) =>
    nonRecurringRows.reduce((s, r) => s + Math.abs(r.values?.[year] ?? 0), 0);

  // Every mismatch explained by the Non-Recurring rows → deterministic repair.
  const allExplainedByCarveOuts =
    nonRecurringRows.length > 0 &&
    mismatches.every((m) => {
      const nr = nonRecurringTotal(m.year);
      const tolerance = Math.max(100, Math.abs(m.reported) * 0.005);
      return nr > 0 && Math.abs(m.delta + nr) <= tolerance;
    });

  if (allExplainedByCarveOuts) {
    const labels = nonRecurringRows.map((r) => r.name).join(", ");
    const repairedRows = pnl.rows.map((r) =>
      r.category === "Non-Recurring" ? { ...r, category: "Excluded" } : r,
    );
    const note =
      `One-time items (${labels}) were listed as separate rows without being deducted from their parent lines, ` +
      `which understated net income by ${mismatches.map((m) => `${fmt(Math.abs(m.delta))} in ${m.year}`).join(", ")}. ` +
      `They are shown under Excluded for reference — the parent line already includes them and the normalization adds them back.`;
    const repairedPnl = { ...pnl, rows: repairedRows, notes: [...(pnl.notes ?? []), note] };
    const remaining = findNetIncomeMismatches(repairedPnl, normalization);
    if (remaining.length === 0) {
      return {
        pnl: repairedPnl,
        normalization: {
          ...normalization,
          notes: [
            ...(normalization.notes ?? []),
            `Income Statement net income now ties to the reported net income used here (one-time carve-outs moved to Excluded on the Income Statement).`,
          ],
        },
      };
    }
  }

  // Unexplained delta — flag on both panels, change nothing.
  const detail = mismatches
    .map((m) => `${m.year}: Income Statement ${fmt(m.reclassified)} vs reported ${fmt(m.reported)} (${m.delta > 0 ? "+" : "−"}${fmt(Math.abs(m.delta))})`)
    .join("; ");
  const pnlNote = `Net income computed from these rows does not tie to the reported net income in the normalization — ${detail}. Check for a carved-out one-time item still included in its parent line, or a line item missing from the extraction.`;
  const normNote = `Reported net income does not tie to the Income Statement rows — ${detail}. The normalization starts from the reported figure; review the Income Statement reclassification before relying on either.`;
  return {
    pnl: { ...pnl, notes: [...(pnl.notes ?? []), pnlNote] },
    normalization: { ...normalization, notes: [...(normalization.notes ?? []), normNote] },
  };
}

// ── Carry-forward of broker edits across versions ──

function normalizeLabel(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const QUESTION_STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "this", "that", "with", "from", "can", "you",
  "your", "please", "confirm", "what", "which", "does", "did", "has", "have", "any", "how",
  "there", "their", "about", "into", "over", "per", "year", "years",
]);

function questionTokens(q: string): Set<string> {
  return new Set(
    normalizeLabel(q)
      .split(" ")
      .filter((t) => t.length >= 3 && !QUESTION_STOPWORDS.has(t)),
  );
}

/** Jaccard similarity on meaningful tokens — 0..1. */
function questionSimilarity(a: string, b: string): number {
  const ta = questionTokens(a);
  const tb = questionTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  ta.forEach((t) => { if (tb.has(t)) inter++; });
  return inter / (ta.size + tb.size - inter);
}

function carryForwardTable(
  prev: UiReclassifiedTable | null | undefined,
  fresh: UiReclassifiedTable | null,
): UiReclassifiedTable | null {
  if (!fresh || !prev?.rows) return fresh;
  const overrides = new Map<string, string>();
  for (const row of prev.rows) {
    if (row.categoryOverride && row.name) overrides.set(normalizeLabel(row.name), row.category);
  }
  if (overrides.size === 0) return fresh;
  return {
    ...fresh,
    rows: fresh.rows.map((row) => {
      const category = overrides.get(normalizeLabel(row.name));
      return category && category !== row.category
        ? { ...row, category, categoryOverride: true }
        : category
          ? { ...row, categoryOverride: true }
          : row;
    }),
  };
}

function carryForwardNormalization(
  prev: UiNormalization | null | undefined,
  fresh: UiNormalization | null,
): UiNormalization | null {
  if (!fresh || !prev) return fresh;
  let addbacks: UiAddback[] = fresh.addbacks.map((ab) => ({ ...ab }));
  const byLabel = new Map(addbacks.map((ab) => [normalizeLabel(ab.label), ab]));

  for (const prevAb of prev.addbacks ?? []) {
    const key = normalizeLabel(prevAb.label);
    const match = byLabel.get(key);
    const isCustom = prevAb.custom === true || (typeof prevAb.id === "string" && prevAb.id.startsWith("custom_"));
    if (isCustom) {
      // Broker-added addback: keep it unless the AI now produces the same line.
      if (!match) {
        const carried: UiAddback = { ...prevAb, custom: true };
        addbacks.push(carried);
        byLabel.set(key, carried);
      }
      continue;
    }
    if (prevAb.approvedOverride && match) {
      match.approved = prevAb.approved;
      match.approvedOverride = true;
    }
  }

  return {
    ...fresh,
    addbacks,
    ...(prev.metricOverride ? { metric: prev.metric, metricOverride: true } : {}),
  };
}

function carryForwardQuestions(
  prev: UiClarifyingQuestion[] | null | undefined,
  fresh: UiClarifyingQuestion[] | null,
  prevVersion: number,
): UiClarifyingQuestion[] | null {
  const settledPrev = (prev ?? []).filter(
    (q) => q.status === "answered" || q.status === "dismissed" || q.status === "routed_to_seller",
  );
  if (settledPrev.length === 0) return fresh;

  const out: UiClarifyingQuestion[] = (fresh ?? []).map((q) => ({ ...q }));
  const usedIds = new Set(out.map((q) => q.id));
  const claimed = new Set<number>();

  for (const prevQ of settledPrev) {
    // Best fresh match by token overlap (exact normalized text always wins).
    let bestIdx = -1;
    let bestScore = 0;
    out.forEach((q, idx) => {
      if (claimed.has(idx)) return;
      const score = normalizeLabel(q.question) === normalizeLabel(prevQ.question) ? 1 : questionSimilarity(q.question, prevQ.question);
      if (score > bestScore) { bestScore = score; bestIdx = idx; }
    });

    const carriedFromVersion = prevQ.carriedFromVersion ?? prevVersion;
    if (bestIdx >= 0 && bestScore >= 0.6) {
      claimed.add(bestIdx);
      out[bestIdx] = {
        ...out[bestIdx],
        status: prevQ.status,
        answer: prevQ.answer,
        discrepancyId: prevQ.discrepancyId,
        carriedFromVersion,
      };
      continue;
    }

    // No equivalent question this run — keep the settled one so its answer
    // (and any routed ask_seller discrepancy) stays reachable from this version.
    let id = prevQ.id;
    if (usedIds.has(id)) id = `${id}_v${prevVersion}`;
    usedIds.add(id);
    out.push({ ...prevQ, id, carriedFromVersion });
  }

  return out.length > 0 ? out : fresh;
}

/**
 * Re-apply the broker's decisions from the previous finished version onto a
 * fresh AI result. Nothing here is the AI's call: reclassifications, approval
 * toggles, custom addbacks, the base metric, and answered / dismissed / routed
 * questions are all explicit broker actions that a re-run must not undo.
 */
export function carryForwardBrokerEdits(
  previous: Pick<FinancialAnalysis, "version" | "reclassifiedPnl" | "reclassifiedBalanceSheet" | "reclassifiedCashFlow" | "normalization" | "clarifyingQuestions">,
  fresh: AnalysisOutput,
): AnalysisOutput {
  const prevVersion = previous.version ?? 0;
  return {
    ...fresh,
    reclassifiedPnl: carryForwardTable(previous.reclassifiedPnl as UiReclassifiedTable | null, fresh.reclassifiedPnl),
    reclassifiedBalanceSheet: carryForwardTable(previous.reclassifiedBalanceSheet as UiReclassifiedTable | null, fresh.reclassifiedBalanceSheet),
    reclassifiedCashFlow: carryForwardTable(previous.reclassifiedCashFlow as UiReclassifiedTable | null, fresh.reclassifiedCashFlow),
    normalization: carryForwardNormalization(previous.normalization as UiNormalization | null, fresh.normalization),
    clarifyingQuestions: carryForwardQuestions(
      previous.clarifyingQuestions as UiClarifyingQuestion[] | null,
      fresh.clarifyingQuestions,
      prevVersion,
    ),
  };
}

// ── Discrepancy persistence ──

export interface FinancialDiscrepancyItem {
  field: string; // short human-readable metric name, e.g. "2025 Revenue"
  sourceA: { source: string; value: string };
  sourceB: { source: string; value: string };
  documentId?: string; // the document backing sourceB, when applicable
  severity: "critical" | "significant" | "minor";
  category: "financial" | "operational" | "legal" | "factual";
  explanation: string;
  suggestedResolution: string;
  /** Id of a previously raised discrepancy this finding corresponds to (model-supplied). */
  existingId?: string;
}

const DISCREPANCY_CATEGORIES = ["financial", "operational", "legal", "factual"] as const;

function normalizeFieldKey(field: string): string {
  return (field || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function bareValue(v: string | null | undefined): string {
  if (!v) return "";
  const idx = v.indexOf(" — ");
  return normalizeLabel(idx > 0 ? v.slice(0, idx) : v);
}

/**
 * Deterministic backstop for the model's existingId: a fresh finding is the
 * same conflict as an existing row when the field keys match, or when the
 * fields share a meaningful word AND one of the values is the same.
 */
function matchesExisting(item: FinancialDiscrepancyItem, existing: Discrepancy): boolean {
  if (normalizeFieldKey(item.field) === normalizeFieldKey(existing.field)) return true;
  const shared = questionSimilarity(item.field, existing.field);
  if (shared === 0) return false;
  const itemValues = new Set([normalizeLabel(item.sourceA.value), normalizeLabel(item.sourceB.value)].filter(Boolean));
  const existingValues = [
    bareValue(existing.interviewValue),
    bareValue(existing.documentValue),
    normalizeLabel(existing.resolvedValue),
  ].filter(Boolean);
  return existingValues.some((v) => itemValues.has(v)) || shared >= 0.5;
}

/**
 * Write the run's discrepancies into the shared table without losing history:
 *  - a finding that corresponds to a RESOLVED row (by existingId, field key,
 *    or value match) is dropped — the broker already settled it;
 *  - a finding that corresponds to an OPEN / routed row refreshes that row in
 *    place (status untouched) instead of creating a duplicate;
 *  - open rows the model explicitly cleared are superseded;
 *  - every other open row is left alone — a run that did not re-evaluate a
 *    conflict must never make it disappear.
 */
async function persistFinancialDiscrepancies(
  dealId: string,
  storage: IStorage,
  items: FinancialDiscrepancyItem[],
  clearedIds: string[],
  docNamesById: Record<string, string>,
  existing: Discrepancy[],
): Promise<void> {
  const live = existing.filter((d) => d.status !== "superseded");
  const byId = new Map(live.map((d) => [d.id, d]));
  const settled = live.filter((d) => d.status === "resolved" || d.status === "accepted");
  const unsettled = live.filter((d) => d.status !== "resolved" && d.status !== "accepted");
  const refreshed = new Set<string>();

  for (const item of items) {
    const referenced = item.existingId ? byId.get(item.existingId) : undefined;
    const settledMatch = referenced && settled.includes(referenced)
      ? referenced
      : settled.find((d) => matchesExisting(item, d));
    if (settledMatch) continue; // already settled by the broker

    const openMatch = referenced && unsettled.includes(referenced)
      ? referenced
      : unsettled.find((d) => d.source === "financial_analysis" && !refreshed.has(d.id) && matchesExisting(item, d));

    const documentName = item.documentId ? docNamesById[item.documentId] ?? null : null;
    const values = {
      interviewValue: `${item.sourceA.value} — ${item.sourceA.source}`,
      documentValue: `${item.sourceB.value} — ${item.sourceB.source}`,
      documentId: item.documentId ?? null,
      documentName,
      severity: item.severity,
      category: item.category,
      aiExplanation: item.explanation,
      suggestedResolution: item.suggestedResolution,
    };

    if (openMatch) {
      refreshed.add(openMatch.id);
      if (openMatch.source !== "financial_analysis") continue; // interview-check rows are not ours to rewrite
      // Refresh the finding; keep the broker's routing/status and the original field name.
      await storage.updateDiscrepancy(openMatch.id, values);
      continue;
    }

    const created = await storage.createDiscrepancy({
      dealId,
      field: item.field,
      ...values,
      source: "financial_analysis",
      status: "open",
    });
    unsettled.push(created);
    refreshed.add(created.id);
  }

  // Explicitly cleared by this run: the sources now agree. Rows the broker
  // routed to the seller stay with the seller — only untouched open rows close.
  for (const id of clearedIds) {
    const row = byId.get(id);
    if (!row || row.source !== "financial_analysis" || refreshed.has(id)) continue;
    if (row.status !== "open" && row.status !== "seller_responded") continue;
    await storage.updateDiscrepancy(id, { status: "superseded" });
  }
}

// ── Comprehensive AI analysis ──

export interface AnalysisOutput {
  reclassifiedPnl: UiReclassifiedTable | null;
  reclassifiedBalanceSheet: UiReclassifiedTable | null;
  reclassifiedCashFlow: UiReclassifiedTable | null;
  normalization: UiNormalization | null;
  workingCapital: any;
  insights: any;
  clarifyingQuestions: UiClarifyingQuestion[] | null;
  discrepancies: FinancialDiscrepancyItem[];
  /** Ids of previously open discrepancies the model re-evaluated and found no longer conflicting. */
  clearedDiscrepancyIds: string[];
  aiReasoning: string;
}

async function runComprehensiveAnalysis(
  deal: { industry: string; subIndustry?: string | null; businessName: string },
  sources: SourceBundle,
): Promise<AnalysisOutput> {
  const statementsJson = JSON.stringify(sources.statements, null, 1);

  // Streamed to keep the connection alive — this generation can run for
  // minutes and idle non-streaming requests get killed by network timeouts.
  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-5",
    max_tokens: 24000,
    // Classification and working-capital figures must be reproducible run to
    // run on the same sources — no sampling noise in a number the broker quotes.
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `You are a senior M&A financial analyst preparing a financial analysis for a Confidential Information Memorandum (CIM). You specialize in sell-side M&A advisory for small to mid-market businesses.

BUSINESS: ${deal.businessName}
INDUSTRY: ${deal.industry}${deal.subIndustry ? ` / ${deal.subIndustry}` : ""}

You have EVERY source of information collected on this deal. Numbers get stated in tax returns, internal statements, valuation workbooks, emails, call notes, and the seller interview — they often disagree. Use ALL sources, prefer the most authoritative for the analysis itself (tax returns > accountant statements > internal statements > workbook > interview/email claims), and flag disagreements as discrepancies.

═══ SOURCE 0: CONFIRMED FACTS (authoritative — confirmed by the seller in the interview or settled by the broker; these OVERRIDE any conflicting figure, name, or split in the sources below) ═══
${sources.confirmedFactsContext || "(none)"}

═══ SOURCE 1: STRUCTURED FINANCIAL STATEMENTS (extracted from financial documents; each has sourceDocumentId + sourceDocumentName) ═══
${statementsJson || "(none)"}

═══ SOURCE 2: TAX RETURNS AND OTHER DOCUMENTS (extracted data + relevant text) ═══
${sources.otherDocsContext || "(none)"}

═══ SOURCE 3: DEAL KNOWLEDGE BASE (merged from seller interview, emails, calls, documents — field names hint at origin) ═══
${sources.knowledgeBaseContext || "(none)"}

═══ SOURCE 4: SELLER QUESTIONNAIRE ═══
${sources.questionnaireContext || "(none)"}

═══ PREVIOUSLY RAISED DISCREPANCIES ═══
${sources.existingDiscrepanciesContext || "(none)"}

INSTRUCTIONS:

Perform a comprehensive M&A financial analysis. Be industry-aware — different industries have different standard charts of accounts, typical addbacks, working capital norms, and red flags (e-commerce: platform fees, return rates, ad spend %, inventory; construction: WIP, holdbacks, bonding; restaurants: food/labor cost %, lease; professional services: utilization, partner comp; etc.).

Respond with valid JSON matching this EXACT structure (this is the shape the broker's UI renders — follow it precisely):

{
  "reclassifiedPnl": {
    "years": ["2022", "2023", "2024", "2025"],
    "rows": [
      { "name": "Product Sales", "category": "Revenue", "values": { "2022": 800000, "2023": 900000 } }
    ],
    "notes": ["..."]
  },

  "reclassifiedBalanceSheet": {
    "years": ["2023", "2024"],
    "rows": [
      { "name": "Cash", "category": "Current Assets", "values": { "2023": 50000, "2024": 75000 } }
    ],
    "notes": ["..."]
  },

  "reclassifiedCashFlow": {
    "years": ["2023", "2024"],
    "rows": [
      { "name": "Cash from Operations", "category": "Operating", "values": { "2023": 200000, "2024": 250000 } }
    ],
    "notes": ["..."]
  },

  "normalization": {
    "metric": "sde",
    "years": ["2022", "2023", "2024", "2025"],
    "netIncome": { "2022": 140000, "2023": 170000 },
    "addbacks": [
      {
        "label": "Owner salary above market",
        "description": "Owner takes $200K; market replacement is $110K",
        "category": "owner_comp",
        "type": "sde",
        "amounts": { "2022": 80000, "2023": 85000 },
        "confidence": "high"
      }
    ],
    "notes": ["..."]
  },

  "workingCapital": {
    "asOfPeriod": "2024",
    "currentAssets": [ { "name": "Cash", "amount": 91402 }, { "name": "Inventory", "amount": 71712 } ],
    "currentLiabilities": [ { "name": "Accounts Payable", "amount": 20000 } ],
    "netWorkingCapital": 143114,
    "targetNwc": 150000,
    "pegAmount": null,
    "notes": ["..."]
  },

  "insights": {
    "positive": [ { "title": "Strong revenue growth", "detail": "Revenue grew 15% YoY", "cimSection": "financialOverview" } ],
    "negative": [ { "title": "Margin compression", "detail": "Gross margin declined from 51% to 48%" } ],
    "neutral":  [ { "title": "Stable working capital", "detail": "NWC as % of revenue is consistent" } ]
  },

  "clarifyingQuestions": [
    {
      "question": "Owner compensation of $200K appears above market. Can you confirm total comp including benefits?",
      "context": "Needed for accurate SDE normalization",
      "severity": "high"
    }
  ],

  "discrepancies": [
    {
      "field": "2024 Revenue",
      "sourceA": { "source": "2024 T2 Tax Return", "value": "$809,147" },
      "sourceB": { "source": "Seller interview (knowledge base annualRevenue)", "value": "$980,830" },
      "documentId": "the sourceDocumentId or document ID backing one of the values, if applicable",
      "severity": "critical",
      "category": "financial",
      "explanation": "The seller quoted gross sales including discounts; the tax return reports net trade sales.",
      "suggestedResolution": "Confirm with the seller whether their revenue figure is gross or net of discounts/returns.",
      "existingId": "only when this is the same conflict as a PREVIOUSLY RAISED open discrepancy — its id; omit otherwise"
    }
  ],

  "clearedDiscrepancyIds": ["ids of PREVIOUSLY RAISED open discrepancies you re-evaluated and found the sources now agree on"],

  "aiReasoning": "A brief explanation of the analytical approach, which sources you preferred and why, assumptions made, and data quality concerns."
}

RULES:
- reclassifiedPnl row categories MUST be from: "Revenue", "COGS", "Operating Expenses", "Other Income", "Other Expense", "Owner Compensation", "Depreciation", "Interest", "Taxes", "Non-Recurring", "Excluded".
- reclassifiedBalanceSheet row categories MUST be from: "Current Assets", "Fixed Assets", "Other Assets", "Current Liabilities", "Long-Term Liabilities", "Equity".
- Include every meaningful line item (do not collapse into single totals), but do NOT include computed subtotal rows (Gross Profit, Net Income, Total Assets) — the UI computes those.
- THE ROWS MUST TIE: for every year, Revenue + Other Income − (every other non-Excluded category) MUST equal the reported net income you put in normalization.netIncome. The rows are a reclassification of the source statement, not a rewrite — line items must sum to the source totals.
- CARVE-OUTS: when you separate a one-time or non-recurring amount out of a line (e.g. a $28,000 renovation buried in Rent), you MUST reduce the parent line by the same amount (Rent = source Rent − 28,000; "Renovation (one-time)" = 28,000 under "Non-Recurring"). Never add a carve-out row while leaving the parent at its full amount — that double-counts the expense and breaks the tie.
- Liability and expense values should be POSITIVE numbers (the UI subtracts them by category).
- normalization.netIncome must be the reported net income per year; addbacks type "sde" = owner-specific (only applies to SDE), type "ebitda" = applies to both (D&A, interest, taxes, true one-offs). Removal of non-recurring INCOME (e.g. government grants) belongs as a NEGATIVE addback amount.
- addback category MUST be from: "owner_comp", "discretionary", "non_recurring", "one_time", "other".
- workingCapital: use the latest period with a full balance sheet; list real line items. If NO source contains a balance sheet, set "workingCapital" to null — never estimate current assets or liabilities from a P&L, and never invent a net working capital figure.
- CONFIRMED FACTS are final. Insights, owner names, revenue splits, and normalization assumptions must use them. A document or scrape that contradicts a confirmed fact is a discrepancy to flag (unless it was already resolved), never a figure to quote.
- clarifyingQuestions severity: "high" | "medium" | "low".
- DISCREPANCIES: compare the SAME metric across sources (revenue, COGS, net income, owner comp, addbacks claimed vs supported, employee counts on payroll vs stated, rent, inventory, asking price). Flag when values differ by >5% (severity: significant 5-10%, critical >10% or core-claim conflicts, minor for rounding/timing). Only flag REAL conflicts with evidence from two identifiable sources — never flag missing data. Name each source specifically (document name, "knowledge base", "questionnaire"). If an addback is claimed in the interview/knowledge base but not visible in any statement, THAT is a discrepancy.
- discrepancy category: "financial" for amounts, margins, and addbacks; "operational" for headcount, hours, locations, customers, vendors; "legal" for leases, licences, contracts, litigation; "factual" for names, ages, dates, ownership, and other non-financial facts.
- PREVIOUSLY RAISED DISCREPANCIES: never re-raise a RESOLVED one under any wording. For each OPEN one, either return it with its "existingId" (still a conflict) or list its id in "clearedDiscrepancyIds" (sources now agree) — do not silently omit it.
- If a statement type has no data, set its value to null.
- If sources agree everywhere, return "discrepancies": [].`,
      },
    ],
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "Comprehensive analysis output was truncated (hit token limit). Re-run the analysis; if this persists the deal may have too many statements.",
    );
  }

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  let parsed: any;
  try {
    parsed = parseJsonLoose(text);
  } catch (err) {
    console.error("Failed to parse comprehensive analysis response:", err);
    throw new Error("The AI analysis returned malformed output. Please re-run the analysis.");
  }

  // Deterministic coercion into the canonical UI shape (adds ids, statuses,
  // approved flags; tolerates the model deviating toward the legacy shape).
  const reclassifiedPnl = coerceReclassifiedTable(parsed.reclassifiedPnl, "pnl");
  const reclassifiedBalanceSheet = coerceReclassifiedTable(parsed.reclassifiedBalanceSheet, "balance");
  const reclassifiedCashFlow = coerceReclassifiedTable(parsed.reclassifiedCashFlow, "pnl");
  const normalization = coerceNormalization(parsed.normalization);
  const workingCapital = coerceWorkingCapital(parsed.workingCapital, reclassifiedBalanceSheet);
  const insights = coerceInsights(parsed.insights);
  // Fresh questions get run-unique ids. The coercer's deterministic fallback
  // (q_legacy_N) exists for stored legacy rows; two versions' questions must
  // never share ids once answered/dismissed ones are carried forward.
  const runTag = Date.now().toString(36);
  const clarifyingQuestions = coerceClarifyingQuestions(
    Array.isArray(parsed.clarifyingQuestions)
      ? parsed.clarifyingQuestions.map((q: any, i: number) =>
          q && typeof q === "object" && !(typeof q.id === "string" && q.id) ? { ...q, id: `q_${runTag}_${i}` } : q,
        )
      : parsed.clarifyingQuestions,
  );

  const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
  const discrepancies: FinancialDiscrepancyItem[] = (Array.isArray(parsed.discrepancies) ? parsed.discrepancies : [])
    .filter((d: any) => d && d.field && d.sourceA?.value && d.sourceB?.value)
    .map((d: any) => ({
      field: String(d.field),
      sourceA: { source: String(d.sourceA.source ?? "Source A"), value: String(d.sourceA.value) },
      sourceB: { source: String(d.sourceB.source ?? "Source B"), value: String(d.sourceB.value) },
      documentId: isUuid(d.documentId) ? d.documentId : undefined,
      severity: ["critical", "significant", "minor"].includes(d.severity) ? d.severity : "significant",
      category: (DISCREPANCY_CATEGORIES as readonly string[]).includes(d.category) ? d.category : "financial",
      explanation: String(d.explanation ?? ""),
      suggestedResolution: String(d.suggestedResolution ?? ""),
      existingId: isUuid(d.existingId) ? d.existingId : undefined,
    }));

  const clearedDiscrepancyIds: string[] = (Array.isArray(parsed.clearedDiscrepancyIds) ? parsed.clearedDiscrepancyIds : [])
    .filter(isUuid);

  return {
    reclassifiedPnl,
    reclassifiedBalanceSheet,
    reclassifiedCashFlow,
    normalization,
    workingCapital,
    insights,
    clarifyingQuestions,
    discrepancies,
    clearedDiscrepancyIds,
    aiReasoning: typeof parsed.aiReasoning === "string" ? parsed.aiReasoning : "",
  };
}
