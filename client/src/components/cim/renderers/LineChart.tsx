/**
 * LineChart renderer
 * Recharts multi-series line chart — smooth curves, clean grid.
 */
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Dot,
} from "recharts";
import { useCimTheme } from "../CimDesignContext";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { ProseFallback } from "../richText";
import { axisWidthFor, formatAxisTick, formatFullValue } from "./chartFormat";

interface SeriesConfig {
  key: string;
  label: string;
  color?: string;
}

interface LineChartLayoutData {
  data?: Array<Record<string, number | string>>;
  series?: SeriesConfig[];
  xLabel?: string;
  yLabel?: string;
  unit?: string;
  title?: string;
}

interface RendererProps {
  layoutData: LineChartLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string; dataKey: string }>;
  label?: string;
  unit?: string;
  series?: SeriesConfig[];
}

function CustomTooltip({ active, payload, label, unit, series }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-card border border-card-border rounded-md shadow-md px-3 py-2 text-xs">
      <p className="font-semibold text-foreground mb-1.5">{label}</p>
      {payload.map((p, i) => {
        const seriesLabel = series?.find((s) => s.key === p.dataKey)?.label || p.name;
        return (
          <div key={i} className="flex items-center gap-2 mb-0.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
            <span className="text-muted-foreground">{seriesLabel}:</span>
            <span className="font-medium tabular-nums">
              {formatFullValue(p.value, unit)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function LineChartRenderer({ layoutData, content, branding, section }: RendererProps) {
  const theme = useCimTheme();
  const data: LineChartLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const chartData = data.data || [];
  const series = data.series || [];

  if (chartData.length === 0 || series.length === 0) {
    if (!content) return null;
    return <ProseFallback content={content} />;
  }

  // Series colours always come from the template, so every chart in the
  // CIM shares one palette (per-series colours in the data are ignored).
  const colorPalette = theme.chart;

  const showLegend = series.length > 1;
  const yAxisWidth = axisWidthFor(chartData.flatMap((d) => series.map((s) => d[s.key])), data.unit);

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      {data.yLabel && (
        // Axis caption sits above the plot — a rotated label inside the axis
        // column collides with the tick numbers (worst on phones).
        <p className="text-2xs font-medium text-muted-foreground mb-1.5">{data.yLabel}</p>
      )}
      <ResponsiveContainer width="100%" height={280}>
        <LineChart
          data={chartData}
          margin={{ top: 4, right: 16, left: 4, bottom: data.xLabel ? 24 : 8 }}
        >
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
            // Points sit on the plot edges, so their centred labels ("FY2025")
            // would hang past the right edge and touch the "$0" tick on the left.
            padding={{ left: 20, right: 20 }}
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
            content={<CustomTooltip unit={data.unit} series={series} />}
            cursor={{ stroke: theme.line, strokeWidth: 1 }}
          />
          {showLegend && (
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8, color: theme.inkSoft }}
              iconType="circle"
              iconSize={8}
              formatter={(value) => series.find((s) => s.key === value)?.label || value}
            />
          )}
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.key}
              stroke={colorPalette[i % colorPalette.length]}
              strokeWidth={2}
              dot={{ r: 3, fill: colorPalette[i % colorPalette.length], strokeWidth: 0 }}
              activeDot={{ r: 5, strokeWidth: 0 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
