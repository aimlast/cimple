/**
 * chartFormat — axis/tooltip number formatting and sizing shared by the CIM
 * chart renderers, so a 7-digit revenue axis reads "$2.2M" instead of being
 * clipped to ",200,000" in Recharts' default 60px axis column.
 */
import { useEffect, useState } from "react";

interface UnitKind {
  /** Currency symbol written before the number ("$", "C$", "€"). */
  prefix: string;
  /** Suffix on a short axis tick ("%"; a plain word stays in the axis caption). */
  tickSuffix: string;
  /** Suffix on a full tooltip value ("%", "% of Revenue", " patients"). */
  fullSuffix: string;
  /**
   * What one unit of the raw value is worth: 1000 when the figures are already
   * in thousands ("$K", "$000s"), 1e6 for millions ("$M"). 1 for plain values.
   */
  scale: number;
}

const CURRENCY = String.raw`(?:c\$|us\$|\$|cad|usd|currency|dollars?|[€£¥])`;
const THOUSANDS = String.raw`(?:k|thousands?|'?000'?s?)`;
const MILLIONS = String.raw`(?:m|mm|millions?)`;
const BILLIONS = String.raw`(?:b|bn|billions?)`;

function currencyPrefix(u: string): string {
  if (/^\s*(c\$|cad)/i.test(u)) return "C$";
  const sym = u.match(/[€£¥]/);
  if (sym) return sym[0];
  if (new RegExp(`^\\s*${CURRENCY}`, "i").test(u)) return "$";
  return "";
}

/**
 * How a chart's `unit` should be written. The AI uses "$", "CAD", "USD",
 * "currency", "$M" / "$K" / "$000s" (values already in millions/thousands),
 * "%", "% of Revenue", or a plain word ("patients").
 */
function unitKind(unit?: string): UnitKind {
  const u = (unit || "").trim();
  const plain: UnitKind = { prefix: "", tickSuffix: "", fullSuffix: "", scale: 1 };
  if (!u) return plain;
  if (/^%/.test(u)) return { ...plain, tickSuffix: "%", fullSuffix: u };
  if (/^percent(age)?$/i.test(u)) return { ...plain, tickSuffix: "%", fullSuffix: "%" };
  // Scaled money or counts: "$K", "CAD 000s", "$ (000s)", "thousands", "$M", "USD millions", "$B".
  const scaled = (re: string) =>
    new RegExp(`^(?:${CURRENCY}\\s*)?\\(?\\s*${re}\\s*\\)?$`, "i").test(u);
  if (scaled(THOUSANDS)) return { ...plain, prefix: currencyPrefix(u), scale: 1e3 };
  if (scaled(MILLIONS)) return { ...plain, prefix: currencyPrefix(u), scale: 1e6 };
  if (scaled(BILLIONS)) return { ...plain, prefix: currencyPrefix(u), scale: 1e9 };
  if (new RegExp(`^${CURRENCY}$`, "i").test(u)) return { ...plain, prefix: currencyPrefix(u) };
  return { ...plain, fullSuffix: ` ${u}` };
}

const COMPACT_STEPS: Array<[number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];

/** Fewest decimals (at most `max`) that write `x` exactly; `max` when none does. */
function decimalsFor(x: number, max: number): number {
  for (let d = 0; d < max; d++) {
    if (Math.abs(Number(x.toFixed(d)) - x) <= Math.abs(x) * 1e-9) return d;
  }
  return max;
}

function fmt(x: number, decimals: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals }).format(x);
}

/**
 * Short form that never misstates a round number: 1650000 → "1.65M" (not
 * "1.7M"), 2000000 → "2M", 38000 → "38K". At most `maxDecimals` decimals.
 */
function compact(abs: number, maxDecimals: number): string {
  for (let i = 0; i < COMPACT_STEPS.length; i++) {
    const [div, letter] = COMPACT_STEPS[i];
    if (abs < div) continue;
    const scaled = abs / div;
    const d = decimalsFor(scaled, maxDecimals);
    // 999,999 rounded would read "1000K"; step up a unit instead.
    if (Number(scaled.toFixed(d)) >= 1000 && i > 0) {
      const [upDiv, upLetter] = COMPACT_STEPS[i - 1];
      const up = abs / upDiv;
      return `${fmt(up, decimalsFor(up, maxDecimals))}${upLetter}`;
    }
    return `${fmt(scaled, d)}${letter}`;
  }
  return fmt(abs, decimalsFor(abs, Math.max(2, maxDecimals)));
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Short axis tick: 2200000 → "$2.2M", 1650000 → "$1.65M", 38000 → "$38K",
 * 64 (unit "%") → "64%", 4640 (unit "$K") → "$4.64M".
 * Axis ticks are "nice" numbers, so three decimals always write them exactly.
 */
export function formatAxisTick(v: unknown, unit?: string): string {
  const n = toNumber(v);
  if (n === null) return String(v ?? "");
  const k = unitKind(unit);
  const sign = n < 0 ? "-" : "";
  return `${sign}${k.prefix}${compact(Math.abs(n) * k.scale, 3)}${k.tickSuffix}`;
}

/**
 * Full value for tooltips: 2013000 → "$2,013,000", 1.85 (unit "$M") → "$1.85M",
 * 4640 (unit "$K") → "$4.64M", 22.2 (unit "% of Revenue") → "22.2% of Revenue".
 * Figures given in thousands or millions stay in that precision (no invented digits).
 */
export function formatFullValue(v: unknown, unit?: string): string {
  const n = toNumber(v);
  if (n === null) return String(v ?? "");
  const k = unitKind(unit);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const body = k.scale === 1 ? fmt(abs, 2) : compact(abs * k.scale, 3);
  return `${sign}${k.prefix}${body}${k.fullSuffix}`;
}

/**
 * A long plain figure shortened for a narrow card: "$31,020,000" → "$31.02M",
 * "C$6,212,400" → "C$6.21M", "1,250,000" → "1.25M" (at most two decimals).
 * Anything that isn't a single plain number — ranges, "350+", "12.8%",
 * words, figures under 10,000 — comes back unchanged.
 */
export function compactFigure(value: string): string {
  const m = value.trim().match(/^(-)?((?:[A-Z]{1,3}\s?)?[$€£¥])?\s?(\d{1,3}(?:,\d{3})+|\d{5,})(\.\d+)?$/);
  if (!m) return value;
  const n = Number(`${m[3].replace(/,/g, "")}${m[4] ?? ""}`);
  if (!Number.isFinite(n) || n < 10_000) return value;
  return `${m[1] ?? ""}${(m[2] ?? "").replace(/\s/g, "")}${compact(n, 2)}`;
}

/** YAxis width that fits the longest formatted tick (11px tick font). */
export function axisWidthFor(values: unknown[], unit?: string): number {
  let longest = 1;
  for (const v of values) {
    const n = toNumber(v);
    if (n === null) continue;
    longest = Math.max(longest, formatAxisTick(n, unit).length);
  }
  // Recharts rounds the domain to "nice" ticks ("$2.5M" above a "$2M" max, "C$2.25M"
  // on some scales), so allow two extra characters (~7px each at 11px) plus the tick gap.
  return Math.min(104, Math.max(48, (longest + 2) * 7 + 8));
}

/** Width of an element (callback ref), kept current as it resizes; 0 until measured. */
export function useElementWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return { ref: setEl, width };
}
