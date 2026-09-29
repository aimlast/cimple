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
  recordAlternate,
  typedNumericValues,
  SOURCE_META_KEYS,
  type FieldSource,
  type SourceKind,
} from "../interview/info-merger";
import {
  cleanExtractedValue,
  cleanYearMap,
  headlineKeyFor,
  interimKeyFor,
  mergeMapEntryInto,
  isBrokerProcessKey,
  isSpecialistSource,
  premisesKey,
  isYearMapKey,
  mergeScalarInto,
  mergeYearMapInto,
  normalisePeriod,
  periodForYear,
  periodYear,
  receivablesMeasureKey,
  reconcileHeadlines,
  leadingYearFigure,
  singleYearFigure,
  splitMultiYearValue,
  stripYearTag,
  yearMapKeyFor,
  yearSuffixedKey,
  HEADLINE_MAPS,
  type MergeContext,
  type SetAsideYear,
} from "./merge-policy";
import { agentConfig } from "../interview/config/load-config";
import { coverageAdjustmentsForDeal } from "../interview/interview-plan";
import type { Deal } from "@shared/schema";
import { guardExtraction, statedMetricKeys, STATED_METRIC_NOTE, STATED_METRICS_KEY, SPOKEN_KINDS } from "./extraction-guard";
import { equipmentLeaseKey, isEquipmentLeaseTitle, PREMISES_LEASE_KEY } from "./lease-kind";

/** The slice of the SDK the extractor uses (a stand-in in tests). */
export interface ExtractionClient {
  messages: {
    stream(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { timeout?: number },
    ): { finalMessage(): Promise<{ content: Array<{ type: string; input?: unknown }>; stop_reason: string | null }> };
  };
}
let client: ExtractionClient | null = null;
const extractionClient = (): ExtractionClient =>
  (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 600_000 }) as unknown as ExtractionClient);
