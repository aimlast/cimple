/**
 * BarChart renderer
 * Recharts vertical bar chart — clean, minimal, professional.
 */
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import { useCimTheme } from "../CimDesignContext";
import type { CimSection } from "@shared/schema";
import { ProseFallback } from "../richText";
import { axisWidthFor, formatAxisTick, formatFullValue } from "./chartFormat";
import { chartSeriesRows, parseChartNumber, unitScale } from "@shared/cim-chart-values";
import { BlockTitle } from "./BlockTitle";
import { NotCharted } from "./NotCharted";
import { useBlockAttrs, useChartPointReporter } from "../blocks";

interface BarDataPoint {
  name: string;
  value: number | string;
  secondaryValue?: number | string;
  color?: string;
}

interface BarChartLayoutData {
  data?: BarDataPoint[];
  xLabel?: string;
  yLabel?: string;
  secondaryLabel?: string;
  unit?: string;
  title?: string;
  stacked?: boolean;
}

interface RendererProps {
  layoutData: BarChartLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
  unit?: string;
}

function CustomTooltip({ active, payload, label, unit }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-card border border-card-border rounded-md shadow-md px-3 py-2 text-xs">
      <p className="font-semibold text-foreground mb-1">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium text-foreground tabular-nums">
            {formatFullValue(p.value, unit)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BarChartRenderer({ layoutData, content, branding, section }: RendererProps) {
  const theme = useCimTheme();
  const ba = useBlockAttrs();
  const point = useChartPointReporter();
  const data: BarChartLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const chartData = data.data || [];

  if (chartData.length === 0) {
    if (!content) return null;
    return <ProseFallback content={content} />;
  }

  // The template's series colours (brand colours lead when the broker uses them).
  const primaryColor = theme.chart[0];
  const secondaryColor = theme.chart[1];
  const hasSecondary = chartData.some((d) => d.secondaryValue != null);

  // Text values ("$1,250,000", "$1,850,000 (9 months YTD)") are read as
  // numbers; one that isn't an amount ("TBD") is listed under the chart,
  // never drawn as a $0 bar.
  // (Each drawn bar keeps its datum's index: the reading tracker's chart
  // points follow the layout data, which also holds the rows not drawn.)
  const series = chartSeriesRows(chartData.map((d, srcIndex) => ({ ...d, srcIndex })), data.unit);
  const normalized = series.rows.map((d) => ({
    ...d,
    secondaryValue: d.secondaryValue != null ? parseChartNumber(d.secondaryValue, unitScale(data.unit)) ?? undefined : undefined,
  }));
  if (normalized.length === 0) {
    if (!content && series.unreadable.length === 0) return null;
    return (
      <div>
        <BlockTitle title={data.title} intro={(data as { intro?: unknown }).intro} />
        <div {...ba("chart")}><NotCharted items={series.unreadable} /></div>
        {content ? <ProseFallback content={content} /> : null}
      </div>
    );
  }

  const yAxisWidth = axisWidthFor(
    normalized.flatMap((d) =>
      data.stacked ? [(d.value || 0) + (d.secondaryValue || 0)] : [d.value, d.secondaryValue],
    ),
    data.unit,
  );

  return (
    <div>
      <BlockTitle title={data.title} intro={(data as { intro?: unknown }).intro} />
      <div {...ba("chart")}>
      {data.yLabel && (
        // Axis caption sits above the plot — a rotated label inside the axis
        // column collides with the tick numbers (worst on phones).
        <p className="text-2xs font-medium text-muted-foreground mb-1.5">{data.yLabel}</p>
      )}
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={normalized} margin={{ top: 4, right: 16, left: 4, bottom: data.xLabel ? 24 : 8 }}
          barCategoryGap="30%"
          onMouseMove={(s) => point(s?.activeTooltipIndex == null ? null : normalized[Number(s.activeTooltipIndex)]?.srcIndex)}
          onMouseLeave={() => point(null)}>
          {/* Explicit paper-palette hex — charts must read identically in both app themes */}
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={theme.line}
            vertical={false}
          />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 11, fill: theme.inkMuted }}
            axisLine={false}
            tickLine={false}
            label={data.xLabel ? { value: data.xLabel, position: "insideBottom", offset: -12, fontSize: 11, fill: theme.inkMuted } : undefined}
          />
          <YAxis
            tick={{ fontSize: 11, fill: theme.inkMuted }}
            axisLine={false}
            tickLine={false}
            width={yAxisWidth}
            tickFormatter={(v) => formatAxisTick(v, data.unit)}
          />
          <Tooltip
            content={<CustomTooltip unit={data.unit} />}
            cursor={{ fill: theme.stripe, fillOpacity: 0.6 }}
          />
          {hasSecondary && (
            // Above the plot: at the bottom it sat on the x-axis caption.
            <Legend
              verticalAlign="top"
              align="right"
              wrapperStyle={{ fontSize: 11, paddingBottom: 8, color: theme.inkSoft }}
              iconType="circle"
              iconSize={8}
            />
          )}
          <Bar
            dataKey="value"
            name={data.yLabel || "Value"}
            fill={primaryColor}
            radius={[3, 3, 0, 0]}
            stackId={data.stacked ? "stack" : undefined}
            className="transition-opacity"
            onMouseEnter={(_, index) => {
              // Subtle highlight via CSS on the parent SVG
              const bars = document.querySelectorAll(`.recharts-bar-rectangle`);
              bars.forEach((b, i) => {
                (b as HTMLElement).style.opacity = i === index ? "1" : "0.6";
              });
            }}
            onMouseLeave={() => {
              const bars = document.querySelectorAll(`.recharts-bar-rectangle`);
              bars.forEach((b) => { (b as HTMLElement).style.opacity = "1"; });
            }}
          />
          {hasSecondary && (
            <Bar
              dataKey="secondaryValue"
              name={data.secondaryLabel || "Secondary"}
              fill={secondaryColor}
              radius={[3, 3, 0, 0]}
              stackId={data.stacked ? "stack" : undefined}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
      <NotCharted items={series.unreadable} />
      </div>
    </div>
  );
}
