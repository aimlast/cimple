/**
 * extraction-guard.ts
 *
 * Mechanical checks on what the extractor recorded, before any of it can
 * become a fact. The prompt asks for figures exactly as the source prints
 * them; this module enforces it, because the model kept doing arithmetic:
 *
 *   - SDE, EBITDA, add-backs, working capital and margins are DERIVED
 *     figures. A financial statement or tax return almost never prints
 *     them, so the model computed them itself — with definition and
 *     arithmetic errors ("SDE" = EBITDA + owner salary, amortization counted
 *     twice) that went straight onto the CIM cover. A derived figure is now
 *     kept only when the source itself names the metric AND prints the
 *     figure; it is then flagged as stated (see STATED_METRICS_KEY).
 *     Normalisation (SDE / adjusted EBITDA) belongs to the financial
 *     analysis, the seller and the broker — never to extraction.
 *   - Any figure written as a calculation ("calculated as …", "$X + $Y",
 *     "included in $1.4M salaries") is not a stated value and is dropped.
 *   - A count (fleet size, headcount…) that holds only a dollar amount is
 *     the wrong fact ("Motor vehicles valued at $1,318,000" as fleetSize).
 *   - Industry classification codes (NAICS / SIC text from a tax return)
 *     are not the industry: they move to naicsCode.
 *   - A metric acronym the source never uses ("…oil & gas, ebitda
 *     agricultural…") is a model glitch and is removed from narrative text.
 *
 * Pure — no I/O. The extractor applies it to every extraction.
 */

import { SOURCE_META_KEYS } from "../interview/info-merger";

/** Source kinds whose text is speech (figures said in words, not printed). */
export const SPOKEN_KINDS: ReadonlySet<string> = new Set(["call", "video_call", "interview"]);

/** Extraction key listing the derived metrics the source itself printed (comma-separated). */
export const STATED_METRICS_KEY = "_statedMetrics";

/** Note recorded on a fact whose derived figure the source printed. */
export const STATED_METRIC_NOTE = "Stated in the source (not calculated)";

type Extraction = Record<string, unknown>;

/** "sde2024" → ["sde","2024"]; "ATMrevenue" → ["atm","revenue"]; "fy2024Ebitda" → ["fy2024","ebitda"]. */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

interface DerivedMetric {
  name: string;
  /** Matches the key's words (joined by spaces). */
  key: RegExp;
  /** The source must use this term for the figure to count as printed. */
  term: RegExp;
}

