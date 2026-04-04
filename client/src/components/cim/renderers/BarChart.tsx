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
import type { CimSection } from "@shared/schema";

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

function lighten(hex: string, amount = 0.5): string {
  try {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    const lr = Math.round(r + (255 - r) * amount);
    const lg = Math.round(g + (255 - g) * amount);
    const lb = Math.round(b + (255 - b) * amount);
    return `rgb(${lr},${lg},${lb})`;
  } catch {
    return "#a0c4b8";
  }
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
            {typeof p.value === "number" ? p.value.toLocaleString() : p.value}
            {unit ? ` ${unit}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BarChartRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: BarChartLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const chartData = data.data || [];

  if (chartData.length === 0) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  const primaryColor = branding.primaryHex || "#2dc88e";
  const secondaryColor = branding.accentHex ? lighten(branding.accentHex, 0.4) : lighten(primaryColor, 0.5);
  const hasSecondary = chartData.some((d) => d.secondaryValue != null);

  const normalized = chartData.map((d) => ({
    ...d,
    value: typeof d.value === "string" ? parseFloat(d.value) || 0 : d.value,
    secondaryValue: d.secondaryValue != null
      ? typeof d.secondaryValue === "string" ? parseFloat(d.secondaryValue) || 0 : d.secondaryValue
      : undefined,
  }));

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={normalized} margin={{ top: 4, right: 16, left: 0, bottom: data.xLabel ? 24 : 8 }}
          barCategoryGap="30%">
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
            content={<CustomTooltip unit={data.unit} />}
            cursor={{ fill: "hsl(var(--muted) / 0.5)" }}
          />
          {hasSecondary && (
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
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
    </div>
  );
}
