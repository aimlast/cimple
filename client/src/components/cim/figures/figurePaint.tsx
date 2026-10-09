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
