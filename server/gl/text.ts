/**
 * text.ts — small pure helpers for reading ledgers: money, dates, delimited
 * lines, account keys, the words an add-back is found by, and escaping for
 * SQL patterns. The old add-back verifier's helpers moved here (it imports
 * them back) so both read money and categories the same way.
 */

// ── Categories (moved from server/financial/addback-verifier.ts) ─────────

export const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/payroll|salary|salaries|wage|wages|cpp|ei |employer|benefit/i, "payroll"],
  [/rent|lease|occupancy/i, "rent"],
  [/hydro|electric|gas bill|water|utilit|internet|phone|telecom/i, "utilities"],
  [/insurance|wsib|premium/i, "insurance"],
  [/legal|accounting|bookkeep|consult|professional|cpa|lawyer/i, "professional_fees"],
  [/owner|shareholder|draw|dividend|management fee/i, "owner_draw"],
  [/travel|flight|hotel|airfare|mileage/i, "travel"],
  [/meal|restaurant|entertain|coffee/i, "meals"],
  [/vehicle|auto|fuel|car |truck|parking/i, "vehicle"],
  [/supplies|office|stationery|software|subscription/i, "supplies"],
  [/deprec|amortiz/i, "depreciation"],
  [/interest|loan|bank charge|finance charge/i, "interest"],
  [/tax|hst|gst|cra|irs/i, "taxes"],
  [/sales|revenue|income|deposit|invoice/i, "revenue"],
];

export function guessCategory(...texts: string[]): string {
  const joined = texts.join(" ");
  for (const [re, category] of CATEGORY_KEYWORDS) {
    if (re.test(joined)) return category;
  }
  return "other";
}

