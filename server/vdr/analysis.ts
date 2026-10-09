/**
 * What Cimple knows about a room document (vdr spec §9.6). No AI.
 *
 *  - privateMattersFor (pass 2): the §4.9 "Private matters" flag, broker
 *    only — a fact from this document Cimple kept OUT of the CIM.
 *  - documentFacts: the facts whose recorded source is this document (a
 *    year of a by-year map counts only for the years it stated).
 *  - buyerKeyFigures: the same, screened for buyers — only facts the CIM
 *    may use (cimSafeFacts: no broker-only source), minus personal details,
 *    staff-private matters and confidentiality holds (screenFactsForCim with
 *    the rules-only keep-out — opening a document never calls the AI), minus
 *    anything naming a held person; figures only, at most 6.
 *  - documentCimLinks: CIM pages that print this document's figures.
 *  - brokerChecks: what it was checked against — dd's checks when the dd
 *    stream is merged, else the discrepancies involving it, plus other
 *    documents that state the same figure.
 */
import type { BuyerQuestion, Deal, Discrepancy, Document } from "@shared/schema";
import { collectStrings } from "@shared/blind-guard";
import { heldPrivateForDeal } from "../cim/held-private";
import { isKnownFigure, knownFiguresFrom, parseFigures, type Figure } from "../cim/figure-check";
import { cimSafeFacts } from "../information/cim-facts";
import { hasSensitiveDetail, keepOutFromNotes, mentionsHeldPerson, screenFactsForCim } from "../cim/sensitive-facts";
import { yearSource, type FieldSource } from "../interview/info-merger";

type Info = Record<string, unknown>;

function noteSources(n: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof n.documentId === "string") out.push(n.documentId);
  if (Array.isArray(n.alsoFrom)) for (const s of n.alsoFrom) if (s && typeof (s as Record<string, unknown>).documentId === "string") out.push((s as Record<string, string>).documentId);
  return out;
}

function short(s: string, n = 90): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** The documents a fact came from (its source, any year's source). */
function factDocuments(info: Info, key: string): Set<string> {
  const out = new Set<string>();
  const src = ((info._fieldSources ?? {}) as Record<string, Record<string, unknown>>)[key];
  if (!src) return out;
  if (typeof src.documentId === "string") out.add(src.documentId);
  const years = src.years as Record<string, unknown> | undefined;
  if (years && typeof years === "object") {
    for (const y of Object.values(years)) {
      if (typeof y === "string") out.add(y);
      else if (y && typeof (y as Record<string, unknown>).documentId === "string") out.add((y as Record<string, string>).documentId);
    }
  }
  return out;
}

/** Every listed document's private matters, read once (the held-private screen runs once per call). Never throws. */
export function privateMattersByDocument(deal: Deal, documentIds: ReadonlyArray<string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (documentIds.length === 0) return map;
  const wanted = new Set(documentIds);
  const add = (id: string, text: string) => {
    if (!wanted.has(id)) return;
    const list = map.get(id) ?? [];
    if (!list.includes(text) && list.length < 5) list.push(text);
    map.set(id, list);
  };
  try {
    const info = ((deal.extractedInfo ?? {}) as Info) || {};
    const notes = Array.isArray(info._brokerPrivateNotes) ? (info._brokerPrivateNotes as Array<Record<string, unknown>>) : [];
    for (const n of notes) {
      if (typeof n?.note !== "string") continue;
      for (const id of noteSources(n)) add(id, short(n.note));
    }
    for (const held of heldPrivateForDeal(deal)) {
      if (held.included) continue;
      for (const id of Array.from(factDocuments(info, held.key))) add(id, short(held.description || held.label || held.text));
    }
  } catch (err: any) {
    console.warn(`[vdr] private matters couldn't be read for deal ${deal.id}:`, err?.message ?? err);
  }
  return map;
}

/** Short broker-only descriptions of what Cimple kept out of the CIM from one document. */
export function privateMattersFor(deal: Deal, documentId: string): string[] {
  return privateMattersByDocument(deal, [documentId]).get(documentId) ?? [];
}

// ── Facts from one document ────────────────────────────────────────────────

export type DocFact = { key: string; label: string; value: unknown; text: string };

/** Words a reader knows in capitals (whole words only). */
const ACRONYMS: Record<string, string> = {
  ebitda: "EBITDA", sde: "SDE", cogs: "COGS", ltd: "LTD", ltc: "LTC", odb: "ODB", fy: "FY", ytd: "YTD", ttm: "TTM",
  cca: "CCA", hst: "HST", gst: "GST", pst: "PST", qst: "QST", cra: "CRA", wsib: "WSIB", nwc: "NWC", kpi: "KPI",
  hr: "HR", ar: "AR", ap: "AP", rx: "Rx", usd: "USD", cad: "CAD", ceo: "CEO", cfo: "CFO",
};

/** A by-year map's key without its "by year" ("revenueByYear" → "revenue"). */
export function baseFactKey(key: string): string {
  return key.replace(/(?:ByYear|_by_year|ByYr)$/, "") || key;
}

/** "otherCurrentAssets" → "Other current assets"; "taxableIncomeByYear" → "Taxable income"; "fy2024StaffT4Earnings" → "FY2024 staff T4 earnings". */
export function factLabel(key: string): string {
  const words = baseFactKey(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z]{2,})(\d)/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((w) => ACRONYMS[w] ?? (/^[a-z]\d{1,2}$/.test(w) ? w.toUpperCase() : w))
    .join(" ")
    .replace(/\bFY (\d{2,4})\b/g, "FY$1")
    // Words a reader writes with a hyphen ("Long-term debt", "Self-pay share").
    .replace(/\b(long|short|full|part|self|year|month) (term|time|pay|end)\b/g, (m, a: string, b: string) => (/^(long|short)$/.test(a) && b === "term") || (/^(full|part)$/.test(a) && b === "time") || (a === "self" && b === "pay") || (/^(year|month)$/.test(a) && b === "end") ? `${a}-${b}` : m);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A value as one line: year maps newest first ("2024: $1.9M · 2023: $1.7M"). */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) >= 1000 ? v.toLocaleString("en-US") : String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map(valueText).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    entries.sort(([a], [b]) => (/^\d{4}$/.test(a) && /^\d{4}$/.test(b) ? Number(b) - Number(a) : a.localeCompare(b)));
    return entries.map(([k, x]) => `${k}: ${valueText(x)}`).join(" · ");
  }
  return String(v);
}