/** For tests: a stand-in client (null → the real one). */
export function _setExtractionClientForTests(c: ExtractionClient | null): void {
  client = c;
}

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
  /** Figures of a by-year metric that aren't a fiscal year's reported one (interim / forecast / unreviewed), by map key. */
  _yearsSetAside?: Record<string, SetAsideYear[]>;

  // Open-ended extraction is still allowed — ad-hoc keys are merged too and
  // canonicalised where an alias exists (see mergeExtractedData).
  [key: string]: string | Record<string, string> | Record<string, SetAsideYear[]> | undefined;
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
  /** One part of a long source (splitSourceText): which, of how many. */
  part?: { index: number; total: number },
): string {
  const docType = subcategory ? `${category} / ${subcategory}` : category;
  const guidance = SOURCE_GUIDANCE[kind];
  const label = kind === "document" ? `${docType} document` : `${kind.replace("_", " ")} (${docType})`;
  const partNote = part && part.total > 1
    ? `\nTHIS IS PART ${part.index + 1} OF ${part.total} of one long source, read in parts (the parts overlap slightly). Extract what THIS part states; the other parts are read separately and the results combined. Put the fiscal year each figure is for in byYear — a later part may be a later year's return or statements. Write the summary about what the source says about the business (its totals and headline figures) — never "Part N of M", and never which rows, record IDs or date range this part happens to hold; if this part is only rows of a table, keep the summary to one short line and leave the business fields to what the rows actually establish.\n`
    : "";

  return `Extract structured data from this ${label}.
${guidance ? `\n${guidance}\n` : ""}${partNote}
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

For LEASE / LEGAL documents, extract: leaseExpiry, monthlyRent, leaseSqft, leaseRenewalOptions, leaseAddress, contracts, legalNotes, permitsLicenses (all licenses and permits). The lease fields (leaseExpiry, monthlyRent, leaseSqft, leaseRenewalOptions, leaseAddress, leaseDetails, landlord) are ONLY for the lease of the business's premises (the building, unit, yard or land it occupies). A lease of equipment or vehicles (a forklift, truck, tractor, trailer, van, copier, machine) goes under equipmentLeases (or vehicleLeases for vehicles) as one line with what is leased, the payment and the term — never under the premises-lease fields — and set _documentType to say so (e.g. "Equipment lease - forklift").

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

/**
 * One read covers at most this much text. A longer source (three years of
 * tax returns, a statement pack, a year-long email thread, a 90-minute call)
 * is read in parts of this size (splitSourceText) and the parts' results are
 * combined as one source (combineExtractions) — it used to be cut here, so
 * the 2023 and 2024 returns of a 464K-character "Corporate Tax Returns 2022
 * to 2024" were never read.
 */
export const MAX_SOURCE_CHARS = 60_000;
/** Consecutive parts overlap by this much, so a table or a sentence cut at a boundary is read whole in one of them. */
const PART_OVERLAP_CHARS = 1_500;
/** At most this many parts are read (600K characters); anything beyond is recorded as not read. */
export const MAX_SOURCE_PARTS = 10;
/** Parts read at the same time. */
const PART_CONCURRENCY = 3;
/** Below this much text there is nothing to read (a scanned image, an empty file). */
export const MIN_READABLE_CHARS = 50;
/** A page of a scanned PDF's text layer holds at most this much text of its own (a stray scanner mark, a stamp). */
export const MAX_SCANNED_PAGE_CHARS = 10;
/** A scanned PDF: at least this share of its pages hold (almost) no text. */
const SCANNED_PAGE_SHARE = 0.75;
/** Without each page's text: a PDF averaging under this much text of its own a page (a typed cover over image pages). */
export const MIN_USEFUL_CHARS_PER_PAGE = 25;
/** Without a page count: a scanner watermark's pages averaging under this much text of their own. */
const MIN_CHARS_PER_WATERMARKED_PAGE = 150;

/** A scanning app's own stamp ("Scanned with CamScanner", "Scanned by TurboScan"). */
const SCANNER_STAMP = /\b(?:scanned (?:with|by|using|via)|camscanner|adobe scan|genius ?scan|microsoft lens|office lens|tiny ?scanner|turbo ?scan|scanbot|clear ?scan|swift ?scan|iscanner|scanner pro|simple ?scan)\b/i;

/** How a source's text was laid out: a PDF's pages (and each page's text), or a file that has no pages. */
export interface TextLayout {
  /** The PDF's page count. */
  pages?: number;
  /** Each page's text, when the PDF was just read. */
  pageTexts?: string[];
  /** True for a PDF (its text may be a scan's text layer); false for Word, Excel, PowerPoint, text and pasted sources. */
  pdf?: boolean;
}

const asLayout = (layout?: number | TextLayout): TextLayout =>
  typeof layout === "number" ? { pages: layout, pdf: true } : layout ?? {};

const normLine = (l: string) => l.toLowerCase().replace(/\s+/g, " ");
const PAGE_NUMBER_LINE = /^(?:page\s*)?#?\s*\d+(?:\s*(?:of|\/)\s*\d+)?$|^[-–—]\s*\d+\s*[-–—]$/i;
const ownChars = (line: string) => line.replace(/[^A-Za-z0-9]/g, "").length;

/**
 * The text a source holds of its own: letters and digits outside a
 * scanner's stamp, a running header / footer and page numbers — and how many
 * pages a scanner's repeated stamp suggests when the page count isn't known.
 * Only a scanner's stamp counts pages: a questionnaire's "Yes" / "No"
 * answers, a slide footer ("Confidential") or a status column ("Owned")
 * repeat too, and they are text of the document's own.
 */
export function usefulText(text: string, runningLines?: Set<string>): { chars: number; repeatedPages: number } {
  const lines = (text || "").split(/\r?\n|\f/).map((l) => l.trim()).filter(Boolean);
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(normLine(l), (counts.get(normLine(l)) ?? 0) + 1);
  let chars = 0;
  let repeatedPages = 0;
  for (const l of lines) {
    const n = counts.get(normLine(l)) ?? 0;
    if (SCANNER_STAMP.test(l) && l.length <= 80) { repeatedPages = Math.max(repeatedPages, n); continue; }
    if (runningLines?.has(normLine(l))) continue;
    if (PAGE_NUMBER_LINE.test(l)) continue;
    chars += ownChars(l);
  }
  return { chars, repeatedPages };
}

/** Lines on at least half of a PDF's pages (a running header or footer), by their text. */
function runningLinesOf(pageTexts: string[]): Set<string> {
  const onPages = new Map<string, number>();
  for (const page of pageTexts) {
    const seen = new Set(page.split(/\r?\n|\f/).map((l) => l.trim()).filter((l) => l && l.length <= 80).map(normLine));
    seen.forEach((l) => onPages.set(l, (onPages.get(l) ?? 0) + 1));
  }
  const out = new Set<string>();
  onPages.forEach((n, l) => { if (n >= Math.max(3, pageTexts.length / 2)) out.add(l); });
  return out;
}

/**
 * True when a document's text layer is too thin to have been read — a
 * scanned PDF whose only text is a scanner's stamp or a typed cover page
 * over image pages. Judged on three or more pages:
 * - with each page's text (a PDF just read): most pages (three in four)
 *   hold almost no text of their own once running headers, footers and
 *   stamps are set aside — a sparse slide deck ("Founded 2009", "Thank
 *   you") has a little on nearly every page, a scan has nothing;
 * - with only the PDF's page count: under MIN_USEFUL_CHARS_PER_PAGE a page;
 * - with no page count (a PDF's stored text): only a scanner's stamp,
 *   repeated page after page, counts the pages.
 * Word, Excel, PowerPoint, text and pasted sources are never judged thin:
 * they have no scanned pages, and their repeated lines are their own text.
 * A one- or two-page document is judged by MIN_READABLE_CHARS alone.
 */
export function thinTextLayer(text: string, layout?: number | TextLayout): boolean {
  const { pages, pageTexts, pdf } = asLayout(layout);
  if (pdf === false) return false;
  if (pageTexts && pageTexts.length >= 3) {
    const running = runningLinesOf(pageTexts);
    const empty = pageTexts.filter((page) => usefulText(page, running).chars <= MAX_SCANNED_PAGE_CHARS).length;
    return empty >= pageTexts.length * SCANNED_PAGE_SHARE;
  }
  if (pages && pages > 0) {
    if (pages < 3) return false;
    return usefulText(text).chars / pages < MIN_USEFUL_CHARS_PER_PAGE;
  }
  const { chars, repeatedPages } = usefulText(text);
  if (repeatedPages < 3) return false;
  return chars / repeatedPages < MIN_CHARS_PER_WATERMARKED_PAGE;
}

/** The reason given for a scanned document with a thin text layer. */
export const SCANNED_REASON = "most of its pages have no readable text — it looks like a scanned document; upload a text PDF, a Word file or a typed copy";

/**
 * A read that found nothing, of a text with little of its own: under 300
 * characters a page (or 300 in all). With hasNoBusinessFacts, the source is
 * not counted as the checklist document it was uploaded for. Only a PDF can
 * be a scan: a short Word, Excel, PowerPoint or text file is what it says.
 */
export function readFoundNothing(data: ExtractedDocumentData, text: string, layout?: number | TextLayout): boolean {
  if (!hasNoBusinessFacts(data)) return false;
  const { pages, pdf } = asLayout(layout);
  if (pdf === false) return false;
  const { chars, repeatedPages } = usefulText(text);
  const pageCount = Math.max(1, pages && pages > 0 ? pages : repeatedPages);
  return chars < 300 || chars / pageCount < 300;
}

/** True when an extraction holds no fact about the business (only its summary and bookkeeping). */
export function hasNoBusinessFacts(data: ExtractedDocumentData): boolean {
  return Object.entries(data).every(([k, v]) => k.startsWith("_") || k === "summary" || k === "keyFacts" || v === undefined || v === null || v === "");
}

/** Where a page, sheet or form feed starts — the preferred place to cut a long source. */
const PAGE_BREAK_RE = /\f|\n(?=[^\n]{0,80}\bPage \d+ of \d+\b)|\n(?=--- Sheet: )|\n\n(?=\S)/g;

/**
 * A long text as the parts one read each covers: at most `size` characters
 * each, cut at a page / sheet boundary (else a blank line, else a line
 * break) in the last 40% of the window, each part starting `overlap`
 * characters before the previous one ended. A text that fits is one part.
 */
export function splitSourceText(text: string, size = MAX_SOURCE_CHARS, overlap = PART_OVERLAP_CHARS): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const window = text.slice(start + Math.floor(size * 0.6), end);
      let cut = -1;
      for (const m of Array.from(window.matchAll(PAGE_BREAK_RE))) cut = m.index ?? cut;
      if (cut < 0) cut = window.lastIndexOf("\n");
      if (cut >= 0) end = start + Math.floor(size * 0.6) + cut + 1;
    }
    parts.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return parts;
}

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

/** A statement's own expense listing ("operatingExpenseBreakdown", "operatingExpensesDetail"): its lines as printed. */
const EXPENSE_LISTING_KEY = /^(?:operating)?expens\w*?(?:Breakdown|Detail|Details|Lines|Items|Schedule)$/i;
/**
 * The owner's pay as a printed line of that listing: "Management salary —
 * shareholder: $180,000", "Management salary $180,000", "Officers'
 * compensation $1,120,000 (2024)".
 */
const OWNER_PAY_LINE_RE =
  /\b(?:management salar(?:y|ies)|shareholders?'? salar(?:y|ies)|owners?'?s? (?:salary|salaries|compensation|remuneration)|officers?'? (?:salary|salaries|compensation))\b(?:\s*[—–-]\s*(?:the\s+)?(?:majority\s+)?(?:shareholders?|owners?)\b)?(?:\s*\([^)$]{0,40}\))?\s*:?\s*(\$\s?\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*\((?:fy\s?)?((?:19|20)\d{2})\))?/gi;

/**
 * The owner's salary a statement prints as a line of its expense listing,
 * when the extraction filed that listing but no ownerSalary (Ridgeline's
 * FY2024 statements: "Management salary $180,000" sat only in
 * operatingExpenseBreakdown, so ownerSalaryByYear never got 2024). Each
 * line's year is its own "(2024)" tag, the listing's "2023:" lead, or the
 * statements' period end; a year printed with two different amounts is
 * left alone. Copies printed figures — never calculates. Pure.
 */
export function liftPrintedOwnerPay(raw: Record<string, unknown>): Record<string, unknown> {
  const byYear = isPlainObject(raw.byYear) ? raw.byYear as Record<string, unknown> : {};
  if ([raw.ownerSalary, raw.ownerSalaryByYear, byYear.ownerSalary].some((v) => v !== undefined && v !== null && v !== "")) return raw;
  const periodYearOf = periodYear(normalisePeriod(raw.periodEnd ?? raw._periodEnd));
  const found = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(raw)) {
    if (!EXPENSE_LISTING_KEY.test(k) || typeof v !== "string") continue;
    for (const part of v.split(/\n|(?=\b(?:FY\s?)?(?:19|20)\d{2}\s*:)/i)) {
      const lead = part.match(/^\s*(?:FY\s?)?((?:19|20)\d{2})\s*:/i)?.[1];
      for (const m of Array.from(part.matchAll(OWNER_PAY_LINE_RE))) {
        const year = m[2] ?? lead ?? periodYearOf ?? "";
        const amount = m[1].replace(/\s+/g, "");
        found.set(year, (found.get(year) ?? new Set()).add(amount));
      }
    }
  }
  const years: Record<string, string> = {};
  let scalar: string | undefined;
  found.forEach((amounts, year) => {
    if (amounts.size !== 1) return; // two figures for one year: not ours to pick
    const amount = Array.from(amounts)[0];
    if (year) years[year] = amount;
    else scalar = amount;
  });
  if (Object.keys(years).length > 0) return { ...raw, ownerSalaryByYear: years };
  if (scalar) return { ...raw, ownerSalary: scalar };
  return raw;
}

function structureExtraction(input: Record<string, unknown>): ExtractedDocumentData {
  const raw = liftPrintedOwnerPay(input);
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

  // A metric's own figures that aren't a fiscal year's reported one (a
  // quarter, a run-rate, a forecast, an unreviewed management number): set
  // aside for the merge to keep as what they are — never a CIM note.
  const setAside: Record<string, SetAsideYear[]> = {};
  const keepAside = (mapKey: string, entries: SetAsideYear[]) => {
    const list = (setAside[mapKey] ??= []);
    for (const e of entries) if (!list.some((x) => x.period === e.period && x.value === e.value)) list.push(e);
  };
  if (isPlainObject(raw._yearsSetAside)) {
    for (const [mapKey, list] of Object.entries(raw._yearsSetAside)) {
      if (Array.isArray(list)) keepAside(mapKey, list.filter((e): e is SetAsideYear => !!e && typeof e.period === "string" && typeof e.value === "string"));
    }
  }
  const addYears = (mapKey: string, metric: string, source: Record<string, unknown>) => {
    const { map, rejected: bad, setAside: aside } = cleanYearMap(metric, source);
    for (const r of bad) rejected.push(`${metric}: ${r}`);
    if (aside.length > 0) keepAside(mapKey, aside);
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
    if (k === "periodEnd" || k === "_periodEnd" || k === "_keyPeriods" || k === "_inferredKeys" || k === "_yearsSetAside") continue;
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
      const value = out[headRawKey];
      // A headline with no year of its own that the map already holds under a
      // year ("$1.35 million" = its 2024) is that year's figure — not also the
      // year of the source's date (a call on Mar 31, 2025 is not FY2025).
      if (!keyPeriods[headRawKey] && map && typeof value === "string") {
        const n = typedNumericValues(value).find((t) => t.kind === "currency")?.value;
        const same = n === undefined ? undefined : Object.keys(map).sort(compareYearKeysDesc)
          .find((y) => typedNumericValues(map[y]).some((t) => t.kind === "currency" && Math.abs(t.value - n) < 0.5));
        if (same) {
          keyPeriods[headRawKey] = periodForYear(same, periodEnd);
          continue;
        }
      }
      const year = periodYear(keyPeriods[headRawKey] ?? periodEnd);
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
  if (Object.keys(setAside).length > 0) out._yearsSetAside = setAside;
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
  /** pages / pageTexts / pdf: how the text was laid out (thinTextLayer). */
  opts: { checklist?: ExtractionChecklistItem[] } & TextLayout = {},
): Promise<ExtractedDocumentData> {
  if (!text || text.trim().length < MIN_READABLE_CHARS) return unreadableExtraction(text, kind);
  // A scanned PDF whose text layer is a watermark or a cover page: not read
  // (nothing in it is), and said so — it is not the document it was sent as.
  if (kind === "document" && thinTextLayer(text, { pages: opts.pages, pageTexts: opts.pageTexts, pdf: opts.pdf })) return unreadableExtraction(text, kind, SCANNED_REASON);

  const parts = splitSourceText(text);
  if (parts.length === 1) {
    const one = await readPart(text, category, subcategory, kind, opts.checklist);
    return one.ok ? one.data : one.failure;
  }

  // A long source: every part is read (a few at a time) and the parts'
  // results are combined as ONE source's extraction.
  const toRead = parts.slice(0, MAX_SOURCE_PARTS);
  const results: Array<Awaited<ReturnType<typeof readPart>>> = new Array(toRead.length);
  let next = 0;
  const worker = async () => {
    while (next < toRead.length) {
      const i = next++;
      // A part that fails on a dropped connection or an overload is read again
      // (with the usual waits) — the other parts' reads are not repeated.
      let r = await readPart(toRead[i], category, subcategory, kind, opts.checklist, { index: i, total: toRead.length });
      for (const wait of extractionRetryDelays()) {
        if (r.ok || r.failure._failure !== "transient") break;
        await new Promise((res) => setTimeout(res, wait));
        r = await readPart(toRead[i], category, subcategory, kind, opts.checklist, { index: i, total: toRead.length });
      }
      results[i] = r;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, toRead.length) }, worker));
  const read = results.map((r, i) => ({ r, i })).filter((x) => x.r.ok);
  if (read.length === 0) {
    // Every part was already tried again: the caller doesn't repeat the whole source.
    return { ...(results.find((r) => !r.ok) as { failure: ExtractedDocumentData }).failure, _partsRetried: "1" };
  }
  // Each part keeps its real number (a failed part doesn't renumber the
  // others) and the count the reader was told ("Part 3 of 5").
  const combined = combineExtractions(
    read.map((x) => (x.r as { data: ExtractedDocumentData }).data),
    { parts: read.map((x) => x.i + 1), total: toRead.length },
  );
  const failed = results.map((r, i) => ({ r, i })).filter((x) => !x.r.ok);
  const readChars = read.reduce((n, x) => n + toRead[x.i].length, 0) - PART_OVERLAP_CHARS * Math.max(0, read.length - 1);
  if (failed.length > 0 || parts.length > toRead.length) {
    const why = [
      failed.length > 0 ? `${failed.length} of its ${toRead.length} parts couldn't be read (${(failed[0].r as { failure: ExtractedDocumentData }).failure._failureReason ?? "the read failed"})` : "",
      parts.length > toRead.length ? `only the first ${toRead.length} of ${parts.length} parts are read` : "",
    ].filter(Boolean).join("; ");
    (combined as Record<string, unknown>)._partialRead = {
      parts: parts.length,
      readParts: read.length,
      readChars: Math.max(0, Math.min(text.length, readChars)),
      totalChars: text.length,
      reason: why,
      ...(failed.some((x) => (x.r as { failure: ExtractedDocumentData }).failure._failure === "transient") ? { retryable: true } : {}),
    };
    console.warn(`[extractor] long source read in part: ${why}`);
  }
  return combined;
}

