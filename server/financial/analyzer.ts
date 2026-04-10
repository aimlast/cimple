/**
 * Financial Analysis Engine
 *
 * Orchestrates the full financial analysis pipeline for a deal:
 *  1. Gather financial documents from storage
 *  2. Extract line-item data via the extractor
 *  3. Reclassify into standard M&A categories (industry-aware)
 *  4. Identify SDE / EBITDA addbacks (normalization)
 *  5. Calculate working capital from balance sheet
 *  6. Generate clarifying questions for red flags
 *  7. Generate positive / negative financial insights
 *  8. Pull comparable transactions (stub)
 *  9. Persist results to the financial_analyses table
 */

import Anthropic from "@anthropic-ai/sdk";
import type { IStorage } from "../storage";
import { extractFinancialData, type ExtractedStatement } from "./extractor";
import { getComparables, type CompsResult } from "./comps";

const anthropic = new Anthropic({ timeout: 600_000 });

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
    // 2. Gather financial documents (processed ones with extracted text)
    const allDocs = await storage.getDocumentsByDeal(dealId);
    const financialDocs = allDocs.filter(
      (d) =>
        d.category === "financials" &&
        d.isProcessed &&
        d.extractedText &&
        d.extractedText.trim().length > 0,
    );

    if (financialDocs.length === 0) {
      await storage.updateFinancialAnalysis(analysis.id, {
        status: "failed",
        aiReasoning:
          "No processed financial documents found for this deal. Upload and process financial statements first.",
      });
      return analysis.id;
    }

    const sourceDocumentIds = financialDocs.map((d) => d.id);

    // 3. Extract line items from each document
    const allStatements: ExtractedStatement[] = [];
    for (const doc of financialDocs) {
      const statements = await extractFinancialData(
        doc.extractedText!,
        doc.id,
        doc.name,
      );
      allStatements.push(...statements);
    }

    if (allStatements.length === 0) {
      await storage.updateFinancialAnalysis(analysis.id, {
        status: "failed",
        sourceDocumentIds,
        aiReasoning:
          "Could not extract any financial statements from the uploaded documents. The documents may not contain recognizable financial data.",
      });
      return analysis.id;
    }

    // Separate by type
    const incomeStatements = allStatements.filter(
      (s) => s.statementType === "income_statement",
    );
    const balanceSheets = allStatements.filter(
      (s) => s.statementType === "balance_sheet",
    );
    const cashFlows = allStatements.filter(
      (s) => s.statementType === "cash_flow",
    );
    const arAgingStatements = allStatements.filter(
      (s) => s.statementType === "ar_aging",
    );

    // 4. Reclassify + normalize + insights via a single comprehensive AI call
    const analysisResult = await runComprehensiveAnalysis(
      deal.industry,
      deal.subIndustry ?? undefined,
      deal.businessName,
      incomeStatements,
      balanceSheets,
      cashFlows,
      arAgingStatements,
    );

    // 5. Pull comps (stub for now)
    const latestRevenue = analysisResult.reclassifiedPnl?.totalRevenue ?? null;
    const latestSde = analysisResult.normalization?.adjustedSde ?? null;
    const comps: CompsResult = await getComparables(
      deal.industry,
      latestRevenue,
      latestSde,
    );

    // 6. Save everything
    await storage.updateFinancialAnalysis(analysis.id, {
      status: "completed",
      reclassifiedPnl: analysisResult.reclassifiedPnl,
      reclassifiedBalanceSheet: analysisResult.reclassifiedBalanceSheet,
      reclassifiedCashFlow: analysisResult.reclassifiedCashFlow,
      arAging: arAgingStatements.length > 0 ? arAgingStatements[0] : null,
      normalization: analysisResult.normalization,
      workingCapital: analysisResult.workingCapital,
      comps,
      insights: analysisResult.insights,
      clarifyingQuestions: analysisResult.clarifyingQuestions,
      sourceDocumentIds,
      aiReasoning: analysisResult.aiReasoning,
    });

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

// ── Comprehensive AI analysis ──

interface AnalysisOutput {
  reclassifiedPnl: any;
  reclassifiedBalanceSheet: any;
  reclassifiedCashFlow: any;
  normalization: any;
  workingCapital: any;
  insights: any;
  clarifyingQuestions: any;
  aiReasoning: string;
}

