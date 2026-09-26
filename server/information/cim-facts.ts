/**
 * The deal's facts as the CIM writers may use them.
 *
 * - Only real business facts: "_" bookkeeping (provenance, broker-private
 *   notes) and per-source notes (a source's summary, red flags, the seller's
 *   worries, the broker's to-dos — SOURCE_META_KEYS) are never CIM input.
 * - Split by provenance, year by year for by-year maps: facts from the
 *   seller, the broker, the intake form, documents, emails and call
 *   transcripts are the fact base; facts only the business's website or
 *   social media asserted are UNCONFIRMED LEADS until the seller or broker
 *   confirms them (a website claim the broker accepted into the facts is a
 *   fact).
 * - Never CIM input at all: anything a broker-only source asserted (the
 *   broker's CRM notes, private emails and files) and broker process data
 *   (referral source, fees, prior approaches) — see isPrivateToBroker.
 */
import {
  getFieldSources,
  isFactKey,
  repairCharIndexedValue,
  yearSource,
  WEBSITE_ACCEPTED_SOURCE_NOTE,
  type FieldSource,
  type SourceKind,
  type SourceRowLookup,
} from "../interview/info-merger";
import {
  isBrokerProcessKey, isPartYearFigure, isPeriodFigure, isUnreviewedFigure, lastStatementsYear, normaliseYearKey, periodYear,
} from "../documents/merge-policy";

/** Note the website "Accept into facts" action writes on the source. */
export const WEBSITE_ACCEPTED_NOTE = WEBSITE_ACCEPTED_SOURCE_NOTE;

/** Source kinds whose facts are leads, not verified facts. */
export const LEAD_SOURCE_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>(["crm", "website", "social"]);

export interface CimFactSplit {
  /** Facts the CIM may state as fact. */
  confirmed: Array<[string, unknown]>;
  /** Facts only a CRM note, the website or social media asserted. */
  leads: Array<[string, unknown]>;
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/**
 * The broker accepted this value into the facts ("Accept into facts" on a
 * website claim). Rows written before the flag existed are recognised by the
 * note the accept action has always written.
 */
export function brokerAcceptedSource(src: FieldSource | undefined): boolean {
  if (!src) return false;
  return src.acceptedByBroker === true || (src.source === "website" && src.note === WEBSITE_ACCEPTED_NOTE);
}

/**
 * True when a source must never reach a CIM input (writer, DD, redaction):
 * it came from a broker-only row (a CRM note, a private email or file —
 * FieldSource.brokerOnly, stamped at merge time from documents.visibility;
 * pass `brokerOnlyDocIds` for rows written before the stamp), or it is a
 * CRM note not known to be shared. The broker's CRM notes are their own
 * working notes — not even an "unconfirmed lead" for the writer. A value
 * the broker accepted into the facts is theirs, and stays.
 */
export function isPrivateToBroker(src: Partial<FieldSource> | null | undefined, brokerOnlyDocIds?: ReadonlySet<string>): boolean {
  if (!src) return false;
  if (brokerAcceptedSource(src as FieldSource)) return false;
  if (src.brokerOnly === true) return true;
  if (src.documentId && brokerOnlyDocIds?.has(src.documentId)) return true;
  return src.source === "crm" && src.brokerOnly !== false;
}

/** True for a public lead (website / social) the broker hasn't vouched for. */
function isLeadSource(src: Partial<FieldSource> | null | undefined): boolean {
  return !!src && LEAD_SOURCE_KINDS.has(src.source as SourceKind) && !brokerAcceptedSource(src as FieldSource);
}

/**
 * True when the fact's recorded source is a lead (CRM / website / social)
 * that the broker hasn't vouched for, or a broker-only source — never a
 * canonical figure.
 */
export function isLeadFact(info: Record<string, unknown>, key: string): boolean {
  const src = getFieldSources(info)[key];
  if (!src) return false;
  if (isPrivateToBroker(src)) return true;
  return LEAD_SOURCE_KINDS.has(src.source) && !brokerAcceptedSource(src);
}

export interface CimFactOptions {
  /** documents rows that are broker-only (for sources written before FieldSource.brokerOnly existed). */
  brokerOnlyDocIds?: ReadonlySet<string>;
  /** Resolves older bare-id year entries to their row's kind / visibility. */
  lookup?: SourceRowLookup;
}

/**
 * A by-year map holds fiscal years' reported figures only — never a quarter,
 * a run-rate or an unreviewed number (the merge moves those to their own
 * facts; this catches any that slipped onto a map another way).
 */
function fiscalYearsOnly(key: string, value: unknown): unknown {
  if (!/ByYear$/.test(key) || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [y, v] of Object.entries(value as Record<string, unknown>)) {
    if (normaliseYearKey(y) === null) continue;
    if (typeof v === "string" && (isPartYearFigure(v) || isUnreviewedFigure(v))) continue;
    out[y] = v;
  }
  return out;
}

/** "Not recorded as yearly figures — revenue: 2025: about $31.8M (management numbers, not reviewed); …" (older reads). */
const YEAR_NOTE_LINE = /^Not recorded as yearly figures\s*[—-]\s*/;
const FORECAST_WORDS = /\b(?:budget(?:ed)?|projected|projections?|forecast|target|expected|plan(?:ned)?|pro ?forma)\b/i;

/**
 * Older reads filed a year's forecast or unreviewed management number in a
 * note ("Not recorded as yearly figures — revenue: 2025: about $31.8 million
 * (management numbers, not reviewed)"): such an entry is never CIM input.
 */
function withoutUnreviewedYearNotes(value: unknown): unknown {
  if (typeof value !== "string" || !/Not recorded as yearly figures/.test(value)) return value;
  const lines = value.split("\n").flatMap((line) => {
    if (!YEAR_NOTE_LINE.test(line)) return [line];
    const entries = line.replace(YEAR_NOTE_LINE, "").split(/;\s+/)
      .filter((e) => !(isUnreviewedFigure(e) || FORECAST_WORDS.test(e) || isPartYearFigure(e)));
    const unique = Array.from(new Set(entries));
    return unique.length > 0 ? [`Not recorded as yearly figures — ${unique.join("; ")}`] : [];
  });
  return Array.from(new Set(lines)).join("\n").trim();
}

/** Figures for a period by name, beyond the statement lines (donations, salaries, fees…). */
const FLOW_FIGURE = /donation|salar|compensation|wages?|fees?$|amorti[sz]ation|dividend|bonus|commission|contribution|purchases|charges?$|insurance|rental|interest(?:Expense|Paid|Income)/i;

/** A money figure (not prose that mentions one). */
const ONE_FIGURE = /^[^;:.]{0,40}\$\s?\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|million|thousand|b|billion)?\b[^;:]{0,60}$/i;

