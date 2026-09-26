/**
 * earnings-canon — ONE adjusted EBITDA (and SDE) per year across the CIM,
 * and the RIGHT one.
 *
 * Pacific (2026-09-26): the cover, Investment Highlights and Transaction
 * Overview printed the broker's resolved "$3,900,000 adjusted EBITDA" (with a
 * 12.6% margin and a 4.6× multiple), while the bridge, the earnings chart and
 * Reason for Sale printed the financial analysis's $3,596,200. The writer was
 * given both and used each where it fit.
 *
 * A first fix made the analysis bridge win everywhere. That was the wrong
 * authority: on all three demo deals with an analysis the bridge was the
 * figure in error (Pacific's classes the owner-pay normalisation as SDE-only;
 * Beacon's classes $105,300 of EBITDA add-backs as SDE-only; Lakeshore's
 * misses add-backs), and the CIM would have led with understated earnings
 * the broker had already corrected.
 *
 * The rule, decided here in code, per metric (adjusted EBITDA, SDE) and year:
 *  1. the broker's decision — a resolved discrepancy about that metric;
 *  2. the broker's own fact for that metric (source "broker": "ebitda",
 *     "sde2024", "adjustedEbitda" …);
 *  3. the financial analysis bridge.
 * Latest wins: a broker figure (1 or 2) set before the bridge's add-backs
 * last moved THAT figure — the same metric and year
 * (CimFinancials.bridgeChangedAt) — was decided against a bridge figure that
 * no longer exists, so it doesn't overrule the newer one — the broker is
 * told, and can enter it again.
 * Where the broker's figure and the bridge disagree, the broker's figure is
 * used and the part of the bridge it contradicts is left out of the CIM (a
 * waterfall that doesn't end at the CIM's figure can't be shown): the whole
 * bridge when its own total is contradicted, else just the adjusted-EBITDA
 * subtotal or the SDE section. The broker is told exactly which, and how to
 * bring the bridge back. Once the whole bridge is withheld, a metric no
 * broker figure confirms is "unconfirmed" and never stated.
 *
 * Every other earnings figure on file — a seller's claim, a document's
 * figure, a clause inside a narrative fact, a sentence in an earlier draft —
 * that isn't the canon is held out of the writer's knowledge base and named
 * in one broker warning; the figure check (offCanon) holds every written
 * section to the same set.
 *
 * Pure: no database, no AI.
 */
import type { CimFinancials } from "./cim-financials";
import type { ResolvedDiscrepancyNote } from "./resolved-block";
import { parseFigures, parseFiguresAt, type Figure } from "./figure-check";
import { getFieldSources } from "../interview/info-merger";

type Metric = "adjusted" | "sde";

/** An adjusted EBITDA / SDE figure the broker stated or decided. */
export interface BrokerFigure {
  metric: Metric;
  year: string;
  value: number;
  tolerance: number;
  /** As written ("$3,900,000", "$3.9M"). */
  text: string;
  /** Where it was: 'resolved discrepancy "2024 Adjusted EBITDA"' / '"Ebitda" (your fact)'. */
  from: string;
  /** 1 = a resolved discrepancy (the broker's decision), 2 = the broker's own fact. */
  rank: 1 | 2;
  /** When the broker resolved / wrote it (ISO), when known. */
  at?: string | null;
}

export interface EarningsOverride {
  /** What of the analysis bridge the CIM leaves out: all of it, or the subtotal / SDE section the broker's figure contradicts. */
  withheld: "bridge" | "adjustedSubtotal" | "sdeSection";
  items: Array<{ metric: Metric; year: string; broker: BrokerFigure; bridge: number }>;
}

