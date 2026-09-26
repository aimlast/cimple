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

/** The formal statements: compiled, reviewed or audited financial statements. */
const FORMAL_STATEMENTS = /financial statements?|compil(?:ed|ation)|review engagement|audited|notice to reader/i;
/** A statement by its name (an internal P&L or balance sheet). */
const STATEMENT_TITLE = /income statement|balance sheet|profit (?:and|&) loss|\bp&l\b|statement of (?:operations|earnings|income)/i;
/**
 * A management report that has a P&L inside it ("Payer mix, location P&L,
 * seasonality and AR report", a budget, a KPI pack, a per-location P&L) is
 * not the statements: its "net income" is often a location's, a segment's
 * or a pre-tax figure.
 */
const MANAGEMENT_REPORT = /\b(?:management report|analysis|mix|dashboard|kpis?|budget|forecast|projections?|pro ?forma|segment(?:ed|s)?|locations?|by (?:clinic|location|site|segment|customer|payer|department|division|region|month|service)|departmental|management accounts?|pack|monthly|quarterly|ytd|detail|volumes?)\b/i;

/**
 * True when a source's title names the business's own book-figure
 * statements. The title's first part is the source's own name: a name that
 * says it is a management report ("Payer mix & monthly volumes FY2024")
 * decides, whatever the reader called the document type.
 */
function isStatementsTitle(title: string): boolean {
  const parts = title.split(/\s+·\s+/);
  if (MANAGEMENT_REPORT.test(parts[0] ?? "")) return false;
  return parts.some((part) => (FORMAL_STATEMENTS.test(part) || STATEMENT_TITLE.test(part)) && !MANAGEMENT_REPORT.test(part));
}