const DERIVED_METRICS: DerivedMetric[] = [
  // "ccaDiscretionaryClaim" (a tax-return line) is not SDE — only discretionary earnings / cash flow are.
  { name: "SDE", key: /\bsde\b|\bdiscretionary (?:earnings|cash)|\bsellers? discretionary\b|\bowner'?s? benefit\b/, term: /\bSDE\b|discretionary/i },
  { name: "EBITDA", key: /\bebitda\b|\bebit\b/, term: /\bEBITDA\b|\bEBIT\b/i },
  { name: "add-backs", key: /\badd ?backs?\b|\baddbacks?\b|\bnormali[sz]ation\b|\bnormali[sz]ed\b|\brecast\b/, term: /add[\s-]?backs?|normali[sz]|recast/i },
  { name: "working capital", key: /\bworking capital\b/, term: /working capital/i },
  { name: "margin", key: /\bmargins?\b/, term: /margin/i },
];

/** The derived metric a key names (SDE, EBITDA, add-backs, working capital, margin), or null. */
export function derivedMetricOf(key: string): DerivedMetric | null {
  const joined = keyWords(key).join(" ");
  return DERIVED_METRICS.find((m) => m.key.test(joined)) ?? null;
}

export function isDerivedMetricKey(key: string): boolean {
  return derivedMetricOf(key) !== null;
}

/**
 * Wording that marks a figure as worked out (or not really there) rather
 * than read off the page: "calculated as", "implied", "not separately
 * stated", "included in $…", "= $Z".
 */
const WORKED_OUT_RE =
  /\bcalculat(?:ed|ion|ing)\b|\bcomputed\b|\bderived\b|\bimplied\b|\bnot (?:separately|individually) (?:stated|disclosed|shown|broken out)\b|\bincluded in (?:the )?\$|=\s*\$?\s?\d/i;

/**
 * Arithmetic between figures: "$X + taxes $Y", "$X plus owner salary $Y",
 * "$X / $Y". An amount must follow within a few words — "$9,700 plus HST"
 * is a stated rent, not a sum.
 */
const ARITHMETIC_RE =
  /\$\s?\d[\d,]*(?:\.\d+)?\s?[kmb]?\s*(?:\+|\bplus\b|\bminus\b|\bless\b|−)\s+(?:[A-Za-z'’&()-]+\s+){0,5}\$?\s?\d|\$\s?\d[\d,]*(?:\.\d+)?\s*\/\s*\$\s?\d/i;

/**
 * The narrow form for ordinary facts: only wording that can mean nothing
 * but a worked-out or absent figure. ("Revenue derived from LTC homes",
 * "commission calculated on gross sales" are plain statements.)
 */
const STATED_AS_CALCULATION_RE =
  /\bcalculated (?:as|by|from|using)\b|\(calculated\b|\bcalculation:|\b(?:19|20)\d{2} calculation\b|\bcomputed (?:as|by|from)\b|=\s*\$\s?\d/i;

/** A figure the source doesn't give on its own ("Included in $1,442,300 salaries and wages"). */
const NOT_STATED_RE = /\bnot (?:separately|individually) (?:stated|disclosed|shown|broken out)\b|\bincluded in (?:the )?\$/i;

/** True when the value is written as a calculation rather than a stated figure. */
export function looksComputed(value: string): boolean {
  return WORKED_OUT_RE.test(value) || ARITHMETIC_RE.test(value);
}

/** Keys that are prose about the source or the business (sentences, not one figure). */
const NARRATIVE_KEYS = new Set([
  "summary", "keyFacts", "redFlags", "keyFinancialNotes", "operationsNotes", "employeeNotes", "legalNotes",
  "callNotes", "propertyNotes", "businessDescription", "companyHistory", "competitiveAdvantage", "strengths",
  "growthOpportunities", "targetMarket", "customerBase", "revenueStreams", "keyProducts",
]);

function isNarrative(key: string, value: string): boolean {
  return NARRATIVE_KEYS.has(key) || /Notes$/.test(key) || value.length > 240;
}

/** Terms a sentence must mention for the narrative strip to consider it (a derived-metric computation). */
const DERIVED_TERM_RE = /\bEBITDA\b|\bSDE\b|discretionary|add[\s-]?backs?|working capital|margin|normali[sz]/i;

/** Digits of every amount in `value`, in order ("$1,318,000" → "1318000"; "33.1%" → "33.1"). */
function amountsIn(value: string): string[] {
  const out: string[] = [];
  const re = /\d[\d,]*(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const digits = m[0].replace(/,/g, "");
    // Years and tiny numbers ("2024", "3 years") are not the figure.
    if (/^(19|20)\d{2}$/.test(digits)) continue;
    if (digits.replace(/\D/g, "").length < 2) continue;
    out.push(digits);
  }
  return out;
}

/** The source text with thousands separators and spaces inside numbers removed, for figure lookups. */
function normaliseSourceDigits(text: string): string {
  return text.replace(/(\d)[,\s](?=\d{3}\b)/g, "$1");
}

/** True when the value's leading figure is printed in the source ("$845,252" ↔ "845,252" / "845252"). */
function figurePrinted(value: string, sourceDigits: string): boolean {
  const first = amountsIn(value)[0];
  if (!first) return false;
  const esc = first.replace(".", "\\.");
  if (new RegExp(`(^|[^\\d.])${esc}(?![\\d])`).test(sourceDigits)) return true;
  // "$1.2M" in the value, "1,200,000" in the source.
  const m = value.match(/(\d+(?:\.\d+)?)\s?(k|m|million|thousand)\b/i);
  if (m) {
    const mult = /^m/i.test(m[2]) ? 1_000_000 : 1_000;
    const whole = String(Math.round(parseFloat(m[1]) * mult));
    if (new RegExp(`(^|[^\\d.])${whole}(?![\\d])`).test(sourceDigits)) return true;
  }
  return false;
}

/** True when every figure in `clause` is printed in the source (none worked out). */
function allFiguresPrinted(clause: string, sourceDigits: string): boolean {
  const figures = amountsIn(clause);
  return figures.length > 0 && figures.every((f) => new RegExp(`(^|[^\\d.])${f.replace(".", "\\.")}(?![\\d])`).test(sourceDigits));
}

/** Keys that hold a number of things (vehicles, staff, locations) — never a dollar amount. */
export function isCountKey(key: string): boolean {
  if (/^(employees|totalEmployees|fullTimeCount|partTimeCount|headcount|numberOfLocations|locationCount)$/i.test(key)) return true;
  const words = keyWords(key);
  const last = words[words.length - 1] ?? "";
  if (/^(count|headcount|qty|quantity)$/.test(last)) return true;
  if (words[0] === "number" && words[1] === "of") return true;
  if (last === "size" && /^(fleet|team|staff|crew|workforce|herd|salesforce)$/.test(words[words.length - 2] ?? "")) return true;
  return false;
}

const CURRENCY_AMOUNT_RE =
  /(?:US\$|C\$|CA\$|CAD\s?|USD\s?|[$€£])\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|b|million|thousand|billion)?\b|\d[\d,]*(?:\.\d+)?\s?(?:dollars|CAD|USD)\b/gi;

/** A value whose only figures are money ("Motor vehicles valued at $1,318,000 gross"). */
export function onlyCurrency(value: string): boolean {
  if (!CURRENCY_AMOUNT_RE.test(value)) return false;
  CURRENCY_AMOUNT_RE.lastIndex = 0;
  const rest = value.replace(CURRENCY_AMOUNT_RE, " ");
  CURRENCY_AMOUNT_RE.lastIndex = 0;
  return !/\d/.test(rest);
}

/** Industry classification text from a tax return ("456110 — Pharmacies and drug stores (NAICS)"). */
export function isClassificationCode(value: string): boolean {
  return /\b(NAICS|SIC)\b/i.test(value) || /^\s*\d{4,6}\s*[-–—:]/.test(value);
}

/** Removes a metric acronym the source never uses from prose ("oil & gas, ebitda agricultural"). */
function stripStrayMetricWords(value: string, sourceText: string): string {
  let out = value;
  for (const [word, present] of [
    ["ebitda", /\bEBITDA\b/i],
    ["sde", /\bSDE\b/i],
  ] as const) {
    if (present.test(sourceText)) continue;
    out = out.replace(new RegExp(`\\s*\\b${word}\\b\\s*`, "gi"), " ");
  }
  return out.replace(/\s+([,.;])/g, "$1").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").trim();
}

/** Drops sentences of prose that work out a derived metric ("EBITDA calculated as net income + …"). */
function stripComputedSentences(value: string): string {
  const sentences = value.split(/(?<=[.!?;])\s+/);
  const kept = sentences.filter((s) => !(looksComputed(s) && DERIVED_TERM_RE.test(s)));
  return kept.length === sentences.length ? value : kept.join(" ").trim();
}

export interface GuardResult {
  data: Extraction;
  /** Derived-metric keys the source itself printed (kept, flagged as stated). */
  stated: string[];
  /** What was removed and why (for logs and tests). */
  dropped: Array<{ key: string; reason: string }>;
}

/**
 * Applies the rules above to one extraction. `sourceText` is the text the
 * extraction was read from; without it (a stored extraction replayed) the
 * checks that need it fall back to the wording rules alone, and a derived
 * figure with nothing to check it against is not kept.
 */
export function guardExtraction(
  input: Extraction,
  sourceText?: string | null,
  /**
   * A spoken source (a call or video-call transcript): the seller names the
   * metric but says the figure in words ("about seven-eighty"), so the
   * figure isn't matched against the text — a calculation is still dropped.
   */
  opts: { spoken?: boolean } = {},
): GuardResult {
  const data: Extraction = {};
  const stated: string[] = [];
  const dropped: GuardResult["dropped"] = [];
  const text = typeof sourceText === "string" ? sourceText : "";
  const sourceDigits = normaliseSourceDigits(text);

  for (const [key, raw] of Object.entries(input)) {
    // Bookkeeping, private notes and the per-year revenue map pass through
    // (the revenue map's own rules live in the merge).
    if (key.startsWith("_") || typeof raw !== "string") {
      data[key] = raw;
      continue;
    }
    let value = raw.trim();
    if (!value) continue;

    const metric = derivedMetricOf(key);
    if (metric) {
      if (!text) {
        dropped.push({ key, reason: `${metric.name}: no source text to check it against` });
        continue;
      }
      if (!metric.term.test(text)) {
        dropped.push({ key, reason: `${metric.name}: the source never names it — a calculated figure` });
        continue;
      }
      if (opts.spoken ? looksComputed(value) : amountsIn(value).length > 0 && !figurePrinted(value, sourceDigits)) {
        dropped.push({ key, reason: opts.spoken ? `${metric.name}: written as a calculation` : `${metric.name}: the figure is not printed in the source` });
        continue;
      }
      if (amountsIn(value).length === 0 && looksComputed(value)) {
        dropped.push({ key, reason: `${metric.name}: written as a calculation` });
        continue;
      }
      data[key] = value;
      stated.push(key);
      continue;
    }

    if (SOURCE_META_KEYS.has(key)) {
      // The source's own summary / key facts / red flags: shown on the source,
      // never merged as deal facts — kept whole.
    } else if (isNarrative(key, value)) {
      value = stripComputedSentences(value);
    } else if (
      NOT_STATED_RE.test(value.split(/;\s|\.\s/)[0]) ||
      // A calculation counts as stated when the source prints it that way
      // (a lease reading "$11.50 per sq ft = $322,000 per annum").
      (STATED_AS_CALCULATION_RE.test(value.split(/;\s|\.\s/)[0]) && !(text && allFiguresPrinted(value.split(/;\s|\.\s/)[0], sourceDigits)))
    ) {
      // Only when the value's own figure is the calculation: "Due from related
      // parties $330,000; rent … included in $2,433,500" is a stated fact.
      // An ordinary figure ("Included in $1,442,300 salaries and wages",
      // "Approximately $606,100 (calculated as …)") that the source never
      // states on its own. Plain "+" wording is left alone here: "$9,700
      // plus $1,200 CAM" is how a lease states its rent.
      dropped.push({ key, reason: "written as a calculation, not a stated figure" });
      continue;
    }
    if (text) value = stripStrayMetricWords(value, text);
    if (!value) {
      dropped.push({ key, reason: "nothing left after removing calculations" });
      continue;
    }

    if (isCountKey(key) && onlyCurrency(value)) {
      dropped.push({ key, reason: "a count holding a dollar amount" });
      continue;
    }

    if ((key === "industry" || key === "businessType" || key === "subIndustry") && isClassificationCode(value)) {
      if (data.naicsCode === undefined && input.naicsCode === undefined) data.naicsCode = value;
      dropped.push({ key, reason: "classification code → naicsCode" });
      continue;
    }

    data[key] = value;
  }

  if (stated.length > 0) data[STATED_METRICS_KEY] = stated.join(",");
  return { data, stated, dropped };
}

/** The derived-metric keys an extraction recorded as printed in its source. */
export function statedMetricKeys(extraction: Extraction): string[] {
  const raw = extraction[STATED_METRICS_KEY];
  return typeof raw === "string" ? raw.split(",").map((k) => k.trim()).filter(Boolean) : [];
}
