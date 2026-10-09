/**
 * figure-anchors — where the CIM shows a figure (stream "dd", spec D3).
 *
 * Anchors are FOUND in each served section, never stored: a cell is tied to
 * a figure only when its row label maps to a line AND its value equals that
 * line's figure for the year (to the precision shown). There are no
 * value-only matches, so a round figure repeated under another label never
 * picks up the wrong note; a cell that matches nothing gets no note.
 *
 * Block keys are the reading tracker's (shared/cim-blocks.ts): `row:i`,
 * `metric:i`, `primary`, `stat:i`, `chart/point:i`; inside a two-column
 * section they carry the `left/` / `right/` prefix. A financial table's
 * Normalized rows (`nrow:i`) are never anchored, and nothing is anchored in
 * an indexed line chart (its values are an index, not figures).
 *
 * Pure: the server (layer, checks, notes) and the browser use it.
 */
import { normalizeFinancialTable } from "./financial-table";
import { comparisonTableView } from "./cim-chart-values";
import { resolveTwoColumnColumn } from "./cim-layouts";
import { fiscalYearKey } from "./fiscal-year";
import { AS_ISSUED, cleanRowLabel, figureKey, lineForLabel, lineSlug, standardLine, type LineId } from "./figure-lines";

/** A figure the registry knows: the CIM's value for a line in a year. */
export interface RegistryFigure {
  key: string;
  line: LineId;
  /** The line's label ("Operating expenses", "Facility rent — warehouse"). */
  lineLabel: string;
  year: string;
  value: number;
  /** A total with components (D7). */
  total: boolean;
  /** Components: figure keys with the sign they add to this total (an expense line in a profit total is −1). */
  components?: Array<{ key: string; sign: 1 | -1 }>;
  /** The analysis category of an analysis line ("Operating Expenses", "COGS"…). */
  category?: string;
  /** Compare as absolute amounts (expenses). */
  expense: boolean;
  /**
   * A standard line's figure as that year's financial statements print it,
   * when they state the line at all (equal or not) — D9a's derived holds read
   * it: a derived total the statements state and agree with is never held.
   */
  statementsValue?: number;
}

export type FigureRegistry = Record<string, RegistryFigure>;

export interface Anchor {
  pageId: string;
  /** Block key including any two-column prefix ("row:3", "left/metric:0", "chart/point:2"). */
  block: string;
  /** Value column (table) or series (chart); null for single-value blocks. */
  cell: number | null;
  figureKey: string;
  /** The value as printed. */
  shown: number;
  display: string;
}

