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
  isSuppressed,
  compareYearKeysDesc,
  SOURCE_META_KEYS,
  type FieldSource,
  type SourceKind,
} from "../interview/info-merger";
import {
  cleanExtractedValue,
  cleanYearMap,
  headlineKeyFor,
  isBrokerProcessKey,
  isSpecialistSource,
  isYearMapKey,
  mergeScalarInto,
  mergeYearMapInto,
  normalisePeriod,
  periodForYear,
  periodYear,
  reconcileHeadlines,
  splitMultiYearValue,
  stripYearTag,
  yearMapKeyFor,
  yearSuffixedKey,
  HEADLINE_MAPS,
  type MergeContext,
} from "./merge-policy";
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
  /** ISO end date of the latest fiscal period the source reports (normalised). */
  _periodEnd?: string;
  /** Per-key fiscal period when it differs from _periodEnd ("$31,020,000 (FY2024)"). */
  _keyPeriods?: Record<string, string>;
  /** Comma-separated keys whose value the reader worked out or that were vague (lowest priority). */
  _inferredKeys?: string;

  // Open-ended extraction is still allowed — ad-hoc keys are merged too and
  // canonicalised where an alias exists (see mergeExtractedData).
  [key: string]: string | Record<string, string> | undefined;
}

const SYSTEM_PROMPT = `You are a skilled M&A analyst extracting structured information about a business that is being sold, from one source (a document, an email, a call transcript, a broker's CRM note, or public web content).

Extract ONLY information that is explicitly stated in the source. Do not infer, estimate, or fabricate.
If a field is not present, omit it entirely.

Record everything with the record_extraction tool. Use the exact field names provided. All values are strings except revenueByYear (an object of year → amount).
For numbers, include units (e.g. "$1,200,000", "3,200 sq ft", "12 employees").
For dates, use the format found in the source.
Never work anything out yourself: no dates computed from terms ("5 years from 2025"), no "years remaining", no totals, sums or differences. Record what the source says, in its words.
Never record a placeholder: if the source doesn't give a value (an address, a surname, an amount), leave the field out — never write "not stated", "not specified", "unknown" or "not provided".`;

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
- Ignore CRM housekeeping (pipeline stage, owner, follow-up reminders) unless it states a fact about the business; put next steps in actionItems.
- The broker's negotiation notes — the seller's floor / lowest acceptable price, walk-away point, what they would give in on, how motivated or desperate they are, the broker's pricing strategy — are NEVER business facts: put them ONLY in _privateNotes. askingPrice is only a price the seller or broker states as the asking/listing price.`,
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

FISCAL PERIODS (any source that states figures):
- periodEnd: the end date (YYYY-MM-DD) of the LATEST fiscal period the source reports figures for (e.g. "2024-12-31" for FY2024 statements).
- revenue, grossProfit, ebitda, sde, netIncome and the other plain figure fields hold ONLY the latest period's single figure — never a list of years, never a year in the field name (no netIncome2023, sde2024).
- Every figure for each fiscal year goes in byYear: {"revenue": {"2024": "$3,318,600", "2023": "$3,082,400"}, "netIncome": {"2024": "…"}} (revenue also in revenueByYear). Key by the fiscal year-END year ("FY2023/24" → "2024"); leave out partial or relative periods (YTD, TTM, "last year" with no year).
- revenueByYear holds revenue only — never SDE, EBITDA, profit or margin.

BROKER PROCESS: how the business reached the broker (who referred it, the lead source), the broker's fee, commission, listing or engagement terms, earlier approaches or offers — these are not facts about the business: put them ONLY in _privateNotes.

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

PRIVATE MATTERS: personal or sensitive things about the owner, their family or staff that must never appear in a sales document — health, family or marital matters, personal money trouble, legal trouble not about the business, the seller's bottom line or other negotiation positions, or anything the source marks private / confidential / "don't share" — go ONLY in _privateNotes (a list of short, factual notes). Never put them in a business field: e.g. reasonForSale stays neutral ("Owner retiring") and the health detail goes in _privateNotes.`;
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
      periodEnd: { type: "string", description: "End date (YYYY-MM-DD) of the latest fiscal period the source reports figures for." },
      byYear: {
        type: "object",
        description: "Per-metric figures by fiscal year-end year: {\"revenue\": {\"2024\": \"$…\"}, \"netIncome\": {…}}",
        additionalProperties: { type: "object", additionalProperties: { type: "string" } },
      },
      _privateNotes: { type: "array", items: { type: "string" } },
    },
  },
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** An adjusted / normalised earnings figure ("adj EBITDA $6.1M", "normalized SDE"). */
const ADJUSTED_WORDS = /\b(?:adj\.?|adjusted|normali[sz]ed|pro ?forma|recast)\b/i;
/** Plain earnings maps → their adjusted counterpart. */
const ADJUSTED_OF: Record<string, string> = { ebitdaByYear: "adjustedEbitdaByYear" };