async function runComprehensiveAnalysis(
  industry: string,
  subIndustry: string | undefined,
  businessName: string,
  incomeStatements: ExtractedStatement[],
  balanceSheets: ExtractedStatement[],
  cashFlows: ExtractedStatement[],
  arAging: ExtractedStatement[],
): Promise<AnalysisOutput> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 12000,
    messages: [
      {
        role: "user",
        content: `You are a senior M&A financial analyst preparing a financial analysis for a Confidential Information Memorandum (CIM). You specialize in sell-side M&A advisory for small to mid-market businesses.

BUSINESS: ${businessName}
INDUSTRY: ${industry}${subIndustry ? ` / ${subIndustry}` : ""}

EXTRACTED FINANCIAL DATA:

=== INCOME STATEMENTS ===
${JSON.stringify(incomeStatements, null, 2)}

=== BALANCE SHEETS ===
${JSON.stringify(balanceSheets, null, 2)}

=== CASH FLOW STATEMENTS ===
${JSON.stringify(cashFlows, null, 2)}

=== AR AGING ===
${JSON.stringify(arAging, null, 2)}

INSTRUCTIONS:

Perform a comprehensive M&A financial analysis. You MUST be industry-aware — different industries have different standard chart of accounts, typical addbacks, working capital norms, and red flags. For example:
- Construction: focus on WIP, retention/holdbacks, bonding capacity, project-based revenue recognition
- Restaurants/food service: food cost %, labor cost %, lease obligations, tip handling
- Professional services: utilization rates, billable vs non-billable, partner compensation
- Manufacturing: inventory turns, COGS breakdown, capex requirements
- Medical practices: insurance reimbursement mix, A/R aging by payor class
- Retail: inventory turns, seasonal patterns, shrinkage, rent as % of revenue

Respond with valid JSON matching this exact structure:

{
  "reclassifiedPnl": {
    "periods": ["2021", "2022", "2023"],
    "totalRevenue": 1200000,
    "sections": [
      {
        "category": "Revenue",
        "items": [
          { "label": "Product Sales", "amounts": { "2021": 800000, "2022": 900000, "2023": 1000000 } }
        ],
        "subtotal": { "2021": 800000, "2022": 900000, "2023": 1000000 }
      }
    ],
    "grossProfit": { "2021": 400000, "2022": 460000, "2023": 520000 },
    "operatingIncome": { "2021": 180000, "2022": 210000, "2023": 250000 },
    "netIncome": { "2021": 140000, "2022": 170000, "2023": 200000 },
    "notes": []
  },

  "reclassifiedBalanceSheet": {
    "periods": ["2022", "2023"],
    "sections": [
      {
        "category": "Current Assets",
        "items": [
          { "label": "Cash", "amounts": { "2022": 50000, "2023": 75000 } }
        ],
        "subtotal": { "2022": 150000, "2023": 200000 }
      }
    ],
    "totalAssets": { "2022": 500000, "2023": 600000 },
    "totalLiabilities": { "2022": 200000, "2023": 220000 },
    "totalEquity": { "2022": 300000, "2023": 380000 },
    "notes": []
  },

  "reclassifiedCashFlow": {
    "periods": ["2022", "2023"],
    "operating": { "2022": 200000, "2023": 250000 },
    "investing": { "2022": -50000, "2023": -60000 },
    "financing": { "2022": -30000, "2023": -40000 },
    "netChange": { "2022": 120000, "2023": 150000 },
    "notes": []
  },

  "normalization": {
    "periods": ["2021", "2022", "2023"],
    "reportedNetIncome": { "2021": 140000, "2022": 170000, "2023": 200000 },
    "addbacks": [
      {
        "label": "Owner salary above market",
        "type": "sde",
        "amounts": { "2021": 80000, "2022": 85000, "2023": 90000 },
        "rationale": "Owner takes $200K; market replacement is $110K",
        "confidence": "high"
      }
    ],
    "adjustedSde": 350000,
    "adjustedEbitda": 280000,
    "sdeByPeriod": { "2021": 280000, "2022": 310000, "2023": 350000 },
    "ebitdaByPeriod": { "2021": 220000, "2022": 250000, "2023": 280000 },
    "sdeMargin": 29.2,
    "ebitdaMargin": 23.3,
    "notes": []
  },

  "workingCapital": {
    "periods": ["2022", "2023"],
    "currentAssets": { "2022": 150000, "2023": 200000 },
    "currentLiabilities": { "2022": 80000, "2023": 90000 },
    "netWorkingCapital": { "2022": 70000, "2023": 110000 },
    "nwcAsPercentOfRevenue": { "2022": 6.4, "2023": 9.2 },
    "targetNwc": 90000,
    "pegAmount": null,
    "notes": ["Working capital increasing — may indicate growing receivables or inventory build-up"]
  },

  "insights": {
    "positive": [
      { "title": "Strong revenue growth", "detail": "Revenue grew 15% YoY from 2022 to 2023", "severity": "high" }
    ],
    "negative": [
      { "title": "Margin compression", "detail": "Gross margin declined from 51% to 48%", "severity": "medium" }
    ],
    "neutral": [
      { "title": "Stable working capital", "detail": "NWC as % of revenue is consistent", "severity": "low" }
    ]
  },

  "clarifyingQuestions": [
    {
      "question": "Owner compensation of $200K appears above market rate for this role. Can you confirm the owner's total compensation including benefits and perks?",
      "context": "Needed for accurate SDE normalization",
      "priority": "high",
      "relatedLineItems": ["Officer Compensation"]
    }
  ],

  "aiReasoning": "A brief explanation of the analytical approach, assumptions made, and any data quality concerns."
}

IMPORTANT:
- If a statement type has no data, set its value to null.
- Use the LATEST period for single-value metrics (adjustedSde, adjustedEbitda, etc.).
- Addbacks should include both SDE-only items (owner benefits) and EBITDA items (non-cash, non-recurring). Mark each with type "sde" or "ebitda".
- Confidence on addbacks: "high" = clearly discretionary, "medium" = likely but needs verification, "low" = speculative.
- Clarifying questions should be specific, actionable, and explain why the information matters.
- Insights should be what a buyer would care about when evaluating this business.`,
      },
    ],
  });

  try {
    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const cleaned = text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);

    return {
      reclassifiedPnl: parsed.reclassifiedPnl ?? null,
      reclassifiedBalanceSheet: parsed.reclassifiedBalanceSheet ?? null,
      reclassifiedCashFlow: parsed.reclassifiedCashFlow ?? null,
      normalization: parsed.normalization ?? null,
      workingCapital: parsed.workingCapital ?? null,
      insights: parsed.insights ?? null,
      clarifyingQuestions: parsed.clarifyingQuestions ?? null,
      aiReasoning: parsed.aiReasoning ?? "",
    };
  } catch (err) {
    console.error("Failed to parse comprehensive analysis response:", err);
    return {
      reclassifiedPnl: null,
      reclassifiedBalanceSheet: null,
      reclassifiedCashFlow: null,
      normalization: null,
      workingCapital: null,
      insights: null,
      clarifyingQuestions: null,
      aiReasoning: "Failed to parse AI analysis output.",
    };
  }
}
