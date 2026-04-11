/**
 * PieChart renderer
 * Recharts PieChart — also handles donut_chart layoutType.
 * Custom legend on the right. Professional color palette.
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
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface PieDataPoint {
  name: string;
  value: number | string;
  color?: string;
}

interface PieChartLayoutData {
  data?: PieDataPoint[];
  totalLabel?: string;
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

function buildPalette(primary: string, accent: string): string[] {
  return [
    primary,
    accent,
    "#64b8a0",
    "#94c9b8",
    "#b8ddd4",
    "#d4ede8",
    "#6b7280",
    "#9ca3af",
    "#d1d5db",
  ];
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
      <span className="font-medium tabular-nums">
        {typeof p.value === "number" ? p.value.toLocaleString() : p.value}
        {unit ? ` ${unit}` : ""}
      </span>
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
  const data: PieChartLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const rawData = data.data || [];

  if (rawData.length === 0) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  const primaryColor = branding.primaryHex || "#2dc88e";
  const accentColor = branding.accentHex || "#1a9e72";
  const palette = buildPalette(primaryColor, accentColor);

  const isDonut = section.layoutType === "donut_chart" || !!(data.centerLabel || data.centerValue);

  const normalized = rawData.map((d, i) => ({
    ...d,
    value: typeof d.value === "string" ? parseFloat(d.value) || 0 : d.value,
    color: d.color || palette[i % palette.length],
  }));

  const total = normalized.reduce((sum, d) => sum + d.value, 0);

  const onPieEnter = useCallback((_: any, index: number) => setActiveIndex(index), []);
  const onPieLeave = useCallback(() => setActiveIndex(undefined), []);

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      <div className="flex items-center gap-6">
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
                <span className="text-xl font-semibold text-foreground leading-tight">
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
        <div className="flex flex-col gap-2 min-w-0 flex-1">
          {data.totalLabel && total > 0 && (
            <div className="mb-2 pb-2 border-b border-border">
              <p className="text-xs text-muted-foreground">{data.totalLabel}</p>
              <p className="text-sm font-semibold tabular-nums">
                {total.toLocaleString()}{data.unit ? ` ${data.unit}` : ""}
              </p>
            </div>
          )}
          {normalized.map((entry, i) => {
            const pct = total > 0 ? ((entry.value / total) * 100).toFixed(1) : "0";
            const isHighlighted = activeIndex === i;
            return (
              <div
                key={i}
                className={cn(
                  "flex items-center gap-2.5 min-w-0 rounded px-1 -mx-1 py-0.5 transition-colors cursor-pointer",
                  isHighlighted && "bg-muted/50",
                )}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseLeave={() => setActiveIndex(undefined)}
              >
                <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: entry.color }} />
                <span className="text-xs text-foreground/80 truncate flex-1">{entry.name}</span>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <span className="text-xs font-semibold tabular-nums text-foreground">
                    {entry.value.toLocaleString()}
                    {data.unit ? ` ${data.unit}` : ""}
                  </span>
                  <span className="text-2xs text-muted-foreground">({pct}%)</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