interface SectionLike {
  id: string;
  layoutType: string;
  layoutData: unknown;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

// ── Reading a printed amount ─────────────────────────────────────────────

export interface ShownAmount {
  value: number;
  /** Half the unit of the last digit shown ("$31.0M" → 50,000), at least 1. */
  tolerance: number;
}

const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

/**
 * A printed amount → its value and precision: "$28,640,000", "(155,000)",
 * "$31.0M", "$8.6 million", "−$4,200". Percentages, multiples, ranges and
 * text are null. A number (chart datum) is exact.
 */
export function parseShownAmount(v: unknown, unitScale = 1): ShownAmount | null {
  if (typeof v === "number") return Number.isFinite(v) ? { value: v * unitScale, tolerance: Math.max(1, unitScale / 2) } : null;
  let t = str(v).replace(/\*\*|\[\[\/?dd\]\]/g, "").trim();
  if (!t || t.length > 32) return null;
  if (/%|[x×]\s*$|\bper\b|\/|–|—|\bto\b|~/i.test(t) || /\d\s*-\s*\$?\d/.test(t)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(t)) { negative = true; t = t.slice(1, -1).trim(); }
  if (/^[-−–]/.test(t)) { negative = true; t = t.replace(/^[-−–]\s*/, ""); }
  t = t.replace(/^(?:c\$|us\$|ca\$|cad|usd)\s*/i, "").replace(/^\$\s*/, "").replace(/\s*(?:cad|usd)$/i, "");
  if (/^\(.*\)$/.test(t)) { negative = true; t = t.slice(1, -1).trim(); }
  const m = t.match(/^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*([a-z]+)?$/i);
  if (!m) return null;
  const suffix = (m[3] ?? "").toLowerCase();
  const scale = suffix ? SCALE[suffix] : unitScale;
  if (!scale) return null;
  const decimals = m[2] ?? "";
  const value = Number(`${m[1].replace(/,/g, "")}${decimals ? `.${decimals}` : ""}`) * scale;
  if (!Number.isFinite(value)) return null;
  const unit = scale / 10 ** decimals.length;
  return { value: negative ? -value : value, tolerance: Math.max(1, unit / 2) };
}

function matches(shown: ShownAmount, fig: RegistryFigure): boolean {
  const a = fig.expense ? Math.abs(shown.value) : shown.value;
  const b = fig.expense ? Math.abs(fig.value) : fig.value;
  return Math.abs(a - b) <= shown.tolerance;
}

// ── Labels → lines ───────────────────────────────────────────────────────

const YEAR_TOKEN = /\b(?:fy|fye)?\s*'?(?:19|20)\d{2}(?:\s*[/-]\s*\d{2,4})?\b|\bfy\s*'?\d{2}\b/gi;

/** A label's year ("FY2024 Revenue" → "2024"), if it names exactly one. */
export function yearInText(text: unknown): string | null {
  const found = new Set<string>();
  for (const m of Array.from(str(text).matchAll(YEAR_TOKEN))) {
    const y = fiscalYearKey(m[0].trim());
    if (y) found.add(y);
  }
  return found.size === 1 ? Array.from(found)[0] : null;
}

/** The label without its year and the words that only say "for the year". */
function labelWithoutYear(label: unknown): string {
  return cleanRowLabel(str(label).replace(/\*\*|\[\[\/?dd\]\]/g, ""))
    .replace(YEAR_TOKEN, " ")
    .replace(/\b(?:annual|yearly|for the year|latest|last year|this year)\b/gi, (w) => (/^annual$/i.test(w) ? w : " "))
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The registry lines a row label can mean: a standard line, or an analysis line with the same name. */
function linesForLabel(label: unknown, lineIndex: Map<string, LineId>): LineId[] {
  const clean = labelWithoutYear(label);
  if (!clean) return [];
  const out: LineId[] = [];
  const std = lineForLabel(clean);
  if (std) out.push(std);
  const atomic = lineIndex.get(lineSlug(clean));
  if (atomic && !out.includes(atomic)) out.push(atomic);
  return out;
}

function registryLineIndex(registry: FigureRegistry): Map<string, LineId> {
  const out = new Map<string, LineId>();
  for (const f of Object.values(registry)) if (f.line.startsWith("line:")) out.set(f.line, f.line);
  return out;
}

function yearsOf(registry: FigureRegistry, line: LineId): string[] {
  return Object.values(registry).filter((f) => f.line === line).map((f) => f.year).sort();
}

function find(registry: FigureRegistry, lines: LineId[], year: string | null, shown: ShownAmount, fallbackLatest: boolean): RegistryFigure | null {
  // A standard line also matches its statements-as-issued variant (a table copied from the statements).
  const expanded: LineId[] = lines.flatMap((l) => (standardLine(l) ? [l, `${l}${AS_ISSUED}` as LineId] : [l]));
  for (const line of expanded) {
    if (year) {
      const f = registry[figureKey(line, year)];
      if (f && matches(shown, f)) return f;
      continue;
    }
    if (!fallbackLatest) continue;
    // No year printed: only the latest year can be meant (a key-number card), and only on an exact match.
    const ys = yearsOf(registry, line);
    const latest = ys[ys.length - 1];
    const f = latest ? registry[figureKey(line, latest)] : undefined;
    if (f && matches(shown, f)) return f;
  }
  return null;
}

// ── Per layout ───────────────────────────────────────────────────────────

/** Every figure the section shows that the registry knows (label and value both match). */
export function anchorFigures(section: SectionLike, registry: FigureRegistry): Anchor[] {
  if (!section || !isRec(section.layoutData) || Object.keys(registry).length === 0) return [];
  const idx = registryLineIndex(registry);
  return anchorsIn(section.id, section.layoutType, section.layoutData, registry, idx, "");
}

function anchorsIn(pageId: string, layoutType: string, data: Rec, registry: FigureRegistry, idx: Map<string, LineId>, prefix: string): Anchor[] {
  const key = (k: string) => (prefix ? `${prefix}/${k}` : k);
  const out: Anchor[] = [];
  const push = (block: string, cell: number | null, f: RegistryFigure, shown: ShownAmount, display: string) =>
    out.push({ pageId, block: key(block), cell, figureKey: f.key, shown: shown.value, display });
  const contextYear = yearInText(`${str(data.title)} ${str(data.caption)} ${str(data.subtitle)} ${str(data.year)}`);

  switch (layoutType) {
    case "financial_table": {
      const table = normalizeFinancialTable(data as { headers?: unknown; rows?: unknown });
      const years = table.columns.map((c) => fiscalYearKey(c));
      table.rows.forEach((row, i) => {
        if (row.isSectionHeader) return;
        const lines = linesForLabel(row.label, idx);
        if (lines.length === 0) return;
        row.cells.forEach((cell, j) => {
          const y = years[j];
          if (!y || cell === null) return;
          const shown = parseShownAmount(cell);
          if (!shown || shown.value === 0) return;
          const f = find(registry, lines, y, shown, false);
          if (f) push(`row:${i}`, j, f, shown, cell);
        });
      });
      break;
    }
    case "comparison_table": {
      const view = comparisonTableView(data);
      const years = view.columns.map((c) => fiscalYearKey(c));
      view.rows.forEach((row, i) => {
        const lines = linesForLabel(row.label, idx);
        if (lines.length === 0) return;
        row.cells.forEach((cell, j) => {
          const y = years[j];
          if (!y) return;
          const shown = parseShownAmount(cell);
          if (!shown || shown.value === 0) return;
          const f = find(registry, lines, y, shown, false);
          if (f) push(`row:${i}`, j, f, shown, cell);
        });
      });
      break;
    }
    case "metric_grid": {
      const metrics = Array.isArray(data.metrics) ? data.metrics : [];
      metrics.forEach((m, i) => {
        if (!isRec(m)) return;
        const lines = linesForLabel(m.label, idx);
        if (lines.length === 0) return;
        const shown = parseShownAmount(m.value);
        if (!shown || shown.value === 0) return;
        const y = yearInText(m.label) ?? yearInText(`${str(m.footnote)} ${str(m.subtext)} ${str(m.sublabel)} ${str(m.period)}`) ?? contextYear;
        const f = find(registry, lines, y, shown, !y);
        if (f) push(`metric:${i}`, null, f, shown, str(m.value));
      });
      break;
    }
    case "stat_callout": {
      const tryOne = (block: string, label: unknown, value: unknown, extra: unknown) => {
        const lines = linesForLabel(label, idx);
        if (lines.length === 0) return;
        const shown = parseShownAmount(value);
        if (!shown || shown.value === 0) return;
        const y = yearInText(label) ?? yearInText(extra) ?? contextYear;
        const f = find(registry, lines, y, shown, !y);
        if (f) push(block, null, f, shown, str(value));
      };
      tryOne("primary", data.primaryLabel, data.primaryValue, `${str(data.primaryContext)} ${str(data.context)}`);
      const stats = Array.isArray(data.secondaryStats) ? data.secondaryStats : [];
      stats.forEach((s, i) => { if (isRec(s)) tryOne(`stat:${i}`, s.label, s.value, s.context); });
      break;
    }
    case "line_chart":
    case "bar_chart": {
      if (data.indexed === true) break;
      const points = Array.isArray(data.data) ? data.data : [];
      const unitScale = scaleOfUnit(data.unit);
      if (unitScale === null) break;
      const series: Array<{ key: string; label: string }> = Array.isArray(data.series)
        ? (data.series as unknown[]).filter(isRec).map((s) => ({ key: str(s.key), label: str(s.label ?? s.key) }))
        : [{ key: "value", label: str(data.yLabel ?? data.valueLabel ?? data.title) }];
      points.forEach((p, i) => {
        if (!isRec(p)) return;
        const y = fiscalYearKey(p.name) ?? yearInText(p.name);
        if (!y) return;
        series.forEach((s, k) => {
          const lines = linesForLabel(s.label, idx).concat(linesForLabel(data.yLabel, idx));
          if (lines.length === 0) return;
          const shown = parseShownAmount(p[s.key], unitScale);
          if (!shown || shown.value === 0) return;
          const f = find(registry, Array.from(new Set(lines)), y, shown, false);
          if (f) push(`chart/point:${i}`, k, f, shown, str(p[s.key]));
        });
      });
      break;
    }
    case "waterfall_chart": {
      const items = Array.isArray(data.items) ? data.items : [];
      items.forEach((it, i) => {
        if (!isRec(it)) return;
        const lines = linesForLabel(it.label, idx).filter((l) => standardLine(l));
        if (lines.length === 0) return;
        const shown = parseShownAmount(it.value);
        if (!shown || shown.value === 0) return;
        const y = yearInText(it.label) ?? contextYear;
        const f = find(registry, lines, y, shown, !y);
        if (f) push(`chart/point:${i}`, null, f, shown, str(it.value));
      });
      break;
    }
    case "two_column": {
      for (const side of ["left", "right"] as const) {
        const col = resolveTwoColumnColumn(data[side]);
        if (!col || !isRec(col.content)) continue;
        out.push(...anchorsIn(pageId, col.layoutType, col.content, registry, idx, prefix ? `${prefix}/${side}` : side));
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/** A chart's unit → the scale of its numbers ("$M" → 1e6); null for a unit that isn't money ("%", "members"). */
export function scaleOfUnit(unit: unknown): number | null {
  const u = str(unit).trim().toLowerCase();
  if (!u || u === "$" || u === "cad" || u === "usd" || u === "$ cad" || u === "dollars") return 1;
  if (/%|percent|members|units|customers|people|staff|beds|patients|visits|x$/.test(u)) return null;
  if (/^\$?\s*(?:k|000s?|thousands?)$/.test(u)) return 1e3;
  if (/^\$?\s*(?:m|mm|mn|millions?)$/.test(u)) return 1e6;
  if (/^\$?\s*(?:b|bn|billions?)$/.test(u)) return 1e9;
  return null;
}

// ── gl contract: earnings-bridge rows tied to a general-ledger line ───────

/** One add-back of the CIM's bridge, as gl ties it to a ledger line (gl §8.1.5). */
export interface GlBridgeLine {
  lineId: string;
  label: string;
  /** Fiscal year → amount added back. */
  amounts: Record<string, number>;
}

const glWords = (t: string): string[] =>
  t.toLowerCase().replace(/\[\[\/?dd\]\]/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(?:and|the|for|add|back|addback|adjustment|normali[sz]ation|fy\d+|\d+)$/.test(w));

/** The bridge line a row is: its amount equals one of the line's (to the precision shown) and its label shares the line's words. */
function glLineFor(label: unknown, value: unknown, lines: GlBridgeLine[], unit: number): string | null {
  const shown = parseShownAmount(value, unit);
  if (!shown || shown.value === 0) return null;
  const rowWords = new Set(glWords(str(label)));
  if (rowWords.size === 0) return null;
  let best: { id: string; score: number } | null = null;
  for (const l of lines) {
    const amountOk = Object.values(l.amounts).some((a) => Math.abs(Math.abs(a) - Math.abs(shown.value)) <= shown.tolerance);
    if (!amountOk) continue;
    const lw = glWords(l.label);
    if (lw.length === 0) continue;
    const shared = lw.filter((w) => rowWords.has(w)).length;
    // Most of the line's own words, or every one of a short label.
    const score = shared / lw.length;
    if (shared === 0 || score < 0.5) continue;
    if (!best || score > best.score) best = { id: l.lineId, score };
  }
  return best?.id ?? null;
}

/**
 * Earnings-bridge rows (waterfall items, also inside a two-column page) that
 * are a general-ledger add-back line — where gl's "Found in the books" mark
 * goes (`<GlMark lineId variant="row" />`). Label AND amount must agree, like
 * every anchor (D3); nothing is guessed.
 */
export function glBridgeMarks(section: SectionLike, lines: GlBridgeLine[]): Array<{ pageId: string; block: string; lineId: string }> {
  if (!section || !isRec(section.layoutData) || lines.length === 0) return [];
  const out: Array<{ pageId: string; block: string; lineId: string }> = [];
  const visit = (layoutType: string, data: Rec, prefix: string) => {
    if (layoutType === "waterfall_chart") {
      const unit = scaleOfUnit(data.unit) ?? 1;
      const items = Array.isArray(data.items) ? data.items : [];
      items.forEach((it, i) => {
        if (!isRec(it) || it.type === "start" || it.type === "total") return;
        const id = glLineFor(it.label, it.value, lines, unit);
        if (id) out.push({ pageId: section.id, block: prefix ? `${prefix}/chart/point:${i}` : `chart/point:${i}`, lineId: id });
      });
    } else if (layoutType === "two_column" && !prefix) {
      for (const side of ["left", "right"] as const) {
        const col = resolveTwoColumnColumn(data[side]);
        if (col && isRec(col.content)) visit(col.layoutType, col.content, side);
      }
    }
  };
  visit(section.layoutType, section.layoutData, "");
  return out;
}
