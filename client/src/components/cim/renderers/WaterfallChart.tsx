/**
 * WaterfallChart renderer
 *
 * Visualizes SDE/EBITDA build-up from net income through addbacks/adjustments.
 * Each bar shows the incremental step (green for additions, red for deductions)
 * with a final total bar. Professional CIM-quality output.
 */
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from "recharts";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface WaterfallItem {
  label: string;
  value: number | string;
  type?: "start" | "add" | "subtract" | "total";
}

interface WaterfallLayoutData {
  items?: WaterfallItem[];
  title?: string;
  unit?: string;
  currency?: string;
  startLabel?: string;
  totalLabel?: string;
}

interface RendererProps {
  layoutData: WaterfallLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

interface WaterfallBarData {
  name: string;
  base: number;
  value: number;
  total: number;
  type: "start" | "add" | "subtract" | "total";
  rawValue: number;
}

function buildWaterfallData(items: WaterfallItem[]): WaterfallBarData[] {
  const result: WaterfallBarData[] = [];
  let runningTotal = 0;

  for (const item of items) {
    const numValue = typeof item.value === "string"
      ? parseFloat(item.value.replace(/[,$]/g, "")) || 0
      : item.value;

    const type = item.type || (result.length === 0 ? "start" : items.indexOf(item) === items.length - 1 ? "total" : numValue >= 0 ? "add" : "subtract");

    if (type === "start") {
      runningTotal = numValue;
      result.push({
        name: item.label,
        base: 0,
        value: numValue,
        total: numValue,
        type: "start",
        rawValue: numValue,
      });
    } else if (type === "total") {
      result.push({
        name: item.label,
        base: 0,
        value: runningTotal,
        total: runningTotal,
        type: "total",
        rawValue: runningTotal,
      });
    } else {
      const absValue = Math.abs(numValue);
      if (numValue >= 0) {
        result.push({
          name: item.label,
          base: runningTotal,
          value: absValue,
          total: runningTotal + absValue,
          type: "add",
          rawValue: numValue,
        });
        runningTotal += absValue;
      } else {
        result.push({
          name: item.label,
          base: runningTotal - absValue,
          value: absValue,
          total: runningTotal - absValue,
          type: "subtract",
          rawValue: numValue,
        });
        runningTotal -= absValue;
      }
    }
  }

  return result;
}

function formatCurrency(value: number, currency?: string): string {
  const prefix = currency === "CAD" ? "C$" : "$";
  if (Math.abs(value) >= 1_000_000) {
    return `${prefix}${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${prefix}${(value / 1_000).toFixed(0)}K`;
  }
  return `${prefix}${value.toLocaleString()}`;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: WaterfallBarData }>;
  currency?: string;
}

function WaterfallTooltip({ active, payload, currency }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  // Find the meaningful bar (not the invisible base)
  const entry = payload.find(p => p.payload)?.payload;
  if (!entry) return null;

  const colorMap = {
    start: "#6b7280",
    add: "#22c55e",
    subtract: "#ef4444",
    total: "#2dc88e",
  };

  return (
    <div className="bg-card border border-card-border rounded-md shadow-md px-3 py-2 text-xs">
      <div className="flex items-center gap-2 mb-1">
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: colorMap[entry.type] }}
        />
        <span className="font-semibold text-foreground">{entry.name}</span>
      </div>
      <div className="space-y-0.5">
        {entry.type === "add" && (
          <span className="text-emerald-500 font-medium">
            +{formatCurrency(entry.rawValue, currency)}
          </span>
        )}
        {entry.type === "subtract" && (
          <span className="text-red-500 font-medium">
            {formatCurrency(entry.rawValue, currency)}
          </span>
        )}
        {(entry.type === "start" || entry.type === "total") && (
          <span className="font-medium text-foreground">
            {formatCurrency(entry.rawValue, currency)}
          </span>
        )}
        {entry.type !== "start" && entry.type !== "total" && (
          <div className="text-muted-foreground mt-0.5">
            Running total: {formatCurrency(entry.total, currency)}
          </div>
        )}
      </div>
    </div>
  );
}

export function WaterfallChartRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: WaterfallLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const items = data.items || [];

  if (items.length === 0) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  const waterfallData = buildWaterfallData(items);
  const primaryColor = branding.primaryHex || "#2dc88e";

  const colorMap: Record<string, string> = {
    start: "#6b7280",
    add: "#22c55e",
    subtract: "#ef4444",
    total: primaryColor,
  };

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      <ResponsiveContainer width="100%" height={Math.max(280, waterfallData.length * 40)}>
        <BarChart
          data={waterfallData}
          margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
          barCategoryGap="25%"
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="hsl(var(--border))"
            vertical={false}
          />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            interval={0}
            angle={-20}
            textAnchor="end"
            height={60}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => formatCurrency(v, data.currency)}
          />
          <Tooltip
            content={<WaterfallTooltip currency={data.currency} />}
            cursor={{ fill: "hsl(var(--muted) / 0.3)" }}
          />
          {/* Invisible base bar */}
          <Bar dataKey="base" stackId="waterfall" fill="transparent" />
          {/* Visible value bar */}
          <Bar dataKey="value" stackId="waterfall" radius={[3, 3, 0, 0]}>
            {waterfallData.map((entry, i) => (
              <Cell key={i} fill={colorMap[entry.type]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="flex items-center justify-center gap-6 mt-3">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />
          <span className="text-[11px] text-muted-foreground">Addback</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-red-500" />
          <span className="text-[11px] text-muted-foreground">Deduction</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: primaryColor }} />
          <span className="text-[11px] text-muted-foreground">Total</span>
        </div>
      </div>
    </div>
  );
}
