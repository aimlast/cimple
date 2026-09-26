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
import { brokerPrivacy } from "../interview/seller-view";
import { getFieldSources } from "../interview/info-merger";
import { filterDiscrepancyItems, dropReason } from "../cim/discrepancy-filter";
import { scrubPrivateText } from "../cim/discrepancy-privacy";
import { mentionsPrivateSource, type DiscrepancySideSources, type DiscrepancySideSource } from "@shared/discrepancy-sides";
import {
  applyAddbackRules,
  applyWorkingCapitalRules,
  flagEarningsNotes,
  flagEarningsStatements,
  isOwnerCompDiscrepancy,
  isOwnerPayLine,
  withCanonicalEarnings,
  withoutDividend,
} from "./normalization-rules";
import {
  buildFigureIndex,
  dealFigureTexts,
  markPrivateAddbacks,
  markPrivateQuestionFigures,
  withoutPrivateFigureSentences,
  type FigureIndex,
} from "./private-figures";
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
  /** Per-document kind + privacy, for each discrepancy side's sideSources */
  docMetaById: Record<string, { kind: string; brokerOnly: boolean }>;
  /**
   * The broker's private material (broker-only files, CRM notes, facts only
   * they assert) — context for the analysis, never cited in a discrepancy
   * or question that could reach the seller.
   */
  privateContext: string;
  /** The deal's real fact keys — each discrepancy names the one it is about. */
  factKeys: string[];
  /** Figures in the shared vs the broker's private material (private-figures.ts). */
  figureIndex: FigureIndex;
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
 * statements hundreds of pages in). `extraKeywords` (the discrepancy check
 * passes the words of the facts it verifies — "lease", "expiry",
 * "technicians") are searched first.
 */
