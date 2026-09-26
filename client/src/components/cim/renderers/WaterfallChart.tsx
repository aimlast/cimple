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
  LabelList,
} from "recharts";
import { useCimTheme } from "../CimDesignContext";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { ProseFallback } from "../richText";
import { axisWidthFor, compactFigure, formatAxisTick, useElementWidth } from "./chartFormat";
import { parseChartNumber, unitScale } from "@shared/cim-chart-values";

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

export function buildWaterfallData(items: WaterfallItem[], unit?: string): WaterfallBarData[] {
  const result: WaterfallBarData[] = [];
  let runningTotal = 0;
  const scale = unitScale(unit);

  for (const item of items) {
    // "$78,000", "-$78K", "(78,000)" are numbers too (parseFloat read "$…" as 0).
    const parsed = parseChartNumber(item.value, scale) ?? 0;
    const type = item.type || (result.length === 0 ? "start" : items.indexOf(item) === items.length - 1 ? "total" : parsed >= 0 ? "add" : "subtract");
    // The step's direction is its type: a "subtract" written as 64000 still
    // takes 64,000 off (it was drawn as an addback).
    const numValue = type === "subtract" ? -Math.abs(parsed) : type === "add" ? Math.abs(parsed) : parsed;

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

/** The currency prefix: "C$" for Canadian dollars, "$" otherwise. */
function moneyPrefix(currency?: string, unit?: string): string {
  return /^(?:cad|c\$)/i.test(currency || "") || /^\s*(?:c\$|cad)/i.test(unit || "") ? "C$" : "$";
}

/**
 * An amount, sign first: "C$3,596,200", "−C$78,000" (never "C$-78K").
 * `short` writes large figures compactly for bar labels ("C$3.6M", "−C$78K").
 */
export function formatCurrency(value: number, currency?: string, unit?: string, short = false): string {
  const prefix = moneyPrefix(currency, unit);
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value) * unitScale(unit);
  const body = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(abs);
  return `${sign}${short ? compactFigure(`${prefix}${body}`) : `${prefix}${body}`}`;
}

/** Tick labels wrapped to the width of their bar ("Below-Market Yard Rent Adjustment" over three lines). */
export function wrapLabel(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if ((line + " " + word).length <= maxChars) line += " " + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Most lines a tick label may take before the chart switches to labelled rows. */
const MAX_TICK_LINES = 4;
const TICK_FONT = 10;
const TICK_LINE_HEIGHT = 12;
/** Average width of a character at the 10px tick font. */
const TICK_CHAR_PX = 5.6;

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: WaterfallBarData }>;
  currency?: string;
  unit?: string;
}

