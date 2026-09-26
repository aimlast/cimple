/**
 * conflict-measures.ts — when two values the fact merge saw for one fact are
 * NOT one fact disputed, and when two values that look unrelated are.
 *
 * A merge discrepancy ("merge" row, merge-conflicts.ts) must only ever put a
 * real disagreement in front of the broker. Two figures that differ can be:
 *  - the same figure: the parts one source lists add up to the other's total
 *    ("$150,000 in July; $250,000 in December" = "$400,000");
 *  - two measures: a quarter, a year-to-date or an ARR/MRR run-rate against
 *    a fiscal year; a share of receivables against a share of revenue;
 *  - two definitions: a tax return's figure against the financial
 *    statements' (taxable vs book income, tax depreciation vs book
 *    depreciation) — the financial analysis reconciles those with context;
 *  - a part against the whole: one owner's salary against the total
 *    shareholder salaries, a salary against total compensation;
 *  - two periods: the FY2022 statements against an FY2024 figure.
 * And two narrative values can disagree materially although no figure key
 * is involved: "medical is about a third of revenue" against "Medical 24% of
 * 2024 sales" (shareClaimsConflict).
 *
 * Pure — no storage, no model.
 */
import { typedNumericValues } from "../interview/info-merger";

/** One side of a possible conflict: its value and what is known of its source. */
export interface ConflictSideInfo {
  value: string;
  /** Source kind (document, email, call, interview, broker, crm…). */
  kind?: string;
  /** The source row's title (a documents row's name), when known. */
  title?: string;
  /** The fiscal period the value is for (ISO yyyy-mm-dd), when known. */
  period?: string;
}

// ─── Measures ────────────────────────────────────────────────────────────────

/** What kind of period a figure's own words say it covers. Untagged = a fiscal year's figure. */
const MEASURE_TAGS: Array<[string, RegExp]> = [
  ["run-rate", /\b(?:arr|mrr|run[- ]?rate|annuali[sz]ed|annual recurring|monthly recurring|recurring revenue run)\b/i],
  [
    "part-year",
    /\b(?:ytd|year[- ]to[- ]date|q[1-4]|(?:first|second|third|fourth|1st|2nd|3rd|4th|last|latest|this|current) quarter|quarterly|first half|second half|h[12]|interim|part[- ]year|partial year|\d{1,2} months|months ended|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?)\s*(?:-|–|—|to|through|thru)\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i,
  ],
  ["monthly", /(?:\/\s?(?:mo|mth|month)\b|\bper month\b|\ba month\b|\bmonthly\b)/i],
  ["forecast", /\b(?:budget(?:ed)?|forecast(?:ed)?|projected|projections?|pro ?forma|outlook)\b/i],
];

/** The measure tags a value's own words give it (empty = a plain fiscal-year figure). */
export function measureTags(value: string): Set<string> {
  const out = new Set<string>();
  for (const [tag, re] of MEASURE_TAGS) if (re.test(value)) out.add(tag);
  // "$8,000/month ($96,000 annually)" states the annual figure too.
  if (out.has("monthly") && /\b(?:annual(?:ly)?|per year|a year|\/\s?(?:yr|year))\b/i.test(value) && !out.has("run-rate")) out.delete("monthly");
  return out;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && Array.from(a).every((x) => b.has(x));
}

/** What a percentage is a share of, by the words next to it. */
const PERCENT_BASES: Array<[string, RegExp]> = [
  ["receivables", /\b(?:a\/?r|receivables?|aging|ageing)\b/i],
  ["margin", /\bgross (?:margin|profit)\b|\bgm\b|\bmargin dollars\b/i],
  ["earnings", /\b(?:ebitda|sde|net income|net profit|earnings)\b/i],
  ["headcount", /\b(?:staff|employees|headcount|workforce)\b/i],
  ["revenue", /\b(?:revenue|revenues|sales|billings?|mrr|arr|turnover|top line)\b/i],
];

function percentBases(value: string): Set<string> {
  const out = new Set<string>();
  for (const [base, re] of PERCENT_BASES) if (re.test(value)) out.add(base);
  return out;
}

const currencies = (v: string) => typedNumericValues(v).filter((t) => t.kind === "currency").map((t) => t.value);
const percents = (v: string) => typedNumericValues(v).filter((t) => t.kind === "percent").map((t) => t.value);
const close = (x: number, y: number, tol: number) => {
  const base = Math.max(Math.abs(x), Math.abs(y));
  return base === 0 || Math.abs(x - y) / base <= tol;
};

