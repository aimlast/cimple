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
import {
  canonicalFieldName,
  setFieldSource,
  getFieldSources,
  sourceAllowsOverwrite,
  sourceRank,
  recordAlternate,
  isSuppressed,
  type FieldSource,
  type SourceKind,
} from "../interview/info-merger";
import { agentConfig } from "../interview/config/load-config";

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

  // Canonical CIM narrative fields — these match shared/schema.ts
  // extractedInfoSchema exactly. The coverage classifier
  // (server/interview/knowledge-base.ts SECTION_FIELD_MAP) reads these
  // names, so extractions landing here light up the CIM COVERAGE panel
  // and stop the interview agent from re-asking answered questions.
  companyHistory?: string;
  yearsOperating?: string;
  entityType?: string;
  competitiveAdvantage?: string;
  uniqueSellingProposition?: string;
  strengths?: string;
  growthOpportunities?: string;
  expansionPlans?: string;
  targetMarket?: string;
  customerDemographics?: string;
  customerBase?: string;
  permitsLicenses?: string;
  seasonality?: string;
  revenueStreams?: string;
  keyProducts?: string;
  customerConcentration?: string;
  leaseDetails?: string;
  propertyInfo?: string;
  employees?: string;
  employeeStructure?: string;
  ownerInvolvement?: string;
  managementTeam?: string;
  idealBuyer?: string;
  trainingSupport?: string;
  transitionPlan?: string;
  reasonForSale?: string;
  askingPrice?: string;
  saleType?: string;
  assetsIncluded?: string;

  // Raw confidence note (stripped at merge — "_"-prefixed keys never land
  // on the deal's extractedInfo)
  _confidence?: string;
  _documentType?: string;

  // Open-ended extraction is still allowed — ad-hoc keys are merged too and
  // canonicalised where an alias exists (see mergeExtractedData).
  [key: string]: string | Record<string, string> | undefined;
}

const SYSTEM_PROMPT = `You are a skilled M&A analyst extracting structured information about a business that is being sold, from one source (a document, an email, a call transcript, a broker's CRM note, or public web content).

Extract ONLY information that is explicitly stated in the source. Do not infer, estimate, or fabricate.
If a field is not present, omit it entirely.

Record everything with the record_extraction tool. Use the exact field names provided. All values are strings except revenueByYear (an object of year → amount).
For numbers, include units (e.g. "$1,200,000", "3,200 sq ft", "12 employees").
For dates, use the format found in the source.`;

/** What kind of source the text is — drives how it is read (see SOURCE_GUIDANCE). */
export type ExtractionSourceKind = SourceKind;

/**
 * How to read each kind of source. The same business facts are extracted from
 * all of them, but WHO is speaking decides what counts as a fact.
 */
const SOURCE_GUIDANCE: Partial<Record<SourceKind, string>> = {
  email: `THIS SOURCE IS AN EMAIL (or email thread).
- Work out who wrote each message (sender line, signature, quoted replies) and when.
- A statement by the seller, the business's staff or its accountant about the business is a fact; a question or suggestion from the broker or anyone else is NOT a fact.
- Quoted older messages count too — attribute them to their own sender.
- In summary, say who wrote to whom and the date(s); in keyFacts, prefix each fact with who said it (e.g. "Seller: revenue about $2.1M in 2024").`,
  call: `THIS SOURCE IS A CALL TRANSCRIPT (phone or in-person meeting between the broker and the seller).
- Attribute every statement to its speaker. The SELLER's statements about the business are facts. The BROKER's lines are questions or prompts — never facts on their own.
- A broker statement becomes a fact only when the seller clearly agrees with it ("yes, that's right").
- If speakers are not labelled, use context (the person describing their own business is the seller); when you cannot tell who said something, leave it out.
- Also fill callDate, callParticipants, keyTopics, actionItems, sellerConcerns, followUpNeeded, callNotes.`,
  video_call: `THIS SOURCE IS A VIDEO-CALL TRANSCRIPT (Zoom / Google Meet / Teams / Cimple call between the broker and the seller).
- Attribute every statement to its speaker. The SELLER's statements about the business are facts. The BROKER's lines are questions or prompts — never facts on their own.
- A broker statement becomes a fact only when the seller clearly agrees with it.
- When you cannot tell who said something, leave it out.
- Also fill callDate, callParticipants, keyTopics, actionItems, sellerConcerns, followUpNeeded, callNotes.`,
  crm: `THIS SOURCE IS THE BROKER'S OWN CRM NOTE (Pipedrive / HubSpot / Salesforce record, activity or note).
- These are the broker's second-hand notes about the seller and the business — useful leads, not verified facts. Extract them faithfully as written; they will be confirmed with the seller later.
- Do not upgrade hedged wording ("approx.", "thinks", "~") into firm figures — keep the hedge in the value.
- Ignore CRM housekeeping (pipeline stage, owner, follow-up reminders) unless it states a fact about the business; put next steps in actionItems.`,
  website: `THIS SOURCE IS PUBLIC WEB CONTENT (the business's website or a directory/review page).
- Everything here is a public marketing claim, unverified. Extract concrete claims only (years in business, services, locations, awards, team names, customer types) and keep the claim's own wording.
- Do not extract financial figures unless the page states them explicitly; never infer size from marketing language.`,
  social: `THIS SOURCE IS A SOCIAL MEDIA POST OR PROFILE (LinkedIn, Facebook, Instagram, Google Business…).
- Everything here is public, self-promotional and unverified. Extract concrete claims only (services, locations, awards, milestones, team, customer types) in the post's own words.
- Never infer financials or size from engagement or marketing language.`,
};

