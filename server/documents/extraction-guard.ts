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

import { SOURCE_META_KEYS, spelledNumbers, typedNumericValues } from "../interview/info-merger";
import { mentionsPrivateMatter } from "../interview/questionnaire-privacy";
import { businessFactForNote, noteRecordedAsFact } from "@shared/private-notes";

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
  /** Every figure in the value must be printed (a ratio or growth rate worked out from printed figures is not). */
  allFigures?: boolean;
}

const DERIVED_METRICS: DerivedMetric[] = [
  // "ccaDiscretionaryClaim" (a tax-return line) is not SDE — only discretionary earnings / cash flow are.
  { name: "SDE", key: /\bsde\b|\bdiscretionary (?:earnings|cash)|\bsellers? discretionary\b|\bowner'?s? benefit\b/, term: /\bSDE\b|discretionary/i },
  // A seller on a call spells it out: "earnings before interest, amortization and tax".
  { name: "EBITDA", key: /\bebitda\b|\bebit\b/, term: /\bEBITDA\b|\bEBIT\b|\bearnings before interest\b[^.;\n]{0,80}?\b(?:tax(?:es)?|depreciation|amorti[sz]ation)\b/i },
  { name: "add-backs", key: /\badd ?backs?\b|\baddbacks?\b|\bnormali[sz]ation\b|\bnormali[sz]ed\b|\brecast\b/, term: /add[\s-]?backs?|normali[sz]|recast/i },
  { name: "working capital", key: /\bworking capital\b/, term: /working capital/i },
  { name: "margin", key: /\bmargins?\b/, term: /margin/i },
  // Growth rates and ratios ("revenueGrowthRate", "debtToEquityRatio"), not "growthOpportunities".
  { name: "growth rate / ratio", key: /\b(?:growth|cagr|yoy|ratio)(?: (?:rate|pct|percent|percentage))?$/, term: /\S/, allFigures: true },
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

/** "Not separately stated / disclosed": the source gives no figure of its own. */
const NOT_SEPARATELY_RE = /\bnot (?:separately|individually) (?:stated|disclosed|shown|broken out)\b/i;

/**
 * True when a figure is one the source doesn't give on its own — the value
 * only points at a larger line ("Included in $1,442,300 salaries and
 * wages", "Owner salary included in $1.4M wages"). Not when the value has a
 * figure of its own ("Inventory (~$180,000 at cost) included in the $3.2M
 * asking price"), says what is NOT included ("Building not included in the
 * $6.5M price"), is unsure ("unclear if included in $4.2M backlog"), or is
 * about what a price, backlog or offer covers — those are stated deal
 * terms, not figures.
 */
export function figureNotStatedOnItsOwn(clause: string): boolean {
  if (NOT_SEPARATELY_RE.test(clause)) return true;
  const m = /\bincluded in (?:the )?(\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|b|million|thousand)?)\s*([^;.]*)/i.exec(clause);
  if (!m) return false;
  const before = clause.slice(0, m.index);
  if (/\b(?:not|n['’]t|never|if|whether|unclear|unsure|possibly|maybe|may be|might be|could be|also|all|fully)\s+(?:\w+\s+){0,2}$/i.test(before)) return false;
  if (amountsIn(before).length > 0) return false;
  if (/^(?:\w+\s+){0,3}(?:price|backlog|offer|deal|consideration|valuation|purchase|sale|loi|package)\b/i.test(m[2])) return false;
  return true;
}

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
  // Commas and non-breaking / thin spaces group thousands ("1 199 100"); a
  // plain space separates two figures ("EBITDA 1,199,100 920,600" is two
  // columns, never 1199100920600).
  return text.replace(/(\d)[,  ](?=\d{3}\b)/g, "$1");
}

/** True when the value's leading figure is printed in the source ("$845,252" ↔ "845,252" / "845252"). */
function figurePrinted(value: string, sourceDigits: string): boolean {
  const first = amountsIn(value)[0];
  if (!first) return false;
  const esc = first.replace(".", "\\.");
  if (new RegExp(`(^|[^\\d.])${esc}(?![\\d])`).test(sourceDigits)) return true;
  // "$1.2M" (or "1,398K") in the value, "1,200,000" in the source.
  const m = value.replace(/(\d),(?=\d{3}(?!\d))/g, "$1").match(/(\d+(?:\.\d+)?)\s?(k|m|million|thousand)\b/i);
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
    ["ebitda", /\bEBITDA\b|\bearnings before interest\b/i],
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
   * `document`: the source is a document (statements, minute book, lease,
   * tax return) — only there are company transactions filed as private
   * notes promoted to facts (promoteBusinessNotes); an e-mail, call or CRM
   * note about a guarantee is second-hand and full of deal process.
   */
  opts: { spoken?: boolean; document?: boolean } = {},
): GuardResult {
  const data: Extraction = {};
  const stated: string[] = [];
  const dropped: GuardResult["dropped"] = [];
  const text = typeof sourceText === "string" ? sourceText : "";
  const sourceDigits = normaliseSourceDigits(text);

  /** Why a derived metric's figure can't be kept, or null when the source prints it. */
  const derivedRejection = (metric: DerivedMetric, value: string): string | null => {
    if (!text) return `${metric.name}: no source text to check it against`;
    if (!metric.term.test(text)) return `${metric.name}: the source never names it — a calculated figure`;
    if (!opts.spoken && metric.allFigures && amountsIn(value).length > 0 && !allFiguresPrinted(value, sourceDigits)) {
      return `${metric.name}: worked out from other figures`;
    }
    if (opts.spoken ? looksComputed(value) : amountsIn(value).length > 0 && !figurePrinted(value, sourceDigits)) {
      return opts.spoken ? `${metric.name}: written as a calculation` : `${metric.name}: the figure is not printed in the source`;
    }
    if (amountsIn(value).length === 0 && looksComputed(value)) return `${metric.name}: written as a calculation`;
    return null;
  };

  /**
   * A by-year map ({"2024": "$…"}), entry by entry: a derived metric's year
   * is kept only when the source prints it; any year written as a
   * calculation, or only "included in" a larger line, goes. `name` is the
   * key reported in `stated` / `dropped`.
   */
  const guardYearMap = (name: string, metricKey: string, map: Record<string, unknown>): Record<string, unknown> | null => {
    const metric = derivedMetricOf(metricKey);
    const kept: Record<string, unknown> = {};
    let printed = false;
    for (const [year, v] of Object.entries(map)) {
      if (v === null || v === undefined || v === "") continue;
      if (typeof v !== "string" && typeof v !== "number") { kept[year] = v; continue; }
      const value = String(v).trim();
      if (!value) continue;
      if (metric) {
        const why = derivedRejection(metric, value);
        if (why) { dropped.push({ key: `${name}.${year}`, reason: why }); continue; }
        printed = true;
      } else {
        const first = value.split(/;\s|\.\s/)[0];
        if (figureNotStatedOnItsOwn(first) || (STATED_AS_CALCULATION_RE.test(first) && !(text && allFiguresPrinted(first, sourceDigits)))) {
          dropped.push({ key: `${name}.${year}`, reason: "written as a calculation, not a stated figure" });
          continue;
        }
      }
      kept[year] = v;
    }
    if (printed) stated.push(name);
    return Object.keys(kept).length > 0 ? kept : null;
  };

  for (const [key, rawIn] of Object.entries(input)) {
    if (key === STATED_METRICS_KEY) continue; // recomputed below
    // By-year maps — the model's byYear block ({metric: {year: figure}}) and
    // the *ByYear maps — are checked year by year.
    if (!key.startsWith("_") && rawIn && typeof rawIn === "object" && !Array.isArray(rawIn)) {
      if (key === "byYear") {
        const out: Record<string, unknown> = {};
        for (const [metricKey, m] of Object.entries(rawIn as Record<string, unknown>)) {
          if (!m || typeof m !== "object" || Array.isArray(m)) { out[metricKey] = m; continue; }
          const kept = guardYearMap(`byYear.${metricKey}`, metricKey, m as Record<string, unknown>);
          if (kept) out[metricKey] = kept;
        }
        if (Object.keys(out).length > 0) data[key] = out;
      } else {
        const kept = guardYearMap(key, key, rawIn as Record<string, unknown>);
        if (kept) data[key] = kept;
      }
      continue;
    }
    // A figure the model gave as a number is checked like its text.
    const raw = typeof rawIn === "number" && !key.startsWith("_") ? String(rawIn) : rawIn;
    // Bookkeeping, private notes and anything else that isn't text pass through.
    if (key.startsWith("_") || typeof raw !== "string") {
      data[key] = raw;
      continue;
    }
    let value = raw.trim();
    if (!value) continue;

    const metric = derivedMetricOf(key);
    if (metric) {
      const why = derivedRejection(metric, value);
      if (why) {
        dropped.push({ key, reason: why });
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
      figureNotStatedOnItsOwn(value.split(/;\s|\.\s/)[0]) ||
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
  if (opts.document) promoteBusinessNotes(data);
  return { data, stated, dropped };
}

/**
 * Company transactions with the owner that the extractor filed as private
 * notes anyway (an older prompt did it routinely: the Class D dividend, the
 * personal guarantee on the term loan, the related-party lease, "unaudited
 * compilation") become the business facts they are (mutates): the note's
 * words are the fact, under dividendsDeclared / personalGuarantees /
 * shareholderLoans / relatedPartyTransactions / auditStatus, or appended to
 * the source's own fact of that family when the note adds something to it.
 * A note that also names a personal matter or a negotiation position stays a
 * note. Idempotent.
 */
export function promoteBusinessNotes(data: Extraction): void {
  const raw = data._privateNotes;
  const notes = Array.isArray(raw) ? raw.map((n) => String(n ?? "")) : typeof raw === "string" ? raw.split("\n") : [];
  if (notes.length === 0) return;
  const kept: string[] = [];
  for (const note of notes.map((n) => n.trim()).filter(Boolean)) {
    const fact = businessFactForNote(note);
    if (!fact || mentionsPrivateMatter(note)) { kept.push(note); continue; }
    if (noteRecordedAsFact(note, data)) continue; // the source already records it
    const key = Object.keys(data).find((k) => !k.startsWith("_") && fact.family.test(k) && typeof data[k] === "string") ?? fact.canonical;
    const current = typeof data[key] === "string" ? String(data[key]).trim() : "";
    data[key] = current ? `${current}; ${note}` : note;
  }
  if (kept.length === notes.length) return;
  if (kept.length > 0) data._privateNotes = Array.isArray(raw) ? kept : kept.join("\n");
  else delete data._privateNotes;
}

// ─── Grounding a value in its source's text (reprocess) ─────────────────────

/** Words that carry no fact on their own, for the word-overlap check. */
const GROUNDING_STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "than", "into", "over", "under", "per", "total", "about",
  "approximately", "approx", "around", "roughly", "including", "includes", "included", "plus", "only", "also",
  "year", "years", "ended", "ending", "fiscal", "each", "which", "their", "its", "are", "was", "were", "has", "have",
]);

/** Lower-case words of a text, punctuation dropped ("Oil & gas, agricultural" → ["oil","gas","agricultural"]). */
function plainWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/([a-z])(\d)/g, "$1 $2") // "promotion26,000" (glued PDF columns) → "promotion 26,000"
    .replace(/(\d)([a-z])/g, "$1 $2") // "8520Advertising" → "8520 advertising"
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** Weekday names: a reader adds them to a date ("Aug 12, 2025 (Tuesday)"); they say nothing the date doesn't. */
const WEEKDAYS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun"]);

/**
 * A word's comparable form: months written out ("aug" → "august"), a light
 * stem so a summary's "opened" / "impacted" / "stores" meets the speaker's
 * "opening" / "impact" / "store".
 */
function stemWord(w: string): string {
  const month = w.length >= 3 ? MONTH_NAMES.find((m) => m.startsWith(w)) : undefined;
  if (month) return month;
  if (w.length < 4) return w;
  return w.replace(/(?:ies|ied)$/, "y").replace(/(?:ing|ed|es|s|ly|ment|ments)$/, "").replace(/e$/, "");
}

/** Content stems of a text: no stop words, no weekday names, no numbers. */
function contentStems(text: string): string[] {
  return plainWords(text)
    .filter((w) => !/^\d/.test(w) && w.length >= 3 && !GROUNDING_STOP.has(w) && !WEEKDAYS.has(w))
    .map(stemWord);
}

/** Every number the source states — printed digits, and (spoken sources) numbers said in words. */
function sourceNumbers(text: string, spoken: boolean): number[] {
  const out = typedNumericValues(text).map((t) => t.value);
  // Commas only as thousands groups: a CSV row "972600,344800,1530400" is three figures.
  for (const m of text.match(/\d{1,3}(?:,\d{3}(?!\d))+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? []) {
    const n = parseFloat(m.replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  if (spoken) out.push(...spelledNumbers(text), ...spokenDecimals(text), ...spokenHundreds(text), ...spokenHalves(text));
  return out;
}

/** "sixty-one and a half million" → 61,500,000; "two and a half thousand" → 2,500. */
function spokenHalves(text: string): number[] {
  const out: number[] = [];
  const re = /((?:[a-z0-9]+[ -]){0,2}[a-z0-9]+)\s+and a half\s+(thousand|million|billion)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const lead = m[1].trim();
    const digits = lead.match(/(\d+(?:\.\d+)?)$/);
    const spelled = spelledNumbers(lead.replace(/-/g, " "));
    const n = digits ? parseFloat(digits[1]) : spelled[spelled.length - 1];
    if (n === undefined || !Number.isFinite(n)) continue;
    const scale = { thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 }[m[2].toLowerCase() as "thousand" | "million" | "billion"];
    out.push(Math.round((n + 0.5) * scale));
  }
  return out;
}

const UNIT_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TENS_WORDS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
/** How people say hundreds in money talk: "one-eighty" → 180, "two fifty" → 250, "three-twenty-five" → 325. */
function spokenHundreds(text: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`\\b(${UNIT_WORDS.join("|")})[- ](${Object.keys(TENS_WORDS).join("|")})(?:[- ](${UNIT_WORDS.join("|")}))?\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tens = TENS_WORDS[m[2].toLowerCase()];
    const units = m[3] && tens >= 20 ? UNIT_WORDS.indexOf(m[3].toLowerCase()) + 1 : 0;
    out.push((UNIT_WORDS.indexOf(m[1].toLowerCase()) + 1) * 100 + tens + units);
  }
  return out;
}

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};
/** "four point two million" → 4,200,000; "one point three five million" → 1,350,000. */
function spokenDecimals(text: string): number[] {
  const out: number[] = [];
  const digit = `(?:${Object.keys(DIGIT_WORDS).join("|")}|\\d)`;
  const re = new RegExp(`\\b(${digit}|ten|eleven|twelve|\\d+)\\s+point\\s+((?:${digit}\\s+){0,2}${digit})\\s+(thousand|million|billion)\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const whole = /^\d+$/.test(m[1]) ? m[1] : ({ ten: "10", eleven: "11", twelve: "12" } as Record<string, string>)[m[1].toLowerCase()] ?? DIGIT_WORDS[m[1].toLowerCase()];
    const frac = m[2].trim().split(/\s+/).map((w) => (/^\d$/.test(w) ? w : DIGIT_WORDS[w.toLowerCase()])).join("");
    const scale = { thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 }[m[3].toLowerCase() as "thousand" | "million" | "billion"];
    const n = parseFloat(`${whole}.${frac}`) * scale;
    if (Number.isFinite(n)) out.push(Math.round(n));
  }
  return out;
}

/** The value's figures (money, percentages, counts ≥ 10), as numbers. */
function valueNumbers(value: string): number[] {
  const typed = typedNumericValues(value).map((t) => t.value);
  // "$1.35M" is 1,350,000 (typed above), not also 1.35.
  const unscaled = value.replace(/\d[\d,]*(?:\.\d+)?\s*(?:k|mm?|million|thousand|b|billion)(?![a-z0-9])/gi, " ");
  const plain = amountsIn(unscaled).map((d) => parseFloat(d)).filter((n) => Number.isFinite(n));
  return Array.from(new Set([...typed, ...plain]));
}

/**
 * True when a value the source row asserted earlier is still grounded in
 * that row's own text — a fact the source actually states, which a fresh
 * read simply didn't repeat (model variance), as opposed to one an older
 * prompt worked out, garbled or mislabelled. Reprocess keeps an omitted
 * value only then:
 *  - it passes today's extraction guard unchanged (a derived metric the
 *    source never names or prints, a calculation, NAICS text as the
 *    industry, a stray "ebitda" in prose — all fail);
 *  - every figure in it is stated in the text (printed; on a call or video
 *    call, also said in words) — a computed ratio, growth rate or total
 *    ("= 0.62", "13.2% year-over-year", "= 51 total") is not;
 *  - its words are the source's: word for word, or a faithful summary — at
 *    least half of its content words (months written out, light stems:
 *    "opened" meets "opening", "Aug" meets "August"; weekday names a reader
 *    adds to a date don't count) are in the text, and a metric term sits
 *    where the source puts it. An earlier read of the same text by the same
 *    kind of reader is not held to a stricter standard than today's read —
 *    what goes is what an older prompt worked out, mislabelled or garbled.
 */
export function groundedInSource(key: string, value: unknown, sourceText: string | null | undefined, opts: GroundingOptions = {}): boolean {
  return (typeof value === "string" || typeof value === "number") && groundedValue(key, value, sourceText, opts) === String(value).trim();
}

export interface GroundingOptions {
  /** The source is speech (a call, video call, interview): figures may be said in words. */
  spoken?: boolean;
  /** Close to the source's own wording (nearly all its words), not only a faithful summary. */
  close?: boolean;
  /** Only the whole value — never a part of a list of figures. */
  whole?: boolean;
}

/**
 * The part of a value its source still states (see groundedInSource): the
 * whole value; or, for a value that lists several figures ("Total WIP
 * contracts: $5,243,000 | … | Weighted average margin: 24.4% | …"), the
 * clauses the source states, without the one the reader worked out; else
 * null. A derived metric (SDE, EBITDA, margin…) is all or nothing.
 */
export function groundedValue(key: string, value: unknown, sourceText: string | null | undefined, opts: GroundingOptions = {}): string | null {
  if (!sourceText || (typeof value !== "string" && typeof value !== "number")) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (clauseGrounded(key, v, sourceText, opts)) return v;
  if (opts.whole || isDerivedMetricKey(key)) return null;
  const piped = /\s\|\s/.test(v);
  const sep = piped ? " | " : /;\s/.test(v) ? "; " : " ";
  const parts = (piped ? v.split(/\s+\|\s+/) : sep === "; " ? v.split(/;\s+/) : v.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const kept = parts.filter((p) => clauseGrounded(key, p, sourceText, opts));
  if (kept.length === 0 || kept.length === parts.length) return null;
  // Only a worked-out figure is left out — a clause the source doesn't say in
  // words means the whole summary is not the source's.
  if (parts.some((p) => !kept.includes(p) && !hasUnstatedFigure(p, sourceText, !!opts.spoken))) return null;
  const joined = kept.join(sep);
  return clauseGrounded(key, joined, sourceText, opts) ? joined : null;
}

/** True when a figure in `v` is not stated in the source (printed; on a call, also said in words). */
function hasUnstatedFigure(v: string, sourceText: string, spoken: boolean): boolean {
  const nums = valueNumbers(v);
  if (nums.length === 0) return false;
  const inSource = sourceNumbers(sourceText, spoken);
  // PDF text often glues a statement's columns together ("Cash431,720164,630"):
  // a figure with thousands separators is also found as written.
  const printedAsWritten = (n: number) => Number.isInteger(n) && n >= 1000 && sourceText.includes(n.toLocaleString("en-US"));
  // A spreadsheet's share ("0.028") is the value's "2.8%".
  const asShare = (n: number) => n > 0 && n <= 100 && inSource.some((s) => s > 0 && s < 1 && Math.abs(s * 100 - n) <= 0.05);
  // A round figure ("$1.35M") may be the printed 1,348,200; an exact one
  // ("$617,819") must be printed exactly — glued PDF columns
  // ("336,616197,819") are full of near misses.
  const exact = (n: number) => Number.isInteger(n) && Math.abs(n) >= 1000 && n % 1000 !== 0;
  // Said on a call in thousands ("replace it in a year or two, maybe
  // one-eighty") — the "$180k" a note-taker writes down.
  const saidInThousands = (n: number) => spoken && n >= 10_000 && n % 1000 === 0 && inSource.includes(n / 1000);
  const stated = (n: number) =>
    inSource.some((s) => s === n || (!exact(n) && n !== 0 && Math.abs(s - n) / Math.abs(n) <= 0.005)) ||
    printedAsWritten(n) || asShare(n) || saidInThousands(n);
  if (nums.every(stated)) return false;
  // A table row whose columns PDF text glued together ("20225893615.5%8,420,000"):
  // the value's figures, in order, run together exactly as printed.
  const run = (v.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((d) => d.replace(/,/g, ""));
  if (run.length >= 2 && run.join("").replace(/\D/g, "").length >= 6) {
    const glued = sourceText.replace(/(\d),(?=\d)/g, "$1");
    if (glued.includes(run.join(""))) return false;
  }
  return true;
}

function clauseGrounded(key: string, v: string, sourceText: string, opts: GroundingOptions): boolean {
  const guarded = guardExtraction({ [key]: v }, sourceText, { spoken: opts.spoken });
  if (guarded.data[key] !== v) return false;
  const nums = valueNumbers(v);
  if (hasUnstatedFigure(v, sourceText, !!opts.spoken)) return false;
  const words = plainWords(v).filter((w) => !/^\d/.test(w));
  const content = contentStems(v);
  if (content.length === 0) return nums.length > 0;
  const textWords = plainWords(sourceText);
  // Word for word (punctuation aside) is always grounded.
  if (` ${textWords.join(" ")} `.includes(` ${words.join(" ")} `)) return true;
  // A metric term must sit where the source puts it: "oil & gas, ebitda
  // agricultural" is a glitch even when the statements say EBITDA elsewhere.
  const bigrams = new Set(textWords.slice(1).map((w, i) => `${textWords[i]} ${w}`));
  for (let i = 0; i < words.length; i++) {
    if (!/^(?:ebitda|ebit|sde)$/.test(words[i])) continue;
    const before = i > 0 ? `${words[i - 1]} ${words[i]}` : null;
    const after = i < words.length - 1 ? `${words[i]} ${words[i + 1]}` : null;
    if (!(before && bigrams.has(before)) && !(after && bigrams.has(after))) return false;
  }
  // Otherwise a faithful summary: at least half of its content words are the
  // source's (a claim the source never makes shares next to none) — or,
  // `close`, nearly all of them (most of them around a stated figure).
  const vocab = new Set(textWords.map(stemWord));
  const present = content.filter((w) => vocab.has(w)).length;
  // (A stated figure's label — "Net over-billed position: $40,400" — is the
  // reader's own wording around the source's figure: a third will do.)
  const needed = opts.close ? (nums.length === 0 ? 0.85 : 0.6) : nums.length === 0 ? 0.5 : 1 / 3;
  return present > 0 && present / content.length >= needed - 1e-9;
}

/**
 * True when `other` (another value the same source gives today) already says
 * what `value` said: every figure of `value` is in it and most of its
 * content words — the fresh read filed the same fact under another key.
 * A bare figure ("$540,000") says what it is only through its key: the two
 * keys must name the same thing (longTermDebt ~ totalDebt, not cash ~
 * inventory).
 */
export function restates(value: string, other: string, keys?: { key: string; otherKey: string }): boolean {
  const content = contentStems(value);
  const nums = valueNumbers(value);
  if (content.length === 0 && nums.length === 0) return false;
  const otherNums = valueNumbers(other);
  if (!nums.every((n) => otherNums.some((o) => o === n || (n !== 0 && Math.abs(o - n) / Math.abs(n) <= 0.005)))) return false;
  if (content.length === 0) {
    if (!keys) return false;
    const GENERIC = new Set(["total", "annual", "amount", "value", "number", "count", "by", "year", "current", "net", "gross", "of"]);
    const kw = (k: string) => new Set(keyWords(k).filter((w) => w.length >= 3 && !GENERIC.has(w) && !/^\d/.test(w)).map(stemWord));
    const a = kw(keys.key);
    return Array.from(kw(keys.otherKey)).some((w) => a.has(w));
  }
  const vocab = new Set(plainWords(other).map(stemWord));
  return content.filter((w) => vocab.has(w)).length / content.length >= 0.7;
}

/** The derived-metric keys an extraction recorded as printed in its source. */
export function statedMetricKeys(extraction: Extraction): string[] {
  const raw = extraction[STATED_METRICS_KEY];
  return typeof raw === "string" ? raw.split(",").map((k) => k.trim()).filter(Boolean) : [];
}