/** The facts whose recorded source is this document (§9.6). */
export function documentFacts(info: Info | null | undefined, documentId: string): DocFact[] {
  if (!info) return [];
  const sources = (info._fieldSources ?? {}) as Record<string, FieldSource>;
  const out: DocFact[] = [];
  for (const [key, value] of Object.entries(info)) {
    if (key.startsWith("_") || value === null || value === undefined || value === "") continue;
    const src = sources[key];
    if (!src) continue;
    if (src.years && value && typeof value === "object" && !Array.isArray(value)) {
      const sub: Record<string, unknown> = {};
      for (const [y, v] of Object.entries(value as Record<string, unknown>)) {
        if (yearSource(src, y)?.documentId === documentId) sub[y] = v;
      }
      if (Object.keys(sub).length > 0) out.push({ key, label: factLabel(key), value: sub, text: valueText(sub) });
      continue;
    }
    if (src.documentId === documentId) out.push({ key, label: factLabel(key), value, text: valueText(value) });
  }
  return out;
}

/** Figures worth matching: money and percentages, and amounts (not years or small counts). */
function strongFigures(text: string): Figure[] {
  return parseFigures(text).filter((f) => {
    if (f.kind === "percent") return f.value !== 0;
    if (Number.isInteger(f.value) && f.value >= 1900 && f.value <= 2100 && !f.text.includes(",") && f.kind === "plain") return false;
    return Math.abs(f.value) >= 1000;
  });
}

const hasFigure = (text: string) => strongFigures(text).length > 0 || /\b\d[\d,.]*\b/.test(text);

/** Identifiers that look like numbers (a business number, a NAICS code, a phone) are never "figures". */
const IDENTIFIER_KEY = /number|code|naics|phone|postal|zip|fax|licen[cs]e|registration|account|sin\b|bn\b|\bid$/i;

/** 29,180,000 → 4 ("2918"); 200,000 → 1; 56,023 → 5. */
function significantDigits(v: number): number {
  return String(Math.round(Math.abs(v))).replace(/0+$/, "").length;
}

/**
 * The order a buyer reads a statement in (checker r2 R2-5): sales lines,
 * then cost of sales, gross profit, EBITDA/SDE, operating income, net
 * income, taxable income, then the balance sheet (equity, cash, debt).
 * Tested on the key's words ("costOfSalesByYear" → "cost of sales by year").
 */