function buildExtractionPrompt(text: string, category: string, subcategory: string | null | undefined, kind: SourceKind): string {
  const docType = subcategory ? `${category} / ${subcategory}` : category;
  const guidance = SOURCE_GUIDANCE[kind];
  const label = kind === "document" ? `${docType} document` : `${kind.replace("_", " ")} (${docType})`;

  return `Extract structured data from this ${label}.
${guidance ? `\n${guidance}\n` : ""}
SOURCE TEXT:
${text.slice(0, MAX_SOURCE_CHARS)}
${text.length > MAX_SOURCE_CHARS ? `\n[… source truncated after ${MAX_SOURCE_CHARS.toLocaleString()} characters]\n` : ""}
Extract all relevant fields. Include:
- _documentType: what type of source this appears to be
- _confidence: "high", "medium", or "low" based on how clear and direct the source is

For FINANCIAL documents, extract: revenue, grossProfit, ebitda, sde, addbacks, netIncome, yearsOfData, revenueByYear (e.g. {"2022": "$1.2M", "2023": "$1.4M"}), keyFinancialNotes

For LEASE / LEGAL documents, extract: leaseExpiry, monthlyRent, leaseSqft, leaseRenewalOptions, leaseAddress, contracts, legalNotes, permitsLicenses (all licenses and permits)

For OPERATIONS / HR documents, extract: employees (total headcount), fullTimeCount, partTimeCount, keyPersonnel, ownerInvolvement (incl. hours/week), suppliers, inventory, assetsIncluded (equipment and assets), operationsNotes

For CALL TRANSCRIPTS, extract: callDate, callDuration, callParticipants (who was on the call), keyTopics (main subjects discussed), actionItems (tasks assigned or promised), sellerConcerns (worries or hesitations expressed by seller), buyerInterests (what buyers were interested in), followUpNeeded (outstanding items), callNotes (additional context). Also extract any business facts mentioned (revenue, employees, lease, etc.) into the standard fields above.

For ANY source that describes the business itself (business overviews, CBOs, CIMs, marketing materials, questionnaires, websites, emails, calls, notes), also extract the following CANONICAL CIM fields. Use these exact field names when the source contains the information:
- Company: companyHistory, yearsOperating, entityType
- Strengths: competitiveAdvantage, uniqueSellingProposition, strengths
- Growth: growthOpportunities, expansionPlans
- Market: targetMarket, customerDemographics, customerBase
- Compliance: permitsLicenses
- Seasonality: seasonality
- Revenue mix: revenueStreams, keyProducts, customerConcentration
- Property: leaseDetails (summary of lease terms), propertyInfo
- People: employees (total headcount), employeeStructure, ownerInvolvement, managementTeam
- Sale: idealBuyer, trainingSupport, transitionPlan, reasonForSale, askingPrice, saleType, assetsIncluded

Any other clearly business-relevant fact may use its own specific camelCase key (e.g. operatoryCount, bondingCapacity).

For ANY source, also extract: summary (1-2 sentences), keyFacts (most important facts as a comma-separated list), redFlags (any concerning items noted)

PRIVATE MATTERS: personal or sensitive things about the owner, their family or staff that must never appear in a sales document — health, family or marital matters, personal money trouble, legal trouble not about the business, or anything the source marks private / confidential / "don't share" — go ONLY in _privateNotes (a list of short, factual notes). Never put them in a business field: e.g. reasonForSale stays neutral ("Owner retiring") and the health detail goes in _privateNotes.`;
}

