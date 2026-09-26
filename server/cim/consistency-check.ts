/**
 * consistency-check — figures that are each "on file" but that don't agree
 * with each other, with their year, or with the definition they're used
 * under. The figure check (figure-check.ts) asks "is this number in the
 * knowledge base?"; this asks "is it used as what it is?".
 *
 * Pacific's CIM (acceptance run, 2026-09-26) passed the figure check and
 * still told buyers four untrue things:
 *   - Working capital. An analysis stored before the cash-free rule listed
 *     cash and the current portion of long-term debt as working-capital
 *     lines; the writer set that $1,022,999 "net working capital" beside
 *     the $2.4M peg (a cash-free, debt-free figure) and promised a
 *     seller-funded "shortfall". On the peg's own basis NWC was above it.
 *   - Counts and rates. A glued PDF table ("2024 64 6 1 5 9.4%") became
 *     "646 inspections, 1 driver OOS, 5 vehicle OOS, 9.4% OOS rate": every
 *     number on file, and 6 of 646 is 0.9%, not 9.4%.
 *   - Debt by year. "$7,570,000 total as of December 31, 2024" was the 2023
 *     balance ($7,860,000 at 2024 year-end), and "$350,000 drawn" on the
 *     line was 2023's — the 2024 draw was nil.
 *
 * Two uses: `factConsistency` screens the facts before the writer sees
 * them (holds a fact that can't be true, annotates one that needs its year,
 * and tells the broker), and `consistencyProblems` checks a written
 * section (it is rewritten once with the list, like any figure problem;
 * a working-capital table that still mixes definitions is rebuilt from the
 * analysis in code — `workingCapitalSectionData`).
 *
 * Pure: no database, no AI.
 */
import { parseFiguresAt } from "./figure-check";
import { isExcludedWorkingCapitalAsset, isExcludedWorkingCapitalLiability } from "../financial/normalization-rules";
import { money, periodLabel, type CimDebt, type CimFinancials, type CimWorkingCapital } from "./cim-financials";

// ── Walking a section ────────────────────────────────────────────────────

interface SectionLike {
  sectionTitle: string;
  layoutType: string;
  layoutData: unknown;
  aiDraftContent?: unknown;
}

const s = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" || typeof v === "number" ? String(v) : "");
const isRec = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Presentation keys: never text a buyer reads as a claim. */
const SKIP = new Set(["layoutType", "style", "trend", "accentColor", "color", "icon", "id", "parentId", "reportsTo", "sectionKey", "relatedSections", "url", "src", "mediaId", "highlight", "bold", "indent", "isTotal", "isSectionHeader", "columns", "expandable", "expandLabel", "collapseLabel"]);
const LABEL_KEYS = ["label", "title", "name", "primaryLabel"];

/**
 * A section's text as the units a reader takes in together: one per item
 * ("Roadside Inspections: 646 (1 driver OOS, 5 vehicle OOS)"), one per
 * paragraph-like string elsewhere.
 */
export function sectionUnits(section: SectionLike, opts: { skipTableRows?: boolean } = {}): string[] {
  const out: string[] = [];
  // Table rows read with their column headings (a year per column) — tableRows.
  const tableRowKeys = opts.skipTableRows ? new Set(["rows", "normalizedRows"]) : new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (v.trim()) out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (!isRec(v)) return;
    const label = LABEL_KEYS.map((k) => s(v[k])).find((x) => x.trim()) ?? "";
    const leaves: string[] = [];
    for (const [k, x] of Object.entries(v)) {
      if (SKIP.has(k) || LABEL_KEYS.includes(k) || tableRowKeys.has(k)) continue;
      if (typeof x === "string" || typeof x === "number") {
        if (s(x).trim()) leaves.push(s(x));
      } else if (Array.isArray(x) && x.every((e) => typeof e === "string" || typeof e === "number")) {
        if (x.some((e) => s(e).trim())) leaves.push(x.map(s).join(" | "));
      } else {
        walk(x);
      }
    }
    // " | " between an item's fields: a dash would read "$1,022,999 — $2,400,000" as a range.
    if (label || leaves.length) out.push(label ? `${label}: ${leaves.join(" | ")}` : leaves.join(" | "));
  };
  walk(section.layoutData);
  if (typeof section.aiDraftContent === "string" && section.aiDraftContent.trim()) out.push(section.aiDraftContent);
  return out;
}

interface TableRow {
  /** The table-like layout the row sits in (a key-figure grid is not a statement). */
  kind: string;
  label: string;
  cells: string[];
  /** Column headings, one per cell ("As of Dec 31, 2024", "Normalized Target", "FY2024"). */
  columns: string[];
  where: string;
}

/** Label/value rows of the table-like layouts (nested two-column sides included). */
function tableRows(layoutType: string, d: unknown, where = ""): TableRow[] {
  if (!isRec(d)) return [];
  const rows: TableRow[] = [];
  const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
  switch (layoutType) {
    case "comparison_table":
      for (const r of arr(d.rows)) rows.push({ kind: layoutType, label: s(r?.label), cells: [s(r?.left), s(r?.right)], columns: [s(d.leftLabel), s(d.rightLabel)], where });
      break;
    case "financial_table": {
      const headers = arr(d.headers).map(s);
      for (const r of [...arr(d.rows), ...arr(d.normalizedRows)]) rows.push({ kind: layoutType, label: s(r?.label), cells: arr(r?.values).map(s), columns: headers.slice(1), where });
      break;
    }
    case "metric_grid":
      for (const m of arr(d.metrics)) rows.push({ kind: layoutType, label: s(m?.label), cells: [s(m?.value)], columns: [s(m?.description ?? m?.footnote)], where });
      break;
    case "icon_stat_row":
      for (const m of arr(d.stats)) rows.push({ kind: layoutType, label: s(m?.label), cells: [s(m?.value)], columns: [s(m?.description)], where });
      break;
    case "two_column":
      for (const side of ["left", "right"]) {
        const col = d[side];
        if (isRec(col) && isRec(col.content) && typeof col.layoutType === "string") rows.push(...tableRows(col.layoutType, col.content, `${side} column `));
      }
      break;
  }
  return rows;
}

const within = (v: number, tol: number, k: number) => Math.abs(Math.abs(v) - Math.abs(k)) <= tol + 1e-6 * Math.max(1, Math.abs(k));

