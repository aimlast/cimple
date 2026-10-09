/**
 * "How far buyers got" — one column per page, its height the number of buyers
 * whose furthest page is at or beyond it (a step down = buyers who stopped
 * there), and under it a reading-time strip: one cell per page, coloured by
 * the page's reading time against the busiest page, so the heat is visible
 * before any click. Clicking a column or a cell opens that page.
 *
 * The sentence names the steepest drop in words; a small ▼ marks it on the
 * chart. With old tracking, pages nobody has any reading on (never recorded:
 * added after these buyers read, or never tracked) are hatched and left out
 * of the drop, wherever they sit. The counts line uses the
 * same numbers as the Buyers view ("13 opened it · 12 with reading recorded").
 *
 * Phones: one collapsed row ("How far buyers got · 6 of 12 to page 27 ▾");
 * tapping it opens the bars and the strip.
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { formatReadingTime, type DocumentPage, type ReachPoint } from "@shared/analytics-v2";
import { cn } from "@/lib/utils";
import { heatChrome } from "../heat";
import { heatIntensity, reachCountsLine, reachFallback, recordedDrop, recordedReach } from "./viewer-model";

/**
 * Which page numbers the axis prints: every Nth, the last, and the open page.
 * On phones the open page's neighbours give way to it (no "151617" crowding).
 */
export function axisLabelShown(i: number, selected: number, n: number, every: number, compact: boolean): boolean {
  if (i === selected) return true;
  if (compact && selected >= 0 && Math.abs(i - selected) < every) return false;
  return i % every === 0 || i === n - 1;
}

const HATCH = "repeating-linear-gradient(135deg, hsl(var(--muted-foreground) / 0.25) 0 2px, transparent 2px 5px)";

