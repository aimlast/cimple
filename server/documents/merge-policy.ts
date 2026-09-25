/**
 * merge-policy.ts — how one source's value is weighed against the value on
 * file, for every fact the document/transcript/email/CRM pipeline merges.
 *
 * Authority is the source kind's rank (SOURCE_RANK in info-merger:
 * broker 7 > interview 6 > call/video 5 > questionnaire/email 4 >
 * document 3 > crm 2 > website/social 1), adjusted per FIELD CLASS
 * (founder decision A, 2026-09-26):
 *
 *  - DOCUMENT-AUTHORITATIVE fields (closed-year statement figures,
 *    balance-sheet lines, customer concentration from sales reports, lease
 *    address/term/rent/expiry, registry facts: shareholders, directors,
 *    incorporation, licence numbers): a document ranks DOCUMENT_AUTHORITY
 *    (5.5) — above a call, video call, email or the questionnaire, still
 *    below the seller live in the interview and the broker. The spoken value
 *    becomes an alternate and a material difference opens a discrepancy.
 *  - SPECIALIST sources (the org chart for key employees, the equipment
 *    list for equipment, the certification summary for certifications, the
 *    lease for lease terms …) rank DOCUMENT_AUTHORITY for their own facts.
 *  - Everything else (the seller's narrative claims) keeps the plain order,
 *    but a material conflict still raises a discrepancy.
 *
 * Between two sources of equal authority the one for the NEWER fiscal
 * period wins (FieldSource.period), then the newer source date
 * (FieldSource.dated) — never processing order, so upload and reprocess
 * agree. A value the reader worked out ("implied", "calculated", a vague
 * "Barrie area (address not stated)") only fills an empty field; any
 * explicit value replaces it. Placeholders ("not stated", "unknown") are
 * never facts.
 *
 * Pure — no I/O. Conflicts are collected in MergeContext.conflicts; the
 * ingest / reprocess callers persist them as discrepancies (source "merge",
 * see merge-conflicts.ts).
 */
import {
  getFieldSources,
  setFieldSource,
  getFieldAlternates,
  getFieldCorroborations,
  recordAlternate,
  noteSameValue,
  displaceCorroborations,
  repairCharIndexedValue,
  isUntrackedSource,
  isSuppressed,
  resolvedYearSources,
  summariseMapSource,
  sourceRowLookup,
  compareYearKeysDesc,
  numbersMateriallyConflict,
  typedNumericValues,
  sourceRank,
  SOURCE_RANK,
  LEGACY_SOURCE_NOTE,
  FIELD_SOURCES_KEY,
  FIELD_ALTERNATES_KEY,
  FIELD_CORROBORATIONS_KEY,
  type FieldSource,
  type FieldAlternate,
  type SourceKind,
  type SourceRowLookup,
} from "../interview/info-merger";

type Info = Record<string, unknown>;
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const LEGACY: FieldSource = { source: "system", note: LEGACY_SOURCE_NOTE };

// ─── Field classes ───────────────────────────────────────────────────────────

/** Rank of a document (or specialist source) for the facts it is the authority on. */
export const DOCUMENT_AUTHORITY_RANK = 5.5;

const DOC_AUTHORITATIVE_FIELD =
  /^(?:annualRevenue|revenue|grossProfit|grossMargin|netIncome|netProfit|operatingIncome|operatingExpenses|total(?:Assets|Liabilities|Expenses|Revenue)|cogs|costOfGoodsSold|costOfSales|accountsReceivable|accountsPayable|cash|cashAndEquivalents|currentAssets|otherCurrentAssets|currentLiabilities|longTermDebt|bankIndebtedness|debt|debtObligations|shareholderLoans?|retainedEarnings|shareholdersEquity|depreciation|amortization|interestExpense|incomeTaxes?|fixedAssets|workingCapital|customerConcentration|topCustomers?|largestCustomer|lease(?:Address|Expiry|ExpiryDate|StartDate|Term|Sqft|RenewalOptions|Details)?|monthlyRent|annualRent|rent|landlord|shareholders?|shareholding|ownershipSplit|ownershipPercent(?:age)?s?|directors?|officers?|incorporationDate|incorporat(?:ed|ion)(?:Jurisdiction|Year)?|entityType|legalName|corporat(?:e|ion)Number|businessNumber|registrationNumber|licen[cs]eNumbers?)$/;

/**
 * True for facts a document is the authority on: closed-year statement
 * figures (and their by-year maps), balance-sheet lines, customer
 * concentration, lease terms, registry facts.
 */
export function isDocumentAuthoritativeField(key: string): boolean {
  const base = key.replace(/ByYear$/, "");
  return base === "revenue" || DOC_AUTHORITATIVE_FIELD.test(key) || DOC_AUTHORITATIVE_FIELD.test(base);
}

/** Facts whose value belongs to one fiscal period (a different period is not a conflict). */
const PERIOD_FIGURE =
  /revenue|sales|profit|income|ebitda|sde|margin|expense|cost|receivable|payable|asset|liabilit|debt|cash|inventory|equity|earnings|payroll|wage|capex|depreciation|tax|rent/i;
/** Descriptive keys that merely mention a figure word ("assetsIncluded", "revenueStreams"). */
const NARRATIVE_KEY =
  /(Included|Streams?|Mix|Notes|Details|Description|Sources|Breakdown|Structure|Strategy|Plans?|History|Opportunit\w*|Drivers?|Trends?|Profile|Summary|Overview|Types?|Policy|Process)$/;
export function isPeriodFigure(key: string): boolean {
  return PERIOD_FIGURE.test(key) && !NARRATIVE_KEY.test(key);
}

