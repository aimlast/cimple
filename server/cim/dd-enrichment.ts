/**
 * DD (Due Diligence) CIM Enrichment Engine
 *
 * Enriches normal CIM sections with previously withheld sensitive information:
 * - Customer names revealed in charts (replacing "Customer A" etc.)
 * - Addback verification details shown inline
 * - Financial comparison against bank statements / T2s
 * - Revenue verification commentary
 *
 * The DD version uses the same layout/format but highlights what's new:
 * newly revealed or newly added spans inside FREE-TEXT fields are wrapped in
 * the sentinel pair `[[dd]]…[[/dd]]`, which the client renders as a brass
 * highlight (client/src/components/cim/richText.tsx). Labels, values, chart
 * names and table cells are revealed without markers — a sentinel inside a
 * chart label would render literally. `sanitizeDdOutput` enforces that
 * split on whatever the model returns, and strips the legacy literal "[DD]"
 * tag so it never reaches a buyer.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { CimSection } from "@shared/schema";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 600_000 });

export const DD_OPEN = "[[dd]]";
export const DD_CLOSE = "[[/dd]]";

/** Fields whose strings may carry `[[dd]]` markers — mirrors PROSE_KEYS in richText.tsx. */
const PROSE_KEYS = new Set([
  "body", "description", "caption", "footnote", "footnotes", "notes", "pullQuote",
  "highlights", "summary", "tagline", "content", "normalizedCaption", "normalizedFootnotes",
  "ownerDependency",
]);

const LEGACY_DD_TAG = /\[DD\]\s*/g;
const DD_MARK = /\[\[\/?dd\]\]/g;

/** Remove every DD sentinel and legacy tag — for any consumer that wants plain text (chatbot, search). */
export function stripDdMarkers(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(LEGACY_DD_TAG, "").replace(DD_MARK, "");
}

/** Balance stray sentinels so a lone opener can't highlight to the end of the text. */
function balanceDdMarkers(text: string): string {
  const cleaned = text.replace(LEGACY_DD_TAG, "");
  const opens = (cleaned.match(/\[\[dd\]\]/g) || []).length;
  const closes = (cleaned.match(/\[\[\/dd\]\]/g) || []).length;
  if (opens === closes) return cleaned;
  // Unbalanced: drop the markers rather than guess the span.
  return cleaned.replace(DD_MARK, "");
}

/** Deep-walk layoutData: prose fields keep (balanced) markers, everything else is plain. */
export function sanitizeDdLayoutData<T>(value: T, parentKey = "", depth = 0): T {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") {
    return (PROSE_KEYS.has(parentKey) ? balanceDdMarkers(value) : stripDdMarkers(value)) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeDdLayoutData(v, parentKey, depth + 1)) as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeDdLayoutData(v, k, depth + 1);
    }
    return out as T;
  }
  return value;
}

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

/** Shape the stored override: balanced markers in prose, plain text elsewhere, no legacy tags. */
export function sanitizeDdOutput(layoutData: any, contentOverride: string): { layoutData: any; contentOverride: string } {
  return {
    layoutData: sanitizeDdLayoutData(layoutData),
    contentOverride: balanceDdMarkers(contentOverride || ""),
  };
}

async function enrichSection(
  section: CimSection,
  ddContext: string,
  deal: { businessName: string; industry?: string | null },
): Promise<DdEnrichmentResult> {
  const layoutData = section.layoutData as any || {};
  const content = section.brokerEditedContent || section.aiDraftContent || "";

  // Cover pages and dividers carry nothing to enrich — skip the model call so
  // they can't come back with stray markers or a reworded title.
  if (section.layoutType === "cover_page" || section.layoutType === "divider") {
    return { cimSectionId: String(section.id), layoutData, contentOverride: content };
  }

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `You are enriching a CIM section for the Due Diligence version. The DD CIM reveals previously withheld sensitive information and adds verification details.

## What to do
1. If this section contains anonymized references (Customer A, Supplier A, etc.), replace them with real names from the DD context below
2. If this section is financial, add inline commentary comparing stated figures against document-verified figures
3. If addback verification data is available and relevant, add verification status notes
4. MARK WHAT IS NEW. Wrap every newly revealed or newly added span of text in the sentinel pair ${DD_OPEN} and ${DD_CLOSE}, for example: "Revenue is concentrated with ${DD_OPEN}Acme Logistics (31%)${DD_CLOSE}." The viewer renders that span as a highlight.
   - Use the markers ONLY inside free-text fields: body, description, caption, footnote(s), notes, pullQuote, highlights, summary, and the content text.
   - NEVER put markers in labels, values, names, titles, chart data, table cells or metric values — reveal those plainly (e.g. change "Customer A" to "Acme Logistics" with no markers).
   - NEVER write a literal "[DD]" tag. The markers above are the only way to flag new information.
   - Keep markers balanced: every ${DD_OPEN} has a matching ${DD_CLOSE} in the same string.
5. KEEP the same layoutData JSON structure — only enrich string values
6. For charts/tables: update labels to show real names where applicable
7. Plain text only — no markdown (no **bold**, no # headings, no bullet runs inside a prose string)

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
  "contentOverride": "<enriched content with ${DD_OPEN}…${DD_CLOSE} around new information>"
}

If this section has nothing to enrich, return the original data unchanged.`,
      },
    ],
  });

  try {
    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);
    const clean = sanitizeDdOutput(parsed.layoutData || layoutData, parsed.contentOverride || content);

    return {
      cimSectionId: String(section.id),
      layoutData: clean.layoutData,
      contentOverride: clean.contentOverride,
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
