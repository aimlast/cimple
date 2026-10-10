/**
 * figurePaint — how a check state looks on the theme-locked CIM paper
 * (shared/figure-states.ts STATE_PAINT: literal hexes). Every state has an
 * icon and words as well as a colour.
 */
import { Check, HelpCircle, Info } from "lucide-react";
import type { CSSProperties } from "react";
import { STATE_PAINT, STATE_WORDS, type CheckState } from "@shared/figure-states";
import type { FigureCheckView, FigureView } from "@shared/figure-layer";

const ORDER: Record<CheckState, number> = { ask: 3, explained: 2, regrouped: 1, match: 0 };

/** The state a figure shows: its worst served check (ask > explained > regrouped > match). */
export function figureState(fig: FigureView | null | undefined): CheckState | null {
  const checks = (fig?.checks ?? []).filter((c) => c.state);
  if (checks.length === 0) return null;
  return checks.reduce<CheckState>((w, c) => (ORDER[c.state] > ORDER[w] ? c.state : w), "match");
}

/** Cell style for a state (tint + left rule). */
export function stateCellStyle(state: CheckState | null): CSSProperties | undefined {
  if (!state) return undefined;
  const p = STATE_PAINT[state];
  if (!p.tint) return undefined;
  return { backgroundColor: p.tint, boxShadow: `inset ${p.ruleWidth}px 0 0 ${p.rule}` };
}

/** The small state icon (with its words for screen readers). */
export function StateIcon({ state, className = "" }: { state: CheckState; className?: string }) {
  const p = STATE_PAINT[state];
  const label = STATE_WORDS[state];
  const style = { color: p.ink };
  if (p.icon === "check") return <Check aria-label={label} role="img" className={`inline h-3 w-3 shrink-0 ${className}`} style={style} strokeWidth={3} />;
  if (p.icon === "check_info") {
    return (
      <span role="img" aria-label={label} className={`inline-flex items-center gap-px ${className}`} style={style}>
        <Check aria-hidden className="h-3 w-3" strokeWidth={3} />
        <Info aria-hidden className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (p.icon === "info") return <Info aria-label={label} role="img" className={`inline h-3 w-3 shrink-0 ${className}`} style={style} />;
  return <HelpCircle aria-label={label} role="img" className={`inline h-3 w-3 shrink-0 ${className}`} style={style} />;
}

/** The check a compare cell shows for a figure (the tax return / management accounts, never the as-issued line). */
export function otherRecordCheck(fig: FigureView | null | undefined): FigureCheckView | null {
  const checks = fig?.checks ?? [];
  return checks.find((c) => !c.kindLabel.startsWith("Financial statements")) ?? null;
}

/** The check that explains this CIM figure vs the statements as issued (✓ⓘ on the CIM cell). */
export function asIssuedCheck(fig: FigureView | null | undefined): FigureCheckView | null {
  return (fig?.checks ?? []).find((c) => c.kindLabel === "Financial statements as issued") ?? null;
}

/**
 * The other record's figure written the way the CIM cell beside it is
 * ("($268,000)" → "($301,000)", "$28,640,000" → "$28,640,000", "28,640,000"
 * → "28,640,000", "$28.6M" → "$28.6M") — one money format per table
 * (checker r1 F5). Falls back to the value as served.
 */
export function formatLike(cimText: string | null | undefined, value: string): string {
  const n = Number(String(value).replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n) || !/\d/.test(value)) return value;
  const t = String(cimText ?? "").trim();
  if (!/\d/.test(t)) return value;
  const paren = /^\(.*\)$/.test(t);
  const minus = /^[-−–]/.test(t);
  const prefix = (t.replace(/^[(\-−–\s]+/, "").match(/^(C\$|CA\$|US\$|\$)/i)?.[1]) ?? "";
  const abs = Math.abs(n);
  const scaled = t.match(/(\d[\d,]*(?:\.(\d+))?)\s*([KMB])\b/i);
  let body: string;
  if (scaled) {
    const unit = scaled[3].toUpperCase();
    const div = unit === "K" ? 1e3 : unit === "M" ? 1e6 : 1e9;
    body = `${(abs / div).toFixed(scaled[2]?.length ?? 0)}${scaled[3]}`;
  } else {
    const decimals = t.match(/\.(\d+)\)?\s*$/)?.[1]?.length ?? 0;
    body = abs.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  const text = `${prefix}${body}`;
  if (paren) return `(${text})`;
  if (minus || n < 0) return `−${text}`;
  return text;
}

/**
 * The popover's collision padding (checker r2 R2-6): it never opens under the
 * view room's sticky bars (the header and the section strip, both marked
 * [data-reading-chrome]) — it keeps below them, or flips below the figure,
 * and scrolls inside when even that is too tall. 12 px elsewhere.
 */
export function figurePopoverPadding(): { top: number; right: number; bottom: number; left: number } {
  let top = 12;
  if (typeof document !== "undefined") {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-reading-chrome]"))) {
      const r = el.getBoundingClientRect();
      // Only a bar pinned at the top of the window counts (a strip not shown yet has no height).
      if (r.height > 0 && r.top <= 1 + top && r.bottom > 0) top = Math.max(top, Math.ceil(r.bottom) + 8);
    }
  }
  return { top, right: 12, bottom: 12, left: 12 };
}

/** Classes that keep a figure popover inside the room Radix found for it (it scrolls, never clips its title). */
export const FIGURE_POPOVER_FIT = "max-h-[var(--radix-popover-content-available-height)] overflow-y-auto";