/** A dedicated source for a fact: [fact key pattern, source title pattern]. */
const SPECIALIST_SOURCES: Array<[RegExp, RegExp]> = [
  // Book figures: the financial statements, not a tax return's version of them.
  [/^(annualRevenue|revenueByYear|grossProfit\w*|grossMargin|netIncome\w*|netProfit|operatingIncome|operatingExpenses|cogs|costOfGoodsSold|costOfSales|ebitda\w*|accountsReceivable\w*|accountsPayable\w*|inventor\w*|totalAssets\w*|totalLiabilities\w*|currentAssets\w*|otherCurrentAssets\w*|currentLiabilities\w*|longTermDebt\w*|retainedEarnings\w*|shareholdersEquity\w*|depreciation\w*|cash\w*)$/,
    /financial statements?|income statement|balance sheet|profit (?:and|&) loss|\bp&l\b|compil(?:ed|ation)|review engagement|audited/i],
  // Tax items: the tax return.
  [/^(taxableIncome\w*|incomeTax\w*|taxesPaid|taxBalance\w*|grossReceipts\w*|totalDeductions\w*|ordinaryBusinessIncome\w*|otherDeductions\w*)$/,
    /\bt2\b|1120|tax return|notice of assessment/i],
  [/^(keyEmployees|managementTeam|employeeStructure|keyPersonnel|orgChart|organizationalStructure)$/,
    /org(?:ani[sz]ation(?:al)?)?\s*chart|key people|management team|staff (?:list|roster)|employee (?:list|roster|census)|personnel/i],
  [/^(employees|fullTimeCount|partTimeCount|headcount)$/,
    /roster|headcount|payroll|employee (?:list|census)|staff list|org(?:ani[sz]ation(?:al)?)?\s*chart/i],
  [/^(certifications|qualityCertifications|isoCertifications|accreditations|qualitySystem|permitsLicenses)$/,
    /certif|quality (?:manual|summary|system|performance)|\biso\b|accredit|licen[cs]e/i],
  [/^(assetsIncluded|equipment|equipmentList|fleet|machinery|presses|pressList|vehicles)$/,
    /equipment|asset (?:list|register)|fixed assets?|fleet list|fleet\b|press list|machine list|vehicle list/i],
  [/^(customerConcentration|topCustomers?|largestCustomer|customerBase|customerList)$/,
    /customer (?:list|sales|revenue|concentration)|sales by customer|revenue by customer|a\/?r aging|receivables? aging/i],
  [/^(lease\w*|monthlyRent|annualRent|rent|landlord|propertyInfo)$/, /\blease\b/i],
  [/^(shareholders?|shareholding|ownershipSplit|directors?|officers?|incorporat\w*|entityType|legalName)$/,
    /minute book|articles|shareholders'? agreement|operating agreement|corporate (?:profile|registry|search)|certificate of (?:incorporation|status)/i],
];

/** True when the source (by its title / type) is a dedicated source for `key`. */
export function isSpecialistSource(key: string, sourceTitle: string | null | undefined): boolean {
  if (!sourceTitle) return false;
  return SPECIALIST_SOURCES.some(([k, t]) => k.test(key) && t.test(sourceTitle));
}

/**
 * Authority of `src` for fact `key` (field class and specialist aware):
 * a specialist document (the statements for book figures, the org chart for
 * key people) ranks just above other documents for its own facts — still
 * below the seller live and the broker.
 */
export function effectiveRank(key: string, src: Partial<FieldSource> | null | undefined): number {
  if (!src) return -1;
  const base = sourceRank(src.source);
  const isDoc = src.source === "document" || src.source === "email";
  if (src.specialist && isDoc) return Math.max(base, DOCUMENT_AUTHORITY_RANK + 0.25);
  if (src.source === "document" && isDocumentAuthoritativeField(key)) return Math.max(base, DOCUMENT_AUTHORITY_RANK);
  return base;
}

/** "2024", "Dec 31, 2024", "2024-06-30", "FY2024" → ISO yyyy-mm-dd (a bare year → its Dec 31). */
export function normalisePeriod(raw: unknown): string | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const iso = text.match(/^((?:19|20)\d{2})-(\d{2})(?:-(\d{2}))?/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3] ?? "28"}`;
  if (/^(?:fy\s*)?(?:19|20)\d{2}$/i.test(text)) return `${text.replace(/\D/g, "")}-12-31`;
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    const y = d.getFullYear();
    if (y >= 1900 && y <= 2099) {
      return `${y}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
  }
  const years = text.match(/(?:19|20)\d{2}/g);
  if (years && years.length > 0) return `${years.sort()[years.length - 1]}-12-31`;
  return undefined;
}

export function periodYear(p: string | undefined | null): string | undefined {
  return p && /^\d{4}/.test(p) ? p.slice(0, 4) : undefined;
}

/** +1 when `a` is newer than `b`, -1 older, 0 unknown/equal. */
function newer(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  return a > b ? 1 : a < b ? -1 : 0;
}

/**
 * True when `incoming` may replace the value currently on file (recorded as
 * `current`) for fact `key`:
 *  - an untracked legacy value only yields to the seller live or the broker;
 *  - a worked-out value never displaces anything, and any explicit value
 *    replaces a worked-out one;
 *  - otherwise the higher effective rank wins; at equal rank the newer
 *    fiscal period, then the newer source date; else the value on file stays.
 */
export function outranksFor(
  key: string,
  incoming: FieldSource,
  current: Partial<FieldSource> | null | undefined,
): boolean {
  if (!current || isUntrackedSource(current)) return sourceRank(incoming.source) >= SOURCE_RANK.interview;
  if (incoming.valueInferred && !current.valueInferred) return false;
  if (current.valueInferred && !incoming.valueInferred) return true;
  const a = effectiveRank(key, incoming);
  const b = effectiveRank(key, current);
  if (a !== b) return a > b;
  const byPeriod = newer(incoming.period, current.period);
  if (byPeriod !== 0) return byPeriod > 0;
  return newer(incoming.dated, current.dated) > 0;
}

