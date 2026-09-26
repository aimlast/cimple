/**
 * Reading headline numbers out of fact prose, for matching and the
 * outside-buyer brief. Facts are often sentences, not numbers:
 *   "2024 net sales: $58,241,630, up approximately 6.5% …"
 *   "Key personnel … Daniel Okafor (since 2014) … Total headcount 23 (incl. owner)."
 * Taking "the first number" read the year (2024 / 2014) as revenue or staff.
 */

const YEAR = /^(?:19|20)\d{2}$/;

/**
 * The first money figure in the text: a "$" amount, or a number written with
 * a million/thousand unit. A bare year or a percentage is never money.
 * Returns dollars, or null.
 */
export function firstMoney(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const re = /(\$\s*)?(\d[\d,]*(?:\.\d+)?)\s*(billion|bn|b|million|mm|m|thousand|k)?(?![\w%])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const [, dollar, digits, unitRaw] = m;
    const unit = (unitRaw || "").toLowerCase();
    // Not money: a percentage or a bare number with neither "$" nor a unit.
    if (!dollar && !unit) continue;
    if (!dollar && YEAR.test(digits.replace(/,/g, "")) && !unit) continue;
    let n = parseFloat(digits.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    if (unit === "billion" || unit === "bn" || unit === "b") n *= 1e9;
    else if (unit === "million" || unit === "mm" || unit === "m") n *= 1e6;
    else if (unit === "thousand" || unit === "k") n *= 1e3;
    if (n > 0) return n;
  }
  return null;
}

/**
 * Total headcount from an employees fact. Prefers an explicit total
 * ("22 total", "Total headcount 23", "212 employees", "staff of 14",
 * "14 FTE"); a year ("since 2014") is never a headcount. Falls back to a
 * lone small number only when the text is essentially just that number.
 */
export function parseHeadcount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = raw.replace(/,/g, "");
  const ok = (s: string | undefined) => {
    if (!s) return null;
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 && n < 200000 && !YEAR.test(s) ? n : null;
  };
  // An explicit total wins ("Total headcount 23", "Total peak season: 19
  // employees", "36 employees plus owner (37 total)"); then a figure the fact
  // opens with ("148 (96 drivers + 52 staff)"); then "N employees".
  const patterns = [
    /\b(\d{1,6})\s+(?:total|in\s+total)\b/i,
    /\btotal\b[^.\d]{0,30}?(\d{1,6})\b/i,
    /\b(?:headcount|head\s*count|workforce)\s*(?:of|is|:|=|—|-|–)?\s*(?:about|approx\.?|approximately|~)?\s*(\d{1,6})\b/i,
    /^\s*(?:about|approx\.?|approximately|~)?\s*(\d{1,6})\b(?!\s*(?:%|-?\s*(?:years?|yrs?|year-round|months?|weeks?|days?|hours?|hrs?)\b|[.,]\d))/i,
    /\b(\d{1,6})\s*(?:full[-\s]?time\s+)?(?:employees|staff|people|ftes?|workers|team\s+members|personnel)\b/i,
  ];
  for (const p of patterns) {
    const m = p.exec(t);
    const n = ok(m?.[1]);
    if (n !== null) return n;
  }
  const lone = /^\s*(?:about|approx\.?|approximately|~)?\s*(\d{1,6})\s*\+?\s*$/i.exec(t);
  return ok(lone?.[1]);
}

/** A headcount as a band for pre-NDA text ("10–24 employees"). */
export function headcountBand(n: number): string {
  if (n < 10) return "under 10";
  if (n < 25) return "10–24";
  if (n < 50) return "25–49";
  if (n < 100) return "50–99";
  if (n < 250) return "100–249";
  if (n < 500) return "250–499";
  return "500+";
}
