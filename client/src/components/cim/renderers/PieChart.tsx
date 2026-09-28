/**
 * PieChart renderer
 * Recharts PieChart — also handles donut_chart layoutType.
 * Custom legend beside the chart, or under it when the space is narrow (a
 * phone, a two-column half) so values are never clipped. Values are written
 * with their unit the way a reader expects: "$3,520,000", "45%", "12 sites"
 * — never "3,520,000 $".
 */
import { useState, useCallback } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Sector,
} from "recharts";
import { cn } from "@/lib/utils";
import { useCimTheme } from "../CimDesignContext";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { ProseFallback } from "../richText";
import { formatFullValue, useElementWidth } from "./chartFormat";
import { chartShares, isPercentUnit, parseChartNumber, unitScale } from "@shared/cim-chart-values";
import { BlockTitle } from "./BlockTitle";

/** Below this width the legend goes under the chart (200px chart + a readable legend). */
const SIDE_BY_SIDE_MIN = 480;

interface PieDataPoint {
  name: string;
  value: number | string;
  color?: string;
}

interface PieChartLayoutData {
  data?: PieDataPoint[];
  totalLabel?: string;
  /** The whole the slices make up, as the knowledge base states it — the only total ever printed. */
  total?: number | string;
  unit?: string;
  title?: string;
  centerLabel?: string;
  centerValue?: string;
}

interface RendererProps {
  layoutData: PieChartLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; name: string; payload: { color: string } }>;
  unit?: string;
}

function CustomTooltip({ active, payload, unit }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0];
  return (
    <div className="bg-card border border-card-border rounded-md shadow-md px-3 py-2 text-xs">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.payload.color }} />
        <span className="font-semibold text-foreground">{p.name}</span>
      </div>
      <span className="font-medium tabular-nums">{formatFullValue(p.value, unit)}</span>
    </div>
  );
}

// Active shape renderer for hover/tap segment lift effect
function renderActiveShape(props: any) {
  const {
    cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill,
  } = props;

  return (
    <g>
      <Sector
        cx={cx}
        cy={cy}
        innerRadius={innerRadius - 2}
        outerRadius={outerRadius + 6}
        startAngle={startAngle}
        endAngle={endAngle}
        fill={fill}
        style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.15))", transition: "all 0.2s ease" }}
      />
    </g>
  );
}

