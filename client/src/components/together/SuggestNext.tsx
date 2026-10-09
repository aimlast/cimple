/**
 * "✦ Suggest what to ask next" (D8 — free, no AI): up to three ideas from
 * the board — a follow-up on what the seller just said (once live filing
 * returns one), the best item on the current topic, the best critical item
 * not asked yet — each with its suggested question and "Show".
 */
import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { nextToAsk, type CoverageBoard, type NextToAskContext } from "@shared/coverage-board";

export function SuggestNext({
  board,
  ctx,
  onShow,
  size = "default",
  label = "Suggest what to ask next",
  inline,
}: {
  board: CoverageBoard;
  ctx?: NextToAskContext;
  onShow: (itemId: string, sectionKey?: string) => void;
  size?: "default" | "sm";
  label?: string;
  /** In the floating window: the ideas open in place (a popover would open in the main window). */
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ideas = useMemo(() => (open ? nextToAsk(board, ctx) : []), [open, board, ctx]);
  const list = (
    <ul className="divide-y divide-border">
      {ideas.map((s, i) => (
        <li key={`${s.kind}-${s.itemId ?? i}`} className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-teal/40 px-1.5 py-[1px] text-[10px] text-teal">{s.chip}</span>
            <span className="text-xs font-medium truncate">{s.label}</span>
            {s.itemId && (
              <button type="button" className="ml-auto text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2" onClick={() => { setOpen(false); onShow(s.itemId!, s.sectionKey); }}>
                Show
              </button>
            )}
          </div>
          <p className="mt-1 text-sm">“{s.ask}”</p>
        </li>
      ))}
    </ul>
  );
  if (inline) {
    return (
      <div data-testid="suggest-next-inline">
        <Button variant="outline" size="sm" className="w-full gap-1.5 h-8 text-xs border-teal/40 text-teal hover:bg-teal/10 hover:text-teal" onClick={() => setOpen((o) => !o)} data-testid="button-suggest-next">
          <Sparkles className="h-3.5 w-3.5" /> {open ? "Hide suggestions" : label}
        </Button>
        {open && (ideas.length === 0 ? <p className="px-1 pt-2 text-xs text-muted-foreground">Everything on the checklist is on file.</p> : <div className="mt-2 rounded-md border border-border">{list}</div>)}
      </div>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={`gap-1.5 ${size === "sm" ? "h-8 text-xs" : "w-full"} border-teal/40 text-teal hover:bg-teal/10 hover:text-teal`} data-testid="button-suggest-next">
          <Sparkles className="h-3.5 w-3.5" /> {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] max-w-[calc(100vw-2rem)] p-0" data-testid="suggest-next">
        <p className="px-3 pt-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">What to ask next</p>
        {ideas.length === 0 ? <p className="px-3 pb-3 text-xs text-muted-foreground">Everything on the checklist is on file.</p> : list}
      </PopoverContent>
    </Popover>
  );
}
