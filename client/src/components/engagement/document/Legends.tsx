/**
 * The two legends under the CIM page: seconds per shade when parts are
 * painted, and the whole-page shade's scale when only page totals are known.
 * Drawn on a paper swatch so the shades match the (theme-locked) page.
 * Owned by the heatmap stream.
 */
import { formatReadingTime } from "@shared/analytics-v2";
import { legendTicks, pageLegendTicks, paperTint, washFill, type HeatScope } from "./viewer-model";

/** Seconds legend for the paper colours (drawn on a paper swatch so the shades match the page). */
export function HeatLegend({ maxMs, scope, perBuyer = false, note }: { maxMs: number; scope: HeatScope; perBuyer?: boolean; note?: string }) {
  const ticks = legendTicks(maxMs);
  if (ticks.length === 0) return <span />;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" data-testid="engagement-heat-legend">
      <span>Reading time on each part{perBuyer ? " per buyer" : ""}{scope === "page" ? " (this page)" : ""}:</span>
      <span className="inline-flex items-stretch overflow-hidden rounded-sm border border-border" style={{ background: "#FBF9F4" }}>
        {ticks.map((t) => (
          <span key={t.t} className="flex flex-col items-center px-1.5 pt-1 pb-0.5">
            <span className="h-2.5 w-8 rounded-[2px]" style={{ background: paperTint(t.t) ?? "transparent", mixBlendMode: "multiply" }} />
            <span className="mt-0.5 text-[10px] tabular-nums" style={{ color: "#201D18" }}>{t.label}</span>
          </span>
        ))}
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold" style={{ background: "#201D18", color: "#FBF9F4" }}>1</span>
        most time on this page
      </span>
      {note && <span className="font-medium text-foreground/80" data-testid="legend-note">· {note}</span>}
    </div>
  );
}

/** Legend for the whole-page shade: the page's reading time against the busiest page. */
export function PageLegend({ maxPageMs, note }: { maxPageMs: number; note?: string }) {
  const ticks = pageLegendTicks(maxPageMs);
  if (ticks.length === 0) return <span />;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" data-testid="engagement-page-legend">
      <span>Whole page shaded by its reading time:</span>
      <span className="inline-flex items-stretch overflow-hidden rounded-sm border border-border" style={{ background: "#FBF9F4" }}>
        {ticks.map((t) => (
          <span key={t.t} className="flex flex-col items-center px-1.5 pt-1 pb-0.5">
            <span className="h-2.5 w-8 rounded-[2px]" style={{ background: washFill(t.t) ?? "transparent", mixBlendMode: "multiply" }} />
            <span className="mt-0.5 text-[10px] tabular-nums" style={{ color: "#201D18" }}>{t.label}</span>
          </span>
        ))}
      </span>
      <span>· darkest = the most-read page ({formatReadingTime(maxPageMs)})</span>
      {note && <span className="font-medium text-foreground/80" data-testid="legend-note">· {note}</span>}
    </div>
  );
}
