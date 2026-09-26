/**
 * source-context — what the interview knows about its SOURCES, beyond the
 * one-value-per-fact list:
 *
 *  - per-source digests (the extractor's summary + key facts), so the agent
 *    knows what each call, email and document actually covers — before this
 *    it saw only file names and treated anything extraction missed as unknown
 *    ("Who is Megan?" while the org chart lists her);
 *  - the risks the sources flag (red flags, seller concerns) — the items a
 *    buyer's diligence will ask about first;
 *  - conflicts between sources (a figure said on a call vs. the document
 *    that shows another), so the agent reconciles them instead of repeating
 *    whichever value happened to win;
 *  - a digest of earlier sessions' questions and answers, so a returning
 *    seller is never asked the same thing twice;
 *  - a keyword search over the sources' text, used to catch a question whose
 *    answer is already written down somewhere.
 *
 * Everything here reads seller-visible sources only: a broker-only row (CRM
 * notes, private emails and files) is never digested, searched or quoted.
 * Pure, except for an in-memory chunk cache.
 */
import type { Document, InterviewSession, ConversationMessage, Discrepancy } from "@shared/schema";
import {
  getFieldSources,
  getFieldAlternates,
  isFactKey,
  repairCharIndexedValue,
  type FieldAlternate,
  type FieldSource,
} from "./info-merger";

type DocLike = Pick<Document, "id" | "name" | "visibility"> & Partial<Pick<Document, "sourceKind" | "sourceMeta" | "createdAt" | "extractedData" | "extractedText" | "isProcessed" | "status" | "category" | "updatedAt">>;

const isSellerVisible = (d: Pick<Document, "visibility">) => d.visibility !== "broker_only";
/** Kinds that are leads, never evidence the seller must reconcile against. */
const LEAD_KINDS = new Set(["crm", "website", "social"]);
/** The seller speaking (typed or spoken) — or writing, or filling the intake. */
const SPOKEN_KINDS = new Set(["interview", "call", "video_call", "email", "questionnaire"]);

// =====================
// Labels
// =====================

function shortDate(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(value as string);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function docDate(doc: DocLike | undefined): string | null {
  if (!doc) return null;
  return shortDate((doc.sourceMeta as { date?: string } | null | undefined)?.date ?? doc.createdAt ?? null);
}

/** "document: 2024 P&L.pdf", "a call transcript (Mar 3, 2026)", "the seller in the interview" … */
export function sourceLabel(src: Partial<FieldSource> | undefined, docs: Map<string, DocLike>): string {
  if (!src) return "on file";
  const doc = src.documentId ? docs.get(src.documentId) : undefined;
  const date = docDate(doc);
  switch (src.source) {
    case "interview": return "the seller in the interview";
    case "call": return doc ? `said on a call${date ? ` (${date})` : ""}` : "said on a call with the broker";
    case "video_call": return doc ? `said on a video call${date ? ` (${date})` : ""}` : "said on a video call with the broker";
    case "questionnaire": return "the seller's intake questionnaire";
    case "email": return `an email${date ? ` (${date})` : ""}`;
    case "broker": return "the broker";
    case "document": return doc ? `document: ${doc.name}` : "an uploaded document";
    default: return doc ? `${doc.name}` : String(src.source ?? "on file");
  }
}

function kindLabel(doc: DocLike): string {
  switch (doc.sourceKind) {
    case "call": return "call transcript";
    case "video_call": return "video-call transcript";
    case "email": return "email";
    case "website": return "website capture (unverified)";
    case "social": return "social media (unverified)";
    case "crm": return "CRM note";
    default: return "document";
  }
}

const trim = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return `${cut.slice(0, sp > n * 0.6 ? sp : n)}…`;
};

// =====================
// Digests
// =====================

export interface SourceDigest {
  id: string;
  name: string;
  kind: string;
  date: string | null;
  summary: string;
  keyFacts: string;
}

/** Per seller-visible, processed source: what it is and what it says (≈400 characters). */
export function buildSourceDigests(documents: DocLike[], maxChars = 420): SourceDigest[] {
  const out: SourceDigest[] = [];
  for (const d of documents) {
    if (!isSellerVisible(d)) continue;
    const data = (d.extractedData as Record<string, unknown> | null | undefined) || null;
    if (!data) continue;
    const summary = typeof data.summary === "string" && !/^extraction failed/i.test(data.summary) ? data.summary : "";
    const keyFacts = typeof data.keyFacts === "string" ? data.keyFacts : Array.isArray(data.keyFacts) ? data.keyFacts.join(", ") : "";
    if (!summary && !keyFacts) continue;
    const s = trim(summary, Math.min(220, maxChars));
    const k = trim(keyFacts, Math.max(120, maxChars - s.length));
    out.push({ id: d.id, name: d.name, kind: kindLabel(d), date: docDate(d), summary: s, keyFacts: k });
  }
  return out;
}

// =====================
// Flagged risks
// =====================

export interface FlaggedRisk {
  /** Short, stable label — also the ledger topic ("risk: <label>"). */
  label: string;
  /** The risk as a source states it. */
  text: string;
  /** Where it was flagged. */
  sources: string[];
}

/**
 * Splits a list of flags into items: at semicolons, line breaks and sentence
 * ends, and at commas when the pieces stand on their own — a piece that
 * continues a phrase ("…contracts, non-competes, or non-solicits…") stays
 * joined. Commas inside parentheses and numbers never split.
 */
export function splitList(text: string): string[] {
  const out: string[] = [];
  for (const chunk of splitAt(text, true)) {
    const pieces = splitAt(chunk, false);
    const merged: string[] = [];
    for (const piece of pieces) {
      const continues = /^(?:or|and|nor|but|which|who|that|including|such as|as well as|plus|with|to|of|for|non-\w+)\b/i.test(piece) || piece.length < 18;
      if (merged.length > 0 && continues) merged[merged.length - 1] += `, ${piece}`;
      else merged.push(piece);
    }
    // A short first piece ("No employment contracts") belongs with what follows.
    if (merged.length > 1 && merged[0].length < 18) merged.splice(0, 2, `${merged[0]}, ${merged[1]}`);
    out.push(...merged);
  }
  return out;
}

