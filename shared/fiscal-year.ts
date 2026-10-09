/**
 * fiscal-year.ts — one rule for "which fiscal year does this label mean".
 *
 * Financial analyses, statements and tax returns label their years in many
 * ways ("2024", "FY2024", "FY 2024", "FYE 2024", "FY24", "2023/24",
 * "2023-2024", "2024-12-31", "Dec 31, 2024", "Year ended March 31, 2024").
 * Everything that compares years across sources (the general-ledger
 * add-back tracing, the DD figure checks) keys them through fiscalYearKey:
 * the calendar year the fiscal year ENDS in, as a 4-digit string.
 *
 * A label that is not one full fiscal year — year-to-date, trailing or last
 * twelve months, an interim period, "9 months", a quarter, a forecast or
 * budget — has no key (null): it can't be matched to a full year of books.
 *
 * Shared by gl (INTEGRATION §2.16, created here) and dd. Pure.
 */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

/** Words that make a label something other than one full fiscal year. */
const NOT_A_FULL_YEAR =
  /\b(?:ytd|y\.t\.d|year[\s-]*to[\s-]*date|ttm|ltm|trailing|last\s+twelve|last\s+12|interim|stub|partial|half[\s-]*year|h[12]|q[1-4]|quarter|(?:[1-9]|1[01]|one|two|three|four|five|six|seven|eight|nine|ten|eleven)[\s-]*(?:months?|mos?\.?|mths?)|forecast|projected|projection|budget|budgeted|estimated|estimate|est\.?|pro\s*forma|run[\s-]*rate|annuali[sz]ed|plan)\b/i;

/** A two- or four-digit year → four digits (24 → 2024, 99 → 1999). */
function fullYear(y: string): number {
  const n = Number(y);
  if (y.length === 4) return n;
  return n >= 70 ? 1900 + n : 2000 + n;
}

function plausible(y: number): boolean {
  return y >= 1950 && y <= 2100;
}

/**
 * "FY2024" | "FY 2024" | "FYE 2024" | "FY24" | "2023/24" | "2023-2024" |
 * "2024-12-31" | "Dec 31, 2024" | "2024" → "2024";
 * YTD / TTM / LTM / interim / "9 months" / quarter / forecast → null.
 */