export interface EarningsCanon {
  /** The metric the CIM leads with. */
  headline: "ebitda" | "sde";
  latestYear: string;
  adjustedEbitda: Record<string, number>;
  sde: Record<string, number>;
  /** Statement EBITDA (before other income), after any restatement. */
  reportedEbitda: Record<string, number>;
  revenue: Record<string, number>;
  margins: Array<{ kind: "adjusted" | "sde" | "reported"; year: string; pct: number }>;
  multiples: Array<{ kind: "adjusted" | "sde"; year: string; value: number }>;
  /** Where each year's figure came from: "bridge", or the broker source. */
  source: { adjusted: Record<string, string>; sde: Record<string, string> };
  /** The broker's figure overruled (part of) the analysis bridge. */
  override: EarningsOverride | null;
  /** With the bridge withheld, the metrics no broker figure confirms: never stated in the CIM. */
  unconfirmed: Metric[];
  /** Broker figures for one metric and year that disagree with each other (neither is used). */
  brokerConflicts: Array<{ metric: Metric; year: string; figures: BrokerFigure[] }>;
  /**
   * Broker figures set before the bridge's add-backs last changed and now
   * disagreeing with it: the later add-back change wins (not used).
   */
  staleBrokerFigures?: Array<{ figure: BrokerFigure; bridge: number }>;
  /** The analysis as the CIM uses it: the overruled part of the bridge left out (null = no analysis). */
  financials: CimFinancials | null;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const within = (v: number, tol: number, k: number) => Math.abs(Math.abs(v) - Math.abs(k)) <= tol + 1e-6 * Math.max(1, Math.abs(k));
const metricLabel = (m: Metric) => (m === "sde" ? "SDE" : "Adjusted EBITDA");

export interface EarningsCanonOptions {
  /** The deal's facts (with _fieldSources): the broker's own earnings facts. */
  extractedInfo?: Record<string, unknown> | null;
  /** The broker's resolved discrepancies. */
  resolved?: ResolvedDiscrepancyNote[] | null;
}

/**
 * The canon, or null when the deal has neither an analysis bridge nor a
 * broker earnings figure (the facts' figures then stand, as before).
 */
export function earningsCanon(
  fin: CimFinancials | null | undefined,
  askingPrice?: string | null,
  opts: EarningsCanonOptions = {},
): EarningsCanon | null {
  const b = fin?.bridge && fin.bridge.addbacks.length > 0 && Object.keys(fin.bridge.adjusted).length > 0 ? fin.bridge : null;
  const reportedEbitda: Record<string, number> = {};
  const revenue: Record<string, number> = {};
  for (const [y, p] of Object.entries(fin?.pnl ?? {})) {
    reportedEbitda[y] = p.ebitda;
    revenue[y] = p.revenue;
  }
  const statementYears = Object.keys(reportedEbitda).sort();
  const fallbackYear = (b ? Object.keys(b.adjusted).sort().pop() : undefined) ?? statementYears[statementYears.length - 1] ?? null;
  const bridgeSeries: Record<Metric, Record<string, number>> = {
    adjusted: b ? (b.metric === "ebitda" ? b.adjusted : b.adjustedEbitda ?? {}) : {},
    sde: b ? (b.metric === "sde" ? b.adjusted : b.sde ?? {}) : {},
  };
  // Latest wins: a broker figure set before the add-backs last moved the
  // bridge was decided against a bridge that no longer exists (the broker
  // accepted the analysis's $674,752, then approved another add-back). It
  // never overrules the newer bridge; it is named in a warning instead.
  // Per figure: only a change to THIS metric and year dates the decision out
  // (a 2023 add-back, or the SDE-only owner salary, leaves the broker's 2024
  // adjusted EBITDA standing).
  const changedAtOf = (f: BrokerFigure): number => {
    const iso = b ? fin?.bridgeChangedAt?.[`${f.metric}|${f.year}`] : undefined;
    return iso ? Date.parse(iso) : NaN;
  };
  const staleBrokerFigures: NonNullable<EarningsCanon["staleBrokerFigures"]> = [];
  const isStale = (f: BrokerFigure): boolean => {
    const bv = bridgeSeries[f.metric][f.year];
    const at = f.at ? Date.parse(f.at) : NaN;
    const changedAt = changedAtOf(f);
    if (typeof bv !== "number" || Number.isNaN(changedAt) || Number.isNaN(at) || at >= changedAt) return false;
    if (within(f.value, Math.max(f.tolerance, Math.abs(bv) * 0.005), bv)) return false;
    staleBrokerFigures.push({ figure: f, bridge: bv });
    return true;
  };
  const { figures, conflicts } = brokerEarnings(opts, fallbackYear, isStale);
  if (!b && figures.length === 0) return null;

  const headlineMetric: Metric | null = b ? (b.metric === "ebitda" ? "adjusted" : "sde") : null;
  const items: EarningsOverride["items"] = [];
  for (const f of figures) {
    const bv = bridgeSeries[f.metric][f.year];
    if (typeof bv === "number" && !within(f.value, Math.max(f.tolerance, Math.abs(bv) * 0.005), bv)) items.push({ metric: f.metric, year: f.year, broker: f, bridge: bv });
  }
  let withheld: EarningsOverride["withheld"] | null = null;
  if (items.some((i) => i.metric === headlineMetric)) withheld = "bridge";
  else if (items.length > 0) withheld = headlineMetric === "adjusted" ? "sdeSection" : "adjustedSubtotal";

  const canonOf = (metric: Metric) => {
    const values: Record<string, number> = {};
    const source: Record<string, string> = {};
    const useBridge = withheld !== "bridge" && !(withheld && metric !== headlineMetric);
    if (useBridge) {
      for (const [y, v] of Object.entries(bridgeSeries[metric])) {
        values[y] = v;
        source[y] = "bridge";
      }
    }
    // The broker's figure fills a year the bridge doesn't give, and replaces one it overrules.
    for (const f of figures.filter((x) => x.metric === metric)) {
      if (f.year in values) continue;
      values[f.year] = f.value;
      source[f.year] = f.from;
    }
    return { values, source };
  };
  const adj = canonOf("adjusted");
  const sdeC = canonOf("sde");
  const adjustedEbitda = adj.values;
  const sde = sdeC.values;
  const unconfirmed: Metric[] = withheld === "bridge" ? (["adjusted", "sde"] as Metric[]).filter((m) => Object.keys(m === "adjusted" ? adjustedEbitda : sde).length === 0) : [];

  const margins: EarningsCanon["margins"] = [];
  const push = (kind: "adjusted" | "sde" | "reported", values: Record<string, number>) => {
    for (const [y, v] of Object.entries(values)) if (revenue[y]) margins.push({ kind, year: y, pct: (v / revenue[y]) * 100 });
  };
  push("adjusted", adjustedEbitda);
  push("sde", sde);
  push("reported", reportedEbitda);
  const latestYear = [...Object.keys(adjustedEbitda), ...Object.keys(sde)].sort().pop() ?? fallbackYear ?? "";
  const multiples: EarningsCanon["multiples"] = [];
  const price = parseFigures(askingPrice ?? "").find((f) => f.kind === "money" && f.value > 0)?.value;
  if (price) {
    if (adjustedEbitda[latestYear] > 0) multiples.push({ kind: "adjusted", year: latestYear, value: price / adjustedEbitda[latestYear] });
    if (sde[latestYear] > 0) multiples.push({ kind: "sde", year: latestYear, value: price / sde[latestYear] });
  }
  const headline: EarningsCanon["headline"] = b ? b.metric : Object.keys(adjustedEbitda).length > 0 ? "ebitda" : "sde";
  const override = withheld ? { withheld, items } : null;
  return {
    headline,
    latestYear,
    adjustedEbitda,
    sde,
    reportedEbitda,
    revenue,
    margins,
    multiples,
    source: { adjusted: adj.source, sde: sdeC.source },
    override,
    unconfirmed,
    brokerConflicts: conflicts,
    ...(staleBrokerFigures.length > 0 ? { staleBrokerFigures } : {}),
    financials: fin ? withBridgeOverride(fin, override) : null,
  };
}

/** The analysis with the overruled part of its bridge left out, and a note saying why. */
function withBridgeOverride(fin: CimFinancials, o: EarningsOverride | null): CimFinancials {
  if (!o || !fin.bridge) return fin;
  const it = o.items[0];
  const said = (m: Metric) => {
    const x = o.items.find((i) => i.metric === m) ?? it;
    // The overruled total itself is never given to the writer (it would be a figure "on file").
    return `the broker's ${metricLabel(x.metric)} for FY${x.year} is ${x.broker.text}, which the financial analysis add-backs don't reach`;
  };
  if (o.withheld === "bridge") {
    return {
      ...fin,
      bridge: null,
      bridgeWithheld: `No EBITDA/SDE bridge is available: ${said(it.metric)}. Draw no bridge or waterfall and list no add-back amounts; state adjusted EBITDA / SDE only as CANONICAL FIGURES give them.`,
    };
  }
  if (o.withheld === "adjustedSubtotal") {
    return {
      ...fin,
      bridge: { ...fin.bridge, adjustedEbitda: null, ebitdaLineCount: undefined },
      bridgeWithheld: `This bridge ends at SDE and has no adjusted EBITDA subtotal: ${said("adjusted")}. Never show an adjusted EBITDA inside this bridge; take it from CANONICAL FIGURES.`,
    };
  }
  return {
    ...fin,
    bridge: { ...fin.bridge, sdeOnly: [], sde: null },
    bridgeWithheld: `This bridge ends at adjusted EBITDA and has no SDE step: ${said("sde")}. Take SDE from CANONICAL FIGURES.`,
  };
}

// ── The broker's own earnings figures ─────────────────────────────────────

/** A fact key for one metric: "ebitda", "adjustedEbitda", "ebitda2024" / "sde", "sde2024", "adjustedSdeByYear". */
function metricOfKey(key: string): Metric | null {
  const bare = key.toLowerCase().replace(/[^a-z]/g, "");
  if (/^(?:adjusted|normali[sz]ed|recast)?ebitda(?:fy)?(?:byyear)?$/.test(bare)) return "adjusted";
  if (/^(?:adjusted|normali[sz]ed|recast)?(?:sde|sellersdiscretionaryearnings|sellerdiscretionaryearnings|sellersdiscretionarycashflow)(?:fy)?(?:byyear)?$/.test(bare)) return "sde";
  return null;
}

/** What a resolved discrepancy is about: "2024 Adjusted EBITDA" → adjusted; "Owner's claimed SDE vs calculated SDE" → sde. */
function metricOfLabel(text: string): Metric | null {
  if (/\bsde\b|discretionary/i.test(text)) return "sde";
  if (/ebitda/i.test(text) && !/\b(?:as[- ])?reported\b|\bunadjusted\b/i.test(text)) return "adjusted";
  return null;
}

const onlyYear = (text: string): string | null => {
  const ys = Array.from(new Set(Array.from(text.matchAll(/\b(?:FY\s?'?)?((?:19|20)\d{2})\b/g)).map((m) => m[1])));
  return ys.length === 1 ? ys[0] : null;
};

/**
 * Mentions of `metric` in a text. Only an EBITDA the wording calls adjusted
 * (or normalised / recast) is an adjusted EBITDA: a plain "EBITDA $1,199,100"
 * is as often the reported figure (Harborview's "ebitda2024" is), and can't
 * set the CIM's figure.
 */
function mentionsOfMetric(text: string, metric: Metric): EarningsMention[] {
  return earningsMentions(text).filter((m) => (metric === "sde" ? m.kind === "sde" : m.kind === "ebitda" && m.basis === "adjusted"));
}

function brokerEarnings(
  opts: EarningsCanonOptions,
  fallbackYear: string | null,
  /** A figure the bridge has since moved past (it is set aside before ranking). */
  isStale: (f: BrokerFigure) => boolean = () => false,
): { figures: BrokerFigure[]; conflicts: EarningsCanon["brokerConflicts"] } {
  const all: BrokerFigure[] = [];
  for (const n of opts.resolved ?? []) {
    const metric = metricOfLabel(`${n.field} ${n.factKey ?? ""}`);
    if (!metric) continue;
    const text = `${n.year ? `${n.year} ` : ""}${n.field}: ${n.resolvedValue}`;
    for (const m of mentionsOfMetric(text, metric)) {
      const year = m.year ?? n.year ?? onlyYear(text) ?? fallbackYear;
      if (year) all.push({ metric, year, value: m.value, tolerance: m.tolerance, text: m.text, from: `resolved discrepancy "${n.field}"`, rank: 1, at: n.resolvedAt ?? null });
    }
  }
  const info = opts.extractedInfo ?? {};
  const sources = getFieldSources(info as Record<string, unknown>);
  for (const [key, value] of Object.entries(info)) {
    if (key.startsWith("_") || sources[key]?.source !== "broker") continue;
    const metric = metricOfKey(key);
    if (!metric) continue;
    const label = key.replace(/([a-z])([A-Z0-9])/g, "$1 $2");
    const keyYear = (key.match(/(?:19|20)\d{2}/) ?? [])[0] ?? null;
    const whole = valueText(value);
    const src = sources[key];
    for (const { text, year: entryYear } of factTexts(value, label)) {
      // A by-year entry was written on its own (years[y].at); else the fact's write.
      const entry = entryYear ? src.years?.[entryYear] : undefined;
      const at = (entry && typeof entry === "object" ? entry.at : undefined) ?? src.at ?? null;
      for (const m of mentionsOfMetric(text, metric)) {
        const year = m.year ?? entryYear ?? keyYear ?? onlyYear(whole) ?? fallbackYear;
        if (year) all.push({ metric, year, value: m.value, tolerance: m.tolerance, text: m.text, from: `"${formatLabel(key)}" (your fact)`, rank: 2, at });
      }
    }
  }
  // One figure per metric and year: the broker's decision first, then their
  // facts — the most precise statement when they agree, none when they don't.
  const figures: BrokerFigure[] = [];
  const conflicts: EarningsCanon["brokerConflicts"] = [];
  const groups = new Map<string, BrokerFigure[]>();
  for (const f of all) {
    if (isStale(f)) continue;
    groups.set(`${f.metric}|${f.year}`, [...(groups.get(`${f.metric}|${f.year}`) ?? []), f]);
  }
  for (const list of Array.from(groups.values())) {
    const top = list.filter((f) => f.rank === Math.min(...list.map((x) => x.rank)));
    const agree = top.every((a) => top.every((c) => within(a.value, Math.max(a.tolerance, c.tolerance), c.value)));
    if (!agree) {
      conflicts.push({ metric: top[0].metric, year: top[0].year, figures: top });
      continue;
    }
    figures.push(top.reduce((best, f) => (f.tolerance < best.tolerance ? f : best), top[0]));
  }
  return { figures, conflicts };
}

function formatLabel(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim().replace(/^\w/, (c) => c.toUpperCase());
}

function valueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(valueText).join("; ");
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${valueText(x)}`).join("; ");
  return "";
}

/**
 * A fact's clauses, each readable on its own: a clause with no earnings word
 * is read with the key's measure ("Sde: FY2023 $815,620"), and a by-year map
 * entry carries its year.
 */
function factTexts(value: unknown, label: string): Array<{ text: string; year: string | null }> {
  const out: Array<{ text: string; year: string | null }> = [];
  const walk = (v: unknown, year: string | null) => {
    if (typeof v === "number") v = String(v);
    if (typeof v === "string") {
      // Always read with the key's measure: "Sde 2024: $920,052 (FY2024 adjusted EBITDA $780,052 …)"
      // — the leading figure is the key's, the one inside the note is the note's.
      for (const c of clausesOf(v)) out.push({ text: `${label}: ${c}`, year });
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, year));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, /^(?:FY)?(?:19|20)\d{2}$/i.test(k) ? k.replace(/\D/g, "") : year);
  };
  walk(value, null);
  return out;
}

/** The CANONICAL FIGURES lines for earnings (replacing the facts' own). */
export function canonLines(c: EarningsCanon): string[] {
  const out: string[] = [];
  const y = c.latestYear;
  const earlier = (values: Record<string, number>) => {
    const ys = Object.keys(values).filter((x) => x !== y).sort();
    return ys.length ? `; earlier years: ${ys.map((x) => `${x} ${money(values[x])}`).join(" · ")}` : "";
  };
  const origin = (src: string | undefined) => (!src || src === "bridge" ? "the financial analysis bridge" : `the broker's figure — ${src}`);
  const margin = (kind: string) => c.margins.find((m) => m.kind === kind && m.year === y);
  if (typeof c.adjustedEbitda[y] === "number") {
    out.push(`Adjusted EBITDA: ${money(c.adjustedEbitda[y])} (FY${y} — ${origin(c.source.adjusted[y])}${earlier(c.adjustedEbitda)}). This is the ONLY adjusted EBITDA the CIM may show.`);
    const m = margin("adjusted");
    if (m) out.push(`Adjusted EBITDA margin: ${m.pct.toFixed(1)}% (FY${y})`);
  }
  if (typeof c.sde[y] === "number") {
    out.push(`SDE: ${money(c.sde[y])} (FY${y} — ${origin(c.source.sde[y])}${earlier(c.sde)})  (this is SDE — label it SDE, not EBITDA)`);
    const m = margin("sde");
    if (m) out.push(`SDE margin: ${m.pct.toFixed(1)}% (FY${y})`);
  }
  for (const u of c.unconfirmed) {
    out.push(`${metricLabel(u)}: no confirmed figure — the CIM states no ${metricLabel(u)} at all (no figure, margin or multiple).`);
  }
  for (const m of c.multiples) {
    out.push(`Asking price multiple: ${m.value.toFixed(1)}× FY${m.year} ${m.kind === "sde" ? "SDE" : "Adjusted EBITDA"}`);
  }
  return out;
}

// ── Reading earnings figures in text ──────────────────────────────────────

/**
 * "adjusted EBITDA", "EBITDA (as reported)", "EBITDA, as reported", "SDE",
 * "EBITDA margin". Groups: 1 qualifier before, 2 the metric, 3 qualifier
 * after, 4 margin.
 */
const EARN_KW = /\b(?:(adj(?:usted|\.)?|normali[sz]ed|reported|as[- ]reported|unadjusted|recast)\s+)?(ebitda|sde|seller'?s discretionary (?:earnings|cash flow))\b(?:\s*\(\s*((?:as[- ])?reported|unadjusted|adjusted|normali[sz]ed)\s*\)|,\s*(as[- ]reported)\b)?(\s+margins?\b)?/gi;
/** Other measures: a figure governed by one of these is not an earnings figure. */
const OTHER_KW = /\b(?:revenues?|sales|net income|net profit|gross (?:profit|margin)|operating income|income from operations|salar(?:y|ies)|wages?|payroll|rent|price|costs?|expenses?|capex|debt|cash|receivables?|payables?|working capital|asking|deposits?|valuation|loans?|interest|taxe?s?|dividends?|compensation|fees?|add-?backs?|adjustments?|depreciation|amortization|growth|grew|increased?|rose|declined?|fell|up|down|contracts?|customers?|employees|staff|drivers|trucks?|units|square feet|sq ?ft|pallets?)\b/gi;
const MULTIPLE_RE = /(\d+(?:\.\d+)?)\s?(?:×|x\b|times\b)/gi;
const YEAR_RE = /\b(?:FY\s?'?)?((?:19|20)\d{2})\b/g;
/** Where a clause ends — not at an abbreviation's dot ("adj. EBITDA", "approx. $4M"). */
const CLAUSE_START = /(?<!\b(?:adj|approx|incl|excl|vs|no|est|avg|inc|ltd|co|corp|st|mr|mrs|ms|dr|e\.g|i\.e))[.;!?\n](?:\s|$)/gi;
/**
 * Words that may sit between a measure and ITS figure ("adjusted EBITDA was
 * $3.6M", "has strengthened from $3.04 million in 2023 to $3.60 million").
 * Anything else — "adds back", "already deducts the", "bridge" — makes the
 * figure a component, not the measure's value ("Adjusted EBITDA adds back
 * $165,000 of above-market owner salary").
 */
const LINKING = new Set(
  "is was were are be been being has have had of at to from in for the a an and then reached reaches totalled totaled totals total totalling totaling came comes stood stands amounted amounts amounting equal equals equalled equaled grew rose increased improved strengthened expanded climbed jumped declined fell decreased dropped slipped approximately approx about around roughly nearly almost over under just some fy fiscal year years million thousand billion mm m k b vs versus compared with prior previous up down margin margins by per normalized normalised adjusted reported recast broker seller's owner's sellers owners claimed initially originally stated estimated"
    .split(" "),
);

function linking(between: string): boolean {
  const t = between
    .replace(/\([^()]*\)/g, " ")
    .replace(/\$?\s?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|[kmb]\b|mm\b|million|thousand|billion)?/gi, " ")
    .replace(/\b(?:FY\s?'?)?(?:19|20)\d{2}\b/gi, " ")
    .toLowerCase();
  // "increased by $300,000", "down $0.2M": a change, not the measure's value.
  if (/\bby\s*[~(]*\s*$|\b(?:up|down)\s*[~(]*\s*$/.test(t)) return false;
  const words = t.match(/[a-z']+/g) ?? [];
  return words.every((w) => LINKING.has(w));
}

/** Does a measure name have its own figure right after it ("adjusted EBITDA $780,052", "EBITDA: $3.6M")? */
function ownFigureAfter(text: string, at: number): boolean {
  const rest = text.slice(at, at + 40);
  const f = parseFiguresAt(rest).find((x) => x.kind !== "plain" || /[×x]/.test(rest.slice(x.end, x.end + 1)));
  // Only a figure attached to it: "EBITDA $780,052", "EBITDA: $3.6M", "EBITDA of $3.6M" — not "EBITDA in 2024 vs 11.3%".
  return !!f && /^\s*(?:[:=]|of|was|is|at|totall?ed|reached|came to)?\s*~?\s*$/i.test(rest.slice(0, f.index));
}

export type EarningsKind = "ebitda" | "sde" | "margin" | "multiple";

export interface EarningsMention {
  kind: EarningsKind;
  /** ebitda / margin: which basis the wording names. */
  basis: "adjusted" | "reported" | "any" | "sde";
  value: number;
  tolerance: number;
  text: string;
  year: string | null;
  /** multiple: the sentence it sits in (is it the asking price's multiple, or a past offer's?). */
  context?: string;
}

interface Kw { at: number; end: number; earn: null | { basis: EarningsMention["basis"]; margin: boolean } }

function keywords(text: string): Kw[] {
  const out: Kw[] = [];
  for (const m of Array.from(text.matchAll(EARN_KW))) {
    const q = `${m[1] || ""} ${m[3] || ""} ${m[4] || ""}`.toLowerCase();
    const sde = /sde|discretionary/i.test(m[2]);
    const basis = sde ? "sde" : /adj|normali|recast/.test(q) ? "adjusted" : /report|unadjusted/.test(q) ? "reported" : "any";
    out.push({ at: m.index!, end: m.index! + m[0].length, earn: { basis, margin: !!m[5] } });
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
 * measure named before it in the same clause and linked to it
 * ("adjusted EBITDA has strengthened from $3.04 million in 2023 to $3.60
 * million in 2024"; "revenue has grown 8.3%" is a revenue figure, not a
 * margin; "Adjusted EBITDA adds back $165,000" is an add-back).
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
    // "…$920,052 (FY2024 adjusted EBITDA $780,052 …)": a measure followed by
    // a figure of its own belongs to that figure, not to the one before it.
    if (adjacent && next!.earn && !ownFigureAfter(text, next!.end)) gov = next!;
    // 2. Else the nearest measure before it in the same clause, when only
    //    linking words sit between them.
    if (!gov) {
      const from = clauseStart(text, index);
      const before = kws.filter((k) => k.end <= index && k.at >= from);
      const last = before.length ? before[before.length - 1] : null;
      gov = last && (!last.earn || linking(text.slice(last.end, index))) ? last : null;
    }
    if (!gov?.earn) continue;
    const year = yearNear(text, index, end);
    if (multiple) {
      const from = clauseStart(text, index);
      const stop = text.slice(end).search(/[.;!?\n](?:\s|$)/);
      out.push({ kind: "multiple", basis: gov.earn.basis, value: f.value, tolerance: f.tolerance, text: f.text, year, context: text.slice(from, stop >= 0 ? end + stop : text.length) });
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

/** Which metric a mention is about (for the unconfirmed test). */
function mentionMetric(m: EarningsMention): Metric | "reported" | "either" {
  if (m.kind === "sde" || m.basis === "sde") return "sde";
  if (m.basis === "reported") return "reported";
  if (m.basis === "adjusted") return "adjusted";
  return m.kind === "multiple" ? "adjusted" : "either";
}

/** The canonical values a mention may take (for its year, when it names one). */
function allowed(m: EarningsMention, c: EarningsCanon): Array<{ year: string; value: number; what: string }> {
  const pick = (values: Record<string, number>, what: string) =>
    Object.entries(values)
      .filter(([y]) => !m.year || y === m.year)
      .map(([year, value]) => ({ year, value, what }));
  if (m.kind === "sde") return pick(c.sde, "SDE");
  if (m.kind === "ebitda") {
    if (m.basis === "adjusted") return pick(c.adjustedEbitda, "Adjusted EBITDA");
    if (m.basis === "reported") return pick(c.reportedEbitda, "EBITDA as reported");
    return [...pick(c.adjustedEbitda, "Adjusted EBITDA"), ...pick(c.reportedEbitda, "EBITDA as reported")];
  }
  if (m.kind === "margin") {
    const kinds = m.basis === "sde" ? ["sde"] : m.basis === "adjusted" ? ["adjusted"] : m.basis === "reported" ? ["reported"] : ["adjusted", "reported"];
    return c.margins
      .filter((x) => kinds.includes(x.kind) && (!m.year || x.year === m.year))
      .map((x) => ({ year: x.year, value: x.pct, what: `${x.kind === "sde" ? "SDE" : x.kind === "adjusted" ? "adjusted EBITDA" : "reported EBITDA"} margin` }));
  }
  const kinds = m.basis === "sde" ? ["sde"] : m.basis === "adjusted" ? ["adjusted"] : ["adjusted", "sde"];
  return c.multiples.filter((x) => kinds.includes(x.kind)).map((x) => ({ year: x.year, value: x.value, what: `multiple of FY${x.year} ${x.kind === "sde" ? "SDE" : "Adjusted EBITDA"}` }));
}

function fmtCanon(k: { year: string; value: number; what: string }, kind: EarningsKind): string {
  if (kind === "margin") return `${k.value.toFixed(1)}% (${k.what}, FY${k.year})`;
  if (kind === "multiple") return `${k.value.toFixed(1)}× (${k.what})`;
  return `${money(k.value)} (${k.what}, FY${k.year})`;
}

/**
 * Is there a canonical figure this mention could be held to? An SDE figure
 * on a deal whose canon has no SDE (or a figure for a year the canon doesn't
 * cover) has nothing to disagree with, and stands — unless the metric is
 * unconfirmed (the bridge was withheld and no broker figure stands in).
 */
function checkable(m: EarningsMention, c: EarningsCanon): boolean {
  const metric = mentionMetric(m);
  if ((metric === "sde" || metric === "adjusted") && c.unconfirmed.includes(metric)) return true;
  if (m.kind === "multiple") return allowed({ ...m, year: null }, c).length > 0;
  // A margin needs the year's revenue to be computed at all (no statements, no margins).
  // A plain "EBITDA margin" for a year is judged only when that year's adjusted margin is known (below).
  if (m.kind === "margin") {
    if (metric === "either" && m.year) return c.margins.some((x) => x.kind === "adjusted" && x.year === m.year);
    return allowed(m, c).length > 0;
  }
  const has = (v: Record<string, number>) => (m.year ? typeof v[m.year] === "number" : Object.keys(v).length > 0);
  if (metric === "sde") return has(c.sde);
  if (metric === "reported") return has(c.reportedEbitda);
  if (metric === "adjusted") return has(c.adjustedEbitda);
  // A plain "EBITDA" for a year: held to the canon only when the canon has
  // that year's adjusted figure (a 2022 margin on a deal whose adjusted
  // EBITDA is known for 2024 only is most likely the adjusted one, and can't
  // be judged against the statements alone).
  return m.year ? has(c.adjustedEbitda) : has(c.adjustedEbitda) || has(c.reportedEbitda);
}

const ASKING_MULTIPLE = /\b(?:asking|list(?:ing|ed)?|purchase price|price[sd]?|pricing|valuation|valued|implie[sd]|represents?|offered (?:for|at) \$)/i;
const OTHER_MULTIPLE = /\b(?:an offer|the offer|offers?\s+(?:of|from|at|around)|offered (?:around|about|roughly|approximately|~)|was offered|were offered|bid|declined|rejected|previous|prior|earlier|former|comparable|comps|industry|typical(?:ly)?|market (?:multiples?|rate)|trade[sd]? at|sold (?:for|at)|earn-?out)\b/i;

/** Mentions in a text that aren't the canon's figures, with what the canon says instead. */
export function offCanon(text: string, c: EarningsCanon): Array<{ mention: EarningsMention; expected: string }> {
  const out: Array<{ mention: EarningsMention; expected: string }> = [];
  for (const m of earningsMentions(text)) {
    // A multiple is the CIM's only when it is the asking price's — not a
    // past offer's ("offered around 4x EBITDA in 2023") or the market's.
    if (m.kind === "multiple" && (!ASKING_MULTIPLE.test(m.context ?? "") || OTHER_MULTIPLE.test(m.context ?? ""))) continue;
    if (!checkable(m, c)) continue;
    const metric = mentionMetric(m);
    if ((metric === "sde" || metric === "adjusted") && c.unconfirmed.includes(metric)) {
      out.push({ mention: m, expected: `nothing — no ${metricLabel(metric)} is confirmed for the CIM, so leave the figure out` });
      continue;
    }
    const ok = allowed(m, c);
    if (ok.some((k) => within(m.value, m.tolerance, k.value))) continue;
    // Name what it should be: that year's figure(s), else the latest.
    const pool = ok.length > 0 ? ok : allowed({ ...m, year: null }, c);
    const year = m.year ?? c.latestYear;
    const forYear = pool.filter((k) => k.year === year);
    const best = forYear.length > 0 ? forYear : pool.length > 0 ? [pool[pool.length - 1]] : [];
    out.push({
      mention: m,
      expected: best.length > 0 ? best.map((k) => fmtCanon(k, m.kind)).join(" or ") : m.year ? `no FY${m.year} figure on file` : "the canonical figure",
    });
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
      const read = prefix ? `${prefix}: ${p}` : p;
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

/**
 * The broker's warnings about earnings: which figure the CIM uses (and from
 * where), the part of the analysis bridge left out when the broker's figure
 * overrules it, broker figures that disagree with each other, and what on
 * file was left out.
 */
export function earningsWarnings(c: EarningsCanon, held: EarningsHold[]): string[] {
  const out: string[] = [];
  const y = c.latestYear;
  if (c.override) {
    const parts = c.override.items.map((i) => `${metricLabel(i.metric)} FY${i.year}: ${i.broker.text} (${i.broker.from}) — the financial analysis add-backs give ${money(i.bridge)}`);
    const what =
      c.override.withheld === "bridge"
        ? "so the analysis's EBITDA/SDE bridge is left out of the CIM"
        : c.override.withheld === "adjustedSubtotal"
          ? "so the bridge is shown straight to SDE, without its adjusted EBITDA subtotal"
          : "so the bridge is shown to adjusted EBITDA, without its SDE step";
    out.push(`Earnings: the CIM uses your figures — ${parts.join("; ")} — ${what}. To show the bridge, correct the add-backs on the Financials tab until they reach your figure, then regenerate.`);
  }
  for (const u of c.unconfirmed) {
    out.push(`Earnings: no ${metricLabel(u)} is confirmed now that the analysis bridge is left out, so the CIM states none. Add the figure on the Information tab if buyers should see it.`);
  }
  for (const s of c.staleBrokerFigures ?? []) {
    const f = s.figure;
    out.push(`Earnings: ${f.text} for ${metricLabel(f.metric)} FY${f.year} (${f.from}) was set before the add-backs on the Financials tab last changed, so the CIM uses the analysis's ${money(s.bridge)}. If ${f.text} is still right, enter it again on the Information tab and regenerate.`);
  }
  for (const k of c.brokerConflicts) {
    out.push(`Earnings: your figures for ${metricLabel(k.metric)} FY${k.year} disagree (${k.figures.map((f) => `${f.text} in ${f.from}`).join("; ")}), so neither is used. Correct one on the Information tab.`);
  }
  if (held.length > 0) {
    const uses = [
      typeof c.adjustedEbitda[y] === "number" ? `Adjusted EBITDA ${money(c.adjustedEbitda[y])}` : "",
      typeof c.sde[y] === "number" ? `SDE ${money(c.sde[y])}` : "",
    ].filter(Boolean).join(" and ");
    const from = [c.source.adjusted[y], c.source.sde[y]].some((s) => s && s !== "bridge") ? "" : " from the financial analysis bridge";
    const items = held.slice(0, 5).map((h) => `"${h.text.length > 90 ? `${h.text.slice(0, 87)}…` : h.text}" (${h.where})`);
    const more = held.length > 5 ? `, and ${held.length - 5} more` : "";
    out.push(
      `Earnings figures: the CIM uses ${uses || "no adjusted EBITDA or SDE"} for FY${y}${from}, everywhere. These differ and were left out of the CIM: ${items.join("; ")}${more}. If a figure on file is the right one, correct it on the Information tab (or the add-backs on the Financials tab) and regenerate.`,
    );
  }
  return out;
}

