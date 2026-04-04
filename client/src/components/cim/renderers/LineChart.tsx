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
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

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

function buildLineColors(primary: string, accent: string): string[] {
  return [primary, accent, "#64b8a0", "#94c9b8", "#6b7280", "#9ca3af"];
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
              {typeof p.value === "number" ? p.value.toLocaleString() : p.value}
              {unit ? ` ${unit}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function LineChartRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: LineChartLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const chartData = data.data || [];
  const series = data.series || [];

  if (chartData.length === 0 || series.length === 0) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  const primaryColor = branding.primaryHex || "#2dc88e";
  const accentColor = branding.accentHex || "#1a9e72";
  const colorPalette = buildLineColors(primaryColor, accentColor);

  const showLegend = series.length > 1;

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      <ResponsiveContainer width="100%" height={280}>
        <LineChart
          data={chartData}
          margin={{ top: 4, right: 16, left: 0, bottom: data.xLabel ? 24 : 8 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="hsl(var(--border))"
            vertical={false}
          />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            label={data.xLabel ? { value: data.xLabel, position: "insideBottom", offset: -12, fontSize: 11, fill: "hsl(var(--muted-foreground))" } : undefined}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => v.toLocaleString()}
            label={data.yLabel ? { value: data.yLabel, angle: -90, position: "insideLeft", fontSize: 11, fill: "hsl(var(--muted-foreground))" } : undefined}
          />
          <Tooltip
            content={<CustomTooltip unit={data.unit} series={series} />}
            cursor={{ stroke: "hsl(var(--border))", strokeWidth: 1 }}
          />
          {showLegend && (
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
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
              stroke={s.color || colorPalette[i % colorPalette.length]}
              strokeWidth={2}
              dot={{ r: 3, fill: s.color || colorPalette[i % colorPalette.length], strokeWidth: 0 }}
              activeDot={{ r: 5, strokeWidth: 0 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
