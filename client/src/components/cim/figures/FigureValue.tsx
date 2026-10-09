/**
 * FigureValue — a value in the CIM that has a note or (DD) a check.
 *
 * Wraps the value TEXT inside a cell (never the cell: block keys and the
 * reading tracker's attributes stay where they are). A figure with nothing
 * served renders exactly as before. Otherwise:
 *   - a dotted underline marks a note; in due diligence the check state
 *     comes first (✓ / ✓ⓘ / ⓘ tint / ? amber) — shape and words, never
 *     colour alone;
 *   - desktop: hover (200 ms) opens the popover, click pins it, Esc closes;
 *   - touch / narrow: tap opens a bottom sheet (FigureSheet);
 *   - opening it records `figure_note` (detail = the opaque figure id).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { FigureView } from "@shared/figure-layer";
import { NOTE_UNDERLINE } from "@shared/figure-states";
import { cn } from "@/lib/utils";
import { useCimInteraction } from "../blocks";
import { useFigureAt, useFigureLayer } from "./FigureLayerContext";
import { FigureBody } from "./FigureBody";
import { FigureSheet } from "./FigureSheet";
import { figureState, StateIcon } from "./figurePaint";

/** Touch device or a narrow screen: open a sheet, not a hover popover. */
export function useCoarse(): boolean {
  const get = () => typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches || window.innerWidth < 640);
  const [coarse, setCoarse] = useState(get);
  useEffect(() => {
    const on = () => setCoarse(get());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return coarse;
}

interface Props {
  /** The renderer's local block key ("row:3", "metric:0"). */
  block: string;
  cell?: number | null;
  children: ReactNode;
  className?: string;
  /** Show the DD state icon after the value (default true; the compare table draws its own). */
  showState?: boolean;
}

export function FigureValue({ block, cell = null, children, className, showState = true }: Props) {
  const fig = useFigureAt(block, cell);
  if (!fig) return <>{children}</>;
  return <FigureTrigger fig={fig} block={block} className={className} showState={showState}>{children}</FigureTrigger>;
}

/** The trigger + popover/sheet for a known figure (also used by the compare table and the check page). */
export function FigureTrigger({ fig, block, children, className, showState = true }: { fig: FigureView; block?: string; children: ReactNode; className?: string; showState?: boolean }) {
  const ctx = useFigureLayer();
  const interaction = useCimInteraction();
  const coarse = useCoarse();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recorded = useRef(false);
  const mode = ctx?.layer.mode ?? "normal";
  const state = mode === "dd" ? figureState(fig) : null;
  const hasNote = !!fig.why;
  // Broker preview: a fainter mark only where Cimple's analysis already suggests the reason (one click
  // to use it) — marking every figure with no reason underlined whole tables. Never shown to buyers.
  const needsReason = !hasNote && ctx?.layer.audience === "broker" && !!fig.noReason && !!fig.hint;

  const record = useCallback(() => {
    if (recorded.current) return;
    recorded.current = true;
    interaction("figure_note", block, fig.id.slice(0, 80));
  }, [interaction, block, fig.id]);

  const openNow = useCallback((pin: boolean) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
    if (pin) setPinned(true);
    record();
  }, [record]);

  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const trigger = (
    <span
      className={cn("inline-flex items-baseline gap-0.5", className)}
    >
      <span
        className="cursor-help"
        style={hasNote || needsReason ? { textDecorationLine: "underline", textDecorationStyle: "dotted", textDecorationColor: hasNote ? NOTE_UNDERLINE : "#D2CBBA", textUnderlineOffset: 3, textDecorationThickness: 1 } : undefined}
      >
        {children}
      </span>
      {showState && state && <StateIcon state={state} className="ml-0.5 self-center" />}
    </span>
  );

  const label = fig.label ? `${fig.label}, FY${fig.year}: ${fig.display}` : `FY${fig.year}: ${fig.display}`;

  if (coarse) {
    return (
      <>
        <button type="button" data-fig={fig.id} className="fig-trigger appearance-none border-0 bg-transparent p-0 text-inherit [font:inherit]" aria-haspopup="dialog" aria-label={`${label}. Open the note`} onClick={() => { setOpen(true); record(); }}>
          {trigger}
        </button>
        <FigureSheet open={open} onOpenChange={setOpen} title={label}>
          <FigureBody fig={fig} mode={mode} audience={ctx?.layer.audience ?? "buyer"} broker={ctx?.broker} buyer={ctx?.buyer} />
        </FigureSheet>
      </>
    );
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setPinned(false); }}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          data-fig={fig.id}
          className="fig-trigger appearance-none border-0 bg-transparent p-0 text-inherit [font:inherit] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#9E752E] rounded-sm"
          aria-label={`${label}. Show the note`}
          onPointerEnter={(e) => {
            if (e.pointerType !== "mouse") return;
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
            hoverTimer.current = setTimeout(() => openNow(false), 200);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType !== "mouse") return;
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
            if (!pinned) closeTimer.current = setTimeout(() => setOpen(false), 180);
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (open && pinned) { setOpen(false); setPinned(false); } else openNow(true);
          }}
        >
          {trigger}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="center"
          sideOffset={6}
          collisionPadding={12}
          className="cim-doc fig-popover z-50 w-[360px] max-w-[calc(100vw-24px)] rounded-lg border border-[#E3DED0] bg-[#FBF9F4] p-3 shadow-lg outline-none"
          onPointerEnter={() => { if (closeTimer.current) clearTimeout(closeTimer.current); }}
          onPointerLeave={() => { if (!pinned) closeTimer.current = setTimeout(() => setOpen(false), 180); }}
          onOpenAutoFocus={(e) => { if (!pinned) e.preventDefault(); }}
        >
          <FigureBody
            fig={fig}
            mode={mode}
            audience={ctx?.layer.audience ?? "buyer"}
            broker={ctx?.broker}
            buyer={ctx?.buyer}
            onClose={pinned ? () => { setOpen(false); setPinned(false); } : undefined}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
