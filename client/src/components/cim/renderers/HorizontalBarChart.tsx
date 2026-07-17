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
import { CIM_DOC } from "../CimBrandingContext";
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

  // Percent labels are shares of the TOTAL (a 50/30/20 revenue split reads
  // 50%/30%/20%). Dividing by the max made the largest bar always read
  // "100%" — visibly wrong in customer-concentration contexts.
  const totalValue = normalized.reduce((s, d) => s + d.value, 0);
  const withPercent = normalized.map((d) => ({
    ...d,
    percent: totalValue > 0 ? ((d.value / totalValue) * 100).toFixed(0) + "%" : "0%",
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
          {/* Explicit paper-palette hex — charts must read identically in both app themes */}
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={CIM_DOC.line}
            horizontal={false}
          />
          <XAxis
            type="number"
            tick={{ fontSize: 11, fill: CIM_DOC.inkMuted }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => v.toLocaleString()}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={leftMargin}
            tick={{ fontSize: 11, fill: CIM_DOC.inkSoft }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            content={<CustomTooltip unit={data.unit} />}
            cursor={{ fill: CIM_DOC.stripe, fillOpacity: 0.6 }}
          />
          <Bar dataKey="value" radius={[0, 3, 3, 0]}>
            {withPercent.map((_, index) => (
              <Cell key={index} fill={primaryColor} />
            ))}
            {data.showPercentages && (
              <LabelList
                dataKey="percent"
                position="right"
                style={{ fontSize: 11, fill: CIM_DOC.inkMuted, fontWeight: 500 }}
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