/** One delimited line → trimmed fields ("" quotes doubled inside quotes). */
export function splitDelimited(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/** A money cell as dollars ("(1,234.56)" → -1234.56), or null. (The old verifier's reader.) */
export function parseMoney(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (!s || s === "-" || s === "—") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.endsWith("-")) { negative = true; s = s.slice(0, -1); }
  if (s.startsWith("-")) { negative = true; s = s.slice(1); }
  s = s.replace(/^(cr|dr)\s*/i, "").replace(/[$€£,\s]/g, "").replace(/(cad|usd)$/i, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** A loose date → yyyy-mm-dd (the old verifier's reader; ledgers use parseLedgerDate). */
export function normalizeDate(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  const iso = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  // Unparseable and no digits at all ("Total", "Opening balance") — not a date
  return /\d/.test(s) ? s : "";
}

// ── The words an add-back is found by (moved from addback-verifier.ts) ──

/** Words that name nothing an add-back could be found by. */
export const TERM_STOP = new Set([
  "the", "and", "for", "from", "with", "that", "this", "are", "was", "were", "per", "year", "years", "annual", "annually",
  "monthly", "month", "business", "company", "expense", "expenses", "cost", "costs", "addback", "add", "back", "amount",
  "paid", "pays", "payment", "payments", "through", "run", "runs", "not", "non", "all", "any", "one", "time", "normal",
  "normalization", "adjustment", "adjust", "adjusted", "total", "part", "portion", "full", "only", "into", "out", "over",
]);

/** More words an add-back's category is found by in a ledger. */
export const CATEGORY_TERMS: Record<string, string[]> = {
  owner_comp: ["owner", "shareholder", "officer", "management", "salary", "salaries", "draw", "draws", "bonus", "compensation", "dividend"],
  discretionary: ["meal", "meals", "entertainment", "travel", "vehicle", "auto", "personal", "club", "membership", "donation", "gift"],
  related_party: ["related", "management fee", "consulting", "rent", "family"],
  one_time: ["legal", "settlement", "consulting", "relocation", "moving", "severance", "repair", "one-time"],
  non_recurring: ["legal", "settlement", "consulting", "relocation", "moving", "severance", "repair"],
  non_cash: ["depreciation", "amortization", "amortisation"],
  other: [],
};

/** A literal for a regular expression (every special character escaped). */
export function escapeRegexTerm(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A literal for SQL LIKE / ILIKE (with `\` as the escape character): %, _ and \ escaped. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** What an add-back is looked for by in a ledger: its own words, and its category's. */
export function addbackTerms(ab: { label: string; description?: string | null; category?: string | null }): string[] {
  const own = `${ab.label} ${ab.description ?? ""}`.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length >= 3 && !TERM_STOP.has(w) && !/^\d+$/.test(w));
  return Array.from(new Set([...own, ...(CATEGORY_TERMS[ab.category ?? ""] ?? [])]));
}

// ── Labels and accounts ──────────────────────────────────────────────────

/** The analysis's own label key (analyzer.ts normalizeLabel): lower-case, every run of other characters one space. */
export function normalizeLabel(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** An account number prefix or suffix the exports put on names ("6110 · Vehicle - Owner", "Vehicle - Owner (6110)"). */
export const ACCOUNT_NUMBER_PREFIX = /^(\d{3,6}(?:[.-]\d{1,4})?)\s*[·\-–—:]\s*/;
export const ACCOUNT_NUMBER_SUFFIX = /\s*\((\d{2,6}(?:[.-]\d{1,4})?)\)$/;

/** Splits "6110 · Vehicle - Owner" / "Vehicle - Owner (6110)" into the name and the number. */
/** "5300 Advertising & Promotion" (Sage 50, adjusting entries): a 4–6 digit number, a space, then a word. */
const ACCOUNT_NUMBER_SPACE = /^(\d{4,6})\s+(?=[A-Za-z])/;

export function splitAccountNumber(raw: string): { name: string; number: string | null } {
  let name = raw.trim();
  let number: string | null = null;
  const pre = name.match(ACCOUNT_NUMBER_PREFIX) ?? name.match(ACCOUNT_NUMBER_SPACE);
  if (pre && name.length > pre[0].length) {
    number = pre[1];
    name = name.slice(pre[0].length).trim();
  }
  const suf = name.match(ACCOUNT_NUMBER_SUFFIX);
  if (suf && name.length > suf[0].length) {
    number = number ?? suf[1];
    name = name.slice(0, name.length - suf[0].length).trim();
  }
  return { name, number };
}

/**
 * The key two exports of the same account share: lower-case, number prefixes
 * and punctuation stripped, each level of a "Parent:Child" path kept
 * ("6100 · Automobile Expense:6110 · Vehicle - Owner" → "automobile expense:vehicle owner").
 */
export function accountKey(account: string): string {
  return account
    .split(":")
    .map((part) => splitAccountNumber(part).name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim())
    .filter(Boolean)
    .join(":");
}

// ── Money and dates in ledger cells ──────────────────────────────────────

/** Currency marks a ledger cell may carry (two different ones in a file → `mixed_currencies`). */
export function currencyOf(raw: string): string | null {
  const s = raw.toUpperCase();
  if (/\bCAD\b|C\$|CA\$/.test(s)) return "CAD";
  if (/\bUSD\b|US\$/.test(s)) return "USD";
  if (/€|\bEUR\b/.test(s)) return "EUR";
  if (/£|\bGBP\b/.test(s)) return "GBP";
  return null;
}

/**
 * A money cell → cents, or null. Handles "(1,234.56)", "1,234.56-",
 * "-1234.56", "CR 500" (negative) / "DR 500", currency marks ($, C$, US$, €,
 * £, CAD, USD), thousands separators, and numbers from a spreadsheet as is.
 * A European "1.234,56" is read when the comma is clearly the decimal mark.
 */
export function parseMoneyToCents(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || /^[-–—]+$/.test(s)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  if (/^cr\b/i.test(s) || /\bcr$/i.test(s)) { negative = !negative; s = s.replace(/^cr\b|\bcr$/i, "").trim(); }
  else if (/^dr\b/i.test(s) || /\bdr$/i.test(s)) { s = s.replace(/^dr\b|\bdr$/i, "").trim(); }
  s = s.replace(/\b(?:cad|usd|eur|gbp)\b/gi, "").replace(/(?:c|ca|us)?\$|€|£/gi, "").trim();
  if (s.endsWith("-")) { negative = !negative; s = s.slice(0, -1).trim(); }
  if (s.startsWith("-") || s.startsWith("−")) { negative = !negative; s = s.slice(1).trim(); }
  if (s.startsWith("+")) s = s.slice(1).trim();
  if (/^\(.*\)$/.test(s)) { negative = !negative; s = s.slice(1, -1).trim(); }
  s = s.replace(/[\s ']/g, "");
  // 1.234,56 (comma decimal) vs 1,234.56
  if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

const MONTH_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function ymd(y: number, m: number, d: number): string | null {
  if (y < 1950 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > days) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** An Excel serial day (1900 system) → yyyy-mm-dd. 45292 → 2024-01-01. Time-zone free. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 18264 || serial > 73051) return null; // 1950..2100
  const ms = Math.round((Math.floor(serial) - 25569) * 86400000);
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

export type DateOrder = "ymd" | "mdy" | "dmy";

/** The numeric parts of a slash/dash/dot date ("03/01/2024" → [3, 1, 2024]), or null. */
export function numericDateParts(raw: string): [number, number, number] | null {
  const m = raw.trim().match(/^(\d{1,4})[\/.\-](\d{1,2})[\/.\-](\d{1,4})(?:[ T].*)?$/);
  if (!m) return null;
  return [+m[1], +m[2], +m[3]];
}

/**
 * A ledger date cell → yyyy-mm-dd, or null. ISO and year-first dates read as
 * such; "03/01/2024" by the file's order (mdy / dmy); month names ("Mar 1,
 * 2024", "1-Mar-24", "01 Mar 2024"); spreadsheet serial days; a date cell
 * already read as { date }. Two-digit years are 20xx (19xx from 70).
 */
export function parseLedgerDate(raw: unknown, order: DateOrder = "mdy"): string | null {
  if (raw && typeof raw === "object" && typeof (raw as { date?: unknown }).date === "string") {
    const iso = (raw as { date: string }).date;
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
  }
  if (typeof raw === "number") return excelSerialToIso(raw);
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 40) return null;
  const yy = (y: number) => (y < 100 ? (y >= 70 ? 1900 + y : 2000 + y) : y);
  let m = s.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})(?:[ T].*)?$/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  const parts = numericDateParts(s);
  if (parts) {
    const [a, b, c] = parts;
    if (c < 100 || c >= 1000) {
      const y = yy(c);
      if (order === "dmy") return ymd(y, b, a);
      if (order === "ymd") return null;
      return ymd(y, a, b);
    }
    return null;
  }
  // "Mar 1, 2024" / "March 1 2024"
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (m) {
    const mo = MONTH_NUM[m[1].slice(0, 4).toLowerCase()] ?? MONTH_NUM[m[1].slice(0, 3).toLowerCase()];
    return mo ? ymd(yy(+m[3]), mo, +m[2]) : null;
  }
  // "1-Mar-24" / "01 Mar 2024" / "1 March, 2024"
  m = s.match(/^(\d{1,2})[\s\-\/.]([A-Za-z]{3,9})\.?[\s\-\/.,]+(\d{2,4})$/);
  if (m) {
    const mo = MONTH_NUM[m[2].slice(0, 4).toLowerCase()] ?? MONTH_NUM[m[2].slice(0, 3).toLowerCase()];
    return mo ? ymd(yy(+m[3]), mo, +m[1]) : null;
  }
  // A serial typed as text ("45292").
  if (/^\d{5}(?:\.\d+)?$/.test(s)) return excelSerialToIso(Number(s));
  return null;
}

/** Text of a cell for display/storage: trimmed, inner whitespace collapsed, at most `max` characters. */
export function cellText(raw: unknown, max = 300): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "object" && typeof (raw as { date?: unknown }).date === "string") return (raw as { date: string }).date;
  const s = typeof raw === "number" ? String(raw) : String(raw);
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}