export function fiscalYearKey(label: unknown): string | null {
  if (typeof label === "number" && Number.isInteger(label)) return plausible(label) ? String(label) : null;
  if (typeof label !== "string") return null;
  const raw = label.trim();
  if (!raw || raw.length > 80) return null;
  if (NOT_A_FULL_YEAR.test(raw)) return null;
  // "12 months" / "twelve months" is a full year; drop the words.
  const s = raw.toLowerCase().replace(/[’']/g, "").replace(/\s+/g, " ").replace(/\b(?:twelve|12)[\s-]*months?\b/g, " ").replace(/\s+/g, " ").trim();

  // "2024A" (actual) is the year; "2025E" / "2025B" (estimate, budget) is not.
  let a = s.match(/^(?:fy\s*)?((?:19|20)\d{2})\s*a$/);
  if (a) return plausible(+a[1]) ? a[1] : null;
  if (/^(?:fy\s*)?(?:19|20)\d{2}\s*[eb]$/.test(s)) return null;

  // A full date: ISO "2024-12-31" / "2024/12/31", or "31/12/2024" / "12/31/2024" — the year is the date's year.
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return plausible(+m[1]) ? m[1] : null;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return plausible(+m[3]) ? m[3] : null;

  // A range of two years: "2023/24", "2023-2024", "2023–24", "FY2023/24" → the later (the year it ends in).
  m = s.match(/(?:^|[^\d])((?:19|20)\d{2})\s*[-/–—]\s*(\d{2}|\d{4})(?![\d])/);
  if (m) {
    const a = +m[1];
    const b = m[2].length === 2 ? Math.floor(a / 100) * 100 + +m[2] : +m[2];
    if (b === a + 1 && plausible(b)) return String(b);
    // "2024-12" style (a month) is not a range.
    if (m[2].length === 2 && +m[2] >= 1 && +m[2] <= 12 && b !== a + 1) return plausible(a) ? String(a) : null;
    return null;
  }

  // A month name with a 4-digit year anywhere ("Dec 31, 2024", "Year ended March 31, 2024", "FYE Mar 2024").
  const monthWord = s.match(/\b([a-z]{3,9})\.?\b/g)?.some((w) => MONTHS[w.replace(/\./, "")] !== undefined) ?? false;
  const years = s.match(/(?<!\d)(?:19|20)\d{2}(?!\d)/g) ?? [];
  if (years.length === 1) {
    const y = +years[0];
    if (!plausible(y)) return null;
    // Anything else in the label must be fiscal-year wording, a month/day, or punctuation.
    const rest = s
      .replace(years[0], " ")
      .replace(/\b(?:fiscal|fy|fye|f\/y|year|years|yr|ended|ending|end|ends|as at|as of|at|for|the|of|actual|actuals|audited|reviewed|compiled|restated|reported|statement|statements|calendar|cy|total|f)\b/g, " ")
      .replace(/\b(?:[a-z]{3,9})\.?\b/g, (w) => (MONTHS[w.replace(/\./, "")] !== undefined ? " " : w))
      .replace(/\b\d{1,2}(?:st|nd|rd|th)?\b/g, (d) => (monthWord ? " " : d))
      .replace(/[\s,.:;()\[\]#-]+/g, "");
    if (rest === "") return String(y);
    return null;
  }
  if (years.length > 1) return null;

  // A two-digit fiscal year: "FY24", "FY 24", "FYE24", "F24".
  m = s.match(/^(?:fy|fye|f)\s*'?(\d{2})$/);
  if (m) {
    const y = fullYear(m[1]);
    return plausible(y) ? String(y) : null;
  }
  return null;
}

/** The fiscal year (key) a date falls in, for a fiscal year ending on `fye` ("MM-DD"). "2024-03-31" with FYE 03-31 → "2024"; "2024-04-01" → "2025". */
export function fiscalYearOfDate(isoDate: string, fye: string = "12-31"): string | null {
  const d = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const f = (fye || "12-31").match(/^(\d{1,2})-(\d{1,2})$/);
  if (!d) return null;
  const year = +d[1];
  const mm = +d[2];
  const dd = +d[3];
  const fm = f ? +f[1] : 12;
  const fd = f ? +f[2] : 31;
  // On or before the fiscal year end (month/day) → this calendar year's fiscal year; after it → next year's.
  const after = mm > fm || (mm === fm && dd > fd);
  return String(after ? year + 1 : year);
}

/** "MM-DD" when the value is a valid month-day (Feb 29 allowed), else null. */
export function normaliseFiscalYearEnd(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  let m = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (!m) m = s.match(/^\d{4}-(\d{1,2})-(\d{1,2})$/);
  if (!m) {
    const named = s.toLowerCase().match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/) ?? s.toLowerCase().match(/^(\d{1,2})\s+([a-z]{3,9})\.?$/);
    if (named) {
      const [w, d] = /^\d/.test(named[1]) ? [named[2], named[1]] : [named[1], named[2]];
      const mo = MONTHS[w];
      if (mo) m = ["", String(mo), d] as unknown as RegExpMatchArray;
    }
  }
  if (!m) return null;
  const mo = +m[1];
  const d = +m[2];
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || d < 1 || d > days[mo - 1]) return null;
  return `${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The first and last day of a fiscal year (key "2024", FYE "03-31" → 2023-04-01 … 2024-03-31). */
export function fiscalYearRange(key: string, fye: string = "12-31"): { start: string; end: string } | null {
  if (!/^\d{4}$/.test(key)) return null;
  const f = normaliseFiscalYearEnd(fye) ?? "12-31";
  const [fm, fd] = f.split("-").map(Number);
  const y = +key;
  // Feb 29 in a non-leap year ends on Feb 28.
  const leap = (yy: number) => (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0;
  const endDay = fm === 2 && fd === 29 && !leap(y) ? 28 : fd;
  const end = `${y}-${String(fm).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
  const endDate = new Date(Date.UTC(y - 1, fm - 1, (fm === 2 && fd === 29 && !leap(y - 1) ? 28 : fd)));
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  return { start: endDate.toISOString().slice(0, 10), end };
}
