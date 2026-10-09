/**
 * figure-lines — the financial lines the CIM's figure notes and the
 * due-diligence checks know about (stream "dd", spec §8).
 *
 * A figure is a line in a year: `figureKey(line, "2023")` →
 * "operatingExpenses|2023". Standard lines (revenue, cost of sales, …) are
 * listed here; the analysis's own statement lines ("Facility rent —
 * warehouse") are `line:<slug>` keys made by `lineSlug`.
 *
 * Pure: used by the server (registry, checks, notes) and the browser.
 */

export type StandardLineId =
  | "revenue" | "costOfSales" | "grossProfit" | "operatingExpenses" | "nonRecurring" | "ebitda"
  | "otherIncome" | "amortization" | "interest" | "incomeBeforeTax" | "incomeTaxes" | "netIncome";

/** A standard line id, or an analysis line "line:<slug>". */
export type LineId = StandardLineId | `line:${string}`;

export interface FigureLine {
  id: StandardLineId;
  label: string;
  /** Per-document `*ByYear` keys that state this line (documents.extracted_data and the deal's facts). */
  factKeys: string[];
  /** CIM row labels that mean this line. */
  labelRe: RegExp;
  /** Words a note or an analysis hint may use for it (rent → lease/premises/warehouse/occupancy). */
  synonyms: string[];
  /** A total with components (its change can be broken down — D7). */
  total: boolean;
  /** An expense: compared as an absolute amount (parentheses / minus signs don't matter). */
  expense: boolean;
  /**
   * How it compares across records (D4): "direct" = same definition on a tax
   * return; "grouping" = tax forms group it differently (compared only when the
   * difference is worked out — D6); "none" = never compared.
   */
  comparable: "direct" | "grouping" | "none";
  /** Can the seller be asked what drove it? Never for EBITDA, SDE, margins or net income (money-talk rule). */
  askable: boolean;
  /** The category word a Blind CIM note uses (never an analysis line label). */
  blindWord: string;
}

