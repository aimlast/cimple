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
}

export type DropReason = "equal" | "missing_side" | "adjusted_vs_reported" | "proposed_vs_current" | "not_a_conflict";

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
}

const APPROX_BEFORE_RE = /(?:~|≈|\babout|\bapprox\.?|\bapproximately|\baround|\broughly|\bover|\bmore than|\bunder|\bless than|\bnearly|\balmost|\bestimated|\bsome|\bclose to)\s*\$?\s*$/;

const MAG: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };

/** Every quantity in a value, with its unit and surroundings. */
export function numberTokens(text: string, opts: { keepSourceLabel?: boolean } = {}): NumTok[] {
  let t = (opts.keepSourceLabel ? text : stripLabel(text)).toLowerCase();
  // Days of the month are not quantities: "December 31, 2024" → "december 2024".
  t = t.replace(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?![0-9]),?`, "g"), "$1 ");
  t = t.replace(/\b(\d{4})-\d{2}-\d{2}\b/g, "$1");
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
    out.push({ value: n, pct, year, durationYears, period, approx, raw: m[0].trim(), unitWord, context });
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
// The same verdict in other words (Beacon: "The seller stated the option
// window opens in 2028, which is correct. … This is consistent - the
// seller's statement … aligns with the lease terms."). Each names the two
// sides agreeing — "the document shows 2029, which is correct" (one side
// right, the other wrong) is NOT matched.
const CONSISTENT_RE = new RegExp(
  [
    // "This is consistent", "This is fully consistent", "which is consistent with the lease"
    String.raw`\b(?:this|that|it|which)\s+(?:is|are|was|seems|appears)\s+(?:(?:fully|entirely|broadly|largely|therefore|also)\s+)?(?:consistent|compatible|in line|aligned|in agreement)\b`,
    // "the two (sources|values|figures|statements) are consistent/agree/align"
    String.raw`\b(?:both|the two|these)\s+(?:sources?|values?|figures?|statements?|numbers?)?\s*(?:are\s+)?(?:consistent|agree|align|match|reconcile)\b`,
    // "the seller's statement … aligns with / is consistent with / matches the lease"
    String.raw`\b(?:seller(?:'s|’s)?|claim|statement|interview (?:value|answer))\b[^.;]{0,120}\b(?:aligns with|is consistent with|agrees with|matches|is supported by|is confirmed by|reconciles (?:to|with))\s+(?:the\s+)?(?:document|lease|contract|statement|statements|records?|report|roster|schedule|agreement|file|terms)\b`,
    // "The seller stated … which is correct / is accurate"
    String.raw`\bseller\s+(?:stated|said|reported|claimed|indicated|mentioned|confirmed)\b[^.;]{0,160}\b(?:which|this|that)\s+is\s+(?:correct|accurate|right)\b`,
    // "No conflict - both sources agree" (the suggested resolution often says so)
    String.raw`^\s*no (?:real |actual )?(?:conflict|discrepancy)\b`,
  ].join("|"),
  "i",
);

// Proposed / future terms compared with the terms in force — not a conflict
// (Ridgeline: "The $12.50 rate is for a proposed future lease, not the
// current rate").
const PROSPECTIVE_VS_CURRENT_RE =
  /\b(?:proposed|prospective|future|draft|planned|new|renewal|renegotiated|offered|quoted|pending)\b[^.;]{0,60}\b(?:not|rather than|as opposed to|versus|vs\.?|instead of)\s+(?:the\s+)?(?:current|existing|in-force|present)\b|\bnot\s+the\s+(?:current|existing|in-force|present)\s+(?:rate|rent|term|terms|lease|price|contract|agreement)\b/i;
const CONTRAST_AFTER_RE = /\b(?:but|however|although|though|yet|except)\b/i;

/**
 * The model reported a finding and, in its own explanation, said it isn't a
 * conflict — in so many words, or by saying the two sides agree, or that
 * one side is a proposed/future term and the other the current one. Only
 * for non-critical findings, and only when nothing after that statement
 * walks it back ("not a conflict on the date, but the amount…").
 */
export function selfDeclaredNonConflict(item: DiscrepancyCandidateLike): boolean {
  if ((item.severity ?? "").toLowerCase() === "critical") return false;
  const text = item.explanation ?? item.aiExplanation ?? "";
  for (const re of [NOT_A_CONFLICT_RE, CONSISTENT_RE, PROSPECTIVE_VS_CURRENT_RE]) {
    const m = text.match(re);
    if (m && m.index !== undefined && !CONTRAST_AFTER_RE.test(text.slice(m.index + m[0].length))) return true;
  }
  // "No conflict - both sources agree …" as the suggested resolution.
  const suggestion = item.suggestedResolution ?? "";
  const s = suggestion.match(/^\s*no (?:real |actual )?(?:conflict|discrepancy)\b/i);
  return !!s && !CONTRAST_AFTER_RE.test(suggestion);
}

// A value the seller gives as a proposed / future / not-yet-agreed term.
const PROSPECTIVE_VALUE_RE =
  /\b(?:proposed|prospective|future|planned|draft|pending|new|renewal)\s+(?:[a-z-]+\s+){0,2}(?:lease|rate|rent|term|terms|contract|agreement|price|renewal|extension|arrangement)\b|\b(?:under negotiation|being negotiated|to be negotiated|not yet (?:signed|agreed|final|executed))\b/i;
const CURRENT_VALUE_RE = /\b(?:current|existing|in[- ]force|present|signed|as of|per (?:the )?(?:current |existing )?(?:lease|contract|agreement))\b/i;

/**
 * The seller-side value is explicitly a proposed / future term and the
 * document states the terms in force ("$12.50/sq ft proposed new lease" vs
 * "$12.00/sq ft for years 3-5 per current lease") — two different things.
 * Directional on purpose: a document's option or proposal against a seller
 * who states it as current fact ("expires 2034" vs "to 2029, option to
 * 2034") IS a conflict and is kept.
 */
export function isProposedVsCurrent(item: DiscrepancyCandidateLike): boolean {
  const claim = stripLabel(item.interviewValue ?? "");
  const doc = stripLabel(item.documentValue ?? "");
  return PROSPECTIVE_VALUE_RE.test(claim) && !PROSPECTIVE_VALUE_RE.test(doc) && (CURRENT_VALUE_RE.test(doc) || !CURRENT_VALUE_RE.test(claim));
}

/** Why a finding should be dropped, or null to keep it. */
export function dropReason(item: DiscrepancyCandidateLike, today: Date = new Date()): DropReason | null {
  if (isMissingSide(item.interviewValue) || isMissingSide(item.documentValue)) return "missing_side";
  if (sidesEquivalent(item.interviewValue ?? "", item.documentValue ?? "", today)) return "equal";
  if (isAdjustedVsReported(item)) return "adjusted_vs_reported";
  if (isProposedVsCurrent(item)) return "proposed_vs_current";
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
