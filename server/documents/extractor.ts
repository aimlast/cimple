/**
 * extractor.ts
 *
 * Uses Claude to extract structured knowledge-base data from raw document text.
 *
 * The output is a flat JSON object that maps to knowledge-base fields used
 * by the interview agent and the layout engine. Fields are additive —
 * multiple documents' extractions are merged onto the deal's extractedInfo.
 *
 * Document categories drive which extraction prompt is used:
 *   financials  → P&L, revenue, EBITDA, SDE, addbacks
 *   legal       → lease terms, permits, licenses, contracts
 *   operations  → employees, processes, systems, suppliers
 *   other       → general extraction
 */
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 600_000 });

export interface ExtractedDocumentData {
  // Financials
  revenue?: string;
  grossProfit?: string;
  ebitda?: string;
  sde?: string;
  addbacks?: string;
  netIncome?: string;
  yearsOfData?: string;
  revenueByYear?: Record<string, string>;
  keyFinancialNotes?: string;

  // Lease / location
  leaseExpiry?: string;
  monthlyRent?: string;
  leaseSqft?: string;
  leaseRenewalOptions?: string;
  leaseAddress?: string;
  propertyNotes?: string;

  // Employees
  totalEmployees?: string;
  fullTimeCount?: string;
  partTimeCount?: string;
  keyPersonnel?: string;
  ownerHoursPerWeek?: string;
  employeeNotes?: string;

  // Legal / compliance
  licenses?: string;
  permits?: string;
  legalNotes?: string;
  contracts?: string;

  // Operations
  suppliers?: string;
  inventory?: string;
  equipment?: string;
  operationsNotes?: string;

  // Call transcript
  callDate?: string;
  callDuration?: string;
  callParticipants?: string;
  keyTopics?: string;
  actionItems?: string;
  sellerConcerns?: string;
  buyerInterests?: string;
  followUpNeeded?: string;
  callNotes?: string;

  // General
  summary?: string;
  keyFacts?: string;
  redFlags?: string;

  // Raw confidence note
  _confidence?: string;
  _documentType?: string;
}

const SYSTEM_PROMPT = `You are a skilled M&A analyst extracting structured information from business documents.

Extract ONLY information that is explicitly stated in the document. Do not infer, estimate, or fabricate.
If a field is not present in the document, omit it entirely from your output.

Return a single flat JSON object. Use the exact field names provided. All values are strings.
For numbers, include units (e.g. "$1,200,000", "3,200 sq ft", "12 employees").
For dates, use the format found in the document.

IMPORTANT: Return ONLY the JSON object — no markdown, no explanation.`;

function buildExtractionPrompt(text: string, category: string, subcategory?: string | null): string {
  const docType = subcategory ? `${category} / ${subcategory}` : category;

  return `Extract structured data from this ${docType} document.

DOCUMENT TEXT:
${text.slice(0, 12000)}

Extract all relevant fields into a JSON object. Include:
- _documentType: what type of document this appears to be
- _confidence: "high", "medium", or "low" based on document clarity

For FINANCIAL documents, extract: revenue, grossProfit, ebitda, sde, addbacks, netIncome, yearsOfData, revenueByYear (e.g. {"2022": "$1.2M", "2023": "$1.4M"}), keyFinancialNotes

For LEASE / LEGAL documents, extract: leaseExpiry, monthlyRent, leaseSqft, leaseRenewalOptions, leaseAddress, licenses, permits, contracts, legalNotes

For OPERATIONS / HR documents, extract: totalEmployees, fullTimeCount, partTimeCount, keyPersonnel, ownerHoursPerWeek, suppliers, inventory, equipment, operationsNotes

For CALL TRANSCRIPT documents, extract: callDate, callDuration, callParticipants (who was on the call), keyTopics (main subjects discussed), actionItems (tasks assigned or promised), sellerConcerns (worries or hesitations expressed by seller), buyerInterests (what buyers were interested in), followUpNeeded (outstanding items), callNotes (additional context). Also extract any business facts mentioned (revenue, employees, lease, etc.) into the standard fields above.

For ANY document, also extract: summary (1-2 sentences), keyFacts (most important facts as a comma-separated list), redFlags (any concerning items noted)

Return JSON only.`;
}

export async function extractDocumentData(
  text: string,
  category: string,
  subcategory?: string | null
): Promise<ExtractedDocumentData> {
  if (!text || text.trim().length < 50) {
    return { _documentType: "unreadable", _confidence: "low" };
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: buildExtractionPrompt(text, category, subcategory),
      }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonText = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    return JSON.parse(jsonText) as ExtractedDocumentData;
  } catch (err) {
    console.error("[extractor] Claude extraction failed:", err);
    return { _documentType: category, _confidence: "low", summary: "Extraction failed" };
  }
}

/**
 * mergeExtractedData
 *
 * Merges new extraction results into existing extractedInfo on a deal.
 * New values overwrite existing only if they are more specific (non-empty).
 * Arrays and objects are merged rather than replaced.
 */
export function mergeExtractedData(
  existing: Record<string, unknown>,
  incoming: ExtractedDocumentData
): Record<string, unknown> {
  const merged = { ...existing };

  for (const [key, value] of Object.entries(incoming)) {
    if (!value || key.startsWith("_")) continue;

    if (key === "revenueByYear" && typeof value === "object") {
      // Deep merge revenue-by-year maps
      merged[key] = { ...(existing[key] as Record<string, string> || {}), ...value as Record<string, string> };
    } else if (!merged[key]) {
      // Only set if not already present
      merged[key] = value;
    } else {
      // Existing value present — append new info as addendum if different
      const existing_str = String(merged[key]);
      const new_str = String(value);
      if (!existing_str.includes(new_str)) {
        merged[key] = existing_str + "\n" + new_str;
      }
    }
  }

  return merged;
}