/** One level of splitting: sentences/semicolons (`strong`) or commas. */
function splitAt(text: string, strong: boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[") depth++;
    if ((c === ")" || c === "]") && depth > 0) depth--;
    const next = text[i + 1] ?? "";
    // A comma inside a number ("$410,000") is not a separator.
    const numericComma = c === "," && /\d/.test(text[i - 1] ?? "") && /\d/.test(next);
    const sentenceEnd = c === "." && /\s/.test(next) && /[a-z)]/i.test(text[i - 1] ?? "") && !/\b(?:inc|ltd|co|corp|st|dr|mr|mrs|ms|no|vs|approx|e\.g|i\.e)$/i.test(cur.trim());
    const separator = strong ? c === ";" || c === "\n" || sentenceEnd : c === "," && !numericComma;
    if (depth === 0 && separator) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Risks a buyer's diligence goes after first. */
export const MATERIAL_RISK_RE =
  /concentrat|terminat|for convenience|change of control|consent|lawsuit|litigation|claim|dismissal|settle|guarantee|union|retir|succession|leav(?:e|ing)|non-?compete|expir|renewal|lease|decline|loss|theft|audit|violation|warning|enforcement|recall|breach|default|covenant|capex|replace|aging|compet|depend/i;
const NOT_A_RISK_RE = /^(none|n\/a|no (?:red flags|concerns|issues)|nothing|not (?:applicable|stated|identified))\b|none (?:explicitly |were )?(?:stated|identified|noted|found)|sample|fictional|demonstration/i;

const RISK_STOP = new Set(
  "the and for with from that this which were was are has have had its their per not but also any all one two three into over under about than more most some such other only very will would could should been being due".split(" "),
);
/** Content stems of a sentence (lower-case, ≥3 letters or digits, first 5 characters). */
export function stemsOf(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) ?? [])
      .map((w) => w.replace(/['’]s$/, ""))
      .filter((w) => (w.length >= 3 || /\d/.test(w)) && !RISK_STOP.has(w))
      .map((w) => w.slice(0, 5)),
  );
}
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  a.forEach((x) => { if (b.has(x)) n++; });
  return n / Math.min(a.size, b.size);
}

