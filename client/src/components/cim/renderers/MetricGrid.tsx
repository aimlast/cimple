/**
 * MetricGrid renderer
 * Grid of KPI cards with trend arrows and highlight accents.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface Metric {
  label: string;
  value: string;
  unit?: string;
  trend?: "up" | "down" | "flat";
  delta?: string;
  highlight?: boolean;
  footnote?: string;
}

interface MetricGridLayoutData {
  metrics?: Metric[];
  columns?: 2 | 3 | 4;
  title?: string;
}

interface RendererProps {
  layoutData: MetricGridLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

const TREND_ICONS = {
  up: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="inline-block">
      <path d="M2 9L6 3L10 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  down: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="inline-block">
      <path d="M2 3L6 9L10 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  flat: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="inline-block">
      <path d="M2 6H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
};

export function MetricGridRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: MetricGridLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const metrics = data.metrics || [];
  const cols = data.columns || 3;

  if (metrics.length === 0) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  const gridClass = {
    2: "grid-cols-2",
    3: "grid-cols-2 sm:grid-cols-3",
    4: "grid-cols-2 sm:grid-cols-4",
  }[cols] || "grid-cols-2 sm:grid-cols-3";

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      <div className={cn("grid gap-3", gridClass)}>
        {metrics.map((metric, i) => (
          <div
            key={i}
            className={cn(
              "relative bg-card rounded-lg px-5 py-4 border",
              metric.highlight
                ? "border-teal/30 shadow-sm"
                : "border-card-border"
            )}
          >
            {/* Teal left accent for highlighted cards */}
            {metric.highlight && (
              <div className="absolute left-0 top-3 bottom-3 w-[3px] bg-teal rounded-full" />
            )}

            {/* Value */}
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold tracking-tight text-foreground">
                {metric.value}
              </span>
              {metric.unit && (
                <span className="text-xs text-muted-foreground font-medium">{metric.unit}</span>
              )}
            </div>

            {/* Label */}
            <p className="text-xs text-muted-foreground mt-1 font-medium leading-snug">
              {metric.label}
            </p>

            {/* Trend + delta */}
            {(metric.trend || metric.delta) && (
              <div
                className={cn(
                  "flex items-center gap-1 mt-2 text-xs font-medium",
                  metric.trend === "up" && "text-success",
                  metric.trend === "down" && "text-destructive",
                  metric.trend === "flat" && "text-muted-foreground"
                )}
              >
                {metric.trend && TREND_ICONS[metric.trend]}
                {metric.delta && <span>{metric.delta}</span>}
              </div>
            )}

            {/* Footnote */}
            {metric.footnote && (
              <p className="text-2xs text-muted-foreground/60 mt-2 leading-snug">{metric.footnote}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