/** Waits before each retry of a transient extraction failure (ms): the first try plus three more. */
const DEFAULT_RETRY_DELAYS_MS = [5_000, 20_000, 60_000];
let retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS;
/** The waits between retries of a transient failure (ingestion, reprocess, parts of a long source). */
export function extractionRetryDelays(): number[] {
  return retryDelaysMs;
}
/** For tests: shorter waits (null → the real ones). */
export function _setExtractionRetryDelaysForTests(delays: number[] | null): void {
  retryDelaysMs = delays ?? DEFAULT_RETRY_DELAYS_MS;
}

/**
 * Runs an extraction and, while it comes back as a TRANSIENT failure stub (a
 * dropped connection, a rate limit, an overloaded API — see
 * classifyExtractionFailure), runs it again after each of `delays`. A
 * permanent failure (a refused key, no credits, nothing to read) is not
 * retried, nor a long source whose parts were each retried already.
 * Returns the last result and how many attempts were made.
 */
export async function extractWithRetries(
  run: () => Promise<ExtractedDocumentData>,
  delays: number[],
  onRetry?: (attempt: number, waitMs: number, reason: string) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ data: ExtractedDocumentData; attempts: number }> {
  let data = await run();
  let attempts = 1;
  for (const wait of delays) {
    if (data.summary !== "Extraction failed" || data._failure !== "transient" || data._partsRetried) break;
    onRetry?.(attempts, wait, String(data._failureReason ?? "transient failure"));
    await sleep(wait);
    data = await run();
    attempts++;
  }
  return { data, attempts };
}

