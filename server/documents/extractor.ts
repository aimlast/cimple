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
  getFieldSources,
  setFieldSource,
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
  leadingYearFigure,
  singleYearFigure,
  splitMultiYearValue,
  stripYearTag,
  yearMapKeyFor,
  yearSuffixedKey,
  HEADLINE_MAPS,
  type MergeContext,
} from "./merge-policy";
import { agentConfig } from "../interview/config/load-config";
import { coverageAdjustmentsForDeal } from "../interview/interview-plan";
import type { Deal } from "@shared/schema";
import { guardExtraction, statedMetricKeys, STATED_METRIC_NOTE, SPOKEN_KINDS } from "./extraction-guard";

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
- Also fill callDate, callParticipants, keyTopics, actionItems, sellerConcerns, followUpNeeded, callNotes.
- Record who said each business fact in _speakers, keyed by the field name you used: {"equipmentCondition": "Luis Ortega (operations manager)", "annualRevenue": "Gord Halvorsen (seller)"}. Mark the seller's own statements "(seller)". Facts stated by anyone else on the call (a manager, partner, accountant) are recorded with that person as the speaker — never attributed to the seller.`,
  video_call: `THIS SOURCE IS A VIDEO-CALL TRANSCRIPT (Zoom / Google Meet / Teams / Cimple call between the broker and the seller).
- Attribute every statement to its speaker. The SELLER's statements about the business are facts. The BROKER's lines are questions or prompts — never facts on their own.
- A broker statement becomes a fact only when the seller clearly agrees with it.
- When you cannot tell who said something, leave it out.
- Also fill callDate, callParticipants, keyTopics, actionItems, sellerConcerns, followUpNeeded, callNotes.
- Record who said each business fact in _speakers, keyed by the field name you used: {"equipmentCondition": "Luis Ortega (operations manager)", "annualRevenue": "Gord Halvorsen (seller)"}. Mark the seller's own statements "(seller)". Facts stated by anyone else on the call (a manager, partner, accountant) are recorded with that person as the speaker — never attributed to the seller.`,
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

/** A data point the deal's interview checklist records under a fixed key (see interview-plan.ts). */
export interface ExtractionChecklistItem {
  key: string;
  label: string;
}

/** At most this many checklist keys are listed in the prompt. */
const MAX_CHECKLIST_KEYS = 60;

function checklistBlock(checklist: ExtractionChecklistItem[] | undefined): string {
  const items = (checklist ?? []).filter((i) => i && /^[a-z][A-Za-z0-9]*$/.test(i.key)).slice(0, MAX_CHECKLIST_KEYS);
  if (items.length === 0) return "";
  return `

THIS DEAL'S CHECKLIST KEYS: when the source answers one of these data points, record it under exactly this key (not a new name of your own):
${items.map((i) => `- ${i.key}: ${i.label}`).join("\n")}`;
}

/**
 * The deal's checklist data points (industry plan + broker-added items), for
 * the extraction prompt — so a roof's condition lands on roofCondition, not
 * an ad-hoc key coverage never credits.
 */
export function extractionChecklist(deal: Pick<Deal, "industry" | "interviewPlan" | "interviewOutline">): ExtractionChecklistItem[] {
  const adj = coverageAdjustmentsForDeal(deal);
  const out: ExtractionChecklistItem[] = [];
  const seen = new Set<string>();
  for (const items of Object.values(adj.add ?? {})) {
    for (const i of items) {
      if (seen.has(i.key) || adj.remove?.has(i.key)) continue;
      seen.add(i.key);
      out.push({ key: i.key, label: i.label });
    }
  }
  return out;
}