export const FIGURE_LINES: readonly FigureLine[] = [
  {
    id: "revenue", label: "Revenue",
    factKeys: ["revenueByYear", "totalRevenueByYear", "salesByYear", "netSalesByYear", "grossRevenueByYear"],
    labelRe: /^(?:total\s+|net\s+|gross\s+|annual\s+)?(?:revenues?|sales)(?:\s*\((?:cad|usd|\$)\))?$/i,
    synonyms: ["revenue", "sales"], total: true, expense: false, comparable: "direct", askable: true, blindWord: "revenue",
  },
  {
    id: "costOfSales", label: "Cost of sales",
    factKeys: ["costOfSalesByYear", "costOfGoodsSoldByYear", "cogsByYear", "costOfRevenueByYear", "directCostsByYear"],
    labelRe: /^(?:total\s+)?(?:cost\s+of\s+(?:sales|goods\s+sold|revenues?)|cogs|direct\s+costs)$/i,
    synonyms: ["cost of sales", "cost of goods", "cogs", "direct costs"], total: true, expense: true, comparable: "direct", askable: true, blindWord: "cost of sales",
  },
  {
    id: "grossProfit", label: "Gross profit",
    factKeys: ["grossProfitByYear", "grossMarginDollarsByYear"],
    labelRe: /^gross\s+profit$/i,
    synonyms: ["gross profit"], total: true, expense: false, comparable: "direct", askable: true, blindWord: "gross profit",
  },
  {
    id: "operatingExpenses", label: "Operating expenses",
    factKeys: ["operatingExpensesByYear", "totalOperatingExpensesByYear", "totalExpensesByYear"],
    labelRe: /^(?:total\s+)?(?:operating\s+expenses|operating\s+costs|opex|overhead(?:\s+expenses)?|selling,?\s+general\s+(?:and|&)\s+administrative(?:\s+expenses)?|sg&a)$/i,
    synonyms: ["operating expenses", "operating costs", "overhead", "opex"], total: true, expense: true, comparable: "grouping", askable: true, blindWord: "operating expenses",
  },
  {
    id: "nonRecurring", label: "One-time costs",
    factKeys: [],
    labelRe: /^(?:one[- ]time(?:\s*\/\s*non[- ]recurring)?|non[- ]recurring|unusual)\s+(?:expenses|costs|items)$/i,
    synonyms: ["one-time", "non-recurring"], total: true, expense: true, comparable: "none", askable: false, blindWord: "one-time costs",
  },
  {
    id: "ebitda", label: "EBITDA",
    factKeys: ["ebitdaByYear", "reportedEbitdaByYear"],
    labelRe: /^(?:reported\s+)?ebitda(?:\s*\((?:as\s+)?reported\))?$/i,
    synonyms: ["ebitda"], total: true, expense: false, comparable: "grouping", askable: false, blindWord: "EBITDA",
  },
  {
    id: "otherIncome", label: "Other income",
    factKeys: ["otherIncomeByYear", "gainOnDisposalByYear", "gainOnSaleOfAssetsByYear"],
    labelRe: /^(?:other\s+income|gain\s+on\s+(?:sale|disposal)(?:\s+of\s+(?:assets|equipment|capital\s+assets))?)$/i,
    synonyms: ["other income", "gain on disposal", "gain on sale"], total: false, expense: false, comparable: "direct", askable: true, blindWord: "other income",
  },
  {
    id: "amortization", label: "Depreciation & amortization",
    factKeys: ["amortizationByYear", "depreciationByYear", "depreciationAndAmortizationByYear", "amortisationByYear"],
    labelRe: /^(?:depreciation(?:\s+(?:and|&)\s+amorti[sz]ation)?|amorti[sz]ation(?:\s+(?:and|&)\s+depreciation)?|amorti[sz]ation\s+of\s+(?:capital|property|tangible)\s+assets)$/i,
    synonyms: ["depreciation", "amortization", "amortisation"], total: false, expense: true, comparable: "direct", askable: true, blindWord: "depreciation",
  },
  {
    id: "interest", label: "Interest",
    factKeys: ["interestExpenseByYear", "interestByYear", "interestOnLongTermDebtByYear"],
    labelRe: /^(?:interest(?:\s+(?:expense|costs?|on\s+(?:long[- ]term\s+)?debt))?|interest\s+and\s+bank\s+charges)$/i,
    synonyms: ["interest"], total: false, expense: true, comparable: "direct", askable: true, blindWord: "interest",
  },
  {
    id: "incomeBeforeTax", label: "Income before income taxes",
    factKeys: ["incomeBeforeTaxByYear", "incomeBeforeTaxesByYear", "pretaxIncomeByYear", "earningsBeforeTaxByYear"],
    labelRe: /^(?:(?:net\s+)?income|earnings|profit)\s+before\s+(?:income\s+)?tax(?:es)?$|^pre-?tax\s+(?:income|earnings|profit)$/i,
    synonyms: ["income before taxes", "pre-tax income"], total: true, expense: false, comparable: "direct", askable: false, blindWord: "income before taxes",
  },
  {
    id: "incomeTaxes", label: "Income taxes",
    factKeys: ["incomeTaxesByYear", "incomeTaxByYear", "incomeTaxExpenseByYear", "provisionForIncomeTaxesByYear"],
    labelRe: /^(?:provision\s+for\s+)?(?:income|corporate)\s+tax(?:es)?(?:\s+expense)?$/i,
    synonyms: ["income tax", "income taxes"], total: false, expense: true, comparable: "direct", askable: true, blindWord: "income taxes",
  },
  {
    id: "netIncome", label: "Net income",
    factKeys: ["netIncomeByYear", "netEarningsByYear", "netProfitByYear"],
    labelRe: /^net\s+(?:income|earnings|profit)(?:\s*\((?:loss|as\s+reported)\))?$|^net\s+income\s*\/\s*\(loss\)$/i,
    synonyms: ["net income", "net earnings", "net profit"], total: true, expense: false, comparable: "direct", askable: false, blindWord: "net income",
  },
];

const BY_ID = new Map<string, FigureLine>(FIGURE_LINES.map((l) => [l.id, l]));

