/**
 * TwoColumn renderer
 * Two equal columns. Each side can render prose, list, metric, or a sub-layout
 * (chart, table, stats, cards…) using the standard CIM renderers.
 *
 * Columns go through resolveTwoColumnColumn (shared/cim-layouts.ts) first:
 * a placeholder where the data should be ({content: "stats", layoutType:
 * "icon_stat_row"}) is never printed — the column is left out and the other
 * one takes the full width — and a list of cards with no layoutType is drawn
 * as cards, not as a heading with nothing under it.
 */
import { Component, type ReactNode } from "react";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { resolveTwoColumnColumn, type TwoColumnColumn } from "@shared/cim-layouts";
import { ProseFallback, renderInline, renderProse } from "../richText";
import { findProseColumnIndex } from "../editableText";
import { CimBlockScope, useBlockAttrs } from "../blocks";

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
import { HorizontalBarChartRenderer } from "./HorizontalBarChart";
import { PieChartRenderer } from "./PieChart";
import { LineChartRenderer } from "./LineChart";
import { FinancialTableRenderer } from "./FinancialTable";
import { ComparisonTableRenderer } from "./ComparisonTable";
import { CalloutListRenderer } from "./CalloutList";
import { NumberedListRenderer } from "./NumberedList";
import { StatCalloutRenderer } from "./StatCallout";
import { ScorecardRenderer } from "./Scorecard";
import { TimelineRenderer } from "./Timeline";
import { BlockTitle } from "./BlockTitle";

interface TwoColumnLayoutData {
  left?: unknown;
  right?: unknown;
  title?: string;
}

