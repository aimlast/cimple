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
const MATERIAL_RISK_RE =
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
  values: { value: string; source: string }[];
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
  return (text.match(/\b(?:19|20)\d{2}\b/g) ?? []).map(Number);
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
  context: { a?: string; b?: string } = {},
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
  // Different periods ("$7.96M at Dec 31, 2024" vs a 2023 return's figure)
  // are not a conflict — each year is its own fact.
  const ya = years(x).length ? years(x) : years(context.a ?? "");
  const yb = years(y).length ? years(y) : years(context.b ?? "");
  if (ya.length > 0 && yb.length > 0 && !ya.some((v) => yb.includes(v))) return false;
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
      if (!valuesMateriallyDiffer(key, win, alt.value, { a: winDoc?.name, b: altDoc?.name })) continue;
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

interface Chunk { docId: string; docName: string; text: string; stems: Set<string> }

/** Chunk stems: like stemsOf, but two-letter words stay (EV, ICE, AR). */
function chunkStems(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9'’&-]*/g) ?? [])
      .map((w) => w.replace(/['’]s$/, ""))
      .filter((w) => w.length >= 2)
      .map((w) => w.slice(0, 4)),
  );
}
const chunkCache = new Map<string, Chunk[]>();

function chunksFor(doc: DocLike): Chunk[] {
  const text = typeof doc.extractedText === "string" ? doc.extractedText : "";
  if (!text.trim()) return [];
  const cacheKey = `${doc.id}:${text.length}:${String(doc.updatedAt ?? "")}`;
  const hit = chunkCache.get(cacheKey);
  if (hit) return hit;
  // ~2-sentence windows (sentences or lines), overlapping by one.
  const sentences = text.replace(/\r/g, "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 3);
  const chunks: Chunk[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const windowText = (sentences[i] + (sentences[i + 1] ? ` ${sentences[i + 1]}` : "")).slice(0, 400);
    chunks.push({ docId: doc.id, docName: doc.name, text: windowText, stems: chunkStems(windowText) });
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

/** Search stems are 4 characters, so "techs" meets "technicians" and "complaint" meets "complaints". */
const searchStem = (s: string) => s.slice(0, 4);

/**
 * Finds the passage of a seller-visible source that already answers a
 * question. The question is split into clauses (a compound question asks
 * several things); a clause is answered when one ~2-sentence window holds
 * all its topic words (two or three of them — or one name), or at least
 * three and 60% of them when it has more. Leads (website, social, CRM) and
 * broker-only rows are never searched.
 */
export function searchSourcesFor(question: string, documents: DocLike[]): SourceHit | null {
  const clauses = question
    .split(/[,;:—–]|\s-\s|\band\b|\bor\b|\?/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 3);
  const probes = clauses
    .map((c) => {
      const { stems, names } = questionTokens(c);
      return { stems: new Set(Array.from(stems).map(searchStem)), names: new Set(Array.from(names).map(searchStem)) };
    })
    .filter((p) => p.stems.size > 0);
  if (probes.length === 0) return null;
  let best: { chunk: Chunk; matched: string[]; score: number } | null = null;
  for (const d of documents) {
    if (!isSellerVisible(d) || LEAD_KINDS.has(String(d.sourceKind))) continue;
    for (const chunk of chunksFor(d)) {
      for (const { stems, names } of probes) {
        const matched = Array.from(stems).filter((s) => chunk.stems.has(s));
        const nameHit = Array.from(names).some((n) => chunk.stems.has(n));
        const n = stems.size;
        const all = matched.length === n;
        const ok =
          (n >= 2 && n <= 3 && all) ||
          (n > 3 && matched.length >= 3 && matched.length / n >= 0.6) ||
          (nameHit && (all || matched.length >= n - 1));
        if (!ok) continue;
        const score = matched.length + matched.length / n + (nameHit ? 1 : 0);
        if (!best || score > best.score) best = { chunk, matched, score };
      }
    }
  }
  if (!best) return null;
  return { docId: best.chunk.docId, docName: best.chunk.docName, snippet: trim(best.chunk.text, 300), matched: best.matched };
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

/** (figure, unit) pairs a text states: "3,100 members", "26 trucks", "18% of revenue". */
export function figuresWithUnits(text: string): { value: number; unit: string; context: Set<string> }[] {
  const out: { value: number; unit: string; context: Set<string> }[] = [];
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
    out.push({ value, unit: unit.startsWith("%") ? unit : unitFamily(unit), context });
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
  // A bare percentage ("9.4%, which…") says nothing about what it measures — skipped.
  const said = figuresWithUnits(sellerMessage).filter((f) => f.value >= 2 && f.unit !== "%");
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
        for (const g of figuresWithUnits(chunk.text)) {
          if (g.unit !== f.unit) continue;
          const isHeadline = aboutUnit && !headlineSeen;
          if (aboutUnit) headlineSeen = true;
          const base = Math.max(f.value, g.value);
          const diff = Math.abs(f.value - g.value) / base;
          if (diff <= 0.04) { agrees = true; continue; }
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
