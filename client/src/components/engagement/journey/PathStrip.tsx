/**
 * One visit's path through the CIM: a strip of segments, one per stop on a
 * page, in reading order; width = time spent there (short stops keep a
 * sliver), shade = time on the brass ramp, the page number printed where it
 * fits. A jump via the contents or a link is marked with a small arrow
 * ("3 → 12 via contents"). Below the strip, the same stops as a wrapped list
 * so every page can be read and tapped on a phone.
 */
import { formatReadingTime, type JourneySegment } from "@shared/analytics-v2";
import { heatChrome } from "../heat";
import { pathWidths } from "../document/viewer-model";

const VIA_WORD = { toc: "via the contents", sticky: "via the page menu", related: "via a link" } as const;

export function PathStrip({ segments, onOpen }: { segments: JourneySegment[]; onOpen?(s: JourneySegment): void }) {
  if (segments.length === 0) return <p className="text-xs text-muted-foreground">No pages recorded for this visit.</p>;
  const widths = pathWidths(segments.map((s) => s.durationSec));
  const max = Math.max(...segments.map((s) => s.durationSec), 1);
  return (
    <div className="space-y-2" data-testid="journey-path">
      <div className="flex h-9 w-full overflow-hidden rounded-md border border-border bg-muted/30">
        {segments.map((s, i) => {
          const w = widths[i];
          const t = s.durationSec / max;
          return (
            <button
              key={`${i}-${s.pageId}`}
              type="button"
              onClick={onOpen ? () => onOpen(s) : undefined}
              disabled={!onOpen}
              title={`Page ${s.label} · ${s.title} · ${formatReadingTime(s.durationSec * 1000)}${s.via ? ` · ${VIA_WORD[s.via]}` : ""}`}
              className="relative h-full min-w-0 border-r border-background/70 last:border-r-0 hover:brightness-110 disabled:cursor-default"
              style={{ width: `${w * 100}%`, background: heatChrome(0.2 + 0.8 * t) }}
            >
              {w > 0.05 && <span className="text-[10px] font-semibold tabular-nums text-foreground/90">{s.label}</span>}
              {s.via && <span className="absolute left-0.5 top-0 text-[9px] leading-none text-foreground/80" aria-hidden>↷</span>}
            </button>
          );
        })}
      </div>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[11px]">
        {segments.map((s, i) => (
          <li key={`${i}-${s.pageId}`} className="flex items-center gap-1">
            {i > 0 && <span className="text-muted-foreground/60">{s.via ? "↷" : "→"}</span>}
            <button
              type="button"
              onClick={onOpen ? () => onOpen(s) : undefined}
              disabled={!onOpen}
              className="rounded px-1 tabular-nums text-foreground/85 hover:bg-muted hover:text-teal disabled:hover:bg-transparent"
              title={`${s.title} · ${formatReadingTime(s.durationSec * 1000)}${s.via ? ` · ${VIA_WORD[s.via]}` : ""}`}
            >
              {s.label}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
