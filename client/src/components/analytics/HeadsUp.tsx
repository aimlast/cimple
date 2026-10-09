/**
 * The heads-up lines under the numbers (at most two, only when they apply):
 * a registered source's line first (the data room), then buyer links running
 * out within 7 days, then buyers who haven't opened 3 days after you gave
 * access. Each has "See them" → the Buyers tab filtered to exactly them.
 */
import { Link } from "wouter";
import { ChevronRight, Flag } from "lucide-react";
import { HEADS_UP_MAX, type HeadsUp as HeadsUpLine } from "@shared/analytics-dashboard";

/** The phone's short words for the built-in lines (the full sentence is the title). */
export function headsUpShort(h: HeadsUpLine): string {
  if (h.id === "expiring") return `${h.count} link${h.count === 1 ? " runs" : "s run"} out this week`;
  if (h.id === "not_opened") return `${h.count} haven't opened after 3 days`;
  return h.text;
}

export function HeadsUp({ lines }: { lines: HeadsUpLine[] }) {
  const shown = lines.slice(0, HEADS_UP_MAX);
  if (shown.length === 0) return null;
  return (
    <div className="space-y-1.5" data-testid="heads-up">
      {shown.map((h) => (
        <div key={h.id} className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
          <Flag className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <p className="min-w-0 flex-1 truncate text-foreground/90" title={h.text}>
            <span className="sm:hidden">{headsUpShort(h)}</span>
            <span className="hidden sm:inline">{h.text}</span>
          </p>
          <Link href={h.link} className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-teal hover:underline" data-testid={`heads-up-${h.id}`}>
            <span className="hidden sm:inline">See them</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      ))}
    </div>
  );
}