function moneyFigures(text: string) {
  return parseFiguresAt(text).filter((f) => f.kind === "money" || (f.kind === "plain" && (Math.abs(f.value) >= 1000 || f.text.includes(","))));
}

// ── Years ────────────────────────────────────────────────────────────────

const YEAR = String.raw`(?:FY\s?)?((?:19|20)\d{2})`;
const DATE_BEFORE_YEAR = String.raw`(?:(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+)?`;

/** The year the text ties the figure at [index, end) to, if any ("$X (2023)", "2023: $X", "$X as of December 31, 2024"). */
export function yearOfFigure(text: string, index: number, end: number): string | null {
  const after = text.slice(end, end + 60);
  const a = new RegExp(
    String.raw`^\s*(?:\(\s*${YEAR}\s*\)|(?:[a-z]+\s+){0,2}(?:in|for|at|as of|as at|at year[- ]end|by(?:\s+the)?\s+(?:year[- ]end|end\s+of))\s+(?:fiscal\s+)?${DATE_BEFORE_YEAR}${YEAR}\b)`,
    "i",
  ).exec(after);
  if (a) return a[1] ?? a[2] ?? null;
  const start = Math.max(0, index - 40);
  const before = text.slice(start, index);
  const b = new RegExp(String.raw`(?:\b${YEAR}\s*[:–-]\s*|\b(?:in|for|at|as of|as at)\s+(?:fiscal\s+)?${DATE_BEFORE_YEAR}${YEAR},?\s*(?:[a-z]+\s+){0,3})$`, "i").exec(before);
  if (!b) return null;
  // A date that follows another figure is that figure's ("$7,570,000 at
  // December 31, 2023 were reduced to $7,860,000"): never borrowed.
  const lead = text.slice(Math.max(0, start + b.index - 30), start + b.index);
  if (/\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|million|thousand)?\s*$/i.test(lead) || /\d\s?%\s*$/.test(lead)) return null;
  return b[1] ?? b[2] ?? null;
}

function yearsIn(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/\b(?:FY\s?)?((?:19|20)\d{2})\b/gi)).map((m) => m[1])));
}

// ── Counts and rates ─────────────────────────────────────────────────────

export interface CountRateMismatch {
  /** "2024: 646 inspections, 1 driver OOS, 5 vehicle OOS, 9.4% OOS rate" */
  phrase: string;
  total: number;
  totalNoun: string;
  parts: number;
  rate: number;
  computed: number;
  /** Every count behind the mismatch (the population and each part): what a clean-up leaves out. */
  numbers: number[];
}

/** Rates of change or of money — never a count over a population. */
const NOT_A_COUNT_RATE = new Set(["growth", "compound", "cagr", "margin", "interest", "tax", "return", "discount", "inflation", "exchange", "run", "burn", "capitalization", "cap", "gross", "net", "effective", "hourly", "billing", "labour", "labor", "tier", "retention"]);
const RATE_FILLER = new Set(["the", "a", "an", "its", "our", "their", "overall", "average", "annual", "combined", "total", "of", "and", "was", "is", "with"]);
/** Nouns that are units, not a population a rate is taken over. */
const NOT_POPULATION = /^(years|months|weeks|days|hours|minutes|kms?|miles|kilometres|kilometers|percent|dollars|points|times|metres|meters|feet|acres|units)$/;

function normRate(text: string): string {
  return text.toLowerCase().replace(/out[- ]of[- ]service/g, "oos").replace(/[–—]/g, "-");
}

interface Rate { value: number; words: string[]; at: number }

function ratesIn(t: string): Rate[] {
  const out: Rate[] = [];
  for (const m of Array.from(t.matchAll(/(\d+(?:\.\d+)?)\s?(?:%|percent)\s+((?:[a-z][a-z-]*\s+){0,3}?)rate\b/g))) {
    out.push({ value: Number(m[1]), words: m[2].trim().split(/\s+/).filter((w) => w && !RATE_FILLER.has(w)), at: m.index! });
  }
  for (const m of Array.from(t.matchAll(/((?:[a-z][a-z-]*\s+){1,4})rate\b[^\d%.;]{0,24}?(\d+(?:\.\d+)?)\s?(?:%|percent)/g))) {
    if (out.some((r) => Math.abs(r.at - m.index!) < 30 && r.value === Number(m[2]))) continue;
    out.push({ value: Number(m[2]), words: m[1].trim().split(/\s+/).filter((w) => w && !RATE_FILLER.has(w)), at: m.index! });
  }
  return out;
}

/** "1 driver oos" / "36 oos": counts of the rate's event, with the word before it (driver/vehicle) if any. */
function partsIn(t: string, event: string): Array<{ n: number; qualifier: string | null; at: number }> {
  const out: Array<{ n: number; qualifier: string | null; at: number }> = [];
  const re = new RegExp(String.raw`(?<![\d.,$])\b(\d[\d,]*)(?!\.\d)(?!\s?%)\s+(?:([a-z]+)\s+)?${event.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b(?!\s+rate)`, "g");
  for (const m of Array.from(t.matchAll(re))) {
    if (m[2] === "percent" || m[2] === "per") continue;
    out.push({ n: Number(m[1].replace(/,/g, "")), qualifier: m[2] && !RATE_FILLER.has(m[2]) ? m[2] : null, at: m.index! });
  }
  return out;
}

/** "646 inspections" / "roadside inspections: 646": the population a rate is taken over. */
function populationsIn(t: string, event: string): Array<{ n: number; noun: string; at: number }> {
  const out: Array<{ n: number; noun: string; at: number }> = [];
  for (const m of Array.from(t.matchAll(/(?<![\d.,$])\b(\d[\d,]*)(?!\.\d)(?!\s?%)\s+(?:[a-z]+\s+)?([a-z]{4,}s)\b/g))) {
    if (m[2] === `${event}s` || NOT_POPULATION.test(m[2])) continue;
    out.push({ n: Number(m[1].replace(/,/g, "")), noun: m[2], at: m.index! });
  }
  for (const m of Array.from(t.matchAll(/\b([a-z]{4,}s)\s*:\s*(\d[\d,]*)(?!\.\d)(?!\s?%)\b/g))) {
    if (NOT_POPULATION.test(m[1])) continue;
    out.push({ n: Number(m[2].replace(/,/g, "")), noun: m[1], at: m.index! });
  }
  return out;
}

/**
 * One group of figures (a clause, a by-year entry, an item): a rate whose
 * own counts give a different rate. `extraRates` are rates stated elsewhere
 * (another metric in the same section) that the group's counts are about.
 */