/** Long sources (full-year email threads, hour-long calls) are read in full up to this size. */
const MAX_SOURCE_CHARS = 60_000;

const EXTRACTION_TOOL = {
  name: "record_extraction",
  description: "Record every fact extracted from the source.",
  input_schema: {
    type: "object" as const,
    additionalProperties: true,
    properties: {
      _documentType: { type: "string" },
      _confidence: { type: "string", enum: ["high", "medium", "low"] },
      summary: { type: "string" },
      keyFacts: { type: "string" },
      redFlags: { type: "string" },
      revenueByYear: { type: "object", additionalProperties: { type: "string" } },
      _privateNotes: { type: "array", items: { type: "string" } },
    },
  },
};

/** Keeps only string values (plus the revenueByYear map) — the merge contract. */
function normaliseExtraction(raw: Record<string, unknown>): ExtractedDocumentData {
  const out: ExtractedDocumentData = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined || v === "") continue;
    if (k === "revenueByYear" && typeof v === "object" && !Array.isArray(v)) {
      const map: Record<string, string> = {};
      for (const [y, amount] of Object.entries(v as Record<string, unknown>)) {
        if (amount !== null && amount !== undefined && amount !== "") map[y] = String(amount);
      }
      if (Object.keys(map).length > 0) out[k] = map;
      continue;
    }
    if (k === "_privateNotes") {
      // Kept apart (one per line) — ingestion routes them to the broker-private notes.
      const notes = (Array.isArray(v) ? v : [v]).map((x) => String(x ?? "").trim()).filter(Boolean);
      if (notes.length > 0) out[k] = notes.join("\n");
      continue;
    }
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");
    else out[k] = JSON.stringify(v);
  }
  return out;
}

export async function extractDocumentData(
  text: string,
  category: string,
  subcategory?: string | null,
  /** What kind of source this is — an email or call is read differently from a P&L. */
  kind: SourceKind = "document",
): Promise<ExtractedDocumentData> {
  if (!text || text.trim().length < 50) {
    return { _documentType: "unreadable", _confidence: "low" };
  }

  try {
    // Tool-forced JSON with a generous output budget: long transcripts used
    // to overflow 2,000 tokens mid-object and the whole extraction failed.
    const response = await anthropic.messages.create({
      model: agentConfig.models.supportingAgents,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: "tool", name: EXTRACTION_TOOL.name },
      messages: [{
        role: "user",
        content: buildExtractionPrompt(text, category, subcategory, kind),
      }],
    });

    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use" || !block.input || typeof block.input !== "object") {
      throw new Error(`no extraction returned (stop_reason ${response.stop_reason})`);
    }
    if (response.stop_reason === "max_tokens") {
      console.warn(`[extractor] extraction hit the output limit — keeping what was recorded`);
    }
    return normaliseExtraction(block.input as Record<string, unknown>);
  } catch (err) {
    console.error("[extractor] Claude extraction failed:", err);
    return { _documentType: category, _confidence: "low", summary: "Extraction failed" };
  }
}

/**
 * Lease sub-fields that get folded into a single labeled `leaseDetails`
 * string (the canonical narrative field coverage reads). The raw keys are
 * ALSO kept verbatim — the financial tab reads them individually.
 */
const LEASE_COMPOSITE_PARTS: Array<{ key: string; label: string }> = [
  { key: "leaseAddress", label: "Address" },
  { key: "leaseSqft", label: "Size" },
  { key: "monthlyRent", label: "Rent" },
  { key: "leaseExpiry", label: "Expires" },
  { key: "leaseRenewalOptions", label: "Renewal options" },
];

/** Who asserted an extraction: the source row and its kind. */
export interface MergeSource {
  documentId?: string;
  /** Defaults to "document". */
  source?: SourceKind;
  /** ISO timestamp recorded on every fact (defaults to now). */
  at?: string;
  note?: string;
}

/**
 * mergeExtractedData
 *
 * Merges one source's extraction into existing extractedInfo with provenance.
 *
 * - Every incoming key is routed through canonicalFieldName so extractions
 *   land on the canonical field names the coverage classifier and the
 *   interview prompt read (revenue → annualRevenue, licenses →
 *   permitsLicenses, …). Keys without an alias are kept verbatim.
 * - Each written fact records {source: kind, documentId, at}.
 * - An empty field is filled. A field that already holds a value is replaced
 *   only by a STRICTLY higher-ranked kind (see SOURCE_RANK) — an email beats
 *   a document, a CRM note never displaces a document, nothing but a live
 *   interview displaces an untracked legacy value. The displaced or losing
 *   value is kept as an alternate, never discarded.
 * - Keys the broker deleted (_brokerSuppressed) are never written back.
 */