export function PieChartRenderer({ layoutData, content, branding, section }: RendererProps) {
  const [activeIndex, setActiveIndex] = useState<number | undefined>(undefined);
  const theme = useCimTheme();
  const onPieEnter = useCallback((_: any, index: number) => setActiveIndex(index), []);
  const onPieLeave = useCallback(() => setActiveIndex(undefined), []);
  const { ref: boxRef, width: boxWidth } = useElementWidth<HTMLDivElement>();
  const data: PieChartLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const rawData = data.data || [];

  if (rawData.length === 0) {
    if (!content) return null;
    return <ProseFallback content={content} />;
  }

  // One palette for every chart in the CIM (per-slice colours in the data
  // are ignored so a template/brand change reaches every chart).
  const palette = theme.chart;

  const isDonut = section.layoutType === "donut_chart" || !!(data.centerLabel || data.centerValue);

  const normalized = rawData.map((d, i) => ({
    ...d,
    // Text values ("22%", "$1.2M") are read as numbers, never drawn as zero.
    value: parseChartNumber(d.value, unitScale(data.unit)) ?? 0,
    color: palette[i % palette.length],
  }));

  // Shares and the total are printed only against a whole the chart states
  // (shared/cim-chart-values.ts chartShares) — never the sum of the slices.
  const { shares, total, asBars } = chartShares(normalized.map((d) => d.value), data.unit, data.total);
  if (asBars) {
    return (
      <div>
        <BlockTitle title={data.title} intro={(data as { intro?: unknown }).intro} />
        {data.totalLabel && total !== null && (
          <div className="mb-3 pb-2 border-b border-border">
            <p className="text-xs text-muted-foreground">{data.totalLabel}</p>
            <p className="text-sm font-semibold tabular-nums">{formatFullValue(total, data.unit)}</p>
          </div>
        )}
        <PercentBars items={normalized} unit={data.unit} shares={shares} />
      </div>
    );
  }

  return (
    <div>
      <BlockTitle title={data.title} intro={(data as { intro?: unknown }).intro} />
      <div
        ref={boxRef}
        className={cn("flex gap-6", boxWidth > 0 && boxWidth < SIDE_BY_SIDE_MIN ? "flex-col items-center" : "items-center")}
      >
        {/* Chart */}
        <div className="relative flex-shrink-0" style={{ width: 200, height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={normalized}
                cx="50%"
                cy="50%"
                innerRadius={isDonut ? 55 : 0}
                outerRadius={88}
                paddingAngle={normalized.length > 1 ? 2 : 0}
                dataKey="value"
                strokeWidth={0}
                activeIndex={activeIndex}
                activeShape={renderActiveShape}
                onMouseEnter={onPieEnter}
                onMouseLeave={onPieLeave}
              >
                {normalized.map((entry, i) => (
                  <Cell key={i} fill={entry.color} className="cursor-pointer transition-opacity" />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip unit={data.unit} />} />
            </PieChart>
          </ResponsiveContainer>
          {/* Donut center label */}
          {isDonut && (data.centerLabel || data.centerValue) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              {data.centerValue && (
                <span
                  className={cn(
                    "font-semibold text-foreground leading-tight tabular-nums",
                    // The hole is ~110px: "$31,020,000" at text-xl ran over the ring.
                    String(data.centerValue).length > 9 ? "text-sm" : String(data.centerValue).length > 6 ? "text-base" : "text-xl",
                  )}
                >
                  {data.centerValue}
                </span>
              )}
              {data.centerLabel && (
                <span className="text-2xs text-muted-foreground text-center px-2 leading-snug mt-0.5">
                  {data.centerLabel}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Legend */}
        <div className={cn("flex flex-col gap-2 min-w-0", boxWidth > 0 && boxWidth < SIDE_BY_SIDE_MIN ? "w-full" : "flex-1")}>
          {data.totalLabel && total !== null && (
            <div className="mb-2 pb-2 border-b border-border">
              <p className="text-xs text-muted-foreground">{data.totalLabel}</p>
              <p className="text-sm font-semibold tabular-nums">{formatFullValue(total, data.unit)}</p>
            </div>
          )}
          {normalized.map((entry, i) => {
            const pct = shares ? shares[i].toFixed(1) : null;
            const isHighlighted = activeIndex === i;
            return (
              <div
                key={i}
                className={cn(
                  "flex items-start gap-2.5 min-w-0 rounded px-1 -mx-1 py-0.5 transition-colors cursor-pointer",
                  isHighlighted && "bg-muted/50",
                )}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseLeave={() => setActiveIndex(undefined)}
              >
                <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0 mt-1" style={{ backgroundColor: entry.color }} />
                <span className="text-xs text-foreground/80 flex-1 min-w-0 break-words">{entry.name}</span>
                <div className="flex flex-wrap items-baseline justify-end gap-x-1.5 flex-shrink-0 max-w-[55%] text-right">
                  <span className="text-xs font-semibold tabular-nums text-foreground whitespace-nowrap">
                    {formatFullValue(entry.value, data.unit)}
                  </span>
                  {pct !== null && <span className="text-2xs text-muted-foreground whitespace-nowrap">({pct}%)</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Values that aren't all the parts of one whole, each drawn as its own bar
 * on a 0–100% scale: percentages (a top customer's 22% and the top five's
 * 47%) at their own value, and amounts that fall short of the stated total
 * at their share of it — a pie would have drawn either as the full circle.
 * Amounts that exceed the stated total have no share: their bars are scaled
 * to the largest.
 */
function PercentBars({ items, unit, shares }: { items: Array<{ name: string; value: number }>; unit?: string; shares?: number[] | null }) {
  const theme = useCimTheme();
  const max = Math.max(...items.map((x) => Math.abs(x.value)), 0);
  const width = (i: number, v: number) =>
    shares ? shares[i] : isPercentUnit(unit) ? v : max > 0 ? (Math.abs(v) / max) * 100 : 0;
  return (
    <div className="flex flex-col gap-3" data-testid="percent-bars">
      {items.map((entry, i) => (
        <div key={i} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-foreground/80 min-w-0 break-words">{entry.name}</span>
            <span className="flex items-baseline gap-1.5 whitespace-nowrap">
              <span className="text-xs font-semibold tabular-nums text-foreground">{formatFullValue(entry.value, unit)}</span>
              {shares && <span className="text-2xs text-muted-foreground">({shares[i].toFixed(1)}%)</span>}
            </span>
          </div>
          <div className="mt-1 h-2 rounded-sm" style={{ backgroundColor: theme.stripe }}>
            <div className="h-2 rounded-sm" style={{ width: `${Math.max(0, Math.min(100, width(i, entry.value)))}%`, backgroundColor: theme.chart[0] }} />
          </div>
        </div>
      ))}
    </div>
  );
}
