/**
 * Deal size words for anything a buyer reads before the NDA — the teaser and
 * the outreach drafts. ONE ladder, so a buyer never sees two different
 * ranges for the same deal (server/buyers/blind-deal-summary.ts uses it too).
 *
 * Money is either a range ("$1M–$2M") or a rounded figure ("$1.3M"); the
 * teaser's `numbers` setting picks which. Headcount and years are always
 * ranges, whatever the setting: an exact headcount or founding year
 * pinpoints a business. Pure; no I/O.
 */

export type NumberStyle = "ranges" | "rounded";
export const NUMBER_STYLES: readonly NumberStyle[] = ["ranges", "rounded"];

const K = 1_000;
const M = 1_000_000;

/** "$1,300,000" / "$1.3M" / "1.3 million" / "$480K" / 1300000 → 1300000. Null when unreadable or not positive. */
export function parseMoney(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const t = raw.replace(/,/g, "").trim();
  const m = /(?:^|[^\w.])\$?\s*(\d+(?:\.\d+)?)\s*(k|thousand|m|mm|mil|million|b|bn|billion)?\b/i.exec(` ${t}`);
  if (!m) return null;
  let n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "k" || unit === "thousand") n *= K;
  else if (unit === "m" || unit === "mm" || unit === "mil" || unit === "million") n *= M;
  else if (unit === "b" || unit === "bn" || unit === "billion") n *= 1_000 * M;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function money(n: number): string {
  if (n >= M) {
    const v = n / M;
    const s = Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, "");
    return `$${s}M`;
  }
  return `$${Math.round(n / K)}K`;
}

/**
 * The range ladder:
 *   under $250K · $250K–$500K · $500K–$750K · $750K–$1M;
 *   $1M steps to $10M; $2.5M steps to $25M; $5M steps to $50M;
 *   $10M steps to $100M; $100M+.
 * Lower bound inclusive ($1M exactly is "$1M–$2M").
 */
export function moneyRange(n: number): string {
  if (!(n > 0)) return "";
  if (n < 250 * K) return "under $250K";
  const ladder: Array<[number, number]> = [[1 * M, 250 * K], [10 * M, 1 * M], [25 * M, 2.5 * M], [50 * M, 5 * M], [100 * M, 10 * M]];
  let floor = 0;
  for (const [top, step] of ladder) {
    if (n < top) {
      const lo = floor + Math.floor((n - floor) / step) * step;
      return `${money(lo)}–${money(lo + step)}`;
    }
    floor = top;
  }
  return "$100M+";
}

/** Rounded: under $1M to the nearest $10K ("$480K"); from $1M one decimal ("$4.8M"); from $100M the nearest $1M ("$142M"). */
export function moneyRounded(n: number): string {
  if (!(n > 0)) return "";
  if (n >= 100 * M) return `$${Math.round(n / M)}M`;
  if (n >= M) {
    const v = Math.round(n / (M / 10)) / 10;
    return `$${v.toFixed(1).replace(/\.0$/, "")}M`;
  }
  const v = Math.round(n / (10 * K)) * 10 * K;
  return v >= M ? "$1M" : `$${Math.round(v / K)}K`;
}

export function moneyIn(style: NumberStyle, n: number): string {
  return style === "rounded" ? moneyRounded(n) : moneyRange(n);
}

/** Years in business as a range: 5+ / 10+ / 20+ / 30+ / 50+ years. Null under 5 or unknown. */
export function yearsRange(years: number | null | undefined): string | null {
  if (typeof years !== "number" || !Number.isFinite(years)) return null;
  for (const t of [50, 30, 20, 10, 5]) if (years >= t) return `${t}+ years`;
  return null;
}

/** A margin (%) as a range: under 10% · 10–15% · 15–20% · 20–30% · 30%+. */
export function marginRange(pct: number | null | undefined): string | null {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  if (pct < 10) return "under 10%";
  if (pct < 15) return "10–15%";
  if (pct < 20) return "15–20%";
  if (pct < 30) return "20–30%";
  return "30%+";
}

/** The largest customer's share (%), as a range — only from a printed percentage. */
export function customerRange(pct: number | null | undefined): string | null {
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  if (pct <= 10) return "No customer above 10%";
  if (pct <= 20) return "Largest customer 10–20%";
  if (pct <= 30) return "Largest customer 20–30%";
  if (pct <= 50) return "Largest customer 30–50%";
  return "Largest customer over 50%";
}

/** The largest customer's share as a value under the label "Largest customer" ("20–30% of revenue"). */
export function customerShare(pct: number | null | undefined): string | null {
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  if (pct <= 10) return "under 10% of revenue";
  if (pct <= 20) return "10–20% of revenue";
  if (pct <= 30) return "20–30% of revenue";
  if (pct <= 50) return "30–50% of revenue";
  return "over 50% of revenue";
}

/** A recurring share (%) as a range ("40–60% recurring"). */
export function recurringRange(pct: number | null | undefined): string | null {
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
  if (pct < 20) return "under 20% recurring";
  if (pct < 40) return "20–40% recurring";
  if (pct < 60) return "40–60% recurring";
  if (pct < 80) return "60–80% recurring";
  return "80%+ recurring";
}

const sortedYears = (byYear: Record<string, number>) =>
  Object.entries(byYear)
    .filter(([y, v]) => /^\d{4}$/.test(y) && typeof v === "number" && Number.isFinite(v) && v > 0)
    .sort(([a], [b]) => Number(a) - Number(b));

/** Revenue trend in words, from ≥ 2 printed full years: "Up 3 years running" / "Up last year" / "Steady" / "Down last year". */
export function revenueTrendWords(byYear: Record<string, number>): string | null {
  const ys = sortedYears(byYear);
  if (ys.length < 2) return null;
  const change = (i: number) => (ys[i][1] - ys[i - 1][1]) / ys[i - 1][1];
  const last = change(ys.length - 1);
  if (last < -0.03) return "Down last year";
  if (last <= 0.03) return "Steady";
  let run = 0;
  for (let i = ys.length - 1; i >= 1 && change(i) > 0.03; i--) run++;
  return run >= 2 ? `Up ${run} years running` : "Up last year";
}

/** Revenue indexed to 100 (the first printed full year), from ≥ 3 years. Shape, never size. */
export function indexedTrend(byYear: Record<string, number>): Array<{ year: string; index: number }> | null {
  const ys = sortedYears(byYear);
  if (ys.length < 3) return null;
  const base = ys[0][1];
  return ys.map(([year, v]) => ({ year, index: Math.round((v / base) * 100) }));
}

/** Two figures read the same in this number style (the teaser's discrepancy rule). Unreadable → false. */
export function sameDisplayed(a: unknown, b: unknown, style: NumberStyle): boolean {
  const x = parseMoney(a);
  const y = parseMoney(b);
  if (x === null || y === null) return false;
  return moneyIn(style, x) === moneyIn(style, y);
}

/** A headcount as a range ("10–24 employees"). Mirrors server/matching/fact-numbers.ts headcountBand. */
export function headcountRange(n: number | null | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  if (n < 10) return "under 10";
  if (n < 25) return "10–24";
  if (n < 50) return "25–49";
  if (n < 100) return "50–99";
  if (n < 250) return "100–249";
  if (n < 500) return "250–499";
  return "500+";
}