/**
 * The merge contract for one extraction (idempotent — also applied to stored
 * extractions replayed by reprocess):
 * - only string values, plus by-year maps ({"2024": "$…"});
 * - per-metric year figures land in by-year maps with one key per fiscal
 *   year ("FY23"/"FY2023"/"fiscal 2023" → "2023"): byYear.{metric},
 *   revenueByYear, and suffixed keys (netIncome2023, sde2024, ebitdaFy2022);
 *   entries that aren't that metric's figure (SDE under revenue, "TTM",
 *   placeholders) become keyFinancialNotes, never figures;
 * - headline figures (revenue, sde, ebitda, …) hold only the latest
 *   period's single figure — a multi-year string is split into the map, a
 *   "(FY2024)" tag becomes the value's period; a missing headline is the
 *   map's latest year and the headline's year is added to the map;
 * - placeholders ("not stated", "unknown") are dropped; "Pam (surname not
 *   provided)" → "Pam"; worked-out or vague values are listed in
 *   _inferredKeys (lowest priority when merged);
 * - broker process data (referral source, fees, prior approaches) goes to
 *   _privateNotes, never a fact;
 * - periodEnd → _periodEnd (ISO).
 */
export function normaliseExtraction(raw: Record<string, unknown>): ExtractedDocumentData {
  const out: ExtractedDocumentData = {};
  const maps: Record<string, Record<string, string>> = {};
  const rejected: string[] = [];
  const privateNotes: string[] = [];
  const inferred = new Set<string>(
    typeof raw._inferredKeys === "string" ? raw._inferredKeys.split(",").map((k) => k.trim()).filter(Boolean) : [],
  );
  const keyPeriods: Record<string, string> = isPlainObject(raw._keyPeriods)
    ? Object.fromEntries(Object.entries(raw._keyPeriods).filter(([, v]) => typeof v === "string")) as Record<string, string>
    : {};
  const periodEnd = normalisePeriod(raw.periodEnd ?? raw._periodEnd);

  const addYears = (mapKey: string, metric: string, source: Record<string, unknown>) => {
    const { map, rejected: bad } = cleanYearMap(metric, source);
    for (const r of bad) rejected.push(`${metric}: ${r}`);
    for (const [y, v] of Object.entries(map)) {
      // "adj EBITDA $6.1M" under EBITDA is adjusted EBITDA (same for SDE).
      const target = (maps[ADJUSTED_OF[mapKey] && ADJUSTED_WORDS.test(v) ? ADJUSTED_OF[mapKey] : mapKey] ??= {});
      if (target[y] === undefined) target[y] = v;
    }
  };

  for (let [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined || v === "") continue;
    if (k === "periodEnd" || k === "_periodEnd" || k === "_keyPeriods" || k === "_inferredKeys") continue;
    if (k === "_privateNotes") {
      // Kept apart (one per line) — ingestion routes them to the broker-private notes.
      const notes = (Array.isArray(v) ? v : String(v).split("\n")).map((x) => String(x ?? "").trim()).filter(Boolean);
      privateNotes.push(...notes);
      continue;
    }
    if (k === "byYear" && isPlainObject(v)) {
      for (const [metric, m] of Object.entries(v)) if (isPlainObject(m)) addYears(yearMapKeyFor(metric), metric, m);
      continue;
    }
    if (isYearMapKey(k) && isPlainObject(v)) {
      addYears(k, k.replace(/ByYear$/, "") || k, v);
      continue;
    }
    // netIncome2023, sde_2024, ebitdaFy2022 → that metric's by-year map.
    const suffixed = !k.startsWith("_") ? yearSuffixedKey(k) : null;
    if (suffixed && (typeof v === "string" || typeof v === "number")) {
      addYears(yearMapKeyFor(suffixed.metric), suffixed.metric, { [suffixed.year]: String(v) });
      continue;
    }
    let text: string;
    if (typeof v === "string") text = v;
    else if (typeof v === "number" || typeof v === "boolean") text = String(v);
    else if (Array.isArray(v)) text = v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");
    else text = JSON.stringify(v);
    if (k.startsWith("_") || SOURCE_META_KEYS.has(k)) { out[k] = text; continue; }
    if (isBrokerProcessKey(canonicalFieldName(k))) {
      privateNotes.push(`${k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())}: ${text}`);
      continue;
    }
    const clean = cleanExtractedValue(text);
    if (clean.value === null) continue; // a placeholder says nothing
    if (clean.inferred) inferred.add(k);
    let value = clean.value;
    // Headline figures: one period's figure only.
    // An adjusted / normalised figure under the plain EBITDA key is adjusted EBITDA.
    if ((k === "ebitda" || k === "EBITDA") && ADJUSTED_WORDS.test(value) && raw.adjustedEbitda === undefined) {
      k = "adjustedEbitda";
    }
    const head = headlineKeyFor(k);
    if (head) {
      const multi = splitMultiYearValue(value);
      if (multi) {
        addYears(yearMapKeyFor(k), k, multi);
        continue; // the headline is re-derived from the map's latest year below
      }
      const tagged = stripYearTag(value);
      if (tagged.year) {
        value = tagged.value;
        keyPeriods[k] = periodForYear(tagged.year, periodEnd);
        addYears(yearMapKeyFor(k), k, { [tagged.year]: tagged.value });
      }
    }
    out[k] = value;
  }

  // Headline ↔ by-year map: a missing headline is the latest year's figure;
  // the headline's own year is on the map.
  for (const { head, map: mapKey } of HEADLINE_MAPS) {
    const headRawKey = Object.keys(out).find((k) => headlineKeyFor(k) === head);
    const map = maps[mapKey];
    if (headRawKey) {
      const year = periodYear(keyPeriods[headRawKey] ?? periodEnd);
      const value = out[headRawKey];
      // A worked-out headline never becomes a year's figure; the rest is checked like any year.
      if (year && typeof value === "string" && /\d/.test(value) && !inferred.has(headRawKey) && !maps[mapKey]?.[year]) {
        addYears(mapKey, headRawKey, { [year]: value });
      }
      continue;
    }
    if (!map) continue;
    const latest = Object.keys(map).sort(compareYearKeysDesc)[0];
    if (!latest) continue;
    const headKey = head === "annualRevenue" ? "revenue" : head;
    out[headKey] = map[latest];
    keyPeriods[headKey] = periodForYear(latest, periodEnd);
  }

  for (const [mapKey, map] of Object.entries(maps)) if (Object.keys(map).length > 0) out[mapKey] = map;
  if (rejected.length > 0) {
    const note = `Not recorded as yearly figures — ${rejected.join("; ")}`;
    out.keyFinancialNotes = typeof out.keyFinancialNotes === "string" && out.keyFinancialNotes
      ? `${out.keyFinancialNotes}\n${note}`
      : note;
  }
  if (privateNotes.length > 0) out._privateNotes = Array.from(new Set(privateNotes)).join("\n");
  if (periodEnd) out._periodEnd = periodEnd;
  if (Object.keys(keyPeriods).length > 0) out._keyPeriods = keyPeriods;
  const inferredList = Array.from(inferred).filter((k) => out[k] !== undefined);
  if (inferredList.length > 0) out._inferredKeys = inferredList.join(",");
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
  /** The source's own title / type ("Organizational chart and key people") — marks specialist sources. */
  title?: string;
  /** Fiscal period end the source reports (defaults to the extraction's _periodEnd). */
  period?: string;
  /** The source's own date (email sent, call held, statement signed). */
  dated?: string;
  /** The source row is broker-only. */
  brokerOnly?: boolean;
}