/** What a part-read of a long source leaves unread (extraction key `_partialRead`). */
export interface PartialRead {
  parts: number;
  readParts: number;
  readChars: number;
  totalChars: number;
  /** Why, in plain words. */
  reason: string;
  /** A part failed on a transient error — reading it again may complete it. */
  retryable?: boolean;
}

/**
 * The extraction of a source with no text to read: a failure the broker
 * sees, with why (`reason` when the file itself couldn't be opened — a .doc,
 * a damaged PDF). Never retried: reading it again finds the same nothing.
 */
export function unreadableExtraction(text: string | null | undefined, kind: SourceKind, reason?: string): ExtractedDocumentData {
  reason ??= kind === "document"
    ? "no text could be read from it — it looks like a scanned image or photo; upload a text PDF, a Word file or a typed copy"
    : "there is too little text in it to read";
  return {
    _documentType: "unreadable",
    _confidence: "low",
    summary: "Extraction failed",
    _failure: "unreadable",
    _failureReason: reason,
    ...(text && text.trim() ? { _textChars: String(text.trim().length) } : {}),
  };
}

/**
 * One model read of one text (a whole source or one part of it), streamed —
 * a long read that sends nothing for minutes gets its connection cut
 * (ETIMEDOUT: one long call transcript's re-read failed three times at 6–9
 * minutes each), a stream keeps it alive.
 */
/**
 * Reads in flight across the whole server. A reprocess reads four sources
 * at once and a long source reads three parts at once, so 4 × 3 = 12
 * streams could start together — rate limits (429s) and retries follow.
 * Every read (a whole source or one part) takes a slot here first.
 */
export const MAX_READS_IN_FLIGHT = 4;
let readsInFlight = 0;
const waitingReads: Array<() => void> = [];

/** Runs `fn` once a read slot is free (first come, first served). */
export async function withReadSlot<T>(fn: () => Promise<T>, limit: number = MAX_READS_IN_FLIGHT): Promise<T> {
  if (readsInFlight >= limit) await new Promise<void>((resolve) => waitingReads.push(resolve));
  readsInFlight++;
  try {
    return await fn();
  } finally {
    readsInFlight--;
    waitingReads.shift()?.();
  }
}

/** For tests: how many reads are running now. */
export function _readsInFlightForTests(): number {
  return readsInFlight;
}

/** The instructions every read shares, marked for the prompt cache (a long source's later parts and a reprocess's other sources reuse it). */
const CACHED_SYSTEM = [{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }];

function readPart(
  text: string,
  category: string,
  subcategory: string | null | undefined,
  kind: SourceKind,
  checklist?: ExtractionChecklistItem[],
  part?: { index: number; total: number },
): Promise<{ ok: true; data: ExtractedDocumentData } | { ok: false; failure: ExtractedDocumentData }> {
  return withReadSlot(() => readPartNow(text, category, subcategory, kind, checklist, part));
}

async function readPartNow(
  text: string,
  category: string,
  subcategory: string | null | undefined,
  kind: SourceKind,
  checklist?: ExtractionChecklistItem[],
  part?: { index: number; total: number },
): Promise<{ ok: true; data: ExtractedDocumentData } | { ok: false; failure: ExtractedDocumentData }> {
  try {
    // Tool-forced JSON with a generous output budget: long transcripts used
    // to overflow 2,000 tokens mid-object and the whole extraction failed.
    const stream = extractionClient().messages.stream(
      {
        model: agentConfig.models.supportingAgents,
        max_tokens: 8000,
        system: CACHED_SYSTEM,
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: "tool", name: EXTRACTION_TOOL.name },
        messages: [{
          role: "user",
          content: buildExtractionPrompt(text, category, subcategory, kind, checklist, part),
        }],
      },
      { timeout: 600_000 },
    );
    const response = await stream.finalMessage();
    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || !block.input || typeof block.input !== "object") {
      throw new Error(`no extraction returned (stop_reason ${response.stop_reason})`);
    }
    if (response.stop_reason === "max_tokens") {
      console.warn(`[extractor] extraction hit the output limit — keeping what was recorded`);
    }
    return { ok: true, data: normaliseExtraction(block.input as Record<string, unknown>, text, kind) };
  } catch (err) {
    console.error(`[extractor] Claude extraction failed${part ? ` (part ${part.index + 1} of ${part.total})` : ""}:`, err);
    const failure = classifyExtractionFailure(err);
    return { ok: false, failure: { _documentType: category, _confidence: "low", summary: "Extraction failed", _failure: failure.kind, _failureReason: failure.reason } };
  }
}

