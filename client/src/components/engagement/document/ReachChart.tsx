/**
 * "How far buyers got" — one column per page, its height the number of buyers
 * whose furthest page is at or beyond it (a step down = buyers who stopped
 * there). The headline names the steepest drop in words; a marker sits on it.
 * Clicking a column opens that page. Direct labels (start and end counts), no
 * legend, one hue. Replaces the old scroll "Drop-off" tab, which counted
 * scroll events, not buyers. Compact: the sentence sits beside the chart on
 * wide screens so the CIM page stays high on the screen.
 */
import type { ReachPoint } from "@shared/analytics-v2";
import { cn } from "@/lib/utils";
import { reachFallback, steepestDrop } from "./viewer-model";

export function ReachChart({
  reach, headline, openedBy, selectedIndex, onOpen, compact = false,
}: {
  reach: ReachPoint[];
  headline: string | null;
  openedBy: number;
  selectedIndex: number;
  onOpen(index: number): void;
  compact?: boolean;
}) {
  if (reach.length === 0 || openedBy === 0) return null;
  const max = Math.max(openedBy, ...reach.map((r) => r.buyers), 1);
  const drop = steepestDrop(reach);
  const first = reach[0];
  const last = reach[reach.length - 1];
  const H = compact ? 36 : 44;
  const sentence = headline ?? reachFallback(reach, openedBy);
  const showEvery = reach.length > 30 ? 5 : reach.length > 16 ? 2 : 1;

  return (
    <section className="rounded-lg border border-border bg-card px-3 py-3 sm:px-4" data-testid="engagement-reach">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-6">
        <div className="lg:w-[22rem] lg:shrink-0">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">How far buyers got</h3>
          {sentence && <p className="mt-0.5 text-sm leading-snug text-foreground/90">{sentence}</p>}
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {first.buyers} opened it · {last.buyers} reached the last page
          </p>
        </div>
        <div className="flex min-w-0 flex-1 items-end gap-2">
          <span className="w-4 shrink-0 pb-4 text-right text-[11px] tabular-nums text-muted-foreground">{first.buyers}</span>
          <div className="min-w-0 flex-1">
            <div className="relative flex items-end gap-[2px]" style={{ height: H }} role="list" aria-label="Buyers who reached each page">
              {reach.map((r, i) => {
                const h = Math.max(2, (r.buyers / max) * H);
                const isDrop = drop?.index === i;
                return (
                  <button
                    key={`${r.pageId}#${r.part}`}
                    type="button"
                    role="listitem"
                    onClick={() => onOpen(i)}
                    title={`Page ${r.label} · ${r.title}: ${r.buyers} buyer${r.buyers === 1 ? "" : "s"} got this far`}
                    aria-label={`Page ${r.label}, ${r.title}: ${r.buyers} buyers got this far`}
                    className="group relative h-full min-w-0 flex-1"
                  >
                    <span
                      className={cn(
                        "absolute inset-x-0 bottom-0 rounded-t-[2px] transition-colors",
                        i === selectedIndex ? "bg-teal" : isDrop ? "bg-teal/55 group-hover:bg-teal/75" : "bg-teal/30 group-hover:bg-teal/55",
                      )}
                      style={{ height: h }}
                    />
                    {isDrop && drop && (
                      <span
                        className="pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold text-amber-500"
                        style={{ bottom: h + 2 }}
                      >
                        −{drop.from - drop.to}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mt-1 flex gap-[2px]">
              {reach.map((r, i) => (
                <span
                  key={`${r.pageId}#${r.part}`}
                  className={cn("min-w-0 flex-1 text-center text-[9px] tabular-nums", i === selectedIndex ? "font-semibold text-teal" : "text-muted-foreground/70")}
                >
                  {i % showEvery === 0 || i === selectedIndex || i === reach.length - 1 ? r.label : ""}
                </span>
              ))}
            </div>
          </div>
          <span className="w-4 shrink-0 pb-4 text-[11px] tabular-nums text-muted-foreground">{last.buyers}</span>
        </div>
      </div>
    </section>
  );
}
