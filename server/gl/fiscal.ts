/**
 * fiscal.ts — which fiscal year a ledger entry belongs to (gl spec D26).
 * The deal's fiscal-year end lives in one place, gl_tracing.fiscal_year_end;
 * it is set when that row is created from the deal's facts (taxYearEnd /
 * fiscalYearEnd / yearEnd), else the statements' period end, else Dec 31.
 * Pure.
 */
import { fiscalYearKey, fiscalYearOfDate, fiscalYearRange, normaliseFiscalYearEnd } from "@shared/fiscal-year";

export { fiscalYearKey, fiscalYearRange, normaliseFiscalYearEnd };

/** The fiscal year (the year it ends in) of an entry dated `isoDate`, for a fiscal year ending `fye` ("MM-DD"). */
export function fiscalYearOf(isoDate: string, fye: string = "12-31"): string {
  return fiscalYearOfDate(isoDate, fye) ?? isoDate.slice(0, 4);
}

const MONTH_END: Record<string, string> = {
  jan: "01-31", feb: "02-28", mar: "03-31", apr: "04-30", may: "05-31", jun: "06-30",
  jul: "07-31", aug: "08-31", sep: "09-30", oct: "10-31", nov: "11-30", dec: "12-31",
};

/** A fiscal-year end written any common way ("December 31", "FYE March 31", "2024-03-31", "Mar 31, 2024", "June") → "MM-DD", or null. */
export function fyeFromText(value: unknown): string | null {
  if (typeof value === "number") return null;
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (!s || s.length > 80) return null;
  const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return normaliseFiscalYearEnd(`${iso[2]}-${iso[3]}`);
  const named = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/) ?? s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (named) {
    const [m, d] = /^\d/.test(named[1]) ? [named[2], named[1]] : [named[1], named[2]];
    return normaliseFiscalYearEnd(`${MONTH_END[m].slice(0, 2)}-${d}`);
  }
  const monthOnly = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (monthOnly) return MONTH_END[monthOnly[1]];
  const mmdd = s.match(/^(\d{1,2})[\/-](\d{1,2})$/);
  if (mmdd) return normaliseFiscalYearEnd(`${mmdd[1]}-${mmdd[2]}`);
  return null;
}

/**
 * The deal's fiscal-year end: the facts first (taxYearEnd, fiscalYearEnd,
 * yearEnd), then the period end most of its statements report, else 12-31.
 */
export function fiscalYearEndFor(
  deal: { extractedInfo?: unknown } | null | undefined,
  docs: ReadonlyArray<{ category?: string | null; subcategory?: string | null; sourceMeta?: unknown }> = [],
): string {
  const info = (deal?.extractedInfo && typeof deal.extractedInfo === "object" ? deal.extractedInfo : {}) as Record<string, unknown>;
  for (const k of ["fiscalYearEnd", "taxYearEnd", "yearEnd", "fiscalYearEndDate"]) {
    const v = fyeFromText(info[k]);
    if (v) return v;
  }
  const counts = new Map<string, number>();
  for (const d of docs) {
    if (d.subcategory === "general_ledger" || d.subcategory === "addback_support") continue;
    const pe = (d.sourceMeta as { periodEnd?: string } | null)?.periodEnd;
    const v = typeof pe === "string" ? fyeFromText(pe) : null;
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : "12-31";
}

/** The fiscal years a ledger's dates span (keys), oldest first. */
export function yearRange(firstDate: string, lastDate: string, fye: string = "12-31"): string[] {
  const a = Number(fiscalYearOf(firstDate, fye));
  const b = Number(fiscalYearOf(lastDate, fye));
  const out: string[] = [];
  for (let y = a; y <= b && out.length < 50; y++) out.push(String(y));
  return out;
}