// ── Parts of a long source: part labels and the combined summary ─────────────
// A long table read in parts (smoke test 2026-09-27: a 293K-character
// membership export in 5 parts) gave "Part 2 of 5 of a customer membership
// database showing member IDs CC-10620 through CC-11280…" as its summary and
// lost the report's headline (2,900 active members, $75,835 MRR).
//
// The tidy-up is CONSERVATIVE (independent checks of 2026-09-28, rounds 1–2):
//  - A business fact is never dropped or blanked because of its wording. It
//    only loses an exact document-part label ("Part 2 of 5:" where 5 is the
//    source's real part count) at its start. "Part 2 of the lease requires…",
//    "Part 2 of 2023's capital plan…", "Part 1 of 3 of the expansion…" are
//    facts and are kept word for word.
//  - Row-range detection ("customer records from February 2023 through
//    November 2023") only shapes the combined SUMMARY: which part's summary
//    leads, and leaving a part's pure row description out of it when another
//    part says what the source is. A misfire there can only reorder or
//    shorten the summary, never lose a fact.

/** Nouns the reader uses for the source it labels ("Part 2 of 5 of a customer membership database"). */
const DOC_NOUN = "(?:database|export|report|file|document|spreadsheet|workbook|sheet|list|listing|register|ledger|statements?|transcript|schedule|table|data\\s?set|records?|returns?|log|extract|source|text|package|pack|roster|dump)";
/** "Part 2 of 5", "part 3/5", "(Part 4 of 5)", "This is part 2 of 5" at the very start. */
const PART_LABEL_START = /^\s*(?:this is\s+)?(\()?part\s+(\d{1,3})\s*(?:of|\/)\s*(\d{1,3})\b(?:\s*(\)))?/i;
/** What may follow an unbracketed label: a delimiter, or "of a/an/the <the source>". */
const AFTER_LABEL_DELIM = /^\s*[:\-–—,]\s*/;
/**
 * Words that end the noun phrase after "of the": an article, "to", a verb.
 * "Part 2 of 5 of the lease requires the tenant to file returns" names no
 * source — "returns" is five words on, past a verb — and is kept as written.
 */
const NOT_IN_SOURCE_NAME = "(?:the|a|an|to|is|are|was|were|be|been|being|has|have|had|and|or|of|that|which|who|it|its|this|these|requires?|required|shows?|showed|states?|stated|says|said|includes?|included|provides?|provided|lists?|listed|covers?|covered|contains?|contained|describes?|described|indicates?|indicated|notes?|noted|sets?|gives?|gave|must|shall|will|would|can|could|may|might|should|files?|filed|pays?|paid|runs?|ran)";
const AFTER_LABEL_OF_DOC = new RegExp(`^\\s*of\\s+(?:a|an|the)\\s+(?=(?:(?!${NOT_IN_SOURCE_NAME}\\b)[\\w'&/-]+\\s+){0,5}?${DOC_NOUN}\\b)`, "i");
/** "Part 4 of customer membership database…" — a part's own number without the count (summaries only). */
const OWN_PART_LEAD = /^\s*(?:this is\s+)?\(?part\s+(\d+)\)?\s*(?:[:\-–—,.]\s*|of\s+)(?:(?:the|a|an)\s+)?/i;

const capitalise = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export interface PartLabelOptions {
  /**
   * The source's real number of parts (the "M" the reader was told). A label
   * is only stripped when its M is exactly this. Unknown (a caller outside a
   * part-read): M must be a plausible part count (2…MAX_SOURCE_PARTS).
   */
  total?: number;
  /** This text's own part number (a summary): allows its bare "Part 4 of …" row-prose label. */
  part?: number;
  /** false: never the bare own-part label (a business fact). */
  lead?: boolean;
}

/**
 * The text without the reader's exact "Part N of M" label at its start:
 * "Part N of M" / "(Part N/M)" where M is the source's real part count and
 * 1 ≤ N ≤ M, followed by ":" "—" "-" "," (or, unbracketed, by "of a/an/the
 * <the source>" as the part prompt produced). Anything else — "Part 2 of
 * the lease requires…", "Part 2 of 2023's plan…", "Part 1 of 3 of the
 * expansion…" with 3 not the real count, a label mid-sentence — is left
 * exactly as written. Additionally, in a part's own summary (`part`), a bare
 * "Part 4 of …" goes when part 4's text that follows only describes its rows.
 */
export function stripPartLabel(text: string, opts: PartLabelOptions = {}): string {
  const m = PART_LABEL_START.exec(text);
  if (m) {
    const [whole, open, nRaw, mRaw, close] = m;
    const n = Number(nRaw);
    const total = Number(mRaw);
    const countOk = opts.total !== undefined ? total === opts.total : total >= 2 && total <= MAX_SOURCE_PARTS;
    if (n >= 1 && n <= total && countOk && !!open === !!close) {
      let rest = text.slice(whole.length);
      let ok = false;
      if (open) {
        ok = true;
        rest = rest.replace(AFTER_LABEL_DELIM, "").replace(/^\s+/, "");
      } else if (rest.trim() === "" || /^\s*[.;]?\s*$/.test(rest)) {
        ok = true;
        rest = "";
      } else if (AFTER_LABEL_DELIM.test(rest)) {
        ok = true;
        rest = rest.replace(AFTER_LABEL_DELIM, "");
      } else if (AFTER_LABEL_OF_DOC.test(rest)) {
        ok = true;
        rest = rest.replace(AFTER_LABEL_OF_DOC, "");
      }
      if (ok) return capitalise(rest.trim());
    }
    return text;
  }
  if (opts.lead !== false && opts.part !== undefined) {
    const own = OWN_PART_LEAD.exec(text);
    if (own && Number(own[1]) === opts.part) {
      const rest = text.slice(own[0].length);
      if (isRowRangeDescription(rest)) return capitalise(rest.trim());
    }
  }
  return text;
}