export function mergeExtractedData(
  existing: Record<string, unknown>,
  incoming: ExtractedDocumentData,
  /** The source row asserting these values (a bare string is its documentId,
   *  for older callers) — recorded per field so higher authorities outrank it
   *  and deleting the source removes its facts. */
  origin?: string | MergeSource,
): Record<string, unknown> {
  const merged = { ...existing };
  const o: MergeSource = typeof origin === "string" ? { documentId: origin } : origin ?? {};
  const kind: SourceKind = o.source ?? "document";
  const documentId = o.documentId;
  const src: FieldSource = {
    source: kind,
    ...(documentId ? { documentId } : {}),
    at: o.at ?? new Date().toISOString(),
    ...(o.note ? { note: o.note } : {}),
  };

  const mergeValue = (key: string, value: unknown) => {
    if (isSuppressed(merged, key)) return; // the broker deleted it — stays deleted
    const current = merged[key];
    if (key === "revenueByYear") {
      // Deep merge ONLY when both sides are maps — spreading a string
      // produced a character-indexed object that broke buyer matching.
      const curIsObj = !!current && typeof current === "object" && !Array.isArray(current);
      const incObj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : null;
      if (current && !curIsObj) { recordAlternate(merged, key, value, src); return; } // seller's own text stands
      if (!incObj) { if (!current) { merged[key] = value; setFieldSource(merged, key, src); } else recordAlternate(merged, key, value, src); return; }
      // Per-year contributors: never overwrite a year already on file; each
      // year remembers its document so deleting one P&L removes only its years.
      const curObj = curIsObj ? { ...(current as Record<string, string>) } : {};
      const prevSrc = getFieldSources(merged)[key];
      const years: Record<string, string> = { ...(prevSrc?.years || {}) };
      for (const [y, v] of Object.entries(incObj)) {
        if (curObj[y] === undefined || curObj[y] === "") { curObj[y] = v; if (documentId) years[y] = documentId; }
        else if (String(curObj[y]) !== String(v)) recordAlternate(merged, `${key}.${y}`, v, src);
      }
      merged[key] = curObj;
      setFieldSource(merged, key, {
        ...(prevSrc ?? src),
        documentId: prevSrc?.documentId ?? documentId,
        ...(Object.keys(years).length ? { years } : {}),
      });
      return;
    }
    const empty = current === null || current === undefined || current === "";
    if (empty) {
      merged[key] = value;
      setFieldSource(merged, key, src);
      return;
    }
    // One canonical value per field — two sources never get glued together
    // with newlines. A strictly higher authority replaces the value (the old
    // one becomes an alternate); an equal or lower one is kept as the
    // alternate for the discrepancy engine and the broker's review.
    if (String(current) === String(value)) return;
    const cur = getFieldSources(merged)[key];
    const outranks = cur
      ? sourceRank(kind) > sourceRank(cur.source)
      : sourceAllowsOverwrite(merged, key, kind);
    if (outranks) {
      recordAlternate(merged, key, current, cur ?? { source: "system", note: "Recorded before sources were tracked" });
      merged[key] = value;
      setFieldSource(merged, key, src);
      return;
    }
    recordAlternate(merged, key, value, src);
  };

  for (const [key, value] of Object.entries(incoming)) {
    if (!value || key.startsWith("_")) continue;
    mergeValue(canonicalFieldName(key), value);
  }

  // Fold individual lease facts into the canonical leaseDetails narrative
  // field so the real-estate section shows as covered. The raw keys were
  // already merged verbatim above (no alias exists for them) so the
  // financial tab keeps its granular values.
  // Skip when the extraction already provided its own leaseDetails summary —
  // building the composite too would append a near-duplicate block.
  if (!incoming.leaseDetails) {
    const leaseParts = LEASE_COMPOSITE_PARTS
      .map(({ key, label }) => {
        const v = incoming[key];
        return v && typeof v === "string" ? `${label}: ${v}` : null;
      })
      .filter((p): p is string => p !== null);
    if (leaseParts.length > 0) {
      mergeValue("leaseDetails", leaseParts.join("; "));
    }
  }

  return merged;
}