const HEADLINE: Array<(words: string) => boolean> = [
  (w) => /\b(revenues?|sales|turnover)\b/.test(w) && !/\b(cost|costs|expenses?|tax|taxes|returns?|commissions?|deferred|unearned|receivables?)\b/.test(w),
  (w) => /\bcost of (sales|goods|revenue)\b|\bcogs\b|\bcost of goods sold\b|\bdirect (operating )?costs?\b/.test(w),
  (w) => /\bgross (profit|margin)\b/.test(w),
  (w) => /\bebitda\b|\bsde\b|\bdiscretionary earnings\b|\badjusted earnings\b/.test(w),
  (w) => /\boperating (income|profit)\b/.test(w),
  (w) => /\bnet (income|earnings|profit)\b/.test(w),
  (w) => /\btaxable income\b/.test(w),
  (w) => /\btotal assets\b|\bequity\b|\bretained earnings\b/.test(w),
  (w) => /\bcash\b/.test(w),
  (w) => /\bdebt\b|\bloans?\b/.test(w) && !/\bbad debts?\b/.test(w),
];
/** Headline figures first, in statement order (above), then other money, then counts, then the rest. */
export function keyFigureRank(f: { key: string; text: string }): number {
  const words = f.key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").toLowerCase();
  // A breakdown written as data ({"2023": {…}}) is never a headline figure.
  if (/^\s*[[{]/.test(f.text)) return 45;
  const h = HEADLINE.findIndex((test) => test(words));
  const money = /\$\s?\d/.test(f.text);
  if (h >= 0 && money) return h;
  if (money) return 20;
  if (strongFigures(f.text).length > 0) return 30;
  if (/\d/.test(f.text)) return 40;
  return 50;
}
const figureRank = keyFigureRank;

// ── Key figures as a reader reads them (checker F3) ──────────────────────

/** A key-figure row: what it shows, and every fact key it stands for (a duplicate folded into it). */
export type KeyFigureRow = DocFact & { keys: string[] };

type Token = { year: string | null; value: number; percent: boolean };
type Shown = {
  f: DocFact; label: string; text: string; tokens: Token[]; years: number; base: string; order: number;
  /** The label's meaningful words (plurals, "total", "annual"… set aside). */
  words: LabelWords;
  /** A breakdown, not one line: a JSON-ish value, more than 3 figures in one value, or a year with several figures. */
  blob: boolean;
};

const YEAR_KEY = /^(?:19|20)\d{2}$/;
const isYearMap = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length > 0 && Object.keys(v as object).every((k) => YEAR_KEY.test(k));
const money = (text: string) => /\$\s?\d/.test(text) && !/\d\s?%/.test(text);

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATES = [
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}`, "gi"),
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
];

/**
 * The figures that say what a value is, for folding: its amounts and
 * percentages ("$742,600"), or — when it has none — its small figures too
 * ("Common shares $100", "12"). Never a bare year or a date's day
 * ("as at December 31, 2024").
 */
function foldFigures(text: string): Figure[] {
  let t = text;
  for (const re of DATES) t = t.replace(re, " ");
  const all = parseFigures(t).filter((f) => !(f.kind === "plain" && Number.isInteger(f.value) && f.value >= 1900 && f.value <= 2100 && !f.text.includes(",")));
  const strong = all.filter((f) => (f.kind === "percent" ? f.value !== 0 : Math.abs(f.value) >= 1000));
  return strong.length > 0 ? strong : all;
}

// ── Do two labels name the same thing? (checker r2 R2-1) ──
/** Words that never decide what a line is. */
const FILLER = new Set(["total", "totals", "annual", "yearly", "the", "and", "of", "for", "in", "on", "at", "a", "an", "from", "amount", "value", "figure", "detail", "details"]);
/** Phrases that say the same thing in other words ("cash on hand" is cash; "km" is kilometres). */
const SAME_WORDS: Array<[RegExp, string]> = [
  [/&/g, " and "], [/\bon hand\b/g, " "], [/\bin (the )?bank\b/g, " "],
  [/\bkms?\b/g, "kilometer"], [/\bkilometres?\b/g, "kilometer"], [/\blabour\b/g, "labor"],
];
/** A word that makes a different line when one label adds it ("Income taxes" vs "Income taxes payable", "Retained earnings" vs "… beginning"). */
const CHANGERS = new Set([
  "net", "gross", "accumulated", "other", "deferred", "non", "excluding", "before", "after", "less", "minus", "plus",
  "payable", "receivable", "paid", "owing", "unpaid", "owed", "prior", "previous", "change", "increase", "decrease", "growth",
  "margin", "percent", "percentage", "ratio", "average", "per", "share", "adjusted", "normalized", "normalised", "reduced",
  "restated", "recast", "pro", "forma", "budget", "budgeted", "forecast", "projected", "target", "ytd", "ttm", "monthly",
  "weekly", "daily", "quarterly", "opening", "closing", "beginning", "ending", "cost", "costs", "portion", "limit", "cap",
  "deposit", "reserve", "provision", "refund", "credit", "rate",
  // Whose it is: "Shareholder loans" is not every loan.
  "shareholder", "owner", "director", "officer", "related", "intercompany", "bank",
]);
/** A word that changes a balance-sheet line ("Total assets" vs "Total current assets", "Debt" vs "Long-term debt"). */
const TERM_WORDS = new Set(["current", "long-term", "short-term", "non-current", "noncurrent"]);
const BALANCE_WORDS = new Set(["asset", "liability", "debt", "loan", "lease", "obligation"]);

function singular(w: string): string {
  if (w.length <= 3 || /ss$/.test(w) || /(us|is)$/.test(w)) return w;
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  return w.endsWith("s") ? w.slice(0, -1) : w;
}

/** A label's meaningful words, and those after an "and" (a second item: "Cash and deposits"). */
export type LabelWords = { words: Set<string>; joined: Set<string> };

/** "Total shareholders equity" → {shareholder, equity}; "Cash on hand" → {cash}; "Cash and deposits" → {cash, deposit} (deposit joined). */
export function labelWords(key: string): LabelWords {
  let t = factLabel(key).toLowerCase();
  for (const [re, to] of SAME_WORDS) t = t.replace(re, to);
  const words = new Set<string>();
  const joined = new Set<string>();
  let afterAnd = false;
  for (const raw of t.split(/\s+/)) {
    if (raw === "and") { afterAnd = true; continue; }
    const w = singular(raw.replace(/[^a-z0-9-]/g, ""));
    if (!w || FILLER.has(w)) continue;
    words.add(w);
    if (afterAnd) joined.add(w);
  }
  return { words, joined };
}

/**
 * "equal": the same name once plurals and "total/annual…" are set aside
 * ("Inventories" / "Inventory", "Total current assets" / "Current assets").
 * "contains": one name is the other plus words that don't change what it is
 * ("Cash" ⊂ "Cash and deposits", "Advertising" ⊂ "Advertising and
 * promotion", "Income taxes" ⊂ "Income taxes current"). null otherwise —
 * "Gross profit" vs "Revenue", "Taxes payable" vs "Other expenses",
 * "Income taxes" vs "Income taxes payable", "Assets" vs "Current assets",
 * "Rent" vs "Rent deposit".
 */
export function sameThing(a: LabelWords, b: LabelWords): "equal" | "contains" | null {
  if (a.words.size === 0 || b.words.size === 0) return null;
  const [small, big] = a.words.size <= b.words.size ? [a, b] : [b, a];
  for (const w of Array.from(small.words)) if (!big.words.has(w)) return null;
  const extra = Array.from(big.words).filter((w) => !small.words.has(w));
  if (extra.length === 0) return "equal";
  // A changing word counts unless it only names a second item ("Cash and deposits" is still cash).
  if (extra.some((w) => CHANGERS.has(w) && !big.joined.has(w))) return null;
  if (extra.some((w) => TERM_WORDS.has(w)) && Array.from(small.words).some((w) => BALANCE_WORDS.has(w))) return null;
  return "contains";
}

/** One fact as a row: "Taxable income (2023)  $459,201", never "Taxable income by year  2023: $459,201". */
function shownFact(f: DocFact, order: number): Shown {
  let label = factLabel(f.key);
  let text = f.text;
  let tokens: Token[] = [];
  let years = 0;
  let blob = /^\s*[[{]/.test(f.text);
  if (isYearMap(f.value)) {
    const ys = Object.keys(f.value).sort((a, b) => Number(b) - Number(a));
    years = ys.length;
    for (const y of ys) {
      const figs = foldFigures(valueText(f.value[y]));
      if (figs.length > 1 || /^\s*[[{]/.test(valueText(f.value[y]))) blob = true;
      for (const g of figs) tokens.push({ year: y, value: g.value, percent: g.kind === "percent" });
    }
    if (ys.length === 1) {
      label = `${label} (${ys[0]})`;
      text = valueText(f.value[ys[0]]);
    }
  } else {
    // "$820,800 (2024)" / "$464,201 (FY2023)": the year goes to the label.
    // Only when it is the value's one year ("$9,000 (2024), $7,000 (2023)" keeps both years in the value).
    const m = /^(.*\S)\s*\((?:FY\s?)?((?:19|20)\d{2})\)$/i.exec(text);
    const year = m && !/\(\d{4}\)$/.test(label) && !/\b(?:19|20)\d{2}\b/.test(m[1]) ? m[2] : null;
    if (m && year) {
      label = `${label} (${year})`;
      text = m[1];
    }
    tokens = foldFigures(text).map((g) => ({ year, value: g.value, percent: g.kind === "percent" }));
    if (tokens.length > 3) blob = true;
  }
  // A dollar amount is never a "share" ("Compounding revenue share  $820,800" → "Compounding revenue").
  // Only a trailing "share" ("Share capital" and "Shareholder loans" are real names).
  const SHARE_TAIL = /\s+share(?=(?:\s+\((?:19|20)\d{2}\))?$)/i;
  if (money(text) && SHARE_TAIL.test(label)) label = label.replace(SHARE_TAIL, "");
  return { f, label, text, tokens, years, base: baseFactKey(f.key), order, words: labelWords(f.key), blob };
}

/**
 * Every figure of `b` is in `a`. A year-less figure of `b` matches any year
 * of `a` only for the same fact (`anyYear`); across two facts it matches
 * only `a`'s newest year (a headline is the latest year) or a year-less one.
 */
function covers(a: Shown, b: Shown, anyYear: boolean): boolean {
  const newest = a.tokens.reduce<string | null>((m, t) => (t.year && (!m || t.year > m) ? t.year : m), null);
  return b.tokens.length > 0 && b.tokens.every((t) => a.tokens.some((u) =>
    u.value === t.value && u.percent === t.percent &&
    (t.year === null ? anyYear || u.year === null || u.year === newest : u.year === t.year)));
}

/** `s` says nothing `k` doesn't (checker r2 R2-1). */
function foldsInto(k: Shown, s: Shown): boolean {
  // The same name saying the very same words ("Incorporation date" / "Date of incorporation": June 3, 1998).
  const plain = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  if ((k.base === s.base || sameThing(k.words, s.words) === "equal") && plain(k.text) === plain(s.text)) return true;
  // Never into a breakdown: a figure that happens to sit in one is its own line.
  if (k.blob) return false;
  // The same fact ("revenue" and "revenueByYear"): its headline folds into the by-year row, small amounts too.
  if (k.base === s.base) return covers(k, s, true);
  const same = sameThing(k.words, s.words);
  if (same === "equal") return covers(k, s, false);
  // A name that contains the other's ("Cash" in "Cash and deposits"): distinctive amounts only — two
  // different $30,000 lines stay — and never a percentage.
  if (same === "contains") return covers(k, s, false) && s.tokens.every((t) => !t.percent && significantDigits(t.value) >= 3);
  return false;
}

/**
 * A document's facts as key-figure rows a buyer can read at a glance (F3):
 * by-year labels as "Taxable income (2023)", a year printed after a figure
 * moved to its label, a money value never called a "share", and a row that
 * repeats another row of the SAME thing dropped ("Net income for tax
 * purposes" beside its by-year map, "Cash" beside "Cash and deposits" with
 * the same amounts, "Common shares $100" beside "Common shares 2024: $100").
 * Two different lines are never folded because their amounts agree
 * (checker r2 R2-1: "Current portion long-term debt $2,420,000" is not
 * "Accounts payable 2023: $2,420,000"; "Gross profit" is not "Revenue"),
 * and nothing folds into a breakdown. Keeps the input's order.
 */
export function presentKeyFigures(facts: ReadonlyArray<DocFact>): KeyFigureRow[] {
  const shown = facts.map((f, i) => shownFact(f, i));
  // Rows that say more come first (a by-year map over its headline, more years over fewer), so the fuller one is kept.
  const byFullness = shown.slice().sort((a, b) => b.years - a.years || b.tokens.length - a.tokens.length || a.order - b.order);
  const kept: Array<Shown & { keys: string[] }> = [];
  for (const s of byFullness) {
    const into = kept.find((k) => foldsInto(k, s));
    if (into) { into.keys.push(s.f.key); continue; }
    kept.push({ ...s, keys: [s.f.key] });
  }
  // Two rows of one name that say different things: the breakdown says so ("Accounts receivable (breakdown)").
  const named = new Map<string, number>();
  for (const k of kept) named.set(k.label, (named.get(k.label) ?? 0) + 1);
  for (const k of kept) if (k.blob && (named.get(k.label) ?? 0) > 1) k.label = `${k.label} (breakdown)`;
  return kept
    .sort((a, b) => a.order - b.order)
    .map((k) => ({ key: k.f.key, label: k.label, value: k.f.value, text: k.text, keys: k.keys }));
}

/** The names a buyer-facing text must never mention: held parties and staff with a private matter. */
export function heldNamesFor(deal: Pick<Deal, "id" | "extractedInfo" | "cimGeneration">): string[] {
  const info = ((deal.extractedInfo ?? {}) as Info) || {};
  const names = new Set<string>(keepOutFromNotes(info).names ?? []);
  try {
    for (const h of heldPrivateForDeal(deal as Deal)) if (!h.included && h.person) names.add(h.person);
  } catch { /* the rules-only names still hold */ }
  return Array.from(names);
}

/**
 * The buyer-safe key figures of a document (§9.6): at most 6 short facts
 * with a figure, never from a broker-only source, never a held or sensitive
 * clause, never naming a held person.
 */
export function buyerKeyFigures(deal: Pick<Deal, "id" | "extractedInfo" | "cimGeneration">, documentId: string, brokerOnlyDocIds: ReadonlySet<string> = new Set()): Array<{ label: string; value: string }> {
  return buyerKeyFigureRows(deal, documentId, brokerOnlyDocIds).map(({ label, value }) => ({ label, value }));
}

/** The same rows with the fact keys each stands for (the About panel's "Used in the memorandum" matches by key). */
export function buyerKeyFigureRows(deal: Pick<Deal, "id" | "extractedInfo" | "cimGeneration">, documentId: string, brokerOnlyDocIds: ReadonlySet<string> = new Set()): Array<{ label: string; value: string; keys: string[] }> {
  const safe = buyerSafeFactRows(deal, documentId, brokerOnlyDocIds, { figuresOnly: true, maxLen: 160 });
  return presentKeyFigures(safe)
    .sort((a, b) => figureRank(a) - figureRank(b))
    .slice(0, 6)
    .map((f) => ({ label: f.label, value: f.text, keys: f.keys }));
}

/** A document's facts screened for buyers (and for the description model's input, ≤ 25). */
export function buyerSafeFacts(
  deal: Pick<Deal, "id" | "extractedInfo" | "cimGeneration">,
  documentId: string,
  brokerOnlyDocIds: ReadonlySet<string>,
  opts: { figuresOnly: boolean; limit: number; maxLen: number },
): Array<{ label: string; value: string }> {
  return buyerSafeFactRows(deal, documentId, brokerOnlyDocIds, opts)
    .sort((a, b) => figureRank(a) - figureRank(b))
    .slice(0, opts.limit)
    .map((f) => ({ label: f.label, value: f.text }));
}

/** The screened facts themselves (unsorted, every one). Never throws. */
function buyerSafeFactRows(
  deal: Pick<Deal, "id" | "extractedInfo" | "cimGeneration">,
  documentId: string,
  brokerOnlyDocIds: ReadonlySet<string>,
  opts: { figuresOnly: boolean; maxLen: number },
): DocFact[] {
  try {
    const info = ((deal.extractedInfo ?? {}) as Info) || {};
    const facts = documentFacts(info, documentId);
    if (facts.length === 0) return [];
    const safe = cimSafeFacts(info, { brokerOnlyDocIds });
    const pairs = Object.entries(safe).filter(([k]) => !k.startsWith("_"));
    const screened = screenFactsForCim(pairs, keepOutFromNotes(info));
    const safeByKey = new Map(screened.safe);
    const held = new Set<string>(screened.heldNames);
    for (const h of heldPrivateForDeal(deal as Deal)) {
      if (h.included) continue;
      if (h.person) held.add(h.person);
    }
    const heldKeys = new Set(heldPrivateForDeal(deal as Deal).filter((h) => !h.included).map((h) => h.key));
    const heldNames = Array.from(held);
    const out: DocFact[] = [];
    for (const f of facts) {
      if (!safeByKey.has(f.key) || heldKeys.has(f.key)) continue;
      const v = safeByKey.get(f.key);
      // The safe value may have lost years / clauses: keep only this document's part of it.
      let value: unknown = v;
      if (f.value && typeof f.value === "object" && !Array.isArray(f.value) && v && typeof v === "object" && !Array.isArray(v)) {
        const sub: Record<string, unknown> = {};
        for (const y of Object.keys(f.value as Record<string, unknown>)) if (y in (v as Record<string, unknown>)) sub[y] = (v as Record<string, unknown>)[y];
        if (Object.keys(sub).length === 0) continue;
        value = sub;
      }
      const text = valueText(value);
      if (!text || text.length > opts.maxLen || (opts.figuresOnly && !hasFigure(text))) continue;
      if (hasSensitiveDetail(text) || mentionsHeldPerson(`${f.label} ${text}`, heldNames)) continue;
      out.push({ ...f, value, text });
    }
    return out;
  } catch (err: any) {
    console.warn(`[vdr] key figures couldn't be read for document ${documentId}:`, err?.message ?? err);
    return [];
  }
}

