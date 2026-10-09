/**
 * Figures in charts (spec §4.4): bar and line charts and the earnings bridge.
 *
 *   useChartFigure()           the figure at a chart point (`chart/point:i`,
 *                              series index for line/bar charts) — the same
 *                              anchors the reading tracker's points use;
 *   <FigureTooltipLine />      the line a Recharts tooltip gains: the note's
 *                              first sentence (DD: the check's state in words)
 *                              and "Click for more" / "Tap for more";
 *   <ChartFigurePopover />     opens the figure's popover (or the bottom sheet
 *                              on touch) at the point the reader clicked.
 *
 * Without a provider (print preview, heat map page canvas, teaser) these are
 * no-ops: the charts draw exactly as before.
 */
import { useCallback, useEffect, useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { FigureView } from "@shared/figure-layer";
import { STATE_WORDS } from "@shared/figure-states";
import { useCimInteraction } from "../blocks";
import { useFigureLayer, useFigureLookup } from "./FigureLayerContext";
import { FigureBody } from "./FigureBody";
import { FigureSheet } from "./FigureSheet";
import { useCoarse } from "./FigureValue";
import { FIGURE_POPOVER_FIT, figurePopoverPadding, figureState } from "./figurePaint";

/** The figure shown at chart point `index` (series `series`; null for single-value charts). */
export function useChartFigure(): (index: number | null | undefined, series?: number | null) => FigureView | null {
  const lookup = useFigureLookup();
  return useCallback((index, series = null) => {
    if (index == null || index < 0) return null;
    return lookup(`chart/point:${index}`, series ?? null);
  }, [lookup]);
}

/** The first sentence of a note ("Up 11% from FY2022, mostly …."). */
export function firstSentence(text: string): string {
  const m = text.match(/^(.+?[.!?])(?:\s|$)/);
  return (m ? m[1] : text).trim();
}

/** What a figure's tooltip line says, or null when it has nothing to say. */
export function tooltipLineFor(fig: FigureView | null | undefined, mode: "dd" | "normal" | "blind"): string | null {
  if (!fig) return null;
  if (fig.why?.text) return firstSentence(fig.why.text);
  if (mode === "dd") {
    const state = figureState(fig);
    if (state) return STATE_WORDS[state];
  }
  return null;
}

/** The note line inside a chart tooltip (paper colours; never in a chart without a provider). */
export function FigureTooltipLine({ fig }: { fig: FigureView | null | undefined }) {
  const ctx = useFigureLayer();
  const coarse = useCoarse();
  if (!ctx || !fig) return null;
  const line = tooltipLineFor(fig, ctx.layer.mode);
  if (!line) return null;
  return (
    <div className="mt-1.5 max-w-[260px] border-t pt-1.5 text-[11px] leading-snug" style={{ borderColor: "#E3DED0", color: "#46423B" }} data-fig-tooltip="">
      <span>{line}</span>
      <span className="ml-1 whitespace-nowrap" style={{ color: "#9E752E" }}>{coarse ? "Tap for more" : "Click for more"}</span>
    </div>
  );
}

export interface ChartPick { fig: FigureView; x: number; y: number }

/** Remember a clicked chart point that carries a figure (Recharts' onClick state). */
export function useChartPick(figAt: (index: number | null | undefined, series?: number | null) => FigureView | null) {
  const [pick, setPick] = useState<ChartPick | null>(null);
  const onChartClick = useCallback((state: any, series: number | null = null) => {
    const index = state?.activeTooltipIndex == null ? null : Number(state.activeTooltipIndex);
    const fig = figAt(index, series);
    if (!fig) return;
    setPick({ fig, x: Number(state?.chartX ?? 0), y: Number(state?.chartY ?? 0) });
  }, [figAt]);
  return { pick, setPick, onChartClick };
}

/**
 * The popover (desktop) or bottom sheet (touch) for a clicked chart point.
 * Rendered inside a `relative` box that wraps the chart; the popover hangs off
 * the point the reader clicked.
 */
export function ChartFigurePopover({ pick, onClose, block }: { pick: ChartPick | null; onClose: () => void; block?: string }) {
  const ctx = useFigureLayer();
  const coarse = useCoarse();
  const interaction = useCimInteraction();
  const openId = ctx && pick ? pick.fig.id : null;
  useEffect(() => {
    // Opening a note is a reading interaction (detail = the opaque figure id).
    if (openId) interaction("figure_note", block ?? "chart", openId.slice(0, 80));
  }, [openId, interaction, block]);
  if (!ctx || !pick) return null;
  const mode = ctx.layer.mode;
  const label = pick.fig.label ? `${pick.fig.label}, FY${pick.fig.year}: ${pick.fig.display}` : `FY${pick.fig.year}: ${pick.fig.display}`;
  if (coarse) {
    return (
      <FigureSheet open onOpenChange={(o) => { if (!o) onClose(); }} title={label}>
        <FigureBody fig={pick.fig} mode={mode} audience={ctx.layer.audience} broker={ctx.broker} buyer={ctx.buyer} />
      </FigureSheet>
    );
  }
  return (
    <PopoverPrimitive.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <PopoverPrimitive.Anchor asChild>
        <span aria-hidden className="pointer-events-none absolute h-px w-px" style={{ left: pick.x, top: pick.y }} />
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={figurePopoverPadding()}
          className={`cim-doc fig-popover z-50 w-[360px] max-w-[calc(100vw-24px)] rounded-lg border border-[#E3DED0] bg-[#FBF9F4] p-3 shadow-lg outline-none ${FIGURE_POPOVER_FIT}`}
          aria-label={label}
        >
          <FigureBody fig={pick.fig} mode={mode} audience={ctx.layer.audience} broker={ctx.broker} buyer={ctx.buyer} onClose={onClose} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