/**
 * A stand-alone figure a document gives for an OLDER fiscal year than the
 * last one the statements cover ("Total operating expenses $7,797,500" from
 * the 2023 tax return, FY2024 statements on file) says which year it is —
 * "$7,797,500 (FY2023)" — so the writer never states it as current.
 */
function datedIfOlder(key: string, value: unknown, src: FieldSource | undefined, statementsYear: string | undefined): unknown {
  if (!statementsYear || typeof value !== "string" || !src || src.source !== "document") return value;
  // (A value that names its own year or years says which period it is.)
  if (!(isPeriodFigure(key) || FLOW_FIGURE.test(key)) || !ONE_FIGURE.test(value.trim()) || /\b(?:19|20)\d{2}\b/.test(value)) return value;
  const year = periodYear(src.period);
  return year && year < statementsYear ? `${value.trim()} (FY${year})` : value;
}

/**
 * The deal's facts as CIM input:
 * - broker process data (referral source, fees, prior approaches) is never CIM input;
 * - a fact (or one year of a by-year map) from a broker-only source or a
 *   CRM note is left out entirely — never sent even as a lead;
 * - website / social facts are UNCONFIRMED LEADS;
 * - by-year maps split year by year on each year's own source, so a
 *   CRM or broker-only year inside a map of statement figures never counts
 *   as confirmed.
 */
export function splitFactsForCim(info: Record<string, unknown> | null | undefined, opts: CimFactOptions = {}): CimFactSplit {
  const out: CimFactSplit = { confirmed: [], leads: [] };
  if (!info) return out;
  const sources = getFieldSources(info);
  const statementsYear = lastStatementsYear(info, { lookup: opts.lookup });
  for (const [key, raw] of Object.entries(info)) {
    if (!isFactKey(key) || isBrokerProcessKey(key)) continue;
    const value = datedIfOlder(key, withoutUnreviewedYearNotes(fiscalYearsOnly(key, repairCharIndexedValue(raw))), sources[key], statementsYear);
    if (!hasValue(value)) continue;
    const src = sources[key];
    if (src?.years && value && typeof value === "object" && !Array.isArray(value)) {
      const confirmed: Record<string, unknown> = {};
      const leads: Record<string, unknown> = {};
      for (const [y, v] of Object.entries(value as Record<string, unknown>)) {
        const ys = yearSource(src, y, opts.lookup);
        if (isPrivateToBroker(ys, opts.brokerOnlyDocIds)) continue;
        (isLeadSource(ys) ? leads : confirmed)[y] = v;
      }
      if (Object.keys(confirmed).length > 0) out.confirmed.push([key, confirmed]);
      if (Object.keys(leads).length > 0) out.leads.push([key, leads]);
      continue;
    }
    if (isPrivateToBroker(src, opts.brokerOnlyDocIds)) continue;
    (isLeadSource(src) ? out.leads : out.confirmed).push([key, value]);
  }
  return out;
}

/**
 * The deal's facts with everything a CIM must never see removed (see
 * splitFactsForCim) — leads kept, in place. For CIM paths that read the
 * facts object directly (DD enrichment, canonical figures).
 */
export function cimSafeFacts(info: Record<string, unknown> | null | undefined, opts: CimFactOptions = {}): Record<string, unknown> {
  if (!info) return {};
  const { confirmed, leads } = splitFactsForCim(info, opts);
  const out: Record<string, unknown> = {};
  for (const [k, v] of confirmed) out[k] = v;
  for (const [k, v] of leads) {
    out[k] = out[k] && typeof out[k] === "object" && typeof v === "object" ? { ...(out[k] as object), ...(v as object) } : out[k] ?? v;
  }
  for (const [k, v] of Object.entries(info)) if (k.startsWith("_")) out[k] = v;
  return out;
}

/** A fact value as prompt text — maps as "2023: $1.7M · 2024: $1.9M", never "[object Object]". */
export function factValueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(factValueText).filter(Boolean).join("; ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${factValueText(v)}`)
      .join(" · ");
  }
  return String(value);
}

/** Heading + instruction for the leads block, shared by both CIM writers. */
export const CIM_LEADS_HEADING =
  "UNCONFIRMED LEADS (from the business's website or social media — NOT confirmed by the seller). " +
  "Never state these as fact and never use them as figures. Use one only as soft context consistent with the confirmed data, " +
  "or leave it out; if a section depends on one, say it is to be confirmed.";