/**
 * True when the figures one side lists add up to a figure the other states
 * ("Tangible $96,400, intangible $42,000" = "$138,400").
 */
export function sumOfPartsMatches(a: string, b: string, tolerance = 0.01): boolean {
  const check = (parts: number[], wholes: number[]) =>
    parts.length >= 2 && wholes.length >= 1 && wholes.some((w) => close(parts.reduce((s, x) => s + x, 0), w, tolerance));
  return check(currencies(a), currencies(b)) || check(currencies(b), currencies(a));
}

// ─── Tax returns vs the statements ───────────────────────────────────────────

/** A tax return (Canadian T2, US 1120/1120-S/1065, a notice of assessment) by its title. */
export const TAX_RETURN_TITLE = /\b(?:t2|t1|t4|t5|1120(?:-?s)?|1065|schedule c|tax returns?|notice of (?:re)?assessment|gifi|tax year)\b/i;

/** Facts a tax return and the statements should report alike (gross receipts ≈ revenue). */
const SAME_ON_BOTH_BASES = /^(?:annualRevenue|revenue|revenueByYear|grossReceipts\w*|sales\w*)$/;

// ─── Owner pay: part vs whole ────────────────────────────────────────────────

const OWNER_PAY_KEY = /^(?:owners?(?:Salary|Salaries|Compensation|Comp|Pay|Wages?|Draws?|Remuneration|Benefits?)|shareholders?(?:Salary|Salaries|Compensation|Remuneration|Wages?)|management(?:Salary|Salaries|Compensation)|officers?(?:Compensation|Salaries)|ownerSalaryByYear|ownerCompensationByYear)$/i;
const AGGREGATE_WORDS = /\b(?:total|combined|together|shareholders'?|all (?:owners|shareholders|partners|directors)|both (?:owners|shareholders|partners)|family|management salaries|incl(?:uding|\.)?|plus|all[- ]in)\b|\+/i;
const COMPONENT_WORDS = /\b(?:dividends?|bonus(?:es)?|benefits?|perks?|personal (?:expenses?|use)|vehicle|t5|draws?|distributions?)\b/i;

export function isOwnerPayKey(key: string): boolean {
  return OWNER_PAY_KEY.test(key);
}

// ─── Segment share claims ────────────────────────────────────────────────────

const FRACTIONS: Array<[RegExp, number]> = [
  [/\b(?:two[- ]thirds)\b/i, 66.7],
  [/\b(?:three[- ]quarters)\b/i, 75],
  [/\b(?:a|one)[- ](?:third)\b/i, 33.3],
  [/\b(?:a|one)[- ](?:quarter)\b/i, 25],
  [/\b(?:a|one)[- ](?:half)\b|\bhalf\b/i, 50],
  [/\b(?:a|one)[- ](?:fifth)\b/i, 20],
  [/\b(?:a|one)[- ](?:tenth)\b/i, 10],
];

const SEGMENT_STOP = new Set([
  "about", "approximately", "approx", "roughly", "around", "nearly", "almost", "over", "under", "just", "now", "currently",
  "today", "is", "are", "was", "were", "be", "makes", "make", "made", "up", "accounts", "account", "for", "represents",
  "represent", "of", "the", "a", "an", "our", "their", "its", "his", "her", "and", "or", "total", "share", "portion",
  "percent", "per", "cent", "in", "on", "at", "by", "to", "from", "with", "as", "that", "this", "which", "it", "we", "they",
  "revenue", "revenues", "sales", "billings", "billing", "gross", "margin", "profit", "dollars", "income", "turnover",
  "year", "fy", "last", "one", "two", "three", "third", "thirds", "quarter", "quarters", "half", "fifth", "tenth",
  "more", "less", "than", "only", "still", "some", "so", "very", "business", "company", "overall", "mix", "split",
  "segment", "line", "lines", "stream", "streams", "comes", "come", "coming", "generates", "generate", "worth", "roughly",
]);

interface ShareClaim {
  segment: Set<string>;
  share: number;
  base: string | undefined;
  /** The fiscal year the claim is about, when the text names one. */
  year: string | undefined;
}

/**
 * Clauses of a narrative value: top-level text split at ; , " / " and
 * sentence ends, each parenthetical its own clause marked as such (it is
 * about the clause before it and never sets the segment or base after it).
 */
function clauses(text: string): Array<{ text: string; paren: boolean }> {
  const parts: Array<{ text: string; paren: boolean }> = [];
  let depth = 0;
  let buf = "";
  for (const ch of text) {
    if (ch === "(") { parts.push({ text: buf, paren: depth > 0 }); buf = ""; depth++; continue; }
    if (ch === ")" && depth > 0) { parts.push({ text: buf, paren: true }); buf = ""; depth--; continue; }
    buf += ch;
  }
  parts.push({ text: buf, paren: depth > 0 });
  return parts.flatMap((p) =>
    p.text.split(/[;\n]|,(?!\d{3})|(?<=[.!?])\s+|\s[—–-]\s|\s\/\s/).map((c) => ({ text: c.trim(), paren: p.paren })).filter((c) => c.text));
}

/** Every share a clause states, in order: "62%", "a third". */
function sharesIn(clause: string): Array<{ share: number; start: number; end: number }> {
  const out: Array<{ share: number; start: number; end: number }> = [];
  for (const m of Array.from(clause.matchAll(/(\d{1,3}(?:\.\d+)?)\s?(?:%|percent\b)/gi))) {
    out.push({ share: Number(m[1]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  for (const [re, v] of FRACTIONS) {
    for (const m of Array.from(clause.matchAll(new RegExp(re.source, "gi")))) {
      const start = m.index ?? 0;
      if (out.some((o) => start < o.end && start + m[0].length > o.start)) continue;
      out.push({ share: v, start, end: start + m[0].length });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

function clauseBase(clause: string): string | undefined {
  // "of revenue", "of 2024 sales", "of gross margin dollars", "of MRR", "of AR".
  const m = clause.match(/\bof\s+(?:(?:the|our|total|all|its|their|(?:fy\s?)?(?:19|20)\d{2}|annual|company)\s+)*([a-z/]+(?:\s+[a-z]+)?)/i);
  const around = m ? m[1] : clause;
  for (const [base, re] of PERCENT_BASES) if (re.test(around)) return base;
  return undefined;
}

function clauseSegment(clause: string): Set<string> {
  const words = clause
    .toLowerCase()
    .replace(/\d[\d,.]*\s?%?/g, " ")
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2 && !SEGMENT_STOP.has(w) && !PERCENT_BASES.some(([, re]) => re.test(w)));
  return new Set(words.map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)));
}

/**
 * The share claims a value makes: "Medical 24% of 2024 sales" → {medical,
 * 24, revenue}; "Automotive 62% / Medical 24%" → one claim each; a
 * parenthetical with no segment of its own ("(approximately one-third of
 * gross margin dollars)") is about the segment before it.
 */
export function shareClaims(text: string): ShareClaim[] {
  const out: ShareClaim[] = [];
  const allYears = Array.from(new Set(text.match(/\b(?:19|20)\d{2}\b/g) ?? []));
  let lastSegment = new Set<string>();
  let lastBase: string | undefined;
  for (const { text: clause, paren } of clauses(text)) {
    const shares = sharesIn(clause);
    const own = clause.match(/\b(?:19|20)\d{2}\b/);
    const year = own ? own[0] : allYears.length === 1 ? allYears[0] : undefined;
    shares.forEach((s, i) => {
      if (s.share <= 0 || s.share > 100) return;
      const prevEnd = i > 0 ? shares[i - 1].end : 0;
      const nextStart = i + 1 < shares.length ? shares[i + 1].start : clause.length;
      let segment = clauseSegment(clause.slice(prevEnd, s.start));
      if (segment.size === 0) segment = clauseSegment(clause.slice(s.end, nextStart));
      if (segment.size === 0) segment = lastSegment;
      if (segment.size === 0) return;
      // "automotive about 62%" in a list after "Medical 24% of sales" is a share of sales too.
      const base = clauseBase(clause.slice(s.start, nextStart)) ?? clauseBase(clause) ?? (paren ? undefined : lastBase);
      if (!paren) {
        lastSegment = segment;
        lastBase = base;
      }
      out.push({ segment, share: s.share, base, year });
    });
  }
  return out;
}

/**
 * True when two values give materially different shares for the same
 * segment of the same base ("medical is about a third of revenue" vs
 * "Medical 24% of 2024 sales"): at least 5 points and 15% apart.
 */
export function shareClaimsConflict(a: string, b: string, yearA?: string, yearB?: string): boolean {
  if (!a || !b) return false;
  // A claim with no year in its words is for its source's period, when known.
  const ca = shareClaims(a).map((c) => ({ ...c, year: c.year ?? yearA }));
  const cb = shareClaims(b).map((c) => ({ ...c, year: c.year ?? yearB }));
  if (ca.length === 0 || cb.length === 0) return false;
  let agree = false;
  let differ = false;
  for (const x of ca) {
    for (const y of cb) {
      if (!x.base || !y.base || x.base !== y.base) continue;
      // Shares for two different years are history, not a dispute.
      if (x.year && y.year && x.year !== y.year) continue;
      if (!Array.from(x.segment).some((w) => y.segment.has(w))) continue;
      const gap = Math.abs(x.share - y.share);
      if (gap < 5 || gap / Math.max(x.share, y.share) < 0.15) agree = true;
      else differ = true;
    }
  }
  return differ && !agree;
}

// ─── The verdict ─────────────────────────────────────────────────────────────

const periodYear = (p?: string) => (p && /^\d{4}/.test(p) ? p.slice(0, 4) : undefined);

/**
 * Why two differing values for `factKey` are NOT one fact disputed, or null
 * when they are a real conflict a broker must look at.
 */
export function falseConflictReason(factKey: string, x: ConflictSideInfo, y: ConflictSideInfo): string | null {
  const a = x.value ?? "";
  const b = y.value ?? "";
  const baseKey = factKey.replace(/ByYear$/, "");
  const figures = currencies(a).length > 0 && currencies(b).length > 0;
  // The same figure: one lists the parts of the other's total.
  if (figures && sumOfPartsMatches(a, b)) return "the parts one source lists add up to the other's total";
  // Two measures: a quarter / YTD / run-rate / monthly / budget figure vs a year's.
  if (figures && !sameSet(measureTags(a), measureTags(b))) return "different measures (a part-year, run-rate or monthly figure vs a year's)";
  // Two shares of different things (receivables vs revenue).
  if (percents(a).length > 0 && percents(b).length > 0) {
    const pa = percentBases(a);
    const pb = percentBases(b);
    if (pa.size > 0 && pb.size > 0 && !Array.from(pa).some((p) => pb.has(p))) return "shares of different things (e.g. of receivables vs of revenue)";
  }
  // Two definitions: a tax return against the statements (or another document).
  const taxA = x.kind === "document" && !!x.title && TAX_RETURN_TITLE.test(x.title);
  const taxB = y.kind === "document" && !!y.title && TAX_RETURN_TITLE.test(y.title);
  if (x.kind === "document" && y.kind === "document" && taxA !== taxB && !SAME_ON_BOTH_BASES.test(factKey) && !SAME_ON_BOTH_BASES.test(baseKey)) {
    return "a tax return and the statements define this figure differently";
  }
  // Two periods: sources for different fiscal years differing is history.
  const ya = periodYear(x.period);
  const yb = periodYear(y.period);
  if (figures && ya && yb && ya !== yb && (x.kind === "document" || y.kind === "document")) return "figures for different fiscal years";
  // Owner pay: one owner vs all shareholders, salary vs total compensation.
  if (isOwnerPayKey(factKey) && figures) {
    const ca = currencies(a);
    const cb = currencies(b);
    const [parts, whole] = ca.length >= 2 && cb.length === 1 ? [ca, cb[0]] : cb.length >= 2 && ca.length === 1 ? [cb, ca[0]] : [null, 0];
    if (parts && parts.reduce((s, v) => s + v, 0) < whole * 0.95) return "one owner's pay against the total for all owners";
    if (AGGREGATE_WORDS.test(a) !== AGGREGATE_WORDS.test(b)) return "one owner's pay against the total for all owners";
    if (COMPONENT_WORDS.test(a) !== COMPONENT_WORDS.test(b)) return "a salary against total compensation";
  }
  return null;
}

/** True when a tax-return side and a statements side are compared for a fact both should report alike (revenue): worth a look, rarely an error. */
export function isTaxVsBook(factKey: string, x: ConflictSideInfo, y: ConflictSideInfo): boolean {
  const taxA = x.kind === "document" && !!x.title && TAX_RETURN_TITLE.test(x.title);
  const taxB = y.kind === "document" && !!y.title && TAX_RETURN_TITLE.test(y.title);
  return x.kind === "document" && y.kind === "document" && taxA !== taxB && (SAME_ON_BOTH_BASES.test(factKey) || SAME_ON_BOTH_BASES.test(factKey.replace(/ByYear$/, "")));
}