function riskLabel(text: string): string {
  const t = text.replace(/\s+/g, " ").replace(/^[-–•*\s]+/, "").trim();
  const cut = t.split(/\s*[(:—–]\s*/)[0] || t;
  // Cut at a word, never ending on a dangling little word ("…costs of $40-50K not").
  return trim(cut.length >= 24 ? cut : t, 64)
    .replace(/…$/, "")
    .replace(/\s+(?:not|of|the|to|and|or|a|an|in|on|for|with|by|from|at|as|is|are|was|were)$/i, "")
    .trim();
}

/**
 * The risks seller-visible sources flag (extractor redFlags + seller
 * concerns), split into items, deduplicated across sources, most-flagged
 * first, capped. Broker-only rows (CRM notes, private files) are skipped.
 */
export function buildFlaggedRisks(documents: DocLike[], cap = 12): FlaggedRisk[] {
  const items: { text: string; stems: Set<string>; sources: string[]; kinds: Set<string>; order: number }[] = [];
  let order = 0;
  for (const d of documents) {
    if (!isSellerVisible(d) || LEAD_KINDS.has(String(d.sourceKind))) continue;
    const data = (d.extractedData as Record<string, unknown> | null | undefined) || null;
    if (!data) continue;
    for (const field of ["redFlags", "sellerConcerns"]) {
      const raw = data[field];
      const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join("; ") : "";
      if (!text.trim()) continue;
      for (const part of splitList(text)) {
        const t = part.replace(/^(and|also)\s+/i, "").trim();
        if (t.length < 12 || NOT_A_RISK_RE.test(t)) continue;
        const stems = new Set(Array.from(stemsOf(t)).filter((w) => !/\d/.test(w)));
        const dup = items.find((x) => overlap(x.stems, stems) >= 0.5);
        if (dup) {
          if (!dup.sources.includes(d.name)) dup.sources.push(d.name);
          dup.kinds.add(String(d.sourceKind || "document"));
          if (t.length > dup.text.length && t.length < 260) { dup.text = t; dup.stems = stems; }
          continue;
        }
        items.push({ text: t, stems, sources: [d.name], kinds: new Set([String(d.sourceKind || "document")]), order: order++ });
        continue;
      }
    }
  }
  // Most material first: what a buyer's diligence asks about (a contract
  // that can end, a claim, a guarantee, a departure…), then how widely it
  // is flagged (a call and a document beat three tax returns).
  const score = (x: (typeof items)[number]) =>
    (MATERIAL_RISK_RE.test(x.text) ? 2 : 0) +
    (Array.from(x.kinds).some((k) => SPOKEN_KINDS.has(k)) ? 1 : 0) +
    Math.min(x.kinds.size, 2) +
    Math.min(x.sources.length, 3) * 0.5;
  return items
    .sort((a, b) => score(b) - score(a) || a.order - b.order)
    .slice(0, cap)
    .map((x) => ({ label: riskLabel(x.text), text: trim(x.text, 240), sources: x.sources }));
}

// =====================
// Conflicts between sources
// =====================

export interface SourceConflict {
  /** The fact key (or a short topic when the conflict spans facts). */
  key: string;
  /** What the conflict is about, in plain words. */
  topic: string;
  /** documentId: the row a side quotes, when known (the source review stamps it) — re-checked against its visibility on every read. */
  values: { value: string; source: string; documentId?: string }[];
  /** Blocks the interview's end until reconciled (revenue, earnings, owner pay…). */
  critical: boolean;
  origin: "alternates" | "merge" | "review";
}

/** Facts whose conflicts must be reconciled before the interview may end on its own. */
export const CRITICAL_CONFLICT_RE =
  /revenue|sales|sde|ebitda|earnings|profit|net.?income|margin|owner.?(?:comp|salary|pay|wage|draw)|compensation|concentration|largest.?customer|top.?customer|lease|rent|tenure|years?.?(?:with|at|employed)|employees?|headcount|staff|backlog|asking.?price|debt/i;
const DATEISH_KEY_RE = /expir|until|renew|leaseTerm|date|founded|incorporat|since|start|established/i;
const FUTURE_RE = /\b(proposed|expected|projected|forecast|budget(?:ed)?|planned|target|new term|on renewal|next year|going forward)\b/i;
/** Facts about the documents themselves (which years, which firm) — never a seller conflict. */
const BOOKKEEPING_KEY_RE = /^(yearsOfData|taxYearEnd|fiscalYearEnd|yearEnd|accountingFirm|accountant|preparedBy|preparer|reportDate|documentDate|statementDate|periodCovered|reviewEngagement|companyName|legalName|yearsOperating|yearsInBusiness|businessAge|companyAge)$|^(taxYear|fiscalYear|period)/i;
/** Descriptive words of a value (numbers, units and filler dropped). */
const VALUE_FILLER = new Set(["about", "approximately", "approx", "around", "roughly", "total", "totals", "plus", "and", "the", "per", "year", "years", "annual", "annually", "each", "some", "over", "under", "nearly", "just", "than", "more", "less", "with", "for", "from", "including", "includes", "excluding", "est", "estimated", "said", "call", "per", "only", "currently", "current", "now", "today"]);
function wordsOf(text: string): Set<string> {
  return new Set(
    (stripLabelNumbers(text).toLowerCase().match(/[a-z][a-z'’-]{2,}/g) ?? [])
      .filter((w) => !VALUE_FILLER.has(w) && !/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(w))
      .map((w) => w.slice(0, 5)),
  );
}

const FRACTIONS: Array<[RegExp, number]> = [
  [/\bhalf\b/i, 50], [/\ba third\b|\bone third\b/i, 33.3], [/\ba quarter\b|\bone quarter\b/i, 25],
  [/\btwo thirds\b/i, 66.7], [/\bthree quarters\b/i, 75],
];

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
/** Dates ("March 12", "12/31/2024") and street numbers ("900 Summit Blvd") are labels, not quantities. */
function stripLabelNumbers(text: string): string {
  return text
    .replace(new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"), " ")
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b`, "gi"), " ")
    .replace(/\b\d{1,4}[/-]\d{1,2}[/-]\d{2,4}\b/g, " ")
    .replace(/\b\d+\s+(?:[A-Z][a-z]+\s+){1,3}(?:Blvd|Boulevard|St|Street|Ave|Avenue|Dr|Drive|Rd|Road|Way|Court|Ct|Lane|Ln|Crescent|Pkwy|Parkway|Highway|Hwy)\b\.?/g, " ")
    .replace(/\b(?:suite|unit|ste\.?|no\.?|#)\s*\d+\b/gi, " ");
}

/** The first figure a short value states, with its kind (percent vs amount/count). */
export function headlineNumber(text: string): { value: number; percent: boolean } | null {
  const t = stripLabelNumbers(text).replace(/\b(?:19|20)\d{2}\b(?!\s*%)/g, " "); // years are labels, not quantities
  const m = t.match(/(\$)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|million|thousand|b|billion)?(?![a-z0-9])\s*(%|percent\b)?/i);
  // A spelled count before the first digit ("Two 5-year options") is the headline.
  const spelled = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?!\s*(?:-|\s)?(?:year|month|week|day)s?\b)/i);
  if (spelled && (!m || (spelled.index ?? 0) < (m.index ?? 0))) {
    const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
    return { value: words.indexOf(spelled[1].toLowerCase()) + 1, percent: false };
  }
  if (m) {
    let n = parseFloat(m[2].replace(/,/g, ""));
    if (!Number.isNaN(n)) {
      const suf = (m[3] || "").toLowerCase();
      const mult: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
      if (suf) n *= mult[suf] ?? 1;
      return { value: n, percent: !!m[4] };
    }
  }
  for (const [re, pct] of FRACTIONS) if (re.test(text)) return { value: pct, percent: true };
  return null;
}

function years(text: string): number[] {
  // "FY2024" names 2024 too (there is no word boundary between Y and 2); a
  // figure's digits ("$2,019,500", "12019") are not a year.
  return (text.match(/(?<![\d$,.])(?:19|20)\d{2}(?![\d,])/g) ?? []).map(Number);
}

/**
 * Two values of the same fact that say materially different things: for
 * short values, their headline figures differ by more than 4% (3,100 vs
 * "2,900 active + 214 suspended"; 18% vs 22%; "a quarter" vs 41%); for
 * date-like facts, the latest year differs (lease to 2034 vs 2029). Long
 * narrative values aren't compared — too many incidental numbers.
 */
export function valuesMateriallyDiffer(
  key: string,
  a: string,
  b: string,
  /** Text naming each value's period when the value doesn't (its source's title, "Form 1120-S — tax year 2023"). */
  context: { a?: string; b?: string; asOf?: number } = {},
): boolean {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y || x.toLowerCase() === y.toLowerCase()) return false;
  if (BOOKKEEPING_KEY_RE.test(key)) return false;
  if (DATEISH_KEY_RE.test(key)) {
    // One side listing more dates than the other ("Hillhurst: May 31, 2027;
    // Seton: Aug 31, 2031" vs "May 31, 2027") is not a conflict — only dates
    // that share nothing are.
    const ya = years(x);
    const yb = years(y);
    if (ya.length > 0 && yb.length > 0 && !ya.some((v) => yb.includes(v)) && x.length <= 120 && y.length <= 120) return true;
  }
  if (x.length > 110 || y.length > 110) return false;
  // A proposed / expected figure vs the current one is a change, not a conflict.
  if (FUTURE_RE.test(x) !== FUTURE_RE.test(y)) return false;
  // Adjusted vs reported (EBITDA $6.1M adjusted vs $5.27M reported), gross vs
  // net, year-to-date vs a full year: different measures, not a conflict.
  // (Values only: a source's TITLE can mention "adjusted" without its figure being adjusted.)
  if (differentMeasure(x, y)) return false;
  // Different periods ("$7.96M at Dec 31, 2024" vs a 2023 return's figure)
  // are not a conflict — each year is its own fact.
  const ya = years(x).length ? years(x) : years(context.a ?? "");
  const yb = years(y).length ? years(y) : years(context.b ?? "");
  if (ya.length > 0 && yb.length > 0 && !ya.some((v) => yb.includes(v))) return false;
  // One side dated to an older period, the other current ("38 presses" said
  // now vs 34 in the FY2022 statements): the business changed in between.
  if (stalePeriod(ya, yb, context) || stalePeriod(yb, ya, context)) return false;
  // Different scope ("212 employees plus temps" vs "16 employees in quality"):
  // when both describe their figure, their words must mostly agree ("26
  // trucks" vs "24 service vans" is still compared).
  const wa = wordsOf(x);
  const wb = wordsOf(y);
  if (wa.size >= 2 && wb.size >= 2) {
    let shared = 0;
    wa.forEach((w) => { if (wb.has(w)) shared++; });
    if (shared / Math.min(wa.size, wb.size) < 0.5) return false;
  }
  const na = headlineNumber(x);
  const nb = headlineNumber(y);
  if (!na || !nb || na.percent !== nb.percent) return false;
  const base = Math.max(Math.abs(na.value), Math.abs(nb.value));
  if (base === 0) return false;
  if (Math.abs(na.value - nb.value) / base <= 0.04) return false;
  // The same count told two ways ("3 clinicians plus 5 admin" vs "8
  // employees (owner + 2 PTs + 5 admin)"): one side's parts add up exactly
  // to the other's headline.
  const partsA = plainNumbers(x);
  const partsB = plainNumbers(y);
  const sum = (ns: number[]) => ns.reduce((t, n) => t + n, 0);
  if ((partsA.length > 1 && sum(partsA) === nb.value) || (partsB.length > 1 && sum(partsB) === na.value)) return false;
  return true;
}

/** Words that name WHICH measure a figure is: adjusted vs reported, gross vs net, part of a year vs a full year. */
const MEASURE_QUALIFIERS: RegExp[] = [
  /\b(adjusted|normali[sz]ed|recast|pro[ -]?forma|add[- ]?backs?|run[- ]?rate)\b/i,
  /\b(gross)\b/i,
  /\b(ytd|year[- ]to[- ]date|so far this year|jan(?:uary)?\s*[-–]\s*(?:may|jun|jul|aug|sep|oct|nov)|q[1-4]|quarterly|(?:this|last|per|each|the first|the second|the third|the fourth) quarter|monthly|per month|a month|\/mo)\b/i,
];
/** True when exactly one side names a qualifier the other lacks (adjusted vs reported, gross vs net, YTD vs full year). */
export function differentMeasure(a: string, b: string): boolean {
  return MEASURE_QUALIFIERS.some((re) => re.test(a) !== re.test(b));
}

/**
 * One side is dated to a period OLDER than the deal's latest statements and
 * the other isn't dated at all (said now): "38 presses" said on a call vs 34
 * in the FY2022 statements, total debt in an email vs the 2023 return. What
 * the seller says now is reconciled against the latest documents, never
 * against an earlier year's — the business changed in between.
 */
function stalePeriod(older: number[], other: number[], context: { asOf?: number }): boolean {
  if (older.length === 0 || other.length > 0 || context.asOf === undefined) return false;
  return Math.max(...older) < context.asOf;
}

/** Titles of annual statements and returns — the documents that date "the latest year" of a deal. */
const ANNUAL_STATEMENT_RE = /\b(fy|fiscal|financial statements?|statements?|tax return|t2|1120|1065|p&l|profit (?:and|&) loss|income statement|balance sheet|annual report|year[- ]end)\b/i;

/**
 * The deal's latest fiscal year: the newest year named in the title of an
 * annual statement or tax return on file (FY2024 statements → 2024). A
 * point-in-time report ("WIP as of May 31, 2025") or a call's date doesn't
 * move it — a call in January 2026 still speaks against FY2024 statements.
 */
export function dealAsOfYear(documents: DocLike[]): number | undefined {
  let latest: number | undefined;
  for (const d of documents) {
    if (!ANNUAL_STATEMENT_RE.test(d.name) || String(d.sourceKind || "document") !== "document") continue;
    for (const y of years(d.name)) if (y <= new Date().getFullYear() + 1 && (latest === undefined || y > latest)) latest = y;
  }
  return latest;
}

/** Every figure in a value except years and date/address numbers. */
function plainNumbers(text: string): number[] {
  return (stripLabelNumbers(text).replace(/\b(?:19|20)\d{2}\b/g, " ").match(/\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((n) => parseFloat(n.replace(/,/g, "")))
    .filter((n) => !Number.isNaN(n));
}

const keyWords = (key: string) =>
  key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.]/g, " ").toLowerCase().trim();

/**
 * Conflicts visible in the interview's own view of the facts: a value said
 * (call, video call, email, questionnaire, interview) against a document's
 * value for the same fact. Document-vs-document differences (usually other
 * fiscal years) and leads (CRM, website) are left to the broker's
 * discrepancy review; a value the broker set is settled.
 */
export function detectAlternateConflicts(viewInfo: Record<string, unknown>, documents: DocLike[]): SourceConflict[] {
  const docs = new Map(documents.map((d) => [d.id, d]));
  const asOf = dealAsOfYear(documents);
  const sources = getFieldSources(viewInfo);
  const alternates = getFieldAlternates(viewInfo);
  const out: SourceConflict[] = [];
  for (const [key, list] of Object.entries(alternates)) {
    if (!isFactKey(key) || key.includes(".")) continue;
    const win = repairCharIndexedValue(viewInfo[key]);
    if (typeof win !== "string" || !win.trim()) continue;
    const winSrc = sources[key];
    const winKind = String(winSrc?.source ?? "");
    if (!winSrc || winKind === "broker" || LEAD_KINDS.has(winKind) || winKind === "system") continue;
    // A date fact the business has several of (one lease per location): a
    // value listing several dates means single dates are about different
    // things, not in conflict.
    const allValues = [win, ...(Array.isArray(list) ? list : []).map((a) => String(a?.value ?? ""))];
    if (DATEISH_KEY_RE.test(key) && allValues.some((v) => /;|\band\b/.test(v) && years(v).length >= 2)) continue;
    const winDoc = winSrc.documentId ? docs.get(winSrc.documentId) : undefined;
    if (winDoc && !isSellerVisible(winDoc)) continue;
    const conflicting: FieldAlternate[] = [];
    for (const alt of Array.isArray(list) ? list : []) {
      const altKind = String(alt?.source ?? "");
      if (!alt || typeof alt.value !== "string" || LEAD_KINDS.has(altKind) || altKind === "system" || altKind === "broker") continue;
      const altDoc = alt.documentId ? docs.get(alt.documentId) : undefined;
      if (alt.documentId && (!altDoc || !isSellerVisible(altDoc))) continue;
      // Said vs written: one side spoken, the other a document.
      const spokenVsDoc =
        (SPOKEN_KINDS.has(winKind) && altKind === "document") || (winKind === "document" && SPOKEN_KINDS.has(altKind));
      if (!spokenVsDoc) continue;
      if (!valuesMateriallyDiffer(key, win, alt.value, { a: winDoc?.name, b: altDoc?.name, asOf })) continue;
      if (conflicting.some((c) => c.value === alt.value)) continue;
      conflicting.push(alt);
    }
    if (conflicting.length === 0) continue;
    out.push({
      key,
      topic: keyWords(key),
      values: [
        { value: trim(win, 160), source: sourceLabel(winSrc, docs) },
        ...conflicting.slice(0, 2).map((a) => ({ value: trim(a.value, 160), source: sourceLabel(a, docs) })),
      ],
      critical: CRITICAL_CONFLICT_RE.test(key),
      origin: "alternates",
    });
  }
  return out;
}

/** Side-source shape stored on discrepancies.side_sources. */
interface SideSource { kind?: string; documentId?: string; brokerOnly?: boolean }

/**
 * Open conflicts the fact merge itself raised (discrepancies with source
 * "merge", facts1) whose sides are both seller-visible.
 */
export function mergeDiscrepancyConflicts(rows: Discrepancy[], documents: DocLike[]): SourceConflict[] {
  const docs = new Map(documents.map((d) => [d.id, d]));
  const out: SourceConflict[] = [];
  for (const d of rows) {
    if (d.source !== "merge" || d.status !== "open") continue;
    const sides = (d.sideSources as { interview?: SideSource; document?: SideSource } | null) || {};
    const privateSide = (s?: SideSource) =>
      !!s && (s.brokerOnly === true || LEAD_KINDS.has(String(s.kind)) || (!!s.documentId && docs.get(s.documentId)?.visibility === "broker_only"));
    if (privateSide(sides.interview) || privateSide(sides.document)) continue;
    if (d.documentId && docs.get(d.documentId)?.visibility === "broker_only") continue;
    if (!d.interviewValue || !d.documentValue) continue;
    const key = d.factKey || d.field;
    const said = sides.interview?.kind ? sourceLabel({ source: sides.interview.kind as FieldSource["source"], documentId: sides.interview.documentId }, docs) : "said by the seller";
    const written = d.documentName ? `document: ${d.documentName}` : sides.document?.documentId ? sourceLabel({ source: "document", documentId: sides.document.documentId }, docs) : "a document";
    out.push({
      key,
      topic: keyWords(d.field || key),
      values: [{ value: trim(d.interviewValue, 160), source: said }, { value: trim(d.documentValue, 160), source: written }],
      critical: d.severity === "critical" || CRITICAL_CONFLICT_RE.test(key),
      origin: "merge",
    });
  }
  return out;
}

// =====================
// Earlier sessions
// =====================

export interface PriorExchange {
  session: number;
  question: string;
  answer: string;
}

/** The question part of an AI message: its sentences that end in "?" (else its tail). */
export function questionPart(message: string): string {
  const qs = message.replace(/\s+/g, " ").match(/[^.!?]*\?/g);
  if (qs && qs.length > 0) return qs.map((q) => q.trim()).join(" ");
  return message.replace(/\s+/g, " ").trim().slice(-200);
}

/**
 * Question → answer pairs from every earlier session of the deal (oldest
 * first), newest `cap` kept. The current session is excluded (the model has
 * its transcript).
 */
export function buildPriorExchanges(
  sessions: Pick<InterviewSession, "id" | "messages" | "startedAt">[],
  currentSessionId: string | null | undefined,
  cap = 40,
): PriorExchange[] {
  const ordered = [...sessions]
    .filter((s) => s.id !== currentSessionId)
    .sort((a, b) => new Date(a.startedAt as unknown as string).getTime() - new Date(b.startedAt as unknown as string).getTime());
  const out: PriorExchange[] = [];
  ordered.forEach((s, idx) => {
    const msgs = (Array.isArray(s.messages) ? s.messages : []) as ConversationMessage[];
    for (let i = 0; i < msgs.length - 1; i++) {
      if (msgs[i].role !== "ai" || msgs[i + 1].role !== "user") continue;
      const answer = msgs[i + 1].content.replace(/\s+/g, " ").trim();
      if (!answer) continue;
      out.push({ session: idx + 1, question: trim(questionPart(msgs[i].content), 220), answer: trim(answer, 240) });
    }
  });
  return out.slice(-cap);
}

// =====================
// Source-text search
// =====================

interface Chunk { docId: string; docName: string; text: string; stems: Set<string>; words: string[] }

/** Abbreviations sources use for the words questions use. */
const WORD_ALIASES: Record<string, string> = {
  tech: "technician", techs: "technician", mgmt: "management", mgr: "manager", reps: "representative", rep: "representative",
  emp: "employee", emps: "employee", yrs: "year", yr: "year", qty: "quantity", ft: "foot", sqft: "foot", approx: "approximately",
  cust: "customer", custs: "customer", admin: "administration", ops: "operation", mfg: "manufacturing", acct: "account",
};
/**
 * A word as the search compares it: lower-case, no possessive or hyphen,
 * singular ("complaints" → complaint, "techs" → technician). Whole words, not
 * prefixes — "clinicians" is not "clinic", "fully" is not "full".
 */
export function searchWord(raw: string): string {
  let w = raw.toLowerCase().replace(/['’]s$/, "").replace(/['’-]/g, "");
  if (WORD_ALIASES[w]) return WORD_ALIASES[w];
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  return WORD_ALIASES[w] ?? w;
}
/** The words of a passage (two-letter words stay: EV, ICE, AR), in order. */
function passageWords(text: string): string[] {
  // PDF and spreadsheet text glue a label to its figure ("technicians22").
  const unglued = text.replace(/([A-Za-z]{3,})(\d)/g, "$1 $2").replace(/(\d)([A-Za-z]{3,})/g, "$1 $2");
  return (unglued.match(/[A-Za-z0-9][A-Za-z0-9'’&-]*/g) ?? []).filter((w) => w.length >= 2).map(searchWord);
}
const chunkCache = new Map<string, Chunk[]>();

function chunksFor(doc: DocLike): Chunk[] {
  const text = typeof doc.extractedText === "string" ? doc.extractedText : "";
  if (!text.trim()) return [];
  const cacheKey = `v4:${doc.id}:${text.length}:${String(doc.updatedAt ?? "")}`;
  const hit = chunkCache.get(cacheKey);
  if (hit) return hit;
  // Windows of a few sentences (or lines), overlapping. A question
  // (the broker's "are the warehouse workers on payroll?") answers nothing,
  // so questions are left out of the windows.
  const sentences = text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3 && !/\?["'”’)\]]*$/.test(s));
  const chunks: Chunk[] = [];
  for (let i = 0; i < sentences.length; i++) {
    // Up to three sentences (a short "Hillhurst lease." heading and the
    // sentence after it belong together), capped in length.
    const windowText = [sentences[i], sentences[i + 1], sentences[i + 2]].filter(Boolean).join(" ").slice(0, 450);
    const words = passageWords(windowText);
    chunks.push({ docId: doc.id, docName: doc.name, text: windowText, stems: new Set(words), words });
  }
  if (chunkCache.size > 400) chunkCache.clear();
  chunkCache.set(cacheKey, chunks);
  return chunks;
}

/** Words that carry no topic in a question ("could you tell me roughly how many…"). */
export const QUESTION_STOP = new Set(
  "what whats how many much your you the is are was were do does did can could would will tell me about any anything some roughly approximately currently today now right like look walk through share give sense kind sort there here that this those these have has had with for and or of to in on at by it its be been being who whom whose which when where why also just still ever yet more most other own quick mention mentioned versus split breakdown across between overall typically usually each mostly shifting moving turning".split(" "),
);

/** Topic tokens of a question: lower-cased, stemmed to 5; acronyms and names kept. */
export function questionTokens(text: string): { stems: Set<string>; names: Set<string> } {
  const stems = new Set<string>();
  const names = new Set<string>();
  const words = text.match(/[A-Za-z0-9][A-Za-z0-9'’&-]*/g) ?? [];
  words.forEach((w, i) => {
    const clean = w.replace(/['’]s$/i, "");
    const lower = clean.toLowerCase();
    if (QUESTION_STOP.has(lower) || RISK_STOP.has(lower)) return;
    const acronym = /^[A-Z0-9&]{2,5}$/.test(clean);
    if (!acronym && lower.length < 4) return;
    stems.add(lower.slice(0, 5));
    // A capitalised word mid-sentence is a name ("Who is Megan?").
    const prev = words[i - 1] ?? "";
    if (/^[A-Z][a-z]{2,}$/.test(clean) && i > 0 && !/[.!?]$/.test(prev)) names.add(lower.slice(0, 5));
  });
  return { stems, names };
}

export interface SourceHit { docId: string; docName: string; snippet: string; matched: string[] }

/** Up to ~300 characters of a passage, starting at the sentence where its matched words begin. */
function snippetAround(text: string, matched: string[]): string {
  if (text.length <= 300) return trim(text, 300);
  const lower = text.toLowerCase();
  const first = matched
    .map((m) => lower.search(new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (first === undefined || first < 150) return trim(text, 300);
  const sentenceStart = Math.max(text.lastIndexOf(". ", first) + 2, text.lastIndexOf("] ", first) + 2, first - 150, 0);
  return trim(text.slice(sentenceStart), 300);
}

/** A question that asks for a quantity, a date or a duration. */
const QUANTITY_QUESTION_RE = /\b(how many|how much|what (?:percentage|percent|share|portion|proportion|number|year|size)|how (?:long|old|big|large|often)|when (?:did|does|do|is|was|will)|what'?s the (?:count|number|total|size|age))\b/i;
/** A figure: digits or a spelled number. */
const FIGURE_RE = /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand|million|dozen|half|quarter)\b/i;

/** Question words that name no topic a passage could answer ("On the warehouse SIDE", "is it FULLY resolved"). */
const SEARCH_NOISE = new Set(["side", "area", "part", "topic", "front", "piece", "point", "happen", "thing", "stuff", "handle", "going", "fully", "really", "actually", "current", "currently", "buyer", "need", "know"]);

/** The topic words of a question clause, as searchWord forms (names and acronyms marked). */
function probeWords(clause: string): { words: Set<string>; names: Set<string>; phrases: [string, string][] } {
  const words = new Set<string>();
  const names = new Set<string>();
  const phrases: [string, string][] = [];
  const raw = clause.match(/[A-Za-z0-9][A-Za-z0-9'’&-]*/g) ?? [];
  let prev: string | null = null;
  raw.forEach((w, i) => {
    const clean = w.replace(/['’]s$/i, "");
    const lower = clean.toLowerCase();
    const acronym = /^[A-Z][A-Z0-9&]{1,5}$/.test(clean);
    const sw = searchWord(clean);
    if (QUESTION_STOP.has(lower) || RISK_STOP.has(lower) || (!acronym && lower.length < 4) || SEARCH_NOISE.has(sw)) {
      prev = null;
      return;
    }
    words.add(sw);
    // Two topic words in a row name one thing ("wrongful dismissal", "scrap rate").
    if (prev) phrases.push([prev, sw]);
    prev = sw;
    if (acronym || (/^[A-Z][a-z]{2,}$/.test(clean) && i > 0 && !/[.!?]$/.test(raw[i - 1] ?? ""))) names.add(sw);
  });
  return { words, names, phrases };
}

/**
 * Finds the passage of a seller-visible source that already answers a
 * question. The question is split into clauses (a compound question asks
 * several things); a clause is answered when one ~2-sentence window holds
 * all its topic words (two or three of them — or one name), or at least
 * three and 60% of them when it has more. Leads (website, social, CRM) and
 * broker-only rows are never searched.
 */
export function searchSourcesFor(question: string, documents: DocLike[]): SourceHit | null {
  return searchSourcesTop(question, documents, 1)[0] ?? null;
}

/** The best `n` passages (one per document) that may answer a question — see searchSourcesFor. */
export function searchSourcesTop(question: string, documents: DocLike[], n: number): SourceHit[] {
  const clauses = question
    // A lead-in ("On the warehouse side:", "Shifting to the lawsuit —") only
    // names the topic; the ask is what follows.
    .replace(/(^|[.!?]\s+)(?:on|about|for|regarding|turning to|shifting to|switching to|back to|speaking of|moving to|now|one more)\b[^:—–?]{0,60}[:—–]\s*/gi, "$1")
    .split(/[,;:—–]|\s-\s|\band\b|\bor\b|\?/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 3);
  const eligible = documents.filter((d) => isSellerVisible(d) && !LEAD_KINDS.has(String(d.sourceKind)));
  // How common each word is across the deal's sources: a passage only
  // answers a question when it shares a DISTINCTIVE word with it — a name,
  // an acronym, or a word few passages use ("College", "deductible"), not
  // just "clinic" and "location" in a clinic's own files.
  const allChunks = eligible.flatMap((d) => chunksFor(d));
  const df = new Map<string, number>();
  for (const c of allChunks) c.stems.forEach((st) => df.set(st, (df.get(st) ?? 0) + 1));
  const rareLimit = Math.max(3, Math.ceil(allChunks.length * 0.015));
  const probes = clauses
    .map((c) => {
      const { words, names, phrases } = probeWords(c);
      return {
        stems: words,
        names,
        phrases,
        // "How many clinicians at each location?" is answered only by a
        // passage that gives a number, not one that merely mentions clinics.
        needsFigure: QUANTITY_QUESTION_RE.test(c) || QUANTITY_QUESTION_RE.test(question),
      };
    })
    .filter((p) => p.stems.size > 0);
  if (probes.length === 0) return [];
  const allWords = new Set(probes.flatMap((p) => Array.from(p.stems)));
  const bestByDoc = new Map<string, { chunk: Chunk; matched: string[]; score: number }>();
  for (const d of eligible) {
    for (const chunk of chunksFor(d)) {
      for (const { stems, names, phrases, needsFigure } of probes) {
        if (needsFigure && !FIGURE_RE.test(chunk.text)) continue;
        const matched = Array.from(stems).filter((s) => chunk.stems.has(s));
        // Weaker candidates, for the answer check to confirm: the clause's
        // two-word subject found as a phrase in the passage ("the wrongful
        // dismissal claim … settled"), or — for a how-many question — one of
        // its rarer words next to a figure ("21 with robots").
        const phraseHit = phrases.some(([a, b]) => {
          const i = chunk.words.indexOf(a);
          const j = chunk.words.indexOf(b);
          return i >= 0 && j >= 0 && j - i >= 1 && j - i <= 2;
        });
        const figureHit =
          needsFigure &&
          matched.some((m) => {
            if (m.length < 5 || (df.get(m) ?? 0) > rareLimit) return false;
            const i = chunk.words.indexOf(m);
            return chunk.words.slice(Math.max(0, i - 6), i + 7).some((w) => /\d/.test(w));
          });
        const nameHit = Array.from(names).some((n) => chunk.stems.has(n));
        // Distinctive: a name or acronym, a word few passages use, or the
        // words together within a few words of each other ("most new
        // patients now come from…").
        const positions = matched.map((m) => chunk.words.indexOf(m)).filter((i) => i >= 0);
        const span = positions.length >= 2 ? Math.max(...positions) - Math.min(...positions) : 99;
        const close = span <= 6;
        // (A short word — "come", "run" — is never distinctive on its own, however rare.)
        const distinctive = nameHit || close || matched.some((m) => m.length >= 5 && (df.get(m) ?? 0) <= rareLimit);
        if (!distinctive && !phraseHit && !figureHit) continue;
        const n = stems.size;
        const all = matched.length === n;
        const full =
          (n >= 2 && n <= 3 && all) ||
          (n > 3 && matched.length >= 3 && matched.length / n >= 0.6) ||
          (nameHit && (all || matched.length >= n - 1));
        if (!full && !phraseHit && !figureHit) continue;
        // Ties go to the passage where the words sit closest together.
        // A spreadsheet row answers only a question about what it names;
        // otherwise prose wins ("Resin comes mainly from two distributors…"
        // over a customer-list row that says "supplier").
        // …and to the passage that also speaks to the question's other clauses.
        const alsoCovers = Array.from(allWords).filter((w) => !stems.has(w) && chunk.stems.has(w)).length;
        // (For a how-many question, a figure right next to the word it counts.)
        const isFigure = (w: string) => /\d/.test(w) && !/^(?:19|20)\d{2}$/.test(w);
        const nearFigures = needsFigure
          ? matched.filter((m) => {
              const i = chunk.words.indexOf(m);
              return chunk.words.slice(Math.max(0, i - 3), i + 4).some(isFigure);
            }).length
          : 0;
        const score = nearFigures * 0.75 + (full ? 0 : -2) + matched.length + matched.length / n + (nameHit ? 1 : 0) + 1 / (1 + span) + alsoCovers * 0.5 - (!nameHit && TABLE_ROW_RE.test(chunk.text) ? 1.5 : 0);
        const best = bestByDoc.get(d.id);
        if (!best || score > best.score) bestByDoc.set(d.id, { chunk, matched, score });
      }
    }
  }
  return Array.from(bestByDoc.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((b) => ({ docId: b.chunk.docId, docName: b.chunk.docName, snippet: snippetAround(b.chunk.text, b.matched), matched: b.matched }));
}

// =====================
// A figure the seller just said vs. the documents
// =====================

/** Nouns counted the same way ("26 trucks" vs "24 service vans"). */
const UNIT_FAMILIES: string[][] = [
  ["truck", "van", "vehicle", "tractor", "fleet"],
  ["employee", "staff", "people", "headcount", "worker", "person"],
  ["member", "membership", "subscriber"],
  ["customer", "client", "account"],
  ["location", "clinic", "store", "branch", "site"],
  ["technician", "tech"],
  ["driver"],
  ["bed"],
  ["patient"],
  ["press"],
];
const unitFamily = (word: string): string => {
  const w = word.toLowerCase().replace(/(?:es|s)$/, "");
  const fam = UNIT_FAMILIES.find((f) => f.some((u) => w === u || w.startsWith(u)));
  return fam ? fam[0] : w.slice(0, 5);
};

/** Words around a figure that say nothing about what it counts. */
const GENERIC_CONTEXT = new Set(["about", "appro", "aroun", "rough", "total", "got", "have", "we've", "our", "plus", "right", "now", "curre", "today", "just", "over", "under", "nearl", "almos", "somet", "maybe", "proba", "think", "guess", "honest", "that's", "there", "these", "those", "with", "them", "they"]);

const ADJECTIVES = /^(active|total|full|part|licensed|current|paying|service|company|power|registered|approximately|about|roughly|around)$/;

/** Words just before a figure that make it an estimate. */
const HEDGE_BEFORE_RE = /\b(probably|maybe|about|roughly|around|approximately|approx\.?|close to|nearly|almost|some|like|call it|give or take|or so)\s*$/i;
/** A spreadsheet/CSV line: cells separated by tabs or bare commas. */
const TABLE_ROW_RE = /\t|(?:[^,\s][^,]*,(?!\s)){2,}|^[^,]{1,40},\d/;
/** Words right after a count that make it a subset ("24 drivers over 10 years", "12 techs with a licence", "5 of them"). */
const SUBSET_AFTER_RE = /^\s*(?:over|under|with|who|that|which|having|of (?:them|those|these|our|the)|in (?:the|our)\s+\w+ (?:team|department|shop|crew)|on (?:the|our) \w+ (?:shift|team|crew)|at (?:the|our) \w+ (?:location|site|clinic|branch))\b/i;

/** (figure, unit) pairs a text states: "3,100 members", "26 trucks", "18% of revenue". */
export function figuresWithUnits(text: string): { value: number; unit: string; context: Set<string>; subset?: boolean; hedged?: boolean }[] {
  const out: { value: number; unit: string; context: Set<string>; subset?: boolean; hedged?: boolean }[] = [];
  const clean = stripLabelNumbers(text);
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(%|percent\b|[a-z]+)(?:\s+(?:of\s+)?([a-z]+))?(?:\s+([a-z]+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const value = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(value) || (value >= 1900 && value <= 2099 && !m[2].startsWith("%"))) continue;
    let unit = m[2].toLowerCase();
    // "2,900 active members", "24 service vans": skip adjectives to reach the noun.
    if (!/^(%|percent)$/.test(unit) && m[3] && ADJECTIVES.test(unit)) {
      unit = m[3].toLowerCase();
      if (m[4] && ADJECTIVES.test(unit)) unit = m[4].toLowerCase();
    }
    if (/^(%|percent)$/.test(unit)) unit = `%${m[3] ? ` ${m[3].toLowerCase().slice(0, 5)}` : ""}`;
    if (unit.length < 3 && !unit.startsWith("%")) continue;
    if (/^(year|month|week|day|hour|minute|time|sq|square|ft|feet|km|mile|am|pm|k|m|mm|million|thousand|dollar|and|or|to|in|on|at|of|for|the|a)$/.test(unit.replace(/s$/, ""))) continue;
    const start = Math.max(0, m.index - 80);
    const context = stemsOf(clean.slice(start, m.index + m[0].length + 40));
    // Everything after the unit noun: "…drivers| over 10 years".
    const after = clean.slice(m.index + (m[1].length + (clean.slice(m.index + m[1].length).match(/^\s*(?:%|percent\b|[a-z]+)/i)?.[0].length ?? 0)));
    const subset = !unit.startsWith("%") && SUBSET_AFTER_RE.test(after);
    // "probably 10 or 11", "about 26", "maybe 3,000", "25-30 people".
    const before = clean.slice(Math.max(0, m.index - 30), m.index);
    const hedged = HEDGE_BEFORE_RE.test(before) || /^\s*(?:or|to|-|–)\s*\d/.test(clean.slice(m.index + m[1].length)) || /\d\s*(?:or|to|-|–)\s*$/.test(before);
    out.push({ value, unit: unit.startsWith("%") ? unit : unitFamily(unit), context, ...(subset ? { subset: true } : {}), ...(hedged ? { hedged: true } : {}) });
  }
  return out;
}

/**
 * A figure the seller just stated that a seller-visible DOCUMENT gives
 * differently for the same kind of thing (3,100 members said vs "2,900
 * active members" in the membership report). The document passage must
 * share the seller's subject (words around the figure besides the unit),
 * and no document may state the seller's figure itself. Calls and emails
 * aren't checked here — they are the seller talking.
 */
export function spokenFigureConflicts(sellerMessage: string, documents: DocLike[]): { said: string; docName: string; snippet: string }[] {
  // Percentages are skipped: "7.5% of revenue" (drayage) and "6.4% of
  // revenue" (a customer) are shares of different things, and a share of a
  // NAMED customer is compared by crossSourceFigureConflicts. So is a count
  // of a subset ("24 drivers over 10 years", "12 techs with their 313A"): it
  // isn't the headline count of anything a document lists.
  const said = figuresWithUnits(sellerMessage).filter((f) => f.value >= 2 && !f.unit.startsWith("%") && !f.subset);
  if (said.length === 0) return [];
  const out: { said: string; docName: string; snippet: string }[] = [];
  for (const f of said) {
    let best: { docName: string; snippet: string; score: number } | null = null;
    let agrees = false;
    for (const d of documents) {
      if (!isSellerVisible(d) || String(d.sourceKind || "document") !== "document") continue;
      // A document about the thing counted ("Fleet list" for trucks) is
      // compared on its headline count only — its first figure of that kind
      // (a roster's 96 drivers, not its 38 linehaul drivers).
      const aboutUnit = (d.name.toLowerCase().match(/[a-z]+/g) ?? []).some((w) => unitFamily(w) === f.unit);
      let headlineSeen = false;
      for (const chunk of chunksFor(d)) {
        // A table row ("Port drayage,14,…") is one line of a breakdown, not a
        // statement of the total — never compared.
        if (TABLE_ROW_RE.test(chunk.text)) continue;
        for (const g of figuresWithUnits(chunk.text)) {
          if (g.unit !== f.unit || g.subset) continue;
          const isHeadline = aboutUnit && !headlineSeen;
          if (aboutUnit) headlineSeen = true;
          const base = Math.max(f.value, g.value);
          const diff = Math.abs(f.value - g.value) / base;
          if (diff <= 0.04) { agrees = true; continue; }
          // A hedged count ("probably 10 or 11 inspectors") a couple off the
          // document's is the seller's estimate, not a conflict worth a stop.
          if (f.hedged && Math.abs(f.value - g.value) <= 2 && base <= 30) { agrees = true; continue; }
          if (diff > 0.5) continue; // a different quantity altogether
          let shared = 0;
          f.context.forEach((w) => { if (g.context.has(w) && !/^\d/.test(w) && !GENERIC_CONTEXT.has(w) && !w.startsWith(f.unit.slice(0, 4))) shared++; });
          // Same subject: two words in common around the figure, or the
          // headline count of a document about exactly this.
          if (shared < 2 && !isHeadline) continue;
          const score = shared + (isHeadline ? 2 : 0);
          if (!best || score > best.score) best = { docName: d.name, snippet: trim(chunk.text, 240), score };
        }
      }
    }
    if (best && !agrees) out.push({ said: `${f.value.toLocaleString("en-US")} ${f.unit}`.trim(), docName: best.docName, snippet: best.snippet });
  }
  return out.slice(0, 2);
}

/** Capitalised names in a text (not sentence starts, months or common words). */
function namesIn(text: string): Set<string> {
  const out = new Set<string>();
  const re = /(^|[^.!?]\s)([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[2];
    if (/^(The|This|That|These|Those|Our|Their|His|Her|Its|And|But|For|With|From|Total|Owner|Seller|Broker|Revenue|Years?|Fiscal|Gross|Net|Annual|January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Canada|Ontario|Alberta|British|Columbia|Inc|Ltd|Corp|Company|Business|Morgan|Ellis)\b/.test(name)) continue;
    out.add(name.split(/\s+/)[0].toLowerCase());
  }
  return out;
}

/**
 * Figures a call or email (the seller talking) gives differently from a
 * document, about the same named thing: "Alderbrook ~18% of revenue" on the
 * intro call vs "Alderbrook 22% of FY2024 revenue" in the statements. Read
 * from the sources' digests (summary, key facts, red flags); both sides must
 * name the same business, customer, location or person near the figure.
 * Seller-visible sources only; leads are ignored.
 */
export function crossSourceFigureConflicts(documents: DocLike[], cap = 4): SourceConflict[] {
  type Fig = { value: number; unit: string; names: Set<string>; ctx: Set<string>; text: string; source: string };
  const said: Fig[] = [];
  const written: Fig[] = [];
  const docs = new Map(documents.map((d) => [d.id, d]));
  for (const d of documents) {
    if (!isSellerVisible(d) || LEAD_KINDS.has(String(d.sourceKind))) continue;
    const data = (d.extractedData as Record<string, unknown> | null | undefined) || null;
    if (!data) continue;
    const kind = String(d.sourceKind || "document");
    const isSaid = ["call", "video_call", "email"].includes(kind);
    const label = sourceLabel({ source: kind as FieldSource["source"], documentId: d.id }, docs);
    for (const field of ["summary", "keyFacts", "redFlags"]) {
      const text = typeof data[field] === "string" ? (data[field] as string) : "";
      for (const part of text.split(/[;,](?![^()]*\))|\.\s/)) {
        for (const f of figuresWithUnits(part)) {
          const names = namesIn(part);
          if (names.size === 0) continue;
          const unit = f.unit.startsWith("%") ? "%" : f.unit;
          // What the figure is about, beyond the name: "rev(enue)", "uti(lization)", "mar(gin)"…
          const ctx = new Set(
            Array.from(stemsOf(part))
              .filter((w) => !/^\d/.test(w) && !Array.from(names).some((n) => n.startsWith(w) || w.startsWith(n.slice(0, 5))) && !GENERIC_CONTEXT.has(w))
              .map((w) => w.slice(0, 3)),
          );
          (isSaid ? said : written).push({ value: f.value, unit, names, ctx, text: trim(part.trim(), 150), source: label });
        }
      }
    }
  }
  const out: SourceConflict[] = [];
  const seen = new Set<string>();
  const sameThing = (s: Fig, w: Fig) =>
    w.unit === s.unit && Array.from(s.names).some((n) => w.names.has(n)) && Array.from(s.ctx).some((c) => w.ctx.has(c));
  for (const s of said) {
    const agrees = written.some((w) => sameThing(s, w) && Math.abs(w.value - s.value) / Math.max(w.value, s.value) <= 0.04);
    if (agrees) continue;
    // 100% / 0% are "all" / "none", not a share to compare.
    if (s.unit === "%" && (s.value >= 100 || s.value <= 0)) continue;
    const match = written.find((w) => {
      if (!sameThing(s, w)) return false;
      if (w.unit === "%" && (w.value >= 100 || w.value <= 0)) return false;
      // Complementary shares (40% exposed vs 60% unaffected) describe one split.
      if (w.unit === "%" && Math.abs(w.value + s.value - 100) <= 2) return false;
      const diff = Math.abs(w.value - s.value) / Math.max(w.value, s.value);
      return diff > 0.04 && diff <= 0.5;
    });
    if (!match) continue;
    const name = Array.from(s.names).find((n) => match.names.has(n))!;
    const key = `${name}${s.unit === "%" ? "Share" : s.unit.charAt(0).toUpperCase() + s.unit.slice(1) + "Count"}`.replace(/[^A-Za-z0-9]/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      topic: `${name} ${s.unit === "%" ? "share" : s.unit}`,
      values: [{ value: s.text, source: s.source }, { value: match.text, source: match.source }],
      critical: CRITICAL_CONFLICT_RE.test(`${key} ${s.text}`) || s.unit === "%",
      origin: "alternates",
    });
    if (out.length >= cap) break;
  }
  return out;
}