/** Figures that describe the business: amounts of 1,000+, $-amounts, percentages — never a year or a record ID ("CC-10620"). */
function headlineFigureCount(text: string): number {
  let n = 0;
  // A number is "1,234,567" or "1234.5" — never with a trailing comma ("2021, status").
  const re = /(?<![A-Za-z0-9][-–]?)(\$\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k|m|mm|million|thousand|b|bn|billion)?\b(\s?%)?/gi;
  for (const m of Array.from(text.matchAll(re))) {
    const [, dollar, num, scale, pct] = m;
    const v = Number(num.replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    if (pct) { n++; continue; }
    const isYear = !dollar && !scale && !num.includes(",") && v >= 1900 && v <= 2100;
    if (isYear) continue;
    if ((dollar && (scale || v >= 1000)) || v >= 1000 || scale) n++;
  }
  return n;
}

/**
 * A count of things the business has ("14 trucks", "450 households", "120
 * patients") — not a year, a day of a date ("July 1, 2023"), a range end
 * ("1 to 500") or part of a record ID.
 */
function hasBusinessCount(text: string): boolean {
  const re = /(?<![\w$.,\-–/+])(\d{1,3}(?:,\d{3})+|\d+)\s+(?!(?:through|to|until|and|of|or)\b)[a-z][a-z-]*/g;
  for (const m of Array.from(text.matchAll(re))) {
    const v = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(v) || v < 2) continue;
    if (!m[1].includes(",") && v >= 1900 && v <= 2100) continue;
    return true;
  }
  return false;
}

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** "2023", "March 2023", "Mar. 1, 2023", "2023-03", "2023-03-31", "FY2023". */
const DATE = `(?:(?:${MONTH}\\.?\\s+(?:\\d{1,2},?\\s+)?)?(?:fy\\s?)?(?:19|20)\\d{2}(?:-\\d{2}(?:-\\d{2})?)?)`;
const THRU = "(?:through|thru|to|until|and|–|—|-)";
/** The rows an export holds — never "list", "register" or "database" alone ("a client list of 450 households" is a fact). */
const ROW_WORDS = "(?:records?|rows?|entries|transactions?|line items?|(?:join|activity|payment|transaction|invoice|record)\\s+dates)";
/** "records from February 2023 through November 2023", "entries between 2022 and 2024". */
const ROW_DATE_RANGE = new RegExp(`\\b${ROW_WORDS}\\b[^.;]{0,40}?\\b(?:from|between|dated)\\s+${DATE}\\s*${THRU}\\s*${DATE}\\b`, "i");
/**
 * "member IDs CC-10620 through CC-11280", "IDs 10620 to 11280", "rows 1 to
 * 500" — a range of record IDs next to a record word (never a fiscal year
 * "FY-2019 to FY-2023" or a model range "models XR-500 through XR-900").
 */
const ROW_ID_RANGE = new RegExp(
  `\\b(?:IDs?|records?|rows?|entries|members?|accounts?|customers?|invoices?|subscriptions?)\\s+(?!FY-)[A-Z]{1,4}-\\d{3,}\\s*${THRU}\\s*(?:[A-Z]{1,4}-)?\\d{3,}\\b|\\b(?:IDs?|rows?|records?|entries)\\s*#?\\d+\\s*${THRU}\\s*#?\\d+\\b`,
  "i",
);
/** A finding about the records ("… show no major failures", "… were reconciled", "…: no late payments"): a fact, not a row range. */
const FINDING_AFTER = /^(?:\s*:\s*\S|[^.;]*?\b(?:show(?:s|ed)?|indicate[sd]?|confirm(?:s|ed)?|reveal(?:s|ed)?|demonstrate[sd]?|contain(?:s|ed)?|reflect(?:s|ed)?|total(?:s|led|ed)?|averag(?:e|es|ed)|grew|declined|increased|decreased|doubled|tripled|has|have|had|was|were|is|are|reconcile[sd]?|match(?:es|ed)?|agree[sd]?|tie[sd]?|support(?:s|ed)?|balance[sd]?|exceed(?:s|ed)?|verif(?:y|ies|ied)|prove[sd]?|remain(?:s|ed)?|equal(?:s|led|ed)?|include[sd]?|document(?:s|ed)|record(?:s|ed)|list(?:s|ed)|cover(?:s|ed)|net(?:s|ted)?|came|come|comes|run|runs|ran|went|go|goes)\b)/i;
/** The business doing something with the records ("The practice has retained patient records from …"): a fact. */
const FINDING_BEFORE = /\b(?:has|have|had|retain(?:s|ed)?|digiti[sz](?:e|es|ed)|kept|keeps?|maintain(?:s|ed)?|holds?|held|stor(?:e|es|ed)|occup(?:y|ies|ied)|stock(?:s|ed)?|owns?|owned|audit(?:s|ed)?|archiv(?:e|es|ed))\b/i;

/**
 * Prose that only says which rows of an export a part holds ("customer
 * records from February 2023 through November 2023", "member IDs CC-10620
 * through CC-11280") — row words with a range of dates or record IDs, and no
 * figure, count or finding about the business. Used for the combined
 * summary only (see the note above): never to drop a fact.
 */
export function isRowRangeDescription(text: string): boolean {
  const t = stripPartLabel(text);
  const m = ROW_DATE_RANGE.exec(t) ?? ROW_ID_RANGE.exec(t);
  if (!m) return false;
  if (headlineFigureCount(t) > 0 || hasBusinessCount(t)) return false;
  // The sentence the range sits in: what comes before it in that sentence, and after.
  const before = t.slice(0, m.index).split(/[.;](?:\s|$)/).pop() ?? "";
  if (FINDING_BEFORE.test(before)) return false;
  return !FINDING_AFTER.test(t.slice(m.index + m[0].length));
}

/** How strongly a part's summary states the source's headline (totals, figures). 0 = row prose. */
export function headlineScore(text: string): number {
  const t = stripPartLabel(text);
  if (!t || isRowRangeDescription(t)) return 0;
  const words = t.match(/\b(?:total|active|annual(?:i[sz]ed)?|recurring|revenue|mrr|arr|as (?:at|of)|year[- ]end|summary|overall|average)\b/gi)?.length ?? 0;
  return headlineFigureCount(t) + words;
}

/** A part's summary, with the part's real number when known (its own bare "Part 4 of …" label). */
export type PartSummary = string | { text: string; part?: number };

/**
 * The combined summary of a long source's parts: the part that states the
 * headline (totals, figures) first, then the others' own findings; a part
 * that only describes its rows adds nothing when another part says what the
 * source is. The reader's exact "Part N of M" labels (M = `total`, the
 * source's real part count) never reach it.
 */
export function combinePartSummaries(summaries: PartSummary[], opts: { total?: number } = {}): string {
  const items: string[] = [];
  for (const raw of summaries) {
    const { text, part } = typeof raw === "string" ? { text: raw, part: undefined } : raw;
    const s = stripPartLabel(text.trim(), { total: opts.total, part }).trim();
    if (!s) continue;
    const low = s.toLowerCase();
    if (items.some((x) => x.toLowerCase() === low || x.toLowerCase().includes(low))) continue;
    const shorter = items.findIndex((x) => low.includes(x.toLowerCase()));
    if (shorter >= 0) items[shorter] = s;
    else items.push(s);
  }
  const findings = items.filter((s) => !isRowRangeDescription(s));
  if (findings.length === 0) return items[0] ?? "";
  const scores = findings.map(headlineScore);
  const best = scores.indexOf(Math.max(...scores));
  // A part that only describes its rows is left out only when another part
  // states the source's headline; otherwise every part's summary stays, in
  // order (a sentence misread as row prose is never lost to a plain one).
  if (scores[best] <= 0) return items.join(" ");
  return [findings[best], ...findings.filter((_, i) => i !== best)].join(" ");
}

/** Keys of an extraction that describe the source in prose (joined across parts, never one part's only). */
const JOINED_TEXT_KEYS = new Set(["summary", "keyFacts", "redFlags", "callNotes", "sellerConcerns", "actionItems", "buyerInterests", "followUpNeeded", "keyTopics", "keyFinancialNotes"]);

