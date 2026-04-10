/**
 * TwoColumn renderer
 * Two equal columns. Each side can render prose, list, metric, or a sub-layout
 * (chart, table, etc.) using the standard CIM renderers.
 */
import { Component, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

/** Error boundary that catches render crashes in sub-renderers */
class ColumnErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

import { MetricGridRenderer } from "./MetricGrid";
import { BarChartRenderer } from "./BarChart";
import { PieChartRenderer } from "./PieChart";
import { LineChartRenderer } from "./LineChart";
import { FinancialTableRenderer } from "./FinancialTable";
import { CalloutListRenderer } from "./CalloutList";
import { StatCalloutRenderer } from "./StatCallout";

interface ColumnContent {
  title?: string;
  content: any; // string for prose/list/metric, object for sub-layouts
  layoutType?: string;
}

interface TwoColumnLayoutData {
  left?: ColumnContent;
  right?: ColumnContent;
  title?: string;
}

interface RendererProps {
  layoutData: TwoColumnLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

/** Known sub-layout types that can be rendered inside a column */
const SUB_RENDERERS: Record<string, React.ComponentType<any>> = {
  bar_chart: BarChartRenderer,
  pie_chart: PieChartRenderer,
  donut_chart: PieChartRenderer,
  line_chart: LineChartRenderer,
  metric_grid: MetricGridRenderer,
  financial_table: FinancialTableRenderer,
  callout_list: CalloutListRenderer,
  stat_callout: StatCalloutRenderer,
};

function parseMetricLines(text: string): Array<{ label: string; value: string }> {
  return text.split("\n").filter(Boolean).map((line) => {
    const idx = line.indexOf(":");
    if (idx === -1) return { label: line, value: "" };
    return { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
  });
}

function SafeColumnBlock({ col, branding, section }: { col: ColumnContent; branding: CimBranding; section: CimSection }) {
  const fallbackContent = typeof col.content === "string" ? col.content : JSON.stringify(col.content, null, 2);
  const fallbackUI = (
    <div className="rounded border border-border/40 bg-muted/20 p-3">
      {col.title && <p className="text-xs font-semibold text-muted-foreground mb-1">{col.title}</p>}
      <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{fallbackContent}</pre>
    </div>
  );
  return (
    <ColumnErrorBoundary fallback={fallbackUI}>
      <ColumnBlockInner col={col} branding={branding} section={section} />
    </ColumnErrorBoundary>
  );
}

function ColumnBlockInner({ col, branding, section }: { col: ColumnContent; branding: CimBranding; section: CimSection }) {
  const type = col.layoutType || "prose";
  const content = col.content;

  // If this column's layoutType matches a known sub-renderer, delegate to it
  const SubRenderer = SUB_RENDERERS[type];
  if (SubRenderer) {
    // The sub-renderer expects layoutData (the object content) and a content string
    const layoutData = typeof content === "object" && content !== null ? content : {};
    const contentStr = typeof content === "string" ? content : "";
    return (
      <div>
        {col.title && (
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            {col.title}
          </p>
        )}
        <SubRenderer layoutData={layoutData} content={contentStr} branding={branding} section={section} />
      </div>
    );
  }

  // Ensure content is a string for simple types
  const textContent = typeof content === "string" ? content : (content != null ? JSON.stringify(content) : "");

  if (type === "list") {
    const lines = textContent.split("\n").filter(Boolean);
    return (
      <div>
        {col.title && (
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            {col.title}
          </p>
        )}
        <ul className="space-y-1.5">
          {lines.map((line, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-teal flex-shrink-0 mt-1.5" />
              <span className="text-sm text-foreground/80 leading-relaxed">{line.replace(/^[-•*]\s*/, "")}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (type === "metric") {
    const pairs = parseMetricLines(textContent);
    return (
      <div>
        {col.title && (
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            {col.title}
          </p>
        )}
        <div className="space-y-2">
          {pairs.map((pair, i) => (
            <div key={i} className="flex items-baseline justify-between gap-4 border-b border-border/40 pb-1.5 last:border-0">
              <span className="text-xs text-muted-foreground">{pair.label}</span>
              <span className="text-sm font-semibold tabular-nums text-foreground">{pair.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // prose (default)
  return (
    <div>
      {col.title && (
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          {col.title}
        </p>
      )}
      <div className="space-y-2">
        {textContent.split("\n\n").filter(Boolean).map((para, i) => (
          <p key={i} className="text-sm text-foreground/80 leading-relaxed">{para}</p>
        ))}
      </div>
    </div>
  );
}

export function TwoColumnRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: TwoColumnLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};

  if (!data.left && !data.right) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  const left = data.left || { content: "", layoutType: "prose" };
  const right = data.right || { content: "", layoutType: "prose" };

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      <div className="grid grid-cols-2 gap-8">
        <div>
          <SafeColumnBlock col={left} branding={branding} section={section} />
        </div>
        <div className="border-l border-border pl-8">
          <SafeColumnBlock col={right} branding={branding} section={section} />
        </div>
      </div>
    </div>
  );
}