/** A dedicated source for a fact: [fact key pattern, source title pattern or test]. */
const SPECIALIST_SOURCES: Array<[RegExp, RegExp | ((title: string) => boolean)]> = [
  // Book figures: the financial statements, not a tax return's version of them
  // and not a management report that happens to contain a P&L.
  [/^(annualRevenue|revenueByYear|grossProfit\w*|grossMargin|netIncome\w*|netProfit|operatingIncome|operatingExpenses|cogs|costOfGoodsSold|costOfSales|ebitda\w*|accountsReceivable\w*|accountsPayable\w*|inventor\w*|totalAssets\w*|totalLiabilities\w*|currentAssets\w*|otherCurrentAssets\w*|currentLiabilities\w*|longTermDebt\w*|retainedEarnings\w*|shareholdersEquity\w*|depreciation\w*|cash\w*)$/,
    isStatementsTitle],
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
  return SPECIALIST_SOURCES.some(([k, t]) => k.test(key) && (typeof t === "function" ? t(sourceTitle) : t.test(sourceTitle)));
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

/**
 * True when a year's value says it is not that fiscal year's actual figure:
 * a budget, forecast or target, a run-rate / ARR / MRR / annualised figure,
 * a year-to-date, quarter or part-year figure.
 */
export function isNotFiscalYearFigure(value: string): boolean {
  return /\b(?:budget(?:ed)?|projected|projection|forecast|target|run[- ]?rate|arr|mrr|expected|plan(?:ned)?|pro ?forma|ytd|year[- ]to[- ]date|to date|annuali[sz](?:ed|ing)|trailing|ttm|ltm|interim|partial|stub|q[1-4]|quarter(?:ly)?|first half|h[12]|\d+ months?|monthly)\b/i.test(value);
}

/** Part of the business ("$6.8M (Alderbrook only)") — not the year's total. */
export function isSubsetFigure(value: string): boolean {
  return /\b(?:only|alone|segment|division|client|customer)\b/i.test(value);
}

/** Metrics measured in money (a year's value must state an amount); margins and counts are not. */
const MONEY_METRIC = /revenue|sales|profit|income|ebitda|sde|earnings|cash|receivable|payable|assets?|liabilit|debt|expense|cost|payroll|wage|rent|inventor|equity/i;

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
    const notActual = isNotFiscalYearFigure(value);
    // Part of the business ("$6.8M (Alderbrook only)") is not the year's total.
    const subset = isSubsetFigure(value);
    // A figure the reader worked out ("implied from 6.5% growth") is never a year's figure.
    // A money metric needs an amount ("trending up 2-3%" is not a year's revenue).
    const noAmount = MONEY_METRIC.test(metric) && !typedNumericValues(value).some((t) => t.kind === "currency");
    if (!year || clean.value === null || clean.inferred || !/\d/.test(value) || noAmount || otherMetric || notActual || subset) {
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

/** Words that may lead a year inside a period tag: "year ended December 31, ", "fiscal ", "FYE ". */
const PERIOD_LEAD = String.raw`(?:(?:fiscal(?:\s+year)?|fye?|ye|years?\s+end(?:ed|ing)|period\s+end(?:ed|ing)|for)\s*)?(?:[a-z]+\.?\s+\d{1,2},?\s*)?`;

/**
 * A headline figure that lists several years ("$3,082,400 (2023), $2,780,200
 * (2022)", "2024: $2.1M; 2023: $1.9M") → the per-year map, else null.
 */
export function splitMultiYearValue(value: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const amount = String.raw`\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|million|thousand|b|billion)?`;
  const yearTag = String.raw`(?:fy\s*)?((?:19|20)\d{2})`;
  // "(2023)", "(FY2024 adjusted)", "(year ended December 31, 2023)", "(2023 calculation: …)".
  const reAfter = new RegExp(`(${amount})\\s*\\(\\s*${PERIOD_LEAD}${yearTag}[^)]*\\)`, "gi");
  const reBefore = new RegExp(`${yearTag}\\s*[:=–—-]\\s*(${amount})`, "gi");
  // "$6,105,400 in 2024, $5,311,310 in 2023" (dollar figures only).
  const reIn = new RegExp(`(\\$\\s*\\d[\\d,]*(?:\\.\\d+)?\\s*(?:k|m|mm|million|thousand|b|billion)?)\\s+(?:in|for)\\s+${yearTag}\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = reAfter.exec(value)) !== null) if (!out[m[2]]) out[m[2]] = m[1].trim();
  while ((m = reBefore.exec(value)) !== null) if (!out[m[1]]) out[m[1]] = m[2].trim();
  while ((m = reIn.exec(value)) !== null) if (!out[m[2]]) out[m[2]] = m[1].trim();
  return Object.keys(out).length >= 2 ? out : null;
}

/** "$31,020,000 (FY2024)" → { value: "$31,020,000", year: "2024" }; otherwise the value unchanged. */
export function stripYearTag(value: string): { value: string; year?: string } {
  const m = value.match(new RegExp(String.raw`^\s*(\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|million|thousand|b|billion)?)\s*\(\s*${PERIOD_LEAD}(?:fy\s*)?((?:19|20)\d{2})\s*\)\s*$`, "i"));
  return m ? { value: m[1].trim(), year: m[2] } : { value };
}

/**
 * A figure that OPENS with its amount and year and then explains itself
 * ("$426,100 (FY2024) - ties to compiled statements: …") → the amount and
 * the year; undefined otherwise.
 */
export function leadingYearFigure(value: string): { amount: string; year: string } | undefined {
  const m = value.match(new RegExp(String.raw`^\s*(\$\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|million|thousand|b|billion)?)\s*\(\s*${PERIOD_LEAD}(?:fy\s*)?((?:19|20)\d{2})\b(?:\s*[,;:–—-][^()]*)?\s*\)`, "i"));
  return m ? { amount: m[1].trim(), year: m[2] } : undefined;
}

/**
 * One labelled figure for one year ("Reported EBITDA 2024: $5,274,900",
 * "EBITDA as reported $5,274,900 in 2024", "about $6M for 2024") → the year
 * and the figure (a leading "about" / "approximately" kept); null when the
 * text holds more than one dollar figure or more than one year.
 */
export function singleYearFigure(text: string): { year: string; value: string } | null {
  const amounts = text.match(/\$\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|million|thousand|b|billion)?\b/gi) ?? [];
  const years = Array.from(new Set(text.match(/(?<![0-9])(?:19|20)\d{2}(?![0-9])/g) ?? []));
  if (amounts.length !== 1 || years.length !== 1) return null;
  const amount = amounts[0].trim();
  const escaped = amount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hedge = new RegExp(`(?:^|[^A-Za-z])(about|approximately|approx\\.?|roughly|around|~)\\s*${escaped}`, "i").exec(text)?.[1];
  return { year: years[0], value: hedge ? `${hedge} ${amount}` : amount };
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
  // Two different leases (a business with two premises) disagreeing about
  // expiry, rent or size are two leases, not one lease disputed.
  if (/^(?:lease\w*|monthlyRent|annualRent|rent|landlord)$/.test(factKey) && winner.src.specialist && loser.src.specialist &&
      winner.src.source === "document" && loser.src.source === "document") return;
  if (!factYear) {
    // Two sources for different fiscal periods (FY2023 vs FY2024 statements,
    // last year's and this year's tax return) differing is history, not a
    // conflict — the newer period is on file.
    // A figure's year: its source's period, else the year its value names
    // ("$5,487,300 (2023); $4,812,600 (2022)" is a 2023 figure).
    const figureYear = (side: ConflictSide) =>
      periodYear(side.src.period) ?? (isPeriodFigure(factKey) ? valueYear(side.value) : undefined);
    const a = figureYear(winner);
    const b = figureYear(loser);
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

/** An earnings text that gives only the adjusted figure ("$3,900,000 adjusted EBITDA (FY2024)"), not the reported one. */
export function isAdjustedOnly(v: string): boolean {
  return /\b(?:adj\.?|adjusted|normali[sz]ed|pro ?forma|recast)\b/i.test(v) && !/\b(?:reported|unadjusted|actual)\b/i.test(v);
}

/** Reported EBITDA and adjusted EBITDA are two measures of one year, never one fact disputed. */
const EARNINGS_SIBLING: Record<string, { head: string; map: string }> = {
  ebitda: { head: "adjustedEbitda", map: "adjustedEbitdaByYear" },
  ebitdaByYear: { head: "adjustedEbitda", map: "adjustedEbitdaByYear" },
  adjustedEbitda: { head: "ebitda", map: "ebitdaByYear" },
  adjustedEbitdaByYear: { head: "ebitda", map: "ebitdaByYear" },
};

/**
 * True when the losing side of an EBITDA conflict is the OTHER measure on
 * file for that year (a source that called the adjusted figure "EBITDA"):
 * $6,105,400 against the statements' $5,274,900 is the adjusted EBITDA, not
 * a disagreement about reported EBITDA.
 */
function isOtherEarningsMeasure(info: Info, c: MergeConflict, onFile: string = c.winner.value): boolean {
  const sib = EARNINGS_SIBLING[c.factKey];
  if (!sib) return false;
  // One side says it is the adjusted figure and the other doesn't: two measures.
  if (isAdjustedOnly(onFile) !== isAdjustedOnly(c.loser.value)) return true;
  const year = c.factYear ?? periodYear(c.loser.src.period) ?? periodYear(c.winner.src.period);
  const candidates: unknown[] = [];
  const map = repairCharIndexedValue(info[sib.map]);
  if (year && isMap(map)) candidates.push(map[year]);
  const headSrc = getFieldSources(info)[sib.head];
  const headYear = periodYear(headSrc?.period) ?? (typeof info[sib.head] === "string" ? stripYearTag(info[sib.head] as string).year : undefined);
  if (!year || !headYear || headYear === year) candidates.push(info[sib.head]);
  return candidates.some((v) => typeof v === "string" && typedNumericValues(v).some((t) => t.kind === "currency") &&
    typedNumericValues(c.loser.value).some((t) => t.kind === "currency") && !numbersMateriallyConflict(v, c.loser.value, 0.01));
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
    if (isOtherEarningsMeasure(info, c, serial(current))) continue;
    // A lease term another lease on file states (the second premises'):
    // two leases, not one disputed.
    if (/^(?:lease\w*|monthlyRent|annualRent|rent|landlord)$/.test(c.factKey) &&
        (getFieldAlternates(info)[c.factKey] ?? []).some((a) => a.specialist && a.source === "document" &&
          a.documentId !== c.loser.src.documentId && !materiallyDifferent(c.factKey, String(a.value), c.loser.value))) continue;
    // (A figure on file as the broker's that the statements also state is weighed as the statements'.)
    const onFileSrc = currentSrc
      ? creditedSource(info, c.factKey, c.factYear && (isYearMapKey(c.factKey) || !mapKey) ? `${c.factKey}.${c.factYear}` : c.factKey, serial(current), currentSrc)
      : c.winner.src;
    const winner: ConflictSide = { value: serial(current), src: onFileSrc };
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

/** Lead kinds: second-hand or public figures, never a headline next to a firm one. */
const HEADLINE_LEAD_KINDS: ReadonlySet<string> = new Set(["crm", "website", "social"]);
// A broker-only value the broker vouched for (a discrepancy settled on the
// broker's own figure: brokerOnly + acceptedByBroker) is private from the
// seller, but a firm figure — not a lead.
const isLeadSource = (s: Partial<FieldSource> | null | undefined) =>
  !!s && ((!!s.brokerOnly && !s.acceptedByBroker) || HEADLINE_LEAD_KINDS.has(String(s.source)));
const isYearKey = (y: string) => /^(?:19|20)\d{2}$/.test(y);
/**
 * A source that closes a fiscal year's figure for the headline: a written
 * record (the statements, a management report), the seller live in the
 * interview, the broker. A call, email or the questionnaire gives the year's
 * figure, but not the headline while a written year one year older exists.
 */
function isClosedYearSource(head: string, src: Partial<FieldSource> | null | undefined): boolean {
  if (!src || isUntrackedSource(src)) return false;
  return src.source === "document" || src.source === "interview" || src.source === "broker" ||
    effectiveRank(head, src) >= DOCUMENT_AUTHORITY_RANK;
}
/** A year's figure its source calls unfinished: an estimate, preliminary, pending, not final. */
const PRELIMINARY_FIGURE = /\b(?:estimate[ds]?|estimated|preliminary|pending|not (?:yet )?final|draft|provisional|unreviewed|before year[- ]end)\b/i;
const firstCurrency = (v: unknown) =>
  typeof v === "string" ? typedNumericValues(v).find((t) => t.kind === "currency")?.value : undefined;

/**
 * The fiscal year a figure's own words give it: a "(FY2024)" tag, the latest
 * year of a multi-year string, or a year named before its first amount
 * ("FY2024 reported EBITDA $1,199,100 (FY2023 $920,600)" → 2024).
 */
export function valueYear(value: string): string | undefined {
  const tagged = stripYearTag(value).year;
  if (tagged) return tagged;
  const multi = splitMultiYearValue(value);
  if (multi) return Object.keys(multi).sort(compareYearKeysDesc)[0];
  const opening = leadingYearFigure(value); // "$690,000 (FY2024, after add-backs); FY2023 $600,800"
  if (opening) return opening.year;
  const lead = value.match(/^[^$\d]*?\b(?:fy\s*)?((?:19|20)\d{2})\b[^$\d]*\$\s*\d/i);
  return lead?.[1];
}

/**
 * The fiscal year a headline value on file is for: its source's period, a
 * "(FY2024)" tag, the latest year a multi-year string lists, or the year of
 * the by-year map whose figure it is. Undefined when nothing says.
 */
export function headlineYearOnFile(
  value: unknown,
  src: Partial<FieldSource> | null | undefined,
  map: Record<string, unknown>,
): string | undefined {
  const fromPeriod = periodYear(src?.period);
  if (fromPeriod) return fromPeriod;
  if (typeof value !== "string") return undefined;
  const named = valueYear(value);
  if (named) return named;
  const n = firstCurrency(value);
  const same = Object.keys(map)
    .filter((y) => isYearKey(y) && (String(map[y]) === value || (n !== undefined && firstCurrency(map[y]) === n)))
    .sort(compareYearKeysDesc);
  return same[0];
}

/**
 * Lines each headline figure (annualRevenue, sde, ebitda, …) up with its
 * by-year map. The headline is the LATEST fiscal year's figure:
 *  - only full fiscal-year figures count — never a run-rate, ARR / MRR,
 *    year-to-date, budget or part-of-the-business figure, never an interim
 *    period; CRM, website and broker-only years only when no other year
 *    exists (and never over a firm headline);
 *  - only the latest such year is weighed — an older year never replaces
 *    the headline however strong its source (the broker choosing a value
 *    for 2022 makes it 2022's figure, not the headline); a year's final
 *    figure beats a newer year's estimate, and a figure only spoken (a
 *    call, an email) for the year right after the last written one (the
 *    statements) stays that year's figure, not the headline;
 *  - a headline on file for an OLDER year (its period, a "(2023)" tag, the
 *    latest year it lists, or the map year it equals) gives way to the newer
 *    year and is kept as another value — two periods, not a conflict;
 *  - for the same year, or when nothing says the headline's year, authority
 *    decides (outranksFor) and a material difference is a conflict.
 * The headline carries its year's source and period — except that a year
 * recorded as the broker's (older maps labelled the broker's as a whole)
 * whose figure a source row also states is credited to that row, so the
 * headline never reads "Broker edit" for a figure the statements give.
 * Also keeps yearsOfData in step with the fiscal years the documents cover.
 */
export function reconcileHeadlines(info: Info, ctx: MergeContext = {}): void {
  for (const { head, map: mapKey } of HEADLINE_MAPS) {
    if (isSuppressed(info, head)) continue;
    const sources = getFieldSources(info);
    const map = repairCharIndexedValue(info[mapKey]);
    if (!isMap(map)) continue;
    const recorded = sources[mapKey];
    if (!recorded || isUntrackedSource(recorded)) continue; // an untracked map says nothing about its years
    const ys = resolvedYearSources(recorded, map, ctx.lookup);
    const interim = new Set(interimYears(ys));
    const eligible = Object.keys(map).filter((y) => {
      const v = map[y];
      const s = ys[y];
      return isYearKey(y) && !interim.has(y) && typeof v === "string" && firstCurrency(v) !== undefined &&
        !isNotFiscalYearFigure(v) && !isSubsetFigure(v) && cleanExtractedValue(v).value !== null &&
        !!s && !isUntrackedSource(s) && !s.valueInferred;
    });
    const firm = eligible.filter((y) => !isLeadSource(ys[y]));
    // A year's final figure beats a newer year's estimate ("$3.45M (unaudited
    // management estimate, pending compilation)") for the headline.
    const final = firm.filter((y) => !PRELIMINARY_FIGURE.test(map[y] as string));
    const current = info[head];
    const curSrc = sources[head];
    const empty = current === null || current === undefined || current === "";
    // Lead years stand in only while the headline is empty or itself a lead.
    const pool = final.length > 0 ? final : firm.length > 0 ? firm : empty || isLeadSource(curSrc) ? eligible : [];
    if (pool.length === 0) continue;
    // The last year the statements (or the seller live, or the broker) give
    // is the headline; a spoken figure for the year after it (statements not
    // out yet — "2025 came in around $31.8M") stays that year's figure. A
    // spoken figure two or more years newer than any statement stands.
    const sorted = [...pool].sort(compareYearKeysDesc);
    const closedYear = sorted.find((y) => isClosedYearSource(head, ys[y]));
    const year = closedYear && Number(sorted[0]) - Number(closedYear) <= 1 ? closedYear : sorted[0];
    const value = map[year] as string;
    const fye = Object.values(ys).find((s) => s.period && /^\d{4}-\d{2}-\d{2}$/.test(s.period))?.period;
    const bestSrc = headlineSourceForYear(info, mapKey, year, value, ys[year], periodForYear(year, fye));
    if (empty) {
      info[head] = value;
      setFieldSource(info, head, bestSrc);
      continue;
    }
    if (String(current) === value) continue;
    const curYear = headlineYearOnFile(current, curSrc, map);
    if (curYear && year < curYear) {
      // Never step back to an older year — except that a spoken figure for
      // the year after the last statements yields to the statements' year.
      const yieldsToStatements = !isClosedYearSource(head, curSrc) && isClosedYearSource(head, bestSrc) &&
        Number(curYear) - Number(year) <= 1;
      if (!yieldsToStatements) continue;
      recordAlternate(info, head, current, curSrc ?? LEGACY);
      info[head] = value;
      setFieldSource(info, head, bestSrc);
      displaceCorroborations(info, head, value);
      continue;
    }
    // A headline that lists several years ("$3,082,400 (2023), $2,780,200
    // (2022)", the older format) gives way to its latest year's own figure.
    const listsYears = typeof current === "string" && splitMultiYearValue(current) !== null;
    if (curYear && (year > curYear || (listsYears && year === curYear))) {
      // A newer fiscal year: the headline moves to it; the older figure is
      // another period's, kept as another value — not a conflict.
      recordAlternate(info, head, current, curSrc ?? LEGACY);
      info[head] = value;
      setFieldSource(info, head, bestSrc);
      displaceCorroborations(info, head, value);
      continue;
    }
    // The same year, or the headline's year unknown: authority decides.
    const curSide: ConflictSide = { value: serial(current), src: { ...(curSrc ?? LEGACY), period: curSrc?.period ?? `${year}-12-31` } };
    if (outranksFor(head, bestSrc, curSrc)) {
      recordAlternate(info, head, current, curSrc ?? LEGACY);
      info[head] = value;
      setFieldSource(info, head, bestSrc);
      displaceCorroborations(info, head, value);
      noteConflict(ctx, head, year, { value, src: bestSrc }, curSide);
    } else {
      noteConflict(ctx, head, year, curSide, { value, src: bestSrc });
    }
  }
  reconcileYearsOfData(info, ctx);
}

/**
 * The source a headline taken from `mapKey`'s `year` records: the year's own
 * source with the year's period. A broker-kind year whose same figure a
 * source row also states (a corroboration) is credited to the strongest such
 * row instead — older maps were labelled the broker's as a whole, and a
 * statement's figure should read as the statement's.
 */
function headlineSourceForYear(
  info: Info,
  mapKey: string,
  year: string,
  value: string,
  yearSrc: FieldSource,
  period: string,
): FieldSource {
  const own = creditedSource(info, mapKey, `${mapKey}.${year}`, value, yearSrc);
  return { ...own, period: own.period ?? period };
}

/**
 * The source a value on file is credited to: its own — except that a value
 * recorded as the broker's (older maps were labelled the broker's as a
 * whole) that a source row also states (a corroboration under `corrKey`)
 * is credited to the strongest such row.
 */
function creditedSource(info: Info, key: string, corrKey: string, value: string, src: FieldSource): FieldSource {
  const { years: _y, ...own } = src;
  if (own.source !== "broker") return own;
  const rows = (getFieldCorroborations(info)[corrKey] ?? [])
    .filter((c) => c && c.documentId && c.source !== "broker" && String(c.value) === value && !isLeadSource(c))
    .sort((a, b) => effectiveRank(key, b) - effectiveRank(key, a));
  if (rows.length === 0) return own;
  const { value: _v, years: _yy, ...row } = rows[0];
  return row;
}

// ─── Years of financials ─────────────────────────────────────────────────────

/** Note on a yearsOfData value counted from the documents' fiscal years. */
export const YEARS_OF_DATA_NOTE = "Counted from the fiscal years in the financial documents";

/** "3 years (2022–2024)", "1 year (2024)", "3 years (2021, 2023, 2024)". */
export function describeFiscalYears(years: string[]): string {
  const ys = Array.from(new Set(years)).sort();
  if (ys.length === 1) return `1 year (${ys[0]})`;
  const contiguous = ys.every((y, i) => i === 0 || Number(y) === Number(ys[i - 1]) + 1);
  return `${ys.length} years (${contiguous ? `${ys[0]}–${ys[ys.length - 1]}` : ys.join(", ")})`;
}

/**
 * yearsOfData ("Years of financials provided") follows the fiscal years the
 * financial documents on file cover — "3 years (2022–2024)" — instead of the
 * last statement's own "2 years" wording. Only shared document years count
 * (not CRM, email or broker-only rows, not interim periods). The broker's
 * own value and the seller's live answer stand; any other value is
 * replaced. Documents' own counts ("2", "2 years (2023 and 2024)") are
 * dropped from the other values — the count covers them.
 */
function reconcileYearsOfData(info: Info, ctx: MergeContext): void {
  const key = "yearsOfData";
  if (isSuppressed(info, key)) return;
  const sources = getFieldSources(info);
  const found = new Map<string, FieldSource>();
  for (const [mapKey, raw] of Object.entries(info)) {
    if (mapKey.startsWith("_") || !isYearMapKey(mapKey) || !isPeriodFigure(mapKey.replace(/ByYear$/, ""))) continue;
    const map = repairCharIndexedValue(raw);
    const rec = sources[mapKey];
    if (!isMap(map) || !rec) continue;
    const ys = resolvedYearSources(rec, map, ctx.lookup);
    const interim = new Set(interimYears(ys));
    for (const [y, s] of Object.entries(ys)) {
      const v = map[y];
      if (!isYearKey(y) || interim.has(y) || s.source !== "document" || s.brokerOnly || !s.documentId) continue;
      if (typeof v !== "string" || !/\d/.test(v) || isNotFiscalYearFigure(v)) continue;
      if (!found.has(y)) found.set(y, s);
    }
  }
  if (found.size === 0) return;
  const years = Array.from(found.keys()).sort(compareYearKeysDesc);
  const derived = describeFiscalYears(years);
  const current = info[key];
  const curSrc = sources[key];
  if (curSrc && (curSrc.source === "broker" || curSrc.source === "interview") && current !== undefined && current !== null && current !== "") return;
  if (current !== derived) {
    const latest = found.get(years[0])!;
    const { years: _y, specialist: _s, valueInferred: _v, ...latestSrc } = latest;
    if (current !== undefined && current !== null && current !== "" && curSrc?.source !== "document") {
      recordAlternate(info, key, current, curSrc ?? LEGACY);
    }
    info[key] = derived;
    setFieldSource(info, key, { ...latestSrc, at: new Date().toISOString(), note: YEARS_OF_DATA_NOTE });
    displaceCorroborations(info, key, derived);
  }
  const alts = getFieldAlternates(info);
  if (alts[key]) {
    const kept = alts[key].filter((a) => a.source !== "document");
    const next = { ...alts };
    if (kept.length > 0) next[key] = kept;
    else delete next[key];
    info[FIELD_ALTERNATES_KEY] = next;
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