function mismatchesInGroup(group: string, extraRates: Rate[] = []): CountRateMismatch[] {
  const t = normRate(group);
  const rates = [...ratesIn(t), ...extraRates];
  const out: CountRateMismatch[] = [];
  for (const rate of rates) {
    if (rate.words.some((w) => NOT_A_COUNT_RATE.has(w))) continue;
    for (const event of rate.words) {
      if (event.length < 2 || event === "percent") continue;
      const allParts = partsIn(t, event);
      if (allParts.length === 0) continue;
      // A rate for one kind ("vehicle OOS rate") counts only that kind.
      const kind = rate.words.find((w) => w !== event && allParts.some((p) => p.qualifier === w));
      const parts = kind ? allParts.filter((p) => p.qualifier === kind) : allParts;
      const totalParts = parts.filter((p) => p.qualifier === null);
      const sums = [totalParts.reduce((a, p) => a + p.n, 0), parts.filter((p) => p.qualifier !== null).reduce((a, p) => a + p.n, 0)].filter((x) => x > 0);
      const firstPart = Math.min(...parts.map((p) => p.at));
      // The population is never the event itself: "60 claims" beside a claims
      // rate, or the "45 warranty claims" a part was read from, are the
      // counts, not what they are counted over ("… on 5,000 shipments").
      const eventStem = stem5(event);
      const pops = populationsIn(t, event).filter(
        (p) => p.n >= Math.max(...sums, 1) && stem5(p.noun) !== eventStem && !allParts.some((q) => q.at === p.at),
      );
      if (pops.length === 0 || sums.length === 0) continue;
      // The population named nearest before the counts.
      const pop = pops.filter((p) => p.at <= firstPart).pop() ?? pops[0];
      const ok = sums.some((sum) => {
        const computed = (sum / pop.n) * 100;
        return Math.abs(computed - rate.value) <= Math.max(0.2, rate.value * 0.08);
      });
      if (ok) continue;
      const parts0 = sums[0];
      out.push({
        phrase: group.trim(),
        total: pop.n,
        totalNoun: pop.noun,
        parts: parts0,
        rate: rate.value,
        computed: Math.round((parts0 / pop.n) * 1000) / 10,
        numbers: Array.from(new Set([pop.n, ...parts.map((p) => p.n)])),
      });
      break;
    }
  }
  return out;
}

/** Where a fact's text breaks into groups (by-year entries, clauses, sentences); captured so a clean-up can rejoin them. */
const GROUP_SPLIT = /(\s·\s|;\s*|\n|\.\s+(?=[A-Z0-9]))/;

