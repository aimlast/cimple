/**
 * cim-chart-values — the numbers inside CIM charts and comparison tables,
 * read the same way by the layout engine (when a section is saved) and by
 * the renderers (for sections saved before this existed).
 *
 * Why (2026-09-26, Pacific): the writer returned bar values as text
 * ("$13,560,000"); the chart read them with parseFloat, which gives NaN for
 * a leading "$", so every bar was 0 and the axis ran $0–$4. And a
 * comparison table packed three years into one cell ("589 → 711 → 646")
 * under a second "Metric" header, overflowing its column.
 *
 * Pure — no server or browser dependencies.
 */

type AnyRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is AnyRecord => !!v && typeof v === "object" && !Array.isArray(v);

const SUFFIX_SCALE: Record<string, number> = {
  k: 1e3, thousand: 1e3, thousands: 1e3,
  m: 1e6, mm: 1e6, mn: 1e6, million: 1e6, millions: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9, billions: 1e9,
};

/** What one unit of a chart's values is worth: 1e3 for "$K" / "$000s", 1e6 for "$M"; 1 otherwise. */
export function unitScale(unit: unknown): number {
  if (typeof unit !== "string") return 1;
  const m = unit.trim().match(/^(?:(?:c|us|ca)?\$|cad|usd|[€£¥])?\s*\(?\s*(k|thousands?|'?000'?s?|m|mm|millions?|b|bn|billions?)\s*\)?$/i);
  if (!m) return 1;
  const s = m[1].toLowerCase().replace(/'/g, "");
  if (s.startsWith("000") || s.startsWith("k") || s.startsWith("thousand")) return 1e3;
  if (s.startsWith("m")) return 1e6;
  return 1e9;
}

/**
 * A chart value as a number: 13560000, "$13,560,000", "C$6.21M", "-$78K",
 * "($78,000)", "22%", "4.6x", "1,250 CAD". With the chart's `unit` scale
 * ("$M"), a written suffix is converted into it ("$13.56M" → 13.56).
 * Null for anything that isn't ONE number — a series ("4 → 5 → 3"), a
 * range ("$1.1–1.2M"), words.
 */
export function parseChartNumber(v: unknown, scale = 1): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let t = v.trim().replace(/[−–—]/g, "-");
  if (!t) return null;
  let neg = false;
  const paren = t.match(/^\((.*)\)$/);
  if (paren) {
    neg = true;
    t = paren[1].trim();
  }
  const nums = t.match(/\d[\d,]*(?:\.\d+)?|\.\d+/g) || [];
  if (nums.length !== 1) return null;
  const at = t.indexOf(nums[0]);
  const before = t.slice(0, at);
  const after = t.slice(at + nums[0].length);
  // Before: a sign, "~", "approx.", a currency code or symbol.
  if (!/^\s*[~≈+-]?\s*(?:approx\.?|about|circa|ca\.)?\s*[+-]?\s*(?:(?:C|US|CA|A|NZ)\$|(?:CAD|USD|EUR|GBP|AUD)\s?\$?|[$€£¥])?\s*[+-]?\s*$/i.test(before)) return null;
  // After: a scale word, "%", "x", a currency code.
  const tail = after.match(/^\s*(k|thousands?|mm|mn|m|millions?|bn|b|billions?)?\.?\s*(%|x|×)?\s*(?:CAD|USD|EUR|GBP|AUD)?\s*$/i);
  if (!tail) return null;
  if (/-/.test(before)) neg = true;
  let n = Number(nums[0].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const suffix = (tail[1] || "").toLowerCase();
  if (suffix) n = (n * (SUFFIX_SCALE[suffix] ?? 1)) / scale;
  return neg ? -n : n;
}

/** Which unit a set of text values implies, when every one agrees: "$" or "%". */
function impliedUnit(raw: unknown[]): string | null {
  const texts = raw.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  if (texts.length === 0) return null;
  if (texts.every((t) => /%\s*$/.test(t.trim()))) return "%";
  if (texts.every((t) => /^\(?\s*[-−–]?\s*(?:C|US|CA)?\$/.test(t.trim()))) return /^\(?\s*[-−–]?\s*C\$/.test(texts[0].trim()) ? "C$" : "$";
  return null;
}

const SERIES_LAYOUTS = new Set(["bar_chart", "horizontal_bar_chart", "pie_chart", "donut_chart"]);

/**
 * A chart's data with every numeric-looking text value turned into a
 * number, and the unit filled in when the texts all said "$" or "%" and the
 * chart had none. Values that aren't one number are left as written. Two-
 * column sections are handled column by column. Anything else is returned
 * unchanged.
 */
export function normalizeChartValues(layoutType: string, data: unknown): AnyRecord {
  if (!isRecord(data)) return {};
  if (layoutType === "two_column") {
    const out: AnyRecord = { ...data };
    for (const side of ["left", "right"] as const) {
      const col = data[side];
      if (isRecord(col) && typeof col.layoutType === "string" && isRecord(col.content)) {
        out[side] = { ...col, content: normalizeChartValues(col.layoutType, col.content) };
      }
    }
    return out;
  }
  const scale = unitScale(data.unit);
  const num = (v: unknown) => (typeof v === "string" ? parseChartNumber(v, scale) ?? v : v);
  if (SERIES_LAYOUTS.has(layoutType) && Array.isArray(data.data)) {
    const rows = data.data as unknown[];
    const raw = rows.flatMap((r) => (isRecord(r) ? [r.value, r.secondaryValue] : []));
    const out: AnyRecord = {
      ...data,
      data: rows.map((r) => {
        if (!isRecord(r)) return r;
        const next: AnyRecord = { ...r, value: num(r.value) };
        if (r.secondaryValue != null) next.secondaryValue = num(r.secondaryValue);
        return next;
      }),
    };
    const unit = !data.unit ? impliedUnit(raw) : null;
    if (unit) out.unit = unit;
    return out;
  }
  if (layoutType === "line_chart" && Array.isArray(data.data) && Array.isArray(data.series)) {
    const keys = (data.series as unknown[]).map((s) => (isRecord(s) && typeof s.key === "string" ? s.key : "")).filter(Boolean);
    const rows = data.data as unknown[];
    const out: AnyRecord = {
      ...data,
      data: rows.map((r) => {
        if (!isRecord(r)) return r;
        const next: AnyRecord = { ...r };
        for (const k of keys) if (k in r) next[k] = num(r[k]);
        return next;
      }),
    };
    const unit = !data.unit ? impliedUnit(rows.flatMap((r) => (isRecord(r) ? keys.map((k) => r[k]) : []))) : null;
    if (unit) out.unit = unit;
    return out;
  }
  if (layoutType === "waterfall_chart" && Array.isArray(data.items)) {
    return { ...data, items: (data.items as unknown[]).map((it) => (isRecord(it) ? { ...it, value: num(it.value) } : it)) };
  }
  return data;
}

// ── Comparison tables ───────────────────────────────────────────────────

/** "2022 → 2023 → 2024", "589 -> 711 -> 646": the parts of a series packed into one cell. */
const ARROW = /\s*(?:→|->|⟶|➝|➔|=>)\s*/;
function seriesParts(v: unknown): string[] | null {
  if (typeof v !== "string") return null;
  const parts = v.split(ARROW).map((p) => p.trim());
  return parts.length >= 2 && parts.every(Boolean) ? parts : null;
}

/** Headers that only say "this is the label column". */
const LABEL_HEADER = /^(?:metric|metrics|measure|item|items|category|kpi|indicator|line item|)$/i;

export interface ComparisonTableView {
  /** The label column's header. */
  labelHeader: string;
  /** The value columns' headers. */
  columns: string[];
  rows: Array<{ label: string; note?: string; cells: string[]; highlight: boolean }>;
}

/**
 * How a comparison table should be drawn. The usual shape is label | left |
 * right. Two shapes the writer produced are repaired:
 *   - a series packed into one column ("2022 → 2023 → 2024" over
 *     "589 → 711 → 646") becomes one column per year;
 *   - a left column headed like the label column ("Metric") holds a
 *     description of the row, shown under the row's label — never a
 *     second "Metric" header.
 */
export function comparisonTableView(data: unknown): ComparisonTableView {
  const d = isRecord(data) ? data : {};
  const rawRows = (Array.isArray(d.rows) ? d.rows : []).filter(isRecord);
  const text = (v: unknown) => (v == null ? "" : String(v));
  const leftLabel = text(d.leftLabel).trim();
  const rightLabel = text(d.rightLabel).trim();
  const leftIsNote = LABEL_HEADER.test(leftLabel) && leftLabel !== "" && rawRows.some((r) => text(r.left).trim());
  const cols: Array<{ header: string; key: "left" | "right" }> = [];
  if (!leftIsNote) cols.push({ header: leftLabel || "Current", key: "left" });
  cols.push({ header: rightLabel || "Benchmark", key: "right" });

  const columns: string[] = [];
  const expand: number[] = []; // per source column: how many columns it becomes (1 = as is)
  for (const c of cols) {
    const headerParts = seriesParts(c.header);
    const cellParts = rawRows.map((r) => seriesParts(text(r[c.key])));
    const n = headerParts?.length ?? cellParts.find(Boolean)?.length ?? 0;
    const allSplit = n >= 2 && cellParts.every((p, i) => (p ? p.length === n : !text(rawRows[i][c.key]).trim()));
    if (allSplit) {
      columns.push(...(headerParts ?? Array.from({ length: n }, (_, i) => `${c.header} ${i + 1}`)));
      expand.push(n);
    } else {
      columns.push(c.header);
      expand.push(1);
    }
  }
  const rows = rawRows.map((r) => {
    const cells: string[] = [];
    cols.forEach((c, i) => {
      const v = text(r[c.key]);
      if (expand[i] > 1) cells.push(...(seriesParts(v) ?? Array.from({ length: expand[i] }, () => "")));
      else cells.push(v);
    });
    const note = leftIsNote ? text(r.left).trim() : "";
    return { label: text(r.label), ...(note ? { note } : {}), cells, highlight: !!r.highlight };
  });
  const labelHeader = leftIsNote ? leftLabel : LABEL_HEADER.test(text(d.labelHeader)) || !d.labelHeader ? "Metric" : text(d.labelHeader);
  return { labelHeader, columns, rows };
}

/** True when a comparison table packs a series into single cells (see comparisonTableView). */
export function comparisonPacksSeries(data: unknown): boolean {
  const d = isRecord(data) ? data : {};
  const rows = (Array.isArray(d.rows) ? d.rows : []).filter(isRecord);
  return ["left", "right"].some((k) => rows.length > 0 && rows.filter((r) => seriesParts(r[k])).length >= Math.ceil(rows.length / 2));
}

/**
 * A comparison table that packs a series into its cells, as the financial
 * table it should have been: one column per year, the row description
 * folded into the label ("Collision rate — per million km").
 */
export function comparisonAsFinancialTable(data: unknown): AnyRecord {
  const d = isRecord(data) ? data : {};
  const view = comparisonTableView(d);
  const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  return {
    ...(typeof d.title === "string" && d.title ? { title: d.title } : {}),
    headers: [view.labelHeader === "Metric" ? "" : view.labelHeader, ...view.columns],
    rows: view.rows.map((r) => ({
      label: r.note ? `${r.label} — ${lowerFirst(r.note)}` : r.label,
      values: r.cells,
      ...(r.highlight ? { bold: true } : {}),
    })),
  };
}

// ── Shares and totals a chart may print ─────────────────────────────────────

/** A unit saying the values are percentages ("%", "(%)", "% of revenue"). */
export function isPercentUnit(unit: unknown): boolean {
  return typeof unit === "string" && (/(?:^|[^\d.])%/.test(unit) || /^\s*per\s?cent/i.test(unit));
}

export interface ChartShares {
  /**
   * The share to print beside each value ("(43.7%)"), or null to print the
   * value alone. Only ever a share of a whole the chart itself states.
   */
  shares: number[] | null;
  /** The whole to print under the chart's totalLabel — a stated one only, never the sum of the slices. */
  total: number | null;
  /**
   * The values are percentages that aren't the parts of one whole (a top
   * customer's 22% beside the top five's 47%, or one 50% slice): a pie
   * would draw them as the full circle. Draw bars instead.
   */
  asBars: boolean;
}

/**
 * What a pie, donut or ranked-bar chart may print besides its values.
 *
 * The renderers printed every slice as "(x%)" of the sum of the slices and
 * a computed "Total" — false whenever the data is partial, which truth rule
 * 17 makes the normal case (Pacific: "largest customer 22%" and "top five
 * 47%" read as 31.9% and 68.1%; a single "50%" slice read "(100.0%)"; one
 * missing service line would have printed a false total revenue). Now:
 *   - values in % are shares already and are printed as they are; when
 *     they don't sum to about 100 they are not the parts of one whole
 *     → `asBars`;
 *   - other values get a share only of a `total` the chart states, and
 *     only when they add up to it (±1%, rounding);
 *   - the total printed is the stated one, never a sum.
 */
export function chartShares(values: number[], unit: unknown, statedTotal: unknown): ChartShares {
  const sum = values.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
  if (isPercentUnit(unit)) {
    const whole = values.length > 1 && Math.abs(sum - 100) <= 1.5;
    return { shares: null, total: null, asBars: !whole };
  }
  const total = parseChartNumber(statedTotal, unitScale(unit));
  if (total === null || !(total > 0)) return { shares: null, total: null, asBars: false };
  const addsUp = Math.abs(sum - total) <= total * 0.01;
  return { shares: addsUp ? values.map((v) => (v / total) * 100) : null, total, asBars: false };
}