function buildExtractionPrompt(
  text: string,
  category: string,
  subcategory: string | null | undefined,
  kind: SourceKind,
  checklist?: ExtractionChecklistItem[],
): string {
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

For FINANCIAL documents, extract the lines exactly as printed: revenue (operating revenue / sales only — investment income, interest income, gains and other non-operating income go under otherIncome, never into revenue), costOfSales, grossProfit, operatingExpenses, amortization, interestExpense, incomeTaxes, netIncome, ownerSalary (only when the owner's or management salary is its own printed line), dividendsPaid, yearsOfData, revenueByYear (e.g. {"2022": "$1.2M", "2023": "$1.4M"}), keyFinancialNotes — and ebitda, adjustedEbitda, sde and addbacks only as the NEVER CALCULATE rule below allows.
- ebitda is EBITDA as reported / before adjustments. A figure the source calls adjusted, normalised, recast or pro forma EBITDA goes ONLY in adjustedEbitda (and byYear.adjustedEbitda) — never in ebitda. When a source prints both, record both.
- netIncome is net income after tax. Income before tax, operating income or one location's / segment's profit is not netIncome — use its own key (incomeBeforeTax, operatingIncome) or keyFinancialNotes.

NEVER CALCULATE. EBITDA, SDE (seller's discretionary earnings), adjusted EBITDA, add-backs, working capital, margins and every other figure worked out from other lines are recorded ONLY when the source itself prints that figure under that name (a line reading "EBITDA  $412,300", "Seller's discretionary earnings", "Normalization adjustments") — then copy the printed figure. Never add, subtract or divide lines to produce a figure, never write "calculated as …", never state a total the source does not print, and never record a figure that is only "included in" a larger line. Normalizing the earnings is the financial analysis's job, not yours.

A count (fleetSize, employees, numberOfLocations, …) is a number of things, never a dollar amount: when the source gives only the dollar value of the vehicles or equipment, record that under its own key (e.g. vehiclesCost). Industry classification codes (NAICS, SIC) go under naicsCode — never as the industry or business type.

FISCAL PERIODS (any source that states figures):
- periodEnd: the end date (YYYY-MM-DD) of the LATEST fiscal period the source reports figures for (e.g. "2024-12-31" for FY2024 statements).
- revenue, grossProfit, ebitda, adjustedEbitda, sde, netIncome and the other plain figure fields hold ONLY the latest period's single figure — never a list of years, never a year in the field name (no netIncome2023, sde2024).
- Every figure for each fiscal year goes in byYear: {"revenue": {"2024": "$3,318,600", "2023": "$3,082,400"}, "netIncome": {"2024": "…"}, "grossProfit": {"2023": "…"}} (revenue also in revenueByYear). Key by the fiscal year-END year ("FY2023/24" → "2024"); leave out partial or relative periods (YTD, TTM, "last year" with no year). NEVER CALCULATE applies to every year too: an EBITDA, adjusted-EBITDA or SDE year goes in byYear only when the source prints that year's figure under that name.
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

PRIVATE MATTERS: personal or sensitive things about the owner, their family or staff that must never appear in a sales document — health, family or marital matters, personal money trouble outside the company, legal trouble not about the business, the seller's bottom line or other negotiation positions, or anything the source marks private / confidential / "don't share" — go ONLY in _privateNotes. Never put them in a business field: e.g. reasonForSale stays neutral ("Owner retiring") and the health detail goes in _privateNotes. One short, factual note per matter: put everything the source says about that matter in the one note (the heart episode, the stent and "keep it out of the brochure" are one note, not three), and name whose matter it is ("Owner's wife…").
Deal-process status and to-dos (an NDA or engagement letter signed, who attended or was copied, documents still to ask for, next steps), contact details (phone numbers, e-mail and office addresses) and the source's own confidentiality stamp are neither facts nor private notes: next steps go in actionItems, the rest stays in summary / keyFacts.
Material events about the company itself — a customer giving notice or leaving, a contract or shareholder agreement signed or amended, an asset excluded from the sale, insurance policies, litigation about the business — are business facts under their own keys, never private notes.
Company transactions that involve the owner or their family are BUSINESS facts, not private notes — a buyer's due diligence needs them and the financial analysis reads them: dividends declared or paid (dividendsDeclared, with class, amount and date), shareholder loans and amounts due to or from shareholders (shareholderLoans), personal guarantees of company debt (personalGuarantees), related-party leases, contracts and family members on the payroll (relatedPartyTransactions), and the audit / review / compilation status (auditStatus). Record them under those keys.
Ignore document housekeeping — "sample" or "fictional" labels, page footers, confidentiality stamps: it is neither a fact nor a note.${checklistBlock(checklist)}`;
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
      // Call / video-call transcripts: field → "Name (role)" of who said it.
      _speakers: { type: "object", additionalProperties: { type: "string" } },
    },
  },
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** An adjusted / normalised earnings figure ("adj EBITDA $6.1M", "normalized SDE"). */
const ADJUSTED_WORDS = /\b(?:adj\.?|adjusted|normali[sz]ed|pro ?forma|recast)\b/i;
/** Plain earnings maps → their adjusted counterpart. */
const ADJUSTED_OF: Record<string, string> = { ebitdaByYear: "adjustedEbitdaByYear" };

/** Pre-tax income ("income before taxes $350,000") — never net income. */
const PRE_TAX_WORDS = /\b(?:before (?:income )?tax(?:es)?|pre-?tax)\b/i;
const NET_INCOME_MAPS: ReadonlySet<string> = new Set(["netIncomeByYear", "netProfitByYear"]);

/** Clauses of a figure text: split at ";", new lines and sentence ends ("…900. Adjusted …"). */
function figureClauses(text: string): string[] {
  return text.split(/[;\n]+|\.\s+(?=[A-Z])/).map((c) => c.trim()).filter(Boolean);
}
const hasDollarFigure = (t: string) => /\$\s*\d/.test(t);

/**
 * EBITDA text that states BOTH the reported and the adjusted measure →
 * the clauses of each ({reported, adjusted}); null when it states only one.
 * "Tom: Adjusted EBITDA $6,105,400 in 2024, $5,311,310 in 2023; EBITDA as
 * reported $5,274,900 in 2024" → adjusted: the first clause, reported: the second.
 */
export function splitEarningsMeasures(text: string): { reported: string; adjusted: string } | null {
  const reported: string[] = [];
  const adjusted: string[] = [];
  for (const c of figureClauses(text)) {
    if (!hasDollarFigure(c)) continue;
    (ADJUSTED_WORDS.test(c) ? adjusted : reported).push(c);
  }
  return reported.length > 0 && adjusted.length > 0 ? { reported: reported.join("; "), adjusted: adjusted.join("; ") } : null;
}

/** One labelled figure per clause and year ("Adjusted EBITDA 2023: $5,311,310. …") → a by-year map, or null. */
function figuresByYear(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const c of figureClauses(text)) {
    const one = singleYearFigure(c);
    if (one && out[one.year] === undefined) out[one.year] = one.value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

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
 *
 * With `sourceText` (the text the model read — null when none is on file)
 * the extraction guard (extraction-guard.ts) runs FIRST, on the values as
 * the model wrote them (their "calculated as …" wording intact): derived
 * figures (SDE, EBITDA, add-backs, working capital, margins) survive only
 * when the source prints them — by-year maps entry by entry —, calculations
 * and count-as-dollars values are dropped, NAICS text moves to naicsCode.
 * Without it (mergeExtractedData re-normalising an extraction that was
 * guarded when it was read) only the structure above is applied.
 */
export function normaliseExtraction(raw: Record<string, unknown>, sourceText?: string | null, kind: SourceKind = "document"): ExtractedDocumentData {
  if (sourceText === undefined) return structureExtraction(raw);
  const guarded = guardExtraction(raw, sourceText, { spoken: SPOKEN_KINDS.has(kind), document: kind === "document" });
  if (guarded.dropped.length > 0) {
    // Keys and reasons only in production (values are the seller's business data).
    // A map entry is reported as "sdeByYear.2024" / "byYear.sde.2024".
    const valueAt = (path: string): unknown =>
      path.split(".").reduce<unknown>((v, p) => (v && typeof v === "object" ? (v as Record<string, unknown>)[p] : undefined), raw);
    const shown = (d: { key: string; reason: string }) =>
      process.env.NODE_ENV === "production" ? `${d.key} (${d.reason})` : `${d.key} (${d.reason}: ${String(valueAt(d.key) ?? "").slice(0, 120)})`;
    console.log(`[extractor] dropped ${guarded.dropped.length} value(s): ${guarded.dropped.map(shown).join("; ")}`);
  }
  return structureExtraction(guarded.data);
}

function structureExtraction(raw: Record<string, unknown>): ExtractedDocumentData {
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
      // "adj EBITDA $6.1M" under EBITDA is adjusted EBITDA; "income before
      // taxes" under net income is pre-tax income.
      const routed = ADJUSTED_OF[mapKey] && ADJUSTED_WORDS.test(v)
        ? ADJUSTED_OF[mapKey]
        : NET_INCOME_MAPS.has(mapKey) && PRE_TAX_WORDS.test(v) ? "incomeBeforeTaxByYear" : mapKey;
      const target = (maps[routed] ??= {});
      if (target[y] === undefined) target[y] = v;
    }
  };

  // A figure moved to its own measure's key keeps who said it (_speakers).
  const renamed: Record<string, string> = {};
  for (let [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined || v === "") continue;
    if (k === "periodEnd" || k === "_periodEnd" || k === "_keyPeriods" || k === "_inferredKeys") continue;
    if (k === "_speakers") {
      // Call / video-call transcripts: field → who said it (fact-guards.ts recordFactSpeakers).
      if (isPlainObject(v)) {
        const who: Record<string, string> = {};
        for (const [f, name] of Object.entries(v)) if (typeof name === "string" && name.trim()) who[f] = name.trim();
        if (Object.keys(who).length > 0) out._speakers = who;
      }
      continue;
    }
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
    if (k === "ebitda" || k === "EBITDA" || k === "adjustedEbitda") {
      // Text that states both measures ("Reported EBITDA 2024: $5,274,900.
      // Adjusted EBITDA 2024: $6,105,400. …"): each clause to its own measure.
      const measures = splitEarningsMeasures(value);
      if (measures) {
        for (const [measure, text] of [["ebitda", measures.reported], ["adjustedEbitda", measures.adjusted]] as const) {
          const years = splitMultiYearValue(text) ?? figuresByYear(text);
          if (years) addYears(yearMapKeyFor(measure), measure, years);
          else if (out[measure] === undefined && (measure === k || raw[measure] === undefined)) out[measure] = text;
        }
        continue;
      }
      // An adjusted / normalised figure under the plain EBITDA key is adjusted EBITDA.
      if (k !== "adjustedEbitda" && ADJUSTED_WORDS.test(value)) {
        if (raw.adjustedEbitda !== undefined) continue; // recorded under its own key already
        renamed[k] = "adjustedEbitda";
        k = "adjustedEbitda";
      }
    }
    // Income before tax under net income is pre-tax income, not net income.
    if ((k === "netIncome" || k === "netProfit") && PRE_TAX_WORDS.test(value)) {
      if (raw.incomeBeforeTax !== undefined) continue;
      renamed[k] = "incomeBeforeTax";
      k = "incomeBeforeTax";
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
      } else {
        // "$426,100 (FY2024) - ties to the statements: …": the words stay, the
        // year's figure goes on the map.
        const lead = leadingYearFigure(value);
        if (lead && !inferred.has(k)) {
          keyPeriods[k] = periodForYear(lead.year, periodEnd);
          addYears(yearMapKeyFor(k), k, { [lead.year]: lead.amount });
        }
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
  if (isPlainObject(out._speakers)) {
    const who = out._speakers as Record<string, string>;
    for (const [from, to] of Object.entries(renamed)) if (who[from] && !who[to]) who[to] = who[from];
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
  /** The deal's checklist keys, so answers land where the interview and coverage look (see extractionChecklist). */
  opts: { checklist?: ExtractionChecklistItem[] } = {},
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
        content: buildExtractionPrompt(text, category, subcategory, kind, opts.checklist),
      }],
    });

    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use" || !block.input || typeof block.input !== "object") {
      throw new Error(`no extraction returned (stop_reason ${response.stop_reason})`);
    }
    if (response.stop_reason === "max_tokens") {
      console.warn(`[extractor] extraction hit the output limit — keeping what was recorded`);
    }
    return normaliseExtraction(block.input as Record<string, unknown>, text, kind);
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

/** The latest fiscal period a normalised extraction's figures are for (its by-year maps and tagged headlines), if any. */
function latestFigurePeriod(data: ExtractedDocumentData): string | undefined {
  const periods: string[] = Object.values((data._keyPeriods as Record<string, string> | undefined) ?? {});
  for (const [k, v] of Object.entries(data)) {
    if (!isYearMapKey(k) || !v || typeof v !== "object") continue;
    for (const y of Object.keys(v as object)) if (/^(?:19|20)\d{2}$/.test(y)) periods.push(`${y}-12-31`);
  }
  return periods.sort().pop();
}

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
  // A document that states no period end (older extractions) is for the
  // latest fiscal year its figures cover — FY2023 statements with FY2022
  // comparatives are a 2023 source, not an undated one.
  const period = normalisePeriod(o.period) ?? data._periodEnd ?? (kind === "document" ? latestFigurePeriod(data) : undefined);
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

  // A derived figure (SDE, EBITDA…) survives extraction only when the source
  // printed it (extraction-guard.ts): the fact it became says so.
  // The guard names the keys as the model wrote them (sde2024, byYear.ebitda);
  // the structure above moved year figures onto by-year maps, and a map's
  // latest year can be its headline.
  const statedFacts = new Set<string>();
  for (const stated of statedMetricKeys(data)) {
    const suffixed = stated.startsWith("byYear.") ? { metric: stated.slice("byYear.".length) } : yearSuffixedKey(stated);
    const key = suffixed ? yearMapKeyFor(suffixed.metric) : canonicalFieldName(stated);
    statedFacts.add(key);
    const head = HEADLINE_MAPS.find((h) => h.map === key)?.head;
    if (head) statedFacts.add(canonicalFieldName(head));
  }
  for (const key of Array.from(statedFacts)) {
    const s = getFieldSources(merged)[key];
    // Only a fact this source wrote (another source's value keeps its own story).
    if (s && !s.note && s.source === base.source && s.documentId === base.documentId && (documentId || s.at === base.at)) {
      setFieldSource(merged, key, { ...s, note: STATED_METRIC_NOTE });
    }
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
