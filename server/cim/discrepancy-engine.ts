/**
 * Discrepancy Verification Engine
 *
 * Cross-references seller interview answers against uploaded document data
 * to identify inconsistencies that must be resolved before CIM generation.
 *
 * Example: "You mentioned revenue of $2M but your P&L shows $1.7M"
 */
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 600_000 });

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
  /** Id of a previously raised (still open) discrepancy this finding corresponds to. */
  existingId?: string;
}

/** What the checker needs to know about discrepancies already on the deal. */
export interface ExistingDiscrepancy {
  id: string;
  field: string;
  status: string;
  severity: string;
  interviewValue?: string | null;
  documentValue?: string | null;
  resolvedValue?: string | null;
}

const SEVERITIES = new Set(["critical", "significant", "minor"]);
const CATEGORIES = new Set(["financial", "operational", "legal", "factual"]);

export function normalizeDiscrepancyFieldKey(field: string): string {
  return (field || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Deterministic backstop for the model's existingId: same normalized field
 * key, or a shared meaningful word in the field plus a shared value.
 */
export function isSameDiscrepancy(
  item: { field: string; interviewValue?: string | null; documentValue?: string | null },
  existing: ExistingDiscrepancy,
): boolean {
  if (normalizeDiscrepancyFieldKey(item.field) === normalizeDiscrepancyFieldKey(existing.field)) return true;
  const tokens = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length >= 3));
  const a = tokens(item.field);
  const b = tokens(existing.field);
  let shared = 0;
  a.forEach((t) => { if (b.has(t)) shared++; });
  if (shared === 0) return false;
  const norm = (v: string | null | undefined) => {
    if (!v) return "";
    const idx = v.indexOf(" — ");
    return (idx > 0 ? v.slice(0, idx) : v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  };
  const itemValues = new Set([norm(item.interviewValue), norm(item.documentValue)].filter(Boolean));
  const existingValues = [norm(existing.interviewValue), norm(existing.documentValue), norm(existing.resolvedValue)].filter(Boolean);
  const jaccard = shared / (a.size + b.size - shared);
  return existingValues.some((v) => itemValues.has(v)) || jaccard >= 0.5;
}

/**
 * Run a discrepancy check between seller-provided info and document-extracted data.
 *
 * `existing` — discrepancies already on the deal. Resolved ones are shown to
 * the model as settled (never re-raise) and dropped again on the way out as a
 * backstop; open ones are re-evaluated by id so the route can refresh them in
 * place instead of creating duplicates.
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
  existing: ExistingDiscrepancy[] = [],
): Promise<{ items: DiscrepancyItem[]; clearedIds: string[] }> {
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
    return { items: [], clearedIds: [] }; // Nothing to cross-reference
  }

  // "_"-prefixed keys are broker-private / session-meta — never cross-referenced
  const interviewData = Object.fromEntries(
    Object.entries(deal.extractedInfo || {}).filter(([k]) => !k.startsWith("_")),
  );
  const questionnaireData = deal.questionnaireData || {};

  // Resolved values are the broker's settled truth — overlay them so the
  // model compares documents against the corrected figure, not the stale one.
  const live = existing.filter((d) => d.status !== "superseded");
  const settled = live.filter((d) => d.status === "resolved" || d.status === "accepted");
  const unsettled = live.filter((d) => d.status !== "resolved" && d.status !== "accepted");
  for (const d of settled) {
    if (d.resolvedValue && d.field && Object.prototype.hasOwnProperty.call(interviewData, d.field)) {
      interviewData[d.field] = d.resolvedValue;
    }
  }
  const renderExisting = (d: ExistingDiscrepancy) =>
    `- [${d.id}] ${d.field} (${d.severity}) — seller: ${d.interviewValue ?? "—"} | document: ${d.documentValue ?? "—"}${d.resolvedValue ? ` → resolved value: ${d.resolvedValue}` : ""}`;
  const existingSection = live.length === 0
    ? ""
    : `
## Previously raised discrepancies
${settled.length > 0 ? `RESOLVED by the broker — settled; never raise these again under this field name or any other wording:\n${settled.map(renderExisting).join("\n")}` : ""}
${unsettled.length > 0 ? `STILL OPEN — re-evaluate each against the documents. If it still conflicts, include it in the array with its "existingId"; if the sources now agree, put its id in "clearedIds". Do not silently omit any of them:\n${unsettled.map(renderExisting).join("\n")}` : ""}
`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4096,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `You are a due diligence verification agent for an M&A deal. Cross-reference the seller's interview answers and questionnaire data against the uploaded documents to find inconsistencies.

## Business: ${deal.businessName}
## Industry: ${deal.industry || "unknown"}

## Seller Interview Data (what they told us; values marked as resolved by the broker are final):
${JSON.stringify(interviewData, null, 2)}

## Seller Questionnaire Data:
${JSON.stringify(questionnaireData, null, 2)}

## Uploaded Documents (what the documents show):
${documentSummaries.map(d => `
### ${d.name} (${d.category || "uncategorized"}, ID: ${d.id})
Extracted data: ${JSON.stringify(d.extractedData, null, 2)}
Text snippet: ${d.textSnippet}
`).join("\n---\n")}
${existingSection}
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

## Category rules
- financial: amounts, margins, addbacks · operational: headcount, hours, locations, customers, vendors · legal: leases, licences, contracts, litigation · factual: names, ages, dates, ownership, other non-financial facts

## Output format
Return ONLY a JSON object (no markdown, no explanation):
{
  "discrepancies": [
    {
      "field": "annualRevenue",
      "interviewValue": "what the seller said",
      "documentValue": "what the document shows",
      "documentId": "doc ID from above",
      "documentName": "doc name",
      "severity": "critical|significant|minor",
      "category": "financial|operational|legal|factual",
      "aiExplanation": "clear explanation of the discrepancy",
      "suggestedResolution": "what to ask the seller or how to resolve",
      "existingId": "only when this is the same conflict as a STILL OPEN discrepancy above — its id"
    }
  ],
  "clearedIds": ["ids of STILL OPEN discrepancies the documents now agree with"]
}

If no discrepancies are found, return { "discrepancies": [], "clearedIds": [] }
Important: Only flag real discrepancies with evidence. Do not flag missing data or make assumptions.`,
      },
    ],
  });

  let parsed: any;
  try {
    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const { parseJsonLoose } = await import("../financial/shape");
    parsed = parseJsonLoose(text);
  } catch {
    return { items: [], clearedIds: [] };
  }

  // Accept the object shape, or a bare array from an older-style reply.
  const rawItems: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.discrepancies) ? parsed.discrepancies : [];
  const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
  const existingIds = new Set(live.map((d) => d.id));

  const items: DiscrepancyItem[] = rawItems
    .filter((item) => item && item.field && item.aiExplanation)
    .map((item) => ({
      field: String(item.field),
      interviewValue: String(item.interviewValue ?? ""),
      documentValue: String(item.documentValue ?? ""),
      documentId: String(item.documentId ?? ""),
      documentName: String(item.documentName ?? ""),
      severity: SEVERITIES.has(item.severity) ? item.severity : "significant",
      category: CATEGORIES.has(item.category) ? item.category : "factual",
      aiExplanation: String(item.aiExplanation),
      suggestedResolution: String(item.suggestedResolution ?? ""),
      existingId: isUuid(item.existingId) && existingIds.has(item.existingId) ? item.existingId : undefined,
    }))
    // Backstop: a settled conflict never comes back, whatever the model called it.
    .filter((item) => {
      const byId = item.existingId ? settled.find((d) => d.id === item.existingId) : undefined;
      return !byId && !settled.some((d) => isSameDiscrepancy(item, d));
    });

  const clearedIds: string[] = (Array.isArray(parsed?.clearedIds) ? parsed.clearedIds : [])
    .filter((id: unknown) => isUuid(id) && existingIds.has(id));

  return { items, clearedIds };
}
