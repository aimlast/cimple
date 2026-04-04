/**
 * HorizontalBarChart renderer
 * Recharts vertical-layout bar chart — good for long category labels.
 */
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ResponsiveContainer,
  LabelList,
} from "recharts";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface HBarDataPoint {
  name: string;
  value: number | string;
  unit?: string;
}

interface HorizontalBarChartLayoutData {
  data?: HBarDataPoint[];
  yLabel?: string;
  unit?: string;
  title?: string;
  showPercentages?: boolean;
}

interface RendererProps {
  layoutData: HorizontalBarChartLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; name: string }>;
  label?: string;
  unit?: string;
}

function CustomTooltip({ active, payload, label, unit }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-card border border-card-border rounded-md shadow-md px-3 py-2 text-xs">
      <p className="font-semibold text-foreground mb-1">{label}</p>
      <span className="font-medium text-foreground tabular-nums">
        {typeof payload[0].value === "number" ? payload[0].value.toLocaleString() : payload[0].value}
        {unit ? ` ${unit}` : ""}
      </span>
    </div>
  );
}

export function HorizontalBarChartRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: HorizontalBarChartLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const chartData = data.data || [];

  if (chartData.length === 0) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  const primaryColor = branding.primaryHex || "#2dc88e";

  const normalized = chartData.map((d) => ({
    ...d,
    value: typeof d.value === "string" ? parseFloat(d.value) || 0 : d.value,
  }));

  const maxValue = Math.max(...normalized.map((d) => d.value));

  // Compute percentages for label rendering
  const withPercent = normalized.map((d) => ({
    ...d,
    percent: maxValue > 0 ? ((d.value / maxValue) * 100).toFixed(0) + "%" : "0%",
  }));

  // Dynamic height based on item count
  const height = Math.max(200, chartData.length * 44 + 40);

  // Calculate left margin to accommodate long labels
  const maxLabelLen = Math.max(...chartData.map((d) => d.name.length));
  const leftMargin = Math.min(Math.max(maxLabelLen * 6, 80), 180);

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={withPercent}
          layout="vertical"
          margin={{ top: 4, right: data.showPercentages ? 48 : 16, left: 0, bottom: 4 }}
          barCategoryGap="25%"
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="hsl(var(--border))"
            horizontal={false}
          />
          <XAxis
            type="number"
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => v.toLocaleString()}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={leftMargin}
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            content={<CustomTooltip unit={data.unit} />}
            cursor={{ fill: "hsl(var(--muted) / 0.5)" }}
          />
          <Bar dataKey="value" radius={[0, 3, 3, 0]}>
            {withPercent.map((_, index) => (
              <Cell key={index} fill={primaryColor} />
            ))}
            {data.showPercentages && (
              <LabelList
                dataKey="percent"
                position="right"
                style={{ fontSize: 11, fill: "hsl(var(--muted-foreground))", fontWeight: 500 }}
              />
            )}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {data.yLabel && (
        <p className="text-xs text-muted-foreground text-center mt-1">{data.yLabel}</p>
      )}
    </div>
  );
}
