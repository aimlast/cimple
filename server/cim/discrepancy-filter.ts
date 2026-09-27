/**
 * Deterministic post-filter for discrepancy findings — applied before any
 * row is written, by the verification check AND the financial analysis.
 *
 * The models flag "conflicts" where both sides say the same thing in
 * different words ($38,700 vs $38,700; $3,900/month vs $46,800/year; 23 vs
 * "23 employees"; "since 2018" vs "7.1 years"), where one side is simply
 * missing ("no MSA uploaded to verify"), or where an adjusted figure is
 * compared with a reported one (adjusted EBITDA ~$780K vs unadjusted
 * $648,891 — a false CRITICAL that blocked generation). None of those is a
 * disagreement between sources, and every one costs the broker a click or
 * blocks the CIM. They are dropped here; real conflicts ("about a quarter"
 * vs 41%, lease 2034 vs 2029) pass.
 *
 * Pure — no I/O. `today` is injectable for the tenure rule.
 */

export interface DiscrepancyCandidateLike {
  field: string;
  suggestedResolution?: string | null;
  interviewValue?: string | null;
  documentValue?: string | null;
  /** The model's own explanation (the check's `aiExplanation`, the analysis's `explanation`). */
  explanation?: string | null;
  aiExplanation?: string | null;
  severity?: string | null;
  /** The model's own verdict on the pair, when it gave one (see FindingRelation). */
  relation?: FindingRelation | string | null;
  /** The fiscal year a by-year fact is disputed for, when the row names one. */
  factYear?: string | null;
}

export type DropReason = "equal" | "missing_side" | "adjusted_vs_reported" | "proposed_vs_current" | "not_a_conflict" | "different_periods" | "different_measures";

export interface FilterResult<T> {
  kept: T[];
  dropped: Array<{ item: T; reason: DropReason }>;
}

/** Strip the " — source" label the financial analysis appends to a value. */
function stripLabel(v: string): string {
  const idx = v.indexOf(" — ");
  return idx > 0 ? v.slice(0, idx) : v;
}

function normText(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9%.$]+/g, " ").replace(/\s+/g, " ").trim();
}

const MISSING_RE = new RegExp(
  [
    String.raw`^(?:—|-|–|n\/?a|none|unknown|not (?:provided|available|stated|specified|known)|no (?:data|value|information|document(?:s)?))\.?$`,
    String.raw`\bnot (?:uploaded|provided|available|on file|disclosed|found|stated|mentioned|specified|documented)\b`,
    // "no MSA uploaded to verify", "No Larkspur MSA document provided in
    // uploaded documents to verify this claim", "no contract on file to confirm"
    String.raw`\bno\b[^.;]{0,80}\b(?:uploaded|provided|on file|available|included|supplied|received)\b[^.;]{0,60}\bto (?:verify|confirm|check|support|substantiate|corroborate)\b`,
    // "no supporting document in the uploaded documents", "no agreement on file"
    String.raw`\bno\b[^.;]{0,60}\b(?:documents?|documentation|records?|evidence|support(?:ing)?|copy|agreement|contract)\b[^.;]{0,40}(?:\b(?:uploaded|provided|on file)\b|\bin the (?:uploaded |provided )?documents\b|\bin (?:the )?data ?room\b)`,
    String.raw`\b(?:not|never|isn'?t|wasn'?t) (?:been )?(?:in|among|part of) (?:the )?(?:uploaded |provided )?documents\b`,
    String.raw`\b(?:has|have) not been (?:uploaded|provided)\b`,
    String.raw`\bmissing (?:document|documentation)\b`,
    String.raw`\b(?:cannot|can'?t|could not|unable to) be (?:verified|confirmed|checked)\b`,
    String.raw`\bnothing (?:uploaded|on file)\b`,
  ].join("|"),
  "i",
);

/** One side is absent, or says only that a document isn't there. */
export function isMissingSide(v: string | null | undefined): boolean {
  const t = stripLabel(v ?? "").trim();
  if (!t) return true;
  return MISSING_RE.test(t);
}

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";

export interface NumTok {
  value: number;
  pct: boolean;
  year: boolean;
  /** Duration in years ("7.1 years", "15 yrs") — for the tenure rule. */
  durationYears: boolean;
  period: "month" | "year" | null;
  /** Hedged: "~40", "about 150", "over 110", "40+". */
  approx: boolean;
  /** The number as written ("18%", "$9.4M", "1,200"). */
  raw: string;
  /** The word right after it ("years", "beds", "trucks"), singular. */
  unitWord: string;
  /** Up to 90 characters either side (lower-cased) — what the number is about. */
  context: string;
  /** Where the number stands in tokenText(text): the match's start and end. */
  at?: number;
  end?: number;
}

