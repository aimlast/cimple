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
import { useCimTheme } from "../CimDesignContext";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { ProseFallback } from "../richText";
import { formatAxisTick, formatFullValue } from "./chartFormat";
import { chartSeriesRows, chartShares, isPercentUnit } from "@shared/cim-chart-values";
import { BlockTitle } from "./BlockTitle";
import { NotCharted } from "./NotCharted";
import { useBlockAttrs, useChartPointReporter } from "../blocks";

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
  /** The whole the bars are parts of, as the knowledge base states it. */
  total?: number | string;
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
        {formatFullValue(payload[0].value, unit)}
      </span>
    </div>
  );
}

export function HorizontalBarChartRenderer({ layoutData, content, branding, section }: RendererProps) {
  const theme = useCimTheme();
  const ba = useBlockAttrs();
  const point = useChartPointReporter();
  const data: HorizontalBarChartLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const chartData = data.data || [];

  if (chartData.length === 0) {
    if (!content) return null;
    return <ProseFallback content={content} />;
  }

  const primaryColor = theme.chart[0];

  // Values written as text ("$13,560,000") are read as numbers — parseFloat
  // gave NaN for them and drew every bar at zero.
  // A value that isn't one amount ("TBD") is listed under the chart, never
  // drawn as a $0 bar (shared/cim-chart-values chartSeriesRows).
  // (Each drawn bar keeps its datum's index: the reading tracker's chart
  // points follow the layout data, which also holds the rows not drawn.)
  const series = chartSeriesRows(chartData.map((d, srcIndex) => ({ ...d, srcIndex })), data.unit);
  const normalized = series.rows;
  if (normalized.length === 0) {
    return (
      <div>
        <BlockTitle title={data.title} intro={(data as { intro?: unknown }).intro} />
        <div {...ba("chart")}><NotCharted items={series.unreadable} /></div>
        {content ? <ProseFallback content={content} /> : null}
      </div>
    );
  }

  // Percent labels: values in % are labelled as written; other values get a
  // share only of a total the chart states and adds up to (chartShares) —
  // never a share of the bars' own sum, which is false when the list is
  // partial (and dividing by the max once made the largest bar read "100%").
  const percentValues = isPercentUnit(data.unit);
  const { shares } = chartShares(normalized.map((d) => d.value), data.unit, data.total);
  const showLabels = !!data.showPercentages && (percentValues || shares !== null);
  const withPercent = normalized.map((d, i) => ({
    ...d,
    percent: percentValues ? formatFullValue(d.value, "%") : shares ? `${shares[i].toFixed(0)}%` : "",
  }));

  // Dynamic height based on item count
  const height = Math.max(200, normalized.length * 44 + 40);

  // Calculate left margin to accommodate long labels
  const maxLabelLen = Math.max(...normalized.map((d) => d.name.length));
  const leftMargin = Math.min(Math.max(maxLabelLen * 6, 80), 180);

  return (
    <div>
      <BlockTitle title={data.title} intro={(data as { intro?: unknown }).intro} />
      <div {...ba("chart")}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={withPercent}
          layout="vertical"
          margin={{ top: 4, right: showLabels ? 48 : 16, left: 0, bottom: 4 }}
          barCategoryGap="25%"
          onMouseMove={(s) => point(s?.activeTooltipIndex == null ? null : normalized[Number(s.activeTooltipIndex)]?.srcIndex)}
          onMouseLeave={() => point(null)}
        >
          {/* Explicit paper-palette hex — charts must read identically in both app themes */}
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={theme.line}
            horizontal={false}
          />
          <XAxis
            type="number"
            tick={{ fontSize: 11, fill: theme.inkMuted }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => formatAxisTick(v, data.unit)}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={leftMargin}
            tick={{ fontSize: 11, fill: theme.inkSoft }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            content={<CustomTooltip unit={data.unit} />}
            cursor={{ fill: theme.stripe, fillOpacity: 0.6 }}
          />
          <Bar dataKey="value" radius={[0, 3, 3, 0]}>
            {withPercent.map((_, index) => (
              <Cell key={index} fill={primaryColor} />
            ))}
            {showLabels && (
              <LabelList
                dataKey="percent"
                position="right"
                style={{ fontSize: 11, fill: theme.inkMuted, fontWeight: 500 }}
              />
            )}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <NotCharted items={series.unreadable} />
      {data.yLabel && (
        <p className="text-xs text-muted-foreground text-center mt-1">{data.yLabel}</p>
      )}
      </div>
    </div>
  );
}
