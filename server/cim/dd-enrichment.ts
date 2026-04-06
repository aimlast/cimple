/**
 * DD (Due Diligence) CIM Enrichment Engine
 *
 * Enriches normal CIM sections with previously withheld sensitive information:
 * - Customer names revealed in charts (replacing "Customer A" etc.)
 * - Addback verification details shown inline
 * - Financial comparison against bank statements / T2s
 * - Revenue verification commentary
 *
 * The DD version uses the same layout/format but highlights what's new.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { CimSection } from "@shared/schema";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface DdEnrichmentResult {
  cimSectionId: string;
  layoutData: any;
  contentOverride: string;
}

/**
 * Generate DD-enriched overrides for CIM sections.
 */
export async function generateDdOverrides(
  sections: CimSection[],
  deal: {
    businessName: string;
    industry?: string | null;
    extractedInfo?: Record<string, any> | null;
  },
  additionalData: {
    addbackVerification?: any;
    financialAnalysis?: any;
    documents?: Array<{ name: string; category: string; extractedText?: string | null }>;
  },
): Promise<DdEnrichmentResult[]> {
  const results: DdEnrichmentResult[] = [];

  // Build the DD context from available data
  const ddContext = buildDdContext(deal, additionalData);

  for (let i = 0; i < sections.length; i += 3) {
    const batch = sections.slice(i, i + 3);
    const batchResults = await Promise.all(
      batch.map((section) => enrichSection(section, ddContext, deal)),
    );
    results.push(...batchResults);
  }

  return results;
}

function buildDdContext(
  deal: { extractedInfo?: Record<string, any> | null },
  data: {
    addbackVerification?: any;
    financialAnalysis?: any;
    documents?: Array<{ name: string; category: string; extractedText?: string | null }>;
  },
): string {
  const parts: string[] = [];
  const info = deal.extractedInfo || {};

  // Customer names (if available from extracted info)
  if (info.customers || info.topCustomers || info.customerConcentration) {
    parts.push(`## Real Customer Data\n${JSON.stringify(info.customers || info.topCustomers || info.customerConcentration, null, 2)}`);
  }

  // Addback verification results
  if (data.addbackVerification) {
    const av = data.addbackVerification;
    const addbacks = (av.addbacks as any[]) || [];
    if (addbacks.length > 0) {
      parts.push(`## Addback Verification\nStatus: ${av.status}\n${addbacks.map((ab: any) =>
        `- ${ab.label}: ${ab.verificationStatus} (${ab.matchedTransactions?.length || 0} supporting transactions)`
      ).join("\n")}`);
    }
  }

  // Financial analysis highlights
  if (data.financialAnalysis) {
    const fa = data.financialAnalysis;
    if (fa.normalization) {
      parts.push(`## Financial Normalization\n${JSON.stringify(fa.normalization, null, 2)}`);
    }
    if (fa.clarifyingQuestions) {
      const cqs = (fa.clarifyingQuestions as any[]) || [];
      if (cqs.length > 0) {
        parts.push(`## Financial Clarifying Questions\n${cqs.map((q: any) => `- ${q.question}`).join("\n")}`);
      }
    }
  }

  // Document summaries for verification
  if (data.documents && data.documents.length > 0) {
    const financialDocs = data.documents.filter(d =>
      d.category === "financials" || d.category === "tax_returns" || d.category === "bank_statements"
    );
    if (financialDocs.length > 0) {
      parts.push(`## Supporting Documents\n${financialDocs.map(d => `- ${d.name} (${d.category})`).join("\n")}`);
    }
  }

  return parts.join("\n\n") || "No additional DD data available.";
}

async function enrichSection(
  section: CimSection,
  ddContext: string,
  deal: { businessName: string; industry?: string | null },
): Promise<DdEnrichmentResult> {
  const layoutData = section.layoutData as any || {};
  const content = section.brokerEditedContent || section.aiDraftContent || "";

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250514",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `You are enriching a CIM section for the Due Diligence version. The DD CIM reveals previously withheld sensitive information and adds verification details.

## What to do
1. If this section contains anonymized references (Customer A, Supplier A, etc.), replace them with real names from the DD context below
2. If this section is financial, add inline commentary comparing stated figures against document-verified figures
3. If addback verification data is available and relevant, add verification status notes
4. Add "[DD]" prefix to any newly revealed data points so buyers can quickly see what's new
5. KEEP the same layoutData JSON structure — only enrich string values
6. For charts/tables: update labels to show real names where applicable

## Business: ${deal.businessName}
## Industry: ${deal.industry || "unknown"}

## DD Context (sensitive data to incorporate):
${ddContext}

## Section to enrich:
Title: ${section.sectionTitle}
Layout type: ${section.layoutType}

### layoutData (JSON):
${JSON.stringify(layoutData, null, 2)}

### Content text:
${content}

## Output format
Respond with ONLY a JSON object (no markdown):
{
  "layoutData": <enriched layoutData>,
  "contentOverride": "<enriched content with [DD] markers on new info>"
}

If this section has nothing to enrich (e.g. it's a divider or cover page), return the original data unchanged.`,
      },
    ],
  });

  try {
    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      cimSectionId: String(section.id),
      layoutData: parsed.layoutData || layoutData,
      contentOverride: parsed.contentOverride || content,
    };
  } catch {
    // Fallback: return original (no enrichment)
    return {
      cimSectionId: String(section.id),
      layoutData,
      contentOverride: content,
    };
  }
}
