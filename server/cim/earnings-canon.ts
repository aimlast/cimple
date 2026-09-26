/**
 * earnings-canon — ONE adjusted EBITDA (and SDE) per year across the CIM.
 *
 * Pacific (2026-09-26): the cover, Investment Highlights and Transaction
 * Overview printed a broker/resolved "$3,900,000 adjusted EBITDA" (with a
 * 12.6% margin and a 4.6× multiple), while the bridge, the earnings chart and
 * Reason for Sale printed the analysis's $3,596,200. The writer was given
 * both — the fact as a "canonical figure", the resolved discrepancy as "final",
 * and the bridge as authoritative for tables — and used each where it fit.
 *
 * The rule, decided here in code: when the deal has a financial analysis
 * with an approved bridge, the bridge's totals ARE the adjusted EBITDA / SDE
 * (and the margins and asking-price multiples computed from them). Any other
 * earnings figure on file — a fact, a resolved discrepancy, a clause inside a
 * narrative fact — is held out of the writer's knowledge base and named in
 * one broker warning, so the CIM can't carry a second number. The figure
 * check (earningsProblems) enforces the same set on every written section.
 *
 * Pure: no database, no AI.
 */
import type { CimFinancials } from "./cim-financials";
import { parseFigures, parseFiguresAt, type Figure } from "./figure-check";

