/**
 * How a number or a label was counted, in one sentence:
 *   <Explain text="…">{child}</Explain>  a tooltip under a mouse, a small
 *                                         popover on a tap (phones have no hover)
 *   <InfoDot text="…" />                  an (i) button that does the same
 */
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Whether the device has a real hover (a mouse or trackpad). False on phones and during server rendering. */
export function useCanHover(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(hover: hover)");
    setCan(mq.matches);
    const on = (e: MediaQueryListEvent) => setCan(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return can;
}

export function Explain({ text, children, side = "top" }: { text: ReactNode; children: ReactElement; side?: "top" | "bottom" | "left" | "right" }) {
  const canHover = useCanHover();
  if (canHover) {
    return (
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} className="max-w-xs text-xs leading-relaxed">{text}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side={side} className="w-72 p-3 text-xs leading-relaxed">{text}</PopoverContent>
    </Popover>
  );
}

/** An (i) that explains how something is counted. */
export function InfoDot({ text, className, label = "How this is counted" }: { text: ReactNode; className?: string; label?: string }) {
  return (
    <Explain text={text}>
      <button
        type="button"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        className={cn("inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal", className)}
        data-testid="info-dot"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
    </Explain>
  );
}