/**
 * The parts of one long source's reading, combined into one extraction
 * (pure; each part already normalised):
 *  - a figure or other single value: the part for the NEWEST fiscal period
 *    wins (the 2024 return over the 2022 one), then the later part (a
 *    transcript's later correction) — with its period and "worked out" flag;
 *  - by-year maps year by year, the same way (a later return's restated
 *    comparative over the earlier return's figure);
 *  - prose about the source (summary, key facts, red flags…) and the
 *    extraction's own notes (private notes, speakers, set-aside years) are
 *    joined, each distinct line once;
 *  - _periodEnd is the latest period any part reports;
 *  - the reader's exact "Part N of M" label (M = the source's real part
 *    count) is taken off the start of the summary and of each fact — nothing
 *    else about a fact's wording is changed, and no fact is dropped for it.
 *
 * `opts.parts[i]` is list[i]'s real part number (1-based) and `opts.total`
 * the number of parts the reader was told about — a part that failed must
 * not renumber the others (extractDocumentData passes both). Without them,
 * list[i] is part i + 1 of list.length.
 */
export function combineExtractions(
  list: ExtractedDocumentData[],
  opts: { parts?: number[]; total?: number } = {},
): ExtractedDocumentData {
  const total = opts.total ?? list.length;
  const partOf = (i: number) => opts.parts?.[i] ?? i + 1;
  if (list.length === 1) {
    // One part read of several: only its labels come off.
    const only = list[0];
    if (opts.total === undefined || opts.total < 2) return only;
    const out: ExtractedDocumentData = {};
    for (const [k, v] of Object.entries(only)) {
      if (k.startsWith("_") || typeof v !== "string") { out[k] = v as never; continue; }
      const clean = k === "summary"
        ? combinePartSummaries([{ text: v, part: partOf(0) }], { total })
        : stripPartLabel(v, { total, lead: false });
      if (clean !== "") out[k] = clean as never;
    }
    return out;
  }
  // Newest fiscal period last (it wins a figure), then the parts in order.
  // Which part "says what the source is" never decides a fact (only the
  // summary's order — combinePartSummaries).
  const order = list
    .map((d, i) => ({ d, i, p: typeof d._periodEnd === "string" ? d._periodEnd : "" }))
    .sort((a, b) => (a.p === b.p ? a.i - b.i : a.p < b.p ? -1 : 1));
  const summaries: PartSummary[] = [];
  const out: ExtractedDocumentData = {};
  const keyPeriods: Record<string, string> = {};
  const inferred = new Set<string>();
  const stated = new Set<string>();
  const notes: string[] = [];
  const speakers: Record<string, string> = {};
  const setAside: Record<string, SetAsideYear[]> = {};
  const joined: Record<string, string[]> = {};
  let periodEnd = "";
  for (const { d, i } of order) {
    const periods = (d._keyPeriods as Record<string, string> | undefined) ?? {};
    const inferredHere = new Set(String(d._inferredKeys ?? "").split(",").map((k) => k.trim()).filter(Boolean));
    for (const [k, v] of Object.entries(d)) {
      if (v === undefined || v === null || v === "") continue;
      if (k === "_periodEnd") { if (typeof v === "string" && v > periodEnd) periodEnd = v; continue; }
      if (k === "_privateNotes") { notes.push(...String(v).split("\n").map((n) => n.trim()).filter(Boolean)); continue; }
      if (k === "_speakers" && isPlainObject(v)) { Object.assign(speakers, v); continue; }
      if (k === "_yearsSetAside" && isPlainObject(v)) {
        for (const [mk, entries] of Object.entries(v as Record<string, SetAsideYear[]>)) {
          const have = setAside[mk] ?? [];
          for (const e of Array.isArray(entries) ? entries : []) if (!have.some((h) => h.period === e.period && h.value === e.value)) have.push(e);
          setAside[mk] = have;
        }
        continue;
      }
      if (k === STATED_METRICS_KEY) { for (const s of String(v).split(",")) if (s.trim()) stated.add(s.trim()); continue; }
      if (k === "_keyPeriods" || k === "_inferredKeys") continue;
      if (k === "_documentType" || k === "_confidence") { out[k] = v as string; continue; }
      if (k.startsWith("_")) { out[k] = v as never; continue; }
      if (k === "summary" && typeof v === "string") { summaries.push({ text: v, part: partOf(i) }); continue; }
      if (JOINED_TEXT_KEYS.has(k) && typeof v === "string") {
        // Item by item ("Customer concentration" then "Customer concentration;
        // tax arrears" is each once); a fuller wording replaces one it contains.
        const list = (joined[k] ??= []);
        const items = k === "summary" ? [v.trim()] : v.split(/;\s+|\n+/).map((x) => x.trim().replace(/[;.\s]+$/, "")).filter(Boolean);
        for (const item of items) {
          const low = item.toLowerCase();
          if (list.some((x) => x.toLowerCase() === low || x.toLowerCase().includes(low))) continue;
          const shorter = list.findIndex((x) => low.includes(x.toLowerCase()));
          if (shorter >= 0) list[shorter] = item;
          else list.push(item);
        }
        continue;
      }
      if (isPlainObject(v) && isPlainObject(out[k])) {
        // Year by year: this (newer, or later) part's years over the earlier ones.
        out[k] = { ...(out[k] as Record<string, string>), ...(v as Record<string, string>) };
        continue;
      }
      // A business fact is kept as written: from any part it only loses the
      // reader's exact "Part N of M" label (never a sentence, never because
      // it names records and a range).
      const value = typeof v === "string" ? stripPartLabel(v, { total, lead: false }) : v;
      if (value === "") continue;
      out[k] = value as never;
      if (periods[k]) keyPeriods[k] = periods[k];
      else delete keyPeriods[k];
      if (inferredHere.has(k)) inferred.add(k);
      else inferred.delete(k);
    }
  }
  for (const [k, list] of Object.entries(joined)) out[k] = list.map((x) => stripPartLabel(x, { total, lead: false })).filter(Boolean).join("; ");
  if (summaries.length > 0) out.summary = combinePartSummaries(summaries, { total });
  if (periodEnd) out._periodEnd = periodEnd;
  if (Object.keys(keyPeriods).length > 0) out._keyPeriods = keyPeriods;
  const inferredList = Array.from(inferred).filter((k) => out[k] !== undefined);
  if (inferredList.length > 0) out._inferredKeys = inferredList.join(",");
  if (stated.size > 0) out[STATED_METRICS_KEY] = Array.from(stated).join(",");
  if (notes.length > 0) out._privateNotes = Array.from(new Set(notes)).join("\n");
  if (Object.keys(speakers).length > 0) out._speakers = speakers;
  if (Object.keys(setAside).length > 0) out._yearsSetAside = setAside;
  return out;
}

/**
 * Whether a failed extraction is worth trying again: a dropped or timed-out
 * connection, a rate limit or an overloaded / erroring API ("transient"), or
 * a request the API will refuse however often it is sent ("permanent" — a
 * bad request, no credits, a bad key). `reason` is a short, broker-readable
 * description (never the request or any key).
 */