// ─── Value hygiene ───────────────────────────────────────────────────────────

const PLACEHOLDER_PHRASE =
  /\b(?:not|never)\s+(?:been\s+|yet\s+|explicitly\s+|clearly\s+)?(?:stated|specified|provided|mentioned|disclosed|given|discussed|confirmed|available|known|clear|listed|included|identified|named)\b|\bunknown\b|\bunspecified\b|\bundisclosed\b|\btbd\b|\btba\b|\bn\/a\b|\bnot applicable\b|\bno (?:details|information|specifics|figures?|amounts?|data) (?:given|provided|stated|available)\b/i;

/** Words that carry no fact on their own ("specific address", "terms", "amounts"). */
const FILLER_WORDS = new Set([
  "specific", "exact", "exactly", "precise", "amount", "amounts", "term", "terms", "detail", "details", "figure", "figures",
  "address", "surname", "last", "first", "full", "name", "names", "date", "dates", "number", "numbers", "value", "values",
  "the", "a", "an", "of", "any", "but", "and", "or", "yet", "not", "never", "been", "was", "were", "is", "are", "be", "it",
  "stated", "specified", "provided", "mentioned", "disclosed", "given", "discussed", "confirmed", "available", "known",
  "clear", "listed", "included", "identified", "named", "unknown", "unspecified", "undisclosed", "tbd", "tba", "n", "na",
  "applicable", "information", "info", "currently", "at", "this", "time", "in", "source", "document", "call", "transcript",
  "no", "none", "explicitly", "clearly", "exact", "per", "for", "on", "to", "by", "with", "which", "what", "their", "its",
]);

function hasConcreteContent(text: string): boolean {
  if (/\d/.test(text)) return true;
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.some((w) => w.length >= 2 && !FILLER_WORDS.has(w));
}

/** Markers that the reader worked the value out instead of the source stating it. */
const INFERRED_ANYWHERE = /\b(?:implied|inferred|presum(?:ed|ably)|assumed|appears to be|apparently|by inference)\b/i;
const INFERRED_PARENTHETICAL =
  /\([^()]*\b(?:likely|calculated|computed|derived|estimated|remaining|based on|from context|worked out|my estimate|approximated)\b[^()]*\)/i;

export interface CleanValue {
  /** The value to record (null = a placeholder — record nothing). */
  value: string | null;
  /** The reader worked it out, or it was vague: lowest priority for its source. */
  inferred: boolean;
}

/**
 * Cleans one extracted string:
 *  - "specific amounts not stated", "Unknown", "N/A" → nothing (a placeholder);
 *  - "Pam (surname not provided)" → "Pam", marked vague;
 *  - "Asset sale implied (…)", "October 2029 (4 years remaining …)" → kept,
 *    marked worked-out.
 */
export function cleanExtractedValue(raw: string): CleanValue {
  let text = raw.trim();
  let inferred = false;
  // Parentheticals that only say something is missing go; the rest is kept.
  const stripped = text.replace(/\s*\(([^()]*)\)/g, (m, inner: string) => (PLACEHOLDER_PHRASE.test(inner) ? " " : m));
  if (stripped !== text) {
    inferred = true;
    text = stripped.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/[\s,;:–—-]+$/, "").trim();
  }
  if (!text) return { value: null, inferred: false };
  if (PLACEHOLDER_PHRASE.test(text)) {
    const rest = text.replace(new RegExp(PLACEHOLDER_PHRASE.source, "gi"), " ");
    if (!hasConcreteContent(rest)) return { value: null, inferred: false };
    inferred = true; // something concrete, but the source left part of it out
  }
  if (INFERRED_ANYWHERE.test(text) || INFERRED_PARENTHETICAL.test(text)) inferred = true;
  return { value: text, inferred };
}

/** True when a value says nothing ("not stated", "unknown", "N/A"). */
export function isPlaceholderValue(v: unknown): boolean {
  return typeof v === "string" && cleanExtractedValue(v).value === null;
}

// ─── Broker process data ─────────────────────────────────────────────────────

/**
 * How the deal reached the broker and the broker's own terms — never facts
 * about the business, never CIM input. Merges route them to the
 * broker-private notes; CIM inputs drop them (older rows included).
 */
const BROKER_PROCESS_KEY =
  /^(?:referral(?:Source|From|Details|Contact)?|referredBy|referrer|leadSource|lead(?:Origin|Channel|Status)|broker(?:Fee|Commission|Engagement|EngagementDate|Name|Firm)?|commission(?:Rate)?|successFee|listingAgreement|listing(?:Terms|Fee|Date)|engagement(?:Letter|Terms|Date|Fee)|retainer(?:Fee)?|saleAdvisor|sellSideAdvisor|advisor(?:Engaged|Engagement)|priorApproaches|previousApproaches|priorOffers?|sellerFloor|walkAwayPrice|lowestAcceptablePrice)$/i;

export function isBrokerProcessKey(key: string): boolean {
  return BROKER_PROCESS_KEY.test(key);
}

// ─── Years ───────────────────────────────────────────────────────────────────

const RELATIVE_PERIOD = /\b(?:ttm|ltm|ytd|trailing|last|this|current|next|prior|previous|projected|projection|forecast|budget|estimate[ds]?|run[- ]?rate|annuali[sz]ed|to date|q[1-4]|h[12]|month)\b/i;

/**
 * A revenue-by-year key → the fiscal year it is (the year-END year):
 * "2023", "FY23", "FY2023", "fiscal 2023", "FY2022/23", "2022-2023" → "2023".
 * Relative or partial periods ("Last year", "YTD", "TTM Sep 2025",
 * "2025 (projected)") → null.
 */