export function ReachChart({
  reach, pages, headline, openedBy, openedTotal, oldTracking, maxPageMs, selectedIndex, onOpen, compact = false, inView = false,
}: {
  reach: ReachPoint[];
  /** The document's pages (reading time and whether the old tracking recorded each one). */
  pages: ReadonlyArray<Pick<DocumentPage, "attentionMs" | "reachRecorded">>;
  headline: string | null;
  /** Buyers with reading recorded. */
  openedBy: number;
  /** Buyers who opened it (the pulse's number). */
  openedTotal: number;
  /** Reach comes from the old tracking (only pages with reading were recorded). */
  oldTracking: boolean;
  /** The busiest page's reading time (the darkest strip cell). */
  maxPageMs: number;
  selectedIndex: number;
  onOpen(index: number): void;
  compact?: boolean;
  /** A narrower view (buyers, a segment, a device, a date range): the counts say "in this view". */
  inView?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (reach.length === 0 || openedBy === 0) return null;
  const max = Math.max(openedBy, ...reach.map((r) => r.buyers), 1);
  const recorded = recordedReach(reach, pages);
  const drop = recordedDrop(reach, pages);
  const first = recorded[0] ?? reach[0];
  const lastRec = recorded[recorded.length - 1] ?? reach[reach.length - 1];
  // Phones' one-line summary: how many got to the last recorded page — or, when
  // nobody in view did (a buyer who stopped early), how far they did get.
  const furthestRec = lastRec.buyers > 0 ? lastRec : [...recorded].reverse().find((r) => r.buyers > 0) ?? lastRec;
  const H = compact ? 36 : 44;
  const sentence = headline ?? reachFallback(recorded, openedBy);
  const counts = reachCountsLine({ openedTotal, openedBy, reach, pages, oldTracking, inView });
  const showEvery = reach.length > 30 ? 5 : reach.length > 16 ? 2 : 1;
  const isRecorded = (i: number) => pages[i]?.reachRecorded !== false;

  const chart = (
    <div className="flex min-w-0 flex-1 items-end gap-2">
      <span className="w-4 shrink-0 pb-7 text-right text-[11px] tabular-nums text-muted-foreground">{first.buyers}</span>
      <div className="min-w-0 flex-1">
        <div className="relative flex items-end gap-[2px]" style={{ height: H }} role="list" aria-label="Buyers who reached each page">
          {reach.map((r, i) => {
            const rec = isRecorded(i);
            const h = rec ? Math.max(2, (r.buyers / max) * H) : H;
            const isDrop = drop?.index === i;
            const stopped = isDrop && drop ? drop.from - drop.to : 0;
            const label = rec
              ? `Page ${r.label} · ${r.title}: ${r.buyers} buyer${r.buyers === 1 ? "" : "s"} got this far`
              : `Page ${r.label} · ${r.title}: no reading recorded on this page`;
            return (
              <button
                key={`${r.pageId}#${r.part}`}
                type="button"
                role="listitem"
                onClick={() => onOpen(i)}
                title={label}
                aria-label={label}
                className="group relative h-full min-w-0 flex-1"
              >
                <span
                  className={cn(
                    "absolute inset-x-0 bottom-0 rounded-t-[2px] transition-colors",
                    !rec ? "" : i === selectedIndex ? "bg-teal" : isDrop ? "bg-teal/60 group-hover:bg-teal/80" : "bg-teal/30 group-hover:bg-teal/55",
                    !rec && i === selectedIndex && "ring-1 ring-foreground/50",
                  )}
                  style={{ height: h, ...(rec ? {} : { background: HATCH, opacity: 0.8 }) }}
                />
                {isDrop && (
                  <span
                    className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[9px] leading-none text-amber-500"
                    style={{ bottom: h + 2 }}
                    title={`${stopped} buyer${stopped === 1 ? "" : "s"} stopped before this page`}
                    aria-label={`${stopped} buyer${stopped === 1 ? "" : "s"} stopped before this page`}
                    data-testid="reach-drop-marker"
                  >
                    ▼
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {/* Reading-time strip: the heat, visible before any click. */}
        <div className="mt-[3px] flex gap-[2px]" role="list" aria-label="Reading time on each page" data-testid="reach-heat-strip">
          {reach.map((r, i) => {
            const rec = isRecorded(i);
            const ms = pages[i]?.attentionMs ?? 0;
            const t = heatIntensity(ms, maxPageMs);
            const label = rec
              ? `Page ${r.label} · ${r.title}: ${formatReadingTime(ms)} of reading time`
              : `Page ${r.label} · ${r.title}: no reading recorded on this page`;
            return (
              <button
                key={`${r.pageId}#${r.part}`}
                type="button"
                role="listitem"
                onClick={() => onOpen(i)}
                title={label}
                aria-label={label}
                className={cn("h-2 min-w-0 flex-1 rounded-[1px]", i === selectedIndex && "outline outline-1 outline-foreground")}
                style={{ background: rec ? heatChrome(t) : HATCH }}
                data-heat-cell={i}
              />
            );
          })}
        </div>
        <div className="mt-1 flex gap-[2px]">
          {reach.map((r, i) => (
            <span
              key={`${r.pageId}#${r.part}`}
              className={cn("min-w-0 flex-1 text-center text-[9px] tabular-nums", i === selectedIndex ? "font-semibold text-teal" : "text-muted-foreground/70")}
            >
              {axisLabelShown(i, selectedIndex, reach.length, showEvery, compact) ? r.label : ""}
            </span>
          ))}
        </div>
        <p className="mt-0.5 text-right text-[10px] text-muted-foreground">bars: buyers who got this far · strip: reading time</p>
      </div>
      <span className="w-4 shrink-0 pb-7 text-[11px] tabular-nums text-muted-foreground">{lastRec.buyers}</span>
    </div>
  );

  if (compact) {
    return (
      <section className="rounded-lg border border-border bg-card px-3 py-2" data-testid="engagement-reach">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 text-left text-xs"
          data-testid="reach-toggle"
        >
          <span className="font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">How far buyers got</span>
          <span className="min-w-0 flex-1 truncate tabular-nums text-foreground/90">
            · {furthestRec.buyers} of {openedBy} to page {furthestRec.label}
          </span>
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
        </button>
        {open && (
          <div className="mt-2 space-y-2">
            {sentence && <p className="text-xs leading-snug text-foreground/90">{sentence}</p>}
            <p className="text-[11px] text-muted-foreground">{counts}</p>
            {chart}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card px-3 py-3 sm:px-4" data-testid="engagement-reach">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-6">
        <div className="lg:w-[22rem] lg:shrink-0">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">How far buyers got</h3>
          {sentence && <p className="mt-0.5 text-sm leading-snug text-foreground/90">{sentence}</p>}
          <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid="reach-counts">{counts}</p>
        </div>
        {chart}
      </div>
    </section>
  );
}