/** Count/rate mismatches in a piece of text, group by group (clauses and by-year entries). */
export function countRateMismatches(text: string): CountRateMismatch[] {
  const groups = text.split(GROUP_SPLIT).filter((g, i) => i % 2 === 0 && g.trim());
  const seen = new Set<string>();
  const out: CountRateMismatch[] = [];
  for (const g of groups) {
    for (const m of mismatchesInGroup(g)) {
      const k = `${m.total}|${m.parts}|${m.rate}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(m);
      }
    }
  }
  return out;
}

/** Counts in a clause ("646 inspections", "1 driver OOS") — never a year, a rate or money. */
function countsIn(clause: string): number[] {
  return Array.from(clause.matchAll(/(?<![\d.,$])\b(\d[\d,]*)(?!\.\d)(?!\s?%)(?![\d,])/g))
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => !(n >= 1900 && n <= 2099));
}

/**
 * The text with the counts that don't give their rate taken out, the rates
 * kept: "2022: 589 inspections, 36 out-of-service, 15.5% OOS rate" →
 * "2022: 15.5% OOS rate". A glued table misreads the counts ("58" + "9"),
 * while the rate is printed on its own — so the counts go, never the rate
 * (Pacific: holding the whole fact lost the true 2022 and 2023 rates).
 * `text` is null when nothing but counts would be left.
 */
export function stripMismatchedCounts(input: string): { text: string | null; mismatches: CountRateMismatch[] } {
  const pieces = input.split(GROUP_SPLIT);
  const all: CountRateMismatch[] = [];
  let changed = false;
  for (let i = 0; i < pieces.length; i += 2) {
    const group = pieces[i];
    if (!group.trim()) continue;
    const found = mismatchesInGroup(group);
    if (found.length === 0) continue;
    all.push(...found);
    const bad = new Set(found.flatMap((m) => m.numbers));
    // "2022: …" / "Roadside inspections: …" — the group's own label stays.
    const label = /^\s*[^:%$\d]{0,40}(?:(?:19|20)\d{2})?[^:%$\d]{0,10}:\s*/.exec(group)?.[0] ?? "";
    const kept = group
      .slice(label.length)
      .split(/,\s*|\s*\(\s*|\s*\)\s*,?\s*/)
      .map((c) => c.trim())
      .filter((c) => c && (/%/.test(c) || !countsIn(c).some((n) => bad.has(n))));
    pieces[i] = kept.some((c) => /%/.test(c)) ? `${label}${kept.join(", ")}` : "";
    changed = true;
  }
  if (!changed) return { text: input, mismatches: [] };
  // Rejoin, dropping the separator of an emptied group.
  const out: string[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    if (!pieces[i].trim()) continue;
    if (out.length > 0) out.push(pieces[i - 1] ?? " · ");
    out.push(pieces[i]);
  }
  const text = out.join("").trim();
  return { text: /%/.test(text) ? text : null, mismatches: all };
}

function describeMismatch(m: CountRateMismatch): string {
  return `${m.parts} of ${m.total.toLocaleString("en-US")} ${m.totalNoun} is ${m.computed}%, not the ${m.rate}% stated`;
}

// ── Working capital ──────────────────────────────────────────────────────

const NWC_WORDS = /\bnet\s+working\s+capital\b|\bnwc\b|\bworking\s+capital\b/i;
const PEG_WORDS = /\bpeg\b|\btarget\b|\bnormali[sz]ed\b|\bbenchmark\b|\brequired\b/i;
/** "current assets $6.2M less current liabilities $5.18M": total current assets minus total current liabilities. */
const ALL_IN_WORDS = /\bcurrent\s+assets\b[^.;]{0,60}\b(?:less|minus|net\s+of|over)\b[^.;]{0,40}\bcurrent\s+liabilities\b|\btotal\s+current\s+assets\b[^.;]{0,40}[-−–]\s*(?:total\s+)?current\s+liabilities/i;

/** A flow, ratio or period measure — never a balance-sheet line. */
const FLOW_LABEL = /\b(?:flows?|conversion|days|ratio|margin|turnover|coverage|yield|growth|%)/i;
const isNwcTotalLabel = (label: string) => /\b(?:net\s+working\s+capital|nwc)\b/i.test(label) || /^\s*(?:total\s+)?working\s+capital\s*$/i.test(label);
const isExcludedLine = (label: string) => isExcludedWorkingCapitalAsset(label) || isExcludedWorkingCapitalLiability(label);

/** Values a CIM may give as net working capital: the cash-free, debt-free closing figure and year-end history. */
function nwcValues(wc: CimWorkingCapital): number[] {
  const tax = wc.withIncomeTaxes;
  return [wc.netWorkingCapital, ...Object.values(wc.history ?? {}), ...(tax ? [tax.netWorkingCapital, ...Object.values(tax.history ?? {})] : [])].filter((n) => Number.isFinite(n));
}

/**
 * Rows of a balance sheet (not a working-capital statement): cash and the
 * current portion of debt are its own lines there, beside any NWC row.
 */
const BALANCE_SHEET_ROW = /\b(?:total\s+assets|total\s+liabilities\s*(?:and|&)|(?:shareholders?'?|owners?'?)\s+equity|total\s+equity|retained\s+earnings|share\s+capital|property|plant\s+and\s+equipment|fixed\s+assets|intangible|goodwill|non[- ]current|future\s+(?:\(deferred\)\s+)?income\s+tax|deferred\s+income\s+tax)\b/i;
const isBalanceSheetTable = (rows: TableRow[]) => rows.some((r) => BALANCE_SHEET_ROW.test(r.label) || /^\s*long[- ]term\s+debt\b/i.test(r.label));

function wcWhere(wc: CimWorkingCapital): string {
  return wc.asOfPeriod ? ` at ${periodLabel(wc.asOfPeriod)}` : "";
}

/** Does a section present working capital? */
function aboutWorkingCapital(section: SectionLike, rows: TableRow[], units: string[]): boolean {
  if (NWC_WORDS.test(section.sectionTitle)) return true;
  if (rows.some((r) => isNwcTotalLabel(r.label))) return true;
  return units.some((u) => NWC_WORDS.test(u) && PEG_WORDS.test(u));
}

/**
 * Working capital stated on two definitions: cash or debt listed as a
 * working-capital line, an NWC figure that isn't the cash-free, debt-free
 * one, or a shortfall / excess against the peg the figures don't show.
 */
export function workingCapitalProblems(section: SectionLike, wc: CimWorkingCapital | null | undefined): string[] {
  const rows = tableRows(section.layoutType, section.layoutData);
  const units = sectionUnits(section);
  if (!aboutWorkingCapital(section, rows, units)) return [];
  const out: string[] = [];
  const hasTotal = rows.some((r) => isNwcTotalLabel(r.label));
  const hasPeg = units.some((u) => PEG_WORDS.test(u) && NWC_WORDS.test(u)) || rows.some((r) => r.columns.some((c) => PEG_WORDS.test(c)));
  if ((hasTotal || hasPeg) && !isBalanceSheetTable(rows)) {
    // Lines of a statement table only: a key-figure grid's "Cash position" or
    // "Free cash flow" beside NWC is a separate figure, not one of its lines;
    // a balance sheet lists cash and the current portion of debt as its own
    // lines, whatever NWC row it adds.
    const mixed = rows.filter(
      (r) => (r.kind === "comparison_table" || r.kind === "financial_table") && !isNwcTotalLabel(r.label) && !FLOW_LABEL.test(r.label) && isExcludedLine(r.label) && r.cells.some((c) => c.trim()),
    );
    if (mixed.length > 0) {
      out.push(
        `${mixed.map((r) => `"${r.label}"`).join(", ")} ${mixed.length === 1 ? "is" : "are"} listed as working capital — on the cash-free, debt-free basis the peg uses, cash, bank debt, the current portion of long-term debt and income taxes are not part of net working capital; list only the WORKING CAPITAL lines in AUTHORITATIVE FINANCIALS`,
      );
    }
  }
  if (!wc) return out;
  const allowed = nwcValues(wc);
  const allIn = wc.allInNetWorkingCapital;
  const expect = `on the cash-free, debt-free basis${wc.pegAmount !== null ? " (the peg's)" : ""} it is ${money(wc.netWorkingCapital)}${wcWhere(wc)}`;
  const flagged = new Set<string>();
  const flag = (text: string, v: number, tol: number) => {
    const key = text.trim();
    if (flagged.has(key)) return;
    flagged.add(key);
    const why = allIn !== null && within(v, Math.max(tol, 1000, Math.abs(allIn) * 0.02), allIn) ? ` (${text.trim()} is total current assets less total current liabilities, cash and debt included)` : "";
    out.push(`net working capital given as ${text.trim()} — ${expect}${why}`);
  };
  // Table rows: the NWC row's figure in a non-peg column.
  for (const r of rows) {
    if (!isNwcTotalLabel(r.label) || PEG_WORDS.test(r.label)) continue;
    r.cells.forEach((c, i) => {
      if (PEG_WORDS.test(r.columns[i] ?? "")) return;
      for (const f of moneyFigures(c)) if (!allowed.some((k) => within(f.value, f.tolerance, k))) flag(f.text, f.value, f.tolerance);
    });
  }
  // Prose: the first figure after "net working capital", unless it's the peg's.
  for (const u of units) {
    for (const m of Array.from(u.matchAll(/\b(?:net\s+working\s+capital|nwc)\b/gi))) {
      const tail = u.slice(m.index! + m[0].length, m.index! + m[0].length + 90);
      const f = moneyFigures(tail)[0];
      if (!f) continue;
      const between = tail.slice(0, f.index);
      if (PEG_WORDS.test(between) || /[.;]/.test(between.replace(/\d\.\d/g, ""))) continue;
      if (!allowed.some((k) => within(f.value, f.tolerance, k)) && !(wc.pegAmount && within(f.value, f.tolerance, wc.pegAmount))) flag(f.text, f.value, f.tolerance);
    }
  }
  // A shortfall or excess the figures don't show. With income taxes payable
  // counted either way, the claim stands if either treatment shows it.
  const text = units.join(" ");
  const saysShort = /\b(?:shortfall|deficit|short)\s+of\s+(?:approximately\s+|about\s+|roughly\s+)?\$|\bbelow\s+the\s+(?:normali[sz]ed\s+)?(?:working\s+capital\s+)?(?:peg|target)\b/i.test(text);
  const saysOver = /\b(?:excess|surplus)\s+of\s+(?:approximately\s+|about\s+|roughly\s+)?\$|\babove\s+the\s+(?:normali[sz]ed\s+)?(?:working\s+capital\s+)?(?:peg|target)\b/i.test(text);
  if (typeof wc.pegAmount === "number") {
    const diffs = [wc.netWorkingCapital, ...(wc.withIncomeTaxes ? [wc.withIncomeTaxes.netWorkingCapital] : [])].map((n) => n - wc.pegAmount!);
    const diff = diffs[0];
    if (saysShort && diffs.every((d) => d > 0)) out.push(`says working capital is short of the peg — ${expect}, ${money(Math.abs(diff))} above the ${money(wc.pegAmount)} peg`);
    if (saysOver && diffs.every((d) => d < 0)) out.push(`says working capital is above the peg — ${expect}, ${money(Math.abs(diff))} below the ${money(wc.pegAmount)} peg`);
  } else if (wc.pegWithheld) {
    // The stored peg is on the all-in basis: no peg, and no comparison with one.
    const peg = wc.pegWithheld;
    const statesPeg = units.some((u) =>
      Array.from(u.matchAll(/\b(?:peg|target\s+(?:net\s+)?working\s+capital|normali[sz]ed\s+(?:net\s+)?working\s+capital(?:\s+target)?)\b/gi)).some((m) => {
        const f = moneyFigures(u.slice(m.index!, m.index! + m[0].length + 60))[0];
        return !!f && !allowed.some((k) => within(f.value, f.tolerance, k));
      }),
    ) || rows.some((r) => isNwcTotalLabel(r.label) && r.cells.some((c, i) => PEG_WORDS.test(r.columns[i] ?? "") && moneyFigures(c).length > 0));
    if (statesPeg || saysShort || saysOver) {
      out.push(`states a working capital peg or a shortfall/excess against one — ${peg.reason}; state no peg; net working capital is ${money(wc.netWorkingCapital)}${wcWhere(wc)}, cash-free and debt-free`);
    }
  }
  return out;
}

/** The working-capital problems that mean the section mixes definitions (vs a lone stray figure). */
export function mixesWorkingCapitalDefinitions(problems: string[]): boolean {
  return problems.some((p) => /is listed as working capital|are listed as working capital|^net working capital given as|^says working capital is|^states a working capital peg/.test(p));
}

/**
 * A working-capital section built in code from the analysis: the
 * cash-free, debt-free lines, NWC beside the peg, and what was left out.
 * Used when a written section still mixes definitions after its rewrite.
 */
export function workingCapitalSectionData(wc: CimWorkingCapital): { layoutType: "comparison_table"; layoutData: Record<string, unknown> } {
  const asOf = wc.asOfPeriod ? periodLabel(wc.asOfPeriod) : "Latest balance sheet";
  const hasPeg = typeof wc.pegAmount === "number";
  const rows: Array<Record<string, unknown>> = [
    ...wc.currentAssets.map((i) => ({ label: i.name, left: money(i.amount), right: "" })),
    ...wc.currentLiabilities.map((i) => ({ label: i.name, left: money(-Math.abs(i.amount)), right: "" })),
    { label: "Net working capital", left: money(wc.netWorkingCapital), right: hasPeg ? money(wc.pegAmount!) : "", highlight: true },
  ];
  const left = wc.excluded.map((i) => i.name.toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").trim());
  const intro = [
    hasPeg ? "Net working capital is shown on a cash-free, debt-free basis — the same basis as the working capital peg." : "Net working capital is shown on a cash-free, debt-free basis.",
    left.length > 0 ? `Cash, bank debt, the current portion of long-term debt and income taxes are settled at closing and are not part of it.` : "",
  ].filter(Boolean).join(" ");
  return {
    layoutType: "comparison_table",
    layoutData: {
      intro,
      leftLabel: asOf,
      rightLabel: hasPeg ? "Peg (target)" : "",
      rows,
    },
  };
}

/** A section title naming more than working capital: its other content isn't the analysis's to replace. */
const OTHER_TOPIC = /\b(?:balance\s+sheet|debt|transaction|structure|deal|terms|capex|capital\s+expenditures?|financials?|summary|overview|highlights?)\b/i;

/** Current-asset / current-liability line names: what a working-capital statement is made of. */
const CURRENT_ITEM = /\b(?:current|receivables?|inventor(?:y|ies)|prepaid|payables?|accrued|accruals|deposits?|cash|debt|tax(?:es)?|deferred\s+revenue|contract|wip|unbilled|billings|remittances?|holdbacks?)\b/i;

/**
 * Is the section itself about working capital — its title, or a
 * working-capital statement table (an NWC total over current lines, not a
 * balance sheet)? Only such a section is rebuilt from the analysis; one that
 * merely mentions working capital (a transaction summary, a balance sheet)
 * keeps its own content (withoutWorkingCapitalClaims).
 */
export function isWorkingCapitalSection(section: SectionLike): boolean {
  // "Working Capital" / "Net Working Capital Peg" — not "Balance Sheet & Working Capital".
  if (NWC_WORDS.test(section.sectionTitle) && !OTHER_TOPIC.test(section.sectionTitle)) return true;
  const rows = tableRows(section.layoutType, section.layoutData);
  if (!rows.some((r) => isNwcTotalLabel(r.label)) || isBalanceSheetTable(rows)) return false;
  const lines = rows.filter((r) => !isNwcTotalLabel(r.label) && r.label.trim());
  return lines.length > 0 && lines.filter((r) => CURRENT_ITEM.test(r.label)).length * 2 >= lines.length;
}

/**
 * A section that only mentions working capital, with the claims that failed
 * the working-capital check taken out — the list item, table row or
 * sentence that states them — and nothing else touched (Pacific's
 * "Transaction Structure" kept its asking price and structure when one stray
 * item set $1.0 million of NWC beside the peg). Null when nothing was found
 * to take out.
 */
export function withoutWorkingCapitalClaims(section: SectionLike, wc: CimWorkingCapital): { layoutData: unknown; aiDraftContent: unknown; removed: string[] } | null {
  const allowed = nwcValues(wc);
  const removed: string[] = [];
  const failsAsProse = (text: string) =>
    (NWC_WORDS.test(text) || /\bpeg\b|shortfall|surplus|\bexcess\b/i.test(text)) &&
    mixesWorkingCapitalDefinitions(workingCapitalProblems({ sectionTitle: "Working capital", layoutType: "prose_highlight", layoutData: { body: text } }, wc));
  // A table row or key figure labelled as NWC whose figure isn't the cash-free one (or the peg).
  const rowFails = (r: Record<string, any>) => {
    const label = s(r.label ?? r.title ?? r.name);
    if (!isNwcTotalLabel(label) || PEG_WORDS.test(label)) return false;
    const cells = [r.value, r.left, ...(Array.isArray(r.values) ? r.values : [])].map(s);
    return cells.some((c) => moneyFigures(c).some((f) => !allowed.some((k) => within(f.value, f.tolerance, k)) && !(wc.pegAmount && within(f.value, f.tolerance, wc.pegAmount))));
  };
  const sentences = (text: string) => {
    const parts = text.split(/(?<=[.!?])\s+(?=[A-Z$(])/);
    const bad = parts.filter((p) => failsAsProse(p));
    if (bad.length === 0) return text;
    removed.push(...bad.map((p) => p.trim()));
    return parts.filter((p) => !bad.includes(p)).join(" ");
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return sentences(v);
    if (Array.isArray(v)) {
      const kept = v.filter((e) => {
        if (!isRec(e)) return true;
        const text = sectionUnits({ sectionTitle: "", layoutType: "", layoutData: e }).join(" ");
        if (!rowFails(e) && !failsAsProse(text)) return true;
        removed.push(text.trim());
        return false;
      });
      // A bullet whose only sentence was taken out goes with it (an empty table cell stays).
      return kept.map((e) => [e, walk(e)] as const).filter(([e, w]) => !(typeof e === "string" && e.trim() && typeof w === "string" && !w.trim())).map(([, w]) => w);
    }
    if (!isRec(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SKIP.has(k) ? x : walk(x);
    return out;
  };
  const layoutData = walk(section.layoutData);
  const aiDraftContent = typeof section.aiDraftContent === "string" ? sentences(section.aiDraftContent) : section.aiDraftContent;
  return removed.length > 0 ? { layoutData, aiDraftContent, removed } : null;
}

// ── Debt by year ─────────────────────────────────────────────────────────

const DEBT_WORDS = /\b(?:debt|loans?|borrowings?|indebtedness|line\s+of\s+credit|operating\s+line|credit\s+(?:line|facility)|drawn|overdraft)\b/i;
/** A limit, a payment or a price — not a balance. */
const NOT_BALANCE = /\b(?:authori[sz]ed|limit|up\s+to|capacity|availability|available|facility\s+of|payments?|instal(?:l)?ments?|repay(?:ment|able)?s?|rent|lease|interest|premiums?|per\s+month|monthly|annually|a\s+year|capex|purchase|price|cost)\b/i;

interface DebtMatch { measure: string; year: string }

function debtMeasures(debt: CimDebt): Array<{ measure: string; values: Record<string, number> }> {
  return [
    { measure: "term debt", values: debt.termDebt },
    { measure: "current portion of term debt", values: debt.currentPortion },
    { measure: "operating-line draw", values: debt.bankIndebtedness },
  ];
}

function matchDebt(value: number, tol: number, debt: CimDebt): DebtMatch[] {
  const out: DebtMatch[] = [];
  for (const { measure, values } of debtMeasures(debt)) {
    for (const [year, v] of Object.entries(values)) if (v > 0 && within(value, tol, v)) out.push({ measure, year });
  }
  return out;
}

/** The latest year's figure for a measure ("$7,860,000", or "nil" for 0). */
function latestOf(debt: CimDebt, measure: string): { year: string; text: string } | null {
  const values = debtMeasures(debt).find((m) => m.measure === measure)?.values ?? {};
  const years = Object.keys(values).sort();
  const y = years[years.length - 1];
  if (!y) return null;
  return { year: y, text: values[y] === 0 ? "nil" : money(values[y]) };
}

interface DebtSlip { figure: string; isYear: string; statedYear: string | null; latest: { year: string; text: string } | null; measure: string }

/**
 * Debt figures tied to the wrong year: a balance that is year X's on the
 * balance sheet, stated for year Y (or undated where X isn't the latest).
 */
function debtSlips(text: string, debt: CimDebt): DebtSlip[] {
  const out: DebtSlip[] = [];
  const latestYear = debt.years[debt.years.length - 1];
  for (const clause of text.split(/;\s*|\.\s+(?=[A-Z])|\n/)) {
    if (!DEBT_WORDS.test(clause)) continue;
    const figs = moneyFigures(clause);
    // A clause's lone year speaks for an undated figure — unless it belongs to another figure ("Total $7,570,000 (2022: $6,950,000)").
    const own = figs.map((f) => yearOfFigure(clause, f.index, f.end));
    const clauseYears = yearsIn(clause);
    for (let i = 0; i < figs.length; i++) {
      const f = figs[i];
      const near = clause.slice(Math.max(0, f.index - 25), Math.min(clause.length, f.end + 15));
      if (NOT_BALANCE.test(near)) continue;
      const matches = matchDebt(f.value, f.tolerance, debt);
      if (matches.length === 0) continue;
      const free = clauseYears.filter((y) => !own.some((o, j) => j !== i && o === y));
      const stated = own[i] ?? (free.length === 1 && clauseYears.length === 1 ? free[0] : null);
      // Fine when the figure is that year's balance (any measure).
      if (stated ? matches.some((m) => m.year === stated) : matches.some((m) => m.year === latestYear)) continue;
      // Undated in a clause that names other years ("(2022: $6,950,000)"): only its own year counts.
      if (!stated && clauseYears.length > 1) continue;
      const m = matches[matches.length - 1];
      out.push({ figure: f.text, isYear: m.year, statedYear: stated, latest: latestOf(debt, m.measure), measure: m.measure });
    }
  }
  return out;
}

function describeSlip(d: DebtSlip): string {
  const now = d.latest && d.latest.year !== d.isYear ? `; at ${d.latest.year} year-end the ${d.measure} was ${d.latest.text}` : "";
  return d.statedYear
    ? `${d.figure} is the ${d.isYear} year-end ${d.measure}, not ${d.statedYear}'s${now}`
    : `${d.figure} is the ${d.isYear} year-end ${d.measure} — state it with its year${now}`;
}

export function debtProblems(section: SectionLike, debt: CimDebt | null | undefined): string[] {
  if (!debt) return [];
  const out: string[] = [];
  // Table rows: each cell's year is its column's.
  for (const r of tableRows(section.layoutType, section.layoutData)) {
    if (!DEBT_WORDS.test(r.label) || NOT_BALANCE.test(r.label)) continue;
    r.cells.forEach((c, i) => {
      const year = yearsIn(r.columns[i] ?? "")[0] ?? null;
      if (!year) return;
      for (const d of debtSlips(`${r.label} ${c} (${year})`, debt)) out.push(describeSlip(d));
    });
  }
  for (const u of sectionUnits(section, { skipTableRows: true })) for (const d of debtSlips(u, debt)) out.push(describeSlip(d));
  return Array.from(new Set(out));
}

// ── Counts behind a rate, in a section ───────────────────────────────────

export interface SuspectCount {
  value: number;
  /** The population noun ("inspections") and its stem ("inspe"). */
  noun: string;
  stem: string;
  source: string;
}

const stem5 = (w: string) => w.toLowerCase().replace(/s$/, "").slice(0, 5);

export function countRateProblems(section: SectionLike, suspects: SuspectCount[] = []): string[] {
  const units = sectionUnits(section);
  const out: string[] = [];
  // A rate stated as its own key figure ("CVSA Out-of-Service Rate: 9.4%")
  // applies to the counts in the other items; a rate inside prose only to
  // its own clause.
  const sectionRates = units.filter((u) => u.length <= 90).flatMap((u) => ratesIn(normRate(u)));
  for (const u of units) {
    for (const g of u.split(/\s·\s|;\s*|\n|\.\s+(?=[A-Z0-9])/).filter((x) => x.trim())) {
      const own = ratesIn(normRate(g));
      for (const m of mismatchesInGroup(g, own.length > 0 ? [] : sectionRates)) out.push(`the counts don't match the rate: ${describeMismatch(m)} — a figure is wrong; state the rate alone, never these counts`);
    }
    for (const sc of suspects) {
      const t = normRate(u);
      for (const f of parseFiguresAt(t)) {
        if (f.kind !== "plain" || f.value !== sc.value) continue;
        const words = t.slice(Math.max(0, f.index - 40), f.end + 40).match(/[a-z]{4,}/g) ?? [];
        if (words.some((w) => stem5(w) === sc.stem)) out.push(`"${f.text}" (${sc.noun}) comes from "${sc.source}", whose counts don't match its rates — leave the count out`);
      }
    }
  }
  return Array.from(new Set(out));
}

// ── Entry points ─────────────────────────────────────────────────────────

export interface ConsistencyKnowledge {
  workingCapital?: CimWorkingCapital | null;
  debt?: CimDebt | null;
  suspectCounts?: SuspectCount[];
}

export function consistencyKnowledge(fin: CimFinancials | null | undefined, suspectCounts: SuspectCount[] = []): ConsistencyKnowledge {
  return { workingCapital: fin?.workingCapital ?? null, debt: fin?.debt ?? null, suspectCounts };
}

/** Every consistency problem in a written section (empty = none). */
export function consistencyProblems(section: SectionLike, k: ConsistencyKnowledge | null | undefined): string[] {
  if (!k) return [];
  return Array.from(new Set([
    ...workingCapitalProblems(section, k.workingCapital),
    ...debtProblems(section, k.debt),
    ...countRateProblems(section, k.suspectCounts ?? []),
  ]));
}

export interface FactConsistency {
  /** Facts that can't be true as written: kept out of the writer's knowledge base. */
  held: string[];
  /** Words appended to a fact's line for the writer ("[… is the 2023 balance …]"). */
  notes: Record<string, string>;
  /** A fact's text as the writer gets it, when part of it was left out (misread counts). */
  rewrites: Record<string, string>;
  warnings: string[];
  suspectCounts: SuspectCount[];
}

const WC_FACT_KEY = /working\s*capital|\bnwc\b|^nwc/i;
const NOT_NWC_FACT = /peg|target|normali[sz]ed|required|requirement|need|swing|season|days|cycle|turn|ratio|policy|adjust|mechanism|method/i;

/**
 * Screen the facts before the writer sees them. `facts` are [key, value
 * text]; `label` turns a key into the name the broker sees.
 */
export function factConsistency(facts: Array<[string, string]>, fin: CimFinancials | null | undefined, label: (key: string) => string): FactConsistency {
  const held: string[] = [];
  const notes: Record<string, string> = {};
  const warnings: string[] = [];
  const suspectCounts: SuspectCount[] = [];
  const rewrites: Record<string, string> = {};
  const wc = fin?.workingCapital ?? null;

  // Working capital on another definition.
  const wcHeld: string[] = [];
  for (const [key, text] of facts) {
    const bare = key.replace(/([a-z])([A-Z])/g, "$1 $2");
    if (!WC_FACT_KEY.test(bare) || NOT_NWC_FACT.test(bare)) continue;
    const figs = moneyFigures(text);
    if (figs.length === 0) continue;
    const allInWording = ALL_IN_WORDS.test(text);
    if (wc) {
      const allowed = nwcValues(wc);
      const isAllIn = wc.allInNetWorkingCapital !== null && figs.some((f) => within(f.value, Math.max(f.tolerance, Math.abs(wc.allInNetWorkingCapital!) * 0.01), wc.allInNetWorkingCapital!));
      const headline = figs[0];
      const agrees = allowed.some((k) => within(headline.value, Math.max(headline.tolerance, Math.abs(k) * 0.01), k));
      if (isAllIn || (allInWording && !agrees)) {
        held.push(key);
        wcHeld.push(`"${label(key)}" (${headline.text})`);
      }
    } else if (allInWording) {
      notes[key] = "[total current assets less total current liabilities — cash and debt included: not the cash-free, debt-free figure a peg is compared with; never set it beside the peg or state a shortfall or excess from it]";
    }
  }
  if (wcHeld.length > 0 && wc) {
    warnings.push(
      `Left out of the CIM: ${wcHeld.join(", ")} ${wcHeld.length === 1 ? "is" : "are"} total current assets less total current liabilities, which counts cash and debt. The CIM states net working capital on the cash-free, debt-free basis the peg uses — ${money(wc.netWorkingCapital)}${wcWhere(wc)}, from the financial analysis. Correct or delete the fact on the Information tab.`,
    );
  }

  // Counts that don't give the rate stated with them: the counts are left
  // out and the rates kept (a whole fact held lost true rates with them).
  const bad: string[] = [];
  for (const [key, text] of facts) {
    if (held.includes(key)) continue;
    const { text: cleaned, mismatches } = stripMismatchedCounts(text);
    if (mismatches.length === 0) continue;
    if (cleaned) rewrites[key] = cleaned;
    else held.push(key);
    bad.push(`"${label(key)}" (${mismatches.map(describeMismatch).join("; ")})`);
    // The population is the distinctive, misread figure ("646 inspections");
    // small part counts (1, 5) would catch unrelated numbers elsewhere.
    for (const m of mismatches) suspectCounts.push({ value: m.total, noun: m.totalNoun, stem: stem5(m.totalNoun), source: label(key) });
  }
  // The same misread counts elsewhere ("Cvsa Inspections By Year: 2022: 589 ·
  // 2024: 646"): those entries go; a fact left with nothing is held.
  const population = suspectCounts.filter((sc, i) => suspectCounts.findIndex((o) => o.stem === sc.stem && o.value === sc.value) === i);
  if (suspectCounts.length > 0) {
    for (const [key, text] of facts) {
      if (held.includes(key) || rewrites[key]) continue;
      const keyWords = normRate(key.replace(/([a-z])([A-Z])/g, "$1 $2")).match(/[a-z]{4,}/g) ?? [];
      const pieces = text.split(GROUP_SPLIT);
      let dropped = 0;
      let groups = 0;
      for (let i = 0; i < pieces.length; i += 2) {
        if (!pieces[i].trim()) continue;
        groups++;
        const t = normRate(pieces[i]);
        const words = new Set([...keyWords, ...(t.match(/[a-z]{4,}/g) ?? [])].map(stem5));
        const values = parseFiguresAt(t).filter((f) => f.kind === "plain").map((f) => f.value);
        if (population.some((sc) => words.has(sc.stem) && values.includes(sc.value))) {
          pieces[i] = "";
          dropped++;
        }
      }
      if (dropped === 0) continue;
      if (dropped === groups) held.push(key);
      else {
        const out: string[] = [];
        for (let i = 0; i < pieces.length; i += 2) {
          if (!pieces[i].trim()) continue;
          if (out.length > 0) out.push(pieces[i - 1] ?? " · ");
          out.push(pieces[i]);
        }
        rewrites[key] = out.join("").trim();
      }
      bad.push(`"${label(key)}" (the same counts)`);
    }
    warnings.push(
      `Counts that don't add up were left out of the CIM (the rates stated with them are kept): ${bad.join("; ")}. A number was probably misread from a table in the source document — check it and correct the fact on the Information tab.`,
    );
  }

  // Debt figures that are another year's balance.
  const debt = fin?.debt ?? null;
  if (debt) {
    const slipped: string[] = [];
    for (const [key, text] of facts) {
      if (held.includes(key)) continue;
      const slips = debtSlips(`${label(key)}: ${text}`, debt).filter((d) => !d.statedYear);
      if (slips.length === 0) continue;
      const parts = Array.from(new Set(slips.map((d) => `${d.figure} is the ${d.isYear} year-end ${d.measure}${d.latest && d.latest.year !== d.isYear ? ` (${d.latest.year}: ${d.latest.text})` : ""}`)));
      notes[key] = `[balance sheet: ${parts.join("; ")} — state these with their year or use the latest year's figures from DEBT AT YEAR END]`;
      slipped.push(`"${label(key)}": ${parts.join("; ")}`);
    }
    if (slipped.length > 0) {
      warnings.push(
        `Debt figures on file are from an earlier year than the latest statements: ${slipped.join("; ")}. The CIM states debt with the year the balance sheet gives it. Update the fact on the Information tab if it should describe the latest year.`,
      );
    }
  }
  return { held, notes, rewrites, warnings, suspectCounts };
}

const COMPANION = /^\s*,?\s*(?:plus|\+|and|with)\s+(?:~\s*|about\s+|approximately\s+|roughly\s+|around\s+)?(\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|thousand|million)?)\s+(?:(?:in|of)\s+)?(legal|lawyers?'?|professional|consulting|advisory|accounting|severance|court)\s+(?:fees|costs|expenses|bills)\b/i;

/**
 * A cost the facts tie to an added-back one-time item that the add-backs
 * leave out: "settled 2024 for $55K plus ~$29K legal fees" beside a $55,000
 * settlement add-back (Pacific: the CIM's FY2024 one-time items were $127K,
 * the $29K of legal fees never added back). The CIM shows the add-backs as
 * the broker approved them; the broker is told, the figure never changed.
 */
export function addbackCompanions(facts: Array<[string, string]>, fin: CimFinancials | null | undefined, label: (key: string) => string): string[] {
  const bridge = fin?.bridge;
  if (!bridge) return [];
  const lines = [...bridge.addbacks, ...(bridge.sdeOnly ?? [])];
  const amounts = lines.flatMap((l) => Object.values(l.amounts)).filter((a) => Number.isFinite(a) && a !== 0);
  const close = (a: number, b: number) => Math.abs(Math.abs(a) - Math.abs(b)) <= Math.max(500, Math.abs(b) * 0.02);
  const out: string[] = [];
  for (const [key, text] of facts) {
    for (const f of moneyFigures(text)) {
      const m = COMPANION.exec(text.slice(f.end, f.end + 80));
      if (!m) continue;
      const companion = parseFiguresAt(m[1])[0];
      if (!companion || companion.value <= 0) continue;
      for (const line of lines) {
        const year = Object.keys(line.amounts).find((y) => line.amounts[y] > 0 && close(f.value, line.amounts[y]));
        if (!year) continue;
        const a = line.amounts[year];
        if (amounts.some((x) => close(companion.value, x) || close(a + companion.value, x))) continue;
        const kind = m[2].toLowerCase().replace(/s?'$|s$/, "");
        out.push(
          `"${label(key)}" ties ${m[1].trim()} of ${kind} costs to "${line.label}" (${money(a)} added back for ${year}); the add-backs don't include it. If it was expensed that year and won't recur, add it on the Financials tab — the CIM shows the add-backs as approved.`,
        );
      }
    }
  }
  return Array.from(new Set(out));
}
