/**
 * chartFormat — axis/tooltip number formatting and sizing shared by the CIM
 * chart renderers, so a 7-digit revenue axis reads "$2.2M" instead of being
 * clipped to ",200,000" in Recharts' default 60px axis column.
 */
import { useEffect, useState } from "react";

/**
 * How a chart's `unit` should be written. The AI uses "$", "CAD", "USD",
 * "currency", "$M" (values already in millions), "%", or a plain word.
 */
function unitKind(unit?: string): { prefix: string; suffix: string; scaledMillions: boolean } {
  const u = (unit || "").trim();
  if (!u) return { prefix: "", suffix: "", scaledMillions: false };
  if (/^%$|^percent/i.test(u)) return { prefix: "", suffix: "%", scaledMillions: false };
  if (/^(c?\$|cad|usd|currency|dollars?)\s*m(illions?)?$/i.test(u) || /^\$m$/i.test(u)) {
    return { prefix: /^c|cad/i.test(u) ? "C$" : "$", suffix: "M", scaledMillions: true };
  }
  if (/^(cad|c\$)$/i.test(u)) return { prefix: "C$", suffix: "", scaledMillions: false };
  if (/^(\$|usd|us\$|currency|dollars?)$/i.test(u)) return { prefix: "$", suffix: "", scaledMillions: false };
  if (/^[€£¥]$/.test(u)) return { prefix: u, suffix: "", scaledMillions: false };
  return { prefix: "", suffix: ` ${u}`, scaledMillions: false };
}

const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const fullFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Short axis tick: 2200000 → "$2.2M", 38000 → "$38K", 64 (unit "%") → "64%". */
export function formatAxisTick(v: unknown, unit?: string): string {
  const n = toNumber(v);
  if (n === null) return String(v ?? "");
  const k = unitKind(unit);
  const sign = n < 0 ? "-" : "";
  const body = k.scaledMillions ? fullFmt.format(Math.abs(n)) : compactFmt.format(Math.abs(n));
  // A plain-word unit ("patients") stays out of the tick; the axis caption names it.
  const suffix = k.suffix.startsWith(" ") ? "" : k.suffix;
  return `${sign}${k.prefix}${body}${suffix}`;
}

/** Full value for tooltips: 2013000 → "$2,013,000", 1.85 (unit "$M") → "$1.85M". */
export function formatFullValue(v: unknown, unit?: string): string {
  const n = toNumber(v);
  if (n === null) return String(v ?? "");
  const k = unitKind(unit);
  const sign = n < 0 ? "-" : "";
  return `${sign}${k.prefix}${fullFmt.format(Math.abs(n))}${k.suffix}`;
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
  // on some scales) — allow two extra characters (~7px each at 11px) plus the tick gap.
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