export interface EarningsCanon {
  /** The metric the analysis bridges to. */
  headline: "ebitda" | "sde";
  latestYear: string;
  adjustedEbitda: Record<string, number>;
  sde: Record<string, number>;
  /** Statement EBITDA (before other income), after any restatement. */
  reportedEbitda: Record<string, number>;
  revenue: Record<string, number>;
  margins: Array<{ kind: "adjusted" | "sde" | "reported"; year: string; pct: number }>;
  multiples: Array<{ kind: "adjusted" | "sde"; year: string; value: number }>;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** The canon, or null when the deal has no usable bridge (the facts' figures then stand, as before). */
export function earningsCanon(fin: CimFinancials | null | undefined, askingPrice?: string | null): EarningsCanon | null {
  const b = fin?.bridge;
  if (!b || b.addbacks.length === 0 || Object.keys(b.adjusted).length === 0) return null;
  const adjustedEbitda = b.metric === "ebitda" ? { ...b.adjusted } : { ...(b.adjustedEbitda ?? {}) };
  const sde = b.metric === "sde" ? { ...b.adjusted } : { ...(b.sde ?? {}) };
  const reportedEbitda: Record<string, number> = {};
  const revenue: Record<string, number> = {};
  for (const [y, p] of Object.entries(fin!.pnl ?? {})) {
    reportedEbitda[y] = p.ebitda;
    revenue[y] = p.revenue;
  }
  const margins: EarningsCanon["margins"] = [];
  const push = (kind: "adjusted" | "sde" | "reported", values: Record<string, number>) => {
    for (const [y, v] of Object.entries(values)) if (revenue[y]) margins.push({ kind, year: y, pct: (v / revenue[y]) * 100 });
  };
  push("adjusted", adjustedEbitda);
  push("sde", sde);
  push("reported", reportedEbitda);
  const latestYear = Object.keys(b.adjusted).sort().pop()!;
  const multiples: EarningsCanon["multiples"] = [];
  const price = parseFigures(askingPrice ?? "").find((f) => f.kind === "money" && f.value > 0)?.value;
  if (price) {
    if (adjustedEbitda[latestYear] > 0) multiples.push({ kind: "adjusted", year: latestYear, value: price / adjustedEbitda[latestYear] });
    if (sde[latestYear] > 0) multiples.push({ kind: "sde", year: latestYear, value: price / sde[latestYear] });
  }
  return { headline: b.metric, latestYear, adjustedEbitda, sde, reportedEbitda, revenue, margins, multiples };
}

/** The CANONICAL FIGURES lines for earnings (replacing the facts' own). */
export function canonLines(c: EarningsCanon): string[] {
  const out: string[] = [];
  const y = c.latestYear;
  const earlier = (values: Record<string, number>) => {
    const ys = Object.keys(values).filter((x) => x !== y).sort();
    return ys.length ? `; earlier years: ${ys.map((x) => `${x} ${money(values[x])}`).join(" · ")}` : "";
  };
  const margin = (kind: string) => c.margins.find((m) => m.kind === kind && m.year === y);
  if (typeof c.adjustedEbitda[y] === "number") {
    out.push(`Adjusted EBITDA: ${money(c.adjustedEbitda[y])} (FY${y} — the financial analysis bridge${earlier(c.adjustedEbitda)}). This is the ONLY adjusted EBITDA the CIM may show.`);
    const m = margin("adjusted");
    if (m) out.push(`Adjusted EBITDA margin: ${m.pct.toFixed(1)}% (FY${y})`);
  }
  if (typeof c.sde[y] === "number") {
    out.push(`SDE: ${money(c.sde[y])} (FY${y} — the financial analysis bridge${earlier(c.sde)})  (this is SDE — label it SDE, not EBITDA)`);
    const m = margin("sde");
    if (m) out.push(`SDE margin: ${m.pct.toFixed(1)}% (FY${y})`);
  }
  for (const m of c.multiples) {
    out.push(`Asking price multiple: ${m.value.toFixed(1)}× FY${m.year} ${m.kind === "sde" ? "SDE" : "Adjusted EBITDA"}`);
  }
  return out;
}

// ── Reading earnings figures in text ──────────────────────────────────────

const EARN_KW = /\b(?:(adj(?:usted|\.)?|normali[sz]ed|reported|as[- ]reported|unadjusted|recast)\s+)?(ebitda|sde|seller'?s discretionary (?:earnings|cash flow))(\s+margins?)?\b/gi;
/** Other measures: a figure governed by one of these is not an earnings figure. */
const OTHER_KW = /\b(?:revenues?|sales|net income|net profit|gross (?:profit|margin)|operating income|income from operations|salar(?:y|ies)|wages?|payroll|rent|price|costs?|expenses?|capex|debt|cash|receivables?|payables?|working capital|asking|deposits?|valuation|loans?|interest|taxe?s?|dividends?|compensation|fees?|add-?backs?|adjustments?|depreciation|amortization|growth|grew|increased?|rose|declined?|fell|up|down|contracts?|customers?|employees|staff|drivers|trucks?|units|square feet|sq ?ft|pallets?)\b/gi;
const MULTIPLE_RE = /(\d+(?:\.\d+)?)\s?(?:×|x\b|times\b)/gi;
const YEAR_RE = /\b(?:FY\s?'?)?((?:19|20)\d{2})\b/g;
/** Where a clause ends — not at an abbreviation's dot ("adj. EBITDA", "approx. $4M"). */
const CLAUSE_START = /(?<!\b(?:adj|approx|incl|excl|vs|no|est|avg|inc|ltd|co|corp|st|mr|mrs|ms|dr|e\.g|i\.e))[.;!?\n](?:\s|$)/gi;

export type EarningsKind = "ebitda" | "sde" | "margin" | "multiple";

export interface EarningsMention {
  kind: EarningsKind;
  /** ebitda / margin: which basis the wording names. */
  basis: "adjusted" | "reported" | "any" | "sde";
  value: number;
  tolerance: number;
  text: string;
  year: string | null;
}

interface Kw { at: number; end: number; earn: null | { basis: EarningsMention["basis"]; margin: boolean } }

function keywords(text: string): Kw[] {
  const out: Kw[] = [];
  for (const m of Array.from(text.matchAll(EARN_KW))) {
    const q = (m[1] || "").toLowerCase();
    const sde = /sde|discretionary/i.test(m[2]);
    const basis = sde ? "sde" : /adj|normali|recast/.test(q) ? "adjusted" : /report|unadjusted/.test(q) ? "reported" : "any";
    out.push({ at: m.index!, end: m.index! + m[0].length, earn: { basis, margin: !!m[3] } });
  }
  for (const m of Array.from(text.matchAll(OTHER_KW))) {
    // "EBITDA margin" / "adjusted EBITDA growth": the earnings keyword already covers it.
    if (out.some((k) => k.earn && m.index! >= k.at && m.index! < k.end)) continue;
    out.push({ at: m.index!, end: m.index! + m[0].length, earn: null });
  }
  return out.sort((a, b) => a.at - b.at);
}

function clauseStart(text: string, at: number): number {
  let start = 0;
  for (const m of Array.from(text.slice(0, at).matchAll(CLAUSE_START))) start = m.index! + 1;
  return start;
}

/** The year a figure speaks for: "(FY2024)", "in 2024" right after it, else "FY2024 …" right before it. */
function yearNear(text: string, index: number, end: number): string | null {
  const after = text.slice(end, end + 22);
  const a = /^\s*(?:\(|,|in|for|during|of)?\s*(?:FY\s?'?)?((?:19|20)\d{2})\b/i.exec(after);
  if (a) return a[1];
  const before = text.slice(Math.max(0, index - 40), index);
  const ys = Array.from(before.matchAll(YEAR_RE));
  if (ys.length > 0) {
    const last = ys[ys.length - 1];
    // Only when nothing but the metric's words sit between the year and the figure.
    const between = before.slice(last.index! + last[0].length);
    if (!/\d/.test(between) && between.length < 30) return last[1];
  }
  return null;
}

/**
 * Earnings figures in a text, each labelled by the measure that governs it:
 * the metric named right after it ("$3.6M adjusted EBITDA", "12.6% adj.
 * EBITDA", "5.0× FY2024 adjusted EBITDA") or, failing that, the nearest
 * measure named before it in the same clause ("adjusted EBITDA has
 * strengthened from $3.04 million in 2023 to $3.60 million in 2024";
 * "revenue has grown 8.3%" is a revenue figure, not a margin).
 */
export function earningsMentions(text: string): EarningsMention[] {
  if (!text || !/ebitda|sde|discretionary/i.test(text)) return [];
  const kws = keywords(text);
  const figs: Array<{ f: Figure; index: number; end: number; multiple: boolean }> = [];
  for (const f of parseFiguresAt(text)) figs.push({ f, index: f.index, end: f.end, multiple: false });
  for (const m of Array.from(text.matchAll(MULTIPLE_RE))) {
    const n = m[1];
    const decimals = n.includes(".") ? n.split(".")[1].length : 0;
    // Replace the plain number parseFiguresAt found at the same place.
    const i = figs.findIndex((x) => x.index === m.index);
    const f: Figure = { value: Number(n), tolerance: Math.pow(10, -decimals) / 2, kind: "plain", text: m[0] };
    if (i >= 0) figs[i] = { f, index: m.index!, end: m.index! + m[0].length, multiple: true };
    else figs.push({ f, index: m.index!, end: m.index! + m[0].length, multiple: true });
  }
  const out: EarningsMention[] = [];
  for (const { f, index, end, multiple } of figs) {
    if (!multiple && f.kind === "plain") continue; // counts, years
    if (f.kind === "money" && Math.abs(f.value) < 1000) continue;
    // 1. The measure named right after the figure.
    const next = kws.find((k) => k.at >= end);
    const gap = next ? text.slice(end, next.at) : "";
    let gov: Kw | null = null;
    const adjacent = !!next && gap.length <= 24 && !/[\d.;:]/.test(gap.replace(/(?:FY\s?'?)?(?:19|20)\d{2}/g, "")) && /^[\s(]*(?:of\s+|in\s+|FY\s?'?\d{2,4}\s+|(?:19|20)\d{2}\s+)*$/i.test(gap);
    // "a $140,000 (replacement) salary" belongs to the salary, whatever was named before it.
    if (next && !next.earn && /^\s*(?:[A-Za-z-]+\s+){0,2}$/.test(gap)) continue;
    if (adjacent && next!.earn) gov = next!;
    // 2. Else the nearest measure before it in the same clause.
    if (!gov) {
      const from = clauseStart(text, index);
      const before = kws.filter((k) => k.end <= index && k.at >= from);
      gov = before.length ? before[before.length - 1] : null;
    }
    if (!gov?.earn) continue;
    const year = yearNear(text, index, end);
    if (multiple) {
      out.push({ kind: "multiple", basis: gov.earn.basis, value: f.value, tolerance: f.tolerance, text: f.text, year });
    } else if (f.kind === "percent") {
      // A percentage is an earnings margin only when the wording says margin
      // (or the figure is directly "x% EBITDA"); growth rates are elsewhere.
      if (!gov.earn.margin && gov !== next) continue;
      out.push({ kind: "margin", basis: gov.earn.basis, value: f.value, tolerance: f.tolerance, text: f.text, year });
    } else {
      out.push({ kind: gov.earn.basis === "sde" ? "sde" : "ebitda", basis: gov.earn.basis, value: f.value, tolerance: f.tolerance, text: f.text, year });
    }
  }
  return out;
}

const within = (v: number, tol: number, k: number) => Math.abs(Math.abs(v) - Math.abs(k)) <= tol + 1e-6 * Math.max(1, Math.abs(k));

/** The canonical values a mention may take (for its year, when it names one). */
function allowed(m: EarningsMention, c: EarningsCanon): Array<{ year: string; value: number; what: string }> {
  const pick = (values: Record<string, number>, what: string) =>
    Object.entries(values)
      .filter(([y]) => !m.year || y === m.year)
      .map(([year, value]) => ({ year, value, what }));
  if (m.kind === "sde") return pick(c.sde, "SDE");
  if (m.kind === "ebitda") {
    if (m.basis === "adjusted") return pick(c.adjustedEbitda, "Adjusted EBITDA");
    if (m.basis === "reported") return pick(c.reportedEbitda, "EBITDA (as reported)");
    return [...pick(c.adjustedEbitda, "Adjusted EBITDA"), ...pick(c.reportedEbitda, "EBITDA (as reported)")];
  }
  if (m.kind === "margin") {
    const kinds = m.basis === "sde" ? ["sde"] : m.basis === "adjusted" ? ["adjusted"] : m.basis === "reported" ? ["reported"] : ["adjusted", "reported"];
    return c.margins
      .filter((x) => kinds.includes(x.kind) && (!m.year || x.year === m.year))
      .map((x) => ({ year: x.year, value: x.pct, what: `${x.kind === "sde" ? "SDE" : x.kind === "adjusted" ? "adjusted EBITDA" : "reported EBITDA"} margin` }));
  }
  const kinds = m.basis === "sde" ? ["sde"] : ["adjusted", "sde"];
  return c.multiples.filter((x) => kinds.includes(x.kind)).map((x) => ({ year: x.year, value: x.value, what: `multiple of FY${x.year} ${x.kind === "sde" ? "SDE" : "Adjusted EBITDA"}` }));
}

function fmtCanon(k: { year: string; value: number; what: string }, kind: EarningsKind): string {
  if (kind === "margin") return `${k.value.toFixed(1)}% (${k.what}, FY${k.year})`;
  if (kind === "multiple") return `${k.value.toFixed(1)}× (${k.what})`;
  return `${money(k.value)} (${k.what}, FY${k.year})`;
}

/**
 * Is there a bridge figure this mention could be held to? An SDE figure on
 * an analysis that computes no SDE (or an adjusted EBITDA on one that bridges
 * straight to SDE) has nothing to disagree with, and stands.
 */
function checkable(m: EarningsMention, c: EarningsCanon): boolean {
  const any = (v: Record<string, number>) => Object.keys(v).length > 0;
  const basis = m.basis;
  if (m.kind === "sde" || basis === "sde") return any(c.sde);
  if (m.kind === "multiple") return c.multiples.length > 0;
  if (basis === "reported") return any(c.reportedEbitda);
  return any(c.adjustedEbitda);
}

/** Mentions in a text that aren't the canon's figures, with what the canon says instead. */
export function offCanon(text: string, c: EarningsCanon): Array<{ mention: EarningsMention; expected: string }> {
  const out: Array<{ mention: EarningsMention; expected: string }> = [];
  for (const m of earningsMentions(text)) {
    if (!checkable(m, c)) continue;
    const ok = allowed(m, c);
    if (ok.some((k) => within(m.value, m.tolerance, k.value))) continue;
    // Name what it should be: that year's figure, else the latest.
    const pool = ok.length > 0 ? ok : allowed({ ...m, year: null }, c);
    const best = pool.find((k) => k.year === (m.year ?? c.latestYear)) ?? pool[pool.length - 1];
    out.push({ mention: m, expected: best ? fmtCanon(best, m.kind) : m.year ? `no FY${m.year} figure in the financial analysis` : "the financial analysis figure" });
  }
  return out;
}

// ── The writer's knowledge base ──────────────────────────────────────────

/** An earnings fact key (camelCase: "ebitda", "adjustedSde", "sdeByYear" — not "businessDescription"). */
const EARN_KEY = /[Ee]bitda|EBITDA|(?:^|:)sde|Sde|SDE|[Dd]iscretionary|[Nn]ormali[sz]ed(?:Earnings|CashFlow)|[Aa]djustedEarnings/;

/** Sentences and "; " clauses (an abbreviation's dot — "adj. EBITDA" — doesn't end one). */
function clausesOf(text: string): string[] {
  return text
    .split(/(?<!\b(?:[Aa]dj|[Aa]pprox|[Ii]ncl|[Ee]xcl|vs|[Nn]o|[Ee]st|[Aa]vg|[Ii]nc|[Ll]td|[Cc]o|[Cc]orp|[Ss]t|Mrs?|Ms|Dr)\.)(?<=[.!?])\s+(?=[A-Z0-9(])|\s*;\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface EarningsHold {
  /** Where the figure was: a fact key or a resolved discrepancy's field. */
  where: string;
  text: string;
}

/**
 * Facts with every off-canon earnings clause removed. `label` is how the key
 * reads ("Adjusted Ebitda"): an earnings key's clauses are read as that
 * measure even when the value is a bare figure ("$3.9M").
 */
export function screenEarningsFacts(
  pairs: Array<[string, unknown]>,
  c: EarningsCanon | null,
  label: (key: string) => string,
): { safe: Array<[string, unknown]>; held: EarningsHold[] } {
  if (!c) return { safe: pairs, held: [] };
  const held: EarningsHold[] = [];
  const safe: Array<[string, unknown]> = [];
  for (const [key, value] of pairs) {
    const earnKey = EARN_KEY.test(key);
    // "adjustedEbitdaByYear" → "adjusted Ebitda By Year", so the measure reads as words.
    const words = label(key).replace(/([a-z])([A-Z])/g, "$1 $2");
    const r = screenValue(value, earnKey ? words : "", c, (text) => held.push({ where: label(key), text }));
    if (!r.dropped) safe.push([key, r.value]);
  }
  return { safe, held };
}

function screenValue(value: unknown, prefix: string, c: EarningsCanon, hold: (text: string) => void): { value: unknown; dropped: boolean } {
  if (typeof value === "string") {
    const parts = clausesOf(value);
    const kept = parts.filter((p) => {
      const read = prefix && !/ebitda|sde|discretionary/i.test(p) ? `${prefix}: ${p}` : p;
      const bad = offCanon(read, c);
      if (bad.length === 0) return true;
      hold(p);
      return false;
    });
    if (kept.length === parts.length) return { value, dropped: false };
    return kept.length === 0 ? { value: null, dropped: true } : { value: kept.join("; "), dropped: false };
  }
  if (Array.isArray(value)) {
    const out = value.map((v) => screenValue(v, prefix, c, hold)).filter((r) => !r.dropped).map((r) => r.value);
    return { value: out, dropped: out.length === 0 && value.length > 0 };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A by-year map entry: "2024: $3.90M" read with the key's measure and year.
      const r = screenValue(typeof v === "string" && /^(?:19|20)\d{2}$/.test(k) ? `${v} (${k})` : v, prefix, c, (t) => hold(/^(?:19|20)\d{2}$/.test(k) ? `${k}: ${v}` : t));
      if (!r.dropped) out[k] = typeof v === "string" && r.value === `${v} (${k})` ? v : r.value;
    }
    return { value: out, dropped: Object.keys(out).length === 0 };
  }
  return { value, dropped: false };
}

/** The broker's warning: which figure the CIM uses and what on file was left out. */
export function earningsWarning(c: EarningsCanon, held: EarningsHold[]): string | null {
  if (held.length === 0) return null;
  const y = c.latestYear;
  const uses = [
    typeof c.adjustedEbitda[y] === "number" ? `Adjusted EBITDA ${money(c.adjustedEbitda[y])}` : "",
    typeof c.sde[y] === "number" ? `SDE ${money(c.sde[y])}` : "",
  ].filter(Boolean).join(" and ");
  const items = held.slice(0, 5).map((h) => `"${h.text.length > 90 ? `${h.text.slice(0, 87)}…` : h.text}" (${h.where})`);
  const more = held.length > 5 ? `, and ${held.length - 5} more` : "";
  return `Earnings figures: the CIM uses ${uses} for FY${y} from the financial analysis bridge, everywhere. These differ and were left out of the CIM: ${items.join("; ")}${more}. If a figure on file is the right one, change the add-backs on the Financials tab and regenerate.`;
}