export function normaliseYearKey(key: string): string | null {
  const k = key.trim();
  if (RELATIVE_PERIOD.test(k)) return null;
  let m = k.match(/^(?:fy|fiscal(?:\s+year)?|year|ye)?\s*'?((?:19|20)\d{2})(?:\s*\((?:fy|fiscal)\))?$/i);
  if (m) return m[1];
  m = k.match(/^(?:fy|fiscal(?:\s+year)?)\s*'?(\d{2})$/i);
  if (m) return `20${m[1]}`;
  m = k.match(/^(?:fy|fiscal(?:\s+year)?)?\s*((?:19|20)\d{2})\s*[\/–—-]\s*(\d{2}|(?:19|20)\d{2})$/i);
  if (m) return m[2].length === 2 ? `${m[1].slice(0, 2)}${m[2]}` : m[2];
  m = k.match(/^(?:fy|fiscal(?:\s+year)?)\s*(\d{2})\s*[\/–—-]\s*(\d{2})$/i);
  if (m) return `20${m[2]}`;
  const years = k.match(/(?:19|20)\d{2}/g);
  if (years && years.length === 1 && /^(?:fy|fiscal|year|ye|ended|end|dec(?:ember)?|jun(?:e)?|mar(?:ch)?|sep(?:tember)?|[\s.,'()\d-])*$/i.test(k)) return years[0];
  return null;
}

/** Which metric a by-year value names (to catch "SDE ~$380K" filed under revenue). */
const METRIC_WORDS: Array<[string, RegExp]> = [
  ["sde", /\b(?:sde|seller'?s? discretionary|discretionary earnings)\b/i],
  ["ebitda", /\bebitda\b/i],
  ["profit", /\b(?:net income|net profit|gross profit|profit|net earnings|margin)\b/i],
  ["cashflow", /\bcash ?flow\b/i],
];
function metricFamily(metric: string): string {
  const m = metric.toLowerCase();
  if (/sde|discretionary/.test(m)) return "sde";
  if (/ebitda/.test(m)) return "ebitda";
  if (/profit|income|margin|earnings/.test(m)) return "profit";
  if (/cash/.test(m)) return "cashflow";
  return m.includes("revenue") || m.includes("sales") ? "revenue" : m;
}

export interface CleanYearMap {
  map: Record<string, string>;
  /** Entries that aren't this metric's figure for a fiscal year — kept as notes, never as figures. */
  rejected: string[];
}

/**
 * Cleans one by-year map from an extraction: year keys normalised (one key
 * per fiscal year), relative periods and entries that aren't this metric's
 * figure (another metric, no figure, a placeholder) set aside as notes.
 * When two raw keys land on the same year, a plain "2023" key wins over
 * "FY23"-style ones.
 */
export function cleanYearMap(metric: string, raw: Record<string, unknown>): CleanYearMap {
  const map: Record<string, string> = {};
  const plain = new Set<string>();
  const rejected: string[] = [];
  const family = metricFamily(metric);
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    if (rawValue === null || rawValue === undefined || rawValue === "") continue;
    const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue);
    const year = normaliseYearKey(rawKey);
    const clean = cleanExtractedValue(value);
    const otherMetric = METRIC_WORDS.find(([f, re]) => f !== family && re.test(value));
    // A budget, forecast or run-rate is not that year's figure.
    const notActual = /\b(?:budget(?:ed)?|projected|projection|forecast|target|run[- ]?rate|expected|plan(?:ned)?|pro ?forma|ytd|year[- ]to[- ]date|annuali[sz]ed|q[1-4]|quarter(?:ly)?|first half|h[12]|\d+ months?|monthly)\b/i.test(value);
    // Part of the business ("$6.8M (Alderbrook only)") is not the year's total.
    const subset = /\b(?:only|alone|segment|division|client|customer)\b/i.test(value);
    // A figure the reader worked out ("implied from 6.5% growth") is never a year's figure.
    if (!year || clean.value === null || clean.inferred || !/\d/.test(value) || otherMetric || notActual || subset) {
      rejected.push(`${rawKey}: ${value}`);
      continue;
    }
    const isPlain = /^(?:19|20)\d{2}$/.test(rawKey.trim());
    if (map[year] !== undefined) {
      if (map[year] === clean.value) continue;
      if (isPlain && !plain.has(year)) {
        rejected.push(`${year}: ${map[year]}`);
      } else {
        rejected.push(`${rawKey}: ${value}`);
        continue;
      }
    }
    map[year] = clean.value;
    if (isPlain) plain.add(year);
  }
  return { map, rejected };
}

/**
 * A headline figure that lists several years ("$3,082,400 (2023), $2,780,200
 * (2022)", "2024: $2.1M; 2023: $1.9M") → the per-year map, else null.
 */
export function splitMultiYearValue(value: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const amount = String.raw`\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|million|thousand|b|billion)?`;
  const yearTag = String.raw`(?:fy\s*)?((?:19|20)\d{2})`;
  const reAfter = new RegExp(`(${amount})\\s*\\(\\s*${yearTag}[^)]*\\)`, "gi");
  const reBefore = new RegExp(`${yearTag}\\s*[:=–—-]\\s*(${amount})`, "gi");
  let m: RegExpExecArray | null;
  while ((m = reAfter.exec(value)) !== null) if (!out[m[2]]) out[m[2]] = m[1].trim();
  while ((m = reBefore.exec(value)) !== null) if (!out[m[1]]) out[m[1]] = m[2].trim();
  return Object.keys(out).length >= 2 ? out : null;
}

/** "$31,020,000 (FY2024)" → { value: "$31,020,000", year: "2024" }; otherwise the value unchanged. */
export function stripYearTag(value: string): { value: string; year?: string } {
  const m = value.match(/^\s*(\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|million|thousand|b|billion)?)\s*\(\s*(?:fy\s*)?((?:19|20)\d{2})\s*\)\s*$/i);
  return m ? { value: m[1].trim(), year: m[2] } : { value };
}

/** Headline facts and the by-year map that holds their history. */
export const HEADLINE_MAPS: ReadonlyArray<{ head: string; map: string }> = [
  { head: "annualRevenue", map: "revenueByYear" },
  { head: "grossProfit", map: "grossProfitByYear" },
  { head: "netIncome", map: "netIncomeByYear" },
  { head: "ebitda", map: "ebitdaByYear" },
  { head: "adjustedEbitda", map: "adjustedEbitdaByYear" },
  { head: "sde", map: "sdeByYear" },
];

/** Extractor metric names → the canonical headline key. */
const METRIC_HEAD: Record<string, string> = {
  revenue: "annualRevenue", revenues: "annualRevenue", annualRevenue: "annualRevenue", sales: "annualRevenue",
  totalRevenue: "annualRevenue", grossRevenue: "annualRevenue", netSales: "annualRevenue",
  grossProfit: "grossProfit", netIncome: "netIncome", netProfit: "netIncome", ebitda: "ebitda",
  adjustedEbitda: "adjustedEbitda", sde: "sde", adjustedSde: "sde",
};

/** The by-year map key for a metric name ("revenue" → revenueByYear, "cash" → cashByYear). */
export function yearMapKeyFor(metric: string): string {
  const head = METRIC_HEAD[metric] ?? METRIC_HEAD[metric.charAt(0).toLowerCase() + metric.slice(1)];
  const pair = head ? HEADLINE_MAPS.find((p) => p.head === head) : undefined;
  if (pair) return pair.map;
  const base = metric.charAt(0).toLowerCase() + metric.slice(1);
  return base.endsWith("ByYear") ? base : `${base}ByYear`;
}

/** The headline key a metric name stands for, if it is one. */
export function headlineKeyFor(metric: string): string | undefined {
  return METRIC_HEAD[metric];
}

/** True for by-year map keys (merged year by year). */
export function isYearMapKey(key: string): boolean {
  return key === "revenueByYear" || /ByYear$/.test(key);
}

/** "netIncome2023", "sde_2024", "ebitdaFy2022", "revenueFY23" → { metric, year }. */
export function yearSuffixedKey(key: string): { metric: string; year: string } | null {
  let m = key.match(/^([a-z][A-Za-z]*?)_?(?:[Ff][Yy])_?((?:19|20)\d{2}|\d{2})$/);
  if (m) return { metric: m[1], year: m[2].length === 2 ? `20${m[2]}` : m[2] };
  m = key.match(/^([a-z][A-Za-z]*?)_?((?:19|20)\d{2})$/);
  if (m) return { metric: m[1], year: m[2] };
  return null;
}

// ─── Conflicts ───────────────────────────────────────────────────────────────

export interface ConflictSide {
  value: string;
  src: FieldSource;
}

/** Two sources disagree materially about one fact (or one year of a map fact). */
export interface MergeConflict {
  factKey: string;
  factYear?: string;
  /** The value kept on file. */
  winner: ConflictSide;
  /** The value that lost (kept as an alternate). */
  loser: ConflictSide;
}

export interface MergeContext {
  /** Collects material conflicts the merge saw (callers persist them as discrepancies). */
  conflicts?: MergeConflict[];
  /** Resolves older bare-id year entries to their row's kind / visibility. */
  lookup?: SourceRowLookup;
}

const DATEISH_KEY = /expir|date|incorporat|founded|established|start|renewal|since|term/i;
const NAMEISH_KEY = /shareholder|director|officer|owner|landlord|legalName|accountant|lawyer/i;
const NAME_STOP = new Set(["The", "Inc", "Ltd", "LLC", "Corp", "Co", "And", "Of", "Owner", "President", "Director", "Directors", "Shareholder", "Shareholders", "Officer", "CEO", "CFO", "VP", "Dr", "Mr", "Mrs", "Ms"]);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function dateParts(text: string): Array<{ y: string; m?: number }> {
  const out: Array<{ y: string; m?: number }> = [];
  const re = /(?:\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?)?((?:19|20)\d{2})(?:-(\d{2}))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : m[3] ? Number(m[3]) : undefined;
    out.push({ y: m[2], ...(month ? { m: month } : {}) });
  }
  return out;
}

/** Years a lease is said to end (or run to): every year in a lease-expiry value, else years after "expires / runs to / until …". */
function leaseEndYears(text: string, key: string): Set<string> {
  if (/expir/i.test(key)) return new Set(text.match(/(?:19|20)\d{2}/g) ?? []);
  const out = new Set<string>();
  const re = /\b(?:expir\w*|runs?|ends?|until|through|terminat\w*|to)\s*:?\s+(?:[a-z]+\.?\s+)?(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?((?:19|20)\d{2})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

function nameTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.match(/\b[A-Z][a-z]{2,}\b/g) ?? []) if (!NAME_STOP.has(w)) out.add(w);
  return out;
}

/**
 * True when two values for `key` disagree in a way a broker must look at:
 * figures more than 5% apart, a different date, or (registry fields)
 * different names. Long narrative values are never compared.
 */
export function materiallyDifferent(key: string, a: string, b: string): boolean {
  if (!a || !b || a.trim() === b.trim()) return false;
  // Lease terms (also inside a lease summary): a different end year is a
  // conflict ("the lease runs to 2029" vs "Expires: August 31, 2027").
  if (/lease/i.test(key)) {
    const ea = leaseEndYears(a, key);
    const eb = leaseEndYears(b, key);
    if (ea.size > 0 && eb.size > 0 && !Array.from(ea).some((y) => eb.has(y))) return true;
  }
  const figureKey = (isDocumentAuthoritativeField(key) || isPeriodFigure(key)) && !NARRATIVE_KEY.test(key);
  // Narrative claims are compared only when both are short, figure-like
  // statements — two descriptions quoting different numbers are not a conflict.
  if (!figureKey && (a.length > 60 || b.length > 60)) return false;
  if (figureKey && (a.length > 240 || b.length > 240)) return false;
  const hasTyped = (t: string) => typedNumericValues(t).length > 0;
  if (hasTyped(a) && hasTyped(b)) return numbersMateriallyConflict(a, b, 0.05);
  if (DATEISH_KEY.test(key)) {
    // The same day written two ways, or a day apart ("Sep 30" vs "Oct 1"), agrees.
    const ta = Date.parse(a.trim());
    const tb = Date.parse(b.trim());
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && Math.abs(ta - tb) <= 3 * 86_400_000) return false;
    const da = dateParts(a);
    const db = dateParts(b);
    if (da.length > 0 && db.length > 0) {
      const agree = da.some((x) => db.some((y) => x.y === y.y && (!x.m || !y.m || x.m === y.m)));
      return !agree;
    }
  }
  if (NAMEISH_KEY.test(key)) {
    const na = nameTokens(a);
    const nb = nameTokens(b);
    if (na.size >= 1 && nb.size >= 1 && na.size + nb.size >= 3) {
      // Different people, not the same people written differently
      // ("Harjit S. Grewal" vs "Harjit Singh Grewal").
      const shared = Array.from(na).filter((w) => nb.has(w)).length;
      const union = new Set([...Array.from(na), ...Array.from(nb)]).size;
      return shared / union < 0.5;
    }
  }
  return false;
}

function sameOrigin(a: FieldSource, b: FieldSource): boolean {
  if (a.documentId && b.documentId) return a.documentId === b.documentId;
  return !a.documentId && !b.documentId && a.source === b.source && a.sessionId === b.sessionId;
}

/** Records a conflict when it is material and between two different, explicit sources. */
export function noteConflict(ctx: MergeContext, factKey: string, factYear: string | undefined, winner: ConflictSide, loser: ConflictSide): void {
  if (!ctx.conflicts) return;
  if (winner.src.valueInferred || loser.src.valueInferred) return;
  if (isUntrackedSource(winner.src) && isUntrackedSource(loser.src)) return;
  if (sameOrigin(winner.src, loser.src)) return;
  if (!factYear) {
    // Two sources for different fiscal periods (FY2023 vs FY2024 statements,
    // last year's and this year's tax return) differing is history, not a
    // conflict — the newer period is on file.
    const a = periodYear(winner.src.period);
    const b = periodYear(loser.src.period);
    // (A lease's terms don't change with the reporting period of the source.)
    const bothDocuments = winner.src.source === "document" && loser.src.source === "document";
    if (a && b && a !== b && (bothDocuments || (isPeriodFigure(factKey) && !/lease|rent/i.test(factKey)))) return;
  }
  if (!materiallyDifferent(factKey, winner.value, loser.value)) return;
  // Figures over three times apart are a different measure (EBITDA filed as
  // revenue, the yard's rent vs the warehouse's), not the same fact disputed.
  const wn = typedNumericValues(winner.value).find((t) => t.kind === "currency")?.value;
  const ln = typedNumericValues(loser.value).find((t) => t.kind === "currency")?.value;
  if (wn && ln && Math.max(wn, ln) / Math.min(wn, ln) > 3) return;
  const text = (s: FieldSource) => ({ ...s });
  ctx.conflicts.push({
    factKey,
    ...(factYear ? { factYear } : {}),
    winner: { value: winner.value, src: text(winner.src) },
    loser: { value: loser.value, src: text(loser.src) },
  });
}

/**
 * The conflicts still standing once every source is merged: a merge
 * notices conflicts along the way (an FY2022 statement beating a call's
 * "$31M" before the FY2024 statement arrived), so each is re-checked
 * against the value finally on file — its winner becomes that value and
 * its source, and it is dropped when the losing value no longer differs
 * materially from it. Duplicates (same fact, year and values) collapse.
 */
export function settleConflicts(info: Info, conflicts: MergeConflict[]): MergeConflict[] {
  const sources = getFieldSources(info);
  const out: MergeConflict[] = [];
  const seen = new Set<string>();
  for (const c of conflicts) {
    let current: unknown;
    let currentSrc: FieldSource | null | undefined;
    const mapKey = HEADLINE_MAPS.find((p) => p.head === c.factKey)?.map;
    if (c.factYear && (isYearMapKey(c.factKey) || !mapKey)) {
      const map = repairCharIndexedValue(info[c.factKey]);
      current = isMap(map) ? map[c.factYear] : undefined;
      currentSrc = isMap(map) && sources[c.factKey] ? resolvedYearSources(sources[c.factKey], map)[c.factYear] : null;
    } else {
      current = info[c.factKey];
      currentSrc = sources[c.factKey];
    }
    if (current === undefined || current === null || current === "") continue;
    const winner: ConflictSide = { value: serial(current), src: currentSrc ?? c.winner.src };
    const settled: MergeConflict[] = [];
    noteConflict({ conflicts: settled }, c.factKey, c.factYear, winner, c.loser);
    for (const s of settled) {
      const key = `${s.factKey}|${s.factYear ?? ""}|${s.winner.value}|${s.loser.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

// ─── Scalar and by-year merges ───────────────────────────────────────────────

const serial = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * Two sources state the same value: the one with more authority FOR THIS
 * FACT is recorded (a statement over an email that repeats its figure), the
 * other kept as a corroboration — so a later spoken figure has to beat the
 * statement, not the email.
 */
export function strongerFor(key: string): (incoming: FieldSource, current: FieldSource) => boolean {
  return (incoming, current) => effectiveRank(key, incoming) > effectiveRank(key, current);
}

/**
 * Merges one scalar value from `src` into `info[key]`: fills an empty
 * field, keeps a same value as a corroboration, otherwise the side that
 * outranks (see outranksFor) is kept and the other becomes an alternate.
 * Returns true when the value on file changed.
 */
export function mergeScalarInto(info: Info, key: string, value: unknown, src: FieldSource, ctx: MergeContext = {}): boolean {
  if (isSuppressed(info, key)) return false;
  const current = info[key];
  if (current === null || current === undefined || current === "") {
    info[key] = value;
    setFieldSource(info, key, src);
    return true;
  }
  const same = typeof current === "object" || typeof value === "object"
    ? JSON.stringify(current) === JSON.stringify(value)
    : String(current) === String(value);
  if (same) {
    noteSameValue(info, key, src, { outranks: strongerFor(key) });
    return false;
  }
  const cur = getFieldSources(info)[key];
  if (outranksFor(key, src, cur)) {
    recordAlternate(info, key, current, cur ?? LEGACY);
    info[key] = value;
    setFieldSource(info, key, src);
    displaceCorroborations(info, key, value);
    noteConflict(ctx, key, undefined, { value: serial(value), src }, { value: serial(current), src: cur ?? LEGACY });
    return true;
  }
  recordAlternate(info, key, value, src);
  noteConflict(ctx, key, undefined, { value: serial(current), src: cur ?? LEGACY }, { value: serial(value), src });
  return false;
}

/** The fiscal period of one year of a map, given the source's own period end. */
export function periodForYear(year: string, sourcePeriod: string | undefined): string {
  if (!sourcePeriod || !/^\d{4}-\d{2}-\d{2}$/.test(sourcePeriod)) return `${year}-12-31`;
  // The source's own fiscal year-end, in that year (a June year-end stays June).
  return `${year}${sourcePeriod.slice(4)}`;
}

/**
 * Years of a by-year map that are an interim period, not a fiscal year: a
 * document year whose period ends on a different month-day than the
 * business's fiscal year-end (what most document years end on) and is not
 * older than the last full year — "2025: $4.7M" from an MRR schedule dated
 * Mar 31, 2025 is annualised run-rate, not FY2025 revenue.
 */
export function interimYears(years: Record<string, FieldSource>): string[] {
  const md = (p?: string) => (p && /^\d{4}-\d{2}-\d{2}$/.test(p) ? p.slice(5) : undefined);
  const counts = new Map<string, number>();
  for (const s of Object.values(years)) {
    if (s.source !== "document") continue;
    const m = md(s.period);
    if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  if (ranked.length < 2 || ranked[0][1] < 2) return [];
  const fye = ranked[0][0];
  const fullYears = Object.entries(years).filter(([, s]) => md(s.period) === fye).map(([y]) => y);
  const sortedFull = fullYears.sort();
  const lastFull = sortedFull[sortedFull.length - 1] ?? "";
  return Object.entries(years)
    .filter(([y, s]) => s.source === "document" && md(s.period) && md(s.period) !== fye && y >= lastFull)
    .map(([y]) => y);
}

/**
 * Merges a by-year map (revenueByYear, sdeByYear, …) year by year. Each year
 * keeps its own full source: an incoming year replaces the one on file only
 * when it outranks it (a closed-year statement beats a call, an email or a
 * CRM approximation; at equal rank the newer statement's figure wins), and
 * the losing figure is kept as that year's alternate ("revenueByYear.2024").
 * A free-text value on file (the seller's own words) stands; the map is kept
 * as an alternate.
 */
export function mergeYearMapInto(info: Info, key: string, incoming: Record<string, string>, src: FieldSource, ctx: MergeContext = {}): void {
  if (isSuppressed(info, key)) return;
  const current = repairCharIndexedValue(info[key]);
  const empty = current === null || current === undefined || current === "";
  if (!empty && !isMap(current)) { recordAlternate(info, key, incoming, src); return; }
  const map: Record<string, unknown> = isMap(current) ? { ...current } : {};
  const recorded = getFieldSources(info)[key];
  const years: Record<string, FieldSource> = Object.keys(map).length === 0
    ? {}
    : recorded
      ? resolvedYearSources(recorded, map, ctx.lookup)
      : Object.fromEntries(Object.keys(map).map((y) => [y, LEGACY])); // an untracked map stays untracked
  const { years: _drop, ...base } = src;
  for (const [y, v] of Object.entries(incoming)) {
    if (v === undefined || v === null || v === "") continue;
    const ySrc: FieldSource = { ...base, period: periodForYear(y, src.period) };
    const cur = map[y];
    if (cur === undefined || cur === null || cur === "") {
      map[y] = v;
      years[y] = ySrc;
      continue;
    }
    const curSrc = years[y] ?? LEGACY;
    const altKey = `${key}.${y}`;
    if (String(cur) === String(v)) {
      // Same figure from another source: remembered (the stronger one is recorded).
      noteSameValue(info, altKey, ySrc, {
        current: cur,
        recorded: isUntrackedSource(curSrc) ? null : curSrc,
        setRecorded: (s) => { years[y] = s; },
        outranks: strongerFor(key),
      });
      continue;
    }
    if (outranksFor(key, ySrc, curSrc)) {
      recordAlternate(info, altKey, cur, curSrc);
      map[y] = v;
      years[y] = ySrc;
      displaceCorroborations(info, altKey, v);
      noteConflict(ctx, key, y, { value: v, src: ySrc }, { value: String(cur), src: curSrc });
    } else {
      recordAlternate(info, altKey, v, ySrc);
      noteConflict(ctx, key, y, { value: String(cur), src: curSrc }, { value: v, src: ySrc });
    }
  }
  // An interim period (a run-rate, a quarter) is never a fiscal year's figure:
  // it stays visible as that year's other value, not as the year.
  for (const y of interimYears(years)) {
    recordAlternate(info, `${key}.${y}`, map[y], { ...years[y], note: "Part-year / run-rate figure" });
    delete map[y];
    delete years[y];
  }
  if (Object.keys(map).length === 0) return;
  info[key] = map;
  if (Object.values(years).every((s) => isUntrackedSource(s))) return; // nothing tracked yet
  const summary = summariseMapSource(years);
  if (summary) setFieldSource(info, key, summary);
}

/**
 * Lines each headline figure (annualRevenue, sde, ebitda, …) up with its
 * by-year map: the headline is the more authoritative of the value on file
 * and the best year of the map (rank first, then the latest year), so a
 * broker-only CRM guess never stands as the headline next to a closed-year
 * statement, and a year the seller stated on a call becomes the headline
 * when nothing stronger exists. The weaker value is kept as an alternate;
 * a material difference for the same period is a conflict.
 */
export function reconcileHeadlines(info: Info, ctx: MergeContext = {}): void {
  const sources = getFieldSources(info);
  for (const { head, map: mapKey } of HEADLINE_MAPS) {
    if (isSuppressed(info, head)) continue;
    const map = repairCharIndexedValue(info[mapKey]);
    if (!isMap(map)) continue;
    const recorded = sources[mapKey];
    const ys = recorded ? resolvedYearSources(recorded, map, ctx.lookup) : {};
    const candidates = Object.keys(map)
      .filter((y) => /^(?:19|20)\d{2}$/.test(y) && typeof map[y] === "string" && /\d/.test(map[y] as string))
      .map((y) => ({ year: y, value: map[y] as string, src: { ...(ys[y] ?? LEGACY), period: ys[y]?.period ?? `${y}-12-31` } as FieldSource }))
      .filter((c) => !isUntrackedSource(c.src));
    if (candidates.length === 0) continue;
    // Never step back to an older year than the headline on file is for
    // (a stronger FY2022 statement doesn't replace a 2024 figure).
    const onFileYear = periodYear(sources[head]?.period) ?? (typeof info[head] === "string" ? stripYearTag(info[head] as string).year : undefined);
    if (onFileYear && info[head] !== undefined && info[head] !== null && info[head] !== "") {
      for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].year < onFileYear) candidates.splice(i, 1);
      if (candidates.length === 0) continue;
    }
    candidates.sort((a, b) =>
      effectiveRank(head, b.src) - effectiveRank(head, a.src) ||
      Number(!!a.src.valueInferred) - Number(!!b.src.valueInferred) ||
      compareYearKeysDesc(a.year, b.year));
    const best = candidates[0];
    const { years: _y, ...bestSrc } = best.src;
    const current = info[head];
    const curSrc = sources[head];
    if (current === null || current === undefined || current === "") {
      info[head] = best.value;
      setFieldSource(info, head, bestSrc);
      continue;
    }
    if (String(current) === best.value) continue;
    const curYear = periodYear(curSrc?.period) ?? stripYearTag(String(current)).year;
    if (outranksFor(head, bestSrc, curSrc)) {
      recordAlternate(info, head, current, curSrc ?? LEGACY);
      info[head] = best.value;
      setFieldSource(info, head, bestSrc);
      displaceCorroborations(info, head, best.value);
      if (!curYear || curYear === best.year) {
        noteConflict(ctx, head, best.year, { value: best.value, src: bestSrc }, { value: serial(current), src: { ...(curSrc ?? LEGACY), period: `${best.year}-12-31` } });
      }
    } else {
      // The headline on file stays; the map's same-period figure may disagree.
      const same = candidates.find((c) => c.year === (curYear ?? best.year));
      if (same && same.value !== String(current)) {
        noteConflict(ctx, head, same.year, { value: serial(current), src: { ...(curSrc ?? LEGACY), period: `${same.year}-12-31` } }, { value: same.value, src: same.src });
      }
    }
  }
}

// ─── Stamping sources with their rows' details ───────────────────────────────

/**
 * Stamps every source entry that points at a documents row with that row's
 * visibility (`brokerOnly`) and upgrades older bare-id year entries to full
 * per-year sources (kind + visibility read from the row), so readers that
 * have no documents list (the CIM writer, the deal list) can tell a
 * broker-only CRM year from a statement year. Pure: returns a new object.
 */
export function stampSourceDetails(
  info: Info,
  documents: Array<{ id: string; sourceKind?: string | null; visibility?: string | null }>,
): Info {
  const lookup = sourceRowLookup(documents);
  const out: Info = { ...info };
  const stamp = <T extends Partial<FieldSource>>(s: T): T => {
    if (!s || !s.documentId) return s;
    const bo = lookup.brokerOnlyOf?.(s.documentId);
    return bo === undefined || s.brokerOnly === bo ? s : { ...s, brokerOnly: bo };
  };
  const sources = getFieldSources(info);
  if (Object.keys(sources).length > 0) {
    const next: Record<string, FieldSource> = {};
    for (const [key, src] of Object.entries(sources)) {
      const value = repairCharIndexedValue(info[key]);
      if (src && src.years && isMap(value)) {
        const ys = resolvedYearSources(src, value, lookup);
        const stamped: Record<string, FieldSource> = {};
        for (const [y, s] of Object.entries(ys)) stamped[y] = stamp(s);
        next[key] = summariseMapSource(stamped) ?? stamp(src);
      } else next[key] = stamp(src);
    }
    out[FIELD_SOURCES_KEY] = next;
  }
  for (const k of [FIELD_ALTERNATES_KEY, FIELD_CORROBORATIONS_KEY]) {
    const raw = k === FIELD_ALTERNATES_KEY ? getFieldAlternates(info) : getFieldCorroborations(info);
    if (Object.keys(raw).length === 0) continue;
    const next: Record<string, FieldAlternate[]> = {};
    for (const [key, list] of Object.entries(raw)) next[key] = (Array.isArray(list) ? list : []).map((a) => stamp(a));
    out[k] = next;
  }
  return out;
}

/** Kind of a source entry, for callers that only need the kind. */
export type { SourceKind };