/**
 * mergeExtractedData
 *
 * Merges one source's extraction into existing extractedInfo with provenance.
 *
 * - The extraction is normalised first (normaliseExtraction — idempotent):
 *   one period per headline figure, by-year maps with clean year keys, no
 *   placeholders, no broker process data.
 * - Every incoming key is routed through canonicalFieldName so extractions
 *   land on the canonical field names the coverage classifier and the
 *   interview prompt read (revenue → annualRevenue, licenses →
 *   permitsLicenses, …). Keys without an alias are kept verbatim.
 * - Each written fact records {source: kind, documentId, at, period, dated,
 *   brokerOnly, specialist?, valueInferred?}.
 * - Who wins is decided per field by server/documents/merge-policy.ts
 *   (outranksFor): source rank adjusted by field class (a statement / lease
 *   / registry document outranks a call, an email or the questionnaire for
 *   the facts it is the authority on; a dedicated source — the org chart —
 *   for its own facts), then the newer period, then the newer source date —
 *   never processing order. Worked-out values only fill empty fields. The
 *   losing value is kept as an alternate, never discarded, and a material
 *   difference is reported in `ctx.conflicts` (the caller opens a
 *   discrepancy).
 * - By-year maps merge year by year, each year with its own full source.
 * - Headline figures are reconciled with their by-year maps
 *   (reconcileHeadlines) after every merge.
 * - Keys the broker deleted (_brokerSuppressed) are never written back.
 */