function WaterfallTooltip({ active, payload, currency, unit }: CustomTooltipProps) {
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
            +{formatCurrency(entry.rawValue, currency, unit)}
          </span>
        )}
        {entry.type === "subtract" && (
          <span className="font-medium" style={{ color: theme.negative }}>
            {formatCurrency(entry.rawValue, currency, unit)}
          </span>
        )}
        {(entry.type === "start" || entry.type === "total") && (
          <span className="font-medium text-foreground">
            {formatCurrency(entry.rawValue, currency, unit)}
          </span>
        )}
        {entry.type !== "start" && entry.type !== "total" && (
          <div className="text-muted-foreground mt-0.5">
            Running total: {formatCurrency(entry.total, currency, unit)}
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

  const waterfallData = buildWaterfallData(items, data.unit);
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
  // Axis labels sit flat under their bar, wrapped to its width (angled
  // labels ran off the left edge: "elow-Market Yard Rent Adjustment").
  // When a label would need more than four lines, the chart is drawn as
  // labelled rows instead — at any width.
  const moneyUnit = moneyPrefix(data.currency, data.unit);
  const yAxisWidth = axisWidthFor(waterfallData.flatMap((d) => [d.base + d.value, d.total]), moneyUnit);
  const band = (measured - yAxisWidth - 24) / Math.max(1, waterfallData.length);
  const maxChars = Math.max(6, Math.floor((band - 6) / TICK_CHAR_PX));
  const tickLines = waterfallData.map((d) => wrapLabel(d.name, maxChars));
  const longestWord = Math.max(...waterfallData.flatMap((d) => d.name.split(/\s+/).map((w) => w.length)));
  const lineCount = Math.max(1, ...tickLines.map((l) => l.length));
  const narrow = measured < NARROW_WIDTH || lineCount > MAX_TICK_LINES || longestWord > maxChars;
  const labelFor = (d: WaterfallBarData) =>
    d.type === "add" ? `+${formatCurrency(d.rawValue, data.currency, data.unit, true)}` : formatCurrency(d.rawValue, data.currency, data.unit, true);

  return (
    <div ref={widthRef}>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      {narrow ? (
        <WaterfallRows data={waterfallData} colorMap={colorMap} currency={data.currency} unit={data.unit} />
      ) : (
      <ResponsiveContainer width="100%" height={Math.max(280, waterfallData.length * 32) + lineCount * TICK_LINE_HEIGHT}>
        <BarChart
          data={waterfallData}
          margin={{ top: 22, right: 16, left: 8, bottom: 4 }}
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
            axisLine={false}
            tickLine={false}
            interval={0}
            height={lineCount * TICK_LINE_HEIGHT + 12}
            tick={({ x, y, index }: { x: number; y: number; index: number }) => (
              <text x={x} y={y + 4} textAnchor="middle" fontSize={TICK_FONT} fill={theme.inkMuted}>
                {(tickLines[index] ?? []).map((line, i) => (
                  <tspan key={i} x={x} dy={i === 0 ? TICK_LINE_HEIGHT - 2 : TICK_LINE_HEIGHT}>{line}</tspan>
                ))}
              </text>
            )}
          />
          <YAxis
            tick={{ fontSize: 11, fill: theme.inkMuted }}
            axisLine={false}
            tickLine={false}
            width={yAxisWidth}
            tickFormatter={(v) => formatAxisTick(v, moneyUnit)}
          />
          <Tooltip
            content={<WaterfallTooltip currency={data.currency} unit={data.unit} />}
            cursor={{ fill: theme.stripe, fillOpacity: 0.5 }}
          />
          {/* Invisible base bar */}
          <Bar dataKey="base" stackId="waterfall" fill="transparent" />
          {/* Visible value bar, its amount above it */}
          <Bar dataKey="value" stackId="waterfall" radius={[3, 3, 0, 0]}>
            {waterfallData.map((entry, i) => (
              <Cell key={i} fill={colorMap[entry.type]} />
            ))}
            <LabelList
              dataKey="value"
              position="top"
              content={({ x, y, width: w, index }: any) => {
                const d = waterfallData[index as number];
                if (!d) return null;
                return (
                  <text x={Number(x) + Number(w) / 2} y={Number(y) - 5} textAnchor="middle" fontSize={10} fontWeight={600} fill={d.type === "subtract" ? theme.negative : d.type === "add" ? theme.positive : theme.ink}>
                    {labelFor(d)}
                  </text>
                );
              }}
            />
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
  unit,
}: {
  data: WaterfallBarData[];
  colorMap: Record<string, string>;
  currency?: string;
  unit?: string;
}) {
  const lo = Math.min(0, ...data.map((d) => d.base), ...data.map((d) => d.total));
  const hi = Math.max(1, ...data.map((d) => d.base + d.value), ...data.map((d) => d.total));
  const span = hi - lo || 1;
  return (
    <div className="space-y-3">
      {data.map((d, i) => {
        const emphasis = d.type === "start" || d.type === "total";
        const amount =
          d.type === "add" ? `+${formatCurrency(d.rawValue, currency, unit)}` : formatCurrency(d.rawValue, currency, unit);
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