// ── Where the CIM uses a document ──────────────────────────────────────────

export type SectionText = { id: string; title: string; text: string };

/** A CIM section's words and figures, for matching (prose + layout data). */
export function sectionText(s: { id: string; sectionTitle: string; brokerEditedContent?: string | null; aiDraftContent?: string | null; layoutData?: unknown }): SectionText {
  const body = [s.brokerEditedContent || s.aiDraftContent || "", ...collectStrings(s.layoutData ?? null)].join("\n");
  return { id: s.id, title: s.sectionTitle, text: body.replace(/\[\[\/?dd\]\]/g, "") };
}

/**
 * CIM pages that print one of this document's figures (§9.6): up to 4,
 * most matches first; a page needs a distinctive amount ($56,023 — not a
 * round $200,000) or two of the document's facts, so a stray "45%" or a
 * round number never links a page.
 */
export function documentCimLinks(facts: ReadonlyArray<DocFact>, sections: ReadonlyArray<SectionText>): { links: Array<{ sectionId: string; title: string; matches: number }>; inCim: Set<string> } {
  const byFact = facts.filter((f) => !IDENTIFIER_KEY.test(f.key)).map((f) => ({ key: f.key, figures: strongFigures(f.text) })).filter((x) => x.figures.length > 0);
  const inCim = new Set<string>();
  const links: Array<{ sectionId: string; title: string; matches: number }> = [];
  if (byFact.length === 0) return { links, inCim };
  for (const s of sections) {
    const known = knownFiguresFrom(s.text);
    let matches = 0;
    let big = false;
    for (const f of byFact) {
      const hit = f.figures.filter((fig) => isKnownFigure(fig, known));
      if (hit.length > 0) {
        // Percentages and round amounts are common on any page: they never link a page on their own.
        if (hit.some((h) => h.kind !== "percent")) matches += 1;
        inCim.add(f.key);
        // A distinctive amount ($56,023 — not a round $200,000 that any page might print) links on its own.
        if (hit.some((h) => h.kind !== "percent" && Math.abs(h.value) >= 10_000 && significantDigits(h.value) >= 3)) big = true;
      }
    }
    if (big || matches >= 2) links.push({ sectionId: s.id, title: s.title, matches });
  }
  return { links: links.sort((a, b) => b.matches - a.matches).slice(0, 4), inCim };
}