export function sliceRelevantText(text: string, budget: number, extraKeywords: string[] = []): string {
  if (text.length <= budget) return text;

  const headBudget = Math.floor(budget * 0.45);
  const head = text.slice(0, headBudget);
  const rest = text.slice(headBudget);
  const restLower = rest.toLowerCase();

  const windows: Array<{ start: number; end: number }> = [];
  const windowSize = 1500;
  const keywords = extraKeywords.length > 0
    ? Array.from(new Set([...extraKeywords.map((k) => k.toLowerCase()).filter((k) => k.length >= 3), ...FINANCIAL_KEYWORDS]))
    : FINANCIAL_KEYWORDS;
  for (const kw of keywords) {
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
  const docMetaById: Record<string, { kind: string; brokerOnly: boolean }> = {};
  for (const d of processedDocs) {
    docNamesById[d.id] = d.name;
    docMetaById[d.id] = { kind: d.sourceKind || "document", brokerOnly: d.visibility === "broker_only" || d.sourceKind === "crm" };
  }
  // The broker's private files and CRM notes inform the analysis but are
  // kept apart (see privateContext) — never a side of a discrepancy the
  // broker could route to the seller.
  const privateDocs = processedDocs.filter((d) => docMetaById[d.id].brokerOnly);
  const sharedDocs = processedDocs.filter((d) => !docMetaById[d.id].brokerOnly);

  // 1. Financial-category docs -> full structured extraction
  const financialDocs = sharedDocs.filter(
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
  const nonFinancialDocs = sharedDocs.filter((d) => d.category !== "financials");
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
  const rawInfo = (deal.extractedInfo as Record<string, unknown>) || {};
  const { isPrivateSource } = brokerPrivacy(allDocs);
  const fieldSources = getFieldSources(rawInfo);
  const privateFacts: Record<string, unknown> = {};
  const extractedInfo = Object.fromEntries(
    Object.entries(rawInfo).filter(([k, v]) => {
      // "_"-prefixed keys are broker-private / session-meta — not analysis input
      if (k.startsWith("_")) return false;
      // A fact only the broker's private material asserts (a CRM note).
      if (isPrivateSource(fieldSources[k])) {
        privateFacts[k] = v;
        return false;
      }
      return true;
    }),
  );
  const factKeys = Object.keys(rawInfo).filter((k) => !k.startsWith("_"));

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
      // Keyed by the real fact when the row names one (never a label-named pseudo-fact).
      const key = d.factKey && !d.factKey.startsWith("_") ? (d.factYear ? `${d.factKey} (${d.factYear})` : d.factKey) : d.field;
      confirmedFacts[key] = d.resolvedValue;
      // The resolved value also replaces the stale figure in the knowledge-base view
      const target = d.factKey && !d.factYear ? d.factKey : d.field;
      if (hasOwn(extractedInfo, target)) extractedInfo[target] = d.resolvedValue;
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
    ...privateDocs.map((d) => d.id),
  ];

  const privateParts: string[] = [];
  if (Object.keys(privateFacts).length > 0) {
    const json = JSON.stringify(privateFacts, null, 1);
    privateParts.push(`Facts only the broker's notes state:\n${json.length > 6000 ? json.slice(0, 6000) + "\n... [truncated]" : json}`);
  }
  for (const d of privateDocs) privateParts.push(renderDoc(d, 4000));
  const privateContext = privateParts.join("\n\n---\n\n");

  // Which figures only the broker's private material states — the check
  // behind the prompt's "never quote SOURCE 5" (add-backs, questions). Every
  // document with text counts, processed or not (fail closed).
  const figureTexts = dealFigureTexts(allDocs, rawInfo, deal.questionnaireData);
  const figureIndex = buildFigureIndex(figureTexts.shared, figureTexts.private);

  return {
    figureIndex,
    statements,
    sourceDocumentIds: contributingDocIds,
    otherDocsContext,
    knowledgeBaseContext,
    questionnaireContext,
    confirmedFactsContext,
    existingDiscrepanciesContext,
    docNamesById,
    docMetaById,
    privateContext,
    factKeys,
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
      sources.questionnaireContext.length > 0 ||
      sources.privateContext.length > 0;

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

    // 3b. Deterministic post-passes (see normalization-rules.ts): distributions
    //     are never add-backs, working capital is cash-free/debt-free with no
    //     single-period peg; then tie the reclassified P&L to reported net
    //     income and re-apply the broker's decisions from the previous version;
    //     finally compute EBITDA/SDE in code and flag any text that states a
    //     different figure.
    //     Add-backs and questions that rest only on the broker's private
    //     material are marked (an add-back stays out of EBITDA/SDE and the
    //     CIM until the broker approves it; a question's private figures are
    //     never sent to the seller).
    const ruled = markPrivateMaterial(postProcessAnalysis(freshResult), sources.figureIndex);
    const reconciled = reconcileNetIncome(ruled.reclassifiedPnl, ruled.normalization, sources.statements);
    const carried: AnalysisOutput = previous
      ? carryForwardBrokerEdits(normalizeFinancialAnalysisRow(previous), {
          ...ruled,
          reclassifiedPnl: reconciled.pnl,
          normalization: reconciled.normalization,
        })
      : { ...ruled, reclassifiedPnl: reconciled.pnl, normalization: reconciled.normalization };
    // Working capital once more on the final balance sheet (a broker's
    // carried-over reclassification can move a row in or out of it).
    const analysisResult = finalizeEarnings({
      ...carried,
      workingCapital: applyWorkingCapitalRules(carried.workingCapital, carried.reclassifiedBalanceSheet),
    });

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
      sources.docMetaById,
      sources.figureIndex,
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

// ── Deterministic post-processing ──

/** Rules applied to the model's fresh output, before the broker's edits are carried over. */
export function postProcessAnalysis(result: AnalysisOutput): AnalysisOutput {
  return {
    ...result,
    normalization: applyAddbackRules(result.normalization),
    workingCapital: applyWorkingCapitalRules(result.workingCapital, result.reclassifiedBalanceSheet),
  };
}

/** Mark what rests only on the broker's private material (after the owner-pay split, before carry-forward). */
export function markPrivateMaterial(result: AnalysisOutput, index: FigureIndex): AnalysisOutput {
  const { privateAddbackLabels, ...rest } = result;
  return {
    ...rest,
    normalization: markPrivateAddbacks(result.normalization, index, new Set(privateAddbackLabels ?? [])),
    clarifyingQuestions: markPrivateQuestionFigures(result.clarifyingQuestions, index),
  };
}

/** Canonical EBITDA/SDE from the final add-back list; text that disagrees is flagged. */
export function finalizeEarnings(result: AnalysisOutput): AnalysisOutput {
  const normalization = withCanonicalEarnings(flagEarningsNotes(result.normalization));
  const { insights, mismatches } = flagEarningsStatements(result.insights, normalization);
  const aiReasoning = mismatches.length > 0
    ? `${result.aiReasoning}${result.aiReasoning ? "\n\n" : ""}Figures checked in code: ${mismatches.map((m) => `${m.where} states ${m.year} ${m.label} ${Math.round(m.stated).toLocaleString("en-US")}; computed ${Math.round(m.expected).toLocaleString("en-US")}`).join("; ")}.`
    : result.aiReasoning;
  return { ...result, normalization, insights, aiReasoning };
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

const EXPENSE_CATEGORIES = new Set(["COGS", "Operating Expenses", "Owner Compensation", "Other Expense", "Non-Recurring", "Depreciation", "Interest", "Taxes"]);
const INCOME_CATEGORIES = new Set(["Revenue", "Other Income"]);

function labelTokens(s: string): Set<string> {
  return new Set(normalizeLabel(s).split(" ").filter((t) => t.length >= 2 && !["and", "the", "of", "incl", "including"].includes(t)));
}

/** Same line on the statement: most of the words agree, or one name contains the other. */
function sameLine(a: string, b: string): boolean {
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = labelTokens(a);
  const tb = labelTokens(b);
  let inter = 0;
  ta.forEach((t) => { if (tb.has(t)) inter++; });
  return inter / Math.min(ta.size || 1, tb.size || 1) >= 0.75;
}

/**
 * Rows whose amount differs from the same line on the source income
 * statement by exactly the year's net-income gap are put back to the
 * statement amount — the model moved money out of a line the statement
 * doesn't split (or into one). Only an unambiguous repair is made: one row,
 * one statement line, the gap closed to the dollar (0.5% for rounding).
 */
export function restoreStatementLines(
  pnl: UiReclassifiedTable,
  mismatches: Array<{ year: string; delta: number }>,
  statements: ExtractedStatement[],
): { pnl: UiReclassifiedTable; notes: string[] } {
  const lines = statements
    .filter((s) => s.statementType === "income_statement")
    .flatMap((s) => (s.lineItems ?? []).filter((li) => !li.isSubtotal && !li.isTotal).map((li) => ({ li, doc: s.sourceDocumentName })));
  if (lines.length === 0) return { pnl, notes: [] };
  const amountFor = (amounts: Record<string, number>, year: string): number | undefined => {
    for (const [k, v] of Object.entries(amounts ?? {})) {
      if ((k.match(/(?:19|20)\d{2}/g)?.pop() ?? k) === year && Number.isFinite(Number(v))) return Math.abs(Number(v));
    }
    return undefined;
  };
  const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const rows = pnl.rows.map((r) => ({ ...r, values: { ...r.values } }));
  const notes: string[] = [];
  for (const m of mismatches) {
    const tolerance = Math.max(1, Math.abs(m.delta) * 0.005);
    const fixes: Array<{ row: (typeof rows)[number]; source: number; doc?: string }> = [];
    for (const row of rows) {
      const v = row.values?.[m.year];
      if (typeof v !== "number") continue;
      const expense = EXPENSE_CATEGORIES.has(row.category);
      if (!expense && !INCOME_CATEGORIES.has(row.category)) continue;
      // Net income moves by −(source − row) for an expense line, +(source − row) for income.
      const needed = expense ? m.delta : -m.delta;
      const hits = lines.filter(({ li }) => {
        const src = amountFor(li.amounts, m.year);
        return src !== undefined && sameLine(li.label, row.name) && Math.abs(src - Math.abs(v) - needed) <= tolerance;
      });
      if (hits.length > 0) fixes.push({ row, source: amountFor(hits[0].li.amounts, m.year)!, doc: hits[0].doc });
    }
    if (fixes.length !== 1) continue;
    const { row, source, doc } = fixes[0];
    const before = Math.abs(row.values[m.year]);
    row.values[m.year] = row.values[m.year] < 0 ? -source : source;
    notes.push(
      `${row.name} (${m.year}) is shown at ${fmt(source)}, its amount on the ${doc ?? "income statement"}; it had been entered as ${fmt(before)}, which left ${m.year} net income ${fmt(Math.abs(m.delta))} away from the reported figure.`,
    );
  }
  return { pnl: { ...pnl, rows }, notes };
}

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
 * trusting two different net-income figures. Before either, a line the
 * model cut below its amount on the source statement is restored when that
 * exactly closes the gap (restoreStatementLines).
 */
export function reconcileNetIncome(
  pnl: UiReclassifiedTable | null,
  normalization: UiNormalization | null,
  statements: ExtractedStatement[] = [],
): { pnl: UiReclassifiedTable | null; normalization: UiNormalization | null } {
  let mismatches = findNetIncomeMismatches(pnl, normalization);
  if (mismatches.length === 0 || !pnl || !normalization) return { pnl, normalization };

  // A line the model reduced for a carve-out the statement already shows on
  // its own line (Pacific FY2024: "Office, IT & software" cut from $318,000
  // to $246,000 for the $72,000 TMS migration, which the statements list
  // separately — deducted twice, EBITDA $72,000 high): put the line back to
  // the statement's amount when that exactly closes the gap.
  const restored = restoreStatementLines(pnl, mismatches, statements);
  if (restored.notes.length > 0) {
    pnl = { ...restored.pnl, notes: [...(restored.pnl.notes ?? []), ...restored.notes] };
    mismatches = findNetIncomeMismatches(pnl, normalization);
    if (mismatches.length === 0) return { pnl, normalization };
  }

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
  const decided = new Set<UiAddback>();
  const apply = (line: UiAddback, prevAb: UiAddback) => {
    line.approved = prevAb.approved;
    line.approvedOverride = true;
    decided.add(line);
  };

  const overridden: UiAddback[] = [];
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
    if (!prevAb.approvedOverride) continue;
    overridden.push(prevAb);
    if (match) apply(match, prevAb);
  }

  // The owner's pay is now two lines (the part above a market salary, and
  // the market salary itself — normalization-rules splitOwnerCompensation),
  // so a broker decision on the owner-pay line must reach both: a rejected
  // "Owner salary" from an unsplit version rejects "Owner salary — market
  // salary" too, or SDE keeps the market salary the broker threw out. Lines
  // an exact label match already decided are left alone. When the model
  // renamed the line, a deal with one working owner on both sides still
  // matches owner line to owner line.
  const baseKey = (label: string) => normalizeLabel(label.replace(/\s+—\s+market salary$/i, ""));
  const isOwnerPay = (ab: UiAddback) => !!ab.ownerCompPart || (!ab.custom && isOwnerPayLine(ab));
  const freshOwner = addbacks.filter((ab) => !ab.custom && isOwnerPay(ab));
  const freshGroups = new Set(freshOwner.map((ab) => baseKey(ab.label)));
  const prevOwner = (prev.addbacks ?? []).filter((ab) => !ab.custom && isOwnerPay(ab));
  const prevGroups = new Set(prevOwner.map((ab) => baseKey(ab.label)));
  for (const prevAb of overridden) {
    if (!isOwnerPay(prevAb)) continue;
    let group = freshOwner.filter((ab) => baseKey(ab.label) === baseKey(prevAb.label));
    if (group.length === 0 && freshGroups.size === 1 && prevGroups.size === 1) group = freshOwner;
    for (const line of group) {
      if (decided.has(line)) continue;
      // A decision on the market-salary part only speaks for that part.
      if (prevAb.ownerCompPart === "market" && line.ownerCompPart !== "market") continue;
      if (prevAb.ownerCompPart === "excess" && line.ownerCompPart === "market") continue;
      apply(line, prevAb);
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
  /** The real fact key this is about (from the deal's keys), when one fits. */
  factKey?: string | null;
  /** Fiscal year for a per-year fact. */
  factYear?: string | null;
  sourceA: { source: string; value: string; documentId?: string };
  sourceB: { source: string; value: string; documentId?: string };
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
/** Kind of source a free-text label names ("Seller interview", "2024 T2", "CRM note"). */
function kindFromSourceLabel(label: string): string {
  const l = label.toLowerCase();
  if (/\bcrm\b|pipedrive|hubspot|broker(?:'s)? (?:note|recast|estimate)|per broker|site visit/.test(l)) return "crm";
  if (/video|zoom|teams|google meet/.test(l)) return "video_call";
  if (/\bcall\b|phone/.test(l)) return "call";
  if (/interview|seller said|told us|knowledge base/.test(l)) return "interview";
  if (/questionnaire|intake/.test(l)) return "questionnaire";
  if (/e-?mail/.test(l)) return "email";
  return "document";
}

const DIVIDEND_NOTE = "Dividends are distributions of after-tax profit, not owner compensation, so any dividend is left out of the owner-pay figures here.";

const CLAIM_SIDE_KINDS = new Set(["interview", "call", "video_call", "questionnaire", "email", "crm"]);

/**
 * The stored values of one analysis finding: which side is the seller's
 * (interviewValue) and which the document's (documentValue), where each came
 * from (sideSources — a broker-only file or CRM note is flagged brokerOnly
 * and its value is stored without the private source's name), the fact it
 * is about, and explanation text that never quotes or names private
 * material. Pure.
 */
export function financialDiscrepancyValues(
  item: FinancialDiscrepancyItem,
  docNamesById: Record<string, string>,
  docMetaById: Record<string, { kind: string; brokerOnly: boolean }>,
  figureIndex?: FigureIndex,
) {
  const sideOf = (s: FinancialDiscrepancyItem["sourceA"], fallbackDocId?: string): DiscrepancySideSource => {
    const docId = s.documentId && docMetaById[s.documentId] ? s.documentId : fallbackDocId && docMetaById[fallbackDocId] ? fallbackDocId : undefined;
    const meta = docId ? docMetaById[docId] : undefined;
    const kind = (meta?.kind ?? kindFromSourceLabel(s.source)) as DiscrepancySideSource["kind"];
    // A known document decides; a free-text label is judged on its words (fail closed).
    const brokerOnly = meta ? meta.brokerOnly : kind === "crm" || mentionsPrivateSource(s.source);
    return {
      kind,
      ...(docId ? { documentId: docId } : {}),
      ...(brokerOnly ? { brokerOnly: true } : {}),
      ...(brokerOnly ? {} : { label: docId ? docNamesById[docId] ?? s.source : s.source }),
    };
  };
  let a = item.sourceA;
  let b = item.sourceB;
  let sideA = sideOf(a);
  let sideB = sideOf(b, item.documentId);
  // The seller-side value goes first, the document second (the table's contract).
  if (!CLAIM_SIDE_KINDS.has(sideA.kind) && CLAIM_SIDE_KINDS.has(sideB.kind)) {
    [a, b] = [b, a];
    [sideA, sideB] = [sideB, sideA];
  }
  const stored = (s: FinancialDiscrepancyItem["sourceA"], side: DiscrepancySideSource) =>
    side.brokerOnly ? s.value : `${s.value} — ${s.source}`;
  const sideSources: DiscrepancySideSources = { interview: sideA, document: sideB };
  const scrubbed = scrubPrivateText({
    field: item.field,
    interviewValue: stored(a, sideA),
    documentValue: stored(b, sideB),
    aiExplanation: item.explanation,
    suggestedResolution: item.suggestedResolution,
    sideSources,
  });
  const documentId = sideB.documentId ?? item.documentId ?? null;
  // The explanation can reach the seller with the row: a sentence quoting a
  // figure only the broker's private material holds is dropped.
  const publicText = (text: string, fallback: string) => {
    if (!figureIndex) return text;
    const kept = withoutPrivateFigureSentences(text, figureIndex);
    return kept === text.trim() ? text : kept || fallback;
  };
  const what = (item.field || "this figure").trim();
  return {
    interviewValue: scrubbed.interviewValue,
    documentValue: scrubbed.documentValue,
    documentId,
    documentName: documentId ? docNamesById[documentId] ?? null : null,
    severity: item.severity,
    category: item.category,
    aiExplanation: publicText(scrubbed.aiExplanation, `The figures on file for ${what} don't agree.`),
    suggestedResolution: publicText(scrubbed.suggestedResolution, `Confirm the correct ${what} with the seller or from the source documents.`),
    factKey: item.factKey ?? null,
    factYear: item.factYear ?? null,
    sideSources: scrubbed.sideSources as any,
  };
}

async function persistFinancialDiscrepancies(
  dealId: string,
  storage: IStorage,
  rawItems: FinancialDiscrepancyItem[],
  clearedIds: string[],
  docNamesById: Record<string, string>,
  existing: Discrepancy[],
  docMetaById: Record<string, { kind: string; brokerOnly: boolean }> = {},
  figureIndex?: FigureIndex,
): Promise<void> {
  const live = existing.filter((d) => d.status !== "superseded");
  const byId = new Map(live.map((d) => [d.id, d]));
  const settled = live.filter((d) => d.status === "resolved" || d.status === "accepted");
  const unsettled = live.filter((d) => d.status !== "resolved" && d.status !== "accepted");
  const refreshed = new Set<string>();

  // Dividends are distributions, not owner compensation — in the conflict
  // the broker reads too, not only in the add-backs: a side that folds a
  // dividend into the owner's pay is restated without it (and may then
  // agree with the other side).
  const reframed = rawItems.map((item) => {
    if (!isOwnerCompDiscrepancy(item.field, item.factKey)) return item;
    const a = withoutDividend(item.sourceA.value);
    const b = withoutDividend(item.sourceB.value);
    if (!a && !b) return item;
    return {
      ...item,
      sourceA: { ...item.sourceA, value: a ?? item.sourceA.value },
      sourceB: { ...item.sourceB, value: b ?? item.sourceB.value },
      explanation: `${item.explanation}${item.explanation ? " " : ""}${DIVIDEND_NOTE}`,
    };
  });

  // Equal values, a missing document, adjusted vs reported: never a conflict.
  const { kept: items, dropped } = filterDiscrepancyItems(
    reframed.map((item) => ({ ...item, interviewValue: item.sourceA.value, documentValue: item.sourceB.value })),
  );
  const droppedExisting = new Set(dropped.map((d) => d.item.existingId).filter((id): id is string => !!id));

  for (const item of items) {
    const referenced = item.existingId ? byId.get(item.existingId) : undefined;
    const settledMatch = referenced && settled.includes(referenced)
      ? referenced
      : settled.find((d) => matchesExisting(item, d));
    if (settledMatch) continue; // already settled by the broker

    const openMatch = referenced && unsettled.includes(referenced)
      ? referenced
      : unsettled.find((d) => d.source === "financial_analysis" && !refreshed.has(d.id) && matchesExisting(item, d));

    const values = financialDiscrepancyValues(item, docNamesById, docMetaById, figureIndex);

    if (openMatch) {
      refreshed.add(openMatch.id);
      if (openMatch.source !== "financial_analysis") continue; // interview-check rows are not ours to rewrite
      // Refresh the finding; keep the broker's routing/status, the original
      // field name and a fact key the broker already linked.
      await storage.updateDiscrepancy(openMatch.id, {
        ...values,
        factKey: openMatch.factKey || values.factKey,
        factYear: openMatch.factKey ? openMatch.factYear : values.factYear,
      });
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

  // An earlier run's owner-pay conflict this run didn't restate: the same
  // dividend rule applies to its stored values.
  for (let i = 0; i < unsettled.length; i++) {
    const row = unsettled[i];
    if (row.source !== "financial_analysis" || refreshed.has(row.id) || !row.interviewValue || !row.documentValue) continue;
    if (!isOwnerCompDiscrepancy(row.field, row.factKey)) continue;
    const a = withoutDividend(row.interviewValue);
    const b = withoutDividend(row.documentValue);
    if (!a && !b) continue;
    const patch = {
      interviewValue: a ?? row.interviewValue,
      documentValue: b ?? row.documentValue,
      aiExplanation: `${row.aiExplanation ?? ""}${row.aiExplanation ? " " : ""}${DIVIDEND_NOTE}`,
    };
    await storage.updateDiscrepancy(row.id, patch);
    unsettled[i] = { ...row, ...patch };
    byId.set(row.id, unsettled[i]);
  }

  // Explicitly cleared by this run (the sources now agree), re-raised but
  // filtered out, or an older finding of ours that was never a conflict
  // (equal values). Rows the broker routed to the seller stay with the
  // seller — only untouched open rows close. A routed question (no second
  // value) is never "equal".
  const toClear = new Set([...clearedIds, ...Array.from(droppedExisting)]);
  for (const row of unsettled) {
    if (row.source === "financial_analysis" && row.status === "open" && row.interviewValue && row.documentValue && dropReason(row) !== null) toClear.add(row.id);
  }
  for (const id of Array.from(toClear)) {
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
  /** Labels of add-backs the model said only the broker's private material supports (evidence "private"). */
  privateAddbackLabels?: string[];
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

═══ SOURCE 5: BROKER-PRIVATE CONTEXT (the broker's own CRM notes and private files — use it to inform your analysis, but NEVER as a side of a discrepancy, and never quote, name or allude to it in any discrepancy or clarifying question: those can be read to the seller) ═══
${sources.privateContext || "(none)"}

═══ FACT KEYS ON FILE (each discrepancy's "factKey" must be one of these, or "" if none fits) ═══
${sources.factKeys.join(", ") || "(none)"}

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
        "label": "Owner compensation (President)",
        "description": "Owner's salary + benefits on the P&L; a general manager for the role costs about $110K",
        "category": "owner_comp",
        "ownerActualComp": { "2022": 190000, "2023": 195000 },
        "marketSalary": 110000,
        "amounts": { "2022": 190000, "2023": 195000 },
        "confidence": "high",
        "evidence": "statements"
      }
    ],
    "notes": ["..."]
  },

  "workingCapital": {
    "asOfPeriod": "2024",
    "currentAssets": [ { "name": "Accounts Receivable", "amount": 91402 }, { "name": "Inventory", "amount": 71712 } ],
    "currentLiabilities": [ { "name": "Accounts Payable", "amount": 20000 } ],
    "netWorkingCapital": 143114,
    "targetNwc": null,
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
      "factKey": "revenueByYear",
      "factYear": "2024",
      "sourceA": { "source": "Seller interview (knowledge base annualRevenue)", "value": "$980,830" },
      "sourceB": { "source": "2024 T2 Tax Return", "value": "$809,147", "documentId": "the document ID backing this value" },
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
- CARVE-OUTS: when you separate a one-time or non-recurring amount out of a line (e.g. a $28,000 renovation buried in Rent), you MUST reduce the parent line by the same amount (Rent = source Rent − 28,000; "Renovation (one-time)" = 28,000 under "Non-Recurring"). Never add a carve-out row while leaving the parent at its full amount — that double-counts the expense and breaks the tie. When the source statement ALREADY shows the one-time item on its own line (e.g. "Systems implementation (TMS migration) 72,000" next to "Office, IT & software 318,000"), that line is the carve-out: classify it as "Non-Recurring" and leave every other line at its source amount — reducing another line as well deducts it twice.
- Liability and expense values should be POSITIVE numbers (the UI subtracts them by category).
- normalization.netIncome must be the reported net income per year. Add-backs apply to both adjusted EBITDA and SDE (type "ebitda"): D&A, interest, taxes, one-offs, AND owner perks run through the company, a relative's pay for a role the business doesn't need, and family pay above market. The only SDE-only amount is the working owner's market salary, which the code derives from "ownerActualComp" and "marketSalary" (so SDE = adjusted EBITDA + the market salary). Removal of non-recurring INCOME (e.g. government grants, insurance proceeds) belongs as a NEGATIVE addback amount.
- DISTRIBUTIONS ARE NOT ADD-BACKS: dividends (any class), owner draws, and shareholder-loan repayments are paid out of after-tax profit on the balance sheet — nothing on the P&L to add back. Never include them in an add-back or in owner compensation; mention them in normalization.notes instead.
- OWNER COMPENSATION: one add-back per working owner, category "owner_comp", with "ownerActualComp" = the owner's actual salary/wages + benefits on the P&L per year (never a dividend) and "marketSalary" = what it would cost to hire someone for the role they do (annual); put the actual compensation in "amounts" too. The code splits it: SDE adds back the owner's FULL compensation, adjusted EBITDA only the part above the market salary. If you cannot estimate a market salary, give "ownerActualComp" and leave "marketSalary" out.
- An OWNER-COMPENSATION DISCREPANCY compares the owner's pay only (salary, wages, benefits): never fold dividends, draws or other add-backs (personal expenses, a relative's pay) into either side's figure, and restate a PREVIOUSLY RAISED one that did (e.g. the T2 side is "$180,000 T4 salary", not "$268,000 = salary + dividends + personal expenses").
- Each add-back's "evidence" says where its amount comes from: "statements" (a line on the financial statements or tax returns), "seller" (the seller's interview answers, emails or questionnaire), "estimate" (your own estimate from those sources), or "private" (only SOURCE 5 supports it). An add-back only SOURCE 5 supports may be listed, but mark it "private": it stays out of EBITDA and SDE until the broker approves it.
- A clawback the business had to REPAY (a drug-plan post-payment audit recovery, a recoupment) is a cost, not income: never remove it as a negative add-back (a one-time clawback may be added back as non-recurring). A recovery the business RECEIVED (insurance proceeds, a legal settlement, a one-time gain) is non-recurring income: remove it with a NEGATIVE add-back.
- Every EBITDA or SDE figure you state (insights, notes, discrepancies) must tie to net income + the add-backs you listed for that year — adjusted EBITDA = net income + the non-owner add-backs + owner compensation above the market salary; SDE = adjusted EBITDA + the market salary (= net income + the non-owner add-backs + the owner's full compensation). The code recomputes both and flags any figure that doesn't tie.
- addback category MUST be from: "owner_comp", "discretionary", "non_recurring", "one_time", "other".
- workingCapital: use the latest period with a full balance sheet; list real line items. If NO source contains a balance sheet, set "workingCapital" to null — never estimate current assets or liabilities from a P&L, and never invent a net working capital figure.
- Working capital is CASH-FREE, DEBT-FREE: exclude cash and equivalents, bank debt / lines of credit, the current portion of long-term debt, shareholder loans (either direction) and income taxes payable/receivable. Leave pegAmount and targetNwc null and don't propose a peg, buffer or target in the notes: the code sets the peg as the average of the balance sheet's year-end net working capital. Give every year's current asset and current liability lines in reclassifiedBalanceSheet — the year-end figures are computed from them.
- CONFIRMED FACTS are final. Insights, owner names, revenue splits, and normalization assumptions must use them. A document or scrape that contradicts a confirmed fact is a discrepancy to flag (unless it was already resolved), never a figure to quote.
- clarifyingQuestions severity: "high" | "medium" | "low".
- DISCREPANCIES: compare the SAME metric across sources (revenue, COGS, net income, owner comp, addbacks claimed vs supported, employee counts on payroll vs stated, rent, inventory, asking price). Flag when values differ by >5% (severity: significant 5-10%, critical >10% or core-claim conflicts, minor for rounding/timing). Only flag REAL conflicts with evidence from two identifiable sources — never flag missing data, never two ways of writing the same value (monthly vs annual, rounding), and never an adjusted/normalized figure against a reported one. Name each source specifically (document name, "knowledge base", "questionnaire") and give its document ID when a document backs it. If an addback is claimed in the interview/knowledge base but not visible in any statement, THAT is a discrepancy.
- Each discrepancy's "factKey" is the fact key (from FACT KEYS ON FILE) whose value IS the conflicting figure — the broker's resolution replaces that value; "factYear" only for a per-year fact like revenueByYear. A part of a broader fact is not that fact (licensed technicians are not total employees; one owner-comp line is not the whole add-back list) — use "" then.
- Headcounts: say exactly what each source counts (the roster, full-time vs part-time, whether the owner is included) — never assert the owner is included unless the source says so.
- BROKER-PRIVATE CONTEXT (SOURCE 5) is never a side of a discrepancy and is never quoted or named ("CRM", "broker note", "broker recast", "site visit") in a discrepancy, explanation, suggested resolution or clarifying question. Notes and insights are read by the due-diligence writer too: never name the private source there either (say "an earlier estimate"). Clarifying questions can be read to the seller: never quote a figure that only SOURCE 5 states.
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
      factKey: typeof d.factKey === "string" && sources.factKeys.includes(d.factKey.trim()) ? d.factKey.trim() : null,
      factYear: typeof d.factYear === "string" && /^(?:FY\s*)?\d{4}$/.test(d.factYear.trim()) ? d.factYear.trim().replace(/^FY\s*/i, "") : null,
      sourceA: { source: String(d.sourceA.source ?? "Source A"), value: String(d.sourceA.value), ...(isUuid(d.sourceA.documentId) ? { documentId: d.sourceA.documentId } : {}) },
      sourceB: { source: String(d.sourceB.source ?? "Source B"), value: String(d.sourceB.value), ...(isUuid(d.sourceB.documentId) ? { documentId: d.sourceB.documentId } : {}) },
      documentId: isUuid(d.documentId) ? d.documentId : isUuid(d.sourceB?.documentId) ? d.sourceB.documentId : undefined,
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
    privateAddbackLabels: (Array.isArray(parsed.normalization?.addbacks) ? parsed.normalization.addbacks : [])
      .filter((a: any) => a && a.label && String(a.evidence ?? "").toLowerCase() === "private")
      .map((a: any) => String(a.label)),
  };
}