export function standardLine(id: string): FigureLine | null {
  return BY_ID.get(id) ?? null;
}

/** Row label as compared: no footnote marks, currency notes or trailing colons; spacing folded. */
export function cleanRowLabel(label: unknown): string {
  return String(label ?? "")
    .replace(/[*†‡¹²³⁴⁵⁶⁷⁸⁹]+/g, "")
    .replace(/\s*\((?:cad|usd|c\$|us\$|\$|000s?|in\s+thousands)\)\s*/gi, " ")
    .replace(/[:\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The standard line a CIM row label means, or null. */
export function lineForLabel(label: unknown): StandardLineId | null {
  const l = cleanRowLabel(label);
  if (!l) return null;
  // Margins, ratios and adjusted / normalised figures are never these lines.
  if (/margin|%|ratio|per\s|adjusted|normali[sz]ed|pro\s*forma|sde\b|discretionary|multiple|growth|cagr|yoy|change/i.test(l)) return null;
  for (const line of FIGURE_LINES) if (line.labelRe.test(l)) return line.id;
  return null;
}

/** A label's words as a slug ("Facility rent — warehouse" → "facility-rent-warehouse"). */
export function slugOf(name: unknown): string {
  return String(name ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** An analysis statement line's id ("line:facility-rent-warehouse"). */
export function lineSlug(name: unknown): LineId {
  return `line:${slugOf(name)}`;
}

export function figureKey(line: LineId, year: string): string {
  return `${line}|${year}`;
}

export function parseFigureKey(key: string): { line: LineId; year: string } | null {
  const i = key.lastIndexOf("|");
  if (i <= 0) return null;
  const line = key.slice(0, i);
  const year = key.slice(i + 1);
  if (!/^\d{4}$/.test(year)) return null;
  if (!BY_ID.has(line) && !/^line:[a-z0-9-]{1,60}$/.test(line)) return null;
  return { line: line as LineId, year };
}

/** Is it one of the standard lines (not an analysis line)? */
export function isStandardLine(line: string): line is StandardLineId {
  return BY_ID.has(line);
}

/**
 * Words that identify a line in free text (analysis hints, a seller's
 * message): the standard line's synonyms, or an analysis line's own
 * meaningful words plus the synonyms of the family it reads like.
 */
export function lineWords(line: LineId, label?: string | null): string[] {
  const std = standardLine(line);
  if (std) return std.synonyms;
  const words = String(label ?? line.replace(/^line:/, "").replace(/-/g, " "))
    .toLowerCase()
    .replace(/&/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !LINE_STOPWORDS.has(w));
  const out = new Set(words);
  for (const [word, syns] of Object.entries(SYNONYM_FAMILIES)) {
    if (words.includes(word)) for (const s of syns) out.add(s);
  }
  return Array.from(out);
}

const LINE_STOPWORDS = new Set(["expenses", "expense", "costs", "other", "total", "general", "including", "incl", "benefits", "with", "from", "into"]);

/** Words that mean the same thing in a hint or a seller's message. */
const SYNONYM_FAMILIES: Record<string, string[]> = {
  rent: ["lease", "premises", "warehouse", "occupancy", "rent"],
  facility: ["lease", "premises", "warehouse", "occupancy", "rent"],
  occupancy: ["lease", "premises", "rent"],
  fuel: ["fuel", "diesel", "gas prices"],
  wages: ["wages", "salaries", "payroll", "staff", "labour", "labor"],
  salaries: ["wages", "salaries", "payroll", "staff"],
  labour: ["labour", "labor", "wages", "payroll"],
  professional: ["legal", "accounting", "lawyer", "accountant", "professional fees"],
  repairs: ["repairs", "maintenance", "servicing"],
  maintenance: ["repairs", "maintenance", "servicing"],
  insurance: ["insurance", "premium", "premiums"],
  advertising: ["advertising", "marketing", "promotion"],
  marketing: ["advertising", "marketing", "promotion"],
  bank: ["bank charges", "merchant fees", "card fees"],
  debts: ["bad debt", "bad debts", "write-off", "write-offs", "collections"],
};
