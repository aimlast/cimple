/**
 * fiscal-year — one reading of a fiscal-year label, shared by the GL tracing
 * (stream "gl", which owns this file — INTEGRATION §2.16) and the CIM's figure
 * notes and due-diligence checks (stream "dd").
 *
 * STAND-IN on the dd branch: gl creates the real file with the same function
 * and the union of both specs' cases. At the merge the integrator keeps gl's
 * file; dd only imports `fiscalYearKey`, and tests/unit/fiscal-year.test.ts
 * pins the cases dd relies on.
 *
 *   "FY2024", "FY 2024", "FYE 2024", "FY24", "2023/24", "2023-2024",
 *   "2024-12-31", "Dec 31, 2024", "2024"            → "2024"
 *   YTD / TTM / LTM / interim / "9 months" / a quarter / a half → null
 *
 * A two-year range names the year it ENDS in ("2023/24" → "2024"): a fiscal
 * year is called by its year end.
 */

const PART_YEAR = /\b(?:ytd|ttm|ltm|ntm|trailing|interim|year[- ]to[- ]date|run[- ]?rate|annuali[sz]ed|projected|forecast|budget|estimate[sd]?|est\.?|pro[- ]?forma|q[1-4]|h[12]|quarter|half|(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven)\s*(?:-\s*)?months?|(?:\d{1,2})\s*mo\.?)\b/i;

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";

function century(two: string): string {
  const n = Number(two);
  return String(n >= 70 ? 1900 + n : 2000 + n);
}

/** A fiscal-year label → its year ("2024"), or null when it isn't one full fiscal year. */
export function fiscalYearKey(label: unknown): string | null {
  if (label === null || label === undefined) return null;
  const raw = String(label).trim();
  if (!raw || raw.length > 40) return null;
  if (PART_YEAR.test(raw)) return null;
  const s = raw.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();

  // ISO date: "2024-12-31", "2024/12/31".
  let m = s.match(/^((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return m[1];
  // "Dec 31, 2024", "31 December 2024", "December 2024".
  m = s.match(new RegExp(`^(?:(?:${MONTHS})\\.?\\s+\\d{1,2},?\\s+|\\d{1,2}\\s+(?:${MONTHS})\\.?,?\\s+|(?:${MONTHS})\\.?,?\\s+)((?:19|20)\\d{2})$`, "i"));
  if (m) return m[1];
  // "FY2024", "FY 2024", "FYE 2024", "FYE Dec 2024", "Fiscal 2024", "Fiscal year 2024".
  m = s.match(new RegExp(`^(?:fye?|fiscal(?:\\s+year)?|year(?:\\s+ended)?)\\s*'?(?:(?:${MONTHS})\\.?\\s+)?((?:19|20)\\d{2})$`, "i"));
  if (m) return m[1];
  // "FY24", "FY'24", "FYE24".
  m = s.match(/^fye?\s*'?(\d{2})$/i);
  if (m) return century(m[1]);
  // "2023/24", "2023-24", "2023–2024", "2023/2024", "FY2023/24".
  m = s.match(/^(?:fye?\s*)?((?:19|20)\d{2})\s*[-/–—]\s*((?:19|20)?\d{2})$/i);
  if (m) {
    const start = Number(m[1]);
    const end = m[2].length === 2 ? Number(century(m[2])) : Number(m[2]);
    return end === start + 1 ? String(end) : null;
  }
  // A bare year, optionally "2024A" (actual) or "2024 actual".
  m = s.match(/^((?:19|20)\d{2})(?:\s*a|\s+actuals?)?$/i);
  if (m) return m[1];
  return null;
}
