/**
 * Financial Document Extractor
 *
 * Uses Claude (claude-sonnet-4-5) to extract structured, line-item-level
 * financial data from document text (P&L, balance sheet, cash flow, AR aging).
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

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: `You are a senior M&A financial analyst. Extract structured financial data from the following document text.

DOCUMENT NAME: ${documentName}

DOCUMENT TEXT:
${documentText.slice(0, 60000)}

INSTRUCTIONS:
1. Identify every financial statement present (income statement / P&L, balance sheet, cash flow statement, AR aging schedule).
2. For each statement, extract EVERY line item with its label, period amounts, and category.
3. Preserve the original line-item labels exactly as they appear.
4. Map each line item to a standard category:
   - Income statement: revenue, cogs, gross_profit, operating_expenses, depreciation_amortization, interest, taxes, other_income, other_expense, net_income
   - Balance sheet: current_assets, fixed_assets, other_assets, current_liabilities, long_term_liabilities, equity
   - Cash flow: operating, investing, financing
   - AR aging: current, 30_days, 60_days, 90_days, over_90_days
5. Identify periods (years or quarters).
6. Detect currency (default USD if unclear).
7. Note the basis of accounting if detectable (cash vs accrual).
8. Provide a confidence score (0-1) for the extraction quality.
9. Include any notes about anomalies, missing data, or assumptions.

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
  "notes": ["Some minor rounding differences detected"]
}

If no financial statements are found, return an empty array [].`,
      },
    ],
  });

  try {
    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    // Strip markdown fences if present
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed: ExtractedStatement[] = JSON.parse(cleaned);

    // Attach source document ID
    return parsed.map((stmt) => ({
      ...stmt,
      sourceDocumentId: documentId,
    }));
  } catch (err) {
    console.error("Failed to parse financial extraction response:", err);
    return [];
  }
}