export function classifyExtractionFailure(err: unknown): { kind: "transient" | "permanent"; reason: string } {
  const e = err as { status?: number; name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } } | null;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const code = e?.code ?? e?.cause?.code;
  const text = `${e?.name ?? ""} ${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
  if (status === 429) return { kind: "transient", reason: "the AI service was busy (rate limit)" };
  if (status === 529 || /overloaded/i.test(text)) return { kind: "transient", reason: "the AI service was overloaded" };
  if (status !== undefined && status >= 500) return { kind: "transient", reason: `the AI service had an error (${status})` };
  if (status === 408 || status === 409) return { kind: "transient", reason: "the AI service timed out" };
  if (/APIConnection|Connection error|timed? ?out|socket hang up|network/i.test(text) || /^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR\w*)$/.test(code ?? "")) {
    return { kind: "transient", reason: "the connection to the AI service dropped" };
  }
  if (status === 401 || status === 403) return { kind: "permanent", reason: "the AI service refused the key" };
  if (status === 400 && /credit|billing|balance/i.test(text)) return { kind: "permanent", reason: "the AI account is out of credits" };
  if (status !== undefined) return { kind: "permanent", reason: `the AI service refused the request (${status})` };
  return { kind: "permanent", reason: "the extraction returned nothing usable" };
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

/** How an equipment lease's terms read once moved off the premises-lease keys. */
const EQUIPMENT_LEASE_LABELS: Record<string, string> = {
  monthlyRent: "Payment", rent: "Payment", annualRent: "Annual payment", leaseExpiry: "Expires", leaseTerm: "Term",
  leaseStart: "Starts", leaseStartDate: "Starts", leaseRenewalOptions: "Options", landlord: "Lessor", leaseAddress: "Location",
};

/**
 * An equipment or vehicle lease (a forklift, a tractor, a copier): the terms
 * the reader filed under the premises-lease keys (leaseExpiry, monthlyRent,
 * leaseDetails, …) move to one equipmentLeases / vehicleLeases line naming
 * the source ("Equipment lease - Toyota forklift: Payment $1,150 per month;
 * Expires March 31, 2027"). The premises lease's facts are never touched.
 */
function rerouteEquipmentLease(data: ExtractedDocumentData, title: string, sourceTitle: string | undefined, inferredKeys: Set<string>): void {
  const target = equipmentLeaseKey(title);
  const parts: string[] = [];
  let summary: string | undefined;
  let inferred = false;
  for (const key of Object.keys(data)) {
    if (key.startsWith("_")) continue;
    const canonical = canonicalFieldName(key);
    if (!PREMISES_LEASE_KEY.test(key) && !PREMISES_LEASE_KEY.test(canonical)) continue;
    const value = data[key];
    delete data[key];
    if (typeof value !== "string" || !value.trim()) continue;
    if (inferredKeys.has(key)) inferred = true;
    if (canonical === "leaseDetails" || key === "leaseDetails" || canonical === "propertyInfo") summary = summary ? `${summary}; ${value.trim()}` : value.trim();
    else {
      const label = EQUIPMENT_LEASE_LABELS[key] ?? EQUIPMENT_LEASE_LABELS[canonical];
      parts.push(label ? `${label}: ${value.trim()}` : value.trim());
    }
  }
  // (A summary that already says a term is not repeated.)
  const terms = [summary, ...parts.filter((p) => !summary || !summary.includes(p.replace(/^[^:]+:\s*/, "")))].filter(Boolean).join("; ");
  if (!terms) return;
  const name = (sourceTitle ?? "").trim();
  const line = name && !terms.toLowerCase().includes(name.toLowerCase()) ? `${name}: ${terms}` : terms;
  const existing = typeof data[target] === "string" ? (data[target] as string).trim() : "";
  data[target] = existing ? `${existing}; ${line}` : line;
  if (inferred) inferredKeys.add(target);
}

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
  // A forklift, truck or copier lease: its term and payment are that
  // equipment's lease, never the premises lease's expiry and rent.
  // (A street address or tenant / landlord terms in the lease's own facts
  // outweigh an equipment word that only describes it.)
  const leaseFacts = { ...(data as Record<string, unknown>) };
  if (isEquipmentLeaseTitle(title, leaseFacts)) rerouteEquipmentLease(data, title, o.title, inferredKeys);

  // The premises a lease document is for (its address, else the place its title names).
  const premises = kind === "document" ? premisesKey(o.title ?? title, typeof data.leaseAddress === "string" ? data.leaseAddress : null) : undefined;
  const srcFor = (rawKey: string, key: string): FieldSource => ({
    ...base,
    ...(keyPeriods[rawKey] ? { period: keyPeriods[rawKey] } : {}),
    ...(isSpecialistSource(key, title, leaseFacts) ? { specialist: true, ...(premises && PREMISES_LEASE_KEY.test(key) ? { premises } : {}) } : {}),
    ...(inferredKeys.has(rawKey) ? { valueInferred: true } : {}),
  });

  const mergeValue = (rawKey: string, canonicalKey: string, value: unknown) => {
    // An A/R aging's "largest customer" is a share of receivables — its own measure.
    const key = receivablesMeasureKey(canonicalKey, value, title);
    if (isSuppressed(merged, key)) return; // the broker deleted it — stays deleted
    if (isBrokerProcessKey(key)) return; // never a business fact
    const src = srcFor(rawKey, key);
    // A headline figure with no amount in it ("call it a million and a half",
    // "close to 1.8") is a remark, not the figure: kept as another value,
    // never the headline.
    if (HEADLINE_MAPS.some((h) => h.head === key) && typeof value === "string" &&
        !typedNumericValues(value).some((t) => t.kind === "currency")) {
      recordAlternate(merged, key, value, src);
      return;
    }
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

  // The lease's address first: a second premises' lease is told from a
  // disputed one by its address (noteConflict), so it must be on file
  // before that lease's expiry and rent are weighed.
  const entries = Object.entries(data).sort(([a], [b]) => Number(b === "leaseAddress") - Number(a === "leaseAddress"));
  for (const [key, value] of entries) {
    if (!value || key.startsWith("_")) continue;
    mergeValue(key, canonicalFieldName(key), value);
  }
  // A quarter / run-rate goes on the metric's interim fact ("Q1 2025" of
  // interimRevenue); a forecast or unreviewed year is that year's other value.
  if (isPlainObject(data._yearsSetAside)) {
    for (const [mapKey, list] of Object.entries(data._yearsSetAside as unknown as Record<string, SetAsideYear[]>)) {
      for (const e of Array.isArray(list) ? list : []) {
        const src = srcFor(mapKey, mapKey);
        if (e.note) recordAlternate(merged, `${mapKey}.${e.period}`, e.value, { ...src, period: periodForYear(e.period, src.period), note: e.note });
        else mergeMapEntryInto(merged, interimKeyFor(mapKey), e.period, e.value, src, ctx);
      }
    }
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
