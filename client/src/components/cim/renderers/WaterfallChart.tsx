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
import { useCimTheme } from "../CimDesignContext";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { ProseFallback } from "../richText";
import { useElementWidth } from "./chartFormat";

/** Below this container width the build-up is drawn as labelled horizontal rows. */
const NARROW_WIDTH = 520;

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
  const theme = useCimTheme();
  if (!active || !payload || payload.length === 0) return null;

  // Find the meaningful bar (not the invisible base)
  const entry = payload.find(p => p.payload)?.payload;
  if (!entry) return null;

  const colorMap = {
    start: theme.neutral,
    add: theme.positive,
    subtract: theme.negative,
    total: theme.chart[0],
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
          <span className="font-medium" style={{ color: theme.positive }}>
            +{formatCurrency(entry.rawValue, currency)}
          </span>
        )}
        {entry.type === "subtract" && (
          <span className="font-medium" style={{ color: theme.negative }}>
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
  const theme = useCimTheme();
  const { ref: widthRef, width } = useElementWidth<HTMLDivElement>();
  const data: WaterfallLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const items = data.items || [];

  if (items.length === 0) {
    if (!content) return null;
    return <ProseFallback content={content} />;
  }

  const waterfallData = buildWaterfallData(items);
  const primaryColor = theme.chart[0];

  // Paper-tuned semantic colors — softer than UI status colors, print-friendly
  const colorMap: Record<string, string> = {
    start: theme.neutral,
    add: theme.positive,
    subtract: theme.negative,
    total: primaryColor,
  };

  // Until measured, fall back to the viewport so a phone never flashes the
  // wide chart with colliding labels.
  const measured = width || (typeof window !== "undefined" ? window.innerWidth : 1024);
  const narrow = measured < NARROW_WIDTH;

  return (
    <div ref={widthRef}>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      {narrow ? (
        <WaterfallRows data={waterfallData} colorMap={colorMap} currency={data.currency} />
      ) : (
      <ResponsiveContainer width="100%" height={Math.max(280, waterfallData.length * 40)}>
        <BarChart
          data={waterfallData}
          margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
          barCategoryGap="25%"
        >
          {/* Explicit paper-palette hex — charts must read identically in both app themes */}
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={theme.line}
            vertical={false}
          />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 10, fill: theme.inkMuted }}
            axisLine={false}
            tickLine={false}
            interval={0}
            angle={-20}
            textAnchor="end"
            height={60}
          />
          <YAxis
            tick={{ fontSize: 11, fill: theme.inkMuted }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => formatCurrency(v, data.currency)}
          />
          <Tooltip
            content={<WaterfallTooltip currency={data.currency} />}
            cursor={{ fill: theme.stripe, fillOpacity: 0.5 }}
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
      )}

      {/* Legend */}
      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 mt-3">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: theme.positive }} />
          <span className="text-[11px] text-muted-foreground">Addback</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: theme.negative }} />
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

/**
 * Phone-width build-up: one labelled row per step with its amount and a bar
 * segment on a shared scale, so long addback names wrap instead of colliding.
 */
function WaterfallRows({
  data,
  colorMap,
  currency,
}: {
  data: WaterfallBarData[];
  colorMap: Record<string, string>;
  currency?: string;
}) {
  const lo = Math.min(0, ...data.map((d) => d.base), ...data.map((d) => d.total));
  const hi = Math.max(1, ...data.map((d) => d.base + d.value), ...data.map((d) => d.total));
  const span = hi - lo || 1;
  return (
    <div className="space-y-3">
      {data.map((d, i) => {
        const emphasis = d.type === "start" || d.type === "total";
        const amount =
          d.type === "add" ? `+${formatCurrency(d.rawValue, currency)}` : formatCurrency(d.rawValue, currency);
        return (
          <div key={i}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className={emphasis ? "font-semibold text-foreground min-w-0" : "text-foreground/80 min-w-0"}>
                {d.name}
              </span>
              <span
                className={emphasis ? "font-semibold tabular-nums shrink-0 text-foreground" : "font-medium tabular-nums shrink-0"}
                style={emphasis ? undefined : { color: colorMap[d.type] }}
              >
                {amount}
              </span>
            </div>
            <div className="relative mt-1 h-2 rounded-sm bg-muted/40">
              <div
                className="absolute top-0 bottom-0 rounded-sm"
                style={{
                  left: `${((d.base - lo) / span) * 100}%`,
                  width: `${Math.max(0.8, (d.value / span) * 100)}%`,
                  backgroundColor: colorMap[d.type],
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
