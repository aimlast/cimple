/**
 * MetricGrid renderer
 * Grid of KPI cards with trend arrows and highlight accents.
 *
 * A figure never breaks mid-number ("$31,020,00 / 0"): in a 3- or 4-card
 * row a long plain figure is shortened ("$31.02M", the exact figure in the
 * tooltip) and the type steps down with the length. Words may wrap between
 * words; numbers stay on one line.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { ProseFallback, renderInline } from "../richText";
import { compactFigure } from "./chartFormat";

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

// A currency unit reads as "$250,000", not "250,000 $".
const CURRENCY_UNIT = /^(?:[A-Z]{0,3}\s?[$€£¥]|[$€£¥]\s?[A-Z]{0,3})$/;
function isCurrencyUnit(unit: string): boolean {
  return CURRENCY_UNIT.test(unit.trim());
}
function currencyPrefix(metric: { value: unknown; unit?: string }): string {
  if (!metric.unit || !isCurrencyUnit(metric.unit)) return "";
  const sym = metric.unit.trim();
  return String(metric.value).trim().startsWith(sym) || /^[$€£¥]/.test(String(metric.value).trim()) ? "" : sym;
}

/** Type size for a value of this length (cards are narrow in 3–4 column rows). */
export function metricValueClass(text: string, cols: number): string {
  const len = text.length;
  if (len <= 7 || (cols <= 2 && len <= 10)) return "text-xl sm:text-2xl";
  if (len <= 10) return "text-lg sm:text-xl";
  return "text-base sm:text-lg";
}

/** The value as a card shows it: currency prefix added, long figures shortened in narrow rows. */
export function metricDisplayValue(metric: { value: unknown; unit?: string }, cols: number): { text: string; exact: string } {
  const exact = currencyPrefix(metric) + String(metric.value ?? "");
  const text = cols >= 3 && exact.length > 9 ? compactFigure(exact) : exact;
  return { text, exact };
}

export function MetricGridRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: MetricGridLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const metrics = data.metrics || [];
  const cols = data.columns || 3;

  if (metrics.length === 0) {
    if (!content) return null;
    return <ProseFallback content={content} />;
  }

  // One card per row on phones (a 7-digit value doesn't fit half a phone),
  // two from 420px, the requested count from sm.
  const gridClass = {
    2: "grid-cols-1 min-[420px]:grid-cols-2",
    3: "grid-cols-1 min-[420px]:grid-cols-2 sm:grid-cols-3",
    4: "grid-cols-1 min-[420px]:grid-cols-2 sm:grid-cols-4",
  }[cols] || "grid-cols-1 min-[420px]:grid-cols-2 sm:grid-cols-3";

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
              "relative min-w-0 bg-card rounded-lg px-4 sm:px-5 py-4 border",
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
            <div className="flex flex-wrap items-baseline gap-x-1.5 min-w-0">
              {(() => {
                const { text, exact } = metricDisplayValue(metric, cols);
                const numeric = !/\s/.test(text.trim());
                return (
                  <span
                    className={cn(
                      "font-semibold tracking-tight text-foreground tabular-nums",
                      metricValueClass(text, cols),
                      // A number stays on one line; words wrap between words.
                      numeric ? "whitespace-nowrap" : "break-words",
                    )}
                    title={text !== exact ? exact : undefined}
                  >
                    {text}
                  </span>
                );
              })()}
              {metric.unit && !isCurrencyUnit(metric.unit) && (
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
              <p className="text-2xs text-muted-foreground/60 mt-2 leading-snug">{renderInline(metric.footnote, `fn${i}`)}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