// ── Checks (broker) ─────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d: Date | string | null | undefined) => {
  if (!d) return "";
  const x = new Date(d);
  return `${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}`;
};

function sideDocIds(d: Discrepancy): string[] {
  const out: string[] = [];
  if (d.documentId) out.push(d.documentId);
  const sides = (d.sideSources ?? {}) as Record<string, { documentId?: string } | undefined>;
  for (const s of Object.values(sides)) if (s && typeof s.documentId === "string") out.push(s.documentId);
  return out;
}

/**
 * What a document was checked against, for the broker (§5.4): differences
 * involving it (resolved: with the recorded reason; open: a pointer to the
 * Financials tab) and other documents that state the same figure.
 */
export function brokerChecks(
  doc: Pick<Document, "id" | "name">,
  facts: ReadonlyArray<DocFact>,
  discrepancies: ReadonlyArray<Discrepancy>,
  otherDocs: ReadonlyArray<Pick<Document, "id" | "name" | "extractedData" | "visibility">>,
): Array<{ tone: "match" | "resolved" | "open"; text: string }> {
  const out: Array<{ tone: "match" | "resolved" | "open"; text: string }> = [];
  for (const d of discrepancies) {
    if (d.status === "superseded" || !sideDocIds(d).includes(doc.id)) continue;
    const label = factLabel(d.factKey || d.field);
    const year = d.factYear ? ` ${d.factYear}` : "";
    if (d.status === "resolved" || d.status === "accepted") {
      const why = (d.brokerNotes && d.brokerNotes.trim()) || (d.resolvedValue ? `kept ${d.resolvedValue}` : "resolved");
      const vs = d.documentValue && d.interviewValue ? `: ${d.documentValue} vs ${d.interviewValue}` : "";
      out.push({ tone: "resolved", text: `${label}${year}${vs}. Resolved ${day(d.resolvedAt)}: ${short(why, 160)}.` });
    } else {
      out.push({ tone: "open", text: `Open difference: ${label}${year}. See the Financials tab.` });
    }
  }
  // The same figure stated by another (shared) document.
  let matches = 0;
  for (const f of facts) {
    if (matches >= 4) break;
    if (IDENTIFIER_KEY.test(f.key)) continue;
    const figs = strongFigures(f.text).filter((x) => x.kind === "money" || (x.kind === "plain" && x.text.includes(",") && Math.abs(x.value) >= 1000));
    if (figs.length === 0) continue;
    for (const other of otherDocs) {
      if (other.id === doc.id || other.visibility === "broker_only") continue;
      const ed = (other.extractedData ?? null) as Record<string, unknown> | null;
      const ov = ed?.[f.key];
      if (ov === undefined || ov === null) continue;
      const known = knownFiguresFrom(valueText(ov));
      if (figs.some((g) => isKnownFigure(g, known))) {
        out.push({ tone: "match", text: `${f.label} matches ${other.name}.` });
        matches++;
        break;
      }
    }
  }
  return out;
}

