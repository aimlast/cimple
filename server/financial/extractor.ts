/**
 * Financial Document Extractor
 *
 * Uses Claude (claude-sonnet-4-5) to extract structured, line-item-level
 * financial data from document text (P&L, balance sheet, cash flow, AR aging).
 *
 * Handles raw statements AND broker/valuation workbooks (multi-sheet Excel
 * exports with recast statements, commentary columns, and summary sheets) —
 * the most common real-world input is a broker's valuation workbook, not a
 * clean accountant-prepared statement.
 */

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ timeout: 600_000 });

// ── Types ──

export interface LineItem {
  label: string;
  amounts: Record<string, number>; // keyed by period, e.g. "2023": 150000
  category: string; // e.g. "revenue", "cogs", "operating_expenses"
  subcategory?: string;
  isSubtotal?: boolean;
  isTotal?: boolean;
  notes?: string;
}

export interface ExtractedStatement {
  statementType: "income_statement" | "balance_sheet" | "cash_flow" | "ar_aging";
  periods: string[]; // e.g. ["2021", "2022", "2023"] or ["Q1 2023", "Q2 2023"]
  lineItems: LineItem[];
  currency: string;
  basisOfAccounting?: "cash" | "accrual" | "unknown";
  sourceDocumentId: string;
  sourceDocumentName?: string;
  confidence: number; // 0-1
  notes: string[];
}

// ── Extraction ──

export async function extractFinancialData(
  documentText: string,
  documentId: string,
  documentName: string,
): Promise<ExtractedStatement[]> {
  if (!documentText || documentText.trim().length < 50) {
    return [];
  }

  // Streamed to keep the connection alive — these generations run for minutes
  // and idle non-streaming requests get killed by network timeouts.
  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-5",
    max_tokens: 16000,
    messages: [
      {
        role: "user",
        content: `You are a senior M&A financial analyst. Extract structured financial data from the following document text.

DOCUMENT NAME: ${documentName}

DOCUMENT TEXT:
${documentText.slice(0, 80000)}

INSTRUCTIONS:
1. Identify every financial statement present. This includes:
   - Clean statements: income statement / P&L, balance sheet, cash flow statement, AR aging schedule
   - VALUATION / RECAST WORKBOOKS: broker workbooks are multi-sheet Excel exports (sheets marked like "--- Sheet: 1-IS ---"). They contain historical income statements, recast/normalized P&Ls, SDE schedules, and balance sheets — often as CSV-like rows with commentary in trailing columns. Treat a recast income statement sheet as an income_statement; treat a balance sheet sheet as a balance_sheet. Ignore commentary/notes columns when reading amounts, but the commentary may clarify what a line item is.
2. For each statement, extract EVERY line item with its label, period amounts, and category. Numbers may be formatted like " 898,079 " or "(71,712)" — parentheses mean negative.
3. Preserve the original line-item labels exactly as they appear (without commentary text).
4. Map each line item to a standard category:
   - Income statement: revenue, cogs, gross_profit, operating_expenses, depreciation_amortization, interest, taxes, other_income, other_expense, net_income
   - Balance sheet: current_assets, fixed_assets, other_assets, current_liabilities, long_term_liabilities, equity
   - Cash flow: operating, investing, financing
   - AR aging: current, 30_days, 60_days, 90_days, over_90_days
5. Identify periods (years or quarters). If a workbook mixes sources per column (e.g. "2025 Internal Statements, 2024 Tax Return"), keep the period keys simple ("2025", "2024") and record the source mix in notes.
6. Detect currency (default USD if unclear; Canadian businesses are usually CAD).
7. Note the basis of accounting if detectable (cash vs accrual).
8. Provide a confidence score (0-1) for the extraction quality.
9. Include any notes about anomalies, missing data, source mix per column, or assumptions.
10. If the same statement appears twice (e.g. raw and recast), extract both and note which is which.

Respond with valid JSON only — an array of extracted statements. Each element:
{
  "statementType": "income_statement" | "balance_sheet" | "cash_flow" | "ar_aging",
  "periods": ["2021", "2022", "2023"],
  "lineItems": [
    {
      "label": "Gross Revenue",
      "amounts": { "2021": 500000, "2022": 600000, "2023": 720000 },
      "category": "revenue",
      "subcategory": "gross_revenue",
      "isSubtotal": false,
      "isTotal": false,
      "notes": ""
    }
  ],
  "currency": "USD",
  "basisOfAccounting": "accrual",
  "confidence": 0.92,
  "notes": ["2025 column is from internal statements; 2022-2024 from tax returns"]
}

If no financial statements are found, return an empty array [].`,
      },
    ],
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === "max_tokens") {
    console.warn(
      `Financial extraction for "${documentName}" hit the output token limit — result may be truncated.`,
    );
  }

  try {
    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const { parseJsonLoose } = await import("./shape");
    const parsed = parseJsonLoose<ExtractedStatement[]>(text);
    if (!Array.isArray(parsed)) return [];

    // Attach source document ID + name, drop empty statements
    return parsed
      .filter((stmt) => stmt && Array.isArray(stmt.lineItems) && stmt.lineItems.length > 0)
      .map((stmt) => ({
        ...stmt,
        sourceDocumentId: documentId,
        sourceDocumentName: documentName,
      }));
  } catch (err) {
    console.error(`Failed to parse financial extraction response for "${documentName}":`, err);
    return [];
  }
}
