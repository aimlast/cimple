/**
 * The page rail beside the heat map: one tile per page — number, real title
 * (and "Buyer saw: …" when blind buyers saw a different title), a layout
 * icon, a bar for the page's share of all reading time, "5 of 6 read" and how
 * they read it. Each tile's background is tinted by the page's reading time
 * against the busiest page (railTint), so the heat shows before any click.
 * Document order or most time first. Up/down arrow keys move between pages
 * while the rail has focus.
 *
 * On a phone the rail becomes a row of chips that scrolls sideways, each with
 * a heat swatch.
 */
import { useEffect, useRef } from "react";
import { READ_LABEL_TEXT, formatReadingTime, type DocumentPage } from "@shared/analytics-v2";
import { cn } from "@/lib/utils";
import { heatChrome } from "../heat";
import { layoutIcon } from "./layout-icons";
import { heatIntensity, orderPages, railTint, type PageOrder } from "./viewer-model";

export function PageRail({
  pages, selectedIndex, onSelect, order, openedBy, totalMs,
}: {
  pages: DocumentPage[];
  selectedIndex: number;
  onSelect(index: number): void;
  order: PageOrder;
  openedBy: number;
  totalMs: number;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const ordered = orderPages(pages, order);
  const maxMs = Math.max(0, ...pages.map((p) => p.attentionMs));

  // Keep the open page's tile in view (scrolls the rail only, never the page),
  // also once the rail settles to its final height (it is sized by the window).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const show = () => {
      const el = list.querySelector<HTMLElement>(`[data-rail-index="${selectedIndex}"]`);
      if (el) keepInView(list, el, "y");
    };
    show();
    if (typeof ResizeObserver === "undefined") return;
    let last = list.clientHeight;
    const ro = new ResizeObserver(() => { if (list.clientHeight !== last) { last = list.clientHeight; show(); } });
    ro.observe(list);
    return () => ro.disconnect();
  }, [selectedIndex, order]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const pos = ordered.findIndex((p) => p.index === selectedIndex);
    const next = ordered[Math.max(0, Math.min(ordered.length - 1, pos + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) onSelect(next.index);
  };

  return (
    <nav aria-label="Pages of the CIM" className="flex min-h-0 flex-col" data-testid="engagement-page-rail">
      <div ref={listRef} tabIndex={0} onKeyDown={onKey} className="relative min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 outline-none focus-visible:ring-1 focus-visible:ring-teal/50 rounded-md">
        {ordered.map((p) => {
          const Icon = layoutIcon(p.layoutType);
          const on = p.index === selectedIndex;
          // Nobody reached it — or nobody's reading was ever recorded on it (old tracking).
          const unreached = p.reachedBy === 0 || p.reachRecorded === false;
          const tint = railTint(heatIntensity(p.attentionMs, maxMs));
          return (
            <button
              key={`${p.pageId}#${p.part}`}
              type="button"
              data-rail-index={p.index}
              onClick={() => onSelect(p.index)}
              aria-current={on ? "page" : undefined}
              className={cn(
                "w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                on ? "border-teal/50 ring-1 ring-teal/60" : "border-transparent hover:border-border",
                !tint && (on ? "bg-teal/10" : "hover:bg-muted/50"),
                unreached && !on && "opacity-55",
              )}
              style={tint ? { background: tint } : undefined}
              data-rail-tint={tint ? "1" : undefined}
            >
              <div className="flex items-start gap-2">
                <span className={cn("mt-px w-5 shrink-0 text-right text-[11px] tabular-nums", on ? "text-teal font-semibold" : "text-muted-foreground")}>{p.label}</span>
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className={cn("truncate text-xs leading-snug", on ? "font-semibold text-foreground" : "text-foreground/90")} title={p.title}>{p.title}</p>
                  {p.servedTitle && (
                    <p className="truncate text-[10px] italic leading-snug text-muted-foreground" title={`Blind buyers saw: ${p.servedTitle}`}>
                      Buyer saw: “{p.servedTitle}”
                    </p>
                  )}
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" title={`${formatReadingTime(p.attentionMs)} of ${formatReadingTime(totalMs)} total reading time`}>
                    <span className="block h-full rounded-full" style={{ width: `${maxMs ? Math.max(p.attentionMs > 0 ? 3 : 0, (p.attentionMs / maxMs) * 100) : 0}%`, background: heatChrome(maxMs ? p.attentionMs / maxMs : 0) }} />
                  </div>
                  <div className="mt-1 flex items-baseline justify-between gap-2 whitespace-nowrap text-[10px] text-muted-foreground">
                    <span className="tabular-nums text-foreground/80">{p.attentionMs > 0 ? formatReadingTime(p.attentionMs) : p.reachRecorded === false ? "no reading recorded" : "not read"}</span>
                    <span className="tabular-nums" title={`${p.readers} of ${Math.max(openedBy, p.readers)} buyers read this page${p.readLabel ? ` · ${READ_LABEL_TEXT[p.readLabel]}` : ""}`}>
                      {p.readers}/{Math.max(openedBy, p.readers)}
                      {p.readLabel && <span className={cn(p.readLabel === "studied" ? "text-teal" : "")}> · {READ_LABEL_TEXT[p.readLabel]}</span>}
                    </span>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** Phone version: a sideways-scrolling row of page chips. */
export function PageChips({ pages, selectedIndex, onSelect }: { pages: DocumentPage[]; selectedIndex: number; onSelect(index: number): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const maxMs = Math.max(0, ...pages.map((p) => p.attentionMs));
  useEffect(() => {
    const list = ref.current;
    const el = list?.querySelector<HTMLElement>(`[data-chip-index="${selectedIndex}"]`);
    if (list && el) keepInView(list, el, "x");
  }, [selectedIndex]);
  return (
    <div ref={ref} className="relative -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" data-testid="engagement-page-chips" aria-label="Pages of the CIM">
      {pages.map((p) => {
        const on = p.index === selectedIndex;
        const t = heatIntensity(p.attentionMs, maxMs);
        return (
          <button
            key={`${p.pageId}#${p.part}`}
            type="button"
            data-chip-index={p.index}
            onClick={() => onSelect(p.index)}
            className={cn(
              "flex max-w-[11rem] shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
              on ? "border-teal/60 bg-teal/15 text-teal" : "border-border text-foreground/85",
            )}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: heatChrome(t) }}
              aria-hidden
              data-heat-swatch
            />
            <span className="tabular-nums font-semibold">{p.label}</span>
            <span className="truncate">{p.title}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Scroll a list (never the window) so that one of its items is visible. The list must be positioned. */
function keepInView(list: HTMLElement, el: HTMLElement, axis: "x" | "y") {
  if (axis === "y") {
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    // Only the part of the rail that is on screen counts (the rail can be taller than what the window shows).
    const r = list.getBoundingClientRect();
    const hiddenAbove = Math.max(0, -r.top);
    const onScreen = Math.max(el.offsetHeight + 16, Math.min(list.clientHeight, (typeof window !== "undefined" ? window.innerHeight : list.clientHeight) - Math.max(0, r.top)) - hiddenAbove);
    const visTop = list.scrollTop + hiddenAbove;
    const visBottom = visTop + onScreen;
    if (top < visTop) list.scrollTop = Math.max(0, top - 8 - hiddenAbove);
    else if (bottom > visBottom) list.scrollTop = Math.max(0, bottom - onScreen + 8 - hiddenAbove);
  } else {
    list.scrollLeft = Math.max(0, el.offsetLeft - (list.clientWidth - el.offsetWidth) / 2);
  }
}