/** The broker's list of questions buyers asked about one document. */
export function documentQuestions(
  questions: ReadonlyArray<Pick<BuyerQuestion, "id" | "question" | "status" | "vdrItemId" | "vdrPage" | "vdrTeamMemberId" | "buyerAccessId" | "createdAt" | "isPublished" | "answerScope">>,
  itemId: string,
  who: (q: { buyerAccessId: string | null; vdrTeamMemberId: string | null }) => string,
): Array<{ id: string; question: string; who: string; page: number | null; status: string; statusLabel: string; at: string }> {
  const LABEL: Record<string, string> = { pending_broker: "Needs your answer", pending_seller: "With the seller", published: "Answered", declined: "Declined" };
  return questions
    .filter((q) => q.vdrItemId === itemId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50)
    .map((q) => ({
      id: q.id,
      question: q.question,
      who: who({ buyerAccessId: q.buyerAccessId ?? null, vdrTeamMemberId: q.vdrTeamMemberId ?? null }),
      page: q.vdrPage ?? null,
      status: q.status,
      statusLabel: q.status === "published" && q.answerScope === "room" ? "Answered · shown to its readers" : LABEL[q.status] ?? "Waiting",
      at: new Date(q.createdAt).toISOString(),
    }));
}

/**
 * The CIM sections one buyer is served (what buildBuyerCim gives their
 * level, from the kept copy while an update waits for review). [] when the
 * CIM is held or anything fails — a page link is a nicety, never a leak path.
 */