export function mergeExtractedData(
  existing: Record<string, unknown>,
  incoming: ExtractedDocumentData,
  /** The source row asserting these values (a bare string is its documentId,
   *  for older callers) — recorded per field so higher authorities outrank it
   *  and deleting the source removes its facts. */
  origin?: string | MergeSource,
  ctx: MergeContext = {},
): Record<string, unknown> {
  const merged = { ...existing };
  const o: MergeSource = typeof origin === "string" ? { documentId: origin } : origin ?? {};
  const kind: SourceKind = o.source ?? "document";
  const documentId = o.documentId;
  const data = normaliseExtraction(incoming as Record<string, unknown>);
  const period = normalisePeriod(o.period) ?? data._periodEnd;
  const dated = normalisePeriod(o.dated);
  const base: FieldSource = {
    source: kind,
    ...(documentId ? { documentId } : {}),
    at: o.at ?? new Date().toISOString(),
    ...(o.note ? { note: o.note } : {}),
    ...(period ? { period } : {}),
    ...(dated ? { dated } : {}),
    ...(documentId && o.brokerOnly !== undefined ? { brokerOnly: o.brokerOnly } : {}),
  };
  const keyPeriods = (data._keyPeriods as Record<string, string> | undefined) ?? {};
  const inferredKeys = new Set(String(data._inferredKeys ?? "").split(",").map((k) => k.trim()).filter(Boolean));
  const title = [o.title, typeof data._documentType === "string" ? data._documentType : ""].filter(Boolean).join(" · ");

  const srcFor = (rawKey: string, key: string): FieldSource => ({
    ...base,
    ...(keyPeriods[rawKey] ? { period: keyPeriods[rawKey] } : {}),
    ...(isSpecialistSource(key, title) ? { specialist: true } : {}),
    ...(inferredKeys.has(rawKey) ? { valueInferred: true } : {}),
  });

  const mergeValue = (rawKey: string, key: string, value: unknown) => {
    if (isSuppressed(merged, key)) return; // the broker deleted it — stays deleted
    if (isBrokerProcessKey(key)) return; // never a business fact
    const src = srcFor(rawKey, key);
    if (isYearMapKey(key)) {
      let map: Record<string, string> | null = null;
      if (value && typeof value === "object" && !Array.isArray(value)) map = value as Record<string, string>;
      else if (typeof value === "string") map = splitMultiYearValue(value);
      if (map) {
        const { map: clean } = cleanYearMap(key.replace(/ByYear$/, "") || key, map);
        if (Object.keys(clean).length > 0) mergeYearMapInto(merged, key, clean, src, ctx);
        return;
      }
    }
    mergeScalarInto(merged, key, value, src, ctx);
  };

  for (const [key, value] of Object.entries(data)) {
    if (!value || key.startsWith("_")) continue;
    mergeValue(key, canonicalFieldName(key), value);
  }

  // Fold individual lease facts into the canonical leaseDetails narrative
  // field so the real-estate section shows as covered. The raw keys were
  // already merged verbatim above (no alias exists for them) so the
  // financial tab keeps its granular values.
  // Skip when the extraction already provided its own leaseDetails summary —
  // building the composite too would append a near-duplicate block.
  if (!data.leaseDetails) {
    const leaseParts = LEASE_COMPOSITE_PARTS
      .map(({ key, label }) => {
        const v = data[key];
        return v && typeof v === "string" ? `${label}: ${v}` : null;
      })
      .filter((p): p is string => p !== null);
    if (leaseParts.length > 0) {
      const anyInferred = LEASE_COMPOSITE_PARTS.some(({ key }) => inferredKeys.has(key));
      if (anyInferred) inferredKeys.add("leaseDetails");
      mergeValue("leaseDetails", "leaseDetails", leaseParts.join("; "));
    }
  }

  // Headline figures follow the most authoritative, latest by-year figure.
  reconcileHeadlines(merged, ctx);
  return merged;
}
