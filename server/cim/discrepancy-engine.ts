/**
 * Discrepancy Verification Engine
 *
 * Cross-references seller interview answers against uploaded document data
 * to identify inconsistencies that must be resolved before CIM generation.
 *
 * Example: "You mentioned revenue of $2M but your P&L shows $1.7M"
 */
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface DiscrepancyItem {
  field: string;
  interviewValue: string;
  documentValue: string;
  documentId: string;
  documentName: string;
  severity: "critical" | "significant" | "minor";
  category: "financial" | "operational" | "legal" | "factual";
  aiExplanation: string;
  suggestedResolution: string;
}

/**
 * Run a discrepancy check between seller-provided info and document-extracted data.
 */
export async function runDiscrepancyCheck(
  deal: {
    id: string;
    businessName: string;
    industry?: string | null;
    extractedInfo: Record<string, any>;
    questionnaireData?: Record<string, any> | null;
  },
  documents: Array<{
    id: string;
    name: string;
    category: string | null;
    extractedText: string | null;
    extractedData: any;
  }>,
): Promise<DiscrepancyItem[]> {
  // Collect document-extracted data
  const documentSummaries = documents
    .filter(d => d.extractedText || d.extractedData)
    .map(d => ({
      id: d.id,
      name: d.name,
      category: d.category,
      extractedData: d.extractedData || {},
      textSnippet: d.extractedText?.slice(0, 3000) || "",
    }));

  if (documentSummaries.length === 0) {
    return []; // Nothing to cross-reference
  }

  const interviewData = deal.extractedInfo || {};
  const questionnaireData = deal.questionnaireData || {};

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250514",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `You are a due diligence verification agent for an M&A deal. Cross-reference the seller's interview answers and questionnaire data against the uploaded documents to find inconsistencies.

## Business: ${deal.businessName}
## Industry: ${deal.industry || "unknown"}

## Seller Interview Data (what they told us):
${JSON.stringify(interviewData, null, 2)}

## Seller Questionnaire Data:
${JSON.stringify(questionnaireData, null, 2)}

## Uploaded Documents (what the documents show):
${documentSummaries.map(d => `
### ${d.name} (${d.category || "uncategorized"}, ID: ${d.id})
Extracted data: ${JSON.stringify(d.extractedData, null, 2)}
Text snippet: ${d.textSnippet}
`).join("\n---\n")}

## Your task
Compare factual claims from the interview/questionnaire against document evidence. Flag discrepancies where:
1. Financial figures differ by more than 5% (revenue, expenses, profit, SDE, EBITDA)
2. Employee counts or structure don't match
3. Lease terms, dates, or conditions conflict
4. Customer/vendor claims don't match documents
5. Operational claims (hours, locations, assets) differ
6. Any other factual inconsistency

## Severity rules
- **critical**: Financial discrepancies >10%, core business claims that don't match
- **significant**: Financial discrepancies 5-10%, operational inconsistencies
- **minor**: Minor date differences, rounding issues, formatting differences

## Output format
Return ONLY a JSON array (no markdown, no explanation):
[
  {
    "field": "annualRevenue",
    "interviewValue": "what the seller said",
    "documentValue": "what the document shows",
    "documentId": "doc ID from above",
    "documentName": "doc name",
    "severity": "critical|significant|minor",
    "category": "financial|operational|legal|factual",
    "aiExplanation": "clear explanation of the discrepancy",
    "suggestedResolution": "what to ask the seller or how to resolve"
  }
]

If no discrepancies are found, return an empty array: []
Important: Only flag real discrepancies with evidence. Do not flag missing data or make assumptions.`,
      },
    ],
  });

  try {
    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const items: DiscrepancyItem[] = JSON.parse(jsonMatch[0]);
    // Validate required fields
    return items.filter(
      (item) =>
        item.field &&
        item.severity &&
        item.category &&
        item.aiExplanation,
    );
  } catch {
    return [];
  }
}
