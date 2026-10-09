/**
 * The period control: Last 7 days · Last 30 days · All time (short words
 * below 640 px: 7 days · 30 days · All). It sits in the header of the
 * numbers it changes, never above things it doesn't change.
 */
import { DASHBOARD_RANGES, rangeLabel, type DashboardRange } from "@shared/analytics-dashboard";
import { cn } from "@/lib/utils";

export function RangeControl({
  value, onChange, className, testId = "range-control",
}: {
  /** The period shown (when the URL has none, the one the server chose). */
  value: DashboardRange;
  onChange(range: DashboardRange): void;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn("inline-flex shrink-0 rounded-md border border-border bg-background/40 p-0.5", className)}
      role="radiogroup"
      aria-label="Period"
      data-testid={testId}
    >
      {DASHBOARD_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={value === r}
          onClick={() => onChange(r)}
          className={cn(
            "flex-1 whitespace-nowrap rounded-[5px] px-2 py-0.5 text-xs font-medium transition-colors sm:px-2.5 sm:py-1",
            value === r ? "bg-teal/15 text-teal" : "text-muted-foreground hover:text-foreground",
          )}
          data-testid={`range-${r}`}
        >
          <span className="sm:hidden">{rangeLabel(r, true)}</span>
          <span className="hidden sm:inline">{rangeLabel(r)}</span>
        </button>
      ))}
    </div>
  );
}