interface RendererProps {
  layoutData: TwoColumnLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

/** Sub-layouts that can be rendered inside a column (TWO_COLUMN_SUB_LAYOUTS). */
const SUB_RENDERERS: Record<string, React.ComponentType<any>> = {
  bar_chart: BarChartRenderer,
  horizontal_bar_chart: HorizontalBarChartRenderer,
  pie_chart: PieChartRenderer,
  donut_chart: PieChartRenderer,
  line_chart: LineChartRenderer,
  metric_grid: MetricGridRenderer,
  financial_table: FinancialTableRenderer,
  comparison_table: ComparisonTableRenderer,
  callout_list: CalloutListRenderer,
  icon_stat_row: CalloutListRenderer,
  numbered_list: NumberedListRenderer,
  stat_callout: StatCalloutRenderer,
  scorecard: ScorecardRenderer,
  timeline: TimelineRenderer,
};

function parseMetricLines(text: string): Array<{ label: string; value: string }> {
  return text.split("\n").filter(Boolean).map((line) => {
    const idx = line.indexOf(":");
    if (idx === -1) return { label: line, value: "" };
    return { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
  });
}

function ColumnTitle({ title }: { title?: string }) {
  if (!title) return null;
  return <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">{title}</p>;
}

function SafeColumnBlock({ col, branding, section }: { col: TwoColumnColumn; branding: CimBranding; section: CimSection }) {
  // A crashed sub-renderer shows the column's words, never raw JSON.
  const fallbackUI = (
    <div>
      <ColumnTitle title={col.title} />
      {typeof col.content === "string" && (
        <div className="text-foreground/80">{renderProse(col.content, { paragraphClassName: "text-sm leading-relaxed mb-2 last:mb-0" })}</div>
      )}
    </div>
  );
  return (
    <ColumnErrorBoundary fallback={fallbackUI}>
      <ColumnBlockInner col={col} branding={branding} section={section} />
    </ColumnErrorBoundary>
  );
}

function ColumnBlockInner({ col, branding, section }: { col: TwoColumnColumn; branding: CimBranding; section: CimSection }) {
  // Inside the column's CimBlockScope: keys come out as "left/…" / "right/…".
  const ba = useBlockAttrs();
  const type = col.layoutType || "prose";
  const content = col.content;

  const SubRenderer = SUB_RENDERERS[type];
  if (SubRenderer) {
    const layoutData = typeof content === "object" && content !== null ? content : {};
    return (
      <div>
        <ColumnTitle title={col.title} />
        {/* Sub-renderers read the layout type from the section (icon_stat_row, donut…). */}
        <SubRenderer layoutData={layoutData} content="" branding={branding} section={{ ...section, layoutType: type }} />
      </div>
    );
  }

  const textContent = typeof content === "string" ? content : "";

  if (type === "list") {
    // One item per line; a single line of "a|b|c" (a shape the AI sometimes
    // writes) is split on the pipes so it never reads as run-on text.
    let lines = textContent.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 1 && lines[0].includes("|")) lines = lines[0].split("|").map((l) => l.trim()).filter(Boolean);
    return (
      <div>
        <ColumnTitle title={col.title} />
        <ul className="space-y-1.5">
          {lines.map((line, i) => (
            <li key={i} {...ba(`item:${i}`)} className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-teal flex-shrink-0 mt-1.5" />
              <span className="text-sm text-foreground/80 leading-relaxed">{renderInline(line.replace(/^\s*[-•*·–]\s*/, ""), `li${i}`)}</span>
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
        <ColumnTitle title={col.title} />
        <div className="space-y-2">
          {pairs.map((pair, i) => (
            <div key={i} {...ba(`metric:${i}`)} className="flex items-baseline justify-between gap-4 border-b border-border/40 pb-1.5 last:border-0">
              <span className="text-xs text-muted-foreground">{renderInline(pair.label, `ml${i}`)}</span>
              <span className="text-sm font-semibold tabular-nums text-foreground">{renderInline(pair.value, `mv${i}`)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // prose (default)
  return (
    <div>
      <ColumnTitle title={col.title} />
      <div className="text-foreground/80">
        {renderProse(textContent, { paragraphClassName: "text-sm leading-relaxed mb-2 last:mb-0", blockAttrs: ba })}
      </div>
    </div>
  );
}

export function TwoColumnRenderer({ layoutData, content, branding, section }: RendererProps) {
  const ba = useBlockAttrs();
  const data: TwoColumnLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};

  if (!data.left && !data.right) {
    if (!content) return null;
    return <ProseFallback content={content} />;
  }

  let left = resolveTwoColumnColumn(data.left);
  let right = resolveTwoColumnColumn(data.right);

  // A broker edit replaces the narrative column (see editableText.ts). If
  // neither column is prose, the edit is shown above the columns so it is
  // never silently dropped.
  const edited = section.brokerEditedContent || "";
  const proseIdx = edited ? findProseColumnIndex(data as Record<string, unknown>) : -1;
  if (edited && proseIdx === 0) left = { ...(left ?? { layoutType: "prose" }), layoutType: "prose", content: edited };
  if (edited && proseIdx === 1) right = { ...(right ?? { layoutType: "prose" }), layoutType: "prose", content: edited };
  const editedAbove = edited && proseIdx === -1;

  // Each column keeps its side's name ("left" / "right") for reading analytics,
  // even when only one of them is drawn.
  const sides = ([["left", left], ["right", right]] as const)
    .filter((s): s is readonly ["left" | "right", TwoColumnColumn] => !!s[1]);
  const columns = sides.map(([, c]) => c);
  const column = (i: number) => (
    <CimBlockScope prefix={sides[i][0]}>
      <SafeColumnBlock col={columns[i]} branding={branding} section={section} />
    </CimBlockScope>
  );
  if (columns.length === 0 && !editedAbove) {
    if (!content) return null;
    return <ProseFallback content={content} />;
  }

  return (
    <div>
      <BlockTitle title={data.title} intro={(data as { intro?: unknown }).intro} />
      {editedAbove && (
        <div className="mb-6 max-w-prose text-foreground/80">
          {renderProse(edited, { paragraphClassName: "text-sm leading-relaxed mb-2 last:mb-0", blockAttrs: ba })}
        </div>
      )}
      {columns.length === 1 ? (
        // Only one column holds anything: it takes the full width.
        <div className="min-w-0" {...ba(sides[0][0])}>
          {column(0)}
        </div>
      ) : columns.length === 2 ? (
        // Stacks on phones (a rule between the two), side by side from md.
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 md:gap-8">
          <div className="min-w-0" {...ba(sides[0][0])}>
            {column(0)}
          </div>
          <div className="min-w-0 border-t border-border pt-6 md:border-t-0 md:border-l md:pl-8 md:pt-0" {...ba(sides[1][0])}>
            {column(1)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