const APPROX_BEFORE_RE = /(?:~|≈|\babout|\bapprox\.?|\bapproximately|\baround|\broughly|\bover|\bmore than|\bunder|\bless than|\bnearly|\balmost|\bestimated|\bsome|\bclose to)\s*\$?\s*$/;

const MAG: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };

/** The text numberTokens reads a value as (lower-cased; days of the month and ISO days dropped) — tokens' `at` index it. */
export function tokenText(text: string, opts: { keepSourceLabel?: boolean } = {}): string {
  let t = (opts.keepSourceLabel ? text : stripLabel(text)).toLowerCase();
  // Days of the month are not quantities: "December 31, 2024" → "december 2024".
  t = t.replace(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?![0-9]),?`, "g"), "$1 ");
  return t.replace(/\b(\d{4})-\d{2}-\d{2}\b/g, "$1");
}

/** Every quantity in a value, with its unit and surroundings. */
export function numberTokens(text: string, opts: { keepSourceLabel?: boolean } = {}): NumTok[] {
  const t = tokenText(text, opts);
  const out: NumTok[] = [];
  const re = /(\$)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|million|thousand|b|billion)?(?![a-z0-9])\s*(%|percent\b)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const raw = m[2].replace(/,/g, "");
    let n = parseFloat(raw);
    if (!Number.isFinite(n)) continue;
    const money = !!m[1];
    const suffix = (m[3] || "").toLowerCase();
    const pct = !!m[4];
    if (suffix) n *= MAG[suffix] ?? 1;
    const after = t.slice(re.lastIndex, re.lastIndex + 24);
    const year = !money && !suffix && !pct && Number.isInteger(n) && n >= 1900 && n <= 2099 && !/^\s*(?:\/|per\b)/.test(after);
    const durationYears = !money && !pct && /^\s*-?\s*(?:years?|yrs?)\b/.test(after);
    let period: NumTok["period"] = null;
    if (/^\s*(?:\/|per\s+|a\s+|each\s+)\s*(?:month|mo)\b|^\s*monthly\b/.test(after)) period = "month";
    else if (/^\s*(?:\/|per\s+|a\s+|each\s+)\s*(?:year|yr|annum)\b|^\s*(?:annually|annual|yearly)\b/.test(after)) period = "year";
    const before = t.slice(Math.max(0, m.index - 16), m.index + (m[0].length - m[0].trimStart().length));
    const approx = APPROX_BEFORE_RE.test(before) || /^\s*\+|^\s*or so\b|^\s*ish\b/.test(after);
    const unitWord = (after.match(/^\s*[-+]?\s*([a-z]{2,})/)?.[1] ?? "").replace(/(?:es|s)$/, "");
    const context = t.slice(Math.max(0, m.index - 90), re.lastIndex + 90);
    out.push({ value: n, pct, year, durationYears, period, approx, raw: m[0].trim(), unitWord, context, at: m.index, end: re.lastIndex });
  }
  return out;
}

function close(a: number, b: number, rel: number): boolean {
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base === 0 || Math.abs(a - b) / base <= rel;
}

/** Values a token can stand for: a monthly amount also reads as its annual total, and vice versa. */
function tokenValues(t: NumTok): number[] {
  if (t.period === "month") return [t.value, t.value * 12];
  if (t.period === "year") return [t.value, t.value / 12];
  return [t.value];
}

export function tokensMatch(a: NumTok, b: NumTok): boolean {
  if (a.pct !== b.pct) return false;
  const approx = a.approx || b.approx;
  if (a.pct) return Math.abs(a.value - b.value) <= (approx ? 1.5 : 0.05);
  const rel = approx ? 0.1 : 0.005;
  return tokenValues(a).some((x) => tokenValues(b).some((y) => close(x, y, rel)));
}

/**
 * True when two sides state the same thing: the same text, or the same
 * numbers (monthly × 12 = annual; ~/about/over allow 10%; the first number
 * of each side must agree and every number on the terser side must appear
 * on the other). Differing first years (lease 2034 vs 2029) never agree —
 * except a start year vs a tenure ("since 2018" vs "7.1 years") that match
 * as of `today`.
 */
export function sidesEquivalent(a: string, b: string, today: Date = new Date()): boolean {
  const na = normText(stripLabel(a));
  const nb = normText(stripLabel(b));
  if (!na || !nb) return false;
  if (na === nb) return true;

  const ta = numberTokens(a);
  const tb = numberTokens(b);

  // Tenure: a start year on one side, a duration in years on the other.
  const tenure = (x: NumTok[], y: NumTok[]) => {
    const start = x.find((t) => t.year);
    const dur = y.find((t) => t.durationYears);
    if (!start || !dur || y.some((t) => t.year) || x.some((t) => t.durationYears)) return null;
    // "since 2018" has no month: compare whole years, with a year's slack
    // either way (the document may be a year older than today).
    const years = today.getUTCFullYear() - start.value;
    return Math.abs(years - dur.value) <= 1.5;
  };
  const tenureAB = tenure(ta, tb) ?? tenure(tb, ta);
  if (tenureAB !== null) return tenureAB;

  const yearsA = ta.filter((t) => t.year);
  const yearsB = tb.filter((t) => t.year);
  if (yearsA.length > 0 && yearsB.length > 0 && yearsA[0].value !== yearsB[0].value) return false;

  const qa = ta.filter((t) => !t.year);
  const qb = tb.filter((t) => !t.year);
  if (qa.length === 0 || qb.length === 0) {
    // Only years on both sides and they agree, with nothing else to compare
    // ("Aug 2027" = "August 31, 2027"; a day adds precision, not a conflict).
    const words = (s: string) => s.replace(new RegExp(`\\b(${MONTHS})[a-z]*`, "g"), "$1").replace(/[^a-z]/g, "");
    return qa.length === 0 && qb.length === 0 && yearsA.length > 0 && yearsB.length > 0 && words(na) === words(nb);
  }
  if (!tokensMatch(qa[0], qb[0])) return false;
  const [small, large] = qa.length <= qb.length ? [qa, qb] : [qb, qa];
  return small.every((s) => large.some((l) => tokensMatch(s, l)));
}

const EARNINGS_RE = /\b(?:ebitda|sde|seller'?s discretionary|earnings|net income|profit|cash flow)\b/i;
const ADJUSTED_RE = /\b(?:adjusted|normali[sz]ed|recast|pro[- ]?forma|add-?backs?|owner benefit)\b/i;
const REPORTED_RE = /\b(?:reported|unadjusted|as filed|statutory|before (?:add-?backs|adjustments|normali[sz]ation))\b/i;

/**
 * An adjusted/normalized earnings figure compared with a reported one — two
 * different metrics, not a conflict. When the subject itself is an adjusted
 * metric ("2024 Adjusted EBITDA": $4.1M vs $3.9M) both sides are adjusted
 * and a difference is real, so it is kept.
 */
export function isAdjustedVsReported(item: DiscrepancyCandidateLike): boolean {
  const a = stripLabel(item.interviewValue ?? "");
  const b = stripLabel(item.documentValue ?? "");
  if (!EARNINGS_RE.test(`${item.field} ${a} ${b}`)) return false;
  if (ADJUSTED_RE.test(item.field)) return false;
  const adjA = ADJUSTED_RE.test(a) && !REPORTED_RE.test(a);
  const adjB = ADJUSTED_RE.test(b) && !REPORTED_RE.test(b);
  return adjA !== adjB;
}

// The model's own explanation says the two sides don't actually conflict
// ("a timing clarification rather than a conflict", "both can be true").
const NOT_A_CONFLICT_RE =
  /\b(?:(?:is|are|this is|it is|it's)\s+not\s+(?:a|an)\s+(?:real\s+|actual\s+|true\s+|genuine\s+|material\s+)?(?:conflict|discrepancy|contradiction|inconsistency)|(?:there is|there's)\s+no\s+(?:real\s+|actual\s+|true\s+|genuine\s+|material\s+)?(?:conflict|discrepancy|contradiction|inconsistency)|not\s+(?:actually\s+)?(?:contradictory|inconsistent|in conflict)|(?:do|does)\s+not\s+(?:actually\s+)?(?:contradict|conflict)|(?:timing|wording|terminology)\s+clarification|clarification\s+rather\s+than|rather\s+than\s+a\s+(?:conflict|discrepancy|contradiction)|both\s+(?:can|could|may)\s+be\s+(?:true|correct|accurate)|(?:sources|values|figures)\s+(?:are\s+)?(?:consistent|compatible|complementary))\b/i;

/**
 * The model's own verdict on a finding it reported. The check asks for it
 * as a field (`relation`) instead of the filter trying to read intent out
 * of the explanation: "consistent with a 2029 expiry, not the 2034 the
 * seller stated", "which is correct for the 2023 roster; the 2024 roster
 * shows 22" and "the new lease runs to 2032" are real conflicts that any
 * phrase list reading "consistent", "correct" or "new lease" throws away.
 *  - conflict: the two sources state different values for the same thing,
 *    as of the same time — the only verdict that becomes a row;
 *  - same_value: they agree (the same value in other words, rounding);
 *  - different_things: a different period, a part vs the whole, a
 *    proposed / future / optional term vs the terms in force.
 */
export type FindingRelation = "conflict" | "same_value" | "different_things" | "proposed_vs_current";
export const FINDING_RELATIONS: FindingRelation[] = ["conflict", "same_value", "different_things", "proposed_vs_current"];

/**
 * The explanation, taken as a whole, is the verdict that the sides agree:
 * a sentence that opens with "This is consistent" / "No conflict", with
 * nothing anywhere after it that contrasts, narrows or disagrees. (Beacon:
 * "… This is consistent - the seller's statement that the window 'opens in
 * 2028' aligns with the lease terms.") Deliberately narrow — the verdict
 * itself comes from `relation`; this only catches the model contradicting
 * its own field in plain words.
 */
const AGREEMENT_VERDICT_RE =
  /(?:^|[.!?]\s+)(?:this|that|it)\s+is\s+(?:fully\s+|entirely\s+)?consistent\b|(?:^|[.!?]\s+)no\s+(?:real\s+|actual\s+)?(?:conflict|discrepancy)\b/i;
// Anything after the verdict that walks it back or names a difference.
const WALK_BACK_RE =
  /\b(?:but|however|although|though|yet|except|not|never|while|whereas|only|unless|than|differ\w*|conflict\w*|contradict\w*|instead|rather|wrong|incorrect|overstat\w*|understat\w*|higher|lower|more|less|fewer)\b|\w+n['’]t\b/i;
const CONTRAST_AFTER_RE = /\b(?:but|however|although|though|yet|except)\b/i;

/**
 * The model reported a finding and, in its own words, said it isn't a
 * conflict. Only for non-critical findings, and only when nothing after
 * that statement walks it back ("not a conflict on the date, but the
 * amount…").
 */
export function selfDeclaredNonConflict(item: DiscrepancyCandidateLike): boolean {
  if ((item.severity ?? "").toLowerCase() === "critical") return false;
  const text = item.explanation ?? item.aiExplanation ?? "";
  for (const re of [NOT_A_CONFLICT_RE, AGREEMENT_VERDICT_RE]) {
    const m = text.match(re);
    if (!m || m.index === undefined) continue;
    const rest = text.slice(m.index + m[0].length);
    if (!(re === NOT_A_CONFLICT_RE ? CONTRAST_AFTER_RE : WALK_BACK_RE).test(rest)) return true;
  }
  // "No conflict - both sources agree …" as the suggested resolution.
  const suggestion = item.suggestedResolution ?? "";
  const s = suggestion.match(/^\s*no (?:real |actual )?(?:conflict|discrepancy)\b/i);
  return !!s && !WALK_BACK_RE.test(suggestion.slice(s[0].length));
}

// ─── Two periods, two measures ───────────────────────────────────────────────
//
// Ridgeline's one check run raised two rows, both false: "Top 3 customers =
// 41% of 2024 revenue" against the concentration schedule's "FY2022: Top 3
// customers 35.0%" (the schedule's FY2024 line says 41.0% — the seller is
// right), and "~$180k replacement cost" for the old press brake against the
// fixed-asset list's "$96,000 original cost, NBV $29,700, Est. FMV $38,000".
// A figure for one fiscal year is not disputed by another year's, and a
// replacement cost is not disputed by a book or market value.

/** A value without the " — source" label the financial analysis appends (only when the tail IS a source label). */
function withoutSourceLabel(v: string): string {
  const idx = v.lastIndexOf(" — ");
  if (idx <= 0) return v;
  const tail = v.slice(idx + 3);
  const label = /\b(?:interview|call|e-?mail|questionnaire|statements?|returns?|report|list|transcript|workbook|knowledge base|seller|document|t[245]|p&l|ledger|notes?|schedule|summary|analysis|filing|minutes?|agreement|lease)\b/i;
  return tail.length <= 160 && label.test(tail) && !/\$\s?\d|\d\s?%/.test(tail) ? v.slice(0, idx) : v;
}

const PERIOD_NOUNS = String.raw`(?:revenues?|sales|ebitda|sde|net income|earnings|gross (?:margin|profit)|profit|results|financials|payroll|wages|fiscal(?: year)?|year[- ]end|statements?|volume|billings?|turnover)`;
/** Year references that say what period a figure is FOR: "FY2022", "of 2024 revenue", "41% (2024)", "2024: 41%", "41% in 2024". */
const PERIOD_YEAR_RES: RegExp[] = [
  /\bFY\s?'?((?:19|20)\d{2}|\d{2})\b/gi,
  new RegExp(String.raw`\b((?:19|20)\d{2})\s+${PERIOD_NOUNS}\b`, "gi"),
  /[\d%]\s*\(\s*(?:fy\s?)?((?:19|20)\d{2})\s*\)/gi,
  /(?:^|[;,(|]\s*)((?:19|20)\d{2})\s*[:–]\s*(?:[a-z ]{0,30})?\$?\d/gi,
  /\d(?:\.\d+)?\s?%?\s+(?:of (?:revenue|sales) )?(?:in|for|during)\s+(?:fiscal\s+|fy\s?)?((?:19|20)\d{2})\b/gi,
];

function fullYear(y: string): string {
  return y.length === 2 ? `20${y}` : y;
}

/** The fiscal years a text's figures are for (dates like "expires 2029" are not periods). */
export function periodYears(text: string): Set<string> {
  const out = new Set<string>();
  for (const re of PERIOD_YEAR_RES) for (const m of Array.from(text.matchAll(re))) out.add(fullYear(m[1]));
  return out;
}

/** Clauses of a value: at ";", "|", ", " (never inside a number), brackets and sentence ends. */
function periodClauses(text: string): string[] {
  return text.split(/;\s*|\s*\|\s*|,\s+|\n|\(|\)|(?<=[.!?])\s+/).map((c) => c.trim()).filter(Boolean);
}

/** The figure a side is about: its first share or money figure, else its first quantity. */
function principal(tokens: NumTok[]): NumTok | undefined {
  const q = tokens.filter((t) => !t.year);
  return q.find((t) => t.pct || /\$/.test(t.raw) || /[km]\b|million|thousand/i.test(t.raw)) ?? q[0];
}

/**
 * How two sides' figures line up by fiscal year: "same" when the evidence's
 * figure for the claim's year agrees with the claim (it was another year's
 * line that differed), "different_periods" when the evidence speaks only of
 * other years, else null (one period, or no period words — decided
 * elsewhere). Date-like facts (a lease's expiry) never get here: their years
 * are the value, not a period.
 */
export function periodAlignment(claim: string, evidence: string, measure?: string | null): "same" | "different_periods" | null {
  const c = withoutSourceLabel(claim);
  const e = withoutSourceLabel(evidence);
  const cy = periodYears(c);
  if (cy.size !== 1) return null;
  const year = Array.from(cy)[0];
  const words = measureWords(measure);
  const claimTokens = numberTokens(c, { keepSourceLabel: true });
  if (!claimTokens.some((t) => !t.year)) return null;
  const ey = periodYears(e);
  if (ey.size === 0) return null;
  // The evidence's figures, clause by clause, for the one year each clause names.
  const forYear: NumTok[] = [];
  for (const clause of periodClauses(e)) {
    const ys = periodYears(clause);
    if (ys.size !== 1 || !ys.has(year)) continue;
    forYear.push(...numberTokens(clause, { keepSourceLabel: true }).filter((t) => !t.year));
  }
  if (forYear.length > 0) {
    // The claim's figure for the disputed measure: its only figure, or the
    // one the measure's words stand next to ("… and EBITDA around $400K") —
    // never simply the first ("2024 revenue of $2.3M" for an EBITDA row).
    const cp = measureFigure(c, claimTokens, words);
    if (!cp) return null;
    return forYear.some((t) => tokensMatch(cp, t)) ? "same" : null;
  }
  return ey.has(year) ? null : "different_periods";
}

/** Words that name no measure of their own in a field's label or key. */
const MEASURE_FILLER = new Set([
  "the", "and", "for", "per", "total", "value", "amount", "figure", "number", "count", "annual", "current", "stated", "reported",
  "claimed", "actual", "fiscal", "year", "years", "estimate", "estimated", "level", "details", "detail", "status",
]);
/** One spelling per measure ("sales" is revenue; salary, compensation and wages are pay). */
const MEASURE_SYNONYMS: Record<string, string> = {
  sale: "revenue", sales: "revenue", revenues: "revenue", turnover: "revenue",
  salary: "pay", salaries: "pay", compensation: "pay", comp: "pay", wage: "pay", wages: "pay", remuneration: "pay",
  customers: "customer", earnings: "earning",
};
const measureWord = (w: string) => MEASURE_SYNONYMS[w] ?? (w.length > 4 ? w.replace(/(?<![su])s$/, "") : w);

/** The words a field's label or key names its measure by ("EBITDA (2024)" → ebitda; "ownerSalaryByYear" → owner, pay). */
export function measureWords(field?: string | null): string[] {
  if (!field) return [];
  return Array.from(new Set(
    field
      .replace(/\([^)]*\)/g, " ")
      .replace(/ByYear\b/g, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 3 && !MEASURE_FILLER.has(w))
      .map(measureWord),
  ));
}

/**
 * The tokens of `text` whose own words name the measure: a measure word in
 * the stretch since the previous figure (within the clause), or right after
 * the figure ("$400K of EBITDA").
 */
export function tiedToMeasure(text: string, tokens: NumTok[], words: string[]): NumTok[] {
  if (words.length === 0) return [];
  const t = tokenText(text, { keepSourceLabel: true });
  // Years are words here ("24% of 2024 sales"): only quantities bound a figure's stretch.
  const all = numberTokens(text, { keepSourceLabel: true }).filter((x) => !x.year);
  const named = (stretch: string) =>
    (stretch.match(/[a-z]+/g) ?? []).some((w) => words.includes(measureWord(w)));
  return tokens.filter((tok) => {
    if (tok.at === undefined || tok.end === undefined) return false;
    const prevEnd = Math.max(0, ...all.filter((x) => x.end !== undefined && x.end <= tok.at!).map((x) => x.end!));
    const before = t.slice(Math.max(prevEnd, tok.at - 60), tok.at).split(/[;|\n()]|,\s/).pop() ?? "";
    const nextAt = Math.min(t.length, ...all.filter((x) => x.at !== undefined && x.at >= tok.end!).map((x) => x.at!));
    const after = t.slice(tok.end, Math.min(nextAt, tok.end + 30)).split(/[;|\n,(]/)[0] ?? "";
    return named(before) || (/^\s*(?:of|in)\s/.test(after) && named(after));
  });
}

/**
 * The claim's figure for the disputed measure: its only share or money
 * figure (else its only quantity), or — when it states several — the one
 * its words tie to the measure. Undefined when that can't be told.
 */
function measureFigure(text: string, tokens: NumTok[], words: string[]): NumTok | undefined {
  const q = tokens.filter((t) => !t.year);
  const valued = q.filter((t) => t.pct || /\$/.test(t.raw) || /[km]\b|million|thousand/i.test(t.raw));
  const pool = valued.length > 0 ? valued : q;
  if (pool.length === 1) return pool[0];
  const tied = tiedToMeasure(text, pool, words);
  return tied.length > 0 ? tied[0] : undefined;
}

/** What kind of value a money figure is, by the words next to it. */
const MEASURE_BASES: Array<[string, RegExp]> = [
  ["book", /\b(?:nbv|net book(?: value)?|book value|original cost|historical cost|cost basis|undepreciated(?: capital cost)?|ucc|carrying (?:value|amount)|depreciated value|purchase(?:d)? (?:price|for))\b/gi],
  ["market", /\b(?:fmv|fair market(?: value)?|market value|appraised(?: value)?|appraisal|resale(?: value)?|liquidation value|auction value|trade-?in value)\b/gi],
  ["insured", /\b(?:insured (?:value|for)|insurance value|replacement value for insurance)\b/gi],
  ["assessed", /\b(?:assessed value|tax assessment|municipal assessment)\b/gi],
  ["replacement", /\b(?:replacement cost|cost to replace|replac\w*|(?:a |buy(?:ing)? )?new (?:one|unit|machine|press|truck)|quote for (?:a )?new)\b/gi],
];

/**
 * The measure behind each money figure of a text ("book", "market",
 * "replacement"…), or null for a figure with no such words near it. A
 * valuation word (NBV, FMV, original cost) next to the figure outranks a
 * condition word ("due for replacement") nearby.
 */
export function moneyMeasures(text: string): Array<string | null> {
  const t = withoutSourceLabel(text);
  const lower = t.toLowerCase();
  const hits: Array<{ base: string; start: number; end: number }> = [];
  for (const [base, re] of MEASURE_BASES) for (const m of Array.from(lower.matchAll(re))) hits.push({ base, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  const out: Array<string | null> = [];
  for (const m of Array.from(lower.matchAll(/\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|mm|million|thousand)?\b/g))) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    const near = hits
      .map((h) => ({ ...h, dist: h.end <= s ? s - h.end : h.start >= e ? h.start - e : 0 }))
      .filter((h) => h.dist <= 40 && !/[;|]/.test(lower.slice(Math.min(h.end, e), Math.max(h.start, s))));
    const valuation = near.filter((h) => h.base !== "replacement").sort((a, b) => a.dist - b.dist)[0];
    const pick = valuation ?? near.sort((a, b) => a.dist - b.dist)[0];
    out.push(pick ? pick.base : null);
  }
  return out;
}

/** True when every money figure on each side names its measure and the two sides share none (replacement cost vs NBV / FMV). */
export function differentMoneyMeasures(a: string, b: string): boolean {
  const ma = moneyMeasures(a);
  const mb = moneyMeasures(b);
  if (ma.length === 0 || mb.length === 0 || ma.some((x) => !x) || mb.some((x) => !x)) return false;
  const sa = new Set(ma as string[]);
  return !(mb as string[]).some((x) => sa.has(x));
}

const DATE_LIKE_FIELD_RE = /\b(?:lease|expir\w*|term|renew\w*|option|matur\w*|deadline|dates?|closing|founded|established|since|anniversary)\b/i;

// The model's own reasoning that the two sides are not one disputed fact:
// the document "does not provide a replacement cost estimate", or it
// "confirms this for 2024" and differs only for another year.
const DOC_LACKS_MEASURE_RE =
  /\b(?:does not|doesn'?t|do not|don'?t)\s+(?:provide|include|state|give|contain|list|specify|show|mention|have)\b[^.;]{0,20}?\b(?:a|an|any)\s+((?:[a-z-]+\s+){0,3}(?:estimate|figure|value|amount|number|cost|price|rate))\b/i;
/**
 * Words in "does not provide a … figure" that name no measure: "the
 * statements do not provide a separate figure for the owner's salary" says
 * only how the document lays it out — the owner's pay is still disputed.
 */
const LACKED_FILLER = new Set([
  "separate", "specific", "single", "exact", "precise", "standalone", "stand-alone", "distinct", "individual", "direct", "clear",
  "explicit", "detailed", "breakdown", "total", "current", "updated", "estimate", "figure", "value", "amount", "number", "cost",
  "price", "rate", "similar", "comparable", "matching", "corresponding", "different",
]);
const DOC_CONFIRMS_FOR_YEAR_RE =
  /\b(?<!not |n't )(?:confirms?|matches|agrees with|supports)\s+(?:this|that|it|the (?:seller'?s?\s+)?(?:claim|figure|statement|value|number))\s+for\s+(?:fy\s?)?((?:19|20)\d{2})\b/i;

/**
 * "The seller's figure appears to refer to FY2024 (which matches the FY2024
 * statements), not FY2023": the claim is another year's figure, and it
 * agrees with that year (Ridgeline's call EBITDA paired with the FY2023
 * statements blocked CIM generation — f-facts known-1).
 */
const CLAIM_IS_OTHER_YEAR_RE =
  /\b(?:appears to |seems to |likely |probably |actually )?(?:refers?|relates?|belongs?|applies|is for)\s+(?:to\s+)?(?:fy\s?|fiscal (?:year )?)?((?:19|20)\d{2})\b([^.;]{0,80}?)\b(?:match(?:es|ing)?|agrees? with|consistent with)\b([^.;)]{0,60})/i;
/**
 * Words that turn the match into a mismatch ("but it does not match",
 * "which matches neither year", "matches nothing on file", "still
 * conflicts"): read between the year and the match word, and in the match
 * clause itself.
 */
const MATCH_NEGATED_RE = /\b(?:not|never|no|neither|nor|nothing|none|either|inconsistent|conflicts?|conflicting|differs?|different|but|however|although|though|still|even)\b|n't\b/i;

/**
 * The model's own words that the claim is another year's figure AND agrees
 * with that year's evidence, or null. The match clause must name the same
 * year ("which matches the FY2024 statements"): "appears to refer to 2022,
 * which matches nothing on file" or "…FY2024, but it does not match the
 * FY2024 statements either" are conflicts, kept.
 */
function claimIsOtherYear(text: string): string | null {
  const m = text.match(CLAIM_IS_OTHER_YEAR_RE);
  if (!m || m.index === undefined) return null;
  // Not when it says the claim does NOT refer to that year, or only supposes it does ("Even if …").
  const before = text.slice(Math.max(0, m.index - 24), m.index);
  if (/\b(?:not|never)\b[^.;]{0,20}$|n't\b[^.;]{0,20}$|\b(?:if|even if|whether|unless)\b[^.;]{0,20}$/i.test(before)) return null;
  const [, year, gap, clause] = m;
  if (MATCH_NEGATED_RE.test(gap) || MATCH_NEGATED_RE.test(clause)) return null;
  // The match clause names the same year.
  const clauseYears = Array.from(clause.matchAll(/(?:^|[^0-9])(?:fy\s?|fiscal (?:year )?)?((?:19|20)\d{2})(?![0-9])/gi)).map((y) => y[1]);
  if (!clauseYears.includes(year) || clauseYears.some((y) => y !== year)) return null;
  return year;
}

/** The model reasoned, in its own words, that the evidence lacks this measure or confirms the claim for its own year. */
export function modelReasonedNoConflict(item: DiscrepancyCandidateLike): boolean {
  if ((item.severity ?? "").toLowerCase() === "critical") return false;
  const text = item.explanation ?? item.aiExplanation ?? "";
  if (!text) return false;
  const claim = withoutSourceLabel(item.interviewValue ?? "");
  const evidence = withoutSourceLabel(item.documentValue ?? "");
  const confirms = text.match(DOC_CONFIRMS_FOR_YEAR_RE);
  if (confirms) {
    const ey = periodYears(evidence);
    if (ey.size > 0 && !ey.has(confirms[1])) return true;
  }
  const otherYear = claimIsOtherYear(text);
  if (otherYear) {
    const disputed = new Set([...Array.from(periodYears(item.field ?? "")), ...Array.from(periodYears(evidence)), ...(item.factYear ? [String(item.factYear)] : [])]);
    if (disputed.size > 0 && !disputed.has(otherYear)) return true;
  }
  const lacks = text.match(DOC_LACKS_MEASURE_RE);
  if (lacks) {
    // The measure the document lacks must be named ("a replacement cost
    // estimate", against "original cost, NBV, FMV") and not be what the
    // evidence states; "a separate figure" names none — the two figures are
    // then simply in conflict.
    const lower = (s: string) => ` ${s.toLowerCase().replace(/[^a-z-]+/g, " ").replace(/\s+/g, " ").trim()} `;
    const phrase = lower(lacks[1]);
    const named = phrase.trim().split(" ").filter((w) => w.length >= 3 && !LACKED_FILLER.has(w));
    if (named.length === 0 || lower(evidence).includes(phrase)) return false;
    // …and the claim's own figure is nowhere on the evidence side.
    const cp = principal(numberTokens(claim, { keepSourceLabel: true }));
    if (cp && !numberTokens(evidence, { keepSourceLabel: true }).some((t) => tokensMatch(cp, t))) return true;
  }
  return false;
}

/** Why a finding should be dropped, or null to keep it. */
export function dropReason(item: DiscrepancyCandidateLike, today: Date = new Date()): DropReason | null {
  if (isMissingSide(item.interviewValue) || isMissingSide(item.documentValue)) return "missing_side";
  if (sidesEquivalent(item.interviewValue ?? "", item.documentValue ?? "", today)) return "equal";
  if (isAdjustedVsReported(item)) return "adjusted_vs_reported";
  const claim = item.interviewValue ?? "";
  const evidence = item.documentValue ?? "";
  if (!DATE_LIKE_FIELD_RE.test(item.field ?? "")) {
    const aligned = periodAlignment(claim, evidence, item.field) ?? periodAlignment(evidence, claim, item.field);
    if (aligned === "same") return "equal";
    if (aligned === "different_periods") return "different_periods";
  }
  if (differentMoneyMeasures(claim, evidence)) return "different_measures";
  if (modelReasonedNoConflict(item)) return "not_a_conflict";
  // The model's own verdict (the check asks for it; the financial analysis doesn't).
  if (item.relation === "proposed_vs_current") return "proposed_vs_current";
  if (item.relation === "same_value" || item.relation === "different_things") return "not_a_conflict";
  if (selfDeclaredNonConflict(item)) return "not_a_conflict";
  return null;
}

export function filterDiscrepancyItems<T extends DiscrepancyCandidateLike>(items: T[], today: Date = new Date()): FilterResult<T> {
  const kept: T[] = [];
  const dropped: FilterResult<T>["dropped"] = [];
  for (const item of items) {
    const reason = dropReason(item, today);
    if (reason) dropped.push({ item, reason });
    else kept.push(item);
  }
  return { kept, dropped };
}
