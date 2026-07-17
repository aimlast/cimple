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
import { extractFinancialData, type ExtractedStatement } from "./extractor";
import { getComparables, type CompsResult } from "./comps";
import {
  coerceReclassifiedTable,
  coerceNormalization,
  coerceWorkingCapital,
  coerceClarifyingQuestions,
  coerceInsights,
  parseJsonLoose,
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
  /** Name lookup used when wiring discrepancies to documents */
  docNamesById: Record<string, string>;
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
  const extractedInfo = (deal.extractedInfo as Record<string, unknown>) || {};
  let knowledgeBaseContext = "";
  if (Object.keys(extractedInfo).length > 0) {
    const json = JSON.stringify(extractedInfo, null, 1);
    knowledgeBaseContext = json.length > 20000 ? json.slice(0, 20000) + "\n... [truncated]" : json;
  }

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
    docNamesById,
  };
}

// ── Public entry point ──

export async function runFinancialAnalysis(
  dealId: string,
  storage: IStorage,
): Promise<string> {
  // 1. Load deal
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error(`Deal ${dealId} not found`);

  // Determine next version number
  const existing = await storage.getFinancialAnalysesByDeal(dealId);
  const nextVersion = existing.length > 0 ? (existing[0].version ?? 0) + 1 : 1;

  // Create a placeholder record in "running" status
  const analysis = await storage.createFinancialAnalysis({
    dealId,
    version: nextVersion,
    status: "running",
  });

  try {
    // 2. Gather every source on the deal
    const sources = await assembleSources(dealId, storage, deal);

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

    // 3. Comprehensive AI analysis across all sources
    const analysisResult = await runComprehensiveAnalysis(deal, sources);

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
    await persistFinancialDiscrepancies(dealId, storage, analysisResult.discrepancies, sources.docNamesById);

    return analysis.id;
  } catch (err: any) {
    console.error("Financial analysis failed:", err);
    await storage.updateFinancialAnalysis(analysis.id, {
      status: "failed",
      aiReasoning: `Analysis failed: ${err.message}`,
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

// ── Discrepancy persistence ──

export interface FinancialDiscrepancyItem {
  field: string; // short human-readable metric name, e.g. "2025 Revenue"
  sourceA: { source: string; value: string };
  sourceB: { source: string; value: string };
  documentId?: string; // the document backing sourceB, when applicable
  severity: "critical" | "significant" | "minor";
  explanation: string;
  suggestedResolution: string;
}

async function persistFinancialDiscrepancies(
  dealId: string,
  storage: IStorage,
  items: FinancialDiscrepancyItem[],
  docNamesById: Record<string, string>,
): Promise<void> {
  const existing = await storage.getDiscrepanciesByDeal(dealId);
  const financialExisting = existing.filter((d) => d.source === "financial_analysis");

  // Supersede stale open findings from previous runs (never delete). Rows the
  // broker already routed (ask_seller) or resolved are left untouched.
  const staleOpen = financialExisting.filter((d) => d.status === "open");
  const freshFields = new Set(items.map((i) => normalizeFieldKey(i.field)));
  for (const stale of staleOpen) {
    if (!freshFields.has(normalizeFieldKey(stale.field))) {
      await storage.updateDiscrepancy(stale.id, { status: "superseded" });
    }
  }

  // Insert fresh findings, skipping any field that already has a live row
  // (open from a previous run with the same finding, routed, or resolved).
  const liveFields = new Set(
    financialExisting
      .filter((d) => d.status !== "superseded")
      .map((d) => normalizeFieldKey(d.field)),
  );

  for (const item of items) {
    if (liveFields.has(normalizeFieldKey(item.field))) continue;
    const documentName = item.documentId ? docNamesById[item.documentId] ?? null : null;
    await storage.createDiscrepancy({
      dealId,
      field: item.field,
      interviewValue: `${item.sourceA.value} — ${item.sourceA.source}`,
      documentValue: `${item.sourceB.value} — ${item.sourceB.source}`,
      documentId: item.documentId ?? null,
      documentName,
      severity: item.severity,
      category: "financial",
      source: "financial_analysis",
      aiExplanation: item.explanation,
      suggestedResolution: item.suggestedResolution,
      status: "open",
    });
    liveFields.add(normalizeFieldKey(item.field));
  }
}

function normalizeFieldKey(field: string): string {
  return (field || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ── Comprehensive AI analysis ──

interface AnalysisOutput {
  reclassifiedPnl: any;
  reclassifiedBalanceSheet: any;
  reclassifiedCashFlow: any;
  normalization: any;
  workingCapital: any;
  insights: any;
  clarifyingQuestions: any;
  discrepancies: FinancialDiscrepancyItem[];
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
    messages: [
      {
        role: "user",
        content: `You are a senior M&A financial analyst preparing a financial analysis for a Confidential Information Memorandum (CIM). You specialize in sell-side M&A advisory for small to mid-market businesses.

BUSINESS: ${deal.businessName}
INDUSTRY: ${deal.industry}${deal.subIndustry ? ` / ${deal.subIndustry}` : ""}

You have EVERY source of information collected on this deal. Numbers get stated in tax returns, internal statements, valuation workbooks, emails, call notes, and the seller interview — they often disagree. Use ALL sources, prefer the most authoritative for the analysis itself (tax returns > accountant statements > internal statements > workbook > interview/email claims), and flag disagreements as discrepancies.

═══ SOURCE 1: STRUCTURED FINANCIAL STATEMENTS (extracted from financial documents; each has sourceDocumentId + sourceDocumentName) ═══
${statementsJson || "(none)"}

═══ SOURCE 2: TAX RETURNS AND OTHER DOCUMENTS (extracted data + relevant text) ═══
${sources.otherDocsContext || "(none)"}

═══ SOURCE 3: DEAL KNOWLEDGE BASE (merged from seller interview, emails, calls, documents — field names hint at origin) ═══
${sources.knowledgeBaseContext || "(none)"}

═══ SOURCE 4: SELLER QUESTIONNAIRE ═══
${sources.questionnaireContext || "(none)"}

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
      "explanation": "The seller quoted gross sales including discounts; the tax return reports net trade sales.",
      "suggestedResolution": "Confirm with the seller whether their revenue figure is gross or net of discounts/returns."
    }
  ],

  "aiReasoning": "A brief explanation of the analytical approach, which sources you preferred and why, assumptions made, and data quality concerns."
}

RULES:
- reclassifiedPnl row categories MUST be from: "Revenue", "COGS", "Operating Expenses", "Other Income", "Other Expense", "Owner Compensation", "Depreciation", "Interest", "Taxes", "Non-Recurring", "Excluded".
- reclassifiedBalanceSheet row categories MUST be from: "Current Assets", "Fixed Assets", "Other Assets", "Current Liabilities", "Long-Term Liabilities", "Equity".
- Include every meaningful line item (do not collapse into single totals), but do NOT include computed subtotal rows (Gross Profit, Net Income, Total Assets) — the UI computes those.
- Liability and expense values should be POSITIVE numbers (the UI subtracts them by category).
- normalization.netIncome must be the reported net income per year; addbacks type "sde" = owner-specific (only applies to SDE), type "ebitda" = applies to both (D&A, interest, taxes, true one-offs). Removal of non-recurring INCOME (e.g. government grants) belongs as a NEGATIVE addback amount.
- addback category MUST be from: "owner_comp", "discretionary", "non_recurring", "one_time", "other".
- workingCapital: use the latest period with a full balance sheet; list real line items.
- clarifyingQuestions severity: "high" | "medium" | "low".
- DISCREPANCIES: compare the SAME metric across sources (revenue, COGS, net income, owner comp, addbacks claimed vs supported, employee counts on payroll vs stated, rent, inventory, asking price). Flag when values differ by >5% (severity: significant 5-10%, critical >10% or core-claim conflicts, minor for rounding/timing). Only flag REAL conflicts with evidence from two identifiable sources — never flag missing data. Name each source specifically (document name, "knowledge base", "questionnaire"). If an addback is claimed in the interview/knowledge base but not visible in any statement, THAT is a discrepancy.
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
  const clarifyingQuestions = coerceClarifyingQuestions(parsed.clarifyingQuestions);

  const discrepancies: FinancialDiscrepancyItem[] = (Array.isArray(parsed.discrepancies) ? parsed.discrepancies : [])
    .filter((d: any) => d && d.field && d.sourceA?.value && d.sourceB?.value)
    .map((d: any) => ({
      field: String(d.field),
      sourceA: { source: String(d.sourceA.source ?? "Source A"), value: String(d.sourceA.value) },
      sourceB: { source: String(d.sourceB.source ?? "Source B"), value: String(d.sourceB.value) },
      documentId: typeof d.documentId === "string" && /^[0-9a-f-]{36}$/i.test(d.documentId) ? d.documentId : undefined,
      severity: ["critical", "significant", "minor"].includes(d.severity) ? d.severity : "significant",
      explanation: String(d.explanation ?? ""),
      suggestedResolution: String(d.suggestedResolution ?? ""),
    }));

  return {
    reclassifiedPnl,
    reclassifiedBalanceSheet,
    reclassifiedCashFlow,
    normalization,
    workingCapital,
    insights,
    clarifyingQuestions,
    discrepancies,
    aiReasoning: typeof parsed.aiReasoning === "string" ? parsed.aiReasoning : "",
  };
}