export async function servedSectionsFor(deal: Deal, accessLevel: string): Promise<SectionText[]> {
  try {
    const { buildBuyerCim, cimHeldFromBuyers } = await import("@shared/cim-buyer-view");
    if (cimHeldFromBuyers(deal as any)) return [];
    const { buyerCimRows, servedBlindCodename } = await import("../cim/published-snapshot");
    const { loadMediaAssets } = await import("../cim/media-store");
    const { listedAskingPrice } = await import("../information/deal-mirror");
    const [rows, media, codename] = await Promise.all([buyerCimRows(deal as any, accessLevel), loadMediaAssets(deal.id), servedBlindCodename(deal as any)]);
    if (rows.missing) return [];
    const cim = buildBuyerCim({
      deal: (codename ? { ...deal, blindCodename: codename } : deal) as any,
      accessLevel,
      sections: rows.sections,
      overrides: rows.overrides,
      media,
      askingPrice: listedAskingPrice(deal),
      published: rows.published,
    });
    return cim.sections.filter((s: any) => !s.locked).map((s: any) => sectionText({ id: s.id, sectionTitle: s.sectionTitle, brokerEditedContent: s.brokerEditedContent, aiDraftContent: s.aiDraftContent, layoutData: s.layoutData }));
  } catch (err: any) {
    console.warn(`[vdr] served sections couldn't be read for deal ${deal.id}:`, err?.message ?? err);
    return [];
  }
}
